/**
 * nutflix-pear's `app-desktop/src/worker/nfx/range-server.ts` (the submodule's pinned commit),
 * its semantics unchanged but for one bound: the link is a plain string here (app-desktop's
 * `LoopbackLink` type stays there), the helpers the origin shares (`parseRange`, `answer`,
 * `write`, `rangeHeader`) are exported, and at most `MAX_RANGE_RESPONSES` responses run at once.
 *
 * The worker's loopback Range server for NFX play sessions (ADR 0020 slice 5d, spike S-E): each
 * session's layout C as one `video/mp4`.
 *
 *   - bound to `127.0.0.1` only, random port; HTTP from the runtime (`WorkerRuntime`);
 *   - `/<path token>/<sid>`: a 128-bit random token per session, checked with the sid; anything
 *     else is 404, and a closed session's link 404s at once (its responses are cut);
 *   - GET and HEAD only, one range (`bytes=a-b`, `bytes=a-`, `bytes=-n`); an unsatisfiable or
 *     malformed one is 416;
 *   - always the WHOLE range asked for (S-E finding 5: Chromium reads a short 206 as the end of
 *     the file), read through `nfx.locate` in pieces of at most `READ_BYTES`, with backpressure;
 *   - a range whose first bytes cannot be had (the session failed without them, or they did not
 *     arrive in time) is 503 before any header; a later piece that cannot be had cuts the
 *     connection, never a short body.
 *
 * In nutflix-pear the link went to the host and main, never to the renderer. Here the renderer
 * plays it in a plain `<video>` (the fallback path, ADR 0001 §4): the token is what keeps other
 * local processes and pages out.
 */
import { nfx } from '@sovit/core';
import type { Logger } from '@sovit/seeder';

import type {
  HttpRequestLike,
  HttpResponseLike,
  HttpServerLike,
  WorkerRuntime,
} from '../runtime.js';

/** A loopback URL the worker serves. */
export type LoopbackLink = string;

export const NFX_PLAY_MIME = 'video/mp4' as const;
const HOST = '127.0.0.1';
/** The most bytes one read of a range holds (a response's memory, whatever its length). */
export const READ_BYTES = 1024 * 1024;
/** How long `close` waits for the server's connections to go. */
const CLOSE_WAIT_MS = 2000;
/**
 * Added here (not in nutflix-pear, whose link only main held): responses served at once across
 * sessions, then 503. Each holds at most `READ_BYTES`; this bounds how many there are.
 */
export const MAX_RANGE_RESPONSES = 64;
const PATH = /^\/([0-9a-f]{32})\/([0-9a-f]{32})$/;

/** What the server reads a session through (`NfxWatchSession`). */
export interface NfxRangeSource {
  readonly layout: nfx.ProgressiveLayout;
  /** One piece's bytes; rejects when they cannot be had. */
  read(piece: nfx.ProgressivePiece): Promise<Uint8Array>;
}

export interface NfxRangeServerOptions {
  readonly createHttpServer: WorkerRuntime['createHttpServer'];
  /** `n` random bytes as hex (libsodium in production). */
  readonly randomHex: (n: number) => string;
  readonly logger: Logger;
}

interface Entry {
  readonly sid: string;
  readonly token: string;
  readonly source: NfxRangeSource;
  /** Responses in flight: cut when the session goes. */
  readonly responses: Set<HttpResponseLike>;
}

/**
 * One `Range` header against a view of `size` bytes (as the S-E e2e's server): the inclusive
 * byte range, `'none'` without a header, `'bad'` for anything unsatisfiable or not one range.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { readonly start: number; readonly end: number } | 'none' | 'bad' {
  if (header === undefined) return 'none';
  const m = /^bytes=(\d{0,16})-(\d{0,16})$/.exec(header.trim());
  if (m === null || (m[1] === '' && m[2] === '')) return 'bad';
  if (m[1] === '') {
    const n = Number(m[2]);
    return n === 0 ? 'bad' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start >= size || end < start ? 'bad' : { start, end };
}

/** The `Range` header as `parseRange` takes it: a repeated header is no single range. */
export function rangeHeader(req: HttpRequestLike): string | undefined {
  return header(req, 'range');
}

function header(req: HttpRequestLike, name: string): string | undefined {
  const v = req.headers[name];
  // A repeated header is no single range.
  return typeof v === 'string' ? v : v === undefined ? undefined : '';
}

export function answer(
  res: HttpResponseLike,
  status: number,
  extra: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, { ...extra, 'content-length': '0' });
  res.end();
}

/** Read fresh after an `await` (an earlier check's narrowing no longer holds). */
function gone(res: HttpResponseLike): boolean {
  return res.destroyed;
}

/** Hand `chunk` over; waits for `drain` when the socket is full. `false`: the client went away. */
export function write(res: HttpResponseLike, chunk: Uint8Array): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false);
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const settle = (ok: boolean): void => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(ok);
    };
    const onDrain = (): void => {
      settle(true);
    };
    const onClose = (): void => {
      settle(false);
    };
    res.on('drain', onDrain);
    res.on('close', onClose);
  });
}

export class NfxRangeServer {
  private readonly o: NfxRangeServerOptions;
  private readonly log: Logger;
  private server: HttpServerLike | null = null;
  private listening: Promise<number> | null = null;
  private portNo = 0;
  private readonly byToken = new Map<string, Entry>();
  private readonly bySid = new Map<string, Entry>();
  /** Responses open now (until their `close`). */
  private active = 0;
  private closing: Promise<void> | null = null;

