/**
 * The worker's NFX play sessions, adapted from nutflix-pear's `app-desktop/src/worker/nfx/
 * watching.ts` (the submodule's pinned commit): `nfx.play.open` / `nfx.play.close`, one session
 * each, sharing one `NfxPeerPool` (a connection per seeder, `./hyperdht-fetcher.ts`), one
 * `NfxRangeServer` and one `NfxOriginServer`.
 *
 * What changed from nutflix-pear's:
 *   - its iroh (NFX-06) and Rust-helper WebRTC fetchers are gone (ADR 0001: WebRTC lives in the
 *     renderer); a session's sources are this node's own store, when it holds the video with
 *     that `root` (`./store-fetcher.ts`), then the beaconed HyperDHT seeders;
 *   - the DHT node, the pool and the watcher key pairs are the worker's (`../host.ts`). The
 *     watcher pair is random, one per network and run, and never stored (`../keys.ts`
 *     `WatcherKeys`). nutflix-pear derived an `nfx:<namespace>:watcher` pair from its Corestore
 *     whenever it had a seeder, which gave every run the same key: a seeder could link one
 *     viewer's plays across days;
 *   - a session serves an NFX-05 §6 origin (`./origin.ts`) beside the progressive stream, either
 *     one on request: the hash list is fetched and verified here once, for both;
 *   - `renditions` is an order of preference (the web player's option of that name).
 *
 * Each session spools under `<spoolDir>/<sid>/` (`p/` the progressive stream, `o/` the origin),
 * deleted by `close`; the host wipes `<storage>/tmp` at every start.
 */
import { nfx } from '@sovit/core';
import type { Logger, NfxStoreFile, SeederCrypto, SeederFs } from '@sovit/seeder';
import { fromHex } from '@sovit/seeder';

import { WorkerError, fail } from '../errors.js';
import type { NfxPlayOpenArgs, NfxPlayOpenResult, NfxRenditionWire } from '../protocol.js';
import type { WorkerRuntime } from '../runtime.js';
import { NfxFallbackFetcher } from './fallback-fetcher.js';
import type { NfxPeerPool } from './hyperdht-fetcher.js';
import { HyperdhtFetcher } from './hyperdht-fetcher.js';
import type { SessionListing } from './offers.js';
import { NfxOriginFiles, NfxOriginServer } from './origin.js';
import { NfxRangeServer } from './range-server.js';
import { StoreFetcher } from './store-fetcher.js';
import type { NfxFetcher } from './watch.js';
import { NfxFetchError, NfxWatchSession, shown, wireRenditions } from './watch.js';

/** NFX play sessions open at once per worker. */
export const MAX_NFX_SESSIONS = 4;
/** Under `<storage>/tmp` (wiped at every worker start): each session spools in `<sid>/`. */
export const NFX_PLAY_DIR = 'nfx-play';
/** A progressive stream's read-ahead when the host names none, seconds. */
export const DEFAULT_PREFETCH_SECONDS = 30;

/** The part of `NfxStore` a session reads: a video it holds, and that video's files. */
export interface NfxLocalStore {
  get(video: nfx.VideoAddr): { readonly root: string } | undefined;
  file(video: nfx.VideoAddr, sha: string): NfxStoreFile | undefined;
}

export interface NfxWatchingDeps {
  /** The worker's one pool (also `nfx.seed.start`'s): one connection per seeder and network. */
  readonly pool: NfxPeerPool;
  readonly store: NfxLocalStore;
  readonly fs: SeederFs;
  /** Remove a directory and everything in it; a missing one is fine. */
  readonly rmTree: (path: string) => Promise<void>;
  /** `<storage>/tmp/nfx-play`. */
  readonly spoolDir: string;
  readonly crypto: SeederCrypto;
  readonly createHttpServer: WorkerRuntime['createHttpServer'];
  readonly randomHex: (n: number) => string;
  readonly logger: Logger;
  /** The number of sessions changed. */
  readonly onChange?: () => void;
  /** TESTS ONLY: shorter bounds (a progressive read's wait, an origin request's). */
  readonly readWaitMs?: number;
  readonly originWaitMs?: number;
}

interface PlaySession {
  readonly sid: string;
  /** Every source of the session; closed last. */
  readonly fetcher: NfxFetcher;
  progressive: NfxWatchSession | null;
  origin: NfxOriginFiles | null;
  /** The verified hash list's files, once `start` has it (`./offers.ts` reads it). */
  files: ReadonlyMap<string, nfx.FileEntry> | null;
  readonly video: string;
  readonly root: string;
  closed: boolean;
}

export class NfxWatching {
  private readonly d: NfxWatchingDeps;
  private readonly sessions = new Map<string, PlaySession>();
  private rangeServerNow: NfxRangeServer | null = null;
  private originServerNow: NfxOriginServer | null = null;
  private closing: Promise<void> | null = null;

