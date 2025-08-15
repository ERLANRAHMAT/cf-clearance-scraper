// server.js
// Express + Queue dengan persistensi ke database.json
// Bahasa: Indonesia

const express = require('express')
const app = express()
const port = process.env.PORT || 3000
const bodyParser = require('body-parser')
const authToken = process.env.authToken || null
const cors = require('cors')
const pidusage = require('pidusage')  // Monitor CPU usage
const fs = require('fs')
const fsp = require('fs').promises
const path = require('path')

// ==== Module kamu (biarkan seperti semula) ====
const reqValidate = require('./module/reqValidate')
if (process.env.SKIP_LAUNCH != 'true') require('./module/createBrowser')
const getSource = require('./endpoints/getSource')
const solveTurnstileMin = require('./endpoints/solveTurnstile.min')
const solveTurnstileMax = require('./endpoints/solveTurnstile.max')
const wafSession = require('./endpoints/wafSession')

// ==== Konfigurasi VPS & Slot ====
const vCPU = 4                     // VPS kamu 8 vCPU
const cpuThreshold = 0.85          // Maks CPU usage (85% dari total)

// ==== Lokasi DB JSON ====
const DB_PATH = path.join(__dirname, 'database.json')

// Struktur default DB
const DEFAULT_DB = {
  queue: [],        // [{ jobId, data, enqueuedAt }]
  results: {},      // { [jobId]: {success, code, ...}}
  meta: {
    version: 1,
    lastWriteAt: null
  }
}

// ---- Util: tulis file secara atomik supaya aman saat crash ----
async function writeJsonAtomic(filePath, dataObj) {
  const tmpPath = filePath + '.tmp'
  const payload = JSON.stringify(dataObj, null, 2)
  await fsp.writeFile(tmpPath, payload, 'utf8')
  await fsp.rename(tmpPath, filePath)
}

// ---- DB Layer sederhana ----
async function ensureDb() {
  try {
    await fsp.access(DB_PATH, fs.constants.F_OK)
  } catch {
    await writeJsonAtomic(DB_PATH, { ...DEFAULT_DB, meta: { ...DEFAULT_DB.meta, lastWriteAt: new Date().toISOString() } })
  }
}

