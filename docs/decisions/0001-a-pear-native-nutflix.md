# 1. A Pear-native Nutflix

Date: 2026-11-19

## Status

Accepted by the maintainer, 2026-11-19. The spikes in [`docs/spikes/`](../spikes/) gate the parts
marked "if S1" or "per S2".

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

   (b) is built only if spike S1 shows that such a runtime can still be bootstrapped and held at
   that version. It is labelled legacy and unsupported if kept.
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
- On Ubuntu 24.04 and later, `pear install` installs an AppImage, which cannot start Chromium's
  sandbox there (nutflix-pear ADR 0017 §7). The app refuses to run without the sandbox, so those
  systems are not supported until Pear offers another Linux format.
- Every security rule that nutflix-pear's own Electron main enforces (fuses, a header CSP,
  refusing `--no-sandbox`) holds in shape (a) only. Shape (b) runs on Holepunch's Electron.
