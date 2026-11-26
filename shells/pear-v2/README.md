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

- **The plain `pear://<key>` link does not run.** Pear v2 updates an app started from it whenever
  that key releases, with no notice and no second key, so the app starts no worker from it and the
  window says to run the versioned link instead. A local directory or `file:` run (development)
  is allowed.
- `pear` here means the v2 runtime installed from the SovTech release line. **Installing Pear v3
  removes the v2 `pear` from your `PATH`** (S1), and v3 has no `pear run`.
- Linux x64 only. Another target needs its own real install-and-launch test first (ADR amendment,
  item 6).

### Finding and checking the link

A SovTech release is announced by a Nostr event of kind 30071 with the tag `d = nutflix-runtime`,
signed by the release key
`83d8bce2f7d6966f306e6f1a712497cf0a2c77d073923136a0e2bb54963b3434` (hex; `RELEASE_PUBKEY` in
[`shells/pear-v3/packaging/update-root.ts`](../pear-v3/packaging/update-root.ts)) and published to
`wss://relay.nutflix.xyz`, `wss://relay.primal.net` and `wss://relay.ditto.pub`. Its `verlink` tag
is the versioned link, and its other tags are `version` and one `artifact` per package
([`shells/pear-v3`'s README](../pear-v3/README.md#what-counts-as-a-notice) has the format).

Before you run a link, fetch that event with any Nostr tool, check that its id and signature verify
and that its author is that key (for example `nak req -k 30071 -a <key> -t d=nutflix-runtime
wss://relay.nutflix.xyz`, then `nak verify`), and run exactly its `verlink`. Take the newest such
event: kind 30071 is replaceable, so relays keep one per author and `d` tag.

**No notice for a shape (b) build exists yet.** The notices this format describes name shape (a)'s
Pear v3 builds. Because a relay keeps only the newest event per `d` tag, a shape (b) notice could not
share `d = nutflix-runtime` with shape (a)'s without replacing it; its tag is the owner's decision,
with the release line (ADR 0001 amendment, item 1).

## What it refuses to do

- **Run on any other platform.** At start the Bare main compares the Pear version, the Bare version
  and the platform's key, fork and length with what its build names, and exits on any difference.
- **Sign, publish or seed.** This shape is watch only (ADR 0001 amendment, item 1): its window has
  Node access and no sandbox, so it has no safe place to type a passphrase or a bunker link. There
  is no Account menu, no secret prompt, and no signer, Studio, publishing or seeding control
  (the renderer runs with `seedPublish: false`). Separate layers hold it:
  - **the page gate** allows `status`, `nfx.play.open` and `nfx.play.close` and nothing else, so
    every `signer.*`, `studio.*`, `seeding.*`, `nfx.seed.*`, `nfx.endpoint` and `app.*` method is
    refused, including any a later worker adds;
  - **for signing and publishing, the worker itself:** it gets its data plane only
    (`src/bare/data-plane.ts`), with no `system`, so it has no signer and no Studio and answers
    their methods `unsupported-input`, and it starts with `localKey: false`;
  - **for seeding, the worker itself:** it starts with `watchOnly: true`, so nothing stored is
    served and no listener opens, at start or later, and it answers `nfx.seed.start`,
    `seeding.watch`, `seeding.resume` and `seeding.set` with `watched: true` `unsupported-input`;
  - **main** turns the seeding switch off at every start and opens no window unless the worker
    confirms it.

  None of these stops code that already runs in the page: it has Node, and can do what you can.

  The worker's seeder key is a network identity and is treated as exposed.
- **Show remote images, or read relay information over `https:`.** The window's network list is
  `http://127.0.0.1` alone, because decoding a stranger's image here needs no click and has no
  sandbox around it. So thumbnails are blank and NIP-11 search hints are not read. Relays still
  work: the runtime's filter does not cover WebSockets.
- **Play a video only nfxd serves.** Shape (a) plays such a video from the `https` origins its
  beacons name (ADR 0001, amendment of 2026-11-26). This window may not fetch from them, so the
  renderer runs here with `beaconOrigins: false`: it never asks for them, and such a video fails
  with a message that says this window does not fetch from HTTPS hosts. Videos a HyperDHT seeder
  serves play as before.

### WebRTC is off by default

Shape (a) sets `webRTCIPHandlingPolicy` so that a peer sees one public address. **This runtime
cannot set it.** Measured in the real window: all 4 ICE candidates were raw host addresses, none
hidden behind mDNS. With WebRTC on, a WebRTC peer could learn your local network and VPN addresses
as well as your public IP.

The worker's HyperDHT node, which plays with WebRTC off, is set never to share them, in both
shapes: it dials with `localConnection: false` and listens with `shareLocalAddress: false`
(`packages/worker/src/net/no-local-addresses.ts`). Left at hyperdht's defaults, every connection
would carry every local IPv4 address of this machine to the other side. A seeder still learns your
public address, as any peer does. The cost: a seeder on your own LAN, behind a router without NAT
loopback, may not be reachable. nutflix-pear's desktop app still shares local addresses; that is
not changed here. The one exception is a node bound to `127.0.0.1`, which the worker's is when
every bootstrap node is `127.0.0.1` (the tests and the proof): it reaches nothing off this machine,
and the local address is how two processes on it meet. This covers the worker only. Pear's own
sidecar has a swarm of its own (see the runtime's known weaknesses below).

The key the worker dials seeders with is random, made each run and never stored, so a seeder cannot
link your plays across runs by it (`packages/worker/src/keys.ts`). It still sees your IP address.

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
- **A request that fails with no code of its own is noted on the Bare process's stderr**, one
  `nutflix: worker error: …` line with its method and the error's code, syscall and class, never its
  message, a path or its arguments (`src/bare/worker-log.ts`). The page gets the answer,
  `internal`, and no log event: the gate passes it the `status` event alone.
- **`pear-bridge` is not used.** It rewrites every `.js` file, which breaks classic scripts and every
  SRI hash, and it serves the whole app drive. `src/bare/page-server.ts` serves the exact bytes of a
  fixed list of files, and only to a request with this listener's `Host` and the `X-Pear` header.
  **Its port is derived from the app's key, so it is the same on every machine.** The page's
  settings (relays, theme, the WebRTC choice) live in that origin's storage, and a random port
  would lose them at each start. The price: a website can tell that this app is running, by trying
  that port on `127.0.0.1`. It learns nothing else: the files are public and a request without the
  listener's `Host` and `X-Pear` is refused.
- **The script policy is a `<meta>`, first in the document, and must not be a header.** The runtime's
  preload evaluates its boot bundle in the document. A header policy with no `unsafe-eval` applies
  from the first instant and stops it, and the window then has no `Pear` and no pipe. The `<meta>`
  takes effect after the preload and before any of the page's scripts. The header carries only
  `frame-ancestors 'none'`.
- **Remote fields are text.** The renderer's lint refuses every HTML sink, and the same rules cover
  the script this shell adds (`src/page/`).
- **Links** go through the renderer's `externalLink` rule (`https:`, no user-info, a public host)
  before `window.open`, because the runtime hands that to `shell.openExternal` with no scheme check.
- **A reload is a new page.** The pipe outlives it, so every page first sends a reset, and the gate
  closes what the old page opened and forgets its request ids.

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
- The sidecar replicates the app, platform and Electron UI drives with a swarm of its own, which
  this app does not configure. It plausibly shares this machine's local addresses with the peers of
  those drives, as hyperdht does by default; that is not verified (its source was not read for it).
  Anyone can announce on a public drive's topic, so such a peer can be anyone.

## Pins

| What | Version |
| --- | --- |
| Pear platform | v2.6.5, `pear://0.3243.pzcjq…`, as a copy on a SovTech release line |
| Bare | 1.24.3 |
| Electron / Chromium | 33.2.1 / 130 |
| `pear-electron` | 1.7.28, whose Electron UI drive is `pear://0.940.cktxz…`, **on Holepunch's key** |
| Bare modules | [`app/package-lock.json`](app/package-lock.json), its own lockfile |

The worker's locked `bare-fs` needs Bare 1.28, so `app/package.json` holds `bare-fs` 4.7.1 and
`bare-http1` 4.5.6 and overrides the other `bare-*` modules to the versions Pear v2.6.5 itself
locks. Every other dependency of the worker and of nutflix-pear's packages is pinned at the same
version as shape (a), and a test says so. Shape (a)'s lockfile is unchanged.

The worker's `system` (Studio's ffmpeg, the NIP-46 bunker's relay socket) needs `bare-ws`,
`bare-subprocess` 6.1.0 and `bare-env` 3.0.1. Shape (b) has no `system`, so it loads the worker's
`adapters/bare-data.ts`, which imports none of them, and `scripts/stage.ts` copies only the worker
modules its entry reaches and fails if one imports any of the three. That is the worker alone:
`pear-electron`, in the same Bare process, loads `bare-subprocess` and `bare-env` itself to start
Electron, at the versions this lockfile holds (5.2.3 and 3.0.0). `bare-ws` is not installed.

`scripts/stage.ts` ships nothing already on disk: it installs the app's modules with a clean
`npm ci` of `app/package-lock.json` in a new directory (which checks every integrity hash), copies
them without `.bin`, then checks every staged package's name and version against the lockfile and
fails on any difference. It prints one sha256 over the staged tree.

The bundles (`index.js`, the page's `app.js` and `legacy.js`) and the worker and nutflix-pear
modules come from the root `node_modules` and the `tsc` output. A test build takes those as they are
on disk, which is what CI builds just before. **A release never does.** It is staged by
`scripts/release.ts`, whose own imports are `node:*` only, so no package code of this checkout runs
in it. It refuses a checkout with local changes, because what is staged is a commit. It exports
that commit (HEAD, and the submodule at its pinned commit, from the local object stores) into a new
folder under a private (0700) directory in the user's cache, and refuses if any folder above the
copy holds a `node_modules` or `package.json`. It runs a clean `npm ci --ignore-scripts` of the
root lockfile and `npm run build` there, without `NODE_OPTIONS` or `NODE_PATH`, and stages with
that copy's own `stage.ts`, which refuses a release anywhere else. `release.ts --test-line …` makes
a test build the same way.

**The Electron UI drive is not on a SovTech key.** `pear-electron` 1.7.28 names
`pear://0.940.cktxz…`, a versioned link on Holepunch's key: it fixes the fork and length, not a
content hash, and nothing of ours checks its bytes at run time. Its key holder could sign a
different tree at that length for users who have not fetched it yet, and Holepunch may stop
seeding it. Re-homing it, or checking its bytes, is an open condition before any release (ADR 0001
amendment, item 1). `UI_DRIVE` in `src/shared/pins.ts` names it, every stage checks that the
staged `pear-electron` names the same link, and **a release is refused while it is on Holepunch's
key**: closing that is the maintainer's step.

`RELEASE_LINE` in `src/shared/pins.ts` is `null`. Creating that line means republishing Holepunch's
platform on a key SovTech holds, and seeding it, which is the maintainer's step. Until both are done
`scripts/stage.ts` makes test builds only, and says which step is open. A test line cannot be
Holepunch's key.

## What CI proves, and what it does not

GitHub runners are never peers of the public network, and Pear v2.6.5 has no download but its drive
on the public DHT. So **GitHub never runs `pear`.**

- **On GitHub** (`.github/workflows/pear-v2.yml`, and the unit tests in `ci.yml`): the app's lockfile
  is clean, a test build stages, and the staged worker answers through the gate on a real Bare. That
  Bare is 1.24.2, the nearest published build to 1.24.3, and it runs in a network namespace with
  loopback alone, so nothing it does can leave the runner, by address or by name. Packets to the
  public DHT bootstrap are counted besides; that count alone would miss dht-rpc's fallback of
  resolving `nodeN.hyperdht.org` to another address.
- **In a throwaway VM** (`proof/run.sh`): the real thing. It fetches Pear v2.6.5 from the public DHT
  as a client, copies it to a key made in the VM, and installs from that key over a private DHT on
  `127.0.0.1`. It then stages the app to a versioned link there and starts it with `pear run`. The
  checks read the real window over the debugger port: the pinned runtime, the CSP, a page-to-worker
  round trip, the label, WebRTC off, refused injections, a real video playing with a stranger's HTML
  as its title and no ICE gathering, no seeding or account controls, every signer, Studio,
  seeding and `app.*` method refused, checked links, no RPC on any socket, no listener after a
  play, no signing key or signer directory on disk, a clean exit, settings kept across a restart,
  no worker from an unversioned link, and a refusal on the wrong platform.

Not proved: a real SovTech release line, a real signed notice, the Electron UI drive's bytes, a
WebRTC mesh playback here, connecting to a seeder behind a NAT, any target but Linux x64, and any
attack on the Chromium 130 engine itself.
