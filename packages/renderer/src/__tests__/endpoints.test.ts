// @vitest-environment node
/**
 * Which HyperDHT endpoints a play may hand the worker: only a seeder's newest valid free beacon,
 * and only an endpoint whose `bind` names that seeder on this network (NFX-12 §2). Which `https`
 * origins nfx's web player may fetch from (NFX-05 §6): `https:`, no user-info, query or fragment,
 * a public host, at most 4 per beacon and 8 in all, what each serves narrowed by every claim.
 * Beacons are really signed. The origin vectors are nutflix-pear's (`app-web`'s endpoint tests).
 */
import { describe, expect, it } from 'vitest';

import type { NfxVideo } from '@sovit/core';
import { hyperdhtEndpoint } from '@sovit/seeder';
import DHT from 'hyperdht';

import {
  MAX_BEACON_ORIGINS,
  MAX_CLAIMED_RENDITIONS,
  beaconOrigin,
  httpsOrigins,
  hyperdhtEndpoints,
  narrowClaim,
  originClaim,
} from '../adapter/endpoints.js';
import {
  Key,
  NS,
  T,
  addrOf,
  beacon,
  hyperdht,
  https,
  seederBeacon,
  webrtc,
} from './support/nfx.js';

const creator = new Key();
const addr = addrOf(creator, 'video-one');
const video: Pick<NfxVideo, 'id' | 'author' | 'namespace'> = {
  id: addr,
  author: creator.pubkey as NfxVideo['author'],
  namespace: NS,
};

describe('hyperdhtEndpoints', () => {
  it('counts a seeder once, by its newest beacon: a withdrawn endpoint is gone', () => {
    const s = new Key();
    const old = hyperdht(s);
    const fresh = hyperdht(s);
    const got = hyperdhtEndpoints(
      video,
      [
        beacon(s, addr, [old], { createdAt: T - 30 }),
        beacon(s, addr, [fresh], { createdAt: T - 5 }),
      ],
      T,
    );
    expect(got.peers.map((p) => p.peer)).toEqual([fresh.peer]);
    expect(got).toMatchObject({ seeders: 1, reachable: 1, held: { seeders: 1, all: 1 } });
  });

  it('counts nobody whose endpoint is bound to another seeder or another network (core refuses the beacon whole)', () => {
    const s = new Key();
    const forged = hyperdht(new Key());
    const wrongNs = hyperdhtEndpoint(DHT.keyPair(), s.pubkey, 'nfx:othernet:1');
    const got = hyperdhtEndpoints(
      video,
      [
        beacon(s, addr, [forged]),
        beacon(new Key(), addr, [{ t: 'hyperdht', peer: wrongNs.peer, bind: wrongNs.bind }]),
        beacon(s, addr, [{ t: 'hyperdht', peer: wrongNs.peer, bind: wrongNs.bind }]),
      ],
      T,
    );
    expect(got).toMatchObject({
      peers: [],
      seeders: 0,
      reachable: 0,
      held: { seeders: 0, all: 0 },
    });
  });

  it('keeps each peer key once, at most sixteen, newest beacon first', () => {
    const seeders = Array.from({ length: 20 }, () => new Key());
    const eps = seeders.map((s) => hyperdht(s));
    const events = seeders.map((s, i) => beacon(s, addr, [eps[i]!], { createdAt: T - i }));
    const got = hyperdhtEndpoints(video, [...events, ...events.slice(0, 3)], T);
    expect(got.peers).toHaveLength(16);
    expect(got.peers.map((p) => p.peer)).toEqual(eps.slice(0, 16).map((e) => e.peer));
    expect(got.seeders).toBe(20);
  });

  it('ignores paid beacons, other videos, other creators, expired and malformed ones', () => {
    const s = new Key();
    const e = hyperdht(s);
    const got = hyperdhtEndpoints(
      video,
      [
        beacon(s, addr, [e], { free: false }),
        seederBeacon(addrOf(creator, 'video-two')).event,
        seederBeacon(addrOf(new Key(), 'video-one')).event,
        seederBeacon(addr, { createdAt: T - 500 }).event,
        { not: 'an event' } as never,
      ],
      T,
    );
    expect(got).toMatchObject({ peers: [], seeders: 0, reachable: 0 });
  });

  it('reads only hyperdht endpoints: an https origin makes a seeder, not a peer', () => {
    const got = hyperdhtEndpoints(
      video,
      [beacon(new Key(), addr, [https('https://seed.example/o')])],
      T,
    );
    expect(got).toMatchObject({ peers: [], seeders: 1, reachable: 0 });
  });
});

