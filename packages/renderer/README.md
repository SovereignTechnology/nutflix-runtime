# @nutflix-runtime/renderer

The Chromium renderer ([ADR 0001](../../docs/decisions/0001-a-pear-native-nutflix.md) §3): the Nutflix
UI, playing free NFX videos that the [worker](../worker/README.md) fetches over HyperDHT.

- **The UI** is nutflix-pear's `@sovit/ui` `Shell` (from the submodule, not edited), over a
  `NetworkAdapter` of this package's own: `RuntimeNetworkAdapter`. It offers Home (the Network and
  Tags feeds), Search, Watch, Channel and Settings. No wallet, no paid videos, no Studio, no
  signing: those calls reject `unsupported`, and the shell's offer (`src/shell/offer.ts`) hides
  what would call them.
- **Nostr** runs here, over the browser's WebSocket, with core's own catalogue (`NfxCatalog`),
  NIP-11-aware search (`RelaySearchSupport`) and live beacon watch (`NfxBeaconWatch`: beacons are
  ephemeral, so they need a live subscription). The default relays are the desktop app's:
  `wss://relay.nutflix.xyz` (the scoped relay) first, then four public read relays.
- **Playback** (ADR decision 4, the hyper-only path): the `t: 'hyperdht'` endpoints of verified
  beacons go to the worker's `nfx.play.open`, and `progressiveUrl` plays in a plain `<video>`.
  Leaving the page closes the session. The WebRTC player is slice B.
- **The capability probe** (`src/probe.ts`) checks `RTCPeerConnection`, `WebAssembly.validate` and
  `MediaSource`, and gives a reason when one is missing. It only reports for now.

## The worker pipe

The renderer reaches the worker through a `WorkerPipe` (`src/worker/pipe.ts`): a framed byte
duplex, the 4-byte-length JSON frames of the worker's protocol. Each shell supplies one. The bundle
(`dist/app`) finds it on `globalThis.nutflixWorkerPipe`, set before the page's script runs, and
optionally `globalThis.nutflixOpenLink(url)`, which receives an `https:` link a viewer clicked.
The shell sends `init` before it hands the pipe over: a renderer never names a path for the worker
to write.

A shell must serve the bundle from one origin (`'self'` in the policy), not `file:`.

The pipe carries the worker's whole protocol, and the worker trusts its host. This renderer uses
three requests of it (`status`, `nfx.play.open`, `nfx.play.close`), but a compromised renderer
could send any other (`nfx.seed.*`). A shell that wants a narrower window filters methods on its
side of the pipe: that is the shells' step, not this package's.

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
  inline script, no `eval`, no inline style; `media-src` is the worker's loopback server only;
  `connect-src` is `wss:` relays, `https:` (the viewer's relays' NIP-11 documents and signed
  images: the hosts are the viewer's, and each is checked by `isPublicHost`) and loopback.

## Layout

| Module | What it is | From nutflix-pear (submodule, `packages/app-web/src/…`) |
|---|---|---|
| `src/main.tsx`, `src/entry.ts` | `startRenderer`, and the page's script | `main.tsx`, adapted |
| `src/adapter/adapter.ts` | `RuntimeNetworkAdapter` | `adapter/web-adapter.ts`, `playNfx` rewritten for the worker |
| `src/adapter/endpoints.ts` | the verified `hyperdht` endpoints of beacons | `adapter/endpoints.ts`, for `https` origins |
| `src/adapter/session.ts` | one play: a `url` source, closed through the worker | new (`adapter/session.ts` is the WebRTC one) |
| `src/adapter/{images,address,wallet}.ts`, `src/net/*`, `src/shell/routes.ts` | signed images, NFX addresses, no wallet, bounded HTTP, hosts, hash routes | the same files, renamed |
| `src/settings/*` | defaults (the desktop app's), the checks, Web Storage | `settings/*`, trimmed |
| `src/shell/offer.ts` | what the shell offers | `shell/offer.ts` |
| `src/worker/pipe.ts` | `WorkerPipe`, `WorkerLink` over the worker's `WorkerClient` | new |
| `src/links.ts`, `src/probe.ts` | the `https:` gate and click guard; the capability probe | new |
| `scripts/build.ts`, `index.html` | the bundle, with SRI and the policy | `scripts/build-site.ts`, `scripts/csp-sri.mjs` (reused) |

## Tests

`npm test` runs the unit tests (jsdom, and node where a file says so). `npm run test:e2e` builds
the bundle and runs `e2e/renderer.e2e.ts`: headless Chromium, a real worker on a loopback hyperdht
testnet fed by nutflix-pear's own `listenNfx`, a local relay, and a VP9 clip made by ffmpeg
(`FFMPEG`; `CHROMIUM` picks a browser; `NUTFLIX_E2E_NO_SANDBOX=1` where Chromium cannot sandbox,
as root). CI runs it as its own job.
