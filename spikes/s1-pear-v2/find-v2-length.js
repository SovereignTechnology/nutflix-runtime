'use strict'
// S1 step 1: open the Pear platform drive read-only and find the last pre-v3 length.
//
//   node find-v2-length.js <empty-store-dir> [platform-key]
//
// Reads only /package.json and /CHANGELOG.md at chosen checkouts (metadata plus two small
// blobs per probe), bisects for the first length whose version is 3.x, walks the write batch
// at that boundary, and probes whether peers still hold the old by-arch blobs. Every result
// line starts with "S1 " and is one JSON object, so the job log can be grepped.

const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const HypercoreID = require('hypercore-id-encoding')

const STORE = process.argv[2]
const KEY = process.argv[3] || 'pzcjqmpoo6szkoc4bpkw65ib9ctnrq7b6mneeinbhbheihaq6p6o'
const V3_KEY = 'smw4thqaqed9iq6bae7a9cxd4fesruixgkafe38jny33ahs33igy' // npm pear@3.0.0 pear.js PEAR_KEY
const HOST = 'linux-x64'
const PEER_WAIT_MS = 10 * 60 * 1000
const READ_TIMEOUT_MS = 120 * 1000

if (!STORE) {
  console.error('usage: node find-v2-length.js <empty-store-dir> [key]')
  process.exit(2)
}

const t0 = Date.now()
const out = (tag, data) => console.log('S1 ' + JSON.stringify({ tag, t: Math.round((Date.now() - t0) / 1000), ...data }))

function withTimeout (p, ms, what) {
  let timer
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout: ' + what)), ms) })
  ])
}

function major (v) {
  const m = /^v?(\d+)\./.exec(v || '')
  return m ? Number(m[1]) : null
}

