/**
 * `nfx.seed.*`: which NFX videos this node stores and seeds over NFX-12. New here; nutflix-pear's
 * worker stores what its Studio packages and what its host imports, while this one also stores a
 * video by fetching it from the seeders that beacon it (ADR 0001 §3: "seed what it plays").
 *
 *   - The store is `@sovit/seeder`'s `NfxStore` as it is (NFX-05 §4): the hash list is verified
 *     against the manifest `root` before anything else, and every file's size and sha256 against
 *     its entry before it is written. Files come over NFX-12 through the worker's one peer pool,
 *     and the NFX-12 client checks them first (so a seeder that serves bad bytes is dropped).
 *   - Every stored video is seeded. Each network (namespace) with a stored video has its own
 *     listener (`./seeding.ts`, key pair `nfx:<namespace>:seeder`), which serves only that
 *     network's videos: a video of one network never names the key of another.
 *   - A file larger than `MAX_NFX_PLAY_FILE_BYTES` is refused before it is fetched (a fetch is
 *     held in memory until the store writes it); the store's disk cap bounds the rest.
 *   - `stop` removes the video from the store (a start of it still running is abandoned first);
 *     a network with no video left stops listening.
 */
import { nfx } from '@sovit/core';
import type {
  HyperdhtEndpoint,
  Logger,
  NfxDht,
  NfxFileSource,
  NfxStore,
  NfxVideoRecord,
  PeerKeyPair,
} from '@sovit/seeder';
import { fromHex } from '@sovit/seeder';

import { fail, toWireError } from '../errors.js';
import type {
  NfxListenerWire,
  NfxSeedListResult,
  NfxSeedStartArgs,
  NfxStoredVideoWire,
  WorkerEvent,
} from '../protocol.js';
import { MAX_NFX_STORED_VIDEOS } from '../protocol.js';
import type { NfxPeerPool } from './hyperdht-fetcher.js';
import { HyperdhtFetcher } from './hyperdht-fetcher.js';
import { NfxSeeding } from './seeding.js';
import { MAX_NFX_PLAY_FILE_BYTES, NfxFetchError } from './watch.js';

export type SeedEvent = Extract<WorkerEvent, { readonly e: 'nfx.seed' }>;

/** Videos fetched to seed at once (as `MAX_NFX_SESSIONS` bounds play sessions). */
export const MAX_SEED_STARTS = 4;

export interface NfxSeedsDeps {
  readonly store: NfxStore;
  /** The worker's one pool (also the play sessions'). */
  readonly pool: NfxPeerPool;
  /** The DHT node to listen on, or `null` while there is none. */
  readonly dht: () => NfxDht | null;
  /** A key pair derived by name (`../keys.ts`). */
  readonly keyPair: (name: string) => Promise<PeerKeyPair>;
  readonly logger: Logger;
  readonly emit: (ev: SeedEvent) => void;
  /** What is stored or served changed. */
  readonly onChange?: () => void;
}

interface Starting {
  readonly root: string;
  readonly fetcher: HyperdhtFetcher;
  readonly done: Promise<NfxStoredVideoWire>;
}

function wire(r: NfxVideoRecord): NfxStoredVideoWire {
  let bytes = 0;
  for (const f of r.files) bytes += f.size;
  return { video: r.video, root: r.root, segs: Number(r.segs), files: r.files.length, bytes };
}

const namespaceOf = (video: string): string => video.slice(0, video.lastIndexOf(':'));

export class NfxSeeds {
  private readonly d: NfxSeedsDeps;
  private readonly listeners = new Map<string, NfxSeeding>();
  private readonly starting = new Map<string, Starting>();
  private closing = false;

  constructor(d: NfxSeedsDeps) {
    this.d = d;
  }

  /** At start: listen on every network the store holds a video of. */
  async resume(): Promise<void> {
    await Promise.all([...this.storedNamespaces()].map((ns) => this.listener(ns).set(true)));
    this.d.onChange?.();
  }

