/**
 * The part of nfx's web player library (`web/player/src/lib.ts`, its types in `api.ts`) this
 * renderer calls, at the commit `nfx-web.lock` pins. The session is written against this
 * interface, so the tests pass a fake and the real library is loaded once, by `./load.ts`.
 * After nutflix-pear's `packages/app-web/src/nfx-lib.ts` (the submodule's pinned commit), plus
 * `remoteCandidates`, which is what lets a desktop renderer use this mesh at all (ADR 0001
 * decision 5).
 *
 * What the renderer does not take from the library: `resolveManifest` and `watchEndpoints`. The
 * manifest comes from core's catalogue and the seeders from core's beacon watch; `open()` verifies
 * the manifest again in WebAssembly either way, and checks every byte against the hash list.
 */

/** One rendition as hls.js parsed it from the master playlist. */
export interface NfxLevel {
  /** What `setLevel()` takes. */
  readonly index: number;
  /** The rendition id (the hash list's `renditions[].id`). */
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly bitrate: number;
}

/** What `onEvent` hears; nothing after `destroy()`. */
export type NfxPlayerEvent =
  | { readonly type: 'log'; readonly message: string }
  | {
      readonly type: 'origin';
      readonly origin: string;
      readonly ok: boolean;
      readonly why?: string;
    }
  | { readonly type: 'verified'; readonly sha256: string; readonly url: string }
  | {
      readonly type: 'rejected';
      readonly sha256: string | null;
      readonly url: string;
      readonly why: string;
    }
  | { readonly type: 'levels'; readonly levels: readonly NfxLevel[] }
  | { readonly type: 'playing' }
  | { readonly type: 'error'; readonly message: string };

/**
 * NFX-10 §6 signaling over Nostr: general relays, `wss:` (or `ws:` to a loopback host), 1 to 8.
 *
 * `remoteCandidates: 'global'` is not optional here: without it a stranger's SDP could aim this
 * machine's ICE checks at its LAN, loopback, router or a cloud metadata address (nutflix-pear ADR
 * 0023 rule 5). The type allows no other value.
 */
export interface NfxNostrSignaling {
  readonly kind: 'nostr';
  readonly relays: string[];
  readonly remoteCandidates: 'global';
}

/** A STUN server (`stun:` URLs, no credentials); the library takes at most 4. */
export interface NfxIceServer {
  readonly urls: string[];
}

/** `open()`'s options, as this renderer passes them (always a signed manifest). */
export interface NfxOpenOptions {
  /** The signed kind-38504 event as JSON; the library verifies it again (NFX-02). */
  readonly manifestJson: string;
  /** The worker's loopback origin (NFX-05 §6), alone. */
  readonly origins: string[];
  /** The renditions the session may play, preferred first; absent: every rendition. */
  readonly renditions?: string[];
  readonly signaling: NfxNostrSignaling;
  readonly iceServers: NfxIceServer[];
  readonly onEvent?: (event: NfxPlayerEvent) => void;
  /** Aborting it cancels `open()`, or destroys the session once open. */
  readonly signal?: AbortSignal;
}

/** One video playing in one element. */
export interface NfxLibSession {
  readonly levels: readonly NfxLevel[];
  /** Play `index` from now on, or -1 to let hls.js pick; throws `RangeError` for any other. */
  setLevel(index: number): void;
  /** Stops hls.js, the p2p loader, its signaling sockets and peers. Idempotent. */
  destroy(): void;
}

/** The library: `init` once (the WASM verifier), then `open` per element. */
export interface NfxPlayerLib {
  init(options?: { readonly wasmUrl?: string }): Promise<void>;
  open(el: HTMLVideoElement, options: NfxOpenOptions): Promise<NfxLibSession>;
}
