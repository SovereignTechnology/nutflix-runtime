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

The app never adds `--no-sandbox`, and its AppImage's `AppRun` is the Electron binary itself, not
electron-builder's script, which adds the switch by itself on Ubuntu 24 and later (S2). If the
switch is on the command line, main shows a native warning before any window and before the worker:
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
- **Windows:** `@electron-forge/maker-msix`, `sign: false`, with a generated manifest. The package is
  not installable until it is signed.
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
   loaded `app://nutflix`, the renderer mounted in it, and the worker answered `status`** (main's
   own request, after `init`), with the sandbox on. Every build prints this line; no switch makes it
   print. The line also says what the packaged engine can do: whether the renderer's WebRTC player
   probe passed, and whether `MediaSource` takes VP9 or H.264 in MP4;
4. with `--no-sandbox`, the warning comes first and no window opens.

What is launched: Linux, the `.AppImage` itself (native FUSE first, then
`--appimage-extract-and-run`); macOS, the `.app`'s executable; Windows, the executable inside the
unpacked `.msix` (`makeappx unpack`). The `.msix` is **not installed**: it is unsigned, and
installing is the next slice's test.

It does **not** prove playback. Playing a video needs a relay and a seeder, and the app takes no
switch to name them (a release build would accept it); a seeder on the public DHT would be a server
waiting for outside traffic, which CI must not be. Playing is covered, on Linux only and outside the
packaged app, by the renderer's own end-to-end job.

### The AppImage runtime (for amendment, item 3)

Seen on GitHub's `ubuntu-24.04` and `ubuntu-24.04-arm` runners, with the type-2 runtime of release
`20251108` and the `fuse3` package installed, `libfuse.so.2` absent:

- The AppImage mounts and starts natively. This runtime is static; it does not load `libfuse.so.2`
  (S2's stock runtime did), but it still needs a FUSE helper binary.
- With no `fusermount` or `fusermount3` on `PATH` it prints `Error: No suitable fusermount binary
  found on the $PATH` and exits 127, before any app code, with no fallback of its own.
  `--appimage-extract-and-run` is the manual way round it.
- So the FUSE fallback of item 3 cannot live in `AppRun` or in the app: the runtime is the first
  thing that runs. It needs a custom runtime or a stub in front of it, pinned by sha256 like this
  one.
- `AppRun` here is the Electron binary, so nothing adds `--no-sandbox`. The sandbox then needs
  unprivileged user namespaces, because the AppImage's `chrome-sandbox` is not setuid (CI lifts
  Ubuntu 24.04's AppArmor restriction on its throwaway runner).

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
- The generated MSIX manifest has none of the template's `packageManagement`, `unvirtualizedResources`
  or write-virtualization-off settings, which the update slice will need.
- The worker is not restarted if it exits; the window's pipe closes and playing fails.
