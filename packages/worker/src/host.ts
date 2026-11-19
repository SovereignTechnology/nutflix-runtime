/**
 * The worker itself, runtime-neutral (Bare in production through `./main.ts`, Node in tests):
 * what `init` builds and what every request reaches (`./rpc.ts` validated it first).
 *
 * `init` (once) builds, under `storage`:
 *   - `keys/`: a Corestore, used only for its primary key: the NFX-12 key pairs
 *     `nfx:<namespace>:seeder` and `nfx:<namespace>:watcher` (`./keys.ts`);
 *   - `nfx/`: `@sovit/seeder`'s `NfxStore` (every file sha256-checked, NFX-05 §4), with the
 *     disk cap `init` names;
 *   - `tmp/`: wiped, then the play spools (`tmp/nfx-play/<sid>/`);
 * and one HyperDHT node (`./net/dht-node.ts`) with the bootstrap `init` names, one peer pool
 * (one connection per seeder and network, shared by play sessions and seed fetches), the play
 * sessions with their two loopback servers (`./nfx/watching.ts`) and the seeds with one NFX-12
 * listener per network (`./nfx/seeds.ts`), whose stored videos are served again at once.
 *
 * `close` takes it down in order: sessions and servers, seeds and listeners, the pool, the DHT
 * node, the keys.
 */
import type { Logger } from '@sovit/seeder';
import { DiskCap, NfxStore } from '@sovit/seeder';

import { randomHex, sodiumCrypto } from './crypto.js';
import { fail } from './errors.js';
import type { Keyring } from './keys.js';
import { openCorestoreKeyring } from './keys.js';
import { createWorkerLogger } from './log.js';
import { DhtNode } from './net/dht-node.js';
import { NfxPeerPool } from './nfx/hyperdht-fetcher.js';
import { NfxSeeds } from './nfx/seeds.js';
import { NFX_PLAY_DIR, NfxWatching, watcherKeyName } from './nfx/watching.js';
import type {
  ArgsOf,
  InitArgs,
  ResultOf,
  WorkerEvent,
  WorkerMethod,
  WorkerStatus,
} from './protocol.js';
import { PROTOCOL_V } from './protocol.js';
import type { WorkerRpcHandler } from './rpc.js';
import type { WorkerRuntime } from './runtime.js';

export const KEYS_DIR = 'keys';
export const TMP_DIR = 'tmp';

export interface WorkerHostOptions {
  readonly runtime: WorkerRuntime;
  /** Events to the host (`./rpc.ts` `emit`). */
  readonly emit: (ev: WorkerEvent) => void;
  /** The key store under `dir`; default: a Corestore (`./keys.ts`). */
  readonly openKeyring?: (dir: string) => Promise<Keyring>;
  /** TESTS ONLY: shorter bounds. */
  readonly bootstrapWaitMs?: number;
  readonly dialTimeoutMs?: number;
  readonly readWaitMs?: number;
  readonly originWaitMs?: number;
}

/** What `init` built. */
interface Running {
  readonly logger: Logger;
  readonly keys: Keyring;
  readonly store: NfxStore;
  readonly dht: DhtNode;
  readonly pool: NfxPeerPool;
  readonly watching: NfxWatching;
  readonly seeds: NfxSeeds;
}

type Call = { [M in WorkerMethod]: { readonly m: M; readonly a: ArgsOf<M> } }[WorkerMethod];

export class WorkerHost implements WorkerRpcHandler {
  private readonly o: WorkerHostOptions;
  private running: Running | null = null;
  private initing = false;
  private closing: Promise<void> | null = null;
  private lastStatus = '';

  constructor(o: WorkerHostOptions) {
    this.o = o;
  }

  /** What `init` built (tests read the store and the DHT node through it). */
  get internals(): Readonly<Running> | null {
    return this.running;
  }

  handle<M extends WorkerMethod>(m: M, a: ArgsOf<M>): Promise<ResultOf<M>> {
    // `M` and its arguments arrive together (`isRequest` checked them as one): the union says so.
    return this.dispatch({ m, a } as unknown as Call) as Promise<ResultOf<M>>;
  }

  private async dispatch(c: Call): Promise<ResultOf<WorkerMethod>> {
    if (this.closing !== null) fail('backend-down', 'worker is shutting down');
    if (c.m === 'init') return this.init(c.a);
    const r = this.running;
    if (r === null) fail('not-ready', 'init has not answered');
    switch (c.m) {
      case 'status':
        return this.status();
      case 'nfx.play.open':
        return r.watching.open(c.a);
      case 'nfx.play.close':
        await r.watching.close(c.a.sid);
        return null;
      case 'nfx.seed.start':
        return r.seeds.start(c.a);
      case 'nfx.seed.stop':
        return r.seeds.stop(c.a.video);
      case 'nfx.seed.list':
        return r.seeds.list();
      case 'nfx.endpoint':
        return { hyperdht: await r.seeds.endpoint(c.a.seeder, c.a.namespace) };
    }
  }

