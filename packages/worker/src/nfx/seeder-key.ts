/**
 * The seeder's Nostr key: a key of this node's own, per network, that signs its kind-20464 beacons
 * and nothing else (NFX-03 names a seeder by its key, never the creator's). A bunker could not
 * approve a signature a minute, and a viewer who only seeds has no signer at all.
 *
 * It is derived from the Corestore's key pair `nfx:<namespace>:beacon` (`../keys.ts`), so it is
 * stable across runs and adds no file. ADR 0001's amendment treats it as a network identity that
 * is exposed: it can announce this node, and sign nothing of the user's.
 */
import type { NostrEvent } from '@sovit/core';
import { nfx } from '@sovit/core';
import type { PeerKeyPair } from '@sovit/seeder';
import { fromHex } from '@sovit/seeder';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';

import { sha256Hex } from '../crypto.js';
import { fail } from '../errors.js';

const DOMAIN = 'nutflix-runtime/nfx-seeder-nostr-key/1';

export const beaconKeyName = (namespace: string): string => `nfx:${namespace}:beacon`;

export interface BeaconDraft {
  readonly kind: number;
  readonly created_at: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
}

export class SeederKey {
  readonly pubkey: string;
  readonly #sk: Uint8Array;

  private constructor(sk: Uint8Array, pubkey: string) {
    this.#sk = sk;
    this.pubkey = pubkey;
  }

  /** The key for `pair`: sha256 of a domain string and the pair's seed, a valid secp256k1 scalar. */
  static fromPair(pair: PeerKeyPair): SeederKey {
    const domain = new TextEncoder().encode(DOMAIN);
    const seed = pair.secretKey.subarray(0, 32);
    for (let counter = 0; counter < 256; counter++) {
      const input = new Uint8Array(domain.length + seed.length + 1);
      input.set(domain, 0);
      input.set(seed, domain.length);
      input[input.length - 1] = counter;
      const sk = fromHex(sha256Hex(input));
      input.fill(0);
      try {
        return new SeederKey(sk, getPublicKey(sk));
      } catch {
        // Past the curve's order, about one time in 2^128.
        sk.fill(0);
      }
    }
    fail('internal', 'no seeder key could be derived');
  }

  /** Signs a beacon, and refuses every other kind. */
  signBeacon(draft: BeaconDraft): NostrEvent {
    if (draft.kind !== nfx.KIND_BEACON) fail('invalid-argument', 'the seeder key signs beacons');
    return JSON.parse(
      JSON.stringify(
        finalizeEvent(
          {
            kind: draft.kind,
            created_at: draft.created_at,
            tags: draft.tags.map((t) => [...t]),
            content: draft.content,
          },
          this.#sk,
        ),
      ),
    ) as NostrEvent;
  }

  wipe(): void {
    this.#sk.fill(0);
  }
}

/** One key per network, derived on first use. */
export class SeederKeys {
  readonly #pair: (name: string) => Promise<PeerKeyPair>;
  readonly #held = new Map<string, Promise<SeederKey>>();

  constructor(pair: (name: string) => Promise<PeerKeyPair>) {
    this.#pair = pair;
  }

  key(namespace: string): Promise<SeederKey> {
    let k = this.#held.get(namespace);
    if (k === undefined) {
      k = this.#pair(beaconKeyName(namespace)).then((p) => SeederKey.fromPair(p));
      this.#held.set(namespace, k);
      void k.catch(() => {
        this.#held.delete(namespace);
      });
    }
    return k;
  }

  async close(): Promise<void> {
    const held = [...this.#held.values()];
    this.#held.clear();
    for (const k of held) (await k.catch(() => null))?.wipe();
  }
}
