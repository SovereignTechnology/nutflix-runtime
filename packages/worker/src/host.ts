/**
 * The worker itself, runtime-neutral (Bare in production through `./main.ts`, Node in tests):
 * what `init` builds and what every request reaches (`./rpc.ts` validated it first).
 *
 * `init` (once) builds, under `storage`:
 *   - `keys/`: a Corestore, used only for its primary key: the seeders' NFX-12 key pairs
 *     `nfx:<namespace>:seeder`, the same every run because beacons name them (`./keys.ts`);
 *   - `nfx/`: `@sovit/seeder`'s `NfxStore` (every file sha256-checked, NFX-05 §4), with the
 *     disk cap `init` names;
 *   - `tmp/`: wiped, then the play spools (`tmp/nfx-play/<sid>/`);
 * and one HyperDHT node (`./net/dht-node.ts`) with the bootstrap `init` names, one peer pool
 * (one connection per seeder and network, shared by play sessions and seed fetches) that dials with
 * a random watcher key pair per network, made for this run and never stored (`./keys.ts`
 * `WatcherKeys`), the play
 * sessions with their two loopback servers (`./nfx/watching.ts`) and the seeds with one NFX-12
 * listener per network (`./nfx/seeds.ts`), whose stored videos are served again at once.
 *
 * On top of the data plane, for the renderer's Settings (ADR 0001 §7 and §8):
 *   - `signer/`: the user's signer, a sealed key in this process or a NIP-46 session;
 *   - `seeding.json`: what may be served and why (`./nfx/seed-policy.ts`), off until the user says;
 *   - the seeder's beacon key, and files handed over from WebRTC (`./nfx/offers.ts`);
 *   - Studio (`./studio/studio.ts`), when the runtime can run the system's ffmpeg.
 *
 * `close` takes it down in order: Studio, sessions and servers, seeds and listeners, the pool, the
 * DHT node, the watcher keys, the signer, the keys.
 */
import type { signer as coreSigner } from '@sovit/core';
import { nfx } from '@sovit/core';
import { npubEncode } from 'nostr-tools/nip19';
import type { Logger, NfxDht } from '@sovit/seeder';
import type DHT from 'hyperdht';
import { DiskCap, NfxStore } from '@sovit/seeder';

import { randomHex, sodiumCrypto, sodiumSha256 } from './crypto.js';
import { fail } from './errors.js';
import type { Keyring } from './keys.js';
import { WatcherKeys, openCorestoreKeyring } from './keys.js';
import { createWorkerLogger } from './log.js';
import { DhtNode } from './net/dht-node.js';
import {
  boundHost,
  hidesLocalAddresses,
  isLoopbackTestnet,
  localAddressesByBind,
} from './net/no-local-addresses.js';
import { signBeacons, type BeaconTarget } from './nfx/beacons.js';
import { NfxPeerPool } from './nfx/hyperdht-fetcher.js';
import { OFFERED_DIR, SegmentOffers } from './nfx/offers.js';
import { SeedPolicy, seedingStatusOf, titleField } from './nfx/seed-policy.js';
import { SeederKeys } from './nfx/seeder-key.js';
import { NfxSeeds } from './nfx/seeds.js';
import { NFX_PLAY_DIR, NfxWatching } from './nfx/watching.js';
import type {
  ArgsOf,
  InitArgs,
  ResultOf,
  SeedingStatusWire,
  SeedingWatchArgs,
  SignCheckWire,
  SignedEventWire,
  UnsignedEventWire,
  WorkerEvent,
  WorkerMethod,
  WorkerStatus,
} from './protocol.js';
import {
  MAX_NFX_STORED_VIDEOS,
  MAX_WATCHED_BYTES,
  MAX_WATCH_BYTES_PER_HOUR,
  MAX_WATCH_STARTS_PER_HOUR,
  PROTOCOL_V,
} from './protocol.js';
import type { WorkerRpcHandler } from './rpc.js';
import type { WorkerRuntime } from './runtime.js';
import { checkManifestDraft, checkSignedManifest } from './signer/manifest-check.js';
import { SIGNER_DIR, UserSigner } from './signer/user-signer.js';
import { STUDIO_DISK_COPIES, STUDIO_NAMESPACE, Studio } from './studio/studio.js';

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
  /**
   * TESTS ONLY: `true` hides local addresses (`./net/no-local-addresses.ts`) even on a node bound to
   * 127.0.0.1, which keeps hyperdht's defaults otherwise. It only ever forces hiding on: `false`
   * is the same as leaving it out, never "share them".
   */
  readonly hideLocalAddresses?: true;
  /** TESTS ONLY: the local signer's KDF cost, a bunker's wait, x264's preset. */
  readonly signerCost?: coreSigner.KdfCost;
  readonly bunkerWaitMs?: number;
  readonly studioPreset?: string;
  readonly maxWatchedBytes?: number;
  readonly maxWatchBytesPerHour?: number;
  readonly sourceTtlSec?: number;
}

