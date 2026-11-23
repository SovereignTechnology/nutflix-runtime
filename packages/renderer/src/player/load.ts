/**
 * Loads the pinned nfx player library, once, from this app's own files (`nfx-web.lock`):
 *
 *   nfx/wasm.js     the WASM verifier as base64. Its sha256 must be the pin's, checked here
 *                   before anything compiles it.
 *   nfx/player.js   the library, byte for byte from the pinned tar. `index.html` preloads it with
 *                   its SRI hash, so the module map holds those bytes or a failure, and the
 *                   `import()` below gets the same entry.
 *
 * Why the WASM travels inside a module: `app:` is deliberately not a fetch-enabled scheme, and the
 * page must check the bytes before compiling them anyway. The library's `init` takes a URL, so it
 * gets a `blob:` URL of the bytes that matched (`connect-src blob:`), revoked at once.
 *
 * Nothing here reaches the network, and a failure at any step is an answer (`null` from the
 * caller's point of view, with the reason): the app then plays over HyperDHT alone.
 */
import type { NfxLibSession, NfxOpenOptions, NfxPlayerLib } from './nfx-lib.js';

export interface LoadedPlayer {
  readonly lib: NfxPlayerLib;
  /** The verifier's bytes, already matched against the pin: what the probe validates. */
  readonly wasm: Uint8Array;
}

export type PlayerLoader = () => Promise<LoadedPlayer>;

export interface PlayerLoaderOptions {
  /** The document's base URL; the library's two files are resolved against it. */
  readonly baseUrl: string;
  /** The sha256 of the pinned WASM, 64 lowercase hex (written into the bundle by the build). */
  readonly wasmSha256: string;
  /** Default: the platform's dynamic `import()`. */
  readonly importModule?: ((url: string) => Promise<unknown>) | undefined;
  /** Default: `crypto.subtle`. */
  readonly sha256?: ((bytes: Uint8Array) => Promise<string>) | undefined;
  readonly createObjectURL?: ((blob: Blob) => string) | undefined;
  readonly revokeObjectURL?: ((url: string) => void) | undefined;
}

async function subtleSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Strict base64 to bytes; throws on anything that is not. */
export function decodeBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new Error('not base64');
  }
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function member(o: unknown, key: string): unknown {
  return typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[key] : undefined;
}

/**
 * The loader: the first call does the work, later calls share it, and a failed load may be tried
 * again. The library's `init` runs here, so a library that loads but cannot start its verifier
 * counts as not loaded.
 */
export function createPlayerLoader(o: PlayerLoaderOptions): PlayerLoader {
  const importModule =
    o.importModule ?? ((url: string): Promise<unknown> => import(/* @vite-ignore */ url));
  const sha256 = o.sha256 ?? subtleSha256;
  const createUrl = o.createObjectURL ?? ((b: Blob): string => URL.createObjectURL(b));
  const revokeUrl =
    o.revokeObjectURL ??
    ((u: string): void => {
      URL.revokeObjectURL(u);
    });

  const load = async (): Promise<LoadedPlayer> => {
    if (!/^[0-9a-f]{64}$/.test(o.wasmSha256)) throw new Error('nfx: no WASM pin in this build');
    const wasmModule = await importModule(new URL('nfx/wasm.js', o.baseUrl).href);
    const text = member(wasmModule, 'default');
    if (typeof text !== 'string') throw new Error('nfx: the verifier module holds no bytes');
    const wasm = decodeBase64(text);
    const got = await sha256(wasm);
    if (got !== o.wasmSha256) throw new Error('nfx: the verifier is not the pinned one');

    const mod = await importModule(new URL('nfx/player.js', o.baseUrl).href);
    const init = member(mod, 'init');
    const open = member(mod, 'open');
    if (typeof init !== 'function' || typeof open !== 'function') {
      throw new Error('nfx: the library has no init or open');
    }
    const url = createUrl(new Blob([new Uint8Array(wasm)], { type: 'application/wasm' }));
    try {
      await (init as NfxPlayerLib['init'])({ wasmUrl: url });
    } finally {
      revokeUrl(url);
    }
    const lib: NfxPlayerLib = {
      // Done above; the session never needs it again.
      init: () => Promise.resolve(),
      open: (el: HTMLVideoElement, options: NfxOpenOptions): Promise<NfxLibSession> =>
        (open as NfxPlayerLib['open'])(el, options),
    };
    return { lib, wasm };
  };

  let held: Promise<LoadedPlayer> | null = null;
  return () => {
    held ??= load().catch((e: unknown) => {
      held = null;
      throw e;
    });
    return held;
  };
}
