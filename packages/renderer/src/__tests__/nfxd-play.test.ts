/**
 * Plays of videos that seeders serve over HTTPS, as nfxd does (its beacons name `iroh`, `https`,
 * `webrtc` and `stun` endpoints, and no `hyperdht` one): the adapter against fake relays, a fake
 * worker and a fake nfx web player, with real `<video>` elements (jsdom).
 *
 * - With WebRTC on, nfx's web player gets the worker's origin first when the worker has a session
 *   (HyperDHT seeders, or the video in its own store), then the beacons' origins, and the mesh.
 * - With WebRTC off, the worker's progressive stream as before; a video it cannot serve plays
 *   through the web player from the beacons' origins with no signaling, so with no peer.
 * - With no web player, or in a window that fetches no `https` (shape b), such a play fails and
 *   says why.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { NfxAddress } from '@sovit/core';

import { HTTPS_ONLY } from '../adapter/adapter.js';
import { RuntimeNfxSession } from '../adapter/session.js';
import { WebRtcNfxSession } from '../adapter/webrtc-session.js';
import { RuntimeAdapterError } from '../errors.js';
import type { NfxOriginSource } from '../player/nfx-lib.js';
import { FakeLib } from './support/fake-lib.js';
import {
  Key,
  READ_A,
  SCOPED,
  addrOf,
  beacon,
  https,
  hyperdht,
  manifest,
  put,
  rig,
  settingsWith,
  storeWith,
  type Rig,
} from './support/nfx.js';

const WORKER_ORIGIN = `http://127.0.0.1:41235/${'f'.repeat(32)}`;
/** What nfxd's beacon on the testnet names besides its origin (read by nobody here). */
const NFXD_EXTRAS = [
  { t: 'iroh', node: 'a'.repeat(64), relay: '', addrs: [], tickets: {} },
  { t: 'webrtc', tracker_urls: ['wss://tracker.example/announce'] },
  { t: 'stun', addrs: ['93.184.215.14:3478'] },
];

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.adapter.close();
});

interface Made extends Rig {
  readonly lib: FakeLib;
  readonly plays: { sid: string; peers: number }[];
}

function make(
  o: {
    readonly player?: boolean;
    readonly webrtc?: boolean;
    readonly beaconOrigins?: boolean;
    readonly beaconWaitMs?: number;
  } = {},
): Made {
  const lib = new FakeLib();
  const plays: { sid: string; peers: number }[] = [];
  const base = settingsWith([READ_A], [SCOPED]);
  const settings = storeWith({
    ...base,
    nfx: { ...(base.nfx ?? ({} as never)), webrtc: o.webrtc ?? true },
  });
  const r = rig({
    player: o.player === false ? null : lib,
    beaconOrigins: o.beaconOrigins,
    beaconWaitMs: o.beaconWaitMs ?? 200,
    settings,
    onPlay: (p) => {
      plays.push({ sid: p.sid, peers: p.peers.length });
    },
  });
  rigs.push(r);
  return { ...r, lib, plays };
}

async function playable(r: Rig): Promise<{ addr: NfxAddress; creator: Key }> {
  const creator = new Key();
  put(r.relays, [READ_A], manifest(creator, 'free-video'));
  const addr = addrOf(creator, 'free-video');
  await r.adapter.nfxVideo(addr);
  return { addr, creator };
}

/** nfxd's beacon for `addr`: its `https` origin and its other endpoints, no `hyperdht`. */
const nfxdBeacon = (addr: string, url = 'https://web.example/o'): ReturnType<typeof beacon> =>
  beacon(new Key(), addr, [...NFXD_EXTRAS, https(url)]);

/** The element's `data-*` attributes, as a plain object. */
const data = (el: HTMLElement): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(el.dataset));

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

/** Attaches `session` to a fresh `<video>` and returns what the library was asked to open. */
async function attach(
  session: unknown,
  lib: FakeLib,
): Promise<{ el: HTMLVideoElement; options: FakeLib['opened'][number]['options'] }> {
  expect(session).toBeInstanceOf(WebRtcNfxSession);
  const el = document.createElement('video');
  el.play = (): Promise<void> => Promise.resolve();
  (session as WebRtcNfxSession).source.attach(el);
  await flush();
  const opened = lib.opened.at(-1);
  if (opened === undefined) throw new Error('the library was not opened');
  return { el, options: opened.options };
}

const failure = async (p: Promise<unknown>): Promise<RuntimeAdapterError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(RuntimeAdapterError);
  return e as RuntimeAdapterError;
};

