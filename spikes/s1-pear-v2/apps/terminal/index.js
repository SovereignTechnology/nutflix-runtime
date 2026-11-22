/* global Pear, Bare */
'use strict'
// S1: a minimal Bare terminal app. Prints one result line and exits.
const out = (data) => console.log('S1 ' + JSON.stringify({ tag: 'terminal-app', ...data }))

async function main () {
  const app = Pear.app || Pear.config
  const v = await Pear.versions()
  out({
    ok: true,
    bare: Bare.version,
    link: app.link,
    key: app.key ? 'set' : null,
    dev: app.dev,
    platform: v.platform && { key: v.platform.key, length: v.platform.length, fork: v.platform.fork },
    app: v.app && { length: v.app.length, fork: v.app.fork },
    runtimes: v.runtimes
  })
  Pear.exit(0)
}

main().catch((err) => {
  out({ ok: false, message: err.message })
  Pear.exit(1)
})
