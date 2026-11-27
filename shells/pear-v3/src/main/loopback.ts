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
 * And `https:` to a private host is cancelled too: an IP literal that is not public (loopback,
 * private, CGNAT and so a tailnet, link-local, unique-local, IPv4-mapped forms of those, …), or
 * a name that is always local (`localhost`, `*.localhost`, which Chromium maps to loopback
 * itself, and `*.local`, mDNS), by the renderer's own rules (`publicIpLiteral`,
 * `isAlwaysLocalName`, `packages/renderer/src/net/hosts.ts`). The page checks every host a
 * beacon or a profile names (`isPublicHost`), but nfx's web player follows redirects, so an
 * origin a beacon names could send its `GET`s to such a host. Redirect targets reach this same
 * listener: in Electron 45.2.1 a followed redirect restarts the request through
 * `onBeforeRequest` with the new URL (`shell/browser/net/proxying_url_loader_factory.cc`,
 * `FollowRedirect` → `RestartInternal`). The cost: a relay on a LAN or tailnet IP literal, or on
 * a `.local` name, gets no NIP-11 document, so search to it is matched in the page. Any OTHER
 * name that resolves to a private address is not caught: only the URL is seen here, not where it
 * resolves.
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
import { isAlwaysLocalName, publicIpLiteral } from '../../../../packages/renderer/src/net/hosts.ts';
import type { Fields } from './log.ts';

const LOOPBACK = '127.0.0.1';

/**
 * The schemes cancelled toward a private host (`isPrivateHost`). `wss:` is left out (the
 * maintainer's call, 2026-11-26): a WebSocket handshake follows no redirect, so it is not the
 * redirect path `https:` is, and only the viewer's own Settings choose `wss` hosts (the read,
 * scoped and signaling relays): no remote data opens a WebSocket here (no relay hint, NIP-65
 * list, beacon tracker or STUN endpoint is followed). A relay the viewer put on a LAN or tailnet
 * address keeps working. Adding `'wss:'` here refuses those too.
 */
export const PRIVATE_HOST_SCHEMES: ReadonlySet<string> = new Set(['https:']);

/**
 * A host (as `URL.hostname` gives it) no remote origin may send this window to: an IP literal
 * that is not public, or a name that is always local.
 */
export function isPrivateHost(hostname: string): boolean {
  return publicIpLiteral(hostname) === false || isAlwaysLocalName(hostname);
}

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
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly port: number | null;
      /** Set when it was refused for its host (`isPrivateHost`), not as plain HTTP. */
      readonly scheme?: 'https' | 'wss';
    };

/** The port a URL names, or its scheme's default. */
function portOf(u: URL, fallback: number): number | null {
  const n = Number(u.port === '' ? String(fallback) : u.port);
  return Number.isInteger(n) ? n : null;
}

/**
 * Whether a request of the main window's session may go on. Plain HTTP only to `127.0.0.1`,
 * without user-info, on a port the worker serves now. `https:` (`PRIVATE_HOST_SCHEMES`) not to a
 * private host (`isPrivateHost`). Anything else may (the page's policy bounds those). A URL that
 * does not parse is refused.
 */
export function allowRequest(url: string, ports: Pick<WorkerPorts, 'has'>): RequestVerdict {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { allow: false, port: null };
  }
  if (u.protocol !== 'http:') {
    if (PRIVATE_HOST_SCHEMES.has(u.protocol) && isPrivateHost(u.hostname))
      return {
        allow: false,
        port: portOf(u, 443),
        scheme: u.protocol === 'wss:' ? 'wss' : 'https',
      };
    return { allow: true };
  }
  const port = workerPort(url);
  if (port !== null && ports.has(port)) return { allow: true };
  return { allow: false, port: portOf(u, 80) };
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
 * Cancels every request in `ses` that `allowRequest` refuses: plain HTTP off the worker's ports,
 * and `https:` to a private host, redirect targets included. With no URL filter: every
 * request of the session reaches the listener. `log` hears the first `REFUSALS_LOGGED` refusals,
 * by port (and scheme) only, never the URL, which the page or a remote host chose. Electron keeps
 * ONE `onBeforeRequest` listener per session: another call on the same session, anywhere, would
 * replace this guard.
 * `observe` sees every request's URL before the decision and changes nothing: only a test root's
 * playback proof passes one (`play-proof.ts` counts what leaves loopback).
 */
export function installLoopbackGuard(
  ses: GuardedSession,
  ports: Pick<WorkerPorts, 'has'>,
  log: (name: string, fields?: Fields) => void,
  observe?: (url: string) => void,
): void {
  let logged = 0;
  ses.webRequest.onBeforeRequest((details, callback) => {
    try {
      observe?.(details.url);
    } catch {
      // An observer's failure never decides a request.
    }
    const v = allowRequest(details.url, ports);
    if (v.allow) {
      callback({});
      return;
    }
    if (logged < REFUSALS_LOGGED) {
      logged += 1;
      if (v.scheme === undefined) log('http-refused', { port: v.port ?? -1 });
      else log('private-refused', { scheme: v.scheme, port: v.port ?? -1 });
    }
    callback({ cancel: true });
  });
}
