/* global Pear */
'use strict'
// S1: the Bare side of a minimal pear-electron app (the old, pre-v3 model).
// It serves a small fMP4 on a loopback port with Range support, starts the Electron UI
// through pear-electron + pear-bridge, sends the renderer that port over the pipe, prints the
// renderer's probe results as one "S1 " line, and exits.
const Runtime = require('pear-electron')
const Bridge = require('pear-bridge')
const http = require('bare-http1')
const fs = require('bare-fs')
const env = require('bare-env')
const b4a = require('b4a')

const FIXTURE = env.S1_FIXTURE || '/tmp/s1/fixture.mp4'
const TIMEOUT_MS = Number(env.S1_GUI_TIMEOUT_MS || 150000)
const out = (tag, data) => console.log('S1 ' + JSON.stringify({ tag, ...data }))
const requests = []

function serveFixture () {
  const body = fs.readFileSync(FIXTURE)
  const size = body.byteLength
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, range: req.headers.range || null })
    if (req.url !== '/x.mp4') {
      res.statusCode = 404
      res.end()
      return
    }
    res.setHeader('Content-Type', 'video/mp4')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Access-Control-Allow-Origin', '*')
    let start = 0
    let end = size - 1
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1])
        if (m[2]) end = Math.min(Number(m[2]), size - 1)
      } else {
        start = Math.max(0, size - Number(m[2]))
      }
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    }
    res.setHeader('Content-Length', String(end - start + 1))
    if (req.method === 'HEAD') return res.end()
    res.end(body.subarray(start, end + 1))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, size }))
  })
}

async function main () {
  const { port, size } = await serveFixture()
  const bridge = new Bridge()
  await bridge.ready()
  const runtime = new Runtime()
  const pipe = await runtime.start({ bridge })
  out('gui-bare', { stage: 'started', bridgeAddr: bridge.addr, videoPort: port, fixtureBytes: size })

  let done = false
  let buffered = ''
  const chunks = []
  const timer = setTimeout(() => finish({ ok: false, reason: 'timeout after ' + TIMEOUT_MS + ' ms' }), TIMEOUT_MS)

  function finish (r) {
    if (done) return
    done = true
    clearTimeout(timer)
    out('gui-bare', { stage: 'finish', ...r, pipeChunks: chunks.slice(0, 6), serverRequests: requests.slice(0, 12), serverRequestCount: requests.length })
    try { pipe.end() } catch {}
    setTimeout(() => Pear.exit(r.ok ? 0 : 1), 3000)
  }

  pipe.on('error', (err) => out('gui-bare', { stage: 'pipe-error', message: err.message }))
  pipe.on('close', () => { if (!done) finish({ ok: false, reason: 'pipe closed before results' }) })
  pipe.on('data', (data) => {
    chunks.push({ type: data && data.constructor && data.constructor.name, bytes: data.byteLength })
    buffered += b4a.toString(data)
    let nl
    while ((nl = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, nl)
      buffered = buffered.slice(nl + 1)
      let msg = null
      try { msg = JSON.parse(line) } catch { out('gui-bare', { stage: 'unparsed-line', bytes: line.length }); continue }
      if (msg.type === 'hello') {
        out('gui-bare', { stage: 'hello-from-renderer', sent: msg.sent })
        pipe.write(JSON.stringify({ type: 'config', videoPort: port, sentFromBare: Date.now() }) + '\n')
      } else if (msg.type === 'results') {
        out('gui-renderer', msg.results)
        finish({ ok: true })
      }
    }
  })
}

main().catch((err) => {
  out('gui-bare', { stage: 'error', message: err.message, stack: String(err.stack).split('\n').slice(0, 5) })
  Pear.exit(1)
})
