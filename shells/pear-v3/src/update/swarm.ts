/**
 * The updater's swarm (`./update-worker.ts`): a client of one public drive. It joins the drive's
 * discovery topic as a client only, announces nothing and serves no topic of its own.
 *
 *   - **Its Noise key pair is new every run, and never derived from the store.** `pear-runtime`
 *     1.3.1, whose `_open()` this follows, uses `store.createKeyPair('pear-runtime')`, which is
 *     the same on every run. Anyone announcing on the public drive's topic would then see that key
 *     on each of a user's update checks and could link them across days and addresses: the
 *     linkage the worker's watcher key no longer allows either. Nothing needs it stable: the swarm
 *     only dials, the store replicates over any Noise stream, and `pear-runtime-updater` 3.4.0
 *     never sees the swarm or its key.
 *   - **No local addresses to the drive's peers on a release root** (no DHT named):
 *     `hideLocalAddressesOn` (`packages/worker/src/net/no-local-addresses.ts`). A test build's
 *     private DHT (127.0.0.1 nodes only, refused in a release root, so no release and no run-time
 *     input reaches it) keeps the swarm's own node and its defaults. Its peer is Pear's sidecar on
 *     this machine, bound to every interface, and on one host hyperdht carries data only between
 *     peers that share local addresses and bind alike (measured; see that file).
 */
import { hideLocalAddressesOn } from '@nutflix-runtime/worker/no-local-addresses';
import DHT from 'hyperdht';
import Hyperswarm from 'hyperswarm';

/** `testDht`: a test build's private bootstrap; `null` on a release root (the public DHT). */
export function updaterSwarm(
  testDht: readonly { host: string; port: number }[] | null,
): Hyperswarm {
  return new Hyperswarm({
    keyPair: DHT.keyPair(),
    ...(testDht === null
      ? { dht: hideLocalAddressesOn(new DHT()) }
      : { bootstrap: [...testDht] }),
  });
}
