/**
 * The worker's loopback NFX origin (ADR 0001 §4): an NFX-05 §6 origin for one play session's
 * video, so nfx's web player (hls.js + p2p-media-loader + nfx_wasm) in the renderer plays bytes
 * this worker fetched over HyperDHT. The renderer passes the session's base as
 * `origins: ['http://127.0.0.1:<port>/<token>']` (the library's `pageOrigin()` accepts http for
 * an origin the page chose).
 *
 * What it serves, under the base `/<token>` (128 random bits per session, the only key to it):
 *
 *   GET|HEAD <base>/<root>                        the hash list (NFX-05 §6)
 *   GET|HEAD <base>/<root>/master.m3u8            the master playlist
 *   GET|HEAD <base>/<root>/<sha256>.<ext>         a file that hash list names: what the player
 *                                                 asks for, playlist URIs being relative (§3)
 *   GET|HEAD <base>/<sha256>[.<ext>]              the same files by hash alone (§6's first form)
 *   OPTIONS  any of those                         a CORS preflight answer
 *
 * and nothing else: every other path, a path with a query (§6.1), uppercase hex, a hash the
 * verified hash list does not name, another session's root, or a token not registered is 404.
 * Paths are matched as raw bytes against one pattern of lowercase hex and a short alphanumeric
 * extension; nothing is percent-decoded or joined, so no path can leave the session's files.
 *
 * - Pull-through (§6.2): a file is served only after its bytes verified against its sha256 —
 *   by the NFX-12 client as it fetched them (NFX-05 §4), or by this node's store when it wrote
 *   them — and the hash list against the manifest `root`. Never an unverified byte.
 * - One range per request (p2p-media-loader resumes a segment with `Range: bytes=n-`), always
 *   the whole range asked for; 416 for anything else. Bodies are read in pieces of at most
 *   `READ_BYTES`, with backpressure; a piece that cannot be read cuts the connection.
 * - Caching (§6.1): `public, max-age=31536000, immutable` on a file, `no-store` on every error.
 *   CORS: `Access-Control-Allow-Origin: *` on every answer (the browser mesh depends on it).
 * - Bounds: `MAX_RESPONSES` responses at once across sessions (then 503), a file that has not
 *   arrived within `waitMs` is 503 (the pull-through goes on, so a retry finds it), and a
 *   session's pull-throughs are bounded by its source (`NfxOriginFiles`).
 * - Bound to `127.0.0.1` only, random port. A closed session's base 404s at once and its
 *   responses in flight are cut.
 */
import { nfx } from '@sovit/core';
import type { Logger, NfxStoreFile, SeederFs } from '@sovit/seeder';

import type {
  HttpRequestLike,
  HttpResponseLike,
  HttpServerLike,
  WorkerRuntime,
} from '../runtime.js';
import type { LoopbackLink } from './range-server.js';
import { READ_BYTES, answer, parseRange, rangeHeader, write } from './range-server.js';
import type { NfxFetcher } from './watch.js';
import { MAX_NFX_PLAY_FILE_BYTES, NfxFetchError } from './watch.js';

const HOST = '127.0.0.1';
/** How long `close` waits for the server's connections to go. */
const CLOSE_WAIT_MS = 2000;
/** How long a request waits for a file that is still being fetched. */
export const ORIGIN_WAIT_MS = 30_000;
/** Responses served at once, across every session. */
export const MAX_RESPONSES = 64;
/** Pull-throughs one session runs at once (as `NFX_FETCH_CONCURRENCY`). */
export const MAX_PULLS = 4;

/** `/<token>/<hash>[.<ext>][/(master.m3u8 | <hash>.<ext>)]`, nothing else. */
const PATH =
  /^\/([0-9a-f]{32})\/([0-9a-f]{64})(\.[0-9A-Za-z]{1,8})?(?:\/(master\.m3u8|[0-9a-f]{64}\.[0-9A-Za-z]{1,8}))?$/;

const IMMUTABLE = 'public, max-age=31536000, immutable';
const CORS: Readonly<Record<string, string>> = { 'access-control-allow-origin': '*' };
const ERROR_HEADERS: Readonly<Record<string, string>> = { ...CORS, 'cache-control': 'no-store' };