describe('a video only HTTPS seeders serve, with WebRTC on', () => {
  it('plays through the web player from the beacons’ origins alone, with the mesh, and no worker session', async () => {
    const r = make();
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], nfxdBeacon(addr));
    // The worker is asked (it might hold the video), with no peer, and cannot serve it.
    r.worker.openFails = 'no-seeders';
    const session = await r.adapter.playNfx(addr);
    expect(r.worker.opens).toHaveLength(1);
    expect(r.worker.opens[0]).toMatchObject({ peers: [], progressive: false });
    expect(r.worker.opens[0]?.held).toBeUndefined();
    expect((session as WebRtcNfxSession).sid).toBeNull();
    const { options } = await attach(session, r.lib);
    expect(options.origins).toEqual([{ url: 'https://web.example/o' }]);
    expect(options.signaling).toEqual({
      kind: 'nostr',
      relays: ['wss://relay.primal.net', 'wss://relay.ditto.pub'],
      remoteCandidates: 'global',
    });
    expect(options.iceServers).toEqual([{ urls: ['stun:web.nutflix.xyz:3478'] }]);
    // Nothing to seed: the worker has no session to store from.
    expect(r.plays).toEqual([]);
    await session.close();
    expect(r.worker.closes).toEqual([]);
    expect(r.adapter.openSessions).toBe(0);
  });

  it('lists the worker’s origin first when it holds the video, and the play is seeded from it', async () => {
    const r = make();
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], nfxdBeacon(addr));
    r.worker.result = { ...r.worker.result, progressiveUrl: null, originUrl: WORKER_ORIGIN };
    const session = await r.adapter.playNfx(addr);
    expect(r.worker.opens[0]).toMatchObject({ peers: [], progressive: false });
    const sid = r.worker.opens[0]?.sid;
    expect((session as WebRtcNfxSession).sid).toBe(sid);
    const { options } = await attach(session, r.lib);
    expect(options.origins).toEqual([WORKER_ORIGIN, { url: 'https://web.example/o' }]);
    // "Seed what you watch" is told of the play, by its worker session (`seeding.watch`).
    expect(r.plays).toEqual([{ sid, peers: 0 }]);
    // Until the player's levels arrive, the renditions are the worker's.
    expect(session.renditions.map((x) => x.id)).toEqual(['720p', '360p']);
    await session.close();
    expect(r.worker.closes).toEqual([sid]);
  });

  it('a player that will not start has no HyperDHT stream to fall back on, and says so', async () => {
    const r = make();
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], nfxdBeacon(addr));
    r.worker.openFails = 'no-seeders';
    r.lib.fails = true;
    const session = await r.adapter.playNfx(addr);
    await attach(session, r.lib);
    await flush();
    expect(r.worker.opens).toHaveLength(1);
    expect((session as WebRtcNfxSession).problems.at(-1)?.message).toMatch(
      /no HyperDHT seeder serves this video/,
    );
    expect(JSON.stringify((session as WebRtcNfxSession).problems)).not.toContain('secret');
  });

  it('does not wait out the beacon wait once an HTTPS seeder is in', async () => {
    const r = make({ beaconWaitMs: 60_000 });
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], nfxdBeacon(addr));
    r.worker.openFails = 'no-seeders';
    const started = Date.now();
    await r.adapter.playNfx(addr);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('a video HyperDHT and HTTPS seeders both serve', () => {
  it('the worker’s origin first, over HyperDHT, then the beacons’ origins, most-named first, at most 8', async () => {
    const r = make();
    const { addr } = await playable(r);
    const desktop = new Key();
    const ep = hyperdht(desktop);
    const many = Array.from({ length: 4 }, (_, i) => https(`https://o${String(i)}.example/o`));
    put(
      r.relays,
      [SCOPED],
      beacon(desktop, addr, [ep, https('https://shared.example/o', ['720p'])]),
      beacon(new Key(), addr, [https('https://shared.example/o'), ...many.slice(0, 3)]),
      beacon(new Key(), addr, [...many, https('https://fifth.example/o')]),
      beacon(
        new Key(),
        addr,
        Array.from({ length: 4 }, (_, i) => https(`https://x${String(i)}.example/o`)),
      ),
    );
    r.worker.result = { ...r.worker.result, progressiveUrl: null, originUrl: WORKER_ORIGIN };
    const session = await r.adapter.playNfx(addr);
    expect(r.worker.opens[0]?.peers.map((p) => p.peer)).toEqual([ep.peer]);
    const { options } = await attach(session, r.lib);
    const urls = options.origins.map((o) => (typeof o === 'string' ? o : o.url));
    expect(urls[0]).toBe(WORKER_ORIGIN);
    expect(urls).toHaveLength(1 + 8);
    expect(urls.slice(1, 3)).toEqual(expect.arrayContaining(['https://shared.example/o']));
    expect(urls).not.toContain('https://fifth.example/o');
    // The desktop seeder's claim narrows the shared origin: a hint for the library's order.
    expect(options.origins).toContainEqual({
      url: 'https://shared.example/o',
      renditions: ['720p'],
    });
    expect(r.plays).toEqual([{ sid: r.worker.opens[0]?.sid, peers: 1 }]);
  });

  it('when the HyperDHT seeders do not answer, the beacons’ origins alone', async () => {
    const r = make();
    const { addr } = await playable(r);
    const desktop = new Key();
    put(r.relays, [SCOPED], beacon(desktop, addr, [hyperdht(desktop)]), nfxdBeacon(addr));
    r.worker.openFails = 'no-seeders';
    const session = await r.adapter.playNfx(addr);
    expect(r.worker.opens[0]?.peers).toHaveLength(1);
    const { options } = await attach(session, r.lib);
    expect(options.origins).toEqual([{ url: 'https://web.example/o' }]);
    expect(r.plays).toEqual([]);
  });

  it('a newest beacon that withdraws its origin takes it out of the play', async () => {
    const r = make();
    const { addr } = await playable(r);
    const nfxd = new Key();
    const desktop = new Key();
    put(
      r.relays,
      [SCOPED],
      beacon(nfxd, addr, [https('https://gone.example/o')], { createdAt: 1_800_000_000 - 30 }),
      beacon(nfxd, addr, [...NFXD_EXTRAS], { createdAt: 1_800_000_000 - 5 }),
      beacon(desktop, addr, [hyperdht(desktop)]),
    );
    r.worker.result = { ...r.worker.result, progressiveUrl: null, originUrl: WORKER_ORIGIN };
    const session = await r.adapter.playNfx(addr);
    const { options } = await attach(session, r.lib);
    expect(options.origins).toEqual([WORKER_ORIGIN]);
  });
});

