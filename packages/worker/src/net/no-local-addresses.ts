/**
 * No local addresses to strangers: nutflix-pear's ADR 0023 rule 5 (no LAN candidates to a WebRTC
 * peer), applied to HyperDHT. Left to its defaults, hyperdht tells the other side of every
 * connection each local IPv4 address of this machine, LAN, VPN and container bridges included:
 *
 *   - a dialer sends them in its first handshake (`localConnection`, `lib/connect.js`);
 *   - a server sends them in every handshake reply (`shareLocalAddress`, `lib/server.js`).
 *
 * The worker hands `@sovit/seeder`'s `dialNfx` and `listenNfx` this view of its DHT node, which
 * turns both off. The cost: a viewer and a seeder on the same LAN, behind a router without NAT
 * loopback, may fail to connect, because neither learns the other's LAN address.
 */
import type { NfxDht } from '@sovit/seeder';

export function withoutLocalAddresses(dht: NfxDht): NfxDht {
  return {
    connect: (remotePublicKey, opts) =>
      dht.connect(remotePublicKey, { ...opts, localConnection: false }),
    createServer: (opts, onconnection) =>
      dht.createServer({ ...opts, shareLocalAddress: false }, onconnection),
  };
}