  /** `nfx.seed.start`. Throws `<code>: …` errors. */
  async start(a: NfxSeedStartArgs): Promise<NfxStoredVideoWire> {
    if (this.closing) fail('backend-down', 'worker is shutting down');
    const video = this.parse(a.video);
    const known = this.d.store.get(video);
    if (known !== undefined) {
      if (known.root !== a.root) fail('exists', 'the video is stored with another hash list');
      await this.listener(video.namespace.toString()).set(true);
      this.d.onChange?.();
      return wire(known);
    }
    const running = this.starting.get(a.video);
    if (running !== undefined) {
      if (running.root !== a.root) fail('exists', 'another hash list of it is being stored');
      return running.done;
    }
    if (a.peers.length === 0) fail('no-seeders', 'the video is not stored and no seeder was named');
    // Each start holds a hash list (up to 16 MiB) and one file at a time in memory.
    if (this.starting.size >= MAX_SEED_STARTS)
      fail('rate-limited', 'too many videos are being fetched to seed');
    if (this.d.store.videos().length >= MAX_NFX_STORED_VIDEOS)
      fail('disk-cap', 'the store holds as many videos as it lists');
    const fetcher = new HyperdhtFetcher({
      pool: this.d.pool,
      video,
      peers: a.peers.map((p) => fromHex(p.peer)),
      logger: this.d.logger,
    });
    const done = this.fetchAndStore(video, a, fetcher);
    const entry: Starting = { root: a.root, fetcher, done };
    this.starting.set(a.video, entry);
    try {
      return await done;
    } catch (err) {
      this.d.emit({
        op: 'ev',
        e: 'nfx.seed',
        video: a.video,
        state: 'failed',
        error: toWireError(err),
      });
      throw err;
    } finally {
      if (this.starting.get(a.video) === entry) this.starting.delete(a.video);
      await fetcher.close();
    }
  }

  /** `nfx.seed.stop`: abandon a start of it, remove it, and stop listening on an empty network. */
  async stop(text: string): Promise<{ readonly removed: boolean }> {
    const video = this.parse(text);
    const running = this.starting.get(text);
    if (running !== undefined) {
      await running.fetcher.close();
      await running.done.catch(() => undefined);
    }
    const removed = await this.d.store.removeVideo(video);
    const ns = video.namespace.toString();
    if (!this.storedNamespaces().has(ns)) await this.listeners.get(ns)?.set(false);
    if (removed) this.d.emit({ op: 'ev', e: 'nfx.seed', video: text, state: 'stopped' });
    this.d.onChange?.();
    return { removed };
  }

  /** `nfx.seed.list`. */
  list(): NfxSeedListResult {
    return {
      videos: this.d.store
        .videos()
        .slice(0, MAX_NFX_STORED_VIDEOS)
        .map((r) => wire(r)),
      listening: this.listening(),
    };
  }

  /** The listeners up. */
  listening(): NfxListenerWire[] {
    const out: NfxListenerWire[] = [];
    for (const [namespace, l] of this.listeners)
      if (l.serving) out.push({ namespace, connections: l.connections });
    return out;
  }

  /** `nfx.endpoint`: while `namespace`'s listener is up. */
  async endpoint(seeder: string, namespace: string): Promise<HyperdhtEndpoint | null> {
    return (await this.listeners.get(namespace)?.endpoint(seeder)) ?? null;
  }

  /** Stop for good: starts abandoned, every listener closed. Never throws. */
  async close(): Promise<void> {
    this.closing = true;
    const starts = [...this.starting.values()];
    await Promise.all(starts.map((s) => s.fetcher.close()));
    await Promise.allSettled(starts.map((s) => s.done));
    await Promise.all([...this.listeners.values()].map((l) => l.close().catch(() => undefined)));
  }

  private parse(text: string): nfx.VideoAddr {
    const v = nfx.VideoAddr.parse(text);
    if (!v.ok || v.value.toString() !== text) fail('invalid-argument', 'not an NFX video address');
    return v.value;
  }