/** What `init` built. */
interface Running {
  readonly logger: Logger;
  readonly keys: Keyring;
  readonly store: NfxStore;
  readonly dht: DhtNode;
  /** Whether a dial now would hide local addresses (always, but on a socket bound to 127.0.0.1). */
  readonly hidesLocalAddresses: () => boolean;
  /** This run's random watcher key pairs, one per network: in memory only. */
  readonly watcherKeys: WatcherKeys;
  readonly pool: NfxPeerPool;
  readonly watching: NfxWatching;
  readonly seeds: NfxSeeds;
  readonly policy: SeedPolicy;
  readonly offers: SegmentOffers;
  readonly seederKeys: SeederKeys;
  /** `null`: this runtime has no `system` (a test of the data plane alone). */
  readonly signer: UserSigner | null;
  readonly studio: Studio | null;
  /** What "seed what you watch" has started lately, and holds in flight. */
  /** `InitArgs.watchOnly`: nothing is served and nothing is fetched to seed. */
  readonly watchOnly: boolean;
  readonly watchBudget: {
    starts: number[];
    reserved: number;
    /** What was fetched in the last hour: deleting a video does not give this back. */
    fetched: { readonly at: number; readonly bytes: number }[];
    /** Videos being fetched for it now, abandoned when the switch goes off. */
    readonly active: Set<string>;
  };
}

const needs = <T>(x: T | null): T => {
  if (x === null) fail('unsupported-input', 'this runtime has no signer or Studio');
  return x;
};

type Call = { [M in WorkerMethod]: { readonly m: M; readonly a: ArgsOf<M> } }[WorkerMethod];

/** What a watch-only worker refuses: fetching to seed, and turning seeding on. */
const SEED_METHODS: ReadonlySet<WorkerMethod> = new Set([
  'nfx.seed.start',
  'seeding.watch',
  'seeding.resume',
]);

