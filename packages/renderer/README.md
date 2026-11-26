# @nutflix-runtime/renderer

The Chromium renderer ([ADR 0001](../../docs/decisions/0001-a-pear-native-nutflix.md) §3): the Nutflix
UI, playing free NFX videos that the [worker](../worker/README.md) fetches over HyperDHT, and videos
that seeders serve over HTTPS, as nfxd does, through nfx's web player.

- **The UI** is nutflix-pear's `@sovit/ui` `Shell` (from the submodule, not edited), over a
  `NetworkAdapter` of this package's own: `RuntimeNetworkAdapter`. It offers Home (the Network and
  Tags feeds), Search, Watch, Channel and Settings. No wallet and no paid videos: those calls
  reject `unsupported`, and the shell's offer (`src/shell/offer.ts`) hides what would call them.
- **Seeding and publishing** are this package's own section of Settings (`src/seeding/`), because
  `@sovit/ui`'s Studio is built around priced uploads and a browser file input. The switch "Seed what
  you watch" is off by default and says it shares the IP address with viewers. The worker holds
  every key and does the work; this page asks, and publishes what comes back to the relays: beacons
  to the scoped relays only, manifests to the write and scoped relays, each verified here first.
- **Chromium's sandbox** is a section of Settings, shown only while the desktop shell says it runs
  without the sandbox (`src/settings/sandbox-choice.ts`). Its one button asks the shell to forget
  the stored "Run anyway" (`app.sandbox.forget`, no argument); the shell confirms in a native
  dialog.
- **Nostr** runs here, over the browser's WebSocket, with core's own catalogue (`NfxCatalog`),
  NIP-11-aware search (`RelaySearchSupport`) and live beacon watch (`NfxBeaconWatch`: beacons are
  ephemeral, so they need a live subscription). The default relays are the desktop app's:
  `wss://relay.nutflix.xyz` (the scoped relay) first, then four public read relays.
- **Playback** (ADR decision 4 and its amendment of 2026-11-26). Verified beacons name two kinds
  of source this app uses (`src/adapter/endpoints.ts`): `t: 'hyperdht'` endpoints, which go to the
  worker's `nfx.play.open`, and `t: 'https'` origins (NFX-05 §6), which only nfx's web player
  fetches, here in the page: the worker fetches no `https`. nfxd names an `https` origin and no
  HyperDHT endpoint, so its videos play from those origins and the mesh. A play waits for a seeder
  that names either one it can use. Then:
  - **The WebRTC player**, when the probe passed and the viewer has not switched WebRTC off: nfx's
    web player (hls.js, p2p-media-loader, `nfx_wasm`), with its origins in this order: the
    worker's loopback origin, when the worker can serve the video (a HyperDHT seeder, or its own
    store), then the beacons' `https` origins. The library takes every file from the first that
    holds a rendition. Beside it, a mesh signaled over Nostr (NFX-10 §6) reaches browsers and
    `nfxd --mesh-relay`. If it fails to start or stops with a fatal error, the same `<video>` goes
    on from the worker's progressive stream; a play with no worker session has none, and says so.
  - **WebRTC off:** `progressiveUrl` in a plain `<video>`, over HyperDHT alone, as before. A video
    the worker cannot serve plays through nfx's web player from the beacons' `https` origins with
    no signaling, so with no mesh: the library then builds plain hls.js and makes no peer
    connection at all. The page still fetches from those hosts.
  - **No web player** (the probe failed): the progressive path alone. A video only `https`
    origins serve fails with a message that says so, not as "nobody is seeding".
  - **Shape (b)** (the `pear run` window, whose network list is loopback alone) never fetches
    beacon origins (`beaconOrigins: false`): such a video fails the same way, saying the window
    does not fetch from HTTPS hosts.

  "Seed what you watch" works on a play the worker has a session for. A video only `https`
  origins serve, and that the worker does not hold, has none, so it is not stored and re-seeded
  here: that would need the worker to take a session with no source
  ([#39](https://github.com/SovereignTechnology/nutflix-runtime/issues/39)).

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
`seeding.set`, `seeding.delete`, `studio.source`, `signer.local.*`, `signer.nip46.connect` or
`signer.lock`. A passphrase or bunker link is typed in main's own prompt window, which this page
cannot read or open: only the native Account menu opens it, and this page only points at that menu.

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
  `blob:`; `connect-src` is `wss:` relays, `https:` (the viewer's relays' NIP-11 documents, signed
  images, and the origins beacons name for nfx's web player; each host is checked by
  `isPublicHost`), loopback and `blob:`. What the WebRTC player added, and why:
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
- **Beacon origins** (`https`, with WebRTC on or off): the host a beacon names sees the viewer's IP
  address and which video it plays, as any seeder does, and Settings says so beside the switch.
  Beacons come from any key, so the rules are the web app's: `https:` only, no user-info, query
  or fragment, a public host by what the URL says, at most 4 per beacon and 8 in all. The player
  follows redirects, so shape (a)'s main also cancels every `https:` request of the window to an
  IP literal that is not public or to `localhost`, `*.localhost` or `*.local`, a redirect's
  target included (`shells/pear-v3/src/main/loopback.ts`, by this package's own `publicIpLiteral`
  and `isAlwaysLocalName`). Known limits:
  - **Any other name that resolves to a private address is not caught**, here or in main:
    neither sees where a name resolves. Such a host gets the library's plain `GET`s, whose answers it cannot
    read without CORS and which are checked against the hash list anyway.
  - **A hostile origin can answer a segment with more bytes than it should:** the player refuses
    them, after downloading them.

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
| `src/adapter/endpoints.ts` | the verified `hyperdht` endpoints and the usable `https` origins of beacons | `adapter/endpoints.ts`, without its fallback origin |
| `src/adapter/session.ts` | one hyper-only play: a `url` source, closed through the worker | new |
| `src/adapter/webrtc-session.ts` | one play through nfx's player (the worker's origin, then the beacons'), with the runtime fallback; what it measured, on the `<video>` | `adapter/session.ts`, adapted |
| `src/player/*` | the library's API as used here; its loader (sha256, SRI, `init`) | `nfx-lib.ts`, `site/entry.ts` |
| `src/adapter/{images,address,wallet}.ts`, `src/net/*`, `src/shell/routes.ts` | signed images, NFX addresses, no wallet, bounded HTTP, hosts, hash routes | the same files, renamed |
| `src/settings/*` | defaults (the desktop app's), the checks, Web Storage, what WebRTC's settings mean and the line Settings shows; the sandbox section (`sandbox-choice.ts`, new) | `settings/*`, trimmed |
| `src/shell/offer.ts` | what the shell offers | `shell/offer.ts` |
| `src/worker/pipe.ts` | `WorkerPipe`, `WorkerLink` over the worker's `WorkerClient` | new |
| `src/links.ts`, `src/probe.ts` | the `https:` gate and click guard; the capability probe | new |
| `scripts/build.ts`, `scripts/nfx-lib.ts`, `index.html` | the bundle, with SRI and the policy; the pinned library, checked | `scripts/build-site.ts`, `scripts/csp-sri.mjs` (reused) |

## Tests

`npm test` runs the unit tests (jsdom, and node where a file says so); `nfxd-play.test.ts` holds the
plays from `https` origins. `npm run test:e2e` builds
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
