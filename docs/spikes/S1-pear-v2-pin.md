# S1: can a pre-v3 Pear runtime still run `pear://`?

Date: 2026-11-19. Harness: [`spikes/s1-pear-v2/`](../../spikes/s1-pear-v2/). Gates ADR 0001 decision
1(b), shape (b).

## Verdict: PENDING

@@VERDICT@@

## How it was run

Everything that downloads or runs Pear, Electron or the test apps ran in throwaway Kata VMs
(`kata-run --net`, the agentrun runner on ubuntu-server): Debian 12, x86_64, root,
`NoNewPrivs: 1`, seccomp mode 2, unprivileged user namespaces unavailable (`unshare -U` fails).
Nothing ran on a developer machine. Source reading was read-only: Pear v2.6.5 and v3.0.0 at their
git tags, pear-electron v1.7.28 at its tag, and the npm tarballs of `pear-electron`, `pear-bridge`,
`pear-cmd`, `pear-constants`, `pear-aliases`, `pear-api`, `pear-pipe` and `pear` 2.0.4/3.0.0,
each downloaded into its own empty directory.

| Step | Script | Job |
|---|---|---|
| Find the last pre-v3 length | `find-v2-length.js` (`run.sh drive`) | agent-run job 21563, exit 0 |
| GUI app and renderer probe | `apps/gui/` (`run.sh gui`) | @@GUIJOB@@ |
| Pinned install, terminal app, update trials | `pin-bootstrap.js`, `mirror-release-line.js` (`run.sh hold`) | @@HOLDJOB@@ |

To run it again (from the repo root):

```sh
kata-run --net --max-wait 14400 --timeout 4800 --cwd spikes/s1-pear-v2 -- \
  'npm ci && bash run.sh drive'   # or: hold, gui
```

`hold` and `gui` find the pin themselves unless `PIN_LENGTH` and `PIN_FORK` are set. Every result
line in the job log starts with `S1`.

Downloads, pinned and recorded:

