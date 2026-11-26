// @vitest-environment node
/**
 * The renderer's adapter against per-relay fake relays (core's `FakeRelayPool`), fake NIP-11
 * documents and a fake worker: the method table (served, read-only, empty, `unsupported`), the
 * catalogue and NIP-50 routing by NIP-11, images by signed sha256 only, and `playNfx` handing the
 * worker exactly the verified HyperDHT endpoints it resolved, then a loopback stream, then a close.
 * Beacons are ephemeral: the tests open the video first (its live subscription), then publish.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { NfxAddress, NostrPubkey } from '@sovit/core';
import type { ErrorCode } from '@nutflix-runtime/worker';

import { RuntimeAdapterError } from '../errors.js';
import type { RuntimeNfxSession } from '../adapter/session.js';
import { FakeWorker } from './support/fake-worker.js';
import {
  Key,
  NS,
  READ_A,
  ROOT,
  SCOPED,
  SEGS,
  addrOf,
  beacon,
  hyperdht,
  https,
  manifest,
  put,
  rig,
  seederBeacon,
  type Rig,
} from './support/nfx.js';

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.adapter.close();
});
function make(o: Parameters<typeof rig>[0] = {}): Rig {
  const r = rig(o);
  rigs.push(r);
  return r;
}

/** An argument a rejected call never reads. */
const ANY = {} as never;

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof RuntimeAdapterError) return e.code;
    throw e;
  }
  return 'resolved';
};

describe('the method table', () => {
  it('is a desktop-shaped adapter, signed out, with nothing to sign or spend', async () => {
    const { adapter } = make();
    expect(adapter.platform).toBe('desktop');
    expect(await adapter.me()).toBeNull();
    expect(await adapter.signer()).toMatchObject({ pubkey: null, locked: false });
    expect(await adapter.subscriptions()).toEqual([]);
    expect(await adapter.related()).toEqual([]);
    expect(await adapter.feed({ source: 'trending' })).toEqual({ items: [] });
    expect(await adapter.library.history()).toEqual({ items: [] });
    expect(await adapter.stats()).toMatchObject({ paidViews: 0 });
  });

  it('rejects every write, money and Studio call as unsupported', async () => {
    const { adapter } = make();
    const calls: Promise<unknown>[] = [
      adapter.play(),
      adapter.comment(),
      adapter.react(),
      adapter.unreact(),
      adapter.nutzap(),
      adapter.subscribe(),
      adapter.unsubscribe(),
      adapter.report(),
      adapter.setProfilePicture(),
      adapter.library.setWatchLater(ANY, true),
      adapter.library.savePlaylist(ANY),
      adapter.studio.probe(ANY),
      adapter.studio.upload(ANY, () => undefined),
      adapter.studio.myVideos(),
      adapter.studio.analytics(ANY),
      adapter.seeder.status(),
      adapter.seeder.setEnabled(true),
      adapter.wallet.balance(ANY),
      adapter.wallet.mints(),
      adapter.wallet.history(),
    ];
    for (const c of calls) expect(await code(c)).toBe('unsupported');
  });

  it('keeps the settings a viewer may change and refuses the rest', async () => {
    const { adapter } = make();
    expect((await adapter.updateSettings({ theme: 'dark' })).theme).toBe('dark');
    expect(await code(adapter.updateSettings({ loadRemoteImages: true }))).toBe('invalid-argument');
    expect(
      await code(adapter.updateSettings({ defaultMints: ['https://mint.example' as never] })),
    ).toBe('invalid-argument');
    expect((await adapter.settings()).loadRemoteImages).toBe(false);
  });
});