function seedsAnything(c: Call): boolean {
  if (c.m === 'seeding.set') return c.a.watched;
  return SEED_METHODS.has(c.m);
}

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
    return this.dispatch({ m, a } as unknown as Call);
  }

  private async dispatch(c: Call): Promise<ResultOf<WorkerMethod>> {
    if (this.closing !== null) fail('backend-down', 'worker is shutting down');
    if (c.m === 'init') return this.init(c.a);
    const r = this.running;
    if (r === null) fail('not-ready', 'init has not answered');
    if (r.watchOnly && seedsAnything(c)) fail('unsupported-input', 'this worker is watch only');
    switch (c.m) {
      case 'status':
        return this.status();
      case 'nfx.play.open':
        this.refusePrivate(r, c.a.video);
        return r.watching.open(c.a);
      case 'nfx.play.close':
        await r.watching.close(c.a.sid);
        r.offers.endSession(c.a.sid);
        return null;
      case 'nfx.seed.start':
        return this.seedFromHost(r, c.a);
      case 'nfx.seed.stop':
        return this.deleteVideo(r, c.a.video);
      case 'nfx.seed.list':
        return r.seeds.list();
      case 'nfx.endpoint':
        return { hyperdht: await r.seeds.endpoint(c.a.seeder, c.a.namespace) };
      case 'signer.status':
        return (
          r.signer?.status() ?? {
            kind: 'none',
            pubkey: null,
            locked: true,
            keyFile: false,
            localAllowed: false,
          }
        );
      case 'signer.local.create':
        return needs(r.signer).create(c.a.passphrase);
      case 'signer.local.unlock':
        return needs(r.signer).unlock(c.a.passphrase);
      case 'signer.nip46.connect':
        return needs(r.signer).connect(c.a.uri);
      case 'signer.lock':
        return needs(r.signer).lock();
      case 'signer.check':
        return this.checkSignable(r, c.a.video);
      case 'signer.sign':
        return this.signManifest(r, c.a.event, c.a.signer);
      case 'seeding.status':
        return this.seedingStatus(r);
      case 'seeding.set': {
        // The switch flips in memory at once; whether the save worked is reported last, so that a
        // full disk cannot leave a fetch running after "off".
        const saved = r.policy.setWatched(c.a.watched).then(
          () => true,
          () => false,
        );
        if (!c.a.watched) {
          // Off means off: fetches for it stop, and nothing handed over is kept.
          await Promise.all([...r.watchBudget.active].map((v) => r.seeds.abandon(v)));
          await r.offers.clear();
        }
        await r.seeds.refresh();
        if (!(await saved)) {
          // An "on" that could not be saved does not stay on.
          if (c.a.watched) {
            await r.policy.setWatched(false).catch(() => undefined);
            await r.seeds.refresh();
          }
          fail('io', 'the seeding switch could not be saved');
        }
        return this.seedingStatus(r);
      }
      case 'seeding.watch':
        return this.seedWatched(r, c.a);
      case 'seeding.stop': {
        const stopped = await r.policy.setStopped(c.a.video, true);
        await r.seeds.refresh();
        return { stopped };
      }
      case 'seeding.resume': {
        if (r.policy.record(c.a.video)?.author === null && r.policy.isPrivate(c.a.video))
          fail('invalid-argument', 'that video was never published');
        const resumed = await r.policy.setStopped(c.a.video, false);
        await r.seeds.refresh();
        return { resumed };
      }
      case 'seeding.title':
        return { title: r.policy.record(c.a.video)?.title ?? null };
      case 'seeding.delete':
        return this.deleteVideo(r, c.a.video);
      case 'seeding.beacons':
        return {
          events: await signBeacons({
            targets: () => this.beaconTargets(r),
            keys: r.seederKeys,
            endpoint: (seeder, namespace) => r.seeds.endpoint(seeder, namespace),
            now: () => Math.floor(Date.now() / 1000),
          }),
        };
      case 'seeding.segment':
        // With the switch off, nothing is kept for re-seeding.
        if (!r.policy.watched) return { accepted: false, complete: false };
        return r.offers.offer(c.a);
      case 'studio.ffmpeg':
        return needs(r.studio).ffmpeg();
      case 'studio.source':
        return needs(r.studio).addSource(c.a.path);
      case 'studio.probe':
        return needs(r.studio).probe(c.a.source);
      case 'studio.publish':
        return needs(r.studio).publish(c.a);
      case 'studio.cancel':
        return { cancelled: r.studio?.cancel() === true };
      case 'studio.discard': {
        if (r.policy.record(c.a.video)?.origin !== 'published' || !r.policy.isPrivate(c.a.video))
          return { removed: false };
        r.studio?.forgetDraft(c.a.video);
        return this.deleteVideo(r, c.a.video);
      }
    }
  }

  /** An unsigned draft, or a stored video no record explains, is not read through a play. */
  private refusePrivate(r: Running, video: string): void {
    const addr = nfx.VideoAddr.parse(video);
    if (addr.ok && r.store.get(addr.value) !== undefined && r.policy.isPrivate(video))
      fail('not-found', 'no such video');
  }

  private seedingStatus(r: Running): SeedingStatusWire {
    return seedingStatusOf(r.policy, r.seeds.list());
  }

  /** Every video served now with a known author: each gets a beacon. */
  private beaconTargets(r: Running): BeaconTarget[] {
    const out: BeaconTarget[] = [];
    for (const v of r.store.videos().slice(0, MAX_NFX_STORED_VIDEOS)) {
      const author = r.policy.record(v.video)?.author ?? null;
      if (author !== null && r.policy.served(v.video)) out.push({ video: v.video, author });
    }
    return out;
  }

  /** `nfx.seed.start` is the host's: what it stores it means to serve, and the record says so. */
  private async seedFromHost(
    r: Running,
    a: ArgsOf<'nfx.seed.start'>,
  ): Promise<ResultOf<'nfx.seed.start'>> {
    const known = r.policy.record(a.video);
    if (known === undefined || known.origin === 'watched')
      await r.policy.set(a.video, { origin: 'host', root: a.root, author: known?.author ?? null });
    try {
      return await r.seeds.start(a);
    } catch (err) {
      const addr = nfx.VideoAddr.parse(a.video);
      if (known === undefined && addr.ok && r.store.get(addr.value) === undefined)
        await r.policy.remove(a.video).catch(() => undefined);
      throw err;
    }
  }

  private async deleteVideo(r: Running, video: string): Promise<{ readonly removed: boolean }> {
    r.studio?.forgetDraft(video);
    const out = await r.seeds.stop(video);
    await r.policy.remove(video);
    await r.offers.drop(video);
    await r.seeds.refresh();
    return out;
  }

  /** The draft waiting for `video`, and what the user is shown before it is signed. */
  private checkSignable(r: Running, video: string): SignCheckWire {
    const signer = needs(r.signer).signingKey;
    if (signer === null) fail('no-signer', 'unlock or connect a signer first');
    const draft = r.studio?.draft(video);
    if (draft === undefined) fail('invalid-argument', 'no draft is waiting for that video');
    checkManifestDraft(draft.event, r.policy, r.store, signer);
    return {
      video,
      event: draft.event,
      signer,
      npub: npubEncode(signer),
      title: draft.event.tags.find((t) => t[0] === 'title')?.[1] ?? '',
      tags: draft.event.tags.flatMap((t) => (t[0] === 't' && t[1] !== undefined ? [t[1]] : [])),
      description: draft.event.content,
      file: draft.file,
    };
  }

  /**
   * `signer.sign`, from main after the user confirmed: exactly Studio's draft, with exactly the key
   * they were shown. Signing a manifest starts seeding it.
   */
  private async signManifest(
    r: Running,
    event: UnsignedEventWire,
    approved: string,
  ): Promise<SignedEventWire> {
    const signer = needs(r.signer);
    const key = signer.signingKey;
    if (key === null) fail('no-signer', 'unlock or connect a signer first');
    if (key !== approved) fail('invalid-argument', 'the signing key changed: confirm it again');
    const video = checkManifestDraft(event, r.policy, r.store, key);
    if (r.studio?.isDraft(video, event) !== true)
      fail('invalid-argument', 'this is not the manifest Studio made for that video');
    const signed = await signer.sign(event);
    checkSignedManifest(signed, video, key);
    const record = r.policy.record(video);
    // On disk before anyone can publish this event: the start-up purge deletes what still reads as
    // an unsigned draft. If this fails nothing was published, and the draft stays for a retry.
    if (record !== undefined) await r.policy.setDurable(video, { ...record, author: key });
    r.studio.forgetDraft(video);
    if (record !== undefined) await r.seeds.refresh();
    return signed;
  }

  /** `seeding.watch`: only with the switch on, and only for a free manifest that verifies. */
  private async seedWatched(r: Running, a: SeedingWatchArgs): Promise<ResultOf<'seeding.watch'>> {
    // A function: the answer can change across the awaits below.
    const switchOn = (): boolean => r.policy.watched;
    if (!switchOn()) fail('invalid-argument', 'seeding what you watch is off');
    const parsed = nfx.parseManifest(a.manifest);
    if (!parsed.ok || !nfx.isListable(parsed.value))
      fail('invalid-argument', 'not a free NFX manifest');
    const m = parsed.value;
    const video = m.addr.toString();
    if (m.addr.namespace.toString() !== STUDIO_NAMESPACE)
      fail('invalid-argument', 'not a network this build speaks');
    if (m.segs > BigInt(Number.MAX_SAFE_INTEGER)) fail('invalid-argument', 'not a stored size');
    // A video the viewer is watching: this window's open play of exactly this hash list.
    const listing = r.watching.listing(a.sid);
    if (listing === null) fail('session-closed', 'that play session is not open');
    if (listing.video !== video || listing.root !== m.root)
      fail('invalid-argument', 'the manifest is not the video of that play');
    const known = r.policy.record(video);
    const held = r.store.get(m.addr) !== undefined;
    // Stored with no record: nothing says why it is here, so a page cannot make it public.
    if (held && known === undefined) fail('invalid-argument', 'that video is stored and private');
    const reserved = held ? 0 : this.admitWatch(r, listing.bytes);
    r.watchBudget.active.add(video);
    try {
      if (known === undefined)
        await r.policy.set(video, {
          origin: 'watched',
          root: m.root,
          author: m.author,
          ...titleField(m.title),
        });
      // The switch can go off during that write, when there was no fetch yet to abandon.
      if (!switchOn()) fail('invalid-argument', 'seeding what you watch is off');
      const stored = await r.seeds.start({
        video,
        root: m.root,
        segs: Number(m.segs),
        peers: a.peers,
      });
      await r.offers.drop(video);
      return stored;
    } catch (err) {
      if (known === undefined && r.store.get(m.addr) === undefined)
        await r.policy.remove(video).catch(() => undefined);
      throw err;
    } finally {
      r.watchBudget.active.delete(video);
      r.watchBudget.reserved -= reserved;
    }
  }

  /**
   * A new video for "seed what you watch": within the hourly rate and the bytes it may keep, so a
   * compromised page cannot fill the disk with what it likes. Returns the bytes it reserved.
   */
  private admitWatch(r: Running, bytes: number): number {
    const b = r.watchBudget;
    const now = Date.now();
    b.starts = b.starts.filter((t) => now - t < 3_600_000);
    b.fetched = b.fetched.filter((f) => now - f.at < 3_600_000);
    if (b.starts.length >= MAX_WATCH_STARTS_PER_HOUR)
      fail('rate-limited', 'too many new videos to seed this hour');
    let fetched = bytes;
    for (const f of b.fetched) fetched += f.bytes;
    if (fetched > (this.o.maxWatchBytesPerHour ?? MAX_WATCH_BYTES_PER_HOUR))
      fail('rate-limited', 'too much video fetched to seed this hour');
    let used = b.reserved;
    for (const v of r.store.videos()) {
      if (r.policy.origin(v.video) !== 'watched') continue;
      for (const f of v.files) used += f.size;
    }
    if (used + bytes > (this.o.maxWatchedBytes ?? MAX_WATCHED_BYTES))
      fail('disk-cap', 'seeding this would pass what watched videos may keep');
    b.starts.push(now);
    b.fetched.push({ at: now, bytes });
    b.reserved += bytes;
    return bytes;
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
    const cap =
      a.diskCapBytes === undefined ? null : new DiskCap(a.diskCapBytes, store.totalBytes());
    if (cap !== null) store.attachCap(cap);

    const dht = new DhtNode({
      bootstrap: a.bootstrap ?? null,
      // A network whose every bootstrap is 127.0.0.1 is one of this machine's own processes: the
      // node binds there, so it cannot reach anything else, whatever that bootstrap is bridged to.
      loopbackOnly: isLoopbackTestnet(a.bootstrap ?? null),
      logger,
      onChange: () => {
        this.emitStatus();
      },
      ...(this.o.bootstrapWaitMs === undefined ? {} : { bootstrapWaitMs: this.o.bootstrapWaitMs }),
    });
    // No local addresses to any peer, unless the node's socket is really bound to 127.0.0.1, read
    // at each dial and when each listener starts (`./net/no-local-addresses.ts`). The switch can
    // only force hiding on.
    const force = this.o.hideLocalAddresses === true;
    const nfxView = (node: DHT): NfxDht => localAddressesByBind(node, { force });
    const hidesNow = (): boolean => {
      const node = dht.dht;
      return hidesLocalAddresses({ boundHost: node === null ? null : boundHost(node), force });
    };
    // Never derived from storage: a seeder sees a new watcher key every run (`./keys.ts`).
    const watcherKeys = new WatcherKeys();
    const pool = new NfxPeerPool({
      dht: async () => nfxView(await dht.ready()),
      keyPair: (namespace) => watcherKeys.keyPair(namespace),
      crypto: sodiumCrypto,
      logger,
      ...(this.o.dialTimeoutMs === undefined ? {} : { dialTimeoutMs: this.o.dialTimeoutMs }),
    });
    const onChange = (): void => {
      this.emitStatus();
    };
    const durable = this.o.runtime.system?.writeDurable;
    const policy = new SeedPolicy(fs, a.storage, {
      ...(durable === undefined ? {} : { durable }),
      warn: (text) => {
        logger.warn(`nfx: ${text}`);
      },
    });
    await policy.load();
    // An unsigned draft does not outlive the run that made it: its in-memory draft is gone, so it
    // could never be signed, and nothing else should hold a video the user has not approved.
    for (const video of policy.drafts()) {
      try {
        const addr = nfx.VideoAddr.parse(video);
        if (addr.ok) await store.removeVideo(addr.value);
        await policy.remove(video);
      } catch {
        // A full or read-only disk must not stop the app. Unremoved, it stays private all the same.
        logger.warn('nfx: an unsigned draft could not be removed');
      }
    }
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
    const offers = new SegmentOffers({
      fs,
      dir: fs.join(a.storage, TMP_DIR, OFFERED_DIR),
      listing: (sid) => watching.listing(sid),
      stored: (video) => {
        const addr = nfx.VideoAddr.parse(video);
        return addr.ok && store.hasVideo(addr.value);
      },
    });
    const seeds = new NfxSeeds({
      store,
      pool,
      dht: () => {
        const node = dht.forListener();
        return node === null ? null : nfxView(node);
      },
      keyPair: (name) => keys.keyPair(name),
      logger,
      emit: (ev) => {
        this.o.emit(ev);
      },
      onChange,
      // Watch only: nothing stored is served, so no listener ever opens.
      served: a.watchOnly === true ? () => false : (video) => policy.served(video),
      held: (video, sha) => offers.read(video, sha),
    });
    const seederKeys = new SeederKeys((name) => keys.keyPair(name));
    const system = this.o.runtime.system;
    let signer: UserSigner | null = null;
    let studio: Studio | null = null;
    if (system !== undefined) {
      const userSigner = new UserSigner({
        fs,
        system,
        dir: fs.join(a.storage, SIGNER_DIR),
        allowLocal: a.localKey === true,
        warn: (text) => {
          logger.warn(`signer: ${text}`);
        },
        ...(this.o.signerCost === undefined ? {} : { cost: this.o.signerCost }),
        ...(this.o.bunkerWaitMs === undefined ? {} : { bunkerWaitMs: this.o.bunkerWaitMs }),
      });
      await userSigner.load();
      signer = userSigner;
      studio = new Studio({
        fs,
        rmTree,
        system,
        store,
        tmpDir: fs.join(a.storage, TMP_DIR),
        sha256: sodiumSha256,
        randomHex,
        logger,
        emit: (ev) => {
          this.o.emit(ev);
        },
        canSign: () => userSigner.signingKey !== null,
        onPackaged: (video, root, title) =>
          policy.set(video, { origin: 'published', root, author: null, ...titleField(title) }),
        onAbandoned: (video) => policy.remove(video),
        room: async () => {
          const quota = cap?.freeBytes ?? null;
          const free = await system.freeBytes(a.storage).catch(() => null);
          const disk = free === null ? null : Math.floor(free / STUDIO_DISK_COPIES);
          if (quota === null) return disk;
          return disk === null ? quota : Math.min(quota, disk);
        },
        now: () => Math.floor(Date.now() / 1000),
        ...(this.o.studioPreset === undefined ? {} : { preset: this.o.studioPreset }),
        ...(this.o.sourceTtlSec === undefined ? {} : { sourceTtlSec: this.o.sourceTtlSec }),
      });
    }
    if (a.watchOnly !== true) await seeds.resume();
    return {
      logger,
      keys,
      store,
      dht,
      hidesLocalAddresses: hidesNow,
      watcherKeys,
      pool,
      watching,
      seeds,
      policy,
      offers,
      seederKeys,
      signer,
      studio,
      watchOnly: a.watchOnly === true,
      watchBudget: { starts: [], reserved: 0, fetched: [], active: new Set() },
    };
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
      await step('Studio', async () => r.studio?.close());
      await step('the play sessions', () => r.watching.shutdown());
      await step('the seeds', () => r.seeds.close());
      r.pool.close();
      await step('the DHT node', () => r.dht.destroy());
      r.watcherKeys.close();
      await step('the signer', async () => r.signer?.close());
      await step('the beacon keys', () => r.seederKeys.close());
      await step('the policy', () => r.policy.flush());
      await step('the keys', () => r.keys.close());
    })();
    return this.closing;
  }
}