async function main () {
  const store = new Corestore(STORE)
  const drive = new Hyperdrive(store, HypercoreID.decode(KEY))
  await drive.ready()
  out('open', { key: HypercoreID.normalize(KEY), discoveryKey: drive.discoveryKey.toString('hex') })

  const swarm = new Hyperswarm()
  let conns = 0
  swarm.on('connection', (c) => { conns++; store.replicate(c) })
  swarm.join(drive.discoveryKey, { client: true, server: false })
  const done = drive.findingPeers()
  swarm.flush().then(done, done)

  // wait until at least one peer has told us the length
  const deadline = Date.now() + PEER_WAIT_MS
  while (drive.core.length === 0 && Date.now() < deadline) {
    await withTimeout(drive.core.update({ wait: true }), 60000, 'update').catch(() => {})
    if (drive.core.length === 0) await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  out('peers', {
    connections: conns,
    corePeers: drive.core.peers.length,
    length: drive.core.length,
    fork: drive.core.fork,
    nat: { randomized: swarm.dht.randomized, firewalled: swarm.dht.firewalled, host: swarm.dht.host ? 'set' : null }
  })
  if (drive.core.length === 0) {
    out('verdict', { fetched: false, reason: 'no peer reported a length within ' + PEER_WAIT_MS / 1000 + ' s' })
    await swarm.destroy(); await store.close()
    process.exitCode = 3
    return
  }

  const latest = drive.core.length
  const cache = new Map()
  async function readAt (len, path) {
    const k = len + path
    if (cache.has(k)) return cache.get(k)
    const snap = drive.checkout(len)
    try {
      const buf = await withTimeout(snap.get(path, { wait: true, timeout: READ_TIMEOUT_MS }), READ_TIMEOUT_MS + 5000, path + '@' + len)
      const v = buf === null ? null : buf.toString()
      cache.set(k, v)
      return v
    } finally {
      await snap.close()
    }
  }
  async function versionAt (len) {
    const s = await readAt(len, '/package.json')
    if (s === null) return null
    try { return JSON.parse(s).version || null } catch { return 'unparseable' }
  }
  async function changelogTopAt (len) {
    const s = await readAt(len, '/CHANGELOG.md')
    if (s === null) return null
    const m = /^##\s+(v?\d[^\s]*)/m.exec(s)
    return m ? m[1] : 'none'
  }

  const latestVersion = await versionAt(latest)
  out('latest', { length: latest, fork: drive.core.fork, version: latestVersion, changelogTop: await changelogTopAt(latest) })

  // Bisect: smallest length whose /package.json version has major >= 3.
  async function firstAtLeast3 (probe) {
    let lo = 1
    let hi = latest
    if ((major(await probe(hi)) ?? 0) < 3) return null
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      const v = await probe(mid)
      out('probe', { length: mid, value: v })
      if ((major(v) ?? 0) >= 3) hi = mid
      else lo = mid + 1
    }
    return lo
  }

  const firstPkg3 = await firstAtLeast3(versionAt)
  const firstLog3 = await firstAtLeast3(changelogTopAt)
  out('boundary', {
    firstLengthPackageJson3: firstPkg3,
    firstLengthChangelog3: firstLog3,
    versionBefore: firstPkg3 ? await versionAt(firstPkg3 - 1) : latestVersion,
    changelogBefore: firstLog3 ? await changelogTopAt(firstLog3 - 1) : null
  })

  // The write batch around the boundary: keys and seqs, so the clean pre-v3 length can be read off.
  let pinned = latest
  if (firstLog3 !== null) {
    const from = Math.max(1, Math.min(firstLog3, firstPkg3 ?? firstLog3) - 25)
    const to = Math.min(latest, Math.max(firstLog3, firstPkg3 ?? firstLog3) + 3)
    const hist = []
    for await (const e of drive.db.createHistoryStream({ gte: from, lt: to })) {
      hist.push({ seq: e.seq, type: e.type, key: e.key })
    }
    out('history', { from, to, entries: hist })
    // Pear stages in sorted key order and /CHANGELOG.md sorts near the top, so the batch that
    // brought v3 starts at or just before the CHANGELOG flip. Take the length before the first
    // entry of the increasing-key run that contains the flip.
    let start = firstLog3 - 1
    const bySeq = new Map(hist.map((e) => [e.seq, e]))
    while (bySeq.has(start - 1) && bySeq.has(start) && bySeq.get(start - 1).key < bySeq.get(start).key) start--
    pinned = start
    out('pin', {
      candidateLength: pinned,
      versionAtPin: await versionAt(pinned),
      changelogAtPin: await changelogTopAt(pinned),
      versionAtPinMinus1: await versionAt(pinned - 1),
      firstEntryOfV3Batch: bySeq.get(start) || null
    })
  }

  // Are the old blobs still served? Look at by-arch/<host>/bin/pear-runtime at the pin and ask
  // for its first and last blocks.
  const snap = drive.checkout(pinned)
  try {
    const entry = await withTimeout(snap.entry('/by-arch/' + HOST + '/bin/pear-runtime', { wait: true, timeout: READ_TIMEOUT_MS }), READ_TIMEOUT_MS + 5000, 'entry')
    const blobs = await snap.getBlobs()
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const peerInfo = blobs.core.peers.map((p) => ({ remoteLength: p.remoteLength, remoteContiguousLength: p.remoteContiguousLength, remoteFork: p.remoteFork }))
    const res = { entry: entry ? { blob: entry.value.blob, executable: entry.value.executable } : null, blobsLength: blobs.core.length, blobPeers: peerInfo }
    if (entry && entry.value.blob) {
      const { blockOffset, blockLength } = entry.value.blob
      const first = await withTimeout(blobs.core.get(blockOffset, { timeout: READ_TIMEOUT_MS }), READ_TIMEOUT_MS + 5000, 'first block').then((b) => b.length, (e) => 'ERR ' + e.message)
      const last = await withTimeout(blobs.core.get(blockOffset + blockLength - 1, { timeout: READ_TIMEOUT_MS }), READ_TIMEOUT_MS + 5000, 'last block').then((b) => b.length, (e) => 'ERR ' + e.message)
      res.firstBlockBytes = first
      res.lastBlockBytes = last
      res.firstBlockIsElf = first !== null && typeof first === 'number' ? (await blobs.core.get(blockOffset)).subarray(0, 4).toString('hex') : null
    }
    out('blobs', res)
  } catch (err) {
    out('blobs', { error: err.message })
  } finally {
    await snap.close()
  }

  if (firstLog3 === null && firstPkg3 === null) {
    out('pin', { candidateLength: pinned, reason: 'no 3.x anywhere on this key: the latest length is the last pre-v3 release', versionAtPin: await versionAt(pinned), changelogAtPin: await changelogTopAt(pinned) })
  }
  out('summary', { latestLength: latest, latestVersion, fork: drive.core.fork, pinnedLength: pinned, pinnedVersion: await versionAt(pinned) })

  // For the record: what the v3 bootstrapper (npm pear@3.0.0) installs from.
  const v3 = new Hyperdrive(store, HypercoreID.decode(V3_KEY))
  await v3.ready()
  swarm.join(v3.discoveryKey, { client: true, server: false })
  await swarm.flush()
  await withTimeout(v3.core.update({ wait: true }), 120000, 'v3 update').catch(() => {})
  const v3pkg = v3.core.length ? await withTimeout(v3.get('/package.json', { wait: true, timeout: 60000 }), 65000, 'v3 pkg').catch(() => null) : null
  const top = []
  if (v3.core.length) {
    try { for await (const name of v3.readdir('/')) { top.push(name); if (top.length >= 20) break } } catch {}
  }
  out('v3-key', { key: V3_KEY, length: v3.core.length, fork: v3.core.fork, peers: v3.core.peers.length, packageVersion: v3pkg ? JSON.parse(v3pkg).version : null, topLevel: top })

  await swarm.destroy()
  await store.close()
}

main().catch((err) => {
  out('error', { message: err.message, stack: err.stack.split('\n').slice(0, 4) })
  process.exitCode = 1
})