  private storedNamespaces(): Set<string> {
    return new Set(this.d.store.videos().map((r) => namespaceOf(r.video)));
  }

  /** `namespace`'s listener (created off), serving only that network's stored videos. */
  private listener(namespace: string): NfxSeeding {
    let l = this.listeners.get(namespace);
    if (l === undefined) {
      const store = this.d.store;
      const mine = (v: nfx.VideoAddr): boolean => v.namespace.toString() === namespace;
      const source: NfxFileSource = {
        hasVideo: (v) => mine(v) && store.hasVideo(v),
        file: (v, sha) => (mine(v) ? store.file(v, sha) : undefined),
      };
      l = new NfxSeeding(
        { dht: this.d.dht, keyPair: this.d.keyPair, source, logger: this.d.logger },
        namespace,
      );
      this.listeners.set(namespace, l);
    }
    return l;
  }

  private async fetchAndStore(
    video: nfx.VideoAddr,
    a: NfxSeedStartArgs,
    fetcher: HyperdhtFetcher,
  ): Promise<NfxStoredVideoWire> {
    // Why a read the store asked for failed (it reports only `io`).
    const why: { fetch: NfxFetchError | null; tooLarge: boolean } = {
      fetch: null,
      tooLarge: false,
    };
    const get = async (sha: string, size: number, exact: boolean): Promise<Uint8Array> => {
      try {
        return await fetcher.fetch(sha, size, exact);
      } catch (err) {
        why.fetch ??= err instanceof NfxFetchError ? err : new NfxFetchError(['error']);
        throw err;
      }
    };
    let listBytes: Uint8Array;
    try {
      listBytes = await get(a.root, nfx.MAX_HASH_LIST_BYTES, false);
    } catch {
      fail('no-seeders', `no seeder served the hash list (${reasons(why.fetch)})`);
    }
    // Verified here to count the files; the store verifies it again before it keeps anything.
    const verified = nfx.verifyHashList(listBytes, a.root, video, BigInt(a.segs));
    if (!verified.ok)
      fail('invalid-argument', 'the hash list does not verify against its manifest');
    const total = verified.value.files.length;
    let done = 0;
    const progress = (): void => {
      this.d.emit({ op: 'ev', e: 'nfx.seed', video: a.video, state: 'fetching', done, total });
    };
    progress();
    const r = await this.d.store.putVideo({
      video,
      root: a.root,
      segs: BigInt(a.segs),
      hashListBytes: listBytes,
      read: async (entry) => {
        if (entry.size > BigInt(MAX_NFX_PLAY_FILE_BYTES)) {
          why.tooLarge = true;
          throw new Error('nfx: a file past the cap');
        }
        const bytes = await get(entry.sha256, Number(entry.size), true);
        done++;
        progress();
        return bytes;
      },
    });
    if (!r.ok) {
      if (r.error === 'invalid')
        fail('invalid-argument', 'the hash list does not verify against its manifest');
      if (r.error === 'exists') fail('exists', 'the video is stored with another hash list');
      if (r.error === 'disk-cap') fail('disk-cap', 'storing the video would exceed the disk cap');
      if (why.tooLarge) fail('unsupported-input', 'a file of this video is too large to seed');
      if (why.fetch !== null) fail('no-seeders', `no seeder served a file (${reasons(why.fetch)})`);
      fail('io', r.error === 'unavailable' ? 'the NFX store did not load' : r.message);
    }
    await this.listener(video.namespace.toString()).set(true);
    this.d.emit({
      op: 'ev',
      e: 'nfx.seed',
      video: a.video,
      state: 'seeding',
      done: total,
      total,
    });
    this.d.onChange?.();
    return wire(r.record);
  }
}

function reasons(e: NfxFetchError | null): string {
  return e === null || e.reasons.length === 0 ? 'none left to ask' : e.reasons.join(', ');
}
