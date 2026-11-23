/**
 * The renderer's `NetworkAdapter` (`RuntimeNetworkAdapter`): `platform: 'desktop'` (an app, not a
 * page), NFX only, signed out, free videos, over ordinary Nostr relays on the browser's
 * WebSocket, with video fetched by the worker over HyperDHT and, where the probe passed and the
 * viewer has not switched it off, traded over a WebRTC mesh. Modelled on nutflix-pear's
 * `packages/app-web/src/adapter/web-adapter.ts` (the submodule's pinned commit). What each call
 * does here:
 *
 * | Calls | Here |
 * |---|---|
 * | `settings`, `updateSettings` | Web Storage (`SettingsStore`) |
 * | `feed` (`network`, `tags`, `author`), `search`, `nfxVideo` | core's `NfxCatalog`; search routed by NIP-11 |
 * | `playNfx` | live beacons from core's `NfxBeaconWatch`, then `nfx.play.open` on the worker: its origin for nfx's web player (`WebRtcNfxSession`), or its progressive stream for a plain `<video>` (`RuntimeNfxSession`) |
 * | `profile`, `image` | kind 0 from the read relays; images only by signed sha256, as `blob:` |
 * | `video`, `comments` | read-only NIP-71 reads (an NFX copy's thread) |
 * | `signer`, `me` | signed out |
 * | `feed` (`subscriptions`, `trending`, `shorts`), `related`, `stats`, `subscriptions`, `library` reads, `notifications`, `seeder.onStatus` | empty |
 * | `play`, `setProfilePicture`, `comment`, `react`, `unreact`, `nutzap`, `subscribe`, `unsubscribe`, `report`, `studio.*`, `seeder.status` and writes, `library` writes, `wallet.*` | reject `unsupported`; the shell's offer hides them |
 *
 * Every relay read goes through core's `NostrClient` (signatures checked) on a `PoolLike` the page
 * passes in (`SimplePoolAdapter`: the browser's WebSocket). A relay failure is `relay-down`; a
 * worker that does not answer is `worker-down`. A message of either is this client's own words.
 */
import type {
  CatalogVideo,
  Comment,
  FeedQuery,
  NetworkAdapter,
  NfxAddress,
  NfxPlaySession,
  NfxVideo,
  NostrEventId,
  NostrPubkey,
  Notification,
  Page,
  PlaySession,
  Playlist,
  Profile,
  RelayUrl,
  Sats,
  SearchFilters,
  SeederStatus,
  Settings,
  Sha256Hex,
  SignerStatus,
  UnixSeconds,
  Unsubscribe,
  VideoManifest,
  VideoStats,
  Wallet,
} from '@sovit/core';
import { MAX_RENDITION_ID_LENGTH, RESERVED_RENDITION_ID, parseATag } from '@sovit/core/nfx';
import {
  NFX_BEACON_WAIT_MS,
  NfxBeaconWatch,
  NfxCatalog,
  NostrClient,
  RelaySearchSupport,
  fetchComments,
  fetchProfile,
  fetchVideo,
  nowSeconds,
  toWire,
  type NfxBeaconWatchTimers,
  type PoolLike,
} from '@sovit/core/nostr';
import { MAX_PREFETCH_SECONDS, type ErrorCode } from '@nutflix-runtime/worker';

import { RuntimeAdapterError, fail, unsupported, type RuntimeErrorCode } from '../errors.js';
import { isWorkerMediaUrl, isWorkerOriginUrl } from '../links.js';
import type { FetchFn } from '../net/http.js';
import { browserRelayInfoFetch } from '../net/relay-info.js';
import type { NfxPlayerLib } from '../player/nfx-lib.js';
import type { SettingsStore } from '../settings/store.js';
import { NFX_NETWORK } from '../settings/defaults.js';
import { webrtcPlan } from '../settings/webrtc.js';
import { codeOf, type PlayWorker } from '../worker/pipe.js';
import { canonicalNfxAddress } from './address.js';
import { hyperdhtEndpoints } from './endpoints.js';
import { Images } from './images.js';
import { RuntimeNfxSession } from './session.js';
import { RuntimeWallet } from './wallet.js';
import { WebRtcNfxSession, type ProgressivePlay } from './webrtc-session.js';

