const express = require('express')
const app = express()
const port = process.env.PORT || 3000
const bodyParser = require('body-parser')
const authToken = process.env.authToken || null
const cors = require('cors')
const reqValidate = require('./module/reqValidate')

global.browserLength = 0
global.browserLimit = Number(process.env.browserLimit) || 20
global.timeOut = Number(process.env.timeOut || 60000)

// Queue manual
let requestQueue = []
let processingQueue = false

app.use(bodyParser.json({}))
app.use(bodyParser.urlencoded({ extended: true }))
app.use(cors())

if (process.env.NODE_ENV !== 'development') {
    let server = app.listen(port, () => { console.log(`Server running on port ${port}`) })
    try { server.timeout = global.timeOut } catch (e) {}
}
if (process.env.SKIP_LAUNCH != 'true') require('./module/createBrowser')

const getSource = require('./endpoints/getSource')
const solveTurnstileMin = require('./endpoints/solveTurnstile.min')
const solveTurnstileMax = require('./endpoints/solveTurnstile.max')
const wafSession = require('./endpoints/wafSession')

async function processRequest(data) {
    let result = { code: 500 }
    global.browserLength++

    try {
        switch (data.mode) {
            case "source":
                result = await getSource(data).then(res => ({ source: res, code: 200 }))
                break;
            case "turnstile-min":
                result = await solveTurnstileMin(data).then(res => ({ token: res, code: 200 }))
                break;
            case "turnstile-max":
                result = await solveTurnstileMax(data).then(res => ({ token: res, code: 200 }))
                break;
            case "waf-session":
                result = await wafSession(data).then(res => ({ ...res, code: 200 }))
                break;
        }
    } catch (err) {
        result = { code: 500, message: err.message }
    } finally {
        global.browserLength--
    }

    return result
}

async function retryUntilSuccess(data, maxRetry = 10, delay = 2000) {
    let attempts = 0
    while (attempts < maxRetry) {
        const result = await processRequest(data)
        if (result.code !== 500) return result
        attempts++
        await new Promise(resolve => setTimeout(resolve, delay))
    }
    return { code: 500, message: 'Max retry reached' }
}

// Worker untuk memproses antrian
async function processQueue() {
    if (processingQueue || requestQueue.length === 0) return
    processingQueue = true

    while (requestQueue.length > 0) {
        // Cek apakah server masih overload
        if (global.browserLength >= global.browserLimit) {
            await new Promise(resolve => setTimeout(resolve, 500)) // tunggu sebentar
            continue
        }

        const { data, res } = requestQueue.shift()
        const result = await retryUntilSuccess(data)
        res.status(result.code ?? 500).send(result)
    }

    processingQueue = false
}

app.post('/cf-clearance-scraper', async (req, res) => {
    const data = req.body
    const check = reqValidate(data)

    if (check !== true) return res.status(400).json({ code: 400, message: 'Bad Request', schema: check })
    if (authToken && data.authToken !== authToken) return res.status(401).json({ code: 401, message: 'Unauthorized' })
    if (process.env.SKIP_LAUNCH != 'true' && !global.browser) return res.status(500).json({ code: 500, message: 'The scanner is not ready yet. Please try again a little later.' })

    // Kalau tidak overload, langsung proses
    if (global.browserLength < global.browserLimit && requestQueue.length === 0) {
        const result = await retryUntilSuccess(data)
        return res.status(result.code ?? 500).send(result)
    }

    // Kalau overload, masuk antrian
    requestQueue.push({ data, res })
    processQueue() // jalanin worker
})

app.use((req, res) => { res.status(404).json({ code: 404, message: 'Not Found' }) })

if (process.env.NODE_ENV == 'development') module.exports = app
