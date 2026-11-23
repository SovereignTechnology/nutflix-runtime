/**
 * Reading a kind-30071 release notice (ADR 0001 decision 2, S2). A relay is not trusted: anything
 * it sends is `unknown` until it has passed, in this order, the size bounds, the shape, the kind,
 * the author, the `d` tag, the event's id and Schnorr signature (`nostr-tools`, no crypto of our
 * own), and the notice's own fields.
 *
 * The shape is nutflix-pear's (`scripts/release-manifest.mjs`, at the submodule's pinned commit)
 * with one tag more, the build's versioned link:
 *
 *   ["d", "nutflix-runtime"]
 *   ["version", "0.1.2"]
 *   ["verlink", "pear://<fork>.<length>.<key>"]
 *   ["artifact", "Nutflix-linux-x64.AppImage", "<sha256>", "<bytes>"]   one per target
 *
 * Which notice counts: the highest `created_at`, and on a tie the lowest `id` (NIP-01's rule for
 * replaceable events). A notice from more than a day in the future is refused, so that one bad
 * clock cannot pin the floor below.
 */
import { verifyEvent } from 'nostr-tools/pure';

import { NOTICE_D, NOTICE_KIND, type TrustRoot } from './root.ts';
import { PLAIN_VERSION, type UpdateReason } from './status.ts';

export const MAX_NOTICE_TAGS = 32;
export const MAX_TAG_ITEMS = 6;
export const MAX_TAG_CHARS = 512;
export const MAX_CONTENT_CHARS = 16 * 1024;
export const MAX_ARTIFACTS = 16;
export const MAX_FUTURE_S = 24 * 60 * 60;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
export const VERLINK =
  /^pear:\/\/[0-9]{1,15}\.[0-9]{1,15}\.[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
const BYTES = /^[0-9]{1,16}$/;

export interface NoticeArtifact {
  readonly sha256: string;
  readonly bytes: number;
}

export interface Notice {
  readonly id: string;
  readonly createdAt: number;
  readonly version: string;
  readonly verlink: string;
  readonly artifacts: ReadonlyMap<string, NoticeArtifact>;
}

export type NoticeRefusal =
  'shape' | 'size' | 'kind' | 'author' | 'd' | 'signature' | 'fields' | 'future';

export type NoticeResult =
  | { readonly notice: Notice; readonly refused?: undefined }
  | { readonly notice?: undefined; readonly refused: NoticeRefusal };

const no = (refused: NoticeRefusal): NoticeResult => ({ refused });

/** One relay's event as a verified notice for `root`, or why it is refused. */
export function readNotice(raw: unknown, root: TrustRoot, nowS: number): NoticeResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return no('shape');
  const e = raw as Record<string, unknown>;
  const { id, pubkey, created_at: createdAt, kind, tags, content, sig } = e;
  if (
    typeof id !== 'string' ||
    !HEX64.test(id) ||
    typeof pubkey !== 'string' ||
    !HEX64.test(pubkey) ||
    typeof sig !== 'string' ||
    !HEX128.test(sig) ||
    typeof createdAt !== 'number' ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    typeof kind !== 'number' ||
    !Number.isInteger(kind) ||
    typeof content !== 'string' ||
    !Array.isArray(tags)
  )
    return no('shape');
  if (content.length > MAX_CONTENT_CHARS || tags.length > MAX_NOTICE_TAGS) return no('size');
  const fresh: string[][] = [];
  for (const t of tags as unknown[]) {
    if (!Array.isArray(t) || t.length === 0) return no('shape');
    if (t.length > MAX_TAG_ITEMS) return no('size');
    const row: string[] = [];
    for (const v of t as unknown[]) {
      if (typeof v !== 'string') return no('shape');
      if (v.length > MAX_TAG_CHARS) return no('size');
      row.push(v);
    }
    fresh.push(row);
  }
  if (kind !== NOTICE_KIND) return no('kind');
  if (pubkey !== root.pubkey) return no('author');
  const ds = fresh.filter((t) => t[0] === 'd');
  if (ds.length !== 1 || ds[0]?.[1] !== NOTICE_D || ds[0].length !== 2) return no('d');
  if (createdAt > nowS + MAX_FUTURE_S) return no('future');

  // A fresh object: `verifyEvent` caches its verdict on what it is given.
  if (!verifyEvent({ id, pubkey, created_at: createdAt, kind, tags: fresh, content, sig }))
    return no('signature');

  const single = (name: string): string | undefined => {
    const found = fresh.filter((t) => t[0] === name);
    return found.length === 1 && found[0]?.length === 2 ? found[0][1] : undefined;
  };
  const version = single('version');
  const verlink = single('verlink');
  if (version === undefined || !PLAIN_VERSION.test(version)) return no('fields');
  if (verlink === undefined || !VERLINK.test(verlink)) return no('fields');
  const rows = fresh.filter((t) => t[0] === 'artifact');
  if (rows.length === 0 || rows.length > MAX_ARTIFACTS) return no('fields');
  const artifacts = new Map<string, NoticeArtifact>();
  for (const t of rows) {
    const [, name, sha256, bytes] = t;
    if (
      t.length !== 4 ||
      name === undefined ||
      !ARTIFACT_NAME.test(name) ||
      sha256 === undefined ||
      !HEX64.test(sha256) ||
      bytes === undefined ||
      !BYTES.test(bytes) ||
      !Number.isSafeInteger(Number(bytes)) ||
      artifacts.has(name)
    )
      return no('fields');
    artifacts.set(name, { sha256, bytes: Number(bytes) });
  }
  return { notice: { id, createdAt, version, verlink, artifacts } };
}