/** Page size of a comment thread (the desktop app's). */
export const COMMENTS_PAGE = 20;
/** How long one relay query may wait, ms. */
export const RELAY_WAIT_MS = 8_000;
/** The largest page a caller may ask for (the desktop's `LIMITS.maxPage`). */
export const MAX_PAGE = 200;
/** A search text's or cursor's length cap (the desktop's `LIMITS.maxString`). */
export const MAX_TEXT = 4096;
/** The most plays open at once: the worker's own cap (`MAX_NFX_SESSIONS`). */
export const MAX_OPEN_SESSIONS = 4;

export interface RuntimeAdapterOptions {
  /** The relay pool: `SimplePoolAdapter` (the browser's WebSocket) in the page. */
  readonly pool: PoolLike;
  readonly settings: SettingsStore;
  /** The worker, over its pipe (`WorkerLink`). */
  readonly worker: PlayWorker;
  /**
   * nfx's web player, when the capability probe passed; `null` or absent: every video plays from
   * the worker's progressive stream. Asked at each play, so a probe that finishes after the first
   * screen counts from the next play on.
   */
  readonly player?: (() => NfxPlayerLib | null) | undefined;
  /** The page's `fetch`, for NIP-11 documents and images. */
  readonly fetch: FetchFn;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  /** 16 random bytes as 32 lowercase hex: a play's session name. Default: `crypto`. */
  readonly newSid?: (() => string) | undefined;
  /** Unix seconds; tests pass a clock. */
  readonly now?: (() => UnixSeconds) | undefined;
  /** The beacon watch's timers; default the browser's. */
  readonly timers?: NfxBeaconWatchTimers | undefined;
  /** How long a play waits for a usable beacon, ms (default one republish interval). */
  readonly beaconWaitMs?: number | undefined;
  /** Per-query relay wait, ms. */
  readonly maxWaitMs?: number | undefined;
}

const SIGNED_OUT: SignerStatus = Object.freeze({
  kind: 'nip07',
  pubkey: null,
  locked: false,
  supportsSignSecret: false,
});

const EMPTY_STATS: VideoStats = Object.freeze({
  paidViews: 0,
  satsToCreator: 0 as Sats,
  reactions: 0,
  likes: 0,
  dislikes: 0,
  comments: 0,
});

/** Arguments are checked as `unknown`: the screens are typed, but nothing here relies on it. */
function isHex64(x: unknown): x is string {
  return typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
}

function isText(x: unknown): x is string {
  return typeof x === 'string' && x.length <= MAX_TEXT;
}

/** A hash-list rendition id as `playNfx` takes one: non-empty, at most 64 characters, never `meta`. */
function isRenditionId(x: unknown): x is string {
  return (
    typeof x === 'string' &&
    x !== '' &&
    x !== RESERVED_RENDITION_ID &&
    x.length <= MAX_RENDITION_ID_LENGTH
  );
}

function checkPage(cursor: unknown, limit: unknown): void {
  if (cursor !== undefined && !isText(cursor)) fail('invalid-argument', 'not a cursor');
  if (
    limit !== undefined &&
    !(typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_PAGE)
  ) {
    fail('invalid-argument', 'not a page size');
  }
}

