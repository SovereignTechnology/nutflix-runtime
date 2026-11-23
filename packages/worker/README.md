# @nutflix-runtime/worker

The Bare worker: nutflix-runtime's data plane ([ADR 0001](../../docs/decisions/0001-a-pear-native-nutflix.md) §3).

- It runs one HyperDHT node.
- It fetches and serves NFX videos over NFX-12 (`nfx/files/1` on Protomux), with nutflix-pear's
  own code from the submodule (`@sovit/seeder`'s `dialNfx` and `listenNfx`).
- It keeps a store in which every file is sha256-checked (`@sovit/seeder`'s `NfxStore`, NFX-05 §4).
- It serves the renderer two loopback endpoints:
  - a **progressive range server**: one rendition as one fMP4, for a plain `<video>` (the
    fallback path);
  - an **NFX origin**: NFX-05 §6 paths for nfx's web player (hls.js, p2p-media-loader and
    `nfx_wasm`), given to it as `origins: [originUrl]`.

The host, which is a Pear shell's main process, talks to it over one framed duplex: `Bare.IPC`,
which both `pear-runtime`'s `run()` and `bare-sidecar` provide.

## Layout

| Module | What it is | From nutflix-pear (submodule, `packages/app-desktop/src/…`) |
|---|---|---|
| `src/main.ts` | The Bare entry: `Bare.IPC` ⇄ `WorkerRpc` ⇄ `WorkerHost` | `worker/entry.ts`, adapted |
| `src/host.ts` | `init`, dispatch, the order of `close` | new |
| `src/rpc.ts`, `src/client.ts` | The worker's and the host's side of the wire | `worker/rpc.ts`, adapted; the client is new |
| `src/protocol.ts`, `src/guards.ts`, `src/errors.ts` | Methods, events, limits; strict argument guards; errors as data | new; same rules as `ipc/worker-guards.ts` and `ipc/errors.ts` |
| `src/framing.ts`, `src/codec.ts` | 4-byte big-endian length, then strict UTF-8 JSON | `ipc/framing.ts` (the cap is now 1 MiB), `ipc/codec.ts` |
| `src/nfx/watch.ts` | One progressive session: layout C, spooled, checked against the plan | `worker/nfx/watch.ts` |
| `src/nfx/hyperdht-fetcher.ts` | The peer pool (one connection per seeder), the NFX-12 fetcher | `worker/nfx/hyperdht-fetcher.ts`, unchanged |
| `src/nfx/fallback-fetcher.ts` | The sources of a session, in order | `worker/nfx/fallback-fetcher.ts`, unchanged |
| `src/nfx/range-server.ts` | The progressive range server | `worker/nfx/range-server.ts` |
| `src/nfx/seeding.ts` | One network's NFX-12 listener | `worker/nfx/seeding.ts`, unchanged |
| `src/nfx/watching.ts` | `nfx.play.*`: play sessions, both loopback servers | `worker/nfx/watching.ts`, adapted (no iroh, no Rust helper) |
| `src/nfx/origin.ts` | The loopback NFX origin and its pull-through file source | new |
| `src/nfx/store-fetcher.ts` | A stored video as a source, hashed again on read | new |
| `src/nfx/seeds.ts` | `nfx.seed.*`: fetch into the store, one listener per network | new |
| `src/nfx/seed-policy.ts`, `beacons.ts`, `seeder-key.ts`, `offers.ts` | What may be served and why; kind-20464 beacons; the seeder's Nostr key; files handed over from WebRTC | new, after `host/nfx/beacons.ts` and `seeder-key.ts` |
| `src/signer/` | The user's signer: a sealed local key or a NIP-46 session | core's `LocalSigner` and `Nip46Signer` |
| `src/studio/` | The system's ffmpeg behind a guard, and publishing | `worker/ffmpeg.ts`, `worker/studio/nfx.ts`, adapted |
| `src/net/dht-node.ts` | The one HyperDHT node | `worker/net/peer-node.ts` and the own-DHT part of `worker/nfx/watching.ts` |
| `src/keys.ts` | Corestore-derived key pairs `nfx:<ns>:seeder` and `nfx:<ns>:watcher` | the names of `worker/nfx/seeding.ts` and `watching.ts` |
| `src/adapters/bare.ts`, `src/runtime.ts` | bare-fs, bare-path and bare-http1, loaded lazily | `worker/adapters/bare.ts` and `worker/runtime.ts`, cut down |
| `src/log.ts`, `src/crypto.ts`, `src/bare-globals.ts` | A redacting logger as events; libsodium sha256 and randomness; `TextEncoder` and `TextDecoder` for Bare | `worker/log.ts`, `worker/crypto.ts`, `worker/bare-globals.ts` |

The package exports its host-side modules for the shells and the tests: `.` (the protocol, framing
and `WorkerClient`, which a renderer can import), `./host`, `./rpc` and `./runtime`, and `./main` (the
Bare entry).

Its tests (`src/__tests__/`) run under Node with injected dependencies: node:http, `nodeFs`,
and a hyperdht testnet on loopback. They include the ported nutflix-pear tests:
- `framing.test.ts` and `codec.test.ts`;
- `watch.test.ts` (from `nfx-watch.test.ts`);
- `fallback-fetcher.test.ts`;
- `seeding.integration.test.ts`.

The tests use nutflix-pear's NFX test video and the NFX-05 test vector, both from the submodule.

## The protocol

Each message is one frame: a 4-byte big-endian length, then that many bytes of UTF-8 JSON (a
JSON object).
- A frame may be at most 1 MiB. A longer length is refused before any byte of the payload is
  buffered.
- A corrupt stream (too long, not UTF-8, not JSON) ends the pipe. Neither side resynchronises.
  The worker exits with code 3.

```
host → worker   { "op": "req", "id": <0..2^31-1>, "m": "<method>", "a": { …arguments } }
worker → host   { "op": "res", "id": …, "ok": true,  "r": <result> }
                { "op": "res", "id": …, "ok": false, "e": { "code": "<code>", "message": "<code>: …" } }
                { "op": "ev",  "e": "<event>", … }
```

The worker checks every request before a handler sees it:
- the method must be known;
- the arguments must be a plain object with no unknown key (a JSON `"__proto__"` key counts as
  one);
- every string and array is bounded;
- hex is lowercase;
- video addresses and namespaces are canonical NFX-01 (a video id has 7 to 63 characters).

What happens to a refused frame:
- If it looks like a request and has a usable `id`, it gets an `invalid-argument` answer.
- Anything else is dropped.

At most 64 requests run at once; any more get `rate-limited`. Only the worker's own error codes
and messages cross the wire; any other failure crosses as `internal: internal error`.

Error codes:
- `invalid-argument`
- `not-ready`
- `not-found`
- `no-seeders`
- `unsupported-input`
- `rate-limited`
- `session-closed`
- `backend-down`
- `exists`
- `disk-cap`
- `io`
- `no-signer`
- `bad-passphrase`
- `ffmpeg-missing`
- `internal`

### Methods

| Method | Arguments | Result |
|---|---|---|
| `init` | `{ v: 1, storage, bootstrap?, diskCapBytes?, logLevel? }` | `{ v: 1 }`, followed by a `ready` event |
| `status` | `{}` | `{ dht, playSessions, storedVideos, listening }` |
| `nfx.play.open` | `{ sid, video, root, segs, peers, renditions?, held?, prefetchSeconds?, progressive?, origin? }` | `{ progressiveUrl, originUrl, rendition, renditions }` |
| `nfx.play.close` | `{ sid }` | `null` (idempotent) |
| `nfx.seed.start` | `{ video, root, segs, peers }` | `{ video, root, segs, files, bytes }` |
| `nfx.seed.stop` | `{ video }` | `{ removed }` |
| `nfx.seed.list` | `{}` | `{ videos: [{ video, root, segs, files, bytes }], listening: [{ namespace, connections }] }` |
| `nfx.endpoint` | `{ seeder, namespace }` | `{ hyperdht: { t: 'hyperdht', peer, bind } \| null }` |
| `signer.status` | `{}` | `{ kind, pubkey, locked, keyFile }` |
| `signer.local.create`, `signer.local.unlock` (main only) | `{ passphrase }` (8 to 1024 characters) | the status |
| `signer.nip46.connect` (main only) | `{ uri }` (`bunker://…`) | the status |
| `signer.lock` | `{}` | the status |
| `signer.check` (main only) | `{ video }` | `{ video, event, signer, npub, title, tags, description, file }` |
| `signer.sign` (main only) | `{ event: { kind, created_at, tags, content }, signer }` | the signed event |
| `seeding.status` | `{}` | `{ watched, videos: [{ video, files, bytes, origin, served, stopped, root?, segs? }], listening }` (no `root` or `segs` for a private video) |
| `seeding.set` (main only) | `{ watched }` | the seeding status |
| `seeding.watch` | `{ sid, manifest, peers }` | `{ video, root, segs, files, bytes }` |
| `seeding.stop` | `{ video }` | `{ stopped }`: stops serving and keeps the bytes |
| `seeding.resume` (main only) | `{ video }` | `{ resumed }` |
| `seeding.delete` (main only) | `{ video }` | `{ removed }` |
| `seeding.beacons` | `{}` | `{ events }`: signed kind-20464 beacons |
| `seeding.segment` | `{ sid, sha256, size, offset, data }` | `{ accepted, complete }` |
| `studio.ffmpeg` | `{}` | `{ found, version?, install }` |
| `studio.source` (main only) | `{ path }` | `{ source, name, bytes }` |
| `studio.probe` | `{ source }` | `{ durationSec, width, height, sizes }` |
| `studio.publish` | `{ source, title, description, tags, sizes }` | `{ video, files, bytes }` |
| `studio.cancel` | `{}` | `{ cancelled }` |
| `studio.discard` (main only) | `{ video }` | `{ removed }`: only an unsigned draft |

Every other request fails `not-ready` until `init` has answered. A second `init` fails.

#### `init`

- **`storage`** must be an absolute directory, at least two names deep, with no `.` or `..` name.
  The worker owns it:
  - `keys/` is a Corestore used only for its primary key;
  - `nfx/` is the NFX store;
  - `tmp/` is wiped at every start and holds the play spools.
- **`bootstrap`** lists 1 to 16 `{ host, port }` nodes. When it is absent or `null`, the node uses
  HyperDHT's public bootstrap.
- **`diskCapBytes`** caps the store. Without it there is no cap.
- **`logLevel`** is the least severe level sent as `log` events. The default is `info`.

At start, the worker listens again for the videos it may serve (see "Seeding"). With none, it
starts no DHT node.

#### The signer

A key made here and sealed under a passphrase (`signer/user.key`, 0600: argon2id and
XChaCha20-Poly1305, core's `LocalSigner`), or a NIP-46 bunker whose session this worker holds. No
method returns a key, and none imports one. A passphrase or bunker URI reaches the worker from main's
own prompt window and never passes through the page. A sealed key exists only where `init` says
`localKey: true`: shape (b) does not, so it has no path to one.

`signer.sign` signs only kinds in `SIGNABLE_KINDS` (kind 38504), and only the exact draft
`studio.publish` made for a video this node packaged, once. Only main reaches it, after the user
confirmed in a native dialog what `signer.check` reported: the file, the full key, the title, the
tags and the description. Main sends back the key the user approved, and the worker refuses if the
signing key is any other. The signer cannot be locked or changed while a signature is pending. A
wrong passphrase costs a full KDF run, and from the second failure an increasing wait.

#### Seeding

`seeding.json` records why each video may be served, and **a stored video with no record is not
served**:
- "Seed what you watch" (`seeding.set`) is off by default, and main turns it on only after a native
  confirmation. With it on, `seeding.watch` stores the video of an open play of the same window,
  within 16 GiB and 20 new videos an hour.
- A video the user published is served once they have confirmed and signed it. Until then it is a
  private draft: it is not served, a play cannot read it, and `seeding.status` hides its hash list.
  Saying no deletes it, a failed signature keeps it for a retry, and the next start deletes it.
- One stored by `nfx.seed.start` (the host's, never a window's) is served.

`seeding.stop` stops serving and keeps the bytes, and the video stays stopped across restarts.
Serving it again (`seeding.resume`) or deleting it (`seeding.delete`) is main's, after a native
confirmation. Turning the switch off also stops fetches in flight and drops what was handed over.

Beacons are signed here by a seeder key derived from the Corestore (never the user's), and the
renderer publishes them.

**Known limit (ADR 0001, Consequences).** With the switch on, a compromised page can choose what
gets seeded: it can open a play of a free video the user never watched, and this computer will store
it and serve it, which shares the user's IP address with whoever fetches it. The worker cannot tell
whether anyone watched, and a "served enough bytes" check would only be something the page could
fake. The limits above bound this; they do not prevent it.

A file that reached the renderer over WebRTC (`seeding.segment`) is taken only for an open play
session whose verified hash list names its sha256 and size, whole, while the switch is on. It is
then re-seeded without being fetched again.

#### Studio

`studio.source` takes a path from main's native dialog; the page only ever holds a token, good for
one publish. There is one live token: a new pick revokes the old one, and it expires after 30
minutes. A job's output is held to the space the store has left, at most 32 GiB. The
system's ffmpeg and ffprobe run from an argv, with `-protocol_whitelist file,pipe`, a demuxer
allow-list (no HLS, DASH or concat, which would read other local files), `-max_pixels`, inputs and outputs confined
to the picked file and a job directory under `tmp/`, and caps on size, length and time. If they are
missing, `studio.ffmpeg` says how to install them.

#### `nfx.play.open`

The host passes a video it found: its manifest is verified, and the `root` and `segs` come from
it. `peers` are the `hyperdht` endpoints of verified beacons, at most 16, each with
`{ t: 'hyperdht', peer, bind }`. `sid` is minted by the host: 32 lowercase hex.

The worker's sources, in order:
1. its own store, when it holds this video with this `root`;
2. the peers.

With neither, the open fails `no-seeders`.

The worker fetches the hash list once and verifies it against `root`, the address and `segs`. A
list that does not verify fails `invalid-argument`.

How the rendition is chosen:
- Without `renditions`, it is the one most seeders hold (by `held`, core's `countHolders`). At
  equal holders, or without `held`, it is the highest bandwidth.
- With `renditions`, an order of preference, it is the first of them that is listed and held.
- With none, the open fails `not-found`.

What comes back:
- **`progressiveUrl`** is `http://127.0.0.1:<port>/<token>/<sid>`: the rendition as one
  `video/mp4`, served from the init and the first segment (the open answers once those are
  spooled), with the rest fetched ahead of the reader by `prefetchSeconds` (default 30, at
  most 600).
  - It takes GET and HEAD with one range, and always serves the whole range asked for: Chromium
    reads a short 206 as the end of the file.
  - An unsatisfiable range is 416. A range whose first bytes cannot be had is 503.
  - If the rendition cannot be one file (not fMP4), it is `null` when the origin was asked for
    too, and the open fails `unsupported-input` when it was not.
- **`originUrl`** is `http://127.0.0.1:<port>/<token>`: an NFX-05 §6 origin for this video only.
  - GET and HEAD of `<base>/<root>`, `<base>/<root>/master.m3u8`, `<base>/<root>/<sha256>.<ext>`
    and `<base>/<sha256>[.<ext>]`, for the hash list and the files it names. OPTIONS answers a
    CORS preflight.
  - Every answer carries `Access-Control-Allow-Origin: *`. Files are
    `Cache-Control: public, max-age=31536000, immutable`; errors are `no-store`.
  - Each file is served only once its bytes have verified (by the NFX-12 client, or by the
    store when it wrote them). It is fetched once on its first request, spooled, and served in
    single ranges.
  - Anything else is 404: another path, a query, uppercase hex, a hash the list does not name, a
    dot segment, percent-encoding, or another token.
- **`rendition`** is the rendition chosen, and **`renditions`** lists the playable renditions,
  highest bandwidth first, at most 16.

`progressive: false` or `origin: false` leaves that endpoint out; at least one stays.

At most 4 sessions are open at once; another open fails `rate-limited`. A duplicate `sid` fails
`invalid-argument`.

#### `nfx.play.close`

Both links 404 at once, and responses in flight are cut. The session's fetches stop and its spool
is deleted.

#### `nfx.seed.start`

The worker stores the video and seeds it:
- It fetches the hash list and every file it names from `peers`, over the same peer pool the
  play sessions use. A file over 64 MiB is refused before it is fetched.
- The store checks the list against `root` and each file's size and sha256 before it writes
  anything.
- The answer comes once the video is stored and its network's NFX-12 listener is up.
- `nfx.seed` events report progress along the way.

Other outcomes:
- If the video is already stored with this `root`, it answers at once; `peers` may be empty.
- If it is stored with another root, it fails `exists`. A start of the same video already
  running is joined.

Every stored video is seeded. Each network (namespace) has its own listener:
- its key pair is Corestore's `nfx:<namespace>:seeder`;
- it serves only that network's videos.

The worker dials with `nfx:<namespace>:watcher`. Neither key pair is used for anything else
(NFX-12 §1).

#### `nfx.seed.stop`

A start of the video that is still running is abandoned. Then the video is removed from the
store, with the files no other video lists. A network with no video left stops listening.

#### `nfx.endpoint`

This answers the beacon endpoint for `seeder` (a Nostr public key, 64 hex) on `namespace`: the
listener's key, and its `bind` signature over `nfx/hyperdht/1:<seeder>:<namespace>`. It answers
only while that network's listener is up, and `null` otherwise, so no beacon names a listener
that is down. The host signs and publishes the beacon.

### Events

| Event | Fields | When |
|---|---|---|
| `ready` | `v` | after `init` answered |
| `status` | `status` (as the `status` method) | whenever a field of it changed |
| `nfx.seed` | `video`, `state` (`fetching`, `seeding`, `failed`, `stopped`), `done?`, `total?`, `error?` | progress of a seed |
| `log` | `level`, `msg` | one redacted log line, at most 2048 characters |

### Security notes

- **The loopback servers.** Both bind 127.0.0.1 only, on a random port. Each session has its own
  128-bit token, made with libsodium randomness. Paths are matched as raw bytes against one
  pattern each, and nothing is percent-decoded or joined.
  - At most 64 origin responses are served at once.
  - A file that is still being fetched gets 30 s, then 503.
  - Each session runs at most 4 pull-throughs at once.
- **What the worker holds in memory.**
  - A fetched file is held until it is spooled. The 64 MiB file cap and the fetch concurrency
    (4 per session) bound this.
  - Frames are at most 1 MiB, and requests in flight at most 64.
- **Logs.** They are redacted twice: `@sovit/seeder`'s `redact`, then 32-byte values cut to 8
  hex characters. Peer keys never leave the worker whole.
