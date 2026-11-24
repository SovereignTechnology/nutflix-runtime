/**
 * Kind-20464 beacons (NFX-03), signed here by the seeder key and handed to the renderer, which
 * alone speaks to relays. One per video served, naming this node's NFX-12 listener:
 *
 *   - **never a listener that is down:** no endpoint, no beacon, so asking cannot start a DHT node;
 *   - **free:** `free: true`, `price_hint: 0`, no mints (no `pay/1` here);
 *   - **self-checked** with core's `parseBeacon` before it leaves.
 *
 * TTL 120 s, for a renderer that asks every 60 s (NFX-03 §3).
 */
import { nfx } from '@sovit/core';
import type { HyperdhtEndpoint } from '@sovit/seeder';

import type { SignedEventWire } from '../protocol.js';
import { MAX_BEACONS } from '../protocol.js';
import type { SeederKeys } from './seeder-key.js';

export const BEACON_TTL_S = 120;

export interface BeaconTarget {
  readonly video: string;
  readonly author: string;
}

export interface BeaconDeps {
  /** The videos served now whose author is known. */
  readonly targets: () => readonly BeaconTarget[];
  readonly keys: SeederKeys;
  /** This node's endpoint for `seeder` on `namespace`, while it listens there; else `null`. */
  readonly endpoint: (seeder: string, namespace: string) => Promise<HyperdhtEndpoint | null>;
  readonly now: () => number;
}

export async function signBeacons(d: BeaconDeps): Promise<SignedEventWire[]> {
  const out: SignedEventWire[] = [];
  const now = d.now();
  for (const t of d.targets().slice(0, MAX_BEACONS)) {
    const addr = nfx.VideoAddr.parse(t.video);
    if (!addr.ok) continue;
    const namespace = addr.value.namespace.toString();
    const key = await d.keys.key(namespace);
    const endpoint = await d.endpoint(key.pubkey, namespace);
    if (endpoint === null) continue;
    const address = `${String(nfx.KIND_MANIFEST)}:${t.author}:${t.video}`;
    const tags = nfx.beaconTags(address, now, BEACON_TTL_S);
    if (!tags.ok) continue;
    const event = key.signBeacon({
      kind: nfx.KIND_BEACON,
      created_at: now,
      tags: tags.value,
      content: nfx.beaconContentText({
        v: 1,
        video: addr.value,
        endpoints: [endpoint],
        skipped: [],
        chunks: 'all',
        priceHint: 0n,
        acceptsMints: [],
        free: true,
      }),
    });
    const check = nfx.parseBeacon(event, now);
    if (!check.ok || check.value.seeder !== key.pubkey) continue;
    out.push(event);
  }
  return out;
}
