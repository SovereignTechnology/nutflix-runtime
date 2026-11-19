/**
 * The worker's NFX-12 key pairs, derived by name from a Corestore's primary key as nutflix-pear
 * derives them (`Corestore.createKeyPair`, stable across runs): `nfx:<namespace>:seeder` for the
 * listener its beacons name (`./nfx/seeding.ts` `seederKeyName`) and `nfx:<namespace>:watcher`
 * for its dials (`./nfx/watching.ts` `watcherKeyName`). One pair per network and role, never
 * shared with another protocol (NFX-12 §1). The secret keys stay in this process.
 */
import type { PeerKeyPair } from '@sovit/seeder';
import Corestore from 'corestore';

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
