/**
 * The page's plain HTTP reaches the worker and nothing else. The renderer's policy allows
 * `http://127.0.0.1:*` (`media-src`, `connect-src`), because the worker's two loopback servers take
 * a random port each: its progressive range server (`progressiveUrl`) and its NFX origin
 * (`originUrl`), both from `nfx.play.open`. That policy alone would let a compromised page send
 * requests to any HTTP service on the user's machine. So main narrows it:
 *
 *   - `WorkerPorts` is the live set of the worker's ports. The gate hands it every URL the worker
 *     answers a window's `nfx.play.open` with, BEFORE the window sees the answer (`rpc-gate.ts`),
 *     and empties it when the worker is gone: a port a dead worker held may be anyone's now. A
 *     worker started again adds its own new ports;
 *   - `installLoopbackGuard` cancels, in the main window's session, every `http:` request that is
 *     not to `127.0.0.1` on one of those ports. The policy stays the outer bound; this is inside it.
 *
 * Not narrowed: `ws://127.0.0.1:*`. Local Nostr relays use it, and the page owns the relay list,
 * so a port list there would not hold. One cost: the NIP-11 document of a `ws://127.0.0.1` relay
 * is fetched over `http://` from the relay's port, and is now refused, so search to such a relay
 * is matched in the page, as for a relay that does not list NIP-50.
 *
 * The listener is installed with NO URL filter, so it sees every request of the session and the
 * decision, port included, is made here (`allowRequest`), not by Electron's match patterns.
 * Electron-free: structural types only, so the tests drive it with fakes.
 */
import type { Fields } from './log.ts';

const LOOPBACK = '127.0.0.1';

/** The port of a worker URL the gate saw (`http://127.0.0.1:<port>/…`), or `null`. */
export function workerPort(url: unknown): number | null {
  if (typeof url !== 'string' || url.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' || u.hostname !== LOOPBACK || u.username !== '' || u.password !== '')
    return null;
  // `URL` leaves the port empty for the scheme's default (80): the worker never takes that one.
  if (!/^\d{1,5}$/.test(u.port)) return null;
  const port = Number(u.port);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** What the gate tells the guard: `RpcGateDeps.loopback` has this shape. */
export interface LoopbackSink {
  /** A URL the worker answered a window's `nfx.play.open` with. */
  served(url: unknown): void;
  /** The worker is gone. */
  reset(): void;
}

export class WorkerPorts implements LoopbackSink {
  readonly #ports = new Set<number>();

  served(url: unknown): void {
    const port = workerPort(url);
    if (port !== null) this.#ports.add(port);
  }

  reset(): void {
    this.#ports.clear();
  }

  has(port: number): boolean {
    return this.#ports.has(port);
  }

  get size(): number {
    return this.#ports.size;
  }
}

export type RequestVerdict =
  { readonly allow: true } | { readonly allow: false; readonly port: number | null };

/**
 * Whether a request of the main window's session may go on. Anything but plain HTTP may (the page's
 * policy bounds those). Plain HTTP only to `127.0.0.1`, without user-info, on a port the worker
 * serves now. A URL that does not parse is refused.
 */
export function allowRequest(url: string, ports: Pick<WorkerPorts, 'has'>): RequestVerdict {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { allow: false, port: null };
  }
  if (u.protocol !== 'http:') return { allow: true };
  const port = workerPort(url);
  if (port !== null && ports.has(port)) return { allow: true };
  const n = Number(u.port === '' ? '80' : u.port);
  return { allow: false, port: Number.isInteger(n) ? n : null };
}

/** The `session` member `installLoopbackGuard` uses (Electron's `session.webRequest`). */
export interface GuardedSession {
  readonly webRequest: {
    onBeforeRequest(
      listener: (
        details: { readonly url: string },
        callback: (response: { readonly cancel?: boolean }) => void,
      ) => void,
    ): void;
  };
}

/** At most this many refusals are logged in a run: a page cannot flood the log. */
export const REFUSALS_LOGGED = 20;

/**
 * Cancels every plain-HTTP request in `ses` that `allowRequest` refuses. With no URL filter: every
 * request of the session reaches the listener. `log` hears the first `REFUSALS_LOGGED` refusals,
 * by port only (never the URL, which the page chose). Electron keeps ONE `onBeforeRequest`
 * listener per session: another call on the same session, anywhere, would replace this guard.
 */
export function installLoopbackGuard(
  ses: GuardedSession,
  ports: Pick<WorkerPorts, 'has'>,
  log: (name: string, fields?: Fields) => void,
): void {
  let logged = 0;
  ses.webRequest.onBeforeRequest((details, callback) => {
    const v = allowRequest(details.url, ports);
    if (v.allow) {
      callback({});
      return;
    }
    if (logged < REFUSALS_LOGGED) {
      logged += 1;
      log('http-refused', { port: v.port ?? -1 });
    }
    callback({ cancel: true });
  });
}
