# 1. A Pear-native Nutflix

Date: 2026-11-19

## Status

Accepted by the maintainer, 2026-11-19. Amended 2026-11-22 after spikes S1 and S2: see
[the amendment](#amendment-2026-11-22), which takes precedence over the text above it.

## Context

[nutflix-pear](https://github.com/SovereignTechnology/nutflix-pear) is an Electron app built with
Forge, with a Bare worker spawned through `bare-sidecar`. It ships as a `.deb` and AppImage on
GitHub, each with a Nostr-signed release notice (kind 30071). Its `pear://` channel was planned
(its ADR 0017 §6) and never built, and it refuses Pear's over-the-air updater.

The maintainer asked for a Nutflix that is native to the Pear network, as a separate repository:
- published on a `pear://` link;
- getting its seeds from nutflix-pear;
- playing over HyperDHT and WebRTC.

Pear changed under that request. **Holepunch removed `pear run` in Pear v3** (deprecated in
v2.6.5; the removal was announced for the end of June 2026). In v3:
- an app is installed with `pear install pear://<key>`, which pulls a `pear build` deployment
  (`by-arch/<platform>-<arch>/app/…`) from peers;
- it updates from the same link through the `pear-runtime` library, inside an Electron shell;
- production releases are gated by `pear multisig`.

## Decision

1. **Two shapes.**
   - (a) A Pear v3 app: `pear install`, plus updates over the Pear network.
   - (b) A `pear-electron` app for a pinned pre-v3 runtime, so that `pear run pear://…` still
     works.

   (b) is kept as an accepted risk, under the conditions in
   [the amendment](#amendment-2026-11-22), and is labelled as unsandboxed legacy software.
2. **Updates need two keys of different kinds.** A release reaches the production link only
   through a `pear multisig` quorum. The running v3 app calls `applyUpdate()` only when a kind-30071
   notice signed by the SovTech key (`d = nutflix-runtime`) names the new build: its versioned link
   and the sha256 of its artifacts. A build that is not named is held, and the app says so.
   - The pre-v3 runtime updates apps without asking them. For (b), users run the **versioned**
     link that the notice names. The unversioned link is documented as trusting the multisig key
     alone.
3. **One worker, one renderer, two thin shells.**
   - **The Bare worker is the data plane:** a HyperDHT node, NFX-12 fetch and serve, the NFX store
     (every file sha256-checked, NFX-05 §4), a loopback progressive range server and a loopback
     NFX origin, the seeder key, and Studio packaging with the system's ffmpeg.
   - **The renderer** runs `@sovit/ui`, talks to Nostr relays over the browser's WebSocket, and
     plays.
   - **The shells** (`shells/pear-v3`, `shells/pear-v2`) only start these and carry the update
     gate.
4. **HyperDHT and WebRTC, with a fallback.**
   - At startup the renderer probes `RTCPeerConnection`, WebAssembly (the pinned `nfx_wasm`) and
     `MediaSource`.
   - With all three, it plays through nfx's web player library: the worker's loopback origin
     serves bytes fetched over HyperDHT, and a WebRTC mesh signaled over Nostr (NFX-10 §6) reaches
     browsers and nfxd's mesh endpoints.
   - Without them, it plays a plain `<video>` from the worker's progressive range server, over
     HyperDHT alone.
   - WebRTC is on by default, with nutflix-pear's disclosure: peers see the user's IP address. The
     user can switch it off.
5. **WebRTC in the renderer keeps nutflix-pear ADR 0023 rule 5.**
   - Before `setRemoteDescription`, remote SDP candidates that are not global-unicast UDP are
     dropped, and so are mDNS names. This is safe because browsers do not trickle candidates.
   - Session keys are random and never the user's or the seeder's key.
   - The v3 shell also sets `webRTCIPHandlingPolicy` to `default_public_interface_only`. The
     pre-v3 runtime cannot, and Settings says so.
6. **Reuse, not copies.** nutflix-pear is a git submodule pinned to a commit, and its
   `@sovit/core`, `@sovit/ui` and `@sovit/seeder` are used as they are, so `nfx/files/1`, beacons
   and manifests stay byte-compatible with deployed seeders. Worker code that is not yet a package
   is adapted here until an upstream PR moves it into one.
7. **Scope of the first version:** free NFX videos (watch, seed, publish). Paid Hyperblobs videos
   (`pay/1`, Cashu) are out of scope.
8. **Secrets:** the user signs with a NIP-46 bunker or a passphrase-sealed local key held by the
   worker. Electron's `safeStorage` is not used: the pre-v3 runtime does not expose it, and one
   code path is easier to review.

## Consequences

- nfxd meets this app over WebRTC only, and only where the runtime has it. A native nfxd HyperDHT
  endpoint is proposed upstream as [nfx #106](https://github.com/SovereignTechnology/nfx/issues/106).
- On Ubuntu 24.04 and later, the AppImage cannot start Chromium's sandbox (nutflix-pear ADR 0017
  §7). The app runs there only if the user chooses to, after a warning (amendment, item 2).
- The rules nutflix-pear's own Electron main enforces (fuses, a header CSP) hold in shape (a) only.
  Shape (b) runs on Holepunch's Electron.
- **Known limit: with "seed what you watch" on, a compromised page can choose what gets seeded.**
  The worker checks that the video is free, that its manifest verifies, and that the same window
  has it open in a play. It cannot tell whether the person actually watched it, because the only
  witness is the page. So a compromised page could open a play of a video the user never saw and
  have this computer store and serve it, sharing the user's IP address with whoever fetches it. A
  "served enough bytes" check would not help: the page could fake it. The limits stay (the switch is
  off by default and takes a native confirmation, 16 GiB, 20 new videos and a byte budget an hour),
  and they bound the damage without removing it. The hourly counters live in memory, so they start
  again when the app restarts. Whether to accept this or to change how the feature works is the
  maintainer's decision.
- **Known limit: fullscreen hides the real Account menu.** Real fullscreen stays, because a video app
  needs it, so a compromised page can draw a fake menu while it lasts. Observed once, in the Electron
  proof on Linux under Xvfb with no window manager: a real click took the page to fullscreen and
  Electron reported the menu bar hidden and the window fullscreen; a real Esc left fullscreen and
  Electron reported the menu bar visible again. That is Electron's own report, not a picture of the
  screen. Windows and macOS were not measured.
- **Without Chromium's sandbox, no sealed key.** A key on disk needs the renderer to be confined, the
  same reason shape (b) may not hold one. If the user chose to run without the sandbox (amendment,
  item 2), the local key path is refused for that run and only a NIP-46 bunker can sign. A key
  already on this computer stays on disk, unread and untouched, and works again on the next launch
  with the sandbox on. The app says why, in Settings and in the Account menu's answer.
- **Secret entry opens only from the native Account menu.** A compromised page can draw a box that
  looks like the real prompt, so no window has a method that opens it. The rule a user can hold on
  to: Nutflix asks for a passphrase or bunker link only after you chose it from the Account menu.
  The page can still draw a fake box, and it cannot open the real one. **There is no Account menu in
  fullscreen**, and a page can enter fullscreen on the user's click, as a video player does, then
  draw a fake menu over the whole screen. So the rule is: press Esc to leave fullscreen first, and
  never enter a key or bunker link while in fullscreen.
- **Known limit: an encode can outlive a crashed worker off Linux.** On Linux the kernel kills
  ffmpeg with its parent (`setpriv --pdeathsig`). On macOS and Windows, or on Linux without
  `setpriv`, ffmpeg is killed on a normal exit and on cancel, but not after a crash of the worker.
- **Known limit: on Windows, a power cut just after publishing can lose the video.** The signed
  record is written and synced before the signed event is returned. On Linux and macOS its directory
  is synced too. On Windows that step is skipped and the rename is not written through, so a power
  cut in the seconds after publishing can bring back the file from before the signature. The video
  then reads as an unsigned draft, the next start deletes its bytes, and its manifest stays on the
  relays pointing at nothing.
- **Known limit: free space is read once, per job.** Studio reads the real free space
  (`statfs`) and holds a job to a third of it, because the encode, the packaged files and the store's
  copy are on disk at once. Anything else filling the disk during the job can still end it with an
  error; it then cleans up after itself.

## Amendment, 2026-11-22

The maintainer's decisions after [S1](../spikes/S1-pear-v2-pin.md) and
[S2](../spikes/S2-pear-v3-ota.md).

1. **Shape (b) stays, as a risk accepted in writing.** S1 recommended dropping it. On Pear v2.6.5
   the renderer has Node integration and no sandbox, and an app cannot change that. In S1, an
   injected `<img onerror>` ran a command as the user, so one missed escape in a stranger's title
   is code execution. Its engine is Chromium 130 and stays there. Hardening lowers the odds of an
   injection; it does not add a boundary. Shape (b) does not ship until all of these hold:
   - It runs on a pinned v2.6.5 from a SovTech-controlled release line, because S1 found that only
     re-homing onto a key we control holds the version. Users run the versioned link a signed
     notice names.
   - A `<meta>` CSP, first in the document, allows no inline script and no `eval`.
   - Every remote field renders as text. `innerHTML` and `dangerouslySetInnerHTML` are refused by
     lint, and anything that cannot be text goes in an `<iframe sandbox="allow-scripts">`.
   - Remote URLs never reach navigation or `window.open`, which the runtime passes to
     `shell.openExternal` with no scheme check. Links go through an `https:` check.
   - Shape (b) v1 is watch only: no signing, no publishing, no seeding, and no wallet. Its window
     has Node access and no sandbox, so it has no safe place to type a passphrase or a bunker link,
     and anything a stranger's string ran there could read them. Seeding and publishing would
     also put the user's address on the network from that same unconfined process. The seeder key
     is a network identity and is treated as exposed.
   - An authenticated renderer-to-worker channel works. S1 did not confirm this pipe.
   - The window, the README and the install instructions say plainly that this is unsandboxed
     legacy software, and point to shape (a).
2. **Without Chromium's sandbox, the app runs only if the user chooses to (shape a).** The AppImage's
   `AppRun` adds `--no-sandbox` only when the kernel limits user namespaces and Chromium itself then
   reports that its sandbox cannot start, because Chromium would otherwise abort before app code.
   The main process detects the switch before any window opens and shows a warning, with Quit as
   the default and "Run anyway" as the choice. The choice is stored per install and can be revoked
   in Settings, and a banner stays visible while the sandbox is off. The main process never adds
   the switch itself.
3. **Without FUSE, the app still starts, and tells the user how to start faster.** It falls back to
   extract-and-run and shows a notice to install FUSE. S2 found that the stock AppImage runtime
   exits before any app code when FUSE is missing, so this fallback lives in a patched runtime,
   pinned by sha256 (`shells/pear-v3/packaging/appimage-runtime/`). That runtime needs only a
   `fusermount` helper, so the notice names `fuse3` rather than FUSE 2.
4. **The update gate follows S2.** It judges only the newest build on the link. A newer build with
   no notice holds back an older announced one: this fails safe, and publishing a notice clears it.
   S2's record has the exact API sequence. Still untested: Chromium's sandbox on a real Debian
   desktop, a signed multisig quorum, and a real signed notice.
5. **Shape (a) ships on five targets from the start:** `darwin-arm64`, `darwin-x64`, `linux-arm64`,
   `linux-x64` and `win32-x64`, all on one `pear://` link. CI builds each on its own OS, `pear build`
   merges them, and each target must pass a real `pear install` and launch before a release. On
   other people's machines, macOS needs Apple code signing and notarization, and Windows needs a
   real code-signing certificate. Until those exist, those three targets are test builds.
6. **Shape (a) does not depend on shape (b).** They share the worker and renderer source but are
   separate builds on separate links. Pear v3 lives on its own platform key, and it has no
   `pear run`; installing v3 also takes the v2 `pear` off `PATH`, so shape (b) needs its own
   launch instructions. Shape (b) cannot use shape (a)'s dependency set as it stands: Pear v2.6.5
   runs Bare 1.24.3, and the locked `bare-fs` needs Bare 1.28 or later. It needs its own pins, and
   its renderer must work on Chromium 130. It follows on a target only after passing the same
   install-and-launch test there.
