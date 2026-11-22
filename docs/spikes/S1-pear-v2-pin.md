# S1: can a pre-v3 Pear runtime still run `pear://`?

Date: 2026-11-19 to 2026-11-22. Harness: [`spikes/s1-pear-v2/`](../../spikes/s1-pear-v2/). Gates ADR 0001 decision
1(b), shape (b).

## Verdict: PARTIAL

**A pre-v3 runtime still installs and runs apps, but shape (b) should not ship.** It can be held
only by republishing Holepunch's platform on a key we control, and it runs strangers' content in a
renderer where an HTML injection is code execution as the user.

| Question | Result |
|---|---|
| Q1. Bootstrap | **Yes.** v2.6.5 at `pear://0.3243.pzcjq…` installs today and is fully seeded. |
| Q2. Hold | **Only by re-homing.** `--no-updates` does not hold it; `pear sidecar --key` holds only while that sidecar runs. |
| Q3. `pear run` | **Yes** for a terminal app (dir and `pear://`) and a GUI app from a dir. GUI from a `pear://` link: not tested. |
| Q4. Chromium | Electron 33.2.1, Chromium 130. WebRTC, WebAssembly, MSE (avc1) and loopback `<video>` work. **The renderer-to-Bare pipe was not confirmed.** |
| Q5. Sandbox, CSP | **No renderer sandbox, no CSP.** An injected `<img onerror>` ran `id` through `child_process`. |

## How it was run

Everything that downloads or runs Pear, Electron or the test apps ran in one of two throwaway
environments, and nothing ran on a developer machine:

- **Kata job N:** a throwaway Kata VM on a private CI runner. Debian 12, x86_64, root,
  `NoNewPrivs: 1`, seccomp mode 2, unprivileged user namespaces unavailable (`unshare -U` fails).
- **GitHub job N:** GitHub Actions, `ubuntu-24.04`, x86_64, a non-root user. Ubuntu's AppArmor
  restriction on unprivileged user namespaces is on unless a step says otherwise.

Source reading was read-only: Pear v2.6.5 and v3.0.0 at their
git tags, pear-electron v1.7.28 at its tag, and the npm tarballs of `pear-electron`, `pear-bridge`,
`pear-cmd`, `pear-constants`, `pear-aliases`, `pear-api`, `pear-pipe` and `pear` 2.0.4/3.0.0,
each downloaded into its own empty directory.

Host names, paths and addresses were redacted from the logs in `spikes/s1-pear-v2/results/`.

| Step | Script | Job |
|---|---|---|
| Find the last pre-v3 length | `find-v2-length.js` (`run.sh drive`) | Kata job 21563, exit 0; v3 key from Kata job 21640 |
| GUI app and renderer probe | `apps/gui/` (`run.sh gui`) | GitHub job 137204115361 (run 45021145956) |
| Pinned install, terminal app, a normal sidecar | `pin-bootstrap.js` (`run.sh terminal`) | Kata job 21640, exit 0 |
| Update trials | `mirror-release-line.js` (`run.sh trials`) | Kata job 21638, exit 0 |
| `npx pear` as a user would run it | `run.sh stock` | GitHub job 135522325589 |

To run it again, in a throwaway VM with network access, from the repo root:

```sh
cd spikes/s1-pear-v2 && npm ci --ignore-scripts && \
  PIN_LENGTH=3243 PIN_FORK=0 bash run.sh gui   # or: drive, terminal, stock, trials
```

Run each phase in its own VM; together they take over an hour. Every result line in the job log
starts with `S1`.

Downloads, pinned and recorded:

