/**
 * What the page's loopback origin answers. `pear-bridge` is not used: it rewrites every `.js` file
 * through script-linker, which breaks classic scripts and every SRI hash (measured in the real
 * runtime), and it serves the whole app drive. This serves the exact bytes of a fixed list of
 * files.
 *
 * The page's script policy is its `<meta>`, and must not also be a header: the runtime's preload
 * evaluates its boot bundle in the document, and a header policy with no `unsafe-eval` applies from
 * the first instant and stops it (measured: the window then has no `Pear` and no pipe). The
 * `<meta>` takes effect after the preload and before any of the page's own scripts. The header
 * carries what a `<meta>` cannot: `frame-ancestors`.
 *
 * A request must carry the `Host` of this listener (DNS rebinding) and the `X-Pear` header that
 * only the app's own Electron session adds. Pure: `main.ts` owns the socket.
 */

/** The response headers every answer carries. */
export const BASE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

const TYPES: Readonly<Record<string, string>> = Object.freeze({
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  png: 'image/png',
  svg: 'image/svg+xml',
  wasm: 'application/wasm',
  woff2: 'font/woff2',
});

/** The content type of a page file, or `null` for a kind of file the page never serves. */
export function contentType(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  return TYPES[path.slice(dot + 1)] ?? null;
}

export interface PageRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly host: string | undefined;
  readonly xPear: string | undefined;
}

export type PageAnswer =
  | { readonly status: 200; readonly file: string; readonly type: string; readonly head: boolean }
  | { readonly status: 400 | 403 | 404 | 405 };

/**
 * `files` holds page-relative paths (`index.html`, `nfx/player.js`). A query or fragment is
 * ignored; anything that is not exactly a listed path is 404, so `..` and encoded forms match
 * nothing.
 */
export function answerPageRequest(
  r: PageRequest,
  files: ReadonlySet<string>,
  host: string,
): PageAnswer {
  if (r.host !== host) return { status: 403 };
  if (r.xPear?.startsWith('Pear ') !== true) return { status: 403 };
  if (r.method !== 'GET' && r.method !== 'HEAD') return { status: 405 };
  if (r.url?.startsWith('/') !== true) return { status: 400 };
  const path = r.url.split(/[?#]/, 1)[0] ?? '';
  const file = path === '/' ? 'index.html' : path.slice(1);
  if (!files.has(file)) return { status: 404 };
  const type = contentType(file);
  if (type === null) return { status: 404 };
  return { status: 200, file, type, head: r.method === 'HEAD' };
}
