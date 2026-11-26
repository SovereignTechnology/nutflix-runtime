/**
 * Where a play fetches from: the HyperDHT endpoints (`t: 'hyperdht'`, NFX-12 §2) and the HTTPS
 * origins (`t: 'https'`, NFX-05 §6) that seeders' live beacons name. Adapted from nutflix-pear's
 * `packages/app-web/src/adapter/endpoints.ts` (the submodule's pinned commit), which does the same
 * for `https` origins, without its fallback origin: a play here uses only what beacons name.
 *
 * - **Which beacons count:** each must pass core's `parseBeacon` (signature, TTL, expiry, the `a`
 *   tag against the content), name this manifest's author and address, and be free. Only each
 *   seeder's newest beacon counts (NFX-03 §2), so a seeder can withdraw an endpoint. "Endpoints
 *   come from it, trust never does": the worker checks every byte against the manifest's hash
 *   list and dials with the endpoint's key, and nfx's web player checks every byte it fetches.
 * - **HyperDHT** (`hyperdhtEndpoints`, for the worker's `nfx.play.open`): a `hyperdht` endpoint
 *   whose `bind` verifies (core's `verifyHyperdhtBind`: the peer key signed this seeder and this
 *   network), each peer key once, at most `MAX_NFX_PEERS`, in the order of the beacons, newest
 *   first. Such an endpoint carries no rendition list, so each reachable seeder holds every
 *   rendition (`all`), and `named` stays empty.
 * - **HTTPS** (`httpsOrigins`, for nfx's web player in this page; the worker fetches no `https`):
 *   - `https:` only; no user-info, query or fragment, because the player appends `/<root>/…` to
 *     the base and a query would steer its requests; a public host (`isPublicHost`), so that no
 *     beacon can point the page at the viewer's own machine or network. Reduced to
 *     `https://host[:port][/prefix]`.
 *   - What an origin serves (NFX-03 §4): its endpoint's `renditions`, absent meaning every
 *     rendition. When several seeders (or one beacon twice) name one origin, it serves only what
 *     every claim says: a beacon can narrow what an origin is taken to serve, never widen it. nfx's
 *     library takes this as a hint for the order in which it tries origins, and asks each origin
 *     itself what it holds (nfx #85). An origin left serving nothing counts for no seeder's reach.
 *   - Caps: at most `PER_BEACON` origins from one beacon, `MAX_BEACON_ORIGINS` in all, ranked by
 *     how many seeders name each, ties in the order of their beacons, newest first.
 * - **Other endpoint types** (`iroh`, `webrtc` trackers, `stun`) are not read. Peers of the WebRTC
 *   mesh, nfxd's mesh endpoint among them, are found over Nostr by room (NFX-10 §6), not by beacon.
 */
import type { NfxVideo, NostrEvent } from '@sovit/core';
import {
  KIND_MANIFEST,
  MAX_RENDITION_ID_LENGTH,
  parseBeacon,
  verifyHyperdhtBind,
  type Beacon,
} from '@sovit/core/nfx';
import {
  MAX_NFX_HELD_SEEDERS,
  MAX_NFX_PEERS,
  type NfxHeldWire,
  type NfxHyperdhtEndpointWire,
} from '@nutflix-runtime/worker';

import { isPublicHost, parseStrictUrl } from '../net/hosts.js';
import { MAX_SERVER_URL } from '../settings/validate.js';

export interface HyperdhtEndpoints {
  /** Verified endpoints, at most `MAX_NFX_PEERS`, newest beacon first. */
  readonly peers: readonly NfxHyperdhtEndpointWire[];
  /** Seeders with a valid, free beacon for this video, whatever they name. */
  readonly seeders: number;
  /** Of those, the ones naming at least one verified `hyperdht` endpoint. */
  readonly reachable: number;
  /** What those seeders hold, as `nfx.play.open` takes it. */
  readonly held: NfxHeldWire;
}

/**
 * Each seeder's newest valid beacon for `video`, newest first, if it is free and names this
 * manifest's author and address. A seeder whose newest beacon is for another video, or paid, is
 * left out whole: an older beacon of it never counts.
 */
function freeBeacons(
  video: Pick<NfxVideo, 'id' | 'author'>,
  events: readonly NostrEvent[],
  now: number,
): Beacon[] {
  const newestFirst = [...events].sort((a, b) => b.created_at - a.created_at);
  const seen = new Set<string>();
  const out: Beacon[] = [];
  for (const ev of newestFirst) {
    const parsed = parseBeacon(ev, now);
    if (!parsed.ok) continue;
    const b = parsed.value;
    // A seeder's newest valid beacon is the only one that counts, whatever it names.
    if (seen.has(b.seeder)) continue;
    seen.add(b.seeder);
    const address = `${String(KIND_MANIFEST)}:${b.creator}:${b.content.video.toString()}`;
    if (b.creator !== video.author || address !== video.id || !b.content.free) continue;
    out.push(b);
  }
  return out;
}