describe('beaconOrigin: https only, no query, fragment or credentials, a public host', () => {
  it.each([
    ['https://cdn.example/o', 'https://cdn.example/o'],
    ['https://cdn.example/o/', 'https://cdn.example/o'],
    ['https://cdn.example', 'https://cdn.example'],
    ['https://CDN.Example:8443/a/b//', 'https://cdn.example:8443/a/b'],
    ['https://cdn.example:443/o', 'https://cdn.example/o'],
    ['https://web.nutflix.xyz/o', 'https://web.nutflix.xyz/o'],
    ['https://93.184.215.14/o', 'https://93.184.215.14/o'],
    ['https://[2606:4700::6810:84e5]/o', 'https://[2606:4700::6810:84e5]/o'],
  ])('%s → %s', (raw, base) => {
    expect(beaconOrigin(raw)).toBe(base);
  });

  it.each([
    ['http://cdn.example/o', 'plain http'],
    ['http://93.184.215.14/o', 'plain http to a public address'],
    ['wss://cdn.example/o', 'not https'],
    ['https://cdn.example/o?x=1', 'a query'],
    ['https://cdn.example/o?', 'an empty query'],
    ['https://cdn.example/o#x', 'a fragment'],
    ['https://cdn.example/o#', 'an empty fragment'],
    ['https://user:pw@cdn.example/o', 'credentials'],
    ['https://user@cdn.example/o', 'a user name'],
    ['https://@cdn.example/o', 'an empty user-info'],
    ['https://evil.example\\@cdn.example/o', 'a backslash'],
    ['https://cdn.exa\tmple/o', 'a tab the parser would drop'],
    ['https://localhost/o', 'localhost'],
    ['https://a.localhost/o', 'a name under localhost'],
    ['https://127.0.0.1/o', 'loopback'],
    ['https://127.0.0.1:41234/o', 'loopback, on a worker-like port'],
    ['https://0x7f.1/o', 'loopback, spelt in hex'],
    ['https://2130706433/o', 'loopback, as one number'],
    ['https://0.0.0.0/o', 'this network'],
    ['https://192.168.1.1/o', 'a LAN address'],
    ['https://10.0.0.8/o', 'a private address'],
    ['https://172.16.5.4/o', 'a private address (172.16/12)'],
    ['https://100.100.12.34/o', 'CGNAT'],
    ['https://169.254.169.254/o', 'link-local (cloud metadata)'],
    ['https://[::1]/o', 'IPv6 loopback'],
    ['https://[fe80::1]/o', 'IPv6 link-local'],
    ['https://[fd00::1]/o', 'IPv6 unique-local'],
    ['https://[::ffff:127.0.0.1]/o', 'IPv4-mapped loopback'],
    ['https://[::ffff:192.168.0.1]/o', 'IPv4-mapped LAN'],
    ['https://router/o', 'a single label'],
    ['https://nas.local/o', 'mDNS'],
    ['https://box.internal/o', '.internal'],
    ['https://pc.lan/o', '.lan'],
    ['https://printer.home.arpa/o', 'home.arpa'],
    [`https://cdn.example/${'a'.repeat(600)}`, 'too long'],
    ['not a url', 'not a URL'],
    ['//cdn.example/o', 'no scheme'],
  ])('%s is refused (%s)', (raw) => {
    expect(beaconOrigin(raw)).toBeNull();
  });
});

