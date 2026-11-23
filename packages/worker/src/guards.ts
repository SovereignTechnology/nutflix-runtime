/**
 * Runtime guards for what the host sends (`./protocol.ts`): every request is checked here before
 * a handler sees it, as nutflix-pear's `ipc/worker-guards.ts` checks its own. Strict: plain
 * objects only, no unknown keys (a JSON `"__proto__"` key is an unknown key), every string and
 * array bounded, hex lowercase, addresses canonical.
 */
import { nfx } from '@sovit/core';

import type {
  ArgsOf,
  BootstrapNode,
  InitArgs,
  NfxHeldWire,
  NfxHyperdhtEndpointWire,
  NfxPlayOpenArgs,
  NfxRenditionWire,
  NfxSeedStartArgs,
  RequestMsg,
  SeedingSegmentArgs,
  SeedingWatchArgs,
  SignedEventWire,
  StudioPublishArgs,
  UnsignedEventWire,
  WireError,
  WorkerMethod,
} from './protocol.js';
import {
  ERROR_CODES,
  MAX_BOOTSTRAP_NODES,
  MAX_BUNKER_URI,
  MAX_DESCRIPTION,
  MAX_LABEL,
  MAX_MANIFEST_CONTENT,
  MAX_MSG_ID,
  MAX_NFX_HELD_RENDITIONS,
  MAX_NFX_HELD_SEEDERS,
  MAX_NFX_PEERS,
  MAX_NFX_RENDITIONS,
  MAX_OFFERED_CHUNK_CHARS,
  MAX_OFFERED_FILE_BYTES,
  MAX_PASSPHRASE,
  MAX_PATH,
  MAX_PREFETCH_SECONDS,
  MAX_SIGN_CONTENT,
  MAX_SIGN_TAG_CHARS,
  MAX_SIGN_TAG_VALUES,
  MAX_SIGN_TAGS,
  MAX_STUDIO_HEIGHT,
  MAX_STUDIO_SIZES,
  MAX_TITLE,
  MAX_VIDEO_TAG,
  MAX_VIDEO_TAGS,
  MIN_PASSPHRASE,
  NFX_RESOLUTION,
  SIGNABLE_KINDS,
  WORKER_METHODS,
} from './protocol.js';

export type Guard<T> = (x: unknown) => x is T;

type Shape = Readonly<Record<string, Guard<unknown>>>;

