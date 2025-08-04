const express = require('express')
const app = express()
const port = process.env.PORT || 3000
const bodyParser = require('body-parser')
const authToken = process.env.authToken || null
const cors = require('cors')
const reqValidate = require('./module/reqValidate')
const pidusage = require('pidusage')  // Monitor CPU usage

// ==== Konfigurasi VPS & Slot ====
const vCPU = 8                     // VPS kamu 8 vCPU
const cpuThreshold = 0.85          // Maks CPU usage (85% dari total)

// ==== Queue dan Hasil ====
let requestQueue = []
let processingQueue = false
let resultsStore = {} // Simpan hasil per jobId

app.use(bodyParser.json({}))
app.use(bodyParser.urlencoded({ extended: true }))
app.use(cors())

if (process.env.NODE_ENV !== 'development') {
    let server = app.listen(port, '0.0.0.0', () => { 
        console.log(`Server running on port ${port}`) 
    })
    try { server.timeout = Number(process.env.timeOut || 60000) } catch (e) {}
}

if (process.env.SKIP_LAUNCH != 'true') require('./module/createBrowser')

// ==== Load Endpoint Modules ====
const getSource = require('./endpoints/getSource')
const solveTurnstileMin = require('./endpoints/solveTurnstile.min')
const solveTurnstileMax = require('./endpoints/solveTurnstile.max')
const wafSession = require('./endpoints/wafSession')

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

    // Fast ACK: masukkan queue, balas cepat agar Cloudflare tidak 502
    requestQueue.push({ data, jobId })
    console.log(`Job ${jobId} masuk queue. Queue length: ${requestQueue.length}`)
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
app.get('/cf-clearance-result/:jobId', async (req, res) => {
    const { jobId } = req.params
    if (!resultsStore[jobId]) {
        return res.status(200).json({
            success: false,
            status: "pending",
            message: "Job is still in queue or processing"
        })
    }
    return res.status(200).json(resultsStore[jobId])
})

// ==== Worker Queue ====
async function processQueue() {
    if (processingQueue || requestQueue.length === 0) return
    processingQueue = true

    while (requestQueue.length > 0) {
        // Tunggu sampai CPU usage turun
        while (!(await canProcessNow())) {
            await new Promise(resolve => setTimeout(resolve, 500))
        }

        const { data, jobId } = requestQueue.shift()
        console.log(`Proses job ${jobId} dari queue. Sisa queue: ${requestQueue.length}`)
        const result = await retryUntilSuccessOrGiveUp(data)

        // Simpan hasil di store
        resultsStore[jobId] = result
    }

    processingQueue = false
}

// ==== 404 Handler ====
app.use((req, res) => { res.status(404).json({ code: 404, message: 'Not Found' }) })

if (process.env.NODE_ENV == 'development') module.exports = app
