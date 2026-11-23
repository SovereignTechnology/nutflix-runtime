/**
 * `app://nutflix/…` serves the renderer's static files and nothing else. After nutflix-pear's
 * `app-desktop/src/main/app-protocol.ts` (the submodule's pinned commit), with the CSP handed in
 * (`csp.ts`) instead of imported.
 *
 * Only `GET`/`HEAD`, only host `nutflix`, only the files the renderer build writes (`APP_FILES`),
 * only `.html`/`.js`/`.css`. The path guard refuses dot segments, hidden files, empty segments,
 * backslashes, NUL and ENCODED separators or dots (`%2f`, `%5c`, `%2e`, `%00`) before decoding,
 * and the resolved real path must still be inside the root (a symlink planted in the renderer's
 * directory cannot lead out of it). Every response carries the policy header. Electron-free:
 * `main.ts` passes `node:fs/promises` in, the tests pass fakes.
 */
import { extname, join, sep } from 'node:path';

import { appResponseHeaders } from './csp.ts';
import { APP_HOST, APP_SCHEME } from './schemes.ts';

/** What `packages/renderer/scripts/build.ts` writes, and all that `app:` will serve. */
export const APP_FILES = [
  'index.html',
  'app.js',
  'ui.css',
  'shell.css',
  'nfx/player.js',
  'nfx/wasm.js',
] as const;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export interface AppProtocolDeps {
  /** Absolute directory of the renderer bundle. */
  readonly root: string;
  /** The `Content-Security-Policy` header value (`headerPolicy`). */
  readonly csp: string;
  /** Relative file names that may be served; default `APP_FILES`. */
  readonly files?: readonly string[];
  readFile(path: string): Promise<Uint8Array>;
  realpath(path: string): Promise<string>;
}

/** The relative file an `app:` URL names, or `null` when the URL is refused. Pure. */
export function resolveAppPath(url: string): string | null {
  // The raw path, before URL parsing normalises anything: refuse encoded separators and dots
  // outright (Chromium and WHATWG treat `%2e%2e` as `..`; a later decode must never create one).
  const rawPath = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/.exec(url)?.[1] ?? '';
  if (/%(?:2f|5c|2e|00)/i.test(rawPath) || rawPath.includes('\\')) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== APP_HOST || u.username !== '') return null;
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (path === '/' || path === '') path = '/index.html';
  if (!path.startsWith('/') || path.includes('\\') || path.includes('\u0000')) return null;
  const segments = path.slice(1).split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..' || s.startsWith('.')) return null;
    // eslint-disable-next-line no-control-regex -- refusing control characters is the point
    if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  }
  const rel = segments.join('/');
  if (!(extname(rel) in CONTENT_TYPES)) return null;
  return rel;
}

/** The `protocol.handle('app', …)` handler. Never throws: failures are 4xx/5xx responses. */
export function createAppProtocolHandler(
  deps: AppProtocolDeps,
): (req: Request) => Promise<Response> {
  const allowed = new Set(deps.files ?? APP_FILES);
  const headers = appResponseHeaders(deps.csp);
  const plain = (status: number, extra: Readonly<Record<string, string>> = {}): Response =>
    new Response(null, { status, headers: { ...headers, ...extra } });
  let realRoot: Promise<string> | undefined;
  return async (req) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return plain(405, { allow: 'GET, HEAD' });
      const rel = resolveAppPath(req.url);
      if (rel === null || !allowed.has(rel)) return plain(404);
      realRoot ??= deps.realpath(deps.root);
      const root = await realRoot;
      let real: string;
      try {
        real = await deps.realpath(join(root, ...rel.split('/')));
      } catch {
        return plain(404);
      }
      if (!real.startsWith(root + sep)) return plain(404);
      const body = await deps.readFile(real);
      const type = CONTENT_TYPES[extname(rel)] ?? 'application/octet-stream';
      return new Response(req.method === 'HEAD' ? null : new Uint8Array(body), {
        status: 200,
        headers: {
          ...headers,
          'content-type': type,
          'content-length': String(body.byteLength),
        },
      });
    } catch {
      realRoot = undefined;
      return plain(500);
    }
  };
}
