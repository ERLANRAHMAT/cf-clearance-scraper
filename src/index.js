const express = require('express')
const app = express()
const port = process.env.PORT || 3000
const bodyParser = require('body-parser')
const authToken = process.env.authToken || null
const cors = require('cors')
const reqValidate = require('./module/reqValidate')
const pidusage = require('pidusage')  // <=== Tambahkan ini

// ==== Konfigurasi VPS & Slot ====
const vCPU = 8                     // VPS kamu 8 vCPU
const slotPerRequest = 2           // 1 request dianggap makan 2 slot
const cpuThreshold = 0.85          // Maks CPU usage (85% dari total)

let requestQueue = []
let processingQueue = false

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

// ==== Cek CPU Usage Real-time ====
async function canProcessNow() {
    const stats = await pidusage(process.pid)
    const cpuUsageFraction = stats.cpu / (100 * vCPU) // cpu% / (100*vCPU)
    return cpuUsageFraction < cpuThreshold
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
    for (let i = 0; i < maxRetry; i++) {
        const result = await processRequest(data)
        if (result.code !== 500) {
            return { success: true, ...result }
        }
        console.log(`Retry #${i + 1} for mode ${data.mode}`)
        await new Promise(resolve => setTimeout(resolve, delay))
    }
    return { success: false, code: 200, message: `Failed after ${maxRetry} retries` }
}

// ==== Endpoint utama ====
app.post('/cf-clearance-scraper', async (req, res) => {
    const data = req.body
    const check = reqValidate(data)

    // Validasi request
    if (check !== true) return res.status(400).json({ code: 400, message: 'Bad Request', schema: check })
    if (authToken && data.authToken !== authToken) return res.status(401).json({ code: 401, message: 'Unauthorized' })
    if (process.env.SKIP_LAUNCH != 'true' && !global.browser) 
        return res.status(503).json({ code: 503, message: 'The scanner is not ready yet.' })

    // Jika CPU belum overload dan queue kosong → proses langsung
    if (await canProcessNow() && requestQueue.length === 0) {
        const result = await retryUntilSuccessOrGiveUp(data)
        return res.status(200).send(result)
    }

    // Kalau overload → masuk queue
    requestQueue.push({ data, res })
    console.log(`Request masuk queue. Queue length: ${requestQueue.length}`)
    processQueue()
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

        const { data, res } = requestQueue.shift()
        console.log(`Proses request dari queue. Sisa queue: ${requestQueue.length}`)
        const result = await retryUntilSuccessOrGiveUp(data)
        res.status(200).send(result)
    }

    processingQueue = false
}

// ==== 404 Handler ====
app.use((req, res) => { res.status(404).json({ code: 404, message: 'Not Found' }) })

if (process.env.NODE_ENV == 'development') module.exports = app
