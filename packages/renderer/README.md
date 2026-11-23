# @nutflix-runtime/renderer

The Chromium renderer ([ADR 0001](../../docs/decisions/0001-a-pear-native-nutflix.md) §3): the Nutflix
UI, playing free NFX videos that the [worker](../worker/README.md) fetches over HyperDHT.

- **The UI** is nutflix-pear's `@sovit/ui` `Shell` (from the submodule, not edited), over a
  `NetworkAdapter` of this package's own: `RuntimeNetworkAdapter`. It offers Home (the Network and
  Tags feeds), Search, Watch, Channel and Settings. No wallet and no paid videos: those calls
  reject `unsupported`, and the shell's offer (`src/shell/offer.ts`) hides what would call them.
- **Seeding and publishing** are this package's own section of Settings (`src/seeding/`), because
  `@sovit/ui`'s Studio is built around priced uploads and a browser file input. The switch "Seed what
  you watch" is off by default and says it shares the IP address with viewers. The worker holds
  every key and does the work; this page asks, and publishes what comes back to the relays: beacons
  to the scoped relays only, manifests to the write and scoped relays, each verified here first.
- **Nostr** runs here, over the browser's WebSocket, with core's own catalogue (`NfxCatalog`),
  NIP-11-aware search (`RelaySearchSupport`) and live beacon watch (`NfxBeaconWatch`: beacons are
  ephemeral, so they need a live subscription). The default relays are the desktop app's:
  `wss://relay.nutflix.xyz` (the scoped relay) first, then four public read relays.
- **Playback** (ADR decision 4). The `t: 'hyperdht'` endpoints of verified beacons go to the
  worker's `nfx.play.open`, and then one of two paths plays:
  - **The WebRTC player**, when the probe passed and the viewer has not switched WebRTC off: nfx's
    web player (hls.js, p2p-media-loader, `nfx_wasm`) with the worker's loopback origin as its one
    origin, and a mesh signaled over Nostr (NFX-10 §6) that reaches browsers and
    `nfxd --mesh-relay`. If it fails to start or stops with a fatal error, the same `<video>` goes
    on from the worker's progressive stream.
  - **The hyper-only path:** `progressiveUrl` in a plain `<video>`.

  Leaving the page closes the session.
- **The capability probe** (`src/probe.ts`) checks `RTCPeerConnection`, `MediaSource`, and that
  the pinned library loads and that its pinned WASM passes `WebAssembly.validate`. When one fails,
  videos play over HyperDHT alone, and Settings says why.

## The worker pipe

The renderer reaches the worker through a `WorkerPipe` (`src/worker/pipe.ts`): a framed byte
duplex, the 4-byte-length JSON frames of the worker's protocol. Each shell supplies one. The bundle
(`dist/app`) finds it on `globalThis.nutflixWorkerPipe`, set before the page's script runs, and
optionally `globalThis.nutflixOpenLink(url)`, which receives an `https:` link a viewer clicked.
The shell sends `init` before it hands the pipe over: a renderer never names a path for the worker
to write.

A shell must serve the bundle from one origin (`'self'` in the policy), not `file:`.

The pipe carries the worker's protocol, and the worker trusts its host, so a compromised renderer
could try any method. The shell filters them on its side of the pipe (`MAIN_WINDOW_POLICY` in
`shells/pear-v3/src/main/rpc-gate.ts`): this page cannot reach `init`, `nfx.seed.*`, `nfx.endpoint`,
`seeding.set` or `studio.source`.

## Security (ADR 0001 amendment, item 1; every shape)

- **Every remote field renders as text.** No `innerHTML`, `outerHTML`, `dangerouslySetInnerHTML`,
  `srcDoc`, `insertAdjacentHTML`, `DOMParser`, `document.write`, `eval` or `new Function` in this
  package (an ESLint block in the root `eslint.config.js`, tested by `src/__tests__/lint.test.ts`).
- **`@sovit/ui`, audited at the pinned commit:** it uses none of those APIs. A grep over
  `packages/ui/src` and `packages/core/src` finds no HTML sink; `Markdown` parses a fixed subset to
  React elements. Its one remote-URL sink is `Markdown`'s `<a href target="_blank">`, which accepts
  `http:` as well as `https:`. This package cancels every anchor click in the capture phase
  (`installLinkGuard`) and passes only an `https:` link on a public host to the shell. Settings'
  `source` link is not offered. Not edited: the findings above are the submodule's as they stand.
- **Remote URLs never reach navigation or `window.open`.** Links go through `externalLink`
  (`https:`, no user-info, a public host). The worker's `progressiveUrl` is checked to be its own
  `http://127.0.0.1:<port>/<token>/<sid>` before a `<video>` sees it. Image URLs follow
  app-web's rule: only an image whose publisher signed its sha256, fetched once without cookies or
  redirects, checked, sniffed, and shown as a `blob:`.
