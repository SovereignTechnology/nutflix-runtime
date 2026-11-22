/**
 * The host ⇄ worker protocol (packages/worker/README.md is its prose): typed JSON messages, one
 * per frame (`./framing.ts`). The host is whatever started the worker (a Pear shell's main
 * process, or a test); it sends requests, the worker answers each once and sends events.
 *
 *   host → worker   { op: 'req', id, m, a }
 *   worker → host   { op: 'res', id, ok: true, r? } | { op: 'res', id, ok: false, e }
 *                   { op: 'ev', e, ... }
 *
 * Runtime-neutral and import-free at runtime but for constants: the shells and the renderer
 * bridge import this module.
 */

/** The protocol version `init` names; the worker refuses any other. */
export const PROTOCOL_V = 1 as const;

export const ERROR_CODES = [
  /** Arguments the guard refused, or a request that contradicts the worker's state. */
  'invalid-argument',
  /** A request other than `init` before `init` answered. */
  'not-ready',
  'not-found',
  /** No seeder (or the local store) served a file the request needs. */
  'no-seeders',
  /** The video cannot be played the way it was asked (not one progressive fMP4, too large). */
  'unsupported-input',
  /** Too many requests in flight, or too many play sessions. */
  'rate-limited',
  /** The play session closed while the request ran. */
  'session-closed',
  /** The worker is shutting down. */
  'backend-down',
  /** `nfx.seed.start`: the video is stored with another hash list. */
  'exists',
  /** `nfx.seed.start`: storing it would pass the disk cap. */
  'disk-cap',
  /** The store could not read or write its files. */
  'io',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface WireError {
  readonly code: ErrorCode;
  /** Starts `<code>: `; at most 512 characters, one line. */
  readonly message: string;
}

// ---- limits --------------------------------------------------------------------------------

/** The most HyperDHT seeders one `nfx.play.open` or `nfx.seed.start` names (nutflix-pear's). */
export const MAX_NFX_PEERS = 16;
/** The most renditions one `nfx.play.open` reports, or takes as a preference. */
export const MAX_NFX_RENDITIONS = 16;
/** The most named renditions `held` carries (core's `MAX_AVAILABILITY_RENDITIONS`). */
export const MAX_NFX_HELD_RENDITIONS = 32;
/** The most seeders `held` counts (core's `MAX_AVAILABILITY_SEEDERS`). */
export const MAX_NFX_HELD_SEEDERS = 64;
/** The most bootstrap nodes `init` takes. */
export const MAX_BOOTSTRAP_NODES = 16;
/** The longest storage path `init` takes. */
export const MAX_PATH = 4096;
/** The longest read-ahead a play session takes, seconds. */
export const MAX_PREFETCH_SECONDS = 600;
/** The most stored videos one `nfx.seed.list` lists. */
export const MAX_NFX_STORED_VIDEOS = 4096;
/** A rendition id or a resolution as it crosses (ids come from a creator's hash list). */
export const MAX_LABEL = 64;
/** A rendition's `resolution` as it crosses (`<w>x<h>`, NFX-05 §2, bounded here). */
export const NFX_RESOLUTION = /^[0-9]{1,6}x[0-9]{1,6}$/;

// ---- shared wire shapes --------------------------------------------------------------------

export interface BootstrapNode {
  readonly host: string;
  readonly port: number;
}

/** An NFX-12 endpoint as a beacon carries it (NFX-03 §4, NFX-12 §2). */
export interface NfxHyperdhtEndpointWire {
  readonly t: 'hyperdht';
  /** The listener's Ed25519 key, 64 lowercase hex. */
  readonly peer: string;
  /** The peer key's signature over `nfx/hyperdht/1:<seeder>:<namespace>`, 128 lowercase hex. */
  readonly bind: string;
}

/** One rendition of an NFX video, as a quality menu needs it. */
export interface NfxRenditionWire {
  readonly id: string;
  /** Peak bits per second (NFX-05 `bandwidth`). */
  readonly bandwidth: number;
  readonly resolution?: string;
}

/** core's `RenditionAvailability` as it crosses (nutflix-pear #97). */
export interface NfxHeldWire {
  /** Seeders counted. */
  readonly seeders: number;
  /** Of those, the ones holding every rendition. */
  readonly all: number;
  /** `[rendition id, seeders holding it by name]`, each id once. */
  readonly named: readonly (readonly [string, number])[];
}

// ---- requests ------------------------------------------------------------------------------

export interface InitArgs {
  readonly v: typeof PROTOCOL_V;
  /** An absolute directory the worker owns: its keys, its NFX store, its spools (`tmp/`). */
  readonly storage: string;
  /** HyperDHT bootstrap nodes; absent or `null`: HyperDHT's public bootstrap. */
  readonly bootstrap?: readonly BootstrapNode[] | null;
  /** Bytes the NFX store may hold; absent: no cap. */
  readonly diskCapBytes?: number;
  /** The least severe log level sent as `log` events; default `info`. */
  readonly logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Watch one free NFX video. The host found it (a manifest it verified) and the seeders that
 * beacon it (verified beacons, their `bind` checked); the worker fetches over NFX-12 (and from
 * its own store when it holds the video) and serves it on loopback.
 */
export interface NfxPlayOpenArgs {
  /** Host-minted, 32 lowercase hex: the session's name for `nfx.play.close`. */
  readonly sid: string;
  /** `<namespace>:<video-id>` (NFX-01): the manifest's `d`. */
  readonly video: string;
  /** The manifest `root`: sha256 of the hash list. */
  readonly root: string;
  /** The manifest `segs`: how many files the hash list lists. */
  readonly segs: number;
  /** The beaconed `hyperdht` endpoints, in the order to try them (0..`MAX_NFX_PEERS`). */
  readonly peers: readonly NfxHyperdhtEndpointWire[];
  /**
   * Rendition ids in order of preference: the progressive stream plays the first one held.
   * Absent: the one most seeders hold (`held`), at equal holders the highest bandwidth.
   */
  readonly renditions?: readonly string[];
  /** Which renditions the seeders of `peers` hold (core's `nfx.countHolders`). */
  readonly held?: NfxHeldWire;
  /** Seconds of media fetched ahead of the progressive stream's reader; default 30. */
  readonly prefetchSeconds?: number;
  /** Serve one rendition as one progressive fMP4 (`progressiveUrl`); default `true`. */
  readonly progressive?: boolean;
  /** Serve an NFX-05 §6 origin for nfx's web player (`originUrl`); default `true`. */
  readonly origin?: boolean;
}

export interface NfxPlayOpenResult {
  /**
   * `http://127.0.0.1:<port>/<token>/<sid>`: the rendition as one `video/mp4`, single ranges;
   * `null` when not asked for, or when the rendition cannot play as one file and the origin
   * was asked for too.
   */
  readonly progressiveUrl: string | null;
  /**
   * `http://127.0.0.1:<port>/<token>`: an NFX-05 §6 origin base for this video only; give it to
   * the web player as `origins: [originUrl]`. `null` when not asked for.
   */
  readonly originUrl: string | null;
  /** The rendition the progressive stream plays, else the preferred one. */
  readonly rendition: string;
  /** The hash list's renditions that can play, highest bandwidth first. */
  readonly renditions: readonly NfxRenditionWire[];
}

/** Store a video in the NFX store (every file sha256-checked) and seed it over NFX-12. */
export interface NfxSeedStartArgs {
  readonly video: string;
  readonly root: string;
  readonly segs: number;
  /** Where to fetch the files the store lacks (0..`MAX_NFX_PEERS`; none: stored already). */
  readonly peers: readonly NfxHyperdhtEndpointWire[];
}

/** A video in the NFX store; every one is seeded. */
export interface NfxStoredVideoWire {
  readonly video: string;
  readonly root: string;
  readonly segs: number;
  /** Files it lists, the hash list included. */
  readonly files: number;
  readonly bytes: number;
}

/** One network's NFX-12 listener. */
export interface NfxListenerWire {
  readonly namespace: string;
  readonly connections: number;
}

export interface NfxSeedListResult {
  readonly videos: readonly NfxStoredVideoWire[];
  /** The listeners up, one per network with a stored video. */
  readonly listening: readonly NfxListenerWire[];
}

export interface WorkerStatus {
  /**
   * `idle`: no DHT node yet, none starts until a play or a stored video needs one. `ready` once
   * it bootstrapped (or its bootstrap wait ran out).
   */
  readonly dht: 'idle' | 'starting' | 'ready' | 'closed';
  readonly playSessions: number;
  readonly storedVideos: number;
  readonly listening: readonly NfxListenerWire[];
}

/** Requests the host makes: `[args, result]`. */
export interface WorkerMethodTable {
  init: [args: InitArgs, result: { readonly v: typeof PROTOCOL_V }];
  status: [args: Record<string, never>, result: WorkerStatus];
  'nfx.play.open': [args: NfxPlayOpenArgs, result: NfxPlayOpenResult];
  /** Its links 404 at once, its fetches stop, its spool goes. Idempotent. */
  'nfx.play.close': [args: { readonly sid: string }, result: null];
  /** Answers once every file is stored and the network's listener is up. */
  'nfx.seed.start': [args: NfxSeedStartArgs, result: NfxStoredVideoWire];
  /** Stop seeding a video and delete it from the store (and a start of it still running). */
  'nfx.seed.stop': [args: { readonly video: string }, result: { readonly removed: boolean }];
  'nfx.seed.list': [args: Record<string, never>, result: NfxSeedListResult];
  /**
   * The `hyperdht` endpoint for beacons that `seeder` (a Nostr key, 64 hex) signs on
   * `namespace`, while this node listens there; else `null`, so no beacon names a listener
   * that is not up.
   */
  'nfx.endpoint': [
    args: { readonly seeder: string; readonly namespace: string },
    result: { readonly hyperdht: NfxHyperdhtEndpointWire | null },
  ];
}
export type WorkerMethod = keyof WorkerMethodTable;
export type ArgsOf<M extends WorkerMethod> = WorkerMethodTable[M][0];
export type ResultOf<M extends WorkerMethod> = WorkerMethodTable[M][1];

export const WORKER_METHODS = [
  'init',
  'status',
  'nfx.play.open',
  'nfx.play.close',
  'nfx.seed.start',
  'nfx.seed.stop',
  'nfx.seed.list',
  'nfx.endpoint',
] as const satisfies readonly WorkerMethod[];

// ---- events --------------------------------------------------------------------------------

export type WorkerEvent =
  /** After `init` answered. */
  | { readonly op: 'ev'; readonly e: 'ready'; readonly v: typeof PROTOCOL_V }
  /** Whenever a field of the status changed. */
  | { readonly op: 'ev'; readonly e: 'status'; readonly status: WorkerStatus }
  /** A seed's progress: files stored of the files to store, or why it stopped. */
  | {
      readonly op: 'ev';
      readonly e: 'nfx.seed';
      readonly video: string;
      readonly state: 'fetching' | 'seeding' | 'failed' | 'stopped';
      readonly done?: number;
      readonly total?: number;
      readonly error?: WireError;
    }
  /** One redacted log line (the worker's only output path). */
  | {
      readonly op: 'ev';
      readonly e: 'log';
      readonly level: 'debug' | 'info' | 'warn' | 'error';
      readonly msg: string;
    };
export type WorkerEventName = WorkerEvent['e'];

// ---- messages ------------------------------------------------------------------------------

export interface RequestMsg<M extends WorkerMethod = WorkerMethod> {
  readonly op: 'req';
  /** 0..2^31-1, unique among the host's requests in flight. */
  readonly id: number;
  readonly m: M;
  readonly a: ArgsOf<M>;
}

export type ResponseMsg =
  | { readonly op: 'res'; readonly id: number; readonly ok: true; readonly r: unknown }
  | { readonly op: 'res'; readonly id: number; readonly ok: false; readonly e: WireError };

export type HostToWorker = RequestMsg;
export type WorkerToHost = ResponseMsg | WorkerEvent;

/** The largest request id. */
export const MAX_MSG_ID = 0x7fffffff;