| What | Version | Integrity |
|---|---|---|
| npm `pear` (the v2 bootstrapper) | 2.0.1 | `sha512-7SzEywtOZuH6Sgw4hceKoy0YoHfzhvI7xLdBRcXMkQuigbZDNf7H/VgdrTCiUHc5yCudlhFREiWKqmiPeaK9YA==` |
| `pear-updater-bootstrap`, `pear-updater`, `corestore`, `hyperdrive`, `hyperswarm` | 2.5.0, 3.10.0, 7.9.2, 13.3.2, 4.17.0 | `spikes/s1-pear-v2/package-lock.json` |
| `pear-electron` | 1.7.28 | `sha512-ZCOFvVmUZgPxl8bCG0EllweW+eO2svGM5BLFNI8nppXdiIeE7ns8fLsQnGS2JdVALpG7ilaNja5pq1XRHbvhYw==` |
| `pear-bridge` | 1.2.5 | `sha512-n6ILZteZOcESljImP/78Jv35aRNUk6TFMJyNmbVBah7cpV8W0H3IsQEvzTt1d2vCywNN+Tv7RoCVL6V3BAcC9A==` |
| `pear-pipe` | 1.0.6 | `sha512-7XApSERIgctSlSjsZ8ATkFXwbkIyCEHG90GQdsc1DG2GkDYxYuGrq4c4H/YEE2jt1oq6VywwE/eNtvrlOEUeHg==` |
| GUI app's Bare modules | `bare-fs` 4.7.1, `bare-http1` 4.5.6, `bare-env` 3.0.0, `b4a` 1.8.0 (the versions Pear v2.6.5 itself locks) | `spikes/s1-pear-v2/apps/gui/package-lock.json` |
| Pear platform | v2.6.5, `pear://0.3243.pzcjqmpoo6szkoc4bpkw65ib9ctnrq7b6mneeinbhbheihaq6p6o` | `pear-runtime` (linux-x64) sha256 `17a24785a94a8439617eecdb8844d3dc73c5a5d170e9666bae2cb17bfdf61636` |
| pear-electron UI asset | `pear://0.940.cktxzetiwt6un3ado5kgqedge6ya4nfazjckzq76zcapefwxakdy` (pinned in pear-electron 1.7.28's `package.json`) | Electron binary sha256 `20828dd41e2247931844e04fc4af25b1ca0bca8469c4536e2cd2a8f9e115ac35` |

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
- **A pinned install works.** Kata job 21640 downloaded 110,800,331 bytes in 76 s. `pear versions`
  then reported Pear 2.6.5, Bare 1.24.3, at `0.3243.pzcjq…`.
- **The stock path depends on the npm version.** `npx pear@2.0.4` installs a working v2.6.5 today.
  `npx pear@2.0.1` also finishes, but it resolves today's `hypercore` 11.40.4 and
  `hypercore-storage` 3.4.0, and `pear versions` on that install printed nothing (exit 0). This
  spike's 2.0.1 install works because `package.json` overrides those two to v2.6.5's own versions.
- **v3 lives on a different key.** npm `pear@3.0.0` (2026-07-14) bootstraps
  `pear://smw4thqaqed9iq6bae7a9cxd4fesruixgkafe38jny33ahs33igy` through `pear-install`, while npm
  `pear@2.0.4` and earlier still bootstrap `pzcjq…`. So `npx pear@2.0.4` installs v2.6.5 today. On the v3 key
  (Kata job 21640): length 92, fork 0, 4 peers, `package.json` version 3.7.0, and top-level
  `by-arch`, `checksums.sha256`, `package.json`.
- **`pear-updater-bootstrap`'s `length` option is not a pin.** It is the checkout the updater treats as
  already installed; `pear-updater` then installs `drive.core.length`, the newest length peers
  report. `pin-bootstrap.js` therefore hands `pear-updater` 3.10.0 a view of the drive whose core
  reports the pinned length and never emits `append`. Everything else is `pear-updater`'s own code.
  Today the pin and the latest length are the same, so this only matters if the key moves.

## Q2. Does it update itself to v3, and can that be stopped?

**Not on its own today: there is no v3 on its key.** A normal sidecar on `pzcjq…` ran for 240 s
and took no update (Kata job 21640). **But nothing in the runtime holds it.** The only hold these
trials support is installing from a release line we control and never appending to it.

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

Trials (Kata job 21638). The pinned platform was copied to a new key inside the VM (linux-x64 only,
1,571 files, 115,660,077 bytes), installed from that key with the stock bootstrapper, and then sent
one append per trial:

| Hold tried | Did the install take the append? |
|---|---|
| None (control) | **Yes.** The sidecar saw it within 15 s and applied it when it shut down. |
| `pear run --no-updates` | **Yes**, the same way. |
| `pear sidecar --key <a key nobody seeds>` | **Held for the 240 s that sidecar ran.** The next normal sidecar took it within 15 s. |
| Re-homing onto our own key | **The install follows that key:** the app reports it as the platform key, and appends to it arrived. |

Re-homing has a price: SovTech becomes the publisher and seeder of Holepunch's binaries, and users
need our bootstrap instead of `npx pear`. No real Holepunch append to `pzcjq…` was observed.

A second route to v3 does not go through the updater at all. **`npx pear@3` removes the v2 PATH
lines** (`export PATH="~/.config/pear/bin":$PATH` and its comment) from every shell rc file
(`migrateFromV2()` in `pear.js`), and installs its own `pear` in `~/.local/bin`. The v2 install
stays in `~/.config/pear`, but `pear` on PATH is v3 from then on, and v3 has no `pear run`.

## Q3. Does `pear run` start a Bare terminal app and a `pear-electron` GUI app?

**Yes, with one case untested.**

- **Terminal app (Kata job 21640):** ran from a local directory and from a `pear://` link made with
  `pear touch` and `pear stage`, with and without `--trusted`. It reported Bare 1.24.3, Pear 2.6.5
  and the platform at length 3243. The link was staged by the same install, so this does not show
  what a stranger's link prompts.
- **GUI app from a directory (GitHub job 137204115361):** Electron opened under Xvfb, loaded
  `index.html` and `app.js` through `pear-bridge`, and ran the probe. `pear run` prints
  `DEPRECATED: pear run is deprecated and will be removed`.
- **Two rough edges.** The app did not exit after `Pear.exit()`, and `timeout` ended it (exit 124).
  The first GitHub run (44513178657) failed to load the bridge with `ERR_FAILED` on both GUI
  attempts. It did not recur once the harness made a request to the bridge before opening the UI.
  The cause was not established.
- **GUI app from a `pear://` link: not tested.**

## Q4. What does the GUI's Chromium offer, and how does the renderer talk to Bare?

Observed in the renderer (GitHub job 137204115361, the same in both runs that started):

| Probe | Result |
|---|---|
| Versions | Electron 33.2.1, Chromium 130.0.6723.137, Node 20.18.1 |
| `RTCPeerConnection` | Present. A local data channel carried a message; candidates were `udp/host/ipv4`. |
| WebAssembly | Present. A test module compiled and returned 42. |
| `MediaSource` | Present. `avc1.64001f` + `mp4a.40.2`, `avc1.42E01E`, AAC and VP9/Opus supported; HEVC not. |
| `<video>` from Bare's `127.0.0.1` fMP4 | Loaded (640x360, 4.08 s) and played to 1.45 s. |
| `<video>` on `localhost:<another port>` | Failed; the server saw no request for it. That host and port were not in `pear.links`. |

**Renderer to Bare, from the source (the probe could not confirm the pipe):**

- The Bare entrypoint (`index.js`, run by `pear run` inside the Pear runtime) calls
  `await new Runtime().start({ bridge })` from `pear-electron`. That spawns the Electron binary
  from the UI asset and returns `sp.stdio[3]`, a duplex pipe.
- In Electron's main process, `pear-api`'s `Pear.pipe` opens fd 3. `ipcMain.on('pipe')` relays
  it to a renderer stream (`streamId`, `streamWrite`, `streamData`, `streamEnd`, `streamClose`
  messages over Electron IPC).
- In the renderer, `require('pear-pipe')()` (or `Pear[Pear.constructor.IPC].pipe()`) returns that
  stream as a streamx `Duplex`.
- **Message shape: raw bytes, no framing.** The app must frame its own messages; the probe used
  newline-delimited JSON.
- **Not observed working.** In every GUI run no bytes reached Bare (`pipeChunks: []`). In the two
  instrumented runs, the page's call to get the pipe had still not returned at least 20 s later.
  The cause was not established. Loopback HTTP from the
  page to a Bare server did work, but it has no authentication of its own.
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
- **An app cannot change any of this.** `open()` in `gui/gui.js` spreads the app's window and view
  options first and then sets its own `webPreferences` object, so every `Pear.Window` and
  `Pear.View` an app opens gets the same preferences. `webviewTag` is never set, so there is no
  `<webview>`. The one isolation tool left to an app is an `<iframe>`: `nodeIntegrationInSubFrames:
  false` keeps Node out of subframes.
- Also set, for every app: `nodeIntegrationInWorker: true` (Web Workers get Node too),
  `experimentalFeatures: true`, `ELECTRON_DISABLE_SECURITY_WARNINGS=true`, the
  `allow-loopback-in-peer-connection` switch, and on Linux x64 `disableHardwareAcceleration()`.

Observed (GitHub job 137204115361, from the process list, sampled every 2 s):

| Run | Result |
|---|---|
| Default flags | Main, GPU, utility, zygote and renderer processes all run with `--no-sandbox`. |
| `pear run --sandbox`, Ubuntu's namespace restriction on | **Aborts:** the SUID helper `chrome-sandbox` is not root-owned with mode 4755. |
| `pear run --sandbox`, namespaces allowed | Starts. Main, GPU and zygote lose `--no-sandbox`, but **two renderers keep `--no-sandbox --no-zygote`, and the app's page reports `--no-sandbox` in its own argv**. A third renderer ran without the flag; the probe does not show which frame it served. |

The preload deletes `window.require`, so an inline script sees `typeof require === 'undefined'`. That
is not a boundary: script-linker's module runtime stays on a global symbol, and its `require` loads
`child_process`.

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

Observed (same job):

- The page had no CSP header or `<meta>`. `eval`, `new Function` and inline scripts all ran.
- `Notification.requestPermission()` returned `granted` with no prompt. Microphone and clipboard
  were inconclusive: the runner has no audio device, and the document was not focused.
- **An injection runs code.** `<img src=… onerror=…>` set through `innerHTML` ran `id` through
  `child_process` and returned the user's uid. A plain `srcdoc` iframe (no `sandbox` attribute) did the same
  through its parent.
- **The page can read the app's whole environment**, because it is a JSON entry in the renderer's
  `process.argv`. Any token in the user's shell environment is exposed to page script.
- **A `sandbox="allow-scripts"` iframe did not reach the runtime** on its parent by the one route
  tried.
- **A page-set CSP is enforced.** In a frame with `<meta>` `default-src 'none'`, an inline script and
  an inline event handler were both refused.

## What could not be tested

- A GUI app from a `pear://` link, and the GUI in the Kata VM. All GUI results come from one
  environment, GitHub's `ubuntu-24.04`.
- A round trip over the renderer-to-Bare pipe (see Q4).
- The request filter on external `https:` and on `wss:` relays, and the MSE append. The probe ran
  them, but the harness cut the log line before their results. What Q5 says about them is from source.
- A real append by Holepunch to `pzcjq…`. The trials used a key made in the VM.
- Whether the `sandbox` iframe is a real boundary: only one route out of it was tried.
- Whether other local users can read the environment from the renderer's command line.
- `shell.openExternal` with a hostile scheme, and any exploit of the Chromium 130 engine.
- macOS, Windows, and Linux on arm64.

## Recommendation for ADR 0001 decision 1(b)

**Do not ship shape (b). Build shape (a) only.** The condition in decision 1 is met only in part:
the runtime can be bootstrapped, but holding it means republishing it. The security result decides it.

**What this means for Nutflix.** The renderer shows Nostr events, profiles and video metadata written
by strangers. In this runtime **an HTML injection is code execution as the user**, with no sandbox
around it. One missed escape in a title lets a stranger read the user's files and environment,
including the seeder key and the sealed signing key of decision 8, and wait for its passphrase.
The engine is Chromium 130, from October 2024, and the pin keeps it there. A memory-safety bug in
its parsers or decoders would need no injection at all (not tested).

**What the app could do, and why it is not enough:**

| Measure | Evidence | Limit |
|---|---|---|
| A separate sandboxed window or view | **Not available.** pear-electron overwrites `webPreferences`, and there is no `<webview>`. | None possible from the app. |
| `<meta>` CSP without inline script | Enforced in a frame (Q5). | Does not stop an engine bug, or a link to `shell.openExternal`. |
| Untrusted content in `<iframe sandbox="allow-scripts">` | One escape route failed (Q5). | Not shown to be a boundary, with `webSecurity: false` on the view. |
| Text-only rendering of all remote fields | Not tested. | One mistake anywhere restores code execution. |

These reduce the odds of an injection. None of them gives the renderer a sandbox, so a single
failure still means code execution as the user.

**If the maintainer keeps (b) anyway,** the minimum is:
- install from a SovTech release line, and run only the versioned link the notice names;
- all four measures above, with no key material reachable from the renderer;
- a working, authenticated renderer-to-worker channel, which this spike did not demonstrate;
- a label saying plainly that the app is unsandboxed legacy software.

**Decision for the maintainer:** drop decision 1(b) and `shells/pear-v2`, or accept this risk in
writing.
