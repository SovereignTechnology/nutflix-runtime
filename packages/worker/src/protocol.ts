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
  /** A signature was asked for and no signer is connected, or the local key is locked. */
  'no-signer',
  /** The passphrase did not open the local key. */
  'bad-passphrase',
  /** Studio needs the system's ffmpeg and ffprobe, and did not find them. */
  'ffmpeg-missing',
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

/** A local key's passphrase, in UTF-16 units (ADR 0001 §8). */
export const MIN_PASSPHRASE = 8;
export const MAX_PASSPHRASE = 1024;
/** The longest `bunker://` URI `signer.nip46.connect` takes. */
export const MAX_BUNKER_URI = 2048;
/** The most relays one bunker URI may name. */
export const MAX_BUNKER_RELAYS = 4;
/**
 * The ONLY event kinds the renderer may ask the user's signer for: the kind-38504 manifest of a
 * video this node packaged. Everything else is refused before a signer is touched.
 */
export const SIGNABLE_KINDS = [38504] as const;
export const MAX_SIGN_TAGS = 128;
export const MAX_SIGN_TAG_VALUES = 8;
export const MAX_SIGN_TAG_CHARS = 1024;
export const MAX_SIGN_CONTENT = 8192;
/** A manifest someone else signed, as `seeding.watch` takes it: its description may be longer. */
export const MAX_MANIFEST_CONTENT = 64 * 1024;

/** The largest video Studio reads. */
export const MAX_SOURCE_BYTES = 16 * 1024 * 1024 * 1024;
/** The longest video Studio packages, seconds. */
export const MAX_SOURCE_SECONDS = 4 * 3600;
/** The widest or tallest frame Studio reads (8K). */
export const MAX_SOURCE_DIMENSION = 7680;
export const MAX_TITLE = 256;
export const MAX_DESCRIPTION = 8192;
export const MAX_VIDEO_TAGS = 16;
export const MAX_VIDEO_TAG = 32;
/** The most rendition sizes one video names (core's `MAX_UPLOAD_SIZES`). */
export const MAX_STUDIO_SIZES = 7;
/** The tallest rendition (core's `MAX_UPLOAD_HEIGHT`). */
export const MAX_STUDIO_HEIGHT = 2160;
/** The most files picked and not yet published that the worker remembers. */
export const MAX_STUDIO_SOURCES = 8;

/** A WebRTC segment handed to the worker: the largest file, and the largest chunk of one. */
export const MAX_OFFERED_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_OFFERED_CHUNK_BYTES = 512 * 1024;
/** `MAX_OFFERED_CHUNK_BYTES` in base64. */
export const MAX_OFFERED_CHUNK_CHARS = Math.ceil(MAX_OFFERED_CHUNK_BYTES / 3) * 4;
/** The most beacons one `seeding.beacons` signs. */
export const MAX_BEACONS = 64;
/** What "seed what you watch" may keep on disk, within the store's own cap. */
export const MAX_WATCHED_BYTES = 16 * 1024 * 1024 * 1024;
/** New videos "seed what you watch" may start storing in an hour. */
export const MAX_WATCH_STARTS_PER_HOUR = 20;

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

/** What the renderer may know of the user's signer: never a key, a passphrase or a URI. */
export interface SignerStatusWire {
  readonly kind: 'none' | 'local' | 'nip46';
  /** 64 lowercase hex, once known; a locked key file still names its public key. */
  readonly pubkey: string | null;
  /** Nothing can be signed until `signer.local.unlock`. */
  readonly locked: boolean;
  /** A sealed local key exists on this machine. */
  readonly keyFile: boolean;
}

/** An event to sign: the user's signer fills in `id`, `pubkey` and `sig`. */
export interface UnsignedEventWire {
  readonly kind: number;
  readonly created_at: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
}

export interface SignedEventWire extends UnsignedEventWire {
  readonly id: string;
  readonly pubkey: string;
  readonly sig: string;
}

/**
 * How a stored video got here. `published`: Studio packaged it, and it is served once the user has
 * confirmed and signed its manifest. `watched`: seeded because the viewer watched it with the
 * switch on, and served only while the switch stays on. `host`: stored through `nfx.seed.start`,
 * always served. `unknown`: no record says why it is here, so it is NOT served.
 */
export type SeedOrigin = 'published' | 'watched' | 'host' | 'unknown';

export interface SeedingVideoWire extends NfxStoredVideoWire {
  readonly origin: SeedOrigin;
  /** Peers can fetch it from this node right now, or will as soon as a listener is up. */
  readonly served: boolean;
}

export interface SeedingStatusWire {
  /** The Settings switch: seed what I watch. Off by default. */
  readonly watched: boolean;
  readonly videos: readonly SeedingVideoWire[];
  readonly listening: readonly NfxListenerWire[];
}

/** Seed a video the viewer is watching, from the seeders its beacons name. */
export interface SeedingWatchArgs {
  /** The open play of this video: what makes it a video the viewer is watching. */
  readonly sid: string;
  /** The video's signed kind-38504 manifest, verified again here. */
  readonly manifest: SignedEventWire;
  readonly peers: readonly NfxHyperdhtEndpointWire[];
}

/** One chunk of a file the renderer's WebRTC player verified, in order from offset 0. */
export interface SeedingSegmentArgs {
  /** The play session the file belongs to: the hash list it is checked against. */
  readonly sid: string;
  readonly sha256: string;
  /** The whole file's size, which must be the hash list's. */
  readonly size: number;
  readonly offset: number;
  /** Base64, at most `MAX_OFFERED_CHUNK_CHARS`. */
  readonly data: string;
}