/** `Content-Type` per role (§6); the hash list is JSON. */
const MIME: Readonly<Record<nfx.Role | 'hash-list', string>> = {
  'hash-list': 'application/json',
  'playlist-master': 'application/vnd.apple.mpegurl',
  playlist: 'application/vnd.apple.mpegurl',
  init: 'video/mp4',
  segment: 'video/iso.segment',
  thumb: 'application/octet-stream',
  subtitle: 'text/vtt',
};

/** A verified file, read in ranges. */
export interface OriginFile {
  readonly size: number;
  /** Exactly `length` bytes at `offset`; rejects otherwise. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** What the origin serves for one session. */
export interface NfxOriginSource {
  /** The manifest `root`: sha256 of the verified hash list. */
  readonly root: string;
  /** The role of a file the hash list names (`hash-list` for `root`), else `undefined`. */
  role(sha: string): nfx.Role | 'hash-list' | undefined;
  /** The sha256 of the master playlist, if the hash list names one. */
  readonly master: string | undefined;
  /** The verified file (a listed one); rejects when it cannot be had now. */
  file(sha: string): Promise<OriginFile>;
}

export interface NfxOriginServerOptions {
  readonly createHttpServer: WorkerRuntime['createHttpServer'];
  /** `n` random bytes as hex (libsodium in production). */
  readonly randomHex: (n: number) => string;
  readonly logger: Logger;
  /** Tests: `ORIGIN_WAIT_MS`. */
  readonly waitMs?: number;
}

interface Entry {
  readonly sid: string;
  readonly token: string;
  readonly source: NfxOriginSource;
  readonly responses: Set<HttpResponseLike>;
}

/** What a request names, once its path matched. */
interface Target {
  readonly entry: Entry;
  readonly sha: string;
  readonly role: nfx.Role | 'hash-list';
}

export class NfxOriginServer {
  private readonly o: NfxOriginServerOptions;
  private readonly log: Logger;
  private server: HttpServerLike | null = null;
  private listening: Promise<number> | null = null;
  private portNo = 0;
  private readonly byToken = new Map<string, Entry>();
  private readonly bySid = new Map<string, Entry>();
  private active = 0;
  private closing: Promise<void> | null = null;

  constructor(o: NfxOriginServerOptions) {
    this.o = o;
    this.log = o.logger.child({ component: 'nfx-origin' });
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
    if (this.closing !== null) return Promise.reject(new Error('nfx: the origin is closed'));
    this.listening ??= this.start();
    return this.listening;
  }

  private async start(): Promise<number> {
    const server = await this.o.createHttpServer((req, res) => {
      this.onRequest(req, res);
    });
    if (this.closing !== null) throw new Error('nfx: the origin is closed');
    this.server = server;
    return new Promise<number>((resolve, reject) => {
      server.on('error', (err) => {
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
          reject(new Error('nfx: the origin has no port'));
          return;
        }
        this.portNo = port;
        this.log.info('nfx origin listening', { port });
        resolve(port);
      });
    });
  }

  /** Admit a session; returns its base, the only URL prefix that reaches it. */
  register(sid: string, source: NfxOriginSource): LoopbackLink {
    if (this.portNo === 0) throw new Error('nfx: the origin is not listening');
    if (this.bySid.has(sid)) throw new Error('invalid-argument: session already registered');
    const e: Entry = { sid, token: this.o.randomHex(16), source, responses: new Set() };
    this.byToken.set(e.token, e);
    this.bySid.set(sid, e);
    return `http://${HOST}:${String(this.portNo)}/${e.token}`;
  }

  /** Revoke a session's base and cut its responses in flight (idempotent). */
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

  /** The session file a request target names, or `undefined` (404). */
  private target(url: string | undefined): Target | undefined {
    const m = PATH.exec(url ?? '');
    if (m === null) return undefined;
    const entry = this.byToken.get(m[1] ?? '');
    if (entry === undefined) return undefined;
    const first = m[2] ?? '';
    const ext = m[3];
    const rest = m[4];
    const { source } = entry;
    let sha: string | undefined;
    if (rest === undefined) {
      sha = first;
    } else {
      // Under `<base>/<root>/` only, and `<root>` bare.
      if (ext !== undefined || first !== source.root) return undefined;
      sha = rest === 'master.m3u8' ? source.master : rest.slice(0, 64);
    }
    if (sha === undefined) return undefined;
    const role = source.role(sha);
    return role === undefined ? undefined : { entry, sha, role };
  }