function isPlain(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto: unknown = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** A plain object with exactly `required`'s keys and any of `optional`'s, each valid. */
export function obj<T>(required: Shape, optional: Shape = {}): Guard<T> {
  return (x): x is T => {
    if (!isPlain(x)) return false;
    for (const k of Object.keys(x)) if (!own(required, k) && !own(optional, k)) return false;
    for (const [k, g] of Object.entries(required)) if (!own(x, k) || !g(x[k])) return false;
    for (const [k, g] of Object.entries(optional)) if (own(x, k) && !g(x[k])) return false;
    return true;
  };
}

export const literal =
  <T extends string | number | boolean | null>(v: T): Guard<T> =>
  (x): x is T =>
    x === v;

export const oneOf =
  <T extends string>(vs: readonly T[]): Guard<T> =>
  (x): x is T =>
    typeof x === 'string' && (vs as readonly string[]).includes(x);

export const int =
  (min: number, max: number): Guard<number> =>
  (x): x is number =>
    Number.isSafeInteger(x) && (x as number) >= min && (x as number) <= max;

export const num =
  (min: number, max: number): Guard<number> =>
  (x): x is number =>
    typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;

export const bool: Guard<boolean> = (x): x is boolean => typeof x === 'boolean';

export const hex =
  (chars: number): Guard<string> =>
  (x): x is string =>
    typeof x === 'string' && x.length === chars && /^[0-9a-f]+$/.test(x);

// C0, DEL and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Text without control characters, `min`..`max` UTF-16 units. */
export const text =
  (min: number, max: number): Guard<string> =>
  (x): x is string =>
    typeof x === 'string' && x.length >= min && x.length <= max && !CONTROL.test(x);

export function arrayOf<T>(g: Guard<T>, max: number, min = 0): Guard<readonly T[]> {
  return (x): x is readonly T[] =>
    Array.isArray(x) && x.length >= min && x.length <= max && x.every((v) => g(v));
}

export function union<A, B>(a: Guard<A>, b: Guard<B>): Guard<A | B> {
  return (x): x is A | B => a(x) || b(x);
}

/** `g`, then `also` on the narrowed value. */
export function refine<T>(g: Guard<T>, also: (x: T) => boolean): Guard<T> {
  return (x): x is T => g(x) && also(x);
}

// ---- domain guards -------------------------------------------------------------------------

export const isSha256 = hex(64);
export const isSessionId = hex(32);
export const isLabel = text(1, MAX_LABEL);

/** A canonical `<namespace>:<video-id>` (NFX-01); ids are 7..63 characters (NFX-02 §2). */
export const isVideoAddr: Guard<string> = (x): x is string => {
  if (typeof x !== 'string' || x.length > 256) return false;
  const v = nfx.VideoAddr.parse(x);
  return v.ok && v.value.toString() === x;
};

/** A canonical `nfx:<network>:<specver>` (NFX-01). */
export const isNamespace: Guard<string> = (x): x is string => {
  if (typeof x !== 'string' || x.length > 128) return false;
  const n = nfx.Namespace.parse(x);
  return n.ok && n.value.toString() === x;
};

/**
 * An absolute directory the worker may own: POSIX `/…` or a Windows drive path, at least two
 * names deep, with no `.` or `..` name (the worker wipes `<storage>/tmp` at every start, so
 * `/`, `/home` or `/a/../` would point that at a directory it does not own).
 */
export const isAbsolutePath: Guard<string> = (x): x is string => {
  if (!text(1, MAX_PATH)(x)) return false;
  const drive = /^[A-Za-z]:[\\/]/.test(x);
  if (!drive && !x.startsWith('/')) return false;
  const names = x
    .slice(drive ? 3 : 1)
    .split(/[\\/]/)
    .filter((n) => n.length > 0);
  return names.length >= 2 && names.every((n) => n !== '.' && n !== '..');
};

const isBootstrapNode = obj<BootstrapNode>({
  host: refine(text(1, 253), (h) => /^[A-Za-z0-9.:-]+$/.test(h)),
  port: int(1, 65535),
});

export const isInitArgs = obj<InitArgs>(
  { v: literal(1), storage: isAbsolutePath },
  {
    bootstrap: union(literal(null), arrayOf(isBootstrapNode, MAX_BOOTSTRAP_NODES, 1)),
    diskCapBytes: int(0, Number.MAX_SAFE_INTEGER),
    logLevel: oneOf(['debug', 'info', 'warn', 'error'] as const),
  },
);

export const isEmpty = obj<Record<string, never>>({});

export const isHyperdhtEndpoint = obj<NfxHyperdhtEndpointWire>({
  t: literal('hyperdht'),
  peer: isSha256,
  bind: hex(128),
});

const isHeldPair: Guard<readonly [string, number]> = (x): x is readonly [string, number] =>
  Array.isArray(x) && x.length === 2 && isLabel(x[0]) && int(1, MAX_NFX_HELD_SEEDERS)(x[1]);

/** nutflix-pear #97's rule: counts that add up (a named holder is not one of `all`), ids once. */
const isHeld = refine(
  obj<NfxHeldWire>({
    seeders: int(1, MAX_NFX_HELD_SEEDERS),
    all: int(0, MAX_NFX_HELD_SEEDERS),
    named: arrayOf(isHeldPair, MAX_NFX_HELD_RENDITIONS),
  }),
  (h) =>
    h.all <= h.seeders &&
    h.named.every(([, n]) => n <= h.seeders - h.all) &&
    new Set(h.named.map(([k]) => k)).size === h.named.length,
);

/** A rendition's id comes from a creator's hash list: a label, nothing longer. */
export const isNfxRenditionWire = obj<NfxRenditionWire>(
  { id: isLabel, bandwidth: int(1, Number.MAX_SAFE_INTEGER) },
  { resolution: refine(text(3, 13), (r) => NFX_RESOLUTION.test(r)) },
);

const unique = (xs: readonly string[]): boolean => new Set(xs).size === xs.length;

export const isPlayOpenArgs = refine(
  obj<NfxPlayOpenArgs>(
    {
      sid: isSessionId,
      video: isVideoAddr,
      root: isSha256,
      segs: int(1, Number.MAX_SAFE_INTEGER),
      peers: arrayOf(isHyperdhtEndpoint, MAX_NFX_PEERS),
    },
    {
      renditions: arrayOf(isLabel, MAX_NFX_RENDITIONS, 1),
      held: isHeld,
      prefetchSeconds: num(0, MAX_PREFETCH_SECONDS),
      progressive: bool,
      origin: bool,
    },
  ),
  (a) =>
    (a.progressive !== false || a.origin !== false) &&
    unique(a.renditions ?? []) &&
    unique(a.peers.map((p) => p.peer)),
);

export const isSeedStartArgs = refine(
  obj<NfxSeedStartArgs>({
    video: isVideoAddr,
    root: isSha256,
    segs: int(1, Number.MAX_SAFE_INTEGER),
    peers: arrayOf(isHyperdhtEndpoint, MAX_NFX_PEERS),
  }),
  (a) => unique(a.peers.map((p) => p.peer)),
);

// ---- the signer ------------------------------------------------------------------------------

/** A passphrase: no control characters, so nothing pasted with a newline seals a key. */
export const isPassphrase = text(MIN_PASSPHRASE, MAX_PASSPHRASE);

/** The shape only; `signer/bunker.ts` parses it. No control characters, no whitespace. */
export const isBunkerUri = refine(text(10, MAX_BUNKER_URI), (u) => /^bunker:\/\/\S+$/.test(u));

/** A string of at most `max` UTF-16 units; unlike `text`, newlines are fine (a description). */
const chars =
  (max: number): Guard<string> =>
  (x): x is string =>
    typeof x === 'string' && x.length <= max && !x.includes('\u0000');

const isTag = arrayOf(chars(MAX_SIGN_TAG_CHARS), MAX_SIGN_TAG_VALUES, 1);

const eventFields = {
  created_at: int(0, Number.MAX_SAFE_INTEGER),
  tags: arrayOf(isTag, MAX_SIGN_TAGS),
  content: chars(MAX_SIGN_CONTENT),
};

/** The allow-list: a kind that is not in `SIGNABLE_KINDS` never reaches a signer. */
const isSignableKind: Guard<number> = (x): x is number =>
  (SIGNABLE_KINDS as readonly unknown[]).includes(x);

export const isUnsignedEvent = obj<UnsignedEventWire>({ kind: isSignableKind, ...eventFields });

export const isSignedManifest = obj<SignedEventWire>({
  id: isSha256,
  pubkey: isSha256,
  sig: hex(128),
  kind: literal(38504),
  ...eventFields,
  content: chars(MAX_MANIFEST_CONTENT),
});

// ---- seeding ---------------------------------------------------------------------------------

export const isSeedingWatchArgs = refine(
  obj<SeedingWatchArgs>({
    sid: isSessionId,
    manifest: isSignedManifest,
    peers: arrayOf(isHyperdhtEndpoint, MAX_NFX_PEERS),
  }),
  (a) => unique(a.peers.map((p) => p.peer)),
);

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export const isSeedingSegmentArgs = refine(
  obj<SeedingSegmentArgs>({
    sid: isSessionId,
    sha256: isSha256,
    size: int(1, MAX_OFFERED_FILE_BYTES),
    offset: int(0, MAX_OFFERED_FILE_BYTES - 1),
    data: (x): x is string =>
      typeof x === 'string' &&
      x.length >= 4 &&
      x.length <= MAX_OFFERED_CHUNK_CHARS &&
      x.length % 4 === 0 &&
      BASE64.test(x),
  }),
  (a) => a.offset < a.size,
);

// ---- Studio ----------------------------------------------------------------------------------

/** A hashtag: one word, as NFX-02's `t` tags carry them. */
const isVideoTag = refine(text(1, MAX_VIDEO_TAG), (t) => !/\s/.test(t));

export const isStudioPublishArgs = refine(
  obj<StudioPublishArgs>({
    source: isSessionId,
    title: refine(text(1, MAX_TITLE), (t) => t.trim() !== ''),
    description: chars(MAX_DESCRIPTION),
    tags: arrayOf(isVideoTag, MAX_VIDEO_TAGS),
    sizes: arrayOf(int(2, MAX_STUDIO_HEIGHT), MAX_STUDIO_SIZES, 1),
  }),
  (a) => new Set(a.sizes).size === a.sizes.length && unique([...a.tags]),
);

/** Arguments of every method: a missing entry is a compile error. */
export const validateArgs: { readonly [M in WorkerMethod]: Guard<ArgsOf<M>> } = {
  init: isInitArgs,
  status: isEmpty,
  'nfx.play.open': isPlayOpenArgs,
  'nfx.play.close': obj<ArgsOf<'nfx.play.close'>>({ sid: isSessionId }),
  'nfx.seed.start': isSeedStartArgs,
  'nfx.seed.stop': obj<ArgsOf<'nfx.seed.stop'>>({ video: isVideoAddr }),
  'nfx.seed.list': isEmpty,
  'nfx.endpoint': obj<ArgsOf<'nfx.endpoint'>>({ seeder: isSha256, namespace: isNamespace }),
  'signer.status': isEmpty,
  'signer.local.create': obj<ArgsOf<'signer.local.create'>>({ passphrase: isPassphrase }),
  'signer.local.unlock': obj<ArgsOf<'signer.local.unlock'>>({ passphrase: isPassphrase }),
  'signer.nip46.connect': obj<ArgsOf<'signer.nip46.connect'>>({ uri: isBunkerUri }),
  'signer.lock': isEmpty,
  'signer.check': obj<ArgsOf<'signer.check'>>({ event: isUnsignedEvent }),
  'signer.sign': obj<ArgsOf<'signer.sign'>>({ event: isUnsignedEvent }),
  'seeding.status': isEmpty,
  'seeding.set': obj<ArgsOf<'seeding.set'>>({ watched: bool }),
  'seeding.watch': isSeedingWatchArgs,
  'seeding.stop': obj<ArgsOf<'seeding.stop'>>({ video: isVideoAddr }),
  'seeding.beacons': isEmpty,
  'seeding.segment': isSeedingSegmentArgs,
  'studio.ffmpeg': isEmpty,
  'studio.source': obj<ArgsOf<'studio.source'>>({ path: isAbsolutePath }),
  'studio.probe': obj<ArgsOf<'studio.probe'>>({ source: isSessionId }),
  'studio.publish': isStudioPublishArgs,
  'studio.cancel': isEmpty,
};

const isMethod = oneOf<WorkerMethod>(WORKER_METHODS);

/** A request whose method is known and whose arguments are valid. */
export function isRequest(x: unknown): x is RequestMsg {
  if (!isPlain(x)) return false;
  if (Object.keys(x).some((k) => k !== 'op' && k !== 'id' && k !== 'm' && k !== 'a')) return false;
  if (x['op'] !== 'req' || !int(0, MAX_MSG_ID)(x['id']) || !isMethod(x['m'])) return false;
  return (validateArgs[x['m']] as Guard<unknown>)(x['a']);
}

/** The id of a frame that looks like a request, to answer its refusal; else `null`. */
export function requestId(x: unknown): number | null {
  if (!isPlain(x) || x['op'] !== 'req') return null;
  const id = x['id'];
  return int(0, MAX_MSG_ID)(id) ? id : null;
}

export const isWireError = obj<WireError>({
  code: oneOf(ERROR_CODES),
  message: text(1, 512),
});
