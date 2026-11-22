/**
 * Where a play fetches from in this version: the HyperDHT endpoints (`t: 'hyperdht'`, NFX-12 §2)
 * that seeders' live beacons name, after the checks the worker relies on the host to have made
 * (packages/worker/README.md, `nfx.play.open`). Adapted from nutflix-pear's `packages/app-web/src/
 * adapter/endpoints.ts` (the submodule's pinned commit), which does the same for `https` origins.
 *
 * - **Which beacons count:** each must pass core's `parseBeacon` (signature, TTL, expiry, the `a`
 *   tag against the content), name this manifest's author and address, and be free. Only each
 *   seeder's newest beacon counts (NFX-03 §2), so a seeder can withdraw an endpoint. "Endpoints
 *   come from it, trust never does": the worker checks every byte against the manifest's hash
 *   list, and dials with the endpoint's key.
 * - **Which endpoints count:** a `hyperdht` endpoint whose `bind` verifies (core's
 *   `verifyHyperdhtBind`: the peer key signed this seeder and this network), each peer key once.
 *   At most `MAX_NFX_PEERS`, in the order of the beacons, newest first. Endpoints of other types
 *   are not read: this slice plays over HyperDHT alone.
 * - **Held:** which renditions those seeders hold. A `hyperdht` endpoint carries no rendition
 *   list, so each reachable seeder holds every rendition (`all`), and `named` stays empty.
 */
import type { NfxVideo, NostrEvent } from '@sovit/core';
import { KIND_MANIFEST, parseBeacon, verifyHyperdhtBind } from '@sovit/core/nfx';
import {
  MAX_NFX_HELD_SEEDERS,
  MAX_NFX_PEERS,
  type NfxHeldWire,
  type NfxHyperdhtEndpointWire,
} from '@nutflix-runtime/worker';

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

/** The endpoints `events` (beacons, any order) name for `video` at `now` (unix seconds). */
export function hyperdhtEndpoints(
  video: Pick<NfxVideo, 'id' | 'author' | 'namespace'>,
  events: readonly NostrEvent[],
  now: number,
): HyperdhtEndpoints {
  const newestFirst = [...events].sort((a, b) => b.created_at - a.created_at);
  const seen = new Set<string>();
  const peers = new Map<string, NfxHyperdhtEndpointWire>();
  let seeders = 0;
  let reachable = 0;
  for (const ev of newestFirst) {
    const parsed = parseBeacon(ev, now);
    if (!parsed.ok) continue;
    const b = parsed.value;
    // A seeder's newest valid beacon is the only one that counts, whatever it names.
    if (seen.has(b.seeder)) continue;
    seen.add(b.seeder);
    const address = `${String(KIND_MANIFEST)}:${b.creator}:${b.content.video.toString()}`;
    if (b.creator !== video.author || address !== video.id || !b.content.free) continue;
    seeders += 1;
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
    seeders,
    reachable,
    held: { seeders: counted, all: counted, named: [] },
  };
}