describe('httpsOrigins: free beacons for this address only, newest per seeder', () => {
  it('takes https origins, drops every other endpoint, ranks by how many seeders name each', () => {
    const s1 = new Key();
    const s2 = new Key();
    const events = [
      beacon(s1, addr, [
        https('https://a.example/o'),
        https('https://b.example/o?steer=1'),
        webrtc('wss://t1.example/announce'),
        hyperdht(s1),
        { t: 'iroh', node: 'a'.repeat(64), relay: '', addrs: [], tickets: {} },
      ]),
      beacon(s2, addr, [https('https://c.example/o'), https('https://a.example/o/')]),
    ];
    expect(httpsOrigins(video, events, T)).toEqual({
      origins: [{ url: 'https://a.example/o' }, { url: 'https://c.example/o' }],
      seeders: 2,
      reachable: 2,
    });
  });

  it('at most 4 origins from one beacon and 8 in all', () => {
    const many = (k: number, n: number): ReturnType<typeof https>[] =>
      Array.from({ length: n }, (_, i) => https(`https://o${String(k)}-${String(i)}.example/o`));
    const events = [0, 1, 2].map((k) => beacon(new Key(), addr, many(k, 6)));
    const found = httpsOrigins(video, events, T);
    expect(found.origins).toHaveLength(MAX_BEACON_ORIGINS);
    // The first four of each beacon: twelve in all, eight kept.
    expect(found.origins.every((o) => /o[0-2]-[0-3]\./.test(o.url))).toBe(true);
    expect(found.reachable).toBe(3);
  });

  it('a refused origin does not take one of a beacon’s four places', () => {
    const ev = beacon(new Key(), addr, [
      https('https://127.0.0.1/o'),
      https('https://10.0.0.1/o'),
      https('https://nas.local/o'),
      https('https://cdn.example/o?x=1'),
      https('https://kept.example/o'),
    ]);
    expect(httpsOrigins(video, [ev], T).origins).toEqual([{ url: 'https://kept.example/o' }]);
  });

  it('a beacon naming a plain-http origin is refused whole by core: nothing in it counts', () => {
    const s = new Key();
    const ev = beacon(s, addr, [
      https('http://plain.example/o'),
      https('https://ok.example/o'),
      hyperdht(s),
    ]);
    expect(httpsOrigins(video, [ev], T)).toEqual({ origins: [], seeders: 0, reachable: 0 });
    expect(hyperdhtEndpoints(video, [ev], T)).toMatchObject({ peers: [], seeders: 0 });
  });

  it('a paid beacon, another creator’s video of the same id, another video: none counts', () => {
    const events = [
      beacon(new Key(), addr, [https('https://paid.example/o')], { free: false }),
      beacon(new Key(), addrOf(new Key(), 'video-one'), [https('https://other-creator.example/o')]),
      beacon(new Key(), addrOf(creator, 'video-two'), [https('https://other.example/o')]),
    ];
    expect(httpsOrigins(video, events, T)).toEqual({ origins: [], seeders: 0, reachable: 0 });
  });

  it('only a seeder’s newest beacon counts: it can withdraw an origin', () => {
    const s = new Key();
    const events = [
      beacon(s, addr, [https('https://old.example/o')], { createdAt: T - 30 }),
      beacon(s, addr, [https('https://new.example/o')], { createdAt: T - 5 }),
    ];
    expect(httpsOrigins(video, events, T).origins).toEqual([{ url: 'https://new.example/o' }]);
    // A newest beacon naming no origin at all withdraws it whole.
    const gone = [
      beacon(s, addr, [https('https://old.example/o')], { createdAt: T - 30 }),
      beacon(s, addr, [hyperdht(s)], { createdAt: T - 5 }),
    ];
    expect(httpsOrigins(video, gone, T)).toEqual({ origins: [], seeders: 1, reachable: 0 });
    expect(hyperdhtEndpoints(video, gone, T).reachable).toBe(1);
  });

  it('expired and tampered beacons are dropped', () => {
    const expired = beacon(new Key(), addr, [https('https://expired.example/o')], {
      createdAt: T - 200,
    });
    const good = beacon(new Key(), addr, [https('https://good.example/o')]);
    const tampered = { ...good, content: good.content.replace('good.example', 'evil.example') };
    expect(httpsOrigins(video, [expired, tampered], T).seeders).toBe(0);
  });

  it('a seeder naming nothing usable here still counts as a seeder, not as reachable', () => {
    const ev = beacon(new Key(), addr, [https('https://127.0.0.1/o'), webrtc('wss://t.example/a')]);
    expect(httpsOrigins(video, [ev], T)).toEqual({ origins: [], seeders: 1, reachable: 0 });
  });

  it('mixed beacons: one seeder over HyperDHT and HTTPS, one over HTTPS alone, one over HyperDHT alone', () => {
    const both = new Key();
    const webOnly = new Key();
    const hyperOnly = new Key();
    const eb = hyperdht(both);
    const eh = hyperdht(hyperOnly);
    const events = [
      beacon(both, addr, [eb, https('https://both.example/o')]),
      beacon(webOnly, addr, [https('https://web.example/o', ['720p'])]),
      beacon(hyperOnly, addr, [eh]),
    ];
    const hyper = hyperdhtEndpoints(video, events, T);
    expect(hyper).toMatchObject({ seeders: 3, reachable: 2 });
    expect(hyper.peers.map((p) => p.peer).sort()).toEqual([eb.peer, eh.peer].sort());
    expect(httpsOrigins(video, events, T)).toEqual({
      origins: [
        { url: 'https://both.example/o' },
        { url: 'https://web.example/o', renditions: ['720p'] },
      ],
      seeders: 3,
      reachable: 2,
    });
  });
});