async function readDb() {
  try {
    const raw = await fsp.readFile(DB_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    // heal minimal jika field hilang
    return {
      queue: Array.isArray(parsed.queue) ? parsed.queue : [],
      results: parsed.results && typeof parsed.results === 'object' ? parsed.results : {},
      meta: { ...DEFAULT_DB.meta, ...(parsed.meta || {}) }
    }
  } catch (e) {
    // Jika korup, backup & reset
    try {
      await fsp.copyFile(DB_PATH, DB_PATH + '.bak-' + Date.now())
    } catch {}
    await writeJsonAtomic(DB_PATH, { ...DEFAULT_DB, meta: { ...DEFAULT_DB.meta, lastWriteAt: new Date().toISOString() } })
    return { ...DEFAULT_DB }
  }
}

let writeLock = Promise.resolve()
function queueWriteDb(updateFn) {
  // Serialisasikan write agar tidak race
  writeLock = writeLock.then(async () => {
    const db = await readDb()
    const next = await updateFn(db)
    next.meta = { ...(next.meta || {}), lastWriteAt: new Date().toISOString(), version: 1 }
    await writeJsonAtomic(DB_PATH, next)
  }).catch(err => {
    console.error('DB write error:', err)
  })
  return writeLock
}

// ==== Queue & Result (akan diisi dari DB saat start) ====
let requestQueue = []
let processingQueue = false
let resultsStore = {} // { jobId: resultObj }

// ==== Middlewares ====
app.use(bodyParser.json({}))
app.use(bodyParser.urlencoded({ extended: true }))
app.use(cors())

// ==== Server listen ====
if (process.env.NODE_ENV !== 'development') {
  let server = app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`)
  })
  try { server.timeout = Number(process.env.timeOut || 60000) } catch (e) {}
}

// ==== CPU Monitoring ====
async function getCpuStats() {
  const stats = await pidusage(process.pid)
  const cpuFraction = stats.cpu / (100 * vCPU) // 0..1
  const memoryGB = stats.memory / (1024 ** 3)
  return {
    cpuFraction,
    cpuPercent: stats.cpu,
    cpuAvailable: Math.max(0, 1 - cpuFraction),
    memoryGB: Number(memoryGB.toFixed(2))
  }
}

async function canProcessNow() {
  const { cpuFraction } = await getCpuStats()
  return cpuFraction < cpuThreshold
}

// ==== Fungsi Proses Request ====
async function processRequest(data) {
  try {
    let result = { code: 500 }

    switch (data.mode) {
      case "source":
        result = await getSource(data).then(res => ({ source: res, code: 200 }))
        break
      case "turnstile-min":
        result = await solveTurnstileMin(data).then(res => ({ token: res, code: 200 }))
        break
      case "turnstile-max":
        result = await solveTurnstileMax(data).then(res => ({ token: res, code: 200 }))
        break
      case "waf-session":
        result = await wafSession(data).then(res => ({ ...res, code: 200 }))
        break
    }
    return result
  } catch (err) {
    return { code: 500, message: err.message }
  }
}

// ==== Retry Otomatis ====
async function retryUntilSuccessOrGiveUp(data, maxRetry = 5, delay = 2000) {
  let cpuStats = await getCpuStats()
  for (let i = 0; i < maxRetry; i++) {
    const result = await processRequest(data)
    cpuStats = await getCpuStats()
    if (result.code !== 500) {
      return {
        success: true,
        ...result,
        queueLength: requestQueue.length,
        cpu: {
          percent: cpuStats.cpuPercent,
          available: cpuStats.cpuAvailable,
          memoryGB: cpuStats.memoryGB
        }
      }
    }
    console.log(`Retry #${i + 1} for mode ${data.mode}`)
    await new Promise(resolve => setTimeout(resolve, delay))
  }

  // Jika gagal semua
  return {
    success: false,
    code: 200,
    message: `Failed after ${maxRetry} retries`,
    queueLength: requestQueue.length,
    cpu: {
      percent: cpuStats.cpuPercent,
      available: cpuStats.cpuAvailable,
      memoryGB: cpuStats.memoryGB
    }
  }
}

// ==== Endpoint utama (Fast ACK) ====
app.post('/cf-clearance-scraper', async (req, res) => {
  const data = req.body
  const check = reqValidate(data)

  // Validasi request
  if (check !== true) return res.status(400).json({ code: 400, message: 'Bad Request', schema: check })
  if (authToken && data.authToken !== authToken) return res.status(401).json({ code: 401, message: 'Unauthorized' })
  if (process.env.SKIP_LAUNCH != 'true' && !global.browser)
    return res.status(503).json({ code: 503, message: 'The scanner is not ready yet.' })

  const jobId = Date.now() + '-' + Math.random().toString(36).substring(2)

  // Masukkan ke memori + DB
  const enqueued = { data, jobId, enqueuedAt: Date.now() }
  requestQueue.push(enqueued)
  console.log(`Job ${jobId} masuk queue. Queue length: ${requestQueue.length}`)

  await queueWriteDb(async (db) => {
    db.queue.push(enqueued)
    return db
  })

  // mulai proses (non-blocking)
  processQueue()

  const cpuStats = await getCpuStats()
  return res.status(200).json({
    success: false,
    status: "queued",
    jobId,
    queueLength: requestQueue.length,
    cpu: {
      percent: cpuStats.cpuPercent,
      available: cpuStats.cpuAvailable,
      memoryGB: cpuStats.memoryGB
    }
  })
})

