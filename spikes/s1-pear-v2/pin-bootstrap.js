'use strict'
// S1 step 2: install the Pear platform at a FIXED drive length into <pear-dir>.
//
//   node pin-bootstrap.js <pear-dir> <length> [fork] [key]
//
// pear-updater-bootstrap's `length` option is not a pin: it is the checkout the updater treats
// as already installed, and pear-updater then installs drive.core.length, the newest length the
// peers report. So this script hands pear-updater 3.10.0 (the version pear@2.0.1 uses) a view
// of the drive whose core reports the pinned length and never emits 'append'. Everything else
// (by-arch mirror into by-dkey/<dkey>/<n>, the boot bundle with checkout.js, the `checkout`
// file, the `current` symlink) is pear-updater's own code, exactly as `npx pear` would run it.

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const HypercoreID = require('hypercore-id-encoding')
const Updater = require('pear-updater')

const DIR = process.argv[2]
const LENGTH = Number(process.argv[3])
const FORK = Number(process.argv[4] || 0)
const KEY = process.argv[5] || 'pzcjqmpoo6szkoc4bpkw65ib9ctnrq7b6mneeinbhbheihaq6p6o'
const PEER_WAIT_MS = 10 * 60 * 1000
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000

if (!DIR || !Number.isInteger(LENGTH) || LENGTH < 1) {
  console.error('usage: node pin-bootstrap.js <pear-dir> <length> [fork] [key]')
  process.exit(2)
}

const t0 = Date.now()
const out = (tag, data) => console.log('S1 ' + JSON.stringify({ tag, t: Math.round((Date.now() - t0) / 1000), ...data }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function pinnedView (drive, length) {
  const core = {
    get id () { return drive.core.id },
    get key () { return drive.core.key },
    get fork () { return drive.core.fork },
    length,
    on () {},
    removeListener () {}
  }
  return {
    core,
    get key () { return drive.key },
    get discoveryKey () { return drive.discoveryKey },
    ready: () => drive.ready(),
    checkout: (len) => drive.checkout(len),
    getBlobs: () => drive.getBlobs()
  }
}

async function main () {
  fs.mkdirSync(DIR, { recursive: true })
  const corestore = new Corestore(path.join(DIR, 'corestores/platform'))
  const drive = new Hyperdrive(corestore, HypercoreID.decode(KEY))
  await drive.ready()

  const swarm = new Hyperswarm()
  swarm.on('connection', (c) => corestore.replicate(c))
  swarm.join(drive.discoveryKey, { client: true, server: false })
  const done = drive.findingPeers()
  swarm.flush().then(done, done)

  const deadline = Date.now() + PEER_WAIT_MS
  while (drive.core.length < LENGTH && Date.now() < deadline) {
    await drive.core.update({ wait: true }).catch(() => {})
    if (drive.core.length < LENGTH) await sleep(5000)
  }
  out('pin-peers', { peers: drive.core.peers.length, remoteLength: drive.core.length, fork: drive.core.fork, pin: LENGTH, pinFork: FORK })
  if (drive.core.length < LENGTH) throw new Error('no peer reported length >= ' + LENGTH)
  if (drive.core.fork !== FORK) throw new Error('fork mismatch: drive fork ' + drive.core.fork + ', pin fork ' + FORK)

  const u = new Updater(pinnedView(drive, LENGTH), {
    directory: DIR,
    checkout: { key: drive.core.id, length: 0, fork: FORK },
    lock: path.join(DIR, 'lock')
  })
  u.on('updating', (c) => out('pin-updating', { length: c.length, fork: c.fork }))

  const blobs = await drive.getBlobs()
  let bytes = 0
  blobs.core.on('download', (i, n) => { bytes += n })
  const ticker = setInterval(() => out('pin-progress', { status: u.status, downloadedBytes: bytes, blobPeers: blobs.core.peers.length }), 20000)

  const end = Date.now() + INSTALL_TIMEOUT_MS
  while (!(u.updated && u.checkout.length === LENGTH) && Date.now() < end) await sleep(1000)
  clearInterval(ticker)
  if (!(u.updated && u.checkout.length === LENGTH)) throw new Error('install did not finish in ' + INSTALL_TIMEOUT_MS / 1000 + ' s; status ' + u.status + ', bytes ' + bytes)

  const applied = await u.applyUpdate()
  const current = path.join(DIR, 'current')
  const runtime = path.join(current, 'by-arch/linux-x64/bin/pear-runtime')
  const sha = crypto.createHash('sha256').update(fs.readFileSync(runtime)).digest('hex')
  const snap = drive.checkout(LENGTH)
  const pkg = JSON.parse(((await snap.get('/package.json')) || '{}').toString())
  await snap.close()
  out('pin-installed', {
    swapEntries: fs.readdirSync(fs.realpathSync(current)),
    applied: applied && { key: HypercoreID.normalize(applied.key), length: applied.length, fork: applied.fork },
    current: fs.readlinkSync(current),
    runtimeSha256: sha,
    packageVersion: pkg.version || null,
    downloadedBytes: bytes,
    seconds: Math.round((Date.now() - t0) / 1000)
  })

  await u.close()
  await swarm.destroy()
  await corestore.close()
}

main().catch((err) => {
  out('pin-error', { message: err.message })
  process.exit(1)
})