/** The HyperDHT endpoints `events` (beacons, any order) name for `video` at `now` (unix seconds). */
export function hyperdhtEndpoints(
  video: Pick<NfxVideo, 'id' | 'author' | 'namespace'>,
  events: readonly NostrEvent[],
  now: number,
): HyperdhtEndpoints {
  const peers = new Map<string, NfxHyperdhtEndpointWire>();
  const beacons = freeBeacons(video, events, now);
  let reachable = 0;
  for (const b of beacons) {
    let named = false;
    for (const e of b.content.endpoints) {
      if (e.t !== 'hyperdht') continue;
      if (!verifyHyperdhtBind(e.peer, e.bind, b.seeder, video.namespace)) continue;
      named = true;
      if (peers.size < MAX_NFX_PEERS && !peers.has(e.peer)) {
        peers.set(e.peer, { t: 'hyperdht', peer: e.peer, bind: e.bind });
      }
    }
    if (named) reachable += 1;
  }
  const counted = Math.min(reachable, MAX_NFX_HELD_SEEDERS);
  return {
    peers: [...peers.values()],
    seeders: beacons.length,
    reachable,
    held: { seeders: counted, all: counted, named: [] },
  };
}

// ---- HTTPS origins ---------------------------------------------------------------------------

/** At most this many origins from beacons (nfx's player reports 8). */
export const MAX_BEACON_ORIGINS = 8;
/** At most this many origins from one beacon. */
export const PER_BEACON = 4;
/** The most rendition ids one claim keeps (nfx's library: `MAX_RENDITIONS`). */
export const MAX_CLAIMED_RENDITIONS = 32;

/**
 * An origin a play may fetch from, and the renditions it is said to serve (nfx's `OriginSource`):
 * absent, every rendition; an empty list, none.
 */
export interface PlayOrigin {
  readonly url: string;
  readonly renditions?: readonly string[];
}

/** A beacon's origin as `https://host[:port][/prefix]`, or `null` when it may not be used. */
export function beaconOrigin(raw: string): string | null {
  const u = parseStrictUrl(raw, MAX_SERVER_URL);
  if (u?.protocol !== 'https:' || raw.includes('?') || raw.includes('#')) return null;
  if (!isPublicHost(u.hostname)) return null;
  const base = u.origin + u.pathname.replace(/\/+$/, '');
  return base.length <= MAX_SERVER_URL ? base : null;
}

/**
 * What an `https` endpoint's `renditions` says its origin serves: `null` for every rendition
 * (absent), else its ids of at most `MAX_RENDITION_ID_LENGTH` characters, each once, the first
 * `MAX_CLAIMED_RENDITIONS` (core's parser has already refused `''`, `meta`, a repeat and an empty
 * list). Empty (every id too long): none.
 */
export function originClaim(renditions: readonly string[] | undefined): string[] | null {
  if (renditions === undefined) return null;
  const out: string[] = [];
  for (const id of renditions) {
    if (out.length >= MAX_CLAIMED_RENDITIONS) break;
    if (id.length <= MAX_RENDITION_ID_LENGTH && !out.includes(id)) out.push(id);
  }
  return out;
}

/** What two claims about one origin leave: only what both say it serves (`null`: every one). */
export function narrowClaim(
  a: readonly string[] | null,
  b: readonly string[] | null,
): string[] | null {
  if (a === null) return b === null ? null : [...b];
  return b === null ? [...a] : a.filter((id) => b.includes(id));
}

/** `url` with `claim` as a `PlayOrigin`. */
function playOrigin(url: string, claim: readonly string[] | null): PlayOrigin {
  return claim === null ? { url } : { url, renditions: claim };
}

/** The HTTPS origins the live beacons of one video name. */
export interface HttpsOrigins {
  /** Origins with what they serve, most-named first, at most `MAX_BEACON_ORIGINS`. */
  readonly origins: readonly PlayOrigin[];
  /** Seeders with a valid, free beacon for this video, whatever they name. */
  readonly seeders: number;
  /** Of those, the ones naming an origin this client may fetch from. */
  readonly reachable: number;
}

/** The HTTPS origins `events` (beacons, any order) name for `video` at `now` (unix seconds). */
export function httpsOrigins(
  video: Pick<NfxVideo, 'id' | 'author'>,
  events: readonly NostrEvent[],
  now: number,
): HttpsOrigins {
  const beacons = freeBeacons(video, events, now);
  const origins = new Map<string, { n: number; claim: string[] | null }>();
  let reachable = 0;
  for (const b of beacons) {
    const own = new Map<string, string[] | null>();
    for (const e of b.content.endpoints) {
      if (e.t !== 'https') continue;
      const o = beaconOrigin(e.url);
      if (o === null) continue;
      const claim = originClaim(e.renditions);
      const named = own.get(o);
      // One beacon naming an origin twice narrows it too.
      if (named !== undefined) own.set(o, narrowClaim(named, claim));
      else if (own.size < PER_BEACON) own.set(o, claim);
    }
    if ([...own.values()].some((c) => c === null || c.length > 0)) reachable += 1;
    for (const [o, claim] of own) {
      const c = origins.get(o);
      if (c === undefined) origins.set(o, { n: 1, claim });
      else origins.set(o, { n: c.n + 1, claim: narrowClaim(c.claim, claim) });
    }
  }
  // `Array.prototype.sort` is stable: ties keep first-seen order.
  const ranked = [...origins].sort((x, y) => y[1].n - x[1].n);
  return {
    origins: ranked.slice(0, MAX_BEACON_ORIGINS).map(([url, { claim }]) => playOrigin(url, claim)),
    seeders: beacons.length,
    reachable,
  };
}