describe('WebRTC off: no peer connection', () => {
  it('a video only HTTPS seeders serve plays through the web player with no signaling at all', async () => {
    const r = make({ webrtc: false });
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], nfxdBeacon(addr));
    r.worker.openFails = 'no-seeders';
    const session = await r.adapter.playNfx(addr);
    // The worker was asked for its progressive stream first, as with WebRTC off before.
    expect(r.worker.opens).toHaveLength(1);
    expect(r.worker.opens[0]).toMatchObject({ peers: [], origin: false });
    const { options } = await attach(session, r.lib);
    expect(options.origins).toEqual([{ url: 'https://web.example/o' }]);
    expect('signaling' in options).toBe(false);
    expect('iceServers' in options).toBe(false);
  });

  it('a video a HyperDHT seeder serves plays from the worker’s stream, and the library is never opened', async () => {
    const r = make({ webrtc: false });
    const { addr } = await playable(r);
    const desktop = new Key();
    put(
      r.relays,
      [SCOPED],
      beacon(desktop, addr, [hyperdht(desktop), https('https://web.example/o')]),
    );
    const session = await r.adapter.playNfx(addr);
    expect(session).toBeInstanceOf(RuntimeNfxSession);
    expect(session.source).toEqual({ kind: 'url', url: r.worker.result.progressiveUrl });
    expect(r.lib.opened).toEqual([]);
  });

  it('a video the worker holds plays from its stream too', async () => {
    const r = make({ webrtc: false });
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], nfxdBeacon(addr));
    const session = await r.adapter.playNfx(addr);
    expect(session).toBeInstanceOf(RuntimeNfxSession);
    expect(r.worker.opens[0]?.peers).toEqual([]);
    expect(r.lib.opened).toEqual([]);
  });
});