  constructor(o: NfxRangeServerOptions) {
    this.o = o;
    this.log = o.logger.child({ component: 'nfx-range-server' });
  }

  /** 0 until listening. */
  get port(): number {
    return this.portNo;
  }

  get sessions(): number {
    return this.bySid.size;
  }

  /** Listen on 127.0.0.1 (once); resolves with the port. */
  listen(): Promise<number> {
    if (this.closing !== null) return Promise.reject(new Error('nfx: the range server is closed'));
    this.listening ??= this.start();
    return this.listening;
  }

  private async start(): Promise<number> {
    const server = await this.o.createHttpServer((req, res) => {
      this.onRequest(req, res);
    });
    if (this.closing !== null) throw new Error('nfx: the range server is closed');
    this.server = server;
    return new Promise<number>((resolve, reject) => {
      server.on('error', (err) => {
        // Before `listening`: the listen failed. After it, nothing to settle.
        reject(err);
      });
      server.listen(0, HOST, () => {
        const addr = server.address();
        const port =
          typeof addr === 'object' &&
          addr !== null &&
          'port' in addr &&
          typeof addr.port === 'number'
            ? addr.port
            : 0;
        if (!Number.isSafeInteger(port) || port < 1) {
          reject(new Error('nfx: the range server has no port'));
          return;
        }
        this.portNo = port;
        this.log.info('nfx range server listening', { port });
        resolve(port);
      });
    });
  }

  /** Admit a session; returns the only link that reads it. */
  register(sid: string, source: NfxRangeSource): LoopbackLink {
    if (this.portNo === 0) throw new Error('nfx: the range server is not listening');
    if (this.bySid.has(sid)) throw new Error('invalid-argument: session already registered');
    const e: Entry = { sid, token: this.o.randomHex(16), source, responses: new Set() };
    this.byToken.set(e.token, e);
    this.bySid.set(sid, e);
    return `http://${HOST}:${String(this.portNo)}/${e.token}/${sid}`;
  }

  /** Revoke a session's link and cut its responses in flight (idempotent). */
  unregister(sid: string): void {
    const e = this.bySid.get(sid);
    if (e === undefined) return;
    this.bySid.delete(sid);
    this.byToken.delete(e.token);
    for (const res of e.responses) res.destroy();
    e.responses.clear();
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      for (const sid of [...this.bySid.keys()]) this.unregister(sid);
      // A server still being created is either assigned by then or never listens.
      await this.listening?.catch(() => undefined);
      const server = this.server;
      this.server = null;
      if (server === null) return;
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CLOSE_WAIT_MS);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    })();
    return this.closing;
  }

  private entryFor(url: string | undefined): Entry | undefined {
    const m = PATH.exec(url ?? '');
    if (m === null) return undefined;
    const e = this.byToken.get(m[1] ?? '');
    return e?.sid === m[2] ? e : undefined;
  }

  private onRequest(req: HttpRequestLike, res: HttpResponseLike): void {
    const e = this.entryFor(req.url);
    if (e === undefined) {
      answer(res, 404);
      return;
    }
    if (this.active >= MAX_RANGE_RESPONSES) {
      answer(res, 503, { 'retry-after': '1' });
      return;
    }
    this.active++;
    e.responses.add(res);
    // Once, on whichever comes first: the response's `close`, or `serve` settling.
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      this.active--;
      e.responses.delete(res);
    };
    res.on('close', finish);
    void this.serve(e, req, res)
      .catch((err: unknown) => {
        this.log.debug('nfx: a range response was cut', { error: err });
        res.destroy();
      })
      .finally(finish);
  }

  private async serve(e: Entry, req: HttpRequestLike, res: HttpResponseLike): Promise<void> {
    const method = req.method ?? '';
    if (method !== 'GET' && method !== 'HEAD') {
      answer(res, 405, { allow: 'GET, HEAD' });
      return;
    }
    const { layout } = e.source;
    const size = layout.size;
    const r = parseRange(header(req, 'range'), size);
    if (r === 'bad') {
      answer(res, 416, { 'content-range': `bytes */${String(size)}` });
      return;
    }
    const { start, end } = r === 'none' ? { start: 0, end: size - 1 } : r;
    const status = r === 'none' ? 200 : 206;
    const headers: Record<string, string> = {
      'content-type': NFX_PLAY_MIME,
      'accept-ranges': 'bytes',
      'content-length': String(end - start + 1),
    };
    if (status === 206)
      headers['content-range'] = `bytes ${String(start)}-${String(end)}/${String(size)}`;
    if (method === 'HEAD') {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    const pieces = nfx.locate(layout, start, end - start + 1, READ_BYTES);
    const [head] = pieces;
    if (head === undefined) throw new Error('nfx: an empty range');
    let first: Uint8Array;
    try {
      first = await e.source.read(head);
    } catch {
      if (!gone(res)) answer(res, 503);
      return;
    }
    if (gone(res)) return;
    res.writeHead(status, headers);
    if (!(await write(res, first))) return;
    for (let i = 1; i < pieces.length; i++) {
      const piece = pieces[i];
      if (piece === undefined || gone(res)) return;
      // A failure here throws: the connection is cut (`onRequest`), never a short body.
      if (!(await write(res, await e.source.read(piece)))) return;
    }
    res.end();
  }
}