  private async init(a: InitArgs): Promise<ResultOf<'init'>> {
    if (this.running !== null || this.initing) fail('invalid-argument', 'already initialised');
    this.initing = true;
    try {
      this.running = await this.build(a);
    } finally {
      this.initing = false;
    }
    this.emitStatus();
    return { v: PROTOCOL_V };
  }

  private async build(a: InitArgs): Promise<Running> {
    const { fs, rmTree } = this.o.runtime;
    const logger = createWorkerLogger({
      emit: (ev) => {
        this.o.emit(ev);
      },
      level: a.logLevel ?? 'info',
    });
    // `storage` is absolute, two levels deep at least and free of `.`/`..` (`isAbsolutePath`):
    // this wipe stays inside it.
    const tmp = fs.join(a.storage, TMP_DIR);
    await rmTree(tmp);
    const spoolDir = fs.join(tmp, NFX_PLAY_DIR);
    await fs.mkdir(spoolDir, { recursive: true });

    const keys = await (this.o.openKeyring ?? openCorestoreKeyring)(fs.join(a.storage, KEYS_DIR));
    try {
      return await this.wire(a, logger, keys, spoolDir);
    } catch (err) {
      await keys.close().catch(() => undefined);
      throw err;
    }
  }

  private async wire(
    a: InitArgs,
    logger: Logger,
    keys: Keyring,
    spoolDir: string,
  ): Promise<Running> {
    const { fs, rmTree } = this.o.runtime;
    const store = new NfxStore({ fs, crypto: sodiumCrypto, dataDir: a.storage });
    await store.load();
    if (store.loadError !== null) logger.error('nfx: the store did not load; seeding is off');
    if (a.diskCapBytes !== undefined)
      store.attachCap(new DiskCap(a.diskCapBytes, store.totalBytes()));

    const dht = new DhtNode({
      bootstrap: a.bootstrap ?? null,
      logger,
      ...(this.o.bootstrapWaitMs === undefined ? {} : { bootstrapWaitMs: this.o.bootstrapWaitMs }),
    });
    dht.start();
    void dht.ready().then(
      () => {
        this.emitStatus();
      },
      () => undefined,
    );
    const pool = new NfxPeerPool({
      dht: () => dht.ready(),
      keyPair: (namespace) => keys.keyPair(watcherKeyName(namespace)),
      crypto: sodiumCrypto,
      logger,
      ...(this.o.dialTimeoutMs === undefined ? {} : { dialTimeoutMs: this.o.dialTimeoutMs }),
    });
    const onChange = (): void => {
      this.emitStatus();
    };
    const watching = new NfxWatching({
      pool,
      store,
      fs,
      rmTree,
      spoolDir,
      crypto: sodiumCrypto,
      createHttpServer: this.o.runtime.createHttpServer,
      randomHex,
      logger,
      onChange,
      ...(this.o.readWaitMs === undefined ? {} : { readWaitMs: this.o.readWaitMs }),
      ...(this.o.originWaitMs === undefined ? {} : { originWaitMs: this.o.originWaitMs }),
    });
    const seeds = new NfxSeeds({
      store,
      pool,
      dht: () => dht.dht,
      keyPair: (name) => keys.keyPair(name),
      logger,
      emit: (ev) => {
        this.o.emit(ev);
      },
      onChange,
    });
    await seeds.resume();
    return { logger, keys, store, dht, pool, watching, seeds };
  }

  status(): WorkerStatus {
    const r = this.running;
    return {
      dht: r?.dht.state ?? (this.closing === null ? 'starting' : 'closed'),
      playSessions: r?.watching.size ?? 0,
      storedVideos: r?.store.videos().length ?? 0,
      listening: r?.seeds.listening() ?? [],
    };
  }

  /** A `status` event, when something in it changed since the last one. */
  private emitStatus(): void {
    if (this.running === null) return;
    const status = this.status();
    const key = JSON.stringify(status);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.o.emit({ op: 'ev', e: 'status', status });
  }

  /** Take everything down, in order. Never throws; idempotent. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      const r = this.running;
      if (r === null) return;
      const step = async (what: string, f: () => Promise<unknown>): Promise<void> => {
        try {
          await f();
        } catch (err) {
          r.logger.warn(`worker close: ${what} did not close cleanly`, { error: err });
        }
      };
      await step('the play sessions', () => r.watching.shutdown());
      await step('the seeds', () => r.seeds.close());
      r.pool.close();
      await step('the DHT node', () => r.dht.destroy());
      await step('the keys', () => r.keys.close());
    })();
    return this.closing;
  }
}