  private onRequest(req: HttpRequestLike, res: HttpResponseLike): void {
    const t = this.target(req.url);
    if (t === undefined) {
      answer(res, 404, ERROR_HEADERS);
      return;
    }
    const method = req.method ?? '';
    if (method === 'OPTIONS') {
      // A preflight (`Range` is not CORS-safelisted everywhere): GET and HEAD, with a range.
      res.writeHead(204, {
        ...CORS,
        'access-control-allow-methods': 'GET, HEAD',
        'access-control-allow-headers': 'range',
        'access-control-max-age': '600',
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      answer(res, 405, { ...ERROR_HEADERS, allow: 'GET, HEAD, OPTIONS' });
      return;
    }
    if (this.active >= MAX_RESPONSES) {
      answer(res, 503, { ...ERROR_HEADERS, 'retry-after': '1' });
      return;
    }
    this.active++;
    t.entry.responses.add(res);
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      this.active--;
      t.entry.responses.delete(res);
    };
    res.on('close', finish);
    void this.serve(t, method, req, res)
      .catch((err: unknown) => {
        this.log.debug('nfx: an origin response was cut', { error: err });
        res.destroy();
      })
      .finally(finish);
  }

  private async serve(
    t: Target,
    method: string,
    req: HttpRequestLike,
    res: HttpResponseLike,
  ): Promise<void> {
    let file: OriginFile;
    try {
      file = await within(t.entry.source.file(t.sha), this.o.waitMs ?? ORIGIN_WAIT_MS);
    } catch {
      if (!res.destroyed) answer(res, 503, { ...ERROR_HEADERS, 'retry-after': '2' });
      return;
    }
    if (res.destroyed) return;
    const size = file.size;
    const r = size === 0 ? 'none' : parseRange(rangeHeader(req), size);
    if (r === 'bad') {
      answer(res, 416, { ...ERROR_HEADERS, 'content-range': `bytes */${String(size)}` });
      return;
    }
    const { start, end } = r === 'none' ? { start: 0, end: size - 1 } : r;
    const status = r === 'none' ? 200 : 206;
    const headers: Record<string, string> = {
      ...CORS,
      'access-control-expose-headers': 'content-length, content-range, accept-ranges',
      'content-type': MIME[t.role],
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      'cache-control': IMMUTABLE,
      'x-content-type-options': 'nosniff',
    };
    if (status === 206)
      headers['content-range'] = `bytes ${String(start)}-${String(end)}/${String(size)}`;
    res.writeHead(status, headers);
    if (method === 'HEAD' || end < start) {
      res.end();
      return;
    }
    for (let at = start; at <= end; at += READ_BYTES) {
      if (res.destroyed) return;
      // A failure here throws: the connection is cut (`onRequest`), never a short body.
      const piece = await file.read(at, Math.min(READ_BYTES, end - at + 1));
      if (!(await write(res, piece))) return;
    }
    res.end();
  }
}

/** `p`, or a rejection after `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('nfx: the file did not arrive in time'));
      }, ms);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}

// ------------------------------------------------------------------ one session's files

export interface NfxOriginFilesOptions {
  readonly video: nfx.VideoAddr;
  readonly root: string;
  /** The hash list, verified against `root` (`nfx.verifyHashList`), and its bytes. */
  readonly list: nfx.HashList;
  readonly listBytes: Uint8Array;
  /** This node's store when it holds this video with this `root`: served in place. */
  readonly store: { file(video: nfx.VideoAddr, sha: string): NfxStoreFile | undefined } | null;
  /** Where files the store lacks come from (sha256-checked by the transport). */
  readonly fetcher: NfxFetcher;
  readonly fs: SeederFs;
  /** This source's spool directory (created on the first write). */
  readonly dir: string;
  readonly logger: Logger;
  /** Tests: `MAX_PULLS`. */
  readonly maxPulls?: number;
}

/**
 * One session's files for the origin (§6.2's pull-through, scoped to one verified hash list):
 * the hash list from memory, a stored video's files from the store, and every other listed file
 * fetched once on first request, spooled (`<sha>.part`, then renamed, so a reader never sees a
 * partial file) and served from the spool. A failed fetch is forgotten, so a retry fetches again.
 */