export interface SeedingSegmentResult {
  /** `false`: refused or already held; the renderer stops sending this file. */
  readonly accepted: boolean;
  /** The whole file arrived and its sha256 is the hash list's. */
  readonly complete: boolean;
}

export interface StudioFfmpegWire {
  readonly found: boolean;
  readonly version?: string;
  /** How to install it on this OS, as a line of plain text. */
  readonly install: string;
}

/** A file the user picked in main's native dialog. The worker alone knows its path. */
export interface StudioSourceWire {
  /** 32 hex: what `studio.probe` and `studio.publish` take. */
  readonly source: string;
  /** The file's base name, for display. */
  readonly name: string;
  readonly bytes: number;
}

export interface StudioSizeWire {
  /** Lines of the short side (720 for 720p). */
  readonly height: number;
  /** The source's own size, which is no standard tier. */
  readonly original: boolean;
  readonly kbps: number;
}

export interface StudioProbeWire {
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly sizes: readonly StudioSizeWire[];
}

export interface StudioPublishArgs {
  readonly source: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  /** Heights from `studio.probe`, each offered and named once. */
  readonly sizes: readonly number[];
}

/** A packaged, stored video and the manifest for the user's signer to sign. */
export interface StudioPublishedWire extends NfxStoredVideoWire {
  readonly draft: UnsignedEventWire;
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
  'signer.status': [args: Record<string, never>, result: SignerStatusWire];
  /** Make a new key in the worker, sealed under the passphrase. Refused if one exists. */
  'signer.local.create': [args: { readonly passphrase: string }, result: SignerStatusWire];
  'signer.local.unlock': [args: { readonly passphrase: string }, result: SignerStatusWire];
  /** Connect a NIP-46 bunker; its session lives in the worker. */
  'signer.nip46.connect': [args: { readonly uri: string }, result: SignerStatusWire];
  /** Zero the local key, or close the bunker session. */
  'signer.lock': [args: Record<string, never>, result: SignerStatusWire];
  /**
   * MAIN ONLY: what `signer.sign` would sign, for the native confirmation: refused unless it is
   * the exact draft Studio made.
   */
  'signer.check': [
    args: { readonly event: UnsignedEventWire },
    result: { readonly video: string; readonly title: string; readonly signer: string },
  ];
  /**
   * MAIN ONLY, after the user confirmed: sign the draft Studio made. Signing it starts serving the
   * video, which shares the user's IP address, so a window reaches it only via `app.publish.sign`.
   */
  'signer.sign': [args: { readonly event: UnsignedEventWire }, result: SignedEventWire];
  'seeding.status': [args: Record<string, never>, result: SeedingStatusWire];
  /** The switch. MAIN ONLY: turning it on takes the user's answer to a native dialog. */
  'seeding.set': [args: { readonly watched: boolean }, result: SeedingStatusWire];
  /** Store and seed a video being watched. Refused while the switch is off. */
  'seeding.watch': [args: SeedingWatchArgs, result: NfxStoredVideoWire];
  /** Stop serving a video and delete it from the store. */
  'seeding.stop': [args: { readonly video: string }, result: { readonly removed: boolean }];
  /** A fresh signed kind-20464 beacon for every video served now, for the renderer to publish. */
  'seeding.beacons': [
    args: Record<string, never>,
    result: { readonly events: readonly SignedEventWire[] },
  ];
  'seeding.segment': [args: SeedingSegmentArgs, result: SeedingSegmentResult];
  'studio.ffmpeg': [args: Record<string, never>, result: StudioFfmpegWire];
  /** MAIN ONLY: the path the user picked in the native dialog. */
  'studio.source': [args: { readonly path: string }, result: StudioSourceWire];
  'studio.probe': [args: { readonly source: string }, result: StudioProbeWire];
  /** Encode, package and store; answers with the manifest draft. One at a time. */
  'studio.publish': [args: StudioPublishArgs, result: StudioPublishedWire];
  /** Kill the running encode, if any. */
  'studio.cancel': [args: Record<string, never>, result: { readonly cancelled: boolean }];
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
  'signer.status',
  'signer.local.create',
  'signer.local.unlock',
  'signer.nip46.connect',
  'signer.lock',
  'signer.check',
  'signer.sign',
  'seeding.status',
  'seeding.set',
  'seeding.watch',
  'seeding.stop',
  'seeding.beacons',
  'seeding.segment',
  'studio.ffmpeg',
  'studio.source',
  'studio.probe',
  'studio.publish',
  'studio.cancel',
] as const satisfies readonly WorkerMethod[];

/**
 * What a window may ask of main itself: answered by the shell (`rpc-gate.ts`), never forwarded to
 * the worker. `app.pickVideo` opens the native file dialog, so a page never names a path;
 * `app.seeding.set` turns the seeding switch, on only after a native confirmation;
 * `app.publish.sign` signs Studio's draft, and so starts seeding it, only after another.
 */
export interface WindowMethodTable {
  'app.pickVideo': [args: Record<string, never>, result: StudioSourceWire | null];
  'app.seeding.set': [args: { readonly on: boolean }, result: SeedingStatusWire];
  'app.publish.sign': [args: { readonly event: UnsignedEventWire }, result: SignedEventWire];
}
export type WindowMethod = keyof WindowMethodTable;
export const WINDOW_METHODS = [
  'app.pickVideo',
  'app.seeding.set',
  'app.publish.sign',
] as const satisfies readonly WindowMethod[];

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
  /** A publish's progress: what it is doing now, and how far (0..100) where that is known. */
  | {
      readonly op: 'ev';
      readonly e: 'studio.progress';
      readonly stage: 'probing' | 'encoding' | 'thumbnails' | 'packaging' | 'storing';
      readonly rendition?: string;
      readonly percent?: number;
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
