/**
 * No local addresses to strangers: nutflix-pear's ADR 0023 rule 5 (no LAN candidates to a WebRTC
 * peer), applied to HyperDHT. Left to its defaults, hyperdht tells the other side of every
 * connection each local IPv4 address of this machine, LAN, VPN and container bridges included:
 *
 *   - a dialer sends them in its first handshake (`localConnection`, `lib/connect.js`);
 *   - a server sends them in every handshake reply (`shareLocalAddress`, `lib/server.js`).
 *
 * The host hands the play pool and the seeds this view of its DHT node, which turns both off. The
 * cost: two peers behind one router without NAT loopback, or two apps on one machine, may fail to
 * connect, because neither learns the other's local address.
 *
 * One exception, `isLoopbackTestnet`: a node whose every bootstrap is `127.0.0.1` lives on a test
 * network of this machine's own processes (the tests, the e2e suites, the `pear run` proof), where
 * the local address is the only way two of them meet. It keeps hyperdht's defaults. A shell that
 * points a node at a `127.0.0.1` bootstrap which itself reaches the public network would get the
 * defaults too; no shell here does.
 */
import type { NfxDht } from '@sovit/seeder';

import type { BootstrapNode } from '../protocol.js';

export function withoutLocalAddresses(dht: NfxDht): NfxDht {
  return {
    connect: (remotePublicKey, opts) =>
      dht.connect(remotePublicKey, { ...opts, localConnection: false }),
    createServer: (opts, onconnection) =>
      dht.createServer({ ...opts, shareLocalAddress: false }, onconnection),
  };
}

/** Every bootstrap node is `127.0.0.1`: a test network on this machine. `null` is the public one. */
export function isLoopbackTestnet(bootstrap: readonly BootstrapNode[] | null): boolean {
  return (
    bootstrap !== null && bootstrap.length > 0 && bootstrap.every((b) => b.host === '127.0.0.1')
  );
}
