/**
 * No local addresses to strangers: nutflix-pear's ADR 0023 rule 5 (no LAN candidates to a WebRTC
 * peer), applied to HyperDHT. Left to its defaults, hyperdht tells the other side of every
 * connection each local IPv4 address of this machine, LAN, VPN and container bridges included:
 *
 *   - a dialer sends them in its first handshake (`localConnection`, `lib/connect.js`);
 *   - a server sends them in every handshake reply (`shareLocalAddress`, `lib/server.js`).
 *
 * Two ways to turn both off, the same options either way:
 *   - `withoutLocalAddresses`: a view of a node, for the worker's play pool and seeds;
 *   - `hideLocalAddressesOn`: the node itself, for a library that needs all of it (shape (a)'s
 *     updater hands one to Hyperswarm on a release root).
 * The cost: two peers behind one router without NAT loopback, or two apps on one machine, may fail
 * to connect, because neither learns the other's local address.
 *
 * On one host, hyperdht 6.36.0 carries data between two peers only through their local addresses,
 * and only when both bind alike: both to every interface (they meet on a LAN address) or both to
 * 127.0.0.1. Measured in a Kata VM on a loopback testnet: with hiding on either side, or with one
 * peer bound to 127.0.0.1 and the other to every interface, the Noise stream opened and then
 * carried nothing until it timed out. So peers that are all this machine's own processes (the
 * tests, the e2e suites, the `pear run` proof) need the defaults, and the same bind.
 *
 * Hence one exception (`hidesLocalAddresses`): a node whose UDP socket is bound to 127.0.0.1
 * (`DhtNode`'s `loopbackOnly`, which the worker sets when every bootstrap is `127.0.0.1`:
 * `isLoopbackTestnet`; the test peers bind there too). Such a node can reach only this machine,
 * and its defaults leak nothing: hyperdht's `localAddresses()` of a socket bound to 127.0.0.1 is
 * that address alone (`lib/holepuncher.js`). The exception follows the bind, not the bootstrap
 * list, so a `127.0.0.1` bootstrap that is itself bridged to the public DHT gets a node that
 * cannot reach a public peer, rather than one that shares local addresses with it.
 */
import type { NfxDht } from '@sovit/seeder';
import type { ConnectOptions, Server, ServerOptions } from 'hyperdht';
import type NoiseSecretStream from '@hyperswarm/secret-stream';

import type { BootstrapNode } from '../protocol.js';

export function withoutLocalAddresses(dht: NfxDht): NfxDht {
  return {
    connect: (remotePublicKey, opts) =>
      dht.connect(remotePublicKey, { ...opts, localConnection: false }),
    createServer: (opts, onconnection) =>
      dht.createServer({ ...opts, shareLocalAddress: false }, onconnection),
  };
}

/** The two methods of a hyperdht node that `hideLocalAddressesOn` replaces. */
export interface HyperdhtNode {
  connect(remotePublicKey: Uint8Array, opts?: ConnectOptions): NoiseSecretStream;
  createServer(opts: ServerOptions, onconnection: (socket: NoiseSecretStream) => void): Server;
}

/**
 * Turns both off on `node` itself, for every later caller: its own `connect` and `createServer`
 * are replaced by ones that set the two options last, so no caller can turn them back on. For a
 * library that takes a whole node (Hyperswarm's `dht` option). Returns `node`.
 */
export function hideLocalAddressesOn<T extends HyperdhtNode>(node: T): T {
  const n: HyperdhtNode = node;
  const connect = n.connect.bind(n);
  const createServer = n.createServer.bind(n);
  n.connect = (remotePublicKey, opts) =>
    connect(remotePublicKey, { ...opts, localConnection: false });
  n.createServer = (opts, onconnection) => {
    // hyperdht also takes `createServer(onconnection)`: that form stays working, and hidden.
    if (typeof opts === 'function') return createServer({ shareLocalAddress: false }, opts);
    return createServer({ ...opts, shareLocalAddress: false }, onconnection);
  };
  return node;
}

/**
 * Whether a node's connections hide local addresses: always, unless its socket is bound to
 * 127.0.0.1. `force` (tests) can only turn hiding on. Named fields, so that the two cannot swap.
 */
export function hidesLocalAddresses(o: {
  readonly loopbackOnly: boolean;
  readonly force?: boolean;
}): boolean {
  return o.force === true || !o.loopbackOnly;
}

/**
 * Every bootstrap node is `127.0.0.1`: a test network on this machine, whose node is then bound to
 * 127.0.0.1 (`DhtNode`'s `loopbackOnly`). `null` is the public network.
 */
export function isLoopbackTestnet(bootstrap: readonly BootstrapNode[] | null): boolean {
  return (
    bootstrap !== null && bootstrap.length > 0 && bootstrap.every((b) => b.host === '127.0.0.1')
  );
}
