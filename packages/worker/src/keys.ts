/**
 * The worker's NFX-12 key pairs: one per network and role, never shared with another protocol
 * (NFX-12 §1). The secret keys stay in this process.
 *
 *   - **The seeder's** listener key, `nfx:<namespace>:seeder` (`./nfx/seeding.ts` `seederKeyName`),
 *     is derived by name from a Corestore's primary key as nutflix-pear derives it
 *     (`Corestore.createKeyPair`), so it is the same every run. It has to be: beacons name it.
 *   - **The watcher's** dial key (`WatcherKeys`) is random, one per network, made when this run
 *     first dials on that network and held only in memory. Nothing about it is written anywhere,
 *     so a seeder sees a new key every run and cannot use it to link one viewer's plays across runs
 *     (nutflix-pear ADR 0023 §3: session keys are random, per run or per play, and never the user's
 *     key or the seeder key).
 *
 * The watcher key is per run, not per play. Every play of a run shares one connection per seeder
 * (`./nfx/hyperdht-fetcher.ts` `NfxPeerPool`), seed fetches included, and a seeder caps connections
 * per remote key (`listenNfx`: 2). A key per play would open a connection per play to the same
 * seeder and make one viewer look like many to those caps. It would also hide little: within a run
 * every dial leaves from the same DHT socket, so the seeder sees the same address for each play.
 */
import type { PeerKeyPair } from '@sovit/seeder';
import Corestore from 'corestore';
import DHT from 'hyperdht';

export interface Keyring {
  /** The pair named `name` (the same pair for the same name, every run). */
  keyPair(name: string): Promise<PeerKeyPair>;
  close(): Promise<void>;
}

/** The longest key name derived (a namespace is short; this bounds the cache). */
const MAX_NAME = 160;

/** A Corestore under `dir` (created if missing), used only for its primary key. */
export async function openCorestoreKeyring(dir: string): Promise<Keyring> {
  const store = new Corestore(dir);
  await store.ready();
  const cache = new Map<string, Promise<PeerKeyPair>>();
  let closed = false;
  return {
    keyPair: (name) => {
      if (closed) return Promise.reject(new Error('backend-down: the keyring is closed'));
      if (name.length === 0 || name.length > MAX_NAME)
        return Promise.reject(new Error('invalid-argument: not a key name'));
      let kp = cache.get(name);
      if (kp === undefined) {
        kp = store.createKeyPair(name);
        cache.set(name, kp);
        void kp.catch(() => {
          cache.delete(name);
        });
      }
      return kp;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await store.close();
    },
  };
}

/**
 * This run's watcher key pairs, one per network: random (libsodium's `crypto_sign_keypair`, through
 * hyperdht), made on first use and never written anywhere. `close` overwrites the secret keys.
 */
export class WatcherKeys {
  private readonly make: () => PeerKeyPair;
  private readonly pairs = new Map<string, PeerKeyPair>();
  private closed = false;

  /** `make`: TESTS ONLY; a fresh random pair. */
  constructor(make: () => PeerKeyPair = () => DHT.keyPair()) {
    this.make = make;
  }

  /** `namespace`'s pair for this run: the same pair for every dial of the run. */
  keyPair(namespace: string): Promise<PeerKeyPair> {
    if (this.closed) return Promise.reject(new Error('backend-down: the watcher keys are gone'));
    if (namespace.length === 0 || namespace.length > MAX_NAME)
      return Promise.reject(new Error('invalid-argument: not a network'));
    let kp = this.pairs.get(namespace);
    if (kp === undefined) {
      kp = this.make();
      this.pairs.set(namespace, kp);
    }
    return Promise.resolve(kp);
  }

  /** Worker shutdown: every secret key is overwritten and forgotten. Idempotent. */
  close(): void {
    this.closed = true;
    for (const kp of this.pairs.values()) kp.secretKey.fill(0);
    this.pairs.clear();
  }
}