export class NfxOriginFiles implements NfxOriginSource {
  readonly root: string;
  readonly master: string | undefined;
  private readonly o: NfxOriginFilesOptions;
  private readonly roles = new Map<string, nfx.Role | 'hash-list'>();
  private readonly sizes = new Map<string, number>();
  private readonly ready = new Map<string, Promise<OriginFile>>();
  private dirReady: Promise<void> | null = null;
  private pulls = 0;
  private closed = false;

  constructor(o: NfxOriginFilesOptions) {
    this.o = o;
    this.root = o.root;
    this.roles.set(o.root, 'hash-list');
    this.sizes.set(o.root, o.listBytes.byteLength);
    let master: string | undefined;
    for (const f of o.list.files) {
      // One size per hash, as the store refuses otherwise; a file past the play cap is not served.
      if (this.roles.has(f.sha256) || f.size > BigInt(MAX_NFX_PLAY_FILE_BYTES)) continue;
      this.roles.set(f.sha256, f.role);
      this.sizes.set(f.sha256, Number(f.size));
      if (f.role === 'playlist-master') master ??= f.sha256;
    }
    this.master = master;
  }

  role(sha: string): nfx.Role | 'hash-list' | undefined {
    return this.roles.get(sha);
  }

  file(sha: string): Promise<OriginFile> {
    if (this.closed) return Promise.reject(new Error('nfx: the session closed'));
    const size = this.sizes.get(sha);
    if (size === undefined) return Promise.reject(new Error('nfx: not a file of this video'));
    if (sha === this.root) return Promise.resolve(memoryFile(this.o.listBytes));
    const stored = this.o.store?.file(this.o.video, sha);
    if (stored?.size === size) return Promise.resolve(stored);
    let p = this.ready.get(sha);
    if (p === undefined) {
      if (this.pulls >= (this.o.maxPulls ?? MAX_PULLS))
        return Promise.reject(new Error('nfx: too many files being fetched'));
      const pulled = this.pull(sha, size);
      p = pulled;
      this.ready.set(sha, pulled);
      // Forgotten when it fails: the next request asks again.
      void pulled.catch(() => {
        if (this.ready.get(sha) === pulled) this.ready.delete(sha);
      });
    }
    return p;
  }

  /** Stop: later requests are refused, and spool writes in flight land first. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.ready.values()]);
  }

  private async pull(sha: string, size: number): Promise<OriginFile> {
    this.pulls++;
    try {
      let bytes: Uint8Array;
      try {
        bytes = await this.o.fetcher.fetch(sha, size, true);
      } catch (err) {
        const why = err instanceof NfxFetchError ? err.reasons.join(', ') : 'error';
        this.o.logger.debug('nfx: the origin could not fetch a file', { reason: why });
        throw new Error('nfx: no source served the file');
      }
      if (bytes.byteLength !== size) throw new Error('nfx: a file of another size');
      if (this.isClosed()) throw new Error('nfx: the session closed');
      const fs = this.o.fs;
      this.dirReady ??= fs.mkdir(this.o.dir, { recursive: true });
      await this.dirReady;
      const path = fs.join(this.o.dir, sha);
      const part = `${path}.part`;
      await fs.writeFile(part, bytes);
      await fs.rename(part, path);
      return spoolFile(fs, path, size);
    } finally {
      this.pulls--;
    }
  }

  /** Read fresh after an `await`. */
  private isClosed(): boolean {
    return this.closed;
  }
}

function memoryFile(bytes: Uint8Array): OriginFile {
  return {
    size: bytes.byteLength,
    read: (offset, length) => {
      if (offset < 0 || length < 0 || offset + length > bytes.byteLength)
        return Promise.reject(new RangeError('nfx: read outside the file'));
      return Promise.resolve(bytes.subarray(offset, offset + length));
    },
  };
}

function spoolFile(fs: SeederFs, path: string, size: number): OriginFile {
  return {
    size,
    read: async (offset, length) => {
      if (offset < 0 || length < 0 || offset + length > size)
        throw new RangeError('nfx: read outside the file');
      const bytes =
        fs.readRange === undefined
          ? (await fs.readFile(path)).subarray(offset, offset + length)
          : await fs.readRange(path, offset, length);
      if (bytes.byteLength !== length) throw new Error('nfx: a short read from the spool');
      return bytes;
    },
  };
}
