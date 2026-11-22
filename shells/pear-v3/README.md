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

## Updates are OFF

**This slice has no updater. Nothing in the shell calls `applyUpdate()`, constructs a `PearRuntime`
or reads an update link, and the app never swaps itself.** The shell uses one function of
`pear-runtime`, the static `run()`, which starts a Bare process (`src/main/worker-proc.ts`). The
update gate (the notice check and the held builds of S2) is the next slice; it belongs in the
worker, which owns the updater, and in this shell's relaunch.

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
`status`, `nfx.play.open` and `nfx.play.close`, and hear the `status` event. Any other method,
`init`, `nfx.seed.*`, `nfx.endpoint`, is answered `invalid-argument` in main and never reaches the
worker. At most 32 requests in flight per window; a play session belongs to the window that opened
it (another window's `nfx.play.close` does nothing, and a window that goes away closes its sessions).
What the worker sees is main's own re-encoding of a checked request, with main's id.

### Without Chromium's sandbox (amendment, item 2)

Main never adds `--no-sandbox`. The AppImage's launcher (`packaging/apprun.ts`) passes it in one
case: the kernel limits user namespaces, as stock Ubuntu 24.04 and later do, **and** Chromium itself
then reports that its sandbox cannot start. Without that, Chromium would abort before any app code
and the user would never see a warning. If the switch is on the command line, main shows a native warning before any window and before the worker:
**Quit is the default** (Enter, Escape and closing the box all quit); "Run anyway" is the choice. It
is stored in `<userData>/sandbox-consent.json`, and a red banner stays at the top of the window
while the sandbox is off (the title says so too). Start the app with `--forget-sandbox-choice` to
forget the choice. A stored choice has no effect on a launch without the switch.
Not done: a control in the renderer's Settings (below).

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
   print. The line also says what the packaged engine can do: whether the renderer's WebRTC player
   probe passed, and whether `MediaSource` takes VP9 or H.264 in MP4;
4. with `--no-sandbox`, the warning comes first and no window opens.

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
  **zero**. It is read again after the app's launch: the app's own worker starts a HyperDHT node on
  the public bootstrap at startup (`packages/worker/src/host.ts`), so those packets are expected
  there, and they are dropped and counted, not sent.
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

Updates stay off: nothing here constructs a `PearRuntime`, calls `applyUpdate()`, provisions or
signs. No secret is used.

### What is, and is not, proved per platform

- **Linux:** the AppImage is launched as `pear install` placed it (`~/.local/bin/Nutflix.AppImage`),
  with FUSE, and its sha256 equals the staged file's. The job also checks the launcher entry
  `pear install` writes (`~/.local/share/applications/Nutflix.desktop` runs that file). The folders
  `~/.local/bin` and `~/.local/share/applications` are made before the install, as on a machine that
  has Pear: `pear install` moves the app into a folder and does not make it (read in pear-install
  1.5.0 and 1.6.0; the job also installs once into a home without the folder and logs what
  happens). **No icons are installed:** `pear install` copies `usr/share/icons/hicolor` out of the
  AppImage, and ours has only `Nutflix.png` at its root (`maker-appimage.ts`), so the launcher
  entry names an icon the system does not have. The job notes it; it does not fail on it.
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
- **The app's own DHT node.** The worker starts a HyperDHT node on the public bootstrap when the app
  starts (`packages/worker/src/host.ts`, `init` takes no bootstrap from main). In the install job
  that node's packets are dropped and counted (a few datagrams per launch); in the `shell` job,
  which has no tripwire, they are sent. Neither job seeds, serves or announces anything with it.

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
| `src/main/` | main: `main.ts`, `window.ts`, `security.ts`, `csp.ts`, `app-protocol.ts`, `rpc-gate.ts`, `worker-proc.ts`, `sandbox-gate.ts`, `external-links.ts`, `page-probe.ts`, `log.ts` |
| `src/preload/preload.ts` | the preload |
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
- **No Settings control to forget the sandbox choice**: that is a renderer change. Until then,
  `--forget-sandbox-choice`.
- **Bundle id** `xyz.sovit.nutflix.runtime`, **MSIX identity** `SovereignTechnology.Nutflix` and
  **publisher** `CN=Sovereign Technology (TEST)`: the publisher must equal the signing certificate's
  subject and then never change.
- The MSIX manifest has none of the template's `packageManagement`, `unvirtualizedResources` or
  write-virtualization-off settings, which the update slice will need. It does have the `Nutflix.exe`
  execution alias, which the install job needs and which also lets a person run the packaged app
  from a terminal and read its output (the app has no switch of its own for that).
- The worker is not restarted if it exits; the window's pipe closes and playing fails.