  constructor(d: NfxWatchingDeps) {
    this.d = d;
  }

  /** Whether `sid` names a session here (open or opening). */
  has(sid: string): boolean {
    return this.sessions.has(sid);
  }

  get size(): number {
    return this.sessions.size;
  }

  /** What an open session's verified hash list says, for a file offered from WebRTC. */
  listing(sid: string): SessionListing | null {
    const s = this.sessions.get(sid);
    if (s?.files === null || s === undefined || s.closed) return null;
    const files = s.files;
    let bytes = 0;
    for (const f of files.values()) bytes += Number(f.size);
    return { video: s.video, root: s.root, bytes, entry: (sha) => files.get(sha) };
  }

  /** `nfx.play.open`. Throws `<code>: …` errors; a session that fails to open leaves nothing. */
  async open(a: NfxPlayOpenArgs): Promise<NfxPlayOpenResult> {
    if (this.closing !== null) fail('backend-down', 'worker is shutting down');
    if (this.sessions.has(a.sid)) fail('invalid-argument', 'duplicate session id');
    if (this.sessions.size >= MAX_NFX_SESSIONS)
      fail('rate-limited', 'too many open NFX play sessions');
    const parsed = nfx.VideoAddr.parse(a.video);
    if (!parsed.ok || parsed.value.toString() !== a.video)
      fail('invalid-argument', 'not an NFX video address');
    const video = parsed.value;
    const peers: Uint8Array[] = [];
    const seen = new Set<string>();
    for (const p of a.peers) {
      if (seen.has(p.peer)) continue;
      seen.add(p.peer);
      peers.push(fromHex(p.peer));
    }
    // This node's own copy first: it needs no network, and its files are checked as they are read.
    const fetchers: NfxFetcher[] = [];
    if (this.d.store.get(video)?.root === a.root)
      fetchers.push(new StoreFetcher({ files: this.d.store, video, crypto: this.d.crypto }));
    if (peers.length > 0)
      fetchers.push(
        new HyperdhtFetcher({ pool: this.d.pool, video, peers, logger: this.d.logger }),
      );
    const [only] = fetchers;
    if (only === undefined)
      fail('no-seeders', 'no seeder was named, and this node does not store the video');
    const session: PlaySession = {
      sid: a.sid,
      fetcher: fetchers.length === 1 ? only : new NfxFallbackFetcher(fetchers),
      progressive: null,
      origin: null,
      files: null,
      video: a.video,
      root: a.root,
      closed: false,
    };
    // Claimed before any await: a second open of the sid is refused, a close finds it.
    this.sessions.set(a.sid, session);
    this.d.onChange?.();
    try {
      return await this.start(session, video, a);
    } catch (err) {
      // A close that came first made the fetches fail: the session closed is the reason.
      const closedFirst = session.closed;
      if (this.sessions.get(a.sid) === session) {
        this.sessions.delete(a.sid);
        this.d.onChange?.();
      }
      await this.teardown(session);
      if (closedFirst && !(err instanceof WorkerError && err.code === 'session-closed'))
        fail('session-closed', 'the play session closed');
      throw err;
    }
  }