/** `a` is newer than `b`: a higher `created_at`, or the lower `id` of two equal ones. */
export function isNewer(
  a: { readonly createdAt: number; readonly id: string },
  b: { readonly createdAt: number; readonly id: string },
): boolean {
  return a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);
}

export function newestNotice(notices: readonly Notice[]): Notice | null {
  let best: Notice | null = null;
  for (const n of notices) if (best === null || isNewer(n, best)) best = n;
  return best;
}

/** The newest notice this install has seen: a replay of anything older is refused. */
export interface Floor {
  readonly createdAt: number;
  readonly id: string;
}

export function parseFloor(x: unknown): Floor | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  const { v, createdAt, id } = r;
  if (
    v !== 1 ||
    typeof createdAt !== 'number' ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    typeof id !== 'string' ||
    !HEX64.test(id)
  )
    return null;
  return { createdAt, id };
}

/** The build the app is deciding on. */
export interface Candidate {
  /** `pear://<fork>.<length>.<key>`. */
  readonly verlink: string;
  readonly version: string;
  /** The notice's name for this platform's artifact. */
  readonly artifact: string;
  readonly sha256: string;
}

export type Decision =
  | {
      readonly kind: 'match';
      readonly notice: Notice;
      readonly refused: number;
    }
  | {
      readonly kind: 'hold';
      readonly reason: UpdateReason;
      readonly refused: number;
      /** The newest valid notice, when there was one: it may raise the floor. */
      readonly newest: Notice | null;
    };

/**
 * What the relays' answer means for this candidate. Only an exact match on link, version and hash,
 * in the NEWEST valid notice, says `match`. An older notice that names this build does not: S2's
 * updater holds only the newest build, and the owner accepted that an unannounced newer build holds
 * back an older announced one.
 */
export function decide(o: {
  readonly events: readonly unknown[];
  readonly reached: number;
  readonly root: TrustRoot;
  readonly nowS: number;
  readonly floor: Floor | null;
  readonly candidate: Candidate;
}): Decision {
  const valid: Notice[] = [];
  let refused = 0;
  for (const raw of o.events) {
    const r = readNotice(raw, o.root, o.nowS);
    if (r.notice !== undefined) valid.push(r.notice);
    else refused++;
  }
  const newest = newestNotice(valid);
  if (newest === null)
    return {
      kind: 'hold',
      reason: o.reached === 0 ? 'relay-unreachable' : 'no-notice',
      refused,
      newest: null,
    };
  const hold = (reason: UpdateReason): Decision => ({ kind: 'hold', reason, refused, newest });
  if (o.floor !== null && newest.id !== o.floor.id && isNewer(o.floor, newest))
    return hold('stale-notice');
  if (newest.verlink !== o.candidate.verlink) return hold('link-mismatch');
  if (newest.version !== o.candidate.version) return hold('version-mismatch');
  const artifact = newest.artifacts.get(o.candidate.artifact);
  if (artifact === undefined) return hold('no-artifact');
  if (artifact.sha256 !== o.candidate.sha256) return hold('hash-mismatch');
  return { kind: 'match', notice: newest, refused };
}
