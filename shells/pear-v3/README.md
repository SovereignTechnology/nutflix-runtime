# @nutflix-runtime/shell-pear-v3

The Pear v3 desktop shell ([ADR 0001](../../docs/decisions/0001-a-pear-native-nutflix.md), shape
(a)): a hardened Electron main, one narrow preload, and the [worker](../../packages/worker/README.md)
as a Bare process, in front of the [renderer](../../packages/renderer/README.md). It packages on
five targets and CI launches the packaged app on each.

| Target         | Package                     |
| -------------- | --------------------------- |
| `linux-x64`    | `Nutflix.AppImage`          |
| `linux-arm64`  | `Nutflix.AppImage`          |
| `darwin-arm64` | `Nutflix.app`               |
| `darwin-x64`   | `Nutflix.app`               |
| `win32-x64`    | `Nutflix.msix` (unsigned)   |

The names are what `pear build` requires: `<productName>.<ext>` (S2).

## Updates: only a build a signed notice names

**A shipped build runs no updater.** It is packaged with no upgrade link (`RELEASE_UPGRADE_LINK` in
`packaging/update-root.ts` is `null`), so main starts no updater process, joins no DHT topic and
asks no relay, and every launch reports `updates: off`. Setting that link is the owner's step.

With a link, the app applies a Pear update **only** when a kind-30071 Nostr release notice
(`d = nutflix-runtime`), signed by the SovTech release key, names exactly that build (ADR 0001
decision 2; the sequence is S2's):

1. On `updated`, read `next`, parse `<length>.<fork>`, build `pear://<fork>.<length>.<key>`.
2. Hash `<next>/by-arch/<host>/app/<name>`: a file's sha256, or for a macOS bundle the sha256 of a
   sorted list of every file's hash and executable bit and every symlink's target (`src/update/hash.ts`).
3. Ask the baked-in relays, and take the newest valid notice. Compare its link, version and hash.
   No match, no notice or no relay: **held**, and the window says "Unverified update held".
4. Hash again, check `next` has not moved, and call `applyUpdate()` with no `await` in between.
5. Hash the installed app to prove the swap, because `applyUpdate()` returns quietly when it did
   nothing. On Windows the installed package is not one file: the app reports that Windows accepted
   the package, and CI compares what got installed.

A held build fires `updated` again at the next start and is judged again. Nothing records an
approval. A newer build with no notice holds back an older announced one (accepted, ADR amendment,
item 4).

### Where it runs, and why

In **a Bare process of its own** (`src/update/update-worker.ts`), started by main only when the build
has a link. It builds `pear-runtime-updater`, a store and a swarm itself rather than a `PearRuntime`,
whose Bare path loads `bare-thread`, which needs a newer Bare (1.33) than the shipped one (1.31):

- not the renderer, which is untrusted and only ever receives a state to display;
- not main, because the updater replicates data from strangers, and main holds every privilege the
  app has;
- not the data worker, because it parses strangers' video and serves the renderer's RPC, so a bug
  there must not be able to reach `applyUpdate()`.

Its swarm (`src/update/swarm.ts`) dials with a Noise key pair new every run, never derived from
the store as `pear-runtime`'s is, so a peer on the drive's topic cannot link a user's update checks
across days by the key. On a release root it dials from a HyperDHT node that tells no peer this
machine's local addresses (`hideLocalAddressesOn`, `packages/worker/src/net/no-local-addresses.ts`),
as the worker's does: anyone can announce on the public drive's topic. A test build's root, whose private DHT on
`127.0.0.1` a release root refuses, keeps the swarm's own node and hyperdht's defaults, because its
peer there is Pear's sidecar bound to every interface, and on one host hyperdht carries data only
between peers that share local addresses and bind alike. `pear install` itself is Pear's CLI, with
a swarm this app does not configure.

Main reads the process's status frames, checks each against fixed lists (`src/update/status.ts`) and
passes the state on through `RpcGate.fromMain`. That event is on the window's `mainEvents`
allow-list: the same name from the data worker is dropped, so a compromised worker cannot tell the
page an update was verified. No RPC reaches the updater.

### The trust root

The release key, the notice relays and the link are **compiled into the updater's bundle** at package
time (`src/update/root.ts`). No environment variable, switch, file in user data or RPC is read for
any of them.

- **The release path** (`package.ts stage|package|make|build`) always bakes in `releaseRoot()`. It has
  no option that names another, and it reads the bundle back and refuses anything but the production
  root.
- **The test path** (`package.ts test-build --update-root <file>`) is what CI uses. It refuses the
  production key, and any relay or DHT node off `127.0.0.1`. There is no such switch in the app.

### What counts as a notice

Every relay is untrusted. An event is read only after size bounds, shape, kind, author, a single
`d` tag, and its id and Schnorr signature (`nostr-tools`). The shape is nutflix-pear's release
manifest plus one tag:

```
["d", "nutflix-runtime"]  ["version", "0.1.2"]  ["verlink", "pear://<fork>.<length>.<key>"]
["artifact", "Nutflix-<target>.<AppImage|app|msix>", "<sha256>", "<bytes>"]    one per target
```

- **The newest** is the highest `created_at`, and on a tie the lowest `id` (NIP-01). A notice more than
  a day in the future is refused.
- **Replays:** the newest valid notice seen is kept as a floor (`notice-floor.json` in the updater's
  directory), and anything older is refused. The floor can only make the gate stricter: deleting it
  loses replay protection and nothing else, and it can never make a notice valid. A fresh install
  has no floor, so a party who controls every relay AND the DHT path could still offer it an older,
  genuinely signed release.
- **One reachable relay is enough** to apply, because the signature is the authority. An unreachable
  relay only matters when no relay answers at all.

## How it runs

```
renderer (app://nutflix, sandboxed, no Node)
   │  window.nutflixWorkerPipe: write / onData / onClose / close   (preload, bytes only)
   ▼
main: RpcGate ── a window's frames are decoded, checked against ITS policy, re-encoded, and
   │             sent on with main's own request id
   ▼
Bare worker (pear-runtime run() → bare-sidecar's `bare`, Bare.IPC)
```

- **Main** (`src/main/main.ts`) sets up the window, the `app:` protocol, the gate, the worker, and
  prints the lines CI reads. Everything it wires is Electron-free and has unit tests; `main.ts` and
  the preload run only in the packaged app.
- **The renderer** is `packages/renderer`'s own build, copied into the app. It is served from one
  privileged origin, `app://nutflix`, because its policy says `'self'`, which `file:` would break.
- **Storage:** main sends the worker `init` with its storage directory (`<userData>/worker`). The
  renderer never names a path.

### What is hardened (ADR 0001 amendment, item 1)

- `sandbox: true`, `contextIsolation: true`, no `nodeIntegration` (also not in workers or
  subframes), no DevTools, written as literals in `window.ts` and pinned by a test.
- **Fuses**, read back from every packaged binary: `RunAsNode`, `EnableNodeOptionsEnvironmentVariable`,
  `EnableNodeCliInspectArguments` and `GrantFileProtocolExtraPrivileges` off. **The two asar fuses
  (`OnlyLoadAppFromAsar`, embedded integrity) are NOT set:** `pear-runtime`'s `run()` spawns Bare from
  real file paths, and an asar archive breaks every spawn (Holepunch's template says the same), so
  the app ships unpacked (`resources/app/`). The cost: main, the preload and the renderer are plain
  files that anyone who can write the install directory can change. See "For the maintainer".
- **A header CSP** on every `app:` response: the renderer's own `<meta>` policy read from the file
  being served, plus `frame-ancestors 'none'` (`src/main/csp.ts`). It refuses to start on a policy
  that allows inline script, `eval` or a frame.
- **Plain HTTP reaches the worker and nothing else** (`src/main/loopback.ts`). The policy allows
  `http://127.0.0.1:*`, because the worker's range server and NFX origin take a random port each.
  Inside that, main cancels every `http:` request of the window's session that is not to
  `127.0.0.1` on a port the worker serves now, so a compromised page cannot send requests to other
  HTTP services on the user's machine. Main learns those ports from the worker's `nfx.play.open`
  answers as they pass the gate, before the page sees them, and forgets them when the worker is gone.
  The listener has no URL filter: it sees every request, and the port is checked in main's own code,
  not by Electron's match patterns. `ws://127.0.0.1:*` is left alone: local Nostr relays use it, and
  the page owns the relay list. A `ws://127.0.0.1` relay's NIP-11 document is `http://` on the
  relay's port, so it is refused, and search to such a relay is matched in the page. The Electron
  proof (`scripts/prompt-proof.ts`, below) installs the same guard in the app's session: from a
  page, a `fetch` and a `<video>` reach a worker port, the server on another loopback port sees no
  request at all, and after the worker is replaced only the new worker's port passes.
- `webRTCIPHandlingPolicy: 'default_public_interface_only'`.
- **Navigation, redirects, `<webview>` and `window.open` are denied** for every webContents.
  Every permission is denied except `fullscreen` for the top frame of `app://nutflix`; no device
  grants, no downloads.
- **`shell.openExternal`** only for a URL that passes the renderer's `externalLink` rule, applied
  again in main (the same function: `https:`, no user-info, a public host), at most five a minute.
- **Switches:** a Chromium switch that turns a sandbox layer off, opens a DevTools target, wraps a
  child process or changes features is refused (exit 78), except `--no-sandbox`, which is the user's
  choice (below). The `app:` protocol path guard refuses dot segments, encoded separators, hidden
  files and symlinks out of the renderer's directory.

### The IPC surface

Four channels (`src/shared/ids.ts`); the page itself gets only `nutflixWorkerPipe` and
`nutflixOpenLink`.

| Channel | Direction | Carries |
| --- | --- | --- |
| `nutflix:pipe:write` | renderer → main | one frame, a `Uint8Array` of at most 1 MiB + 4 |
| `nutflix:pipe:data` | main → renderer | the worker's bytes for this window |
| `nutflix:pipe:close` | main → renderer | the pipe ended |
| `nutflix:link` | renderer → main | a string of at most 2048 characters |

Every `ipcMain` message is dropped unless it came from the top frame of a window main made, at
`app://nutflix`.

**The RPC allow-list** (`MAIN_WINDOW_POLICY`, `src/main/rpc-gate.ts`): the renderer's window may call
`status`, `nfx.play.open`, `nfx.play.close`, `signer.status`, `seeding.status`,
`seeding.watch`, `seeding.stop` (stops serving, keeps the bytes), `seeding.beacons`,
`seeding.segment`, `studio.ffmpeg`, `studio.probe`, `studio.publish` and `studio.cancel`, and hear
`status` and `studio.progress`. Any other method, `init`, `nfx.seed.*`, `nfx.endpoint`,
`seeding.set`, `seeding.resume`, `seeding.delete`, `studio.source`, `studio.discard`,
`signer.local.*`, `signer.nip46.connect`, `signer.lock`, `signer.check`, `signer.sign`, is answered `invalid-argument` in main and never reaches the worker. At most 32 requests in flight per window; a play session
belongs to the window that opened it (another window's `nfx.play.close` does nothing, a window that
goes away closes its sessions, and `seeding.segment` and `seeding.watch` must name one of its own). What the worker sees
is main's own re-encoding of a checked request, with main's id.

These methods are answered by main itself and never reach the worker as such
(`src/main/main-calls.ts`), each behind a surface only the user can answer, one at a time. A "no" is
not asked again for a minute, and turning seeding off is never held up:
- `app.pickVideo` opens the OS file picker. The path goes from main to the worker (`studio.source`);
  the page gets a random token, the base name and the size.
- `app.seeding.set` turns "seed what you watch" on only after a native confirmation that says it
  shares the user's IP address with viewers (the default answer is to keep it off).
- `app.seeding.resume` and `app.seeding.delete` serve a stopped video again, or delete a video's
  bytes, after a native confirmation.
- `app.publish.sign` has the user's signer sign Studio's draft, which publishes the video and starts
  seeding it, only after a native confirmation. The box shows the worker's account of its own draft
  (`signer.check`): the file's name, size and length, the whole npub, the whole title, the tags and
  the start of the description, with every control, format and line-separator character removed.
  "No" deletes the draft. The key the user approved goes back with the request.
- `app.sandbox.forget`, only while the app runs without Chromium's sandbox, forgets the stored "Run
  anyway" after a native confirmation (keeping it is the default answer). It takes no argument and
  can do nothing else. Main tells the window that the sandbox is off with its own `sandbox` event.

**Secret entry is reachable only from the native Account menu** (`src/main/account-menu.ts`): Unlock
Key, Create Key, Connect Bunker and Lock, with shortcuts main catches in `before-input-event`
(Ctrl or Cmd + Shift + O, K, B, L), before the page and out of its reach. No window has a method
that opens it, because a compromised page could otherwise draw its own box and own the button that
opens the real one. The page says only: use the Account menu, and Nutflix never asks for a key or
bunker link inside this page. The menu bar is kept on screen (`autoHideMenuBar: false`) on Linux and
Windows, and is in the system's menu bar on macOS. Every packaged launch on all five targets reads
back from Electron that the menu is in place and, on Linux and Windows, that the bar is visible
(`accountMenu` and `menuBar` in the ready line); a launch that fails this fails CI. **There is no Account menu in fullscreen:** a page can go
fullscreen on the user's click and draw a fake menu, so press Esc first, and never enter a key or
bunker link while in fullscreen. In the Electron proof (Linux under Xvfb, no window manager), a real
click took the page to fullscreen and Electron reported the menu bar hidden; a real Esc left it and
Electron reported the bar visible again. Windows and macOS were not measured. Lock never
waits for another dialog, so a page that keeps one open cannot keep the key unlocked, and a cancelled
file picker stays closed for a few seconds.

Main's **prompt window** (`src/main/prompt-window.ts`, `src/prompt/`) sends what is typed to the
worker, so a passphrase or bunker URI never enters the page. It is modal, sandboxed and isolated, in
an in-memory session of its own that reaches one file; its policy is `default-src 'none'`, so its
page runs no script and its form is built by its preload; and main takes a value only from that
exact webContents' top frame, at that exact URL. Closing it while a value is being handled waits for
that call and reports what really happened. The proof kills the renderer process of a prompt on screen, and the prompt ends as a cancel; a prompt
that never loads is destroyed by a 30 s watchdog. For a renderer killed before its first paint, the
proof requires a cancel by a named path, no value delivered, a destroyed window, and a next prompt
that opens and answers normally through the real dialog lock. Each run's `death-before-paint` log
line names the path that ended it (`load-failed`, `render-process-gone` or `watchdog`). In the
one CI run this was first recorded in, the path was `load-failed`. **Known
limit:** a renderer that has crashed but not exited does not end the prompt until the process is
gone. In CI, `forcefullyCrashRenderer` left it alive for at least 12 s, and only the proof's kill
ended it.

Without Chromium's sandbox, `init` says `localKey: false`: only a bunker can sign, and a key on disk
stays untouched. Choosing Unlock or Create Key says why.

`scripts/prompt-proof.ts` (run in the `seed-publish` workflow) drives that real window and the real
menu in Electron with a script: the item is clicked and the keys are sent by the script. A failure
is final, and the workflow requires one exact result line with every check true. No person has used
them in CI, and no test drives the native message boxes.

### Without Chromium's sandbox (amendment, item 2)

Main never adds `--no-sandbox`. The AppImage's launcher (`packaging/apprun.ts`) passes it in one
case: the kernel limits user namespaces, as stock Ubuntu 24.04 and later do, **and** Chromium itself
then reports that its sandbox cannot start. Without that, Chromium would abort before any app code
and the user would never see a warning. If the switch is on the command line, main shows a native warning before any window and before the worker:
**Quit is the default** (Enter, Escape and closing the box all quit); "Run anyway" is the choice. It
is stored in `<userData>/sandbox-consent.json`, and a red banner stays at the top of the window
while the sandbox is off (the title says so too). Two things forget the choice, so that the next
start without the sandbox warns again: **Settings › Chromium's sandbox › Forget "Run anyway"**,
shown only while the sandbox is off (`app.sandbox.forget`, behind a native confirmation; the run
itself stays as it is), and starting the app with `--forget-sandbox-choice`, which deletes it and
exits. A stored choice has no effect on a launch without the switch.

## Packaging

```sh
npm ci --ignore-scripts && npm run build        # the packages' dist/ first
node shells/pear-v3/scripts/package.ts build    # this machine's platform and arch
```

`build` runs `package` on macOS and `make` elsewhere. It stages one directory (the runtime closure
of this package's `dependencies` computed from `package-lock.json` by nutflix-pear's own
`runtimeClosure`, so the versions are the lockfile's; only the target's prebuilds), runs Electron
Forge, flips the fuses, and checks the result (`packaging/layout.ts`). Everything lands in
`shells/pear-v3/out/` and the run prints `ARTIFACT <kind> <path>` lines.

- **Linux:** the in-repo maker (`packaging/maker-appimage.ts`, after nutflix-pear's): `mksquashfs`
  plus the type-2 runtime of AppImage/type2-runtime `20251108`, which CI downloads and the maker
  refuses unless it equals its sha256 pin (the same two pins as nutflix-pear's).
- **macOS:** Forge's package step; the `.app` gets an ad-hoc signature (`codesign -s -`: no
  certificate) because an Apple-silicon Mac refuses a bundle that does not match its signature.
- **Windows:** `@electron-forge/maker-msix`, `sign: false`. The manifest is the maker's own template
  filled in as before plus one **execution alias**, `Nutflix.exe` (`packaging/msix-manifest.ts`): the
  installed package can be started by that name from a terminal, with the caller's pipes, so that
  its `NUTFLIX_SHELL` lines can be read (see "The install job"). The package is not installable
  until it is signed; the install job signs its own copy with a certificate it makes for the run.
- **Electron** (45.2.1, exact) is downloaded by Forge and checked against the sha256 list of the
  `electron` npm package, which the lockfile pins. No other tool is downloaded.
- **Test builds only.** Nothing is signed or notarized, and CI holds no certificate or secret.
  macOS needs Apple signing and notarization, and Windows a real certificate, before these run on
  other people's machines (ADR 0001 amendment, item 5).

### The Bare runtime

`pear-runtime` 1.3.1 spawns `bare-sidecar` 0.5.4's `bare`, which that package builds from **Bare
1.31.0** (its `CMakeLists.txt`). The worker needs 1.29.4 or later in dev and `bare-fs` 1.28 or later,
so it fits. CI runs `bare --version` on the packaged runtime of every target and refuses one older
than 1.29.4 (`smoke.ts bare`).

## What CI proves

`.github/workflows/ci.yml`, job `shell`, once per target (the PR lists the run):

1. the package is made, its fuses read back right and its layout is as `layout.ts` says;
2. the packaged Bare is 1.29.4 or later (`smoke.ts bare` asks the shipped `bare-sidecar` runtime
   for `Bare.version`; it is a launcher with no `--version`, so it runs a one-line script);
3. the packaged app is launched with no switch, and prints `NUTFLIX_SHELL_READY {…}`: **the window
   loaded `app://nutflix`, the renderer mounted in it, the worker answered main's `status`, the
   page's own `status` came back through the preload, main's gate and the worker (`pipe`), and the
   OS is confining the renderer** (`rendererSandbox`: seccomp on Linux, Electron's process metrics
   on macOS and Windows). Every build prints this line; no switch makes it
   print. The line must also show the WebRTC IP policy as Chromium reports it for this window
   (`default_public_interface_only`) and that the renderer's whole WebRTC player probe passed: the
   pinned nfx library loaded through `app:` under the real policy, and its WASM verifier started.
   It says too whether `MediaSource` takes VP9 or H.264 in MP4;
4. with `--no-sandbox`, the warning comes first and no window opens;
5. every launch says `updates: off`: a package made for release starts no updater.

What is launched: Linux, the `.AppImage` itself, once mounted with FUSE and once with no FUSE tools;
macOS, the `.app`'s executable; Windows, the executable inside the
unpacked `.msix` (`makeappx unpack`). The `shell` job does not install the `.msix` (it is unsigned);
the `install` job below does.

It does **not** prove playback. Playing a video needs a relay and a seeder, and the app takes no
switch to name them (a release build would accept it); a seeder on the public DHT would be a server
waiting for outside traffic, which CI must not be. Playing is covered, on Linux only and outside the
packaged app, by the renderer's own end-to-end job.

## The install job: `pear build`, `stage`, `seed` and `install`, on five targets

ADR 0001's amendment (item 5) wants each target to pass a real `pear install` and launch before a
release. Job `install` of `.github/workflows/ci.yml` does that, once per target, on that target's
runner. It downloads the five packages the `shell` job uploaded and then, with
`scripts/pear-install.ts` (`scripts/pear-ci/run.ts` has the steps):

| Step | What it does |
| --- | --- |
| merged | `pear build` merges the five packages into one deployment folder (`by-arch/<target>/app/Nutflix.<ext>`); each entry is compared with its input |
| staged | `pear stage` puts the folder on a throwaway link; `pear dump --list` lists every file back |
| seeded | `pear seed` announces it, on the private DHT below, until the install is done |
| installed | `pear install pear://<link>`, on the private DHT; the installed bytes are compared with the staged ones (a file's sha256; a macOS bundle's every file, symlink and executable bit) |
| launched | the INSTALLED app is started as installed, and must print its ready line: `pipe` `round-trip`, `rendererSandbox` `enforced`, and the rest of what the `shell` job requires |
| gate | the update gate, on two more real builds (below) |

### No peer on the public network

GitHub disabled Actions on another repository of this account for hosting a peer, so **no runner may
seed, serve, announce or wait for outside traffic**. This job runs the whole of Pear against a
private network, and measures that it never touched the public one.

- **A private DHT.** `scripts/pear-ci/dht-node.ts` starts a HyperDHT testnet, ten nodes bound to
  `127.0.0.1` and given no other bootstrap (Pear's own test runner makes its network the same way).
- **Every Pear process is told.** `pear --dht-bootstrap 127.0.0.1:<port> <command>` is the way to
  point the sidecar at a DHT: the CLI starts the sidecar when none runs and forwards the flag
  (`cli.js`, `tryboot`); a sidecar that is already up keeps the DHT it started with, and a bare
  `pear` call starts one on the public bootstrap. So every call carries the flag, the first call
  (`pear touch`) is the one that starts the sidecar, in a home directory that never held one, and
  `pear install` also gets the flag as its own option (it opens its own swarm in the CLI process and
  takes its bootstrap from that option alone). Pear 3.7.0 lists the flag in `pear install -h` only;
  the rest is read from its source (`cli.js`, `sidecar.js`, `lib/cmd.js`, `subsystems/sidecar/index.js`, and pear-install's
  `cmd.js`), which is also how its own tests start a sidecar.
- **The sidecar says so.** Its `pear.log` has the line `DHT bootstrap set` with the private node,
  and not the line `DHT known-nodes read from database` that a sidecar without the flag writes.
- **A tripwire counts.** Before anything starts, a firewall rule drops every packet to HyperDHT's
  three public bootstrap addresses and counts the packets it drops (iptables on Linux, pf on macOS,
  Windows Defender Firewall with its blocked-packet log on Windows). The job proves the instrument
  first: it sends one datagram to a documentation address (RFC 5737) that the same rule watches, and
  fails unless the rule counted it. After Pear has run, the count for the public bootstrap must be
  **zero**, and it must still be zero after the installed app's launch: the app starts no DHT node
  until a play or a stored video needs one (`packages/worker/src/net/dht-node.ts`).
- **No public Nostr relay or STUN server either.** The renderer connects to its default relays as soon
  as it loads, and the app takes no test switch. So `scripts/pear-ci/sinkhole.ts` reads every public
  relay and STUN host from the app's sources, points those names at loopback in the runner's hosts
  file before the first launch (in the `shell` job too), and proves that they resolve there. In the
  install job the tripwire also counts their real addresses, and that count must stay zero.
- **The Pear CLI is not fetched from the DHT.** `npx pear` bootstraps by downloading the platform
  drive over the public HyperDHT. This job downloads the platform's GitHub release asset instead
  (`https://github.com/holepunchto/pear/releases/download/v3.7.0/pear-<target>.zip`, an ordinary
  HTTPS download that listens and seeds nothing) and refuses it unless its sha256 equals the pin in
  `scripts/pear-ci/pins.ts`, before it unpacks or runs it. GitHub's own digest for each asset
  agreed with the pins when they were written, and the linux-x64 binary has the byte length of the
  one `npx pear@3.0.0` installed in S2.
- **The link exists only on that DHT.** It is made by `pear touch` on the private DHT and printed in
  the log: a public key that no one outside the runner can fetch, and whose write key never leaves
  the runner's throwaway home directory.

Nothing here provisions or uses a real key or link, and no secret is used.

### The update gate, on every target

`scripts/pear-ci/update-proof.ts` runs after the steps above, on a second private DHT, with a relay
on `127.0.0.1` in the job (`notice-relay.ts`, which ignores subscription filters on purpose, so that
a forged notice really reaches the app):

| Step | What happens | Must be true after it |
| --- | --- | --- |
| builds | `package.ts test-build` makes A and B, with a throwaway key, that relay and a private link baked in | the two digests differ |
| installed | `pear install` of A | installed = A |
| staged | B goes onto the same link | |
| (a) no notice | the installed app starts, mirrors B | `held/no-notice`, the window shows it, installed = A |
| (b) wrong hash | a notice signed by the right key, naming B with another hash | `held/hash-mismatch`, installed = A |
| (b) wrong signer | B's right hash, signed by another key, and again claiming the release key | `held/no-notice`, 2 refused, installed = A |
| (c) matching | a notice naming B exactly | `applied`; the job's own hash of the installed app = B |
| restart | the app starts again | it reports B's version, and is not holding anything |

On Windows the proof of the swap is the installed package's version plus every file under `app\\`
compared with B's `.msix`, because `applyUpdate()` hands the package to Windows.

### What is, and is not, proved per platform

- **Linux:** the AppImage is launched as `pear install` placed it (`~/.local/bin/Nutflix.AppImage`),
  with FUSE, and its sha256 equals the staged file's. The job also checks the launcher entry
  `pear install` writes (`~/.local/share/applications/Nutflix.desktop` runs that file). The folders
  `~/.local/bin` and `~/.local/share/applications` are made before the install, as on a machine that
  has Pear: `pear install` moves the app into a folder and does not make it, and the job's extra
  install into a home without the folder shows it: exit 1, `ENOENT … rename … -> ~/.local/bin/Nutflix.AppImage`
  (on macOS the same for `~/Applications`). `pear install` copies `usr/share/icons/hicolor` out of
  the AppImage, and the job fails unless the icon the launcher entry names was installed.
- **macOS:** the bundle is ad-hoc signed (no certificate), as before. After the round trip through
  `pear build`, `stage` and `install`, every file, symlink and executable bit of the installed
  bundle must equal the input's, and `codesign --verify --deep --strict` must pass: **that proves
  every file and symlink of the bundle survived, because the signature seals them.** It does not
  prove who built the app (nobody signed it), notarization, or that Gatekeeper accepts it:
  `spctl --assess` says "rejected" (exit 3), and the job prints that and does not require it.
  `~/Applications` is made first, as above.
- **Windows:** the job makes a self-signed code-signing certificate whose subject is the manifest's
  publisher, `CN=Sovereign Technology (TEST)`, in the job. Its key is not exportable and is in no
  file; it is trusted in the runner's Trusted People store only, and removed at the end. A Windows
  Server image has sideloading off (`AllowAllTrustedApps` unset), so the job switches that on, on
  its throwaway runner. It signs its copy of the `.msix` with the certificate, and `pear install`
  really installs the package (`Add-AppxPackage`, through `msix-manager`); the job reads back its
  publisher, signature kind and status, and compares every file under `app\` with the `.msix`'s.
  The app is then launched by its execution alias, so that the packaged app gets the job's pipes and
  its ready line can be read, and the job asks Windows (`GetPackageFullName`) which package the
  running process belongs to. A Windows file system cannot keep a macOS bundle's symlinks, so on the
  Windows runner the macOS entries of the deployment are stand-ins (compared by their files only);
  the other four legs unpack them exactly. Those four legs' deployments hold the unsigned `.msix`.
- **The app's own DHT node.** The worker uses the public bootstrap, but starts its node only when a
  play or a stored video needs one. CI launches have neither, so they send nothing to the public
  network, and the install job fails if one does.

### The AppImage runtime (for amendment, item 3)

The AppImage carries this repository's patched type-2 runtime
([`packaging/appimage-runtime/`](packaging/appimage-runtime/README.md)), pinned by sha256:

- With FUSE usable, it mounts as usual. It is static, so it needs a `fusermount` helper (the `fuse3`
  package gives one) and not `libfuse.so.2`.
- With no usable FUSE, it extracts to a private per-user cache and runs from there. The first start
  is slower; the app then shows a notice, once per version, to install `fuse3`.
- The sandbox needs unprivileged user namespaces, because the AppImage's `chrome-sandbox` is not
  setuid. CI runs the AppImage twice with Ubuntu 24.04's restriction still on (it must reach the
  warning, and after "Run anyway" it must run with the sandbox off), then lifts the restriction on
  its throwaway runner and requires an OS-enforced sandbox.

## Layout

| Path | What it is |
| --- | --- |
| `src/main/` | main: `main.ts`, `window.ts`, `security.ts`, `csp.ts`, `loopback.ts`, `app-protocol.ts`, `rpc-gate.ts`, `main-calls.ts`, `worker-proc.ts`, `sandbox-gate.ts`, `consent-file.ts`, `external-links.ts`, `page-probe.ts`, `log.ts` |
| `src/preload/preload.ts` | the preload |
| `src/update/` | the update gate: `gate.ts`, `notice.ts`, `root.ts`, `relays.ts`, `hash.ts`, and its Bare entry `update-worker.ts` |
| `packaging/` | stage, Forge config, fuses, the AppImage maker, layout check |
| `scripts/package.ts`, `scripts/smoke.ts` | the packaging driver; the launcher CI runs |

Adapted from nutflix-pear (the submodule's pinned commit): `window.ts`, `security.ts`, `csp.ts`,
`app-protocol.ts`, `schemes.ts` from `app-desktop/src/main/`; `fuses.ts`, `maker-appimage.ts`,
`layout.ts`, `stage.ts`, `forge-config.ts` and the driver from `app-desktop/packaging/`; the closure
is imported from there unchanged. The MSIX settings and the Windows SDK lookup are Holepunch's
`hello-pear-electron` template (pinned `ed067ea`, S2).

## For the maintainer

- **No asar** (above). Keeping main and the renderer in an archive with the integrity fuses means
  patching where `bare-sidecar` finds `bare`, or loading `pear-runtime` from outside the archive.
- **Bundle id** `xyz.sovit.nutflix.runtime`, **MSIX identity** `SovereignTechnology.Nutflix` and
  **publisher** `CN=Sovereign Technology (TEST)`: the publisher must equal the signing certificate's
  subject and then never change.
- **Turning updates on** takes: a `pear multisig` production link, set as `RELEASE_UPGRADE_LINK`; each
  release notice signed with the SovTech key; and `nutflix-runtime` added to `RELEASE_D_TAGS` in
  nutflix-pear's release scripts, whose artifact-name rules must also learn this app's names.
  [`docs/release.md`](../../docs/release.md) is the runbook, step by step, and says which steps are
  the tool's (`scripts/release/`) and which are the owner's.
- The MSIX manifest gets `packageManagement`, `unvirtualizedResources` and write virtualization off
  **only in a build with a link** (an in-app MSIX update needs all three, and Holepunch's template has
  them). A shipped build today does not ask for them. It does have the `Nutflix.exe`
  execution alias, which the install job needs and which also lets a person run the packaged app
  from a terminal and read its output (the app has no switch of its own for that).
- The worker is not restarted if it exits; the window's pipe closes and playing fails.
