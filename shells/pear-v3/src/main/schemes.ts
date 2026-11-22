/**
 * The one privileged scheme and the app origin. After nutflix-pear's `app-desktop/src/main/
 * schemes.ts` (the submodule's pinned commit), without its second scheme: media comes straight
 * from the worker's loopback server (the renderer's policy allows `http://127.0.0.1:*` only), so
 * main proxies nothing. `registerSchemesAsPrivileged` must run before `app.ready`. The scheme is
 * standard (a real origin, so the policy's `'self'` means these files), secure (a secure context)
 * and streams. It does not bypass the CSP, enable CORS or the fetch API, or allow service workers.
 */
import type { CustomScheme } from 'electron';

export const APP_SCHEME = 'app';
export const APP_HOST = 'nutflix';
export const APP_ORIGIN = 'app://nutflix';
export const APP_URL = 'app://nutflix/index.html';

export function privilegedSchemes(): CustomScheme[] {
  return [{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, stream: true } }];
}

/** True for a URL whose origin is exactly `app://nutflix`. Never throws. */
export function isAppUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length > 4096) return false;
  try {
    const u = new URL(url);
    return u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST && u.username === '';
  } catch {
    return false;
  }
}

/** True for exactly the app origin string (permission checks hand over origins). */
export function isAppOrigin(origin: unknown): boolean {
  return origin === APP_ORIGIN;
}
