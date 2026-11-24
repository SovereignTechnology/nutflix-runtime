# @nutflix-runtime/shell-pear-v2

> **This is unsandboxed legacy software. Prefer the Pear v3 app: `pear install pear://<key>`
> ([`shells/pear-v3`](../pear-v3/README.md)).**
>
> On Pear v2.6.5 the window has Node access and no sandbox, and an app cannot change that. Its engine
> is Chromium 130, from October 2024, and the pin keeps it there. If code from a stranger ever runs
> in this window, it runs as you: it can read your files and your environment. The measures below
> make that less likely. **None of them is a sandbox.**

The same [renderer](../../packages/renderer/README.md) and [worker](../../packages/worker/README.md)
as the Pear v3 app, under a pinned pre-v3 runtime, so that `pear run pear://…` works. This is shape
(b) of [ADR 0001](../../docs/decisions/0001-a-pear-native-nutflix.md), kept as a risk the maintainer
accepted in writing (amendment, item 1). It is a separate build on a separate link and depends on
nothing in `shells/pear-v3`.

**It has not been released, and no link exists.** The build refuses to stage for release until a
SovTech release line of the platform exists (below).

## Run it

Once a release exists, run **the versioned link that a signed release notice names**:

```sh
pear run pear://<fork>.<length>.<key>
```

- Do not run the plain `pear://<key>` link. This runtime updates apps without asking them, so that
  link trusts the multisig key alone. The window says so if you do.
- `pear` here means the v2 runtime installed from the SovTech release line. **Installing Pear v3
  removes the v2 `pear` from your `PATH`** (S1), and v3 has no `pear run`.
- Linux x64 only. Another target needs its own real install-and-launch test first (ADR amendment,
  item 6).

## What it refuses to do

- **Run on any other platform.** At start the Bare main compares the Pear version, the Bare version
  and the platform's key, fork and length with what its build names, and exits on any difference.
- **Sign anything, or hold a wallet.** There is no sign-in in this build, and two separate things
  stop a local signing key. The page gate refuses every `signer.*` method by name. And the shell
  gives the worker its data plane only (`src/bare/data-plane.ts`), without the `system` that
  builds the worker's signer, so the worker itself answers those methods `unsupported-input` and
  writes no key file. Staging fails if the shared renderer ever offers sign-in. If signing comes
  to this shape, it may only be a NIP-46 bunker.
- **Seed or publish.** The page gate allows `status`, `nfx.play.open` and `nfx.play.close`, and
  nothing else, including any method a later worker adds. The worker's seeder key is a network
  identity and is treated as exposed.
- **Show remote images, or read relay information over `https:`.** The window's network list is
  `http://127.0.0.1` alone, because decoding a stranger's image here needs no click and has no
  sandbox around it. So thumbnails are blank and NIP-11 search hints are not read. Relays still
  work: the runtime's filter does not cover WebSockets.

### WebRTC is off by default

Shape (a) sets `webRTCIPHandlingPolicy` so that a peer sees one public address. **This runtime
cannot set it.** Measured in the real window: all 4 ICE candidates were raw host addresses, none
hidden behind mDNS. With WebRTC on, a peer could learn your local network and VPN addresses as well
as your public IP.

So this shape starts with WebRTC off and plays over HyperDHT alone, and Settings says why. You can
turn it on there, and that choice is kept across restarts. If the window has no working storage,
the off switch cannot be saved, so the shell removes `RTCPeerConnection` from the page instead.
With WebRTC off, the page gathers no addresses and signals nothing. The pinned player library does
construct one unconfigured `RTCPeerConnection` when it loads, to test for the promise API, and
closes it without a local description. The pinned player library does load on Chromium 130, but
**a WebRTC mesh playback has not been run on this runtime.**

## How it runs

```
page (http://127.0.0.1:<port>, Node integration, no sandbox)
   │  nutflixWorkerPipe ── Pear's page-to-Bare stream, relayed by Electron main to fd 3
   ▼
Bare main: PageGate ── allow-list, decoded and re-encoded, its own request ids
   ▼
the worker, in the same process
```