  private async start(
    s: PlaySession,
    video: nfx.VideoAddr,
    a: NfxPlayOpenArgs,
  ): Promise<NfxPlayOpenResult> {
    const alive = (): void => {
      if (s.closed) fail('session-closed', 'the play session closed');
    };
    // The hash list, verified against the manifest once, for both ways of serving it.
    let listBytes: Uint8Array;
    try {
      listBytes = await s.fetcher.fetch(a.root, nfx.MAX_HASH_LIST_BYTES, false);
    } catch (err) {
      alive();
      const why = err instanceof NfxFetchError ? ` (${err.reasons.join(', ')})` : '';
      fail('no-seeders', `no seeder served the hash list${why}`);
    }
    alive();
    const verified = nfx.verifyHashList(listBytes, a.root, video, BigInt(a.segs));
    if (!verified.ok) {
      this.d.logger.warn('nfx: a hash list did not verify', { reason: verified.error.reason });
      fail('invalid-argument', 'the hash list does not verify against its manifest');
    }
    const list = verified.value;
    s.files = new Map(list.files.map((f) => [f.sha256, f]));

    // nutflix-pear #97: only renditions someone holds, the most-held first (the bandwidth breaks
    // ties), as `NfxWatchSession.open` chooses; then the host's order of preference, if any.
    const all = wireRenditions(list.renditions);
    const held =
      a.held === undefined
        ? undefined
        : { seeders: a.held.seeders, all: a.held.all, named: new Map(a.held.named) };
    const preferred = held === undefined ? all : nfx.preferRenditions(all, held);
    const playable = held === undefined ? all : all.filter((r) => preferred.includes(r));
    const asked = a.renditions;
    const chosen: NfxRenditionWire | undefined =
      asked === undefined
        ? preferred[0]
        : asked.map((id) => playable.find((r) => r.id === id)).find((r) => r !== undefined);
    if (chosen === undefined)
      fail(
        'not-found',
        asked !== undefined
          ? 'no rendition asked for is listed and held'
          : held === undefined
            ? 'no playable rendition'
            : 'nobody online holds a rendition of this video',
      );

    if (a.origin !== false)
      s.origin = new NfxOriginFiles({
        video,
        root: a.root,
        list,
        listBytes,
        store: this.d.store.get(video)?.root === a.root ? this.d.store : null,
        fetcher: s.fetcher,
        fs: this.d.fs,
        dir: this.d.fs.join(this.d.spoolDir, s.sid, 'o'),
        logger: this.d.logger,
      });

    if (a.progressive !== false) {
      const fetcher = s.fetcher;
      const watch = new NfxWatchSession({
        video,
        root: a.root,
        segs: a.segs,
        rendition: chosen.id,
        ...(held === undefined ? {} : { held }),
        prefetchSeconds: a.prefetchSeconds ?? DEFAULT_PREFETCH_SECONDS,
        // The hash list it asks for first is the one verified above; the session's sources are
        // closed by `teardown`, after it.
        fetcher: {
          fetch: (sha, size, exact) =>
            sha === a.root ? Promise.resolve(listBytes) : fetcher.fetch(sha, size, exact),
          close: () => Promise.resolve(),
        },
        fs: this.d.fs,
        rmTree: this.d.rmTree,
        dir: this.d.fs.join(this.d.spoolDir, s.sid, 'p'),
        logger: this.d.logger,
        ...(this.d.readWaitMs === undefined ? {} : { waitMs: this.d.readWaitMs }),
      });
      s.progressive = watch;
      try {
        await watch.open();
      } catch (err) {
        // Not one progressive file: with the origin asked for too, the web player can still play.
        if (a.origin === false || !(err instanceof WorkerError) || err.code !== 'unsupported-input')
          throw err;
        this.d.logger.info('nfx: no progressive stream for this rendition', {
          reason: err.message,
        });
        s.progressive = null;
        await watch.close();
      }
    }

    const range = s.progressive === null ? null : this.rangeServer();
    const origin = s.origin === null ? null : this.originServer();
    await Promise.all([range?.listen(), origin?.listen()]);
    alive();
    const progressiveUrl =
      range === null || s.progressive === null ? null : range.register(s.sid, s.progressive);
    const originUrl =
      origin === null || s.origin === null ? null : origin.register(s.sid, s.origin);
    this.d.logger.info('nfx play session opened', {
      rendition: chosen.id,
      progressive: progressiveUrl !== null,
      origin: originUrl !== null,
    });
    return {
      progressiveUrl,
      originUrl,
      rendition: chosen.id,
      renditions: shown(playable, chosen),
    };
  }

  /** `nfx.play.close`: its links 404, its fetches stop, its spool goes. Idempotent. */
  async close(sid: string): Promise<void> {
    const session = this.sessions.get(sid);
    if (session === undefined) return;
    this.sessions.delete(sid);
    this.d.onChange?.();
    await this.teardown(session);
  }

  /** Worker shutdown: every session, both servers. Never throws. */
  shutdown(): Promise<void> {
    this.closing ??= (async () => {
      await Promise.all([...this.sessions.keys()].map((sid) => this.close(sid)));
      await this.rangeServerNow?.close().catch(() => undefined);
      await this.originServerNow?.close().catch(() => undefined);
    })();
    return this.closing;
  }

  /** Links revoked, sources closed (fetches in flight end), then the readers, then the spool. */
  private async teardown(s: PlaySession): Promise<void> {
    if (s.closed) return;
    s.closed = true;
    this.rangeServerNow?.unregister(s.sid);
    this.originServerNow?.unregister(s.sid);
    await s.fetcher.close().catch(() => undefined);
    await s.origin?.close().catch(() => undefined);
    await s.progressive?.close().catch(() => undefined);
    try {
      await this.d.rmTree(this.d.fs.join(this.d.spoolDir, s.sid));
    } catch (err) {
      this.d.logger.warn('nfx: a play spool could not be deleted', { error: err });
    }
  }

  private rangeServer(): NfxRangeServer {
    this.rangeServerNow ??= new NfxRangeServer({
      createHttpServer: this.d.createHttpServer,
      randomHex: this.d.randomHex,
      logger: this.d.logger,
    });
    return this.rangeServerNow;
  }

  private originServer(): NfxOriginServer {
    this.originServerNow ??= new NfxOriginServer({
      createHttpServer: this.d.createHttpServer,
      randomHex: this.d.randomHex,
      logger: this.d.logger,
      ...(this.d.originWaitMs === undefined ? {} : { waitMs: this.d.originWaitMs }),
    });
    return this.originServerNow;
  }
}