- **The policy** is the first element of `index.html`'s `<head>` (tested by `csp.test.ts`): no
  inline script, no `eval`, no inline style; `media-src` is the worker's loopback server and
  `blob:`; `connect-src` is `wss:` relays, `https:` (the viewer's relays' NIP-11 documents and
  signed images: the hosts are the viewer's, and each is checked by `isPublicHost`), loopback and
  `blob:`. What the WebRTC player added, and why:
  - `script-src 'wasm-unsafe-eval'`: compiles nfx's WASM verifier. JavaScript `eval` stays refused.
  - `media-src blob:`: hls.js plays through a `MediaSource`, whose URL is a `blob:`.
  - `connect-src blob:`: the library's `init` fetches the WASM from a URL, so it is handed a `blob:`
    of the bytes this page has already checked against the pin. No new host of any kind.

## WebRTC safety (ADR 0001 decision 5)

- **Remote candidates:** every play passes `remoteCandidates: 'global'`, and the option's type
  allows no other value. Before `setRemoteDescription`, the library keeps only UDP candidates at
  global unicast addresses: private, shared, loopback, link-local, documentation and multicast
  addresses, mDNS and other names, and TCP are dropped.
- **Session keys** are the library's: random for each play, never the user's or a seeder's. This
  renderer holds neither.
- **The IP policy:** the v3 shell sets `default_public_interface_only` on its webContents and
  prints what Chromium reports back in its ready line, which its smoke test requires.
- **What this does not hide:** peers, the signaling relays and the STUN server see the viewer's IP
  address while WebRTC is on, and the relays learn which videos' rooms it is in. Settings says so
  beside the switch. Two viewers on one LAN do not connect directly, because their host candidates
  are mDNS names, which the filter drops.

## The pinned library

`nfx-web.lock` pins nfx's web library by commit, source sha256 and tar sha256. The tar is committed
(`pinned/`), `scripts/build.ts` refuses any other bytes, and the `nfx-lib` job of
`.github/workflows/webrtc.yml` rebuilds it from the pinned source and compares. The lock says why.
Nothing is loaded from a CDN.

## Layout

| Module | What it is | From nutflix-pear (submodule, `packages/app-web/src/…`) |
|---|---|---|
| `src/main.tsx`, `src/entry.ts` | `startRenderer`, and the page's script | `main.tsx`, adapted |
| `src/adapter/adapter.ts` | `RuntimeNetworkAdapter` | `adapter/web-adapter.ts`, `playNfx` rewritten for the worker |
| `src/adapter/endpoints.ts` | the verified `hyperdht` endpoints of beacons | `adapter/endpoints.ts`, for `https` origins |
| `src/adapter/session.ts` | one hyper-only play: a `url` source, closed through the worker | new |
| `src/adapter/webrtc-session.ts` | one play through nfx's player, with the runtime fallback | `adapter/session.ts`, adapted |
| `src/player/*` | the library's API as used here; its loader (sha256, SRI, `init`) | `nfx-lib.ts`, `site/entry.ts` |
| `src/adapter/{images,address,wallet}.ts`, `src/net/*`, `src/shell/routes.ts` | signed images, NFX addresses, no wallet, bounded HTTP, hosts, hash routes | the same files, renamed |
| `src/settings/*` | defaults (the desktop app's), the checks, Web Storage, what WebRTC's settings mean and the line Settings shows | `settings/*`, trimmed |
| `src/shell/offer.ts` | what the shell offers | `shell/offer.ts` |
| `src/worker/pipe.ts` | `WorkerPipe`, `WorkerLink` over the worker's `WorkerClient` | new |
| `src/links.ts`, `src/probe.ts` | the `https:` gate and click guard; the capability probe | new |
| `scripts/build.ts`, `scripts/nfx-lib.ts`, `index.html` | the bundle, with SRI and the policy; the pinned library, checked | `scripts/build-site.ts`, `scripts/csp-sri.mjs` (reused) |

## Tests

`npm test` runs the unit tests (jsdom, and node where a file says so). `npm run test:e2e` builds
the bundle and runs `e2e/renderer.e2e.ts`: headless Chromium, a real worker on a loopback hyperdht
testnet fed by nutflix-pear's own `listenNfx`, a local relay, and a VP9 clip made by ffmpeg
(`FFMPEG`; `CHROMIUM` picks a browser; `NUTFLIX_E2E_NO_SANDBOX=1` where Chromium cannot sandbox,
as root). It runs with `RTCPeerConnection` and WebAssembly removed: the fallback. CI runs it as its
own job.

`npm run test:netns` (`e2e/netns/`, the `webrtc` workflow) is the real WebRTC path: two viewers,
then a viewer and `nfxd --mesh-relay`, through a stock strfry, on the player's default scheduling.
A viewer must play past segments its own seeder was never asked for, which can have come only over
WebRTC, with a sha256 check on what reached the `SourceBuffer`s. The candidate filter refuses loopback, so these run in three Linux network
namespaces joined by a bridge, with global-looking addresses and no way out; a firewall rule in
each one counts anything that tries to leave, and the job fails unless that is zero. No switch in
the product exists for this.