- **No RPC listens on a socket.** The pipe is an inherited file descriptor. This was S1's open
  question, and it works; S1's probe hung in `import('pear-pipe')`, not in the pipe.
- **`pear-bridge` is not used.** It rewrites every `.js` file, which breaks classic scripts and every
  SRI hash, and it serves the whole app drive. `src/bare/page-server.ts` serves the exact bytes of a
  fixed list of files, and only to a request with this listener's `Host` and the `X-Pear` header.
  Its port is derived from the app's key, because the page's settings live in that origin.
- **The script policy is a `<meta>`, first in the document, and must not be a header.** The runtime's
  preload evaluates its boot bundle in the document. A header policy with no `unsafe-eval` applies
  from the first instant and stops it, and the window then has no `Pear` and no pipe. The `<meta>`
  takes effect after the preload and before any of the page's scripts. The header carries only
  `frame-ancestors 'none'`.
- **Remote fields are text.** The renderer's lint refuses every HTML sink, and the same rules cover
  the script this shell adds (`src/page/`).
- **Links** go through the renderer's `externalLink` rule (`https:`, no user-info, a public host)
  before `window.open`, because the runtime hands that to `shell.openExternal` with no scheme check.

### Known weaknesses of the runtime

From its source, and not fixable from an app:

- The page's environment variables are in its `process.argv`. Any token in the shell that started
  the app is readable by code in the page.
- The GUI's navigation check is a string prefix (`url.startsWith(bridge)`), so
  `http://127.0.0.1:<port>@<host>/` counts as the app's own origin. The network filter still blocks
  other hosts, but another port on `127.0.0.1` would load in this window. The renderer's link guard
  is what keeps a remote URL from reaching navigation.
- `pear-electron` carries a patch for its boot bundle, but Pear v2.6.5 never applies it: the patch
  waits for a message this sidecar does not send. The installed bundle differs from the patch by 89
  bytes. S1 and the two points above read the patch's source.

## Pins

| What | Version |
| --- | --- |
| Pear platform | v2.6.5, `pear://0.3243.pzcjq…`, as a copy on a SovTech release line |
| Bare | 1.24.3 |
| Electron / Chromium | 33.2.1 / 130 |
| `pear-electron` | 1.7.28, whose UI drive is `pear://0.940.cktxz…` |
| Bare modules | [`app/package-lock.json`](app/package-lock.json), its own lockfile |

The worker's locked `bare-fs` needs Bare 1.28, so `app/package.json` holds `bare-fs` 4.7.1 and
overrides the other `bare-*` modules to the versions Pear v2.6.5 itself locks. A test refuses any
package that needs a newer Bare. Shape (a)'s lockfile is unchanged.

`RELEASE_LINE` in `src/shared/pins.ts` is `null`. Creating that line means republishing Holepunch's
platform on a key SovTech holds, and seeding it, which is the maintainer's step. Until then
`scripts/stage.ts` makes test builds only, and a test line cannot be Holepunch's key.

## What CI proves, and what it does not

GitHub runners are never peers of the public network, and Pear v2.6.5 has no download but its drive
on the public DHT. So **GitHub never runs `pear`.**

- **On GitHub** (`.github/workflows/pear-v2.yml`, and the unit tests in `ci.yml`): the app's lockfile
  is clean, a test build stages, and the staged worker answers through the gate on a real Bare with
  packets to the public DHT counted. That Bare is 1.24.2, the nearest published build to 1.24.3.
- **In a throwaway VM** (`proof/run.sh`): the real thing. It fetches Pear v2.6.5 from the public DHT
  as a client, copies it to a key made in the VM, and installs from that key over a private DHT on
  `127.0.0.1`. It then stages the app to a versioned link there and starts it with `pear run`. The
  checks read the real window over the debugger port: the pinned runtime, the CSP, a page-to-worker
  round trip, the label, WebRTC off, refused injections, a real video playing with a stranger's HTML
  as its title and no ICE gathering, refused methods and links, no RPC on any socket, no
  signing key on disk, a clean exit, settings kept across a restart, and a refusal on the wrong
  platform.

Not proved: a real SovTech release line, a real signed notice, a WebRTC mesh playback here, any
target but Linux x64, and any attack on the Chromium 130 engine itself.