| What | Version | Integrity |
|---|---|---|
| npm `pear` (the v2 bootstrapper) | 2.0.1 | `sha512-7SzEywtOZuH6Sgw4hceKoy0YoHfzhvI7xLdBRcXMkQuigbZDNf7H/VgdrTCiUHc5yCudlhFREiWKqmiPeaK9YA==` |
| `pear-updater-bootstrap`, `pear-updater`, `corestore`, `hyperdrive`, `hyperswarm` | 2.5.0, 3.10.0, 7.9.2, 13.3.2, 4.17.0 | `spikes/s1-pear-v2/package-lock.json` |
| `pear-electron` | 1.7.28 | `sha512-ZCOFvVmUZgPxl8bCG0EllweW+eO2svGM5BLFNI8nppXdiIeE7ns8fLsQnGS2JdVALpG7ilaNja5pq1XRHbvhYw==` |
| `pear-bridge` | 1.2.5 | `sha512-n6ILZteZOcESljImP/78Jv35aRNUk6TFMJyNmbVBah7cpV8W0H3IsQEvzTt1d2vCywNN+Tv7RoCVL6V3BAcC9A==` |
| `pear-pipe` | 1.0.6 | `sha512-7XApSERIgctSlSjsZ8ATkFXwbkIyCEHG90GQdsc1DG2GkDYxYuGrq4c4H/YEE2jt1oq6VywwE/eNtvrlOEUeHg==` |
| GUI app's Bare modules | `bare-fs` 4.7.1, `bare-http1` 4.5.6, `bare-env` 3.0.0, `b4a` 1.8.0 (the versions Pear v2.6.5 itself locks) | `spikes/s1-pear-v2/apps/gui/package-lock.json` |
| Pear platform | v2.6.5, `pear://0.3243.pzcjqmpoo6szkoc4bpkw65ib9ctnrq7b6mneeinbhbheihaq6p6o` | `pear-runtime` (linux-x64) @@RUNTIMESHA@@ |
| pear-electron UI asset | `pear://0.940.cktxzetiwt6un3ado5kgqedge6ya4nfazjckzq76zcapefwxakdy` (pinned in pear-electron 1.7.28's `package.json`) | @@ASSET@@ |

## Q1. Can a pre-v3 platform still be bootstrapped? Which version, length and fork?

**Yes. Pear v2.6.5 is `pear://0.3243.pzcjqmpoo6szkoc4bpkw65ib9ctnrq7b6mneeinbhbheihaq6p6o`: fork 0,
length 3243.** That is also the drive's latest length: Holepunch never wrote v3 to this key.

Evidence (job 21563, 2026-11-19 07:36Z):

```text
S1 {"tag":"peers","t":47,"connections":2,"corePeers":1,"length":3243,"fork":0,...}
S1 {"tag":"latest","t":49,"length":3243,"fork":0,"version":"2.6.5","changelogTop":"v2.6.5"}
S1 {"tag":"boundary","t":49,"firstLengthPackageJson3":null,"firstLengthChangelog3":null,...}
S1 {"tag":"blobs","t":55,"entry":{"blob":{"byteOffset":1338748641,"blockOffset":22410,
   "blockLength":1156,"byteLength":75756968},"executable":true},"blobsLength":28162,
   "blobPeers":[{"remoteLength":28162,"remoteContiguousLength":28162,"remoteFork":0}, x3],
   "firstBlockBytes":65536,"lastBlockBytes":62888,"firstBlockIsElf":"7f454c46"}
```

- One peer served the metadata core within 47 s. **Three peers each hold all 28162 blocks of the
  blobs core** (`remoteContiguousLength` = `remoteLength`), so the whole history, old blobs
  included, is still seeded today.
- The linux-x64 `pear-runtime` at that length (75,756,968 bytes, ELF) returned its first and last
  blocks.
- @@INSTALL@@
- **v3 lives on a different key.** npm `pear@3.0.0` (2026-07-14) bootstraps
  `pear://smw4thqaqed9iq6bae7a9cxd4fesruixgkafe38jny33ahs33igy` through `pear-install`, while npm
  `pear@2.0.4` and earlier still bootstrap `pzcjq…`. So `npx pear@2.0.4` (or the 2.0.1 this spike
  pins) installs v2.6.5 today. @@V3KEY@@
- **`pear-updater-bootstrap`'s `length` option is not a pin.** It is the checkout the updater treats as
  already installed; `pear-updater` then installs `drive.core.length`, the newest length peers
  report. `pin-bootstrap.js` therefore hands `pear-updater` 3.10.0 a view of the drive whose core
  reports the pinned length and never emits `append`. Everything else is `pear-updater`'s own code.
  Today the pin and the latest length are the same, so this only matters if the key moves.

## Q2. Does it update itself to v3, and can that be stopped?

**Not on its own today: there is no v3 on its key.** @@Q2SUMMARY@@

How v2.6.5 updates, from its source (`sidecar.js`, `subsystems/sidecar/index.js`):

- Every sidecar (spawned by any `pear` command) creates a `pear-updater` on the platform key it was
  installed from (`CHECKOUT.key`, baked into the boot bundle). The only exceptions are a dev
  checkout (`LOCALDEV`) and `pear sidecar --key <key>` ("switch release lines", removed in v3).
- When that key gets a new length, the updater mirrors `by-arch/<host>` into a new swap, rebuilds
  `boot.bundle`, and logs "Platform update available". It then sets the spindown to 0, so the
  sidecar exits as soon as no app is attached, and applies the update on exit by renaming `next`
  over `current`.
- `pear run --no-updates` only stops **app** update notifications (`state.updates`). It does not
  touch the platform updater.
- `EOLS.pear` (in the bundled `pear-aliases` 1.0.7) lists one retired key, `pqbzjhqy…`, which is
  redirected to `pzcjq…`. `pzcjq…` itself is not listed, and the list is frozen in the boot bundle.
- A read-only `current` cannot work: `current` is a symlink in the platform directory, which must
  stay writable (it holds `pear.sock`, `db`, `gc`, `lock`, `corestores`), and root ignores modes.

So the risk to shape (b) is not v3 arriving by itself. It is **whatever Holepunch appends to
`pzcjq…` later**: an end-of-life notice, a v2.6.6, or v3 itself. Every v2 install would take it on
its next sidecar exit. The trials below show which holds stop that.

@@Q2TRIALS@@

A second route to v3 does not go through the updater at all. **`npx pear@3` removes the v2 PATH
lines** (`export PATH="~/.config/pear/bin":$PATH` and its comment) from every shell rc file
(`migrateFromV2()` in `pear.js`), and installs its own `pear` in `~/.local/bin`. The v2 install
stays in `~/.config/pear`, but `pear` on PATH is v3 from then on, and v3 has no `pear run`.

## Q3. Does `pear run` start a Bare terminal app and a `pear-electron` GUI app?

@@Q3@@

## Q4. What does the GUI's Chromium offer, and how does the renderer talk to Bare?

@@Q4@@

**Renderer to Bare, from the source and confirmed by the probe:**

- The Bare entrypoint (`index.js`, run by `pear run` inside the Pear runtime) calls
  `await new Runtime().start({ bridge })` from `pear-electron`. That spawns the Electron binary
  from the UI asset and returns `sp.stdio[3]`, a duplex pipe.
- In Electron's main process, `pear-api`'s `Pear.pipe` opens fd 3. `ipcMain.on('pipe')` relays
  it to a renderer stream (`streamId`, `streamWrite`, `streamData`, `streamEnd`, `streamClose`
  messages over Electron IPC).
- In the renderer, `require('pear-pipe')()` (or `Pear[Pear.constructor.IPC].pipe()`) returns that
  stream as a streamx `Duplex`.
- **Message shape: raw bytes, no framing.** The app must frame its own messages; the probe used
  newline-delimited JSON. @@PIPESHAPE@@
- `pear-bridge` serves the app's own files to the renderer at `http://localhost:<port>`
  (`127.0.0.1` listener). It answers only requests carrying an `X-Pear: Pear <id>` header, which
  the session's `onBeforeSendHeaders` adds.

## Q5. Is Chromium's sandbox on, and what CSP applies?

**Sandbox: off, by design, on Linux.**

- `pear-electron` 1.7.28 `runtime.js` adds `--no-sandbox` to Electron's argv on Linux and Windows
  unless the user passed `--sandbox` or `--no-sandbox` (`if ((isLinux || isWindows) &&
  indices.flags.sandbox === undefined) argv.splice(..., '--no-sandbox')`).
- Every app window and view is created with `nodeIntegration: true` and `contextIsolation: false`
  (`gui/gui.js` in the Linux boot bundle the runtime installs, `boot.bundle.patch.js`). App views
  also set `webSecurity: false` ("disable CORS"). With Node integration on, Electron does not
  sandbox that renderer even if Chromium's sandbox is running, so `pear run --sandbox` cannot give
  the renderer a sandbox either.

@@Q5SANDBOX@@

**CSP: none.**

- `pear-bridge` sends only `Content-Type` (and status) on app files, with no
  `Content-Security-Policy` header. The runtime injects no `<meta>` CSP.
- Electron main registers `file:` as privileged with `bypassCSP: true`.
- The only network policy is the session's `webRequest.onBeforeRequest` filter for `http://*/*`
  and `https://*/*`. It cancels any request whose protocol, host and port do not match the
  bridge's own origin or an `http(s)` entry in the app's `pear.links`. A link without a port allows
  every port on that host. The filter does not list `ws:`/`wss:`.
- No permission request or check handlers are set, so Electron's defaults (grant) apply.
- `will-navigate` to anything outside the bridge, and `window.open`, go to `shell.openExternal(url)`
  with no scheme check.

@@Q5CSP@@

## What could not be tested

@@UNTESTED@@

## Recommendation for ADR 0001 decision 1(b)

@@RECOMMENDATION@@