describe('what an origin serves (NFX-03 §4): a beacon narrows it, never widens it', () => {
  it('absent is every rendition, a list those', () => {
    const events = [
      beacon(new Key(), addr, [https('https://all.example/o')]),
      beacon(new Key(), addr, [https('https://some.example/o', ['360p', '720p'])]),
    ];
    expect(httpsOrigins(video, events, T).origins).toEqual([
      { url: 'https://all.example/o' },
      { url: 'https://some.example/o', renditions: ['360p', '720p'] },
    ]);
  });

  it('several seeders naming one origin: only what every one of them says it serves', () => {
    const events = [
      beacon(new Key(), addr, [https('https://o.example/o', ['360p', '720p', '1080p'])]),
      beacon(new Key(), addr, [https('https://o.example/o/', ['720p', '360p'])]),
      // A claim of every rendition narrows nothing, and widens nothing either.
      beacon(new Key(), addr, [https('https://o.example/o')]),
      beacon(new Key(), addr, [https('https://wide.example/o')]),
      beacon(new Key(), addr, [https('https://wide.example/o', ['480p'])]),
    ];
    expect(httpsOrigins(video, events, T).origins).toEqual([
      { url: 'https://o.example/o', renditions: ['360p', '720p'] },
      { url: 'https://wide.example/o', renditions: ['480p'] },
    ]);
    // Claims that share nothing leave nothing: the player tries that origin last.
    const disjoint = [
      beacon(new Key(), addr, [https('https://o.example/o', ['360p'])]),
      beacon(new Key(), addr, [https('https://o.example/o', ['720p'])]),
    ];
    expect(httpsOrigins(video, disjoint, T).origins).toEqual([
      { url: 'https://o.example/o', renditions: [] },
    ]);
  });

  it('one beacon naming an origin twice narrows it as well, and counts it once', () => {
    const events = [
      beacon(new Key(), addr, [
        https('https://o.example/o', ['360p', '720p']),
        https('https://o.example/o/', ['720p']),
        https('https://p.example/o'),
        https('https://p.example/o'),
      ]),
      beacon(new Key(), addr, [https('https://p.example/o')]),
    ];
    expect(httpsOrigins(video, events, T).origins).toEqual([
      { url: 'https://p.example/o' },
      { url: 'https://o.example/o', renditions: ['720p'] },
    ]);
  });

  it('an origin serving nothing makes no seeder reachable, but still narrows the others’ claims', () => {
    const empty = beacon(new Key(), addr, [
      https('https://o.example/o', ['360p']),
      https('https://o.example/o/', ['720p']),
    ]);
    expect(httpsOrigins(video, [empty], T)).toMatchObject({ seeders: 1, reachable: 0 });
    const other = beacon(new Key(), addr, [https('https://o.example/o')]);
    expect(httpsOrigins(video, [empty, other], T)).toMatchObject({
      origins: [{ url: 'https://o.example/o', renditions: [] }],
      seeders: 2,
      reachable: 1,
    });
  });

  it('originClaim: ids of at most 64 characters, each once, the first 32; narrowClaim intersects', () => {
    expect(originClaim(undefined)).toBeNull();
    expect(originClaim([])).toEqual([]);
    expect(originClaim(['720p', '720p', 'x'.repeat(65), '360p'])).toEqual(['720p', '360p']);
    const many = Array.from({ length: 40 }, (_, i) => `r${String(i)}`);
    expect(originClaim(many)).toEqual(many.slice(0, MAX_CLAIMED_RENDITIONS));
    expect(narrowClaim(null, null)).toBeNull();
    expect(narrowClaim(null, ['a'])).toEqual(['a']);
    expect(narrowClaim(['a', 'b'], null)).toEqual(['a', 'b']);
    expect(narrowClaim(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c']);
    expect(narrowClaim(['a'], [])).toEqual([]);
  });
});