describe('where the beacons’ origins cannot be used', () => {
  it('no web player: the play fails, saying why, and never as “nobody is seeding”', async () => {
    const r = make({ player: false });
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], nfxdBeacon(addr));
    r.worker.openFails = 'no-seeders';
    const e = await failure(r.adapter.playNfx(addr));
    expect(e.code).toBe('unsupported');
    expect(e.message).toBe(`unsupported: ${HTTPS_ONLY.noPlayer}`);
    expect(e.message).not.toContain('no-seeders');
    expect(r.worker.opens).toHaveLength(1);
    expect(r.adapter.openSessions).toBe(0);
  });

  it('no web player: an HTTPS seeder does not end the beacon wait (a HyperDHT one may still come)', async () => {
    const r = make({ player: false, beaconWaitMs: 400 });
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], nfxdBeacon(addr));
    r.worker.openFails = 'no-seeders';
    const started = Date.now();
    await failure(r.adapter.playNfx(addr));
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });

  it('a window that fetches no HTTPS (shape b): refused, saying why, with the library never opened', async () => {
    for (const webrtc of [true, false]) {
      const r = make({ beaconOrigins: false, webrtc });
      const { addr } = await playable(r);
      put(r.relays, [SCOPED], nfxdBeacon(addr));
      r.worker.openFails = 'no-seeders';
      const e = await failure(r.adapter.playNfx(addr));
      expect(e.message, String(webrtc)).toBe(`unsupported: ${HTTPS_ONLY.notHere}`);
      expect(r.lib.opened).toEqual([]);
    }
  });

  it('a window that fetches no HTTPS still plays a HyperDHT seeder’s video through the worker’s origin alone', async () => {
    const r = make({ beaconOrigins: false });
    const { addr } = await playable(r);
    const desktop = new Key();
    put(
      r.relays,
      [SCOPED],
      beacon(desktop, addr, [hyperdht(desktop), https('https://web.example/o')]),
    );
    r.worker.result = { ...r.worker.result, progressiveUrl: null, originUrl: WORKER_ORIGIN };
    const session = await r.adapter.playNfx(addr);
    const { options } = await attach(session, r.lib);
    expect(options.origins).toEqual([WORKER_ORIGIN]);
  });

  it('the worker’s own failures keep their words when no origin was named', async () => {
    const r = make();
    const { addr } = await playable(r);
    const desktop = new Key();
    put(r.relays, [SCOPED], beacon(desktop, addr, [hyperdht(desktop)]));
    r.worker.openFails = 'no-seeders';
    expect((await failure(r.adapter.playNfx(addr))).code).toBe('no-seeders');
    r.worker.openFails = 'backend-down';
    expect((await failure(r.adapter.playNfx(addr))).code).toBe('worker-down');
  });
});

describe('what a play measured, for the installed app’s play proof', () => {
  it('names the origin the library plays from and the mesh’s byte counters, never a URL', async () => {
    const r = make();
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], nfxdBeacon(addr));
    r.worker.result = { ...r.worker.result, progressiveUrl: null, originUrl: WORKER_ORIGIN };
    r.lib.stats = {
      origin: 'https://web.example/o',
      verified: 7,
      mesh: { bytes: { http: 1_000, p2p: 2_500 }, peers: 2 },
    };
    const session = await r.adapter.playNfx(addr);
    const { el } = await attach(session, r.lib);
    expect(data(el)).toEqual({
      nfxFrom: 'https',
      nfxHttpBytes: '1000',
      nfxP2pBytes: '2500',
      nfxPeers: '2',
    });
    const s = r.lib.sessions[0];
    if (s === undefined) throw new Error('no session');
    s.snapshot = { origin: WORKER_ORIGIN, verified: 9, mesh: null };
    el.dispatchEvent(new Event('timeupdate'));
    // With the mesh off the library counts no bytes: -1, not a guess.
    expect(data(el)).toEqual({
      nfxFrom: 'worker',
      nfxHttpBytes: '-1',
      nfxP2pBytes: '-1',
      nfxPeers: '-1',
    });
    expect(JSON.stringify(data(el))).not.toContain('f'.repeat(32));
    await session.close();
    expect(data(el)).toEqual({});
  });

  it('origins are handed over as the library takes them', async () => {
    const r = make();
    const { addr } = await playable(r);
    put(
      r.relays,
      [SCOPED],
      beacon(new Key(), addr, [
        https('https://a.example/o', ['360p']),
        https('https://b.example/o'),
      ]),
    );
    r.worker.openFails = 'no-seeders';
    const session = await r.adapter.playNfx(addr);
    const { options } = await attach(session, r.lib);
    const want: NfxOriginSource[] = [
      { url: 'https://a.example/o', renditions: ['360p'] },
      { url: 'https://b.example/o' },
    ];
    expect(options.origins).toEqual(want);
  });
});
