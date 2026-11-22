'use strict'
// S1 hold candidate: re-home the pinned platform onto a release line we control.
//
//   node mirror-release-line.js <src-store> <dst-store> <length> [fork] [key]
//
// Copies checkout(<length>) of the Pear platform drive into a NEW writable Hyperdrive (its own
// key pair, kept in <dst-store> inside the VM), keeping only linux-x64 binaries and prebuilds,
// prints the new drive's public key and length as one "S1 " line, then seeds it until killed.
// An install bootstrapped from that key has it as CHECKOUT.key, so its sidecar's updater follows
// the copy, which nobody moves to v3.

const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const HypercoreID = require('hypercore-id-encoding')

const [SRC, DST, LEN, FORK = '0', KEY = 'pzcjqmpoo6szkoc4bpkw65ib9ctnrq7b6mneeinbhbheihaq6p6o'] = process.argv.slice(2)
const LENGTH = Number(LEN)
const HOST = 'linux-x64'
const t0 = Date.now()
const out = (tag, data) => console.log('S1 ' + JSON.stringify({ tag, t: Math.round((Date.now() - t0) / 1000), ...data }))

function keep (key) {
  const arch = /\/(by-arch|prebuilds)\/([^/]+)/.exec(key)
  return !arch || arch[2] === HOST
}

async function main () {
  const srcStore = new Corestore(SRC)
  const src = new Hyperdrive(srcStore, HypercoreID.decode(KEY))
  await src.ready()
  const swarm = new Hyperswarm()
  swarm.on('connection', (c) => srcStore.replicate(c))
  swarm.join(src.discoveryKey, { client: true, server: false })
  const done = src.findingPeers()
  swarm.flush().then(done, done)
  while (src.core.length < LENGTH) {
    await src.core.update({ wait: true })
    if (src.core.length < LENGTH) await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  if (src.core.fork !== Number(FORK)) throw new Error('fork mismatch ' + src.core.fork)

  const dstStore = new Corestore(DST)
  const dst = new Hyperdrive(dstStore)
  await dst.ready()

  const snap = src.checkout(LENGTH)
  const m = snap.mirror(dst, { filter: keep, preload: false, prune: false })
  await m.done()
  await snap.close()
  out('release-line', {
    key: HypercoreID.normalize(dst.key),
    length: dst.core.length,
    fork: dst.core.fork,
    files: m.count.files,
    added: m.count.add,
    bytesAdded: m.bytesAdded,
    sourceLength: LENGTH,
    version: JSON.parse((await dst.get('/package.json')).toString()).version
  })

  await swarm.destroy()
  const seeder = new Hyperswarm()
  seeder.on('connection', (c) => dstStore.replicate(c))
  await seeder.join(dst.discoveryKey, { server: true, client: false }).flushed()
  out('release-line-seeding', { discoveryKey: dst.discoveryKey.toString('hex') })

  // SIGUSR2: publish a new release on this line, the way an upstream platform update arrives.
  // It adds a file under by-arch/<host> (forces a new swap, so `current` moves) and bumps the
  // version in /package.json.
  let n = 0
  process.on('SIGUSR2', async () => {
    n++
    try {
      const pkg = JSON.parse((await dst.get('/package.json')).toString())
      pkg.version = '2.6.5-s1.' + n
      const batch = dst.batch()
      await batch.put('/by-arch/' + HOST + '/s1-update-' + n + '.txt', Buffer.from('s1 update ' + n + '\n'))
      await batch.put('/package.json', Buffer.from(JSON.stringify(pkg, null, 2) + '\n'))
      await batch.flush()
      out('release-line-appended', { n, length: dst.core.length, version: pkg.version })
    } catch (err) {
      out('release-line-append-error', { n, message: err.message })
    }
  })
  process.on('SIGTERM', async () => { await seeder.destroy(); await dstStore.close(); await srcStore.close(); process.exit(0) })
}

main().catch((err) => {
  out('release-line-error', { message: err.message })
  process.exit(1)
})