/** 16 random bytes from the platform's CSPRNG, lowercase hex: `nfx.play.open`'s `sid`. */
export function randomSid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** The adapter's code for a worker's (the worker's own words never cross). */
const WORKER_CODES: Readonly<Partial<Record<ErrorCode, readonly [RuntimeErrorCode, string]>>> =
  Object.freeze({
    'invalid-argument': ['invalid-argument', 'the worker refused this play'],
    'no-seeders': ['no-seeders', 'no seeder could be reached over HyperDHT'],
    'not-found': ['not-found', 'the worker does not have that rendition'],
    'unsupported-input': ['unsupported', 'this video cannot play over HyperDHT alone'],
    'rate-limited': ['internal', 'too many videos are open'],
    'session-closed': ['session-closed', 'the play has ended'],
    'not-ready': ['worker-down', 'the worker is not ready'],
    'backend-down': ['worker-down', 'the worker is not running'],
  });

/** A worker's failure as this client's. */
export function fromWorker(e: unknown): RuntimeAdapterError {
  if (e instanceof RuntimeAdapterError) return e;
  const mapped = WORKER_CODES[codeOf(e) ?? 'internal'];
  return mapped === undefined
    ? new RuntimeAdapterError('internal', 'the worker failed')
    : new RuntimeAdapterError(mapped[0], mapped[1]);
}

export class RuntimeNetworkAdapter implements NetworkAdapter {
  readonly platform = 'desktop' as const;
  readonly wallet: Wallet = new RuntimeWallet();

  readonly #o: RuntimeAdapterOptions;
  readonly #now: () => UnixSeconds;
  readonly #catalog: NfxCatalog;
  readonly #beacons: NfxBeaconWatch;
  readonly #images: Images;
  readonly #sessions = new Set<RuntimeNfxSession | WebRtcNfxSession>();
  #client: { readonly relays: Settings['relays']; readonly client: NostrClient } | null = null;
  #closed = false;

  constructor(o: RuntimeAdapterOptions) {
    this.#o = o;
    this.#now = o.now ?? nowSeconds;
    const search = new RelaySearchSupport(browserRelayInfoFetch(o.fetch));
    this.#catalog = new NfxCatalog(
      () => this.#nostr(),
      NFX_NETWORK,
      () => this.#settings().nfx?.scopedRelays ?? [],
      { searchSupport: search.supports },
    );
    this.#beacons = new NfxBeaconWatch({
      subscribe: (filter, relays, onEvent) =>
        this.#nostr().subscribe([filter], onEvent, { relays }),
      now: () => this.#now(),
      timers: o.timers,
    });
    this.#images = new Images({
      fetch: o.fetch,
      createObjectURL: o.createObjectURL,
      revokeObjectURL: o.revokeObjectURL,
    });
  }

  // ---- plumbing ----------------------------------------------------------------------------

  #settings(): Settings {
    return this.#o.settings.get();
  }

  /** The read client for the current relays (rebuilt when they change). No signer, ever. */
  #nostr(): NostrClient {
    const relays = this.#settings().relays;
    const held = this.#client;
    if (held?.relays === relays) return held.client;
    const client = new NostrClient({
      pool: this.#o.pool,
      relays,
      now: this.#now,
      maxWaitMs: this.#o.maxWaitMs ?? RELAY_WAIT_MS,
    });
    this.#client = { relays, client };
    return client;
  }

  /** The relays beacons are read from: the scoped relays, or the read relays when there are none. */
  #beaconRelays(): readonly RelayUrl[] {
    const scoped = this.#settings().nfx?.scopedRelays ?? [];
    return scoped.length > 0 ? scoped : this.#nostr().readRelays;
  }

  /** A relay read: `relay-down` when there is no relay to ask or none answered. */
  async #read<T>(fn: () => Promise<T>): Promise<T> {
    const s = this.#settings();
    if (this.#nostr().readRelays.length === 0 && (s.nfx?.scopedRelays.length ?? 0) === 0) {
      fail('relay-down', 'no relays configured');
    }
    try {
      return await fn();
    } catch (e) {
      if (e instanceof RuntimeAdapterError) throw e;
      throw new RuntimeAdapterError('relay-down', 'relay request failed');
    }
  }

  // ---- identity: signed out ------------------------------------------------------------------

  signer(): Promise<SignerStatus> {
    return Promise.resolve(SIGNED_OUT);
  }

  me(): Promise<NostrPubkey | null> {
    return Promise.resolve(null);
  }

  async profile(pubkey: NostrPubkey): Promise<Profile | null> {
    if (!isHex64(pubkey)) fail('invalid-argument', 'not a pubkey');
    // No NIP-05 lookup: it would make the page fetch a URL a relay event names.
    return this.#read(() => fetchProfile(this.#nostr(), pubkey));
  }

  setProfilePicture(): Promise<Profile> {
    return unsupported('setting a profile picture');
  }

  // ---- catalogue ---------------------------------------------------------------------------

  async feed(q: FeedQuery): Promise<Page<CatalogVideo>> {
    checkPage(q.cursor, q.limit);
    switch (q.source) {
      case 'network':
      case 'tags':
      case 'author':
        if (q.author !== undefined && !isHex64(q.author)) fail('invalid-argument', 'not a pubkey');
        return this.#read(() => this.#catalog.feed(q, null));
      case 'subscriptions':
      case 'trending':
      case 'shorts':
        // Signed out, and no NIP-71 listing: nothing to show.
        return { items: [] };
      default:
        return fail('invalid-argument', 'not a feed');
    }
  }

  async video(id: NostrEventId): Promise<VideoManifest | null> {
    if (!isHex64(id)) return null;
    return this.#read(() => fetchVideo(this.#nostr(), id));
  }

  /** The video, and its live beacons read from now on, so Play usually finds a seeder at once. */
  async nfxVideo(addr: NfxAddress): Promise<NfxVideo | null> {
    const a = canonicalNfxAddress(addr);
    if (a === null) return null;
    const video = await this.#read(() => this.#catalog.video(a));
    if (video !== null) this.#beacons.watch(video, this.#beaconRelays());
    return video;
  }

  async playNfx(addr: NfxAddress, rendition?: string): Promise<NfxPlaySession> {
    if (this.#closed) fail('session-closed', 'the app is closing');
    const a = canonicalNfxAddress(addr);
    if (a === null) fail('invalid-argument', 'not an NFX address on this network');
    if (rendition !== undefined && !isRenditionId(rendition)) {
      fail('invalid-argument', 'no such rendition');
    }
    if (this.#sessions.size >= MAX_OPEN_SESSIONS) fail('internal', 'too many videos are open');
    const video = await this.#read(() => this.#catalog.video(a));
    if (video === null) fail('not-found', 'no such free NFX video');
    const target = parseATag(video.id);
    if (!target.ok) fail('invalid-argument', 'not an NFX address on this network');
    try {
      await this.#o.worker.ready();
    } catch (e) {
      throw fromWorker(e);
    }
    const now = (): number => this.#now();
    // Live beacons (NFX-04: never stored): wait until a seeder names a HyperDHT endpoint whose
    // `bind` verifies, at most one republish interval, then take what came.
    const events = await this.#beacons.wait(
      video,
      this.#beaconRelays(),
      (evs) => hyperdhtEndpoints(video, evs, now()).reachable > 0,
      this.#o.beaconWaitMs ?? NFX_BEACON_WAIT_MS,
    );
    const found = hyperdhtEndpoints(video, events, now());
    if (found.seeders === 0) fail('no-seeders', 'nobody seeding this NFX video is online');
    const common = {
      video: target.value.addr.toString(),
      root: video.root,
      segs: video.segs,
      peers: found.peers,
      ...(found.held.seeders > 0 ? { held: found.held } : {}),
      ...(rendition === undefined ? {} : { renditions: [rendition] }),
    };
    const openProgressive = async (): Promise<ProgressivePlay> => {
      const sid = (this.#o.newSid ?? randomSid)();
      let opened;
      try {
        // `peers` may be empty: the worker plays from its own store when it holds the video.
        opened = await this.#o.worker.open({
          ...common,
          sid,
          prefetchSeconds: Math.min(
            Math.max(0, Math.trunc(this.#settings().prefetchSeconds)),
            MAX_PREFETCH_SECONDS,
          ),
          // The progressive stream alone.
          origin: false,
        });
      } catch (e) {
        throw fromWorker(e);
      }
      const url = opened.progressiveUrl;
      if (!isWorkerMediaUrl(url)) {
        // The worker answered with something that is not its own loopback stream: refuse it, and
        // close the play it opened.
        await this.#o.worker.close(sid).catch(() => undefined);
        fail('internal', 'the worker gave no playable stream');
      }
      return {
        sid,
        url,
        rendition: opened.rendition,
        renditions: opened.renditions.map((r) => ({
          id: r.id,
          bandwidth: r.bandwidth,
          ...(r.resolution === undefined ? {} : { resolution: r.resolution }),
        })),
      };
    };

    const player = this.#o.player?.() ?? null;
    const plan = webrtcPlan(this.#settings().nfx);
    let session: RuntimeNfxSession | WebRtcNfxSession;
    if (player !== null && plan !== null) {
      const sid = (this.#o.newSid ?? randomSid)();
      let opened;
      try {
        // The origin alone: the player fetches what it needs, and the progressive stream is
        // opened only if the player fails.
        opened = await this.#o.worker.open({ ...common, sid, progressive: false });
      } catch (e) {
        throw fromWorker(e);
      }
      const originUrl = opened.originUrl;
      if (!isWorkerOriginUrl(originUrl)) {
        await this.#o.worker.close(sid).catch(() => undefined);
        fail('internal', 'the worker gave no playable origin');
      }
      session = new WebRtcNfxSession({
        videoId: a,
        manifestJson: JSON.stringify(toWire(video.event)),
        sid,
        originUrl,
        renditions: opened.renditions.map((r) => ({
          id: r.id,
          bandwidth: r.bandwidth,
          ...(r.resolution === undefined ? {} : { resolution: r.resolution }),
        })),
        pin: rendition,
        meshRelays: plan.meshRelays,
        iceServers: plan.iceServers,
        player,
        worker: this.#o.worker,
        openProgressive,
        onClose: (s) => {
          this.#sessions.delete(s);
        },
      });
    } else {
      const p = await openProgressive();
      session = new RuntimeNfxSession({
        videoId: a,
        sid: p.sid,
        url: p.url,
        rendition: p.rendition,
        renditions: p.renditions,
        worker: this.#o.worker,
        onClose: (s) => {
          this.#sessions.delete(s);
        },
      });
    }
    this.#sessions.add(session);
    if (this.#isClosed()) {
      await session.close();
      fail('session-closed', 'the app is closing');
    }
    return session;
  }

  play(): Promise<PlaySession> {
    return unsupported('playing a NIP-71 video');
  }

  stats(): Promise<VideoStats> {
    return Promise.resolve(EMPTY_STATS);
  }

  related(): Promise<readonly VideoManifest[]> {
    return Promise.resolve([]);
  }

  async search(q: {
    readonly text: string;
    readonly cursor?: string;
    readonly filters?: SearchFilters;
  }): Promise<Page<CatalogVideo>> {
    if (!isText(q.text)) fail('invalid-argument', 'not a search');
    checkPage(q.cursor, undefined);
    return this.#read(() => this.#catalog.search(q));
  }

  image(url: string, sha256?: Sha256Hex, size?: number): Promise<string> {
    return this.#images.image(url, sha256, size);
  }

  // ---- social: read-only ---------------------------------------------------------------------

  async comments(
    videoId: NostrEventId,
    sort: 'new' | 'top',
    cursor?: string,
  ): Promise<Page<Comment>> {
    if (!isHex64(videoId)) fail('invalid-argument', 'not an event id');
    if (!(['new', 'top'] as readonly unknown[]).includes(sort))
      fail('invalid-argument', 'not a sort');
    checkPage(cursor, undefined);
    return this.#read(() =>
      fetchComments(this.#nostr(), videoId, { sort, cursor, limit: COMMENTS_PAGE }),
    );
  }

  comment(): Promise<Comment> {
    return unsupported('commenting');
  }

  react(): Promise<void> {
    return unsupported('reacting');
  }

  unreact(): Promise<void> {
    return unsupported('reacting');
  }

  nutzap(): Promise<void> {
    return unsupported('zapping');
  }

  subscribe(): Promise<void> {
    return unsupported('subscribing');
  }

  unsubscribe(): Promise<void> {
    return unsupported('subscribing');
  }

  subscriptions(): Promise<readonly NostrPubkey[]> {
    return Promise.resolve([]);
  }

  report(): Promise<void> {
    return unsupported('reporting');
  }

  readonly library: NetworkAdapter['library'] = {
    history: () => Promise.resolve({ items: [] }),
    recordProgress: () => Promise.resolve(),
    watchLater: () => Promise.resolve([]),
    setWatchLater: () => unsupported('Watch later'),
    playlists: () => Promise.resolve([] as readonly Playlist[]),
    savePlaylist: () => unsupported('saving a playlist'),
    liked: () => Promise.resolve([]),
  };

  readonly studio: NetworkAdapter['studio'] = {
    probe: () => unsupported('uploading'),
    upload: () => unsupported('uploading'),
    myVideos: () => unsupported('Studio'),
    analytics: () => unsupported('Studio'),
  };

  readonly seeder: NetworkAdapter['seeder'] = {
    status: (): Promise<SeederStatus> => unsupported('seeding'),
    setEnabled: () => unsupported('seeding'),
    melt: () => unsupported('seeding'),
    unban: () => unsupported('seeding'),
    onStatus: (): Unsubscribe => () => undefined,
  };

  // ---- settings ------------------------------------------------------------------------------

  settings(): Promise<Settings> {
    return Promise.resolve(this.#settings());
  }

  updateSettings(patch: Partial<Settings>): Promise<Settings> {
    try {
      return Promise.resolve(this.#o.settings.update(patch));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  notifications(_cb: (n: Notification) => void): Unsubscribe {
    return () => undefined;
  }

  // ---- the page --------------------------------------------------------------------------------

  /** Whether the app closed while a play was opening (a method, so no narrowing hides it). */
  #isClosed(): boolean {
    return this.#closed;
  }

  /** The plays open now. */
  get openSessions(): number {
    return this.#sessions.size;
  }

  /** The page is going: every play closes, every beacon subscription too, every image URL. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#sessions].map((s) => s.close()));
    this.#beacons.close();
    this.#images.clear();
  }
}