// ==== Endpoint ambil hasil ====
// Catatan: setelah hasil diambil, langsung hapus dari DB & memori agar tidak berat
app.get('/cf-clearance-result/:jobId', async (req, res) => {
  const { jobId } = req.params

  // Pastikan sinkron dengan DB (kalau perlu)
  if (!resultsStore[jobId]) {
    const db = await readDb()
    if (db.results && db.results[jobId]) {
      resultsStore[jobId] = db.results[jobId]
    }
  }

  if (!resultsStore[jobId]) {
    return res.status(200).json({
      success: false,
      status: "pending",
      message: "Job is still in queue or processing"
    })
  }

  const payload = resultsStore[jobId]

  // Hapus dari memori & DB
  delete resultsStore[jobId]
  await queueWriteDb(async (db) => {
    if (db.results) delete db.results[jobId]
    // sekaligus bersihkan item queue yang mungkin tersisa (safetynet)
    db.queue = db.queue.filter(q => q.jobId !== jobId)
    return db
  })

  return res.status(200).json(payload)
})

// ==== Worker Queue ====
// - Menunggu CPU idle
// - Ambil dari queue (memori & DB)
// - Simpan hasil ke results (memori & DB)
async function processQueue() {
  if (processingQueue || requestQueue.length === 0) return
  processingQueue = true

  try {
    while (requestQueue.length > 0) {
      // Tunggu sampai CPU usage turun
      while (!(await canProcessNow())) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }

      // Ambil job pertama
      const { data, jobId } = requestQueue.shift()

      // Persist: hapus dari DB.queue segera agar tidak dobel saat crash berikutnya
      await queueWriteDb(async (db) => {
        db.queue = db.queue.filter(q => q.jobId !== jobId)
        return db
      })

      console.log(`Proses job ${jobId} dari queue. Sisa queue: ${requestQueue.length}`)
      const result = await retryUntilSuccessOrGiveUp(data)

      // Simpan hasil di store + DB
      resultsStore[jobId] = result
      await queueWriteDb(async (db) => {
        db.results = db.results || {}
        db.results[jobId] = result
        return db
      })
    }
  } catch (e) {
    console.error('processQueue error:', e)
  } finally {
    processingQueue = false
  }
};

// ==== Inisialisasi: buat database.json & muat ulang antrian yang tertunda ====
(async function boot() {
  await ensureDb()
  const db = await readDb()

  // Muat queue & hasil dari DB ke memori
  requestQueue = Array.isArray(db.queue) ? db.queue.slice() : []
  resultsStore = (db.results && typeof db.results === 'object') ? { ...db.results } : {}

  if (requestQueue.length > 0) {
    console.log(`Memuat ${requestQueue.length} job dari database.json ke memori`)
    // Mulai proses ulang
    processQueue()
  }

  // Opsi: housekeeping hasil lama (TTL), misal hapus yg > 15 menit
  const TTL_MS = Number(process.env.RESULT_TTL_MS || 15 * 60 * 1000)
  setInterval(async () => {
    const now = Date.now()
    let changed = false
    for (const [jobId, result] of Object.entries(resultsStore)) {
      const ts = result?.finishedAt || result?.cpu?.finishedAt || 0
      const anchor = typeof ts === 'number' ? ts : (result?.queueLengthTime || 0)
      if (anchor && now - anchor > TTL_MS) {
        delete resultsStore[jobId]
        changed = true
      }
    }
    if (changed) {
      await queueWriteDb(async (db) => {
        for (const jobId of Object.keys(db.results || {})) {
          const res = db.results[jobId]
          const ts = res?.finishedAt || res?.cpu?.finishedAt || 0
          const anchor = typeof ts === 'number' ? ts : 0
          if (anchor && now - anchor > TTL_MS) {
            delete db.results[jobId]
          }
        }
        return db
      })
    }
  }, 60 * 1000)
})()

// ==== 404 Handler ====
app.use((req, res) => { res.status(404).json({ code: 404, message: 'Not Found' }) })

if (process.env.NODE_ENV == 'development') module.exports = app