describe('the catalogue', () => {
  it('lists the network feed from the relays, and finds one video by address', async () => {
    const r = make();
    const creator = new Key();
    put(r.relays, [READ_A], manifest(creator, 'video-one', { title: 'First' }));
    put(r.relays, [SCOPED], manifest(creator, 'video-two', { title: 'Second' }));
    const page = await r.adapter.feed({ source: 'network', limit: 20 });
    expect(page.items.map((v) => (v.kind === 38504 ? v.title : ''))).toEqual(
      expect.arrayContaining(['First', 'Second']),
    );
    const one = await r.adapter.nfxVideo(addrOf(creator, 'video-one'));
    expect(one?.title).toBe('First');
    expect(await r.adapter.nfxVideo(addrOf(creator, 'missing'))).toBeNull();
  });

  it('checks every argument before a relay is asked', async () => {
    const r = make();
    expect(await code(r.adapter.feed({ source: 'author', author: 'nope' as NostrPubkey }))).toBe(
      'invalid-argument',
    );
    expect(await code(r.adapter.feed({ source: 'network', limit: 100_000 }))).toBe(
      'invalid-argument',
    );
    expect(await code(r.adapter.search({ text: 'x'.repeat(5000) }))).toBe('invalid-argument');
    expect(await r.adapter.nfxVideo('38504:nope' as NfxAddress)).toBeNull();
    expect(r.relays.asked).toEqual([]);
  });

  it('says relay-down, never the relay’s own words, when there is no relay', async () => {
    const r = make({ read: [], scoped: [] });
    const e = await r.adapter.feed({ source: 'network' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RuntimeAdapterError);
    expect((e as RuntimeAdapterError).code).toBe('relay-down');
  });

  it('asks a relay for NIP-50 search only when its NIP-11 document lists 50', async () => {
    const r = make({ nip11: { [SCOPED]: { supported_nips: [1, 11, 50] } } });
    const creator = new Key();
    put(r.relays, [SCOPED], manifest(creator, 'v', { title: 'Orbits of Jupiter' }));
    await r.adapter.search({ text: 'jupiter' });
    expect(r.fetches.map((f) => f.url)).toContain(SCOPED.replace('wss:', 'https:'));
    expect(
      r.fetches.every((f) => f.init.credentials === 'omit' && f.init.redirect === 'error'),
    ).toBe(true);
  });

  it('shows images only by a signed sha256, and never a request without one', async () => {
    const r = make();
    expect(await code(r.adapter.image('https://img.example/a.png'))).toBe('forbidden');
    expect(await code(r.adapter.image('http://img.example/a.png', 'a'.repeat(64) as never))).toBe(
      'forbidden',
    );
    expect(await code(r.adapter.image('https://localhost/a.png', 'a'.repeat(64) as never))).toBe(
      'forbidden',
    );
    expect(r.fetches).toEqual([]);
  });
});

describe('playNfx: beacons → HyperDHT endpoints → the worker', () => {
  async function playable(r: Rig): Promise<{ addr: NfxAddress; creator: Key }> {
    const creator = new Key();
    put(r.relays, [READ_A], manifest(creator, 'free-video'));
    const addr = addrOf(creator, 'free-video');
    // The Watch page loads the video first, which opens its beacon subscription.
    await r.adapter.nfxVideo(addr);
    return { addr, creator };
  }

  it('hands the worker the verified endpoints, plays its loopback stream, and closes it', async () => {
    const r = make();
    const { addr } = await playable(r);
    const a = new Key();
    const ea = hyperdht(a);
    const b = seederBeacon(addr);
    const eb = b.endpoint;
    // A beacon whose endpoint is bound to another seeder is no beacon at all (core refuses it).
    const forged = hyperdht(a);
    put(
      r.relays,
      [SCOPED],
      beacon(a, addr, [ea, https('https://seed.example/o')]),
      b.event,
      beacon(new Key(), addr, [forged]),
    );
    const session = await r.adapter.playNfx(addr);
    expect(r.worker.readyCalls).toBe(1);
    expect(r.worker.opens).toHaveLength(1);
    const open = r.worker.opens[0]!;
    expect(open).toMatchObject({
      sid: '1'.padStart(32, '0'),
      video: `${NS}:free-video`,
      root: ROOT,
      segs: SEGS,
      prefetchSeconds: 30,
      origin: false,
    });
    expect(open.peers).toHaveLength(2);
    expect(open.peers.map((p) => p.peer).sort()).toEqual([ea.peer, eb.peer].sort());
    expect(open.peers.every((p) => /^[0-9a-f]{128}$/.test(p.bind))).toBe(true);
    expect(open.held).toEqual({ seeders: 2, all: 2, named: [] });
    expect(open.renditions).toBeUndefined();
    expect(session.videoId).toBe(addr);
    expect(session.source).toEqual({ kind: 'url', url: r.worker.result.progressiveUrl });
    expect(session.rendition).toBe('720p');
    expect(session.renditions).toEqual([
      { id: '720p', bandwidth: 2_000_000, resolution: '1280x720' },
      { id: '360p', bandwidth: 500_000, resolution: '640x360' },
    ]);
    expect(r.adapter.openSessions).toBe(1);
    await session.close();
    await session.close();
    expect(r.worker.closes).toEqual([open.sid]);
    expect(r.adapter.openSessions).toBe(0);
  });

  it('asks for the rendition a viewer picked, first', async () => {
    const r = make();
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], seederBeacon(addr).event);
    r.worker.result = { ...r.worker.result, rendition: '360p' };
    const session = await r.adapter.playNfx(addr, '360p');
    expect(r.worker.opens[0]?.renditions).toEqual(['360p']);
    expect(session.rendition).toBe('360p');
    expect(await code(r.adapter.playNfx(addr, 'meta'))).toBe('invalid-argument');
    expect(await code(r.adapter.playNfx(addr, ''))).toBe('invalid-argument');
    expect(await code(r.adapter.playNfx(addr, 'x'.repeat(65)))).toBe('invalid-argument');
  });

  it('passes the viewer’s read-ahead on, bounded', async () => {
    const r = make();
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], seederBeacon(addr).event);
    await r.adapter.updateSettings({ prefetchSeconds: 90.9 });
    await r.adapter.playNfx(addr);
    expect(r.worker.opens[0]?.prefetchSeconds).toBe(90);
  });

  it('refuses before any relay or worker call: not an NFX address, a video nobody published', async () => {
    const r = make();
    expect(await code(r.adapter.playNfx('38504:x' as NfxAddress))).toBe('invalid-argument');
    expect(await code(r.adapter.playNfx(addrOf(new Key(), 'nothing')))).toBe('not-found');
    expect(r.worker.readyCalls).toBe(0);
    expect(r.worker.opens).toEqual([]);
  });

  it('says no-seeders when no beacon names anyone within the wait', async () => {
    const r = make({ beaconWaitMs: 50 });
    const { addr } = await playable(r);
    expect(await code(r.adapter.playNfx(addr))).toBe('no-seeders');
    expect(r.worker.opens).toEqual([]);
  });

  it('still asks the worker when seeders beacon but none names a usable endpoint (its store may hold the video)', async () => {
    const r = make({ beaconWaitMs: 50 });
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], beacon(new Key(), addr, [https('https://seed.example/o')]));
    r.worker.openFails = 'no-seeders';
    // With no web player here, an HTTPS origin cannot be used, and the failure says so
    // (`nfxd-play.test.ts`) rather than that nobody seeds the video.
    expect(await code(r.adapter.playNfx(addr))).toBe('unsupported');
    expect(r.worker.opens).toHaveLength(1);
    expect(r.worker.opens[0]?.peers).toEqual([]);
    r.worker.openFails = null;
    expect(await code(r.adapter.playNfx(addr))).toBe('resolved');
  });

  it('ignores beacons for another video, a paid one, and another creator’s copy', async () => {
    const r = make({ beaconWaitMs: 50 });
    const { addr } = await playable(r);
    const other = addrOf(new Key(), 'free-video');
    put(r.relays, [SCOPED], seederBeacon(addr, { free: false }).event, seederBeacon(other).event);
    expect(await code(r.adapter.playNfx(addr))).toBe('no-seeders');
  });

  it('maps the worker’s failures to its own words, never the worker’s', async () => {
    const r = make();
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], seederBeacon(addr).event);
    const table: [ErrorCode, string][] = [
      ['no-seeders', 'no-seeders'],
      ['not-found', 'not-found'],
      ['unsupported-input', 'unsupported'],
      ['invalid-argument', 'invalid-argument'],
      ['backend-down', 'worker-down'],
      ['not-ready', 'worker-down'],
      ['rate-limited', 'internal'],
      ['io', 'internal'],
      ['internal', 'internal'],
    ];
    for (const [from, to] of table) {
      r.worker.openFails = from;
      const e = await r.adapter.playNfx(addr).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RuntimeAdapterError);
      expect((e as RuntimeAdapterError).code, from).toBe(to);
      expect((e as Error).message).not.toContain('secret');
    }
    r.worker.openFails = null;
    r.worker.readyFails = 'backend-down';
    const e = await r.adapter.playNfx(addr).catch((x: unknown) => x);
    expect((e as RuntimeAdapterError).code).toBe('worker-down');
    expect((e as Error).message).not.toContain('secret');
    expect(r.adapter.openSessions).toBe(0);
  });

  it('refuses a stream URL that is not the worker’s own loopback one, and closes that play', async () => {
    const r = make();
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], seederBeacon(addr).event);
    for (const bad of [
      null,
      'https://evil.example/x',
      'http://evil.example:80/x',
      'http://127.0.0.1:80/a/b',
      `http://127.0.0.1:41234/${'a'.repeat(32)}/${'b'.repeat(31)}g`,
      `http://localhost:41234/${'a'.repeat(32)}/${'b'.repeat(32)}`,
      `javascript:alert(1)//${'a'.repeat(32)}`,
    ]) {
      r.worker.result = { ...r.worker.result, progressiveUrl: bad };
      expect(await code(r.adapter.playNfx(addr))).toBe('internal');
    }
    expect(r.worker.closes).toHaveLength(7);
    expect(r.adapter.openSessions).toBe(0);
  });

  it('opens at most four plays at once', async () => {
    const r = make();
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], seederBeacon(addr).event);
    const open: RuntimeNfxSession[] = [];
    for (let i = 0; i < 4; i++) open.push((await r.adapter.playNfx(addr)) as RuntimeNfxSession);
    expect(await code(r.adapter.playNfx(addr))).toBe('internal');
    await open[0]?.close();
    expect(await code(r.adapter.playNfx(addr))).toBe('resolved');
  });

  it('closes every play when the app closes, and plays nothing after', async () => {
    const r = make();
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], seederBeacon(addr).event);
    await r.adapter.playNfx(addr);
    await r.adapter.playNfx(addr);
    await r.adapter.close();
    expect(r.worker.closes).toHaveLength(2);
    expect(await code(r.adapter.playNfx(addr))).toBe('session-closed');
  });

  it('a worker that is gone when a play closes is not an error', async () => {
    const worker = new FakeWorker();
    worker.closeFails = true;
    const r = make({ worker });
    const { addr } = await playable(r);
    put(r.relays, [SCOPED], seederBeacon(addr).event);
    const session = await r.adapter.playNfx(addr);
    await expect(session.close()).resolves.toBeUndefined();
  });
});
