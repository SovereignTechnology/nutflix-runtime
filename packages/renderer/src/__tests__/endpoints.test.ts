// @vitest-environment node
/**
 * Which HyperDHT endpoints a play may hand the worker: only a seeder's newest valid free beacon,
 * and only an endpoint whose `bind` names that seeder on this network (NFX-12 §2).
 */
import { describe, expect, it } from 'vitest';

import type { NfxVideo } from '@sovit/core';
import { hyperdhtEndpoint } from '@sovit/seeder';
import DHT from 'hyperdht';

import { hyperdhtEndpoints } from '../adapter/endpoints.js';
import { Key, NS, T, addrOf, beacon, hyperdht, https, seederBeacon } from './support/nfx.js';

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
