/**
 * The worker against nutflix-pear's own NFX-12 code (`@sovit/seeder` from the submodule) on a
 * local hyperdht testnet, driven through the real wire (`WorkerClient` ⇄ `WorkerRpc`):
 *
 *   (a) nutflix-pear's `listenNfx` serves a video and `nfx.seed.start` fetches every file into
 *       this worker's store, each sha256-equal to the fixture;
 *   (b) this worker seeds it, and nutflix-pear's `dialNfx` files-client fetches every file back,
 *       from the endpoint `nfx.endpoint` names (its `bind` verifies; its key is the Corestore
 *       pair `nfx:<namespace>:seeder`);
 *   (c) `nfx.play.open`'s progressive stream: layout C by range (200, 206 across every boundary,
 *       the whole view as one range, a suffix, an open range, HEAD, 416, 404 for another token
 *       or sid), and nutflix-pear's refusals;
 *   (d) `nfx.play.open`'s origin: exactly what a web player asks for, followed from the master
 *       playlist down, sha256-equal; 404 without the token; from the store with no seeder named.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { nfx } from '@sovit/core';
import type { NfxFileSource } from '@sovit/seeder';
import { dialNfx, hyperdhtEndpoint, listenNfx, nodeCrypto } from '@sovit/seeder';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seederKeyName } from '../nfx/seeding.js';
import { MAX_NFX_SESSIONS, NFX_PLAY_DIR } from '../nfx/watching.js';
import type { NfxHyperdhtEndpointWire, NfxPlayOpenArgs, WorkerEvent } from '../protocol.js';
import type { RunningWorker } from './helpers/harness.js';
import { httpGet, request, startWorker, tempDir } from './helpers/harness.js';
import { NFX_NS, memorySource, testNfxVideo, vectorVideo } from './helpers/nfx-video.js';

vi.setConfig({ testTimeout: 120_000 });

const SEEDER_NOSTR = 'ab'.repeat(32);
const sid = (): string => randomBytes(16).toString('hex');
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const namespaceOf = (video: string): string => video.slice(0, video.lastIndexOf(':'));

describe('the worker and nutflix-pear over NFX-12 (hyperdht testnet)', () => {
  let testnet: Testnet;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    testnet = await createTestnet(3);
  });
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    await testnet.destroy();
  });

  async function node(): Promise<DHT> {
    const n = new DHT({ bootstrap: testnet.bootstrap });
    cleanups.push(() => n.destroy());
    await n.fullyBootstrapped();
    return n;
  }

  /** nutflix-pear's own seeder (`listenNfx`) on the testnet; its beacon endpoint. */
  async function pearSeeder(
    source: NfxFileSource,
    namespace: string,
  ): Promise<NfxHyperdhtEndpointWire> {
    const dht = await node();
    const keyPair = DHT.keyPair();
    const listener = await listenNfx(dht, { keyPair, source });
    cleanups.push(() => listener.close());
    return hyperdhtEndpoint(keyPair, SEEDER_NOSTR, namespace);
  }

  async function worker(): Promise<{ w: RunningWorker; storage: string }> {
    const d = await tempDir('nf-worker-');
    const w = startWorker();
    cleanups.push(
      () => d.rm(),
      () => w.close(),
    );
    await w.client.request('init', { v: 1, storage: d.dir, bootstrap: testnet.bootstrap });
    return { w, storage: d.dir };
  }

  const storedPath = (storage: string, sha: string): string =>
    join(storage, 'nfx', 'files', sha.slice(0, 2), sha);

  it('(a) + (b): fetches every file from listenNfx, then serves every file to dialNfx', async () => {
    const vector = vectorVideo();
    const fmp4 = testNfxVideo();
    const { w, storage } = await worker();

    for (const v of [vector, fmp4]) {
      const ns = namespaceOf(v.video);
      // One seeder without the files first: it is skipped for the next.
      const empty = await pearSeeder(memorySource(new Map(), v.video), ns);
      const full = await pearSeeder(memorySource(v.files, v.video), ns);
      const stored = await w.client.request('nfx.seed.start', {
        video: v.video,
        root: v.root,
        segs: v.segs,
        peers: [empty, full],
      });
      let bytes = 0;
      for (const b of v.files.values()) bytes += b.length;
      expect(stored).toEqual({
        video: v.video,
        root: v.root,
        segs: v.segs,
        files: v.files.size,
        bytes,
      });
      // (a) Every file, byte for byte, sha256-equal, where the store keeps it.
      for (const [sha, want] of v.files) {
        const got = readFileSync(storedPath(storage, sha));
        expect(sha256(got), sha).toBe(sha);
        expect(got.equals(Buffer.from(want)), sha).toBe(true);
      }
      const seedEvents = w.events.filter(
        (e): e is Extract<WorkerEvent, { e: 'nfx.seed' }> =>
          e.e === 'nfx.seed' && e.video === v.video,
      );
      expect(seedEvents.at(-1)).toMatchObject({ state: 'seeding', done: v.segs, total: v.segs });
      // Asked again: already stored, nothing fetched.
      expect(
        await w.client.request('nfx.seed.start', {
          video: v.video,
          root: v.root,
          segs: v.segs,
          peers: [],
        }),
      ).toEqual(stored);
      await expect(
        w.client.request('nfx.seed.start', {
          video: v.video,
          root: 'e'.repeat(64),
          segs: v.segs,
          peers: [full],
        }),
      ).rejects.toMatchObject({ code: 'exists' });
    }

    // (b) The listener of the vector's network, named by nfx.endpoint.
    const ns = namespaceOf(vector.video);
    const { hyperdht: endpoint } = await w.client.request('nfx.endpoint', {
      seeder: SEEDER_NOSTR,
      namespace: ns,
    });
    if (endpoint === null) throw new Error('no endpoint while seeding');
    expect(nfx.verifyHyperdhtBind(endpoint.peer, endpoint.bind, SEEDER_NOSTR, ns)).toBe(true);
    const keys = w.host.internals!.keys;
    const seederKey = await keys.keyPair(seederKeyName(ns));
    expect(endpoint.peer).toBe(Buffer.from(seederKey.publicKey).toString('hex'));
    // One listener per network, each its own key.
    const other = await w.client.request('nfx.endpoint', {
      seeder: SEEDER_NOSTR,
      namespace: NFX_NS,
    });
    expect(other.hyperdht?.peer).not.toBe(endpoint.peer);
    expect(
      (await w.client.request('nfx.seed.list', {})).listening.map((l) => l.namespace).sort(),
    ).toEqual([ns, NFX_NS].sort());

    const watcher = await node();
    const dialed = await dialNfx(watcher, Buffer.from(endpoint.peer, 'hex'), {
      keyPair: DHT.keyPair(),
      crypto: nodeCrypto,
      timeoutMs: 20_000,
    });
    if (!dialed.ok) throw new Error(`dial failed: ${dialed.reason}`);
    cleanups.push(() => {
      dialed.connection.destroy('test over');
      return Promise.resolve();
    });
    const video = nfx.VideoAddr.parse(vector.video);
    if (!video.ok) throw new Error('bad vector video');
    const files = dialed.connection.files(video.value);
    if (files === undefined) throw new Error('the worker does not serve the vector video');
    for (const [sha, want] of vector.files) {
      const chunks: Uint8Array[] = [];
      const r = await files.fetch({
        sha,
        size: want.length,
        sink: { write: (c) => void chunks.push(c) },
      });
      expect(r, sha).toEqual({ ok: true, bytes: want.length });
      const got = Buffer.concat(chunks);
      expect(sha256(got), sha).toBe(sha);
    }
    // A file of the other network's video is not this listener's to serve.
    const fmp4Addr = nfx.VideoAddr.parse(fmp4.video);
    if (!fmp4Addr.ok) throw new Error('bad test video');
    const elsewhere = dialed.connection.files(fmp4Addr.value);
    const r =
      elsewhere === undefined
        ? { ok: false }
        : await elsewhere.fetch({
            sha: fmp4.root,
            size: fmp4.files.get(fmp4.root)!.length,
            sink: { write: () => undefined },
          });
    expect(r.ok).toBe(false);

    // Stop: removed from the store, the network's listener goes, its endpoint is null.
    expect(await w.client.request('nfx.seed.stop', { video: vector.video })).toEqual({
      removed: true,
    });
    expect(existsSync(storedPath(storage, vector.root))).toBe(false);
    expect(await w.client.request('nfx.endpoint', { seeder: SEEDER_NOSTR, namespace: ns })).toEqual(
      { hyperdht: null },
    );
    expect((await w.client.request('nfx.seed.list', {})).videos.map((x) => x.video)).toEqual([
      fmp4.video,
    ]);
    expect(await w.client.request('nfx.seed.stop', { video: vector.video })).toEqual({
      removed: false,
    });
    expect(w.fatal).toEqual([]);
  });

  it('(c) the progressive stream serves layout C by range; refusals', async () => {
    const v = testNfxVideo();
    const empty = await pearSeeder(memorySource(new Map(), v.video), NFX_NS);
    const full = await pearSeeder(memorySource(v.files, v.video), NFX_NS);
    const { w, storage } = await worker();
    const s = sid();
    const opened = await w.client.request('nfx.play.open', {
      sid: s,
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [empty, full],
      origin: false,
    });
    expect(opened.rendition).toBe('720p');
    expect(opened.renditions).toEqual([
      { id: '720p', bandwidth: 2_000_000, resolution: '1280x720' },
      { id: '360p', bandwidth: 500_000, resolution: '640x360' },
    ]);
    expect(opened.originUrl).toBeNull();
    const link = opened.progressiveUrl!;
    expect(link).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/[0-9a-f]{32}/${s}$`));
    const size = v.expected.length;
    const expected = Buffer.from(v.expected);

    const whole = await httpGet(link);
    expect(whole.status).toBe(200);
    expect(whole.headers['content-type']).toBe('video/mp4');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['content-length']).toBe(String(size));
    expect(whole.body.equals(expected)).toBe(true);

    // Across init|sidx, sidx|segment 0, segment 0|1|2, and the whole view as one range: always
    // the whole range asked for (Chromium reads a short 206 as the end of the file).
    const [seg0, seg1, seg2] = v.segmentAt as [number, number, number];
    for (const [a, b] of [
      [v.sidxAt - 3, v.sidxAt + 5],
      [seg0 - 7, seg0 + 9],
      [seg1 - 1, seg2 + 2],
      [0, size - 1],
    ] as const) {
      const r = await httpGet(link, { range: `bytes=${a}-${b}` });
      expect(r.status, `${a}-${b}`).toBe(206);
      expect(r.headers['content-range']).toBe(`bytes ${a}-${b}/${size}`);
      expect(r.headers['content-length']).toBe(String(b - a + 1));
      expect(r.body.equals(expected.subarray(a, b + 1)), `${a}-${b}`).toBe(true);
    }
    const tail = await httpGet(link, { range: 'bytes=-10' });
    expect(tail.status).toBe(206);
    expect(tail.body.equals(expected.subarray(size - 10))).toBe(true);
    const open = await httpGet(link, { range: `bytes=${seg2}-` });
    expect(open.body.equals(expected.subarray(seg2))).toBe(true);
    const past = await httpGet(link, { range: `bytes=${seg2}-${size + 99}` });
    expect(past.status).toBe(206);
    expect(past.body.equals(expected.subarray(seg2))).toBe(true);

    const head = await request(link, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(size));
    expect(head.body.length).toBe(0);
    for (const range of [`bytes=${size}-`, 'bytes=5-2', 'bytes=0-1,3-4', 'bytes=-0']) {
      const r = await httpGet(link, { range });
      expect(r.status, range).toBe(416);
      expect(r.headers['content-range'], range).toBe(`bytes */${size}`);
    }
    expect((await request(link, { method: 'POST' })).status).toBe(405);

    // The token is the session's: another sid on it, or another token, is 404.
    expect((await httpGet(link.replace(s, 'f'.repeat(32)))).status).toBe(404);
    expect((await httpGet(link.replace(/\/[0-9a-f]{32}\//, `/${'0'.repeat(32)}/`))).status).toBe(
      404,
    );
    expect((await httpGet(`${link}?x=1`)).status).toBe(404);

    const spool = join(storage, 'tmp', NFX_PLAY_DIR, s);
    expect(existsSync(spool)).toBe(true);
    await w.client.request('nfx.play.close', { sid: s });
    await w.client.request('nfx.play.close', { sid: s });
    expect((await httpGet(link)).status).toBe(404);
    expect(existsSync(spool)).toBe(false);

    // nutflix-pear's refusals, through this protocol.
    const args = (over: Partial<NfxPlayOpenArgs> = {}): NfxPlayOpenArgs => ({
      sid: sid(),
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [full],
      ...over,
    });
    const low = args({ renditions: ['4k', '360p'] });
    const lowOpened = await w.client.request('nfx.play.open', low);
    expect(lowOpened.rendition).toBe('360p');
    expect((await httpGet(lowOpened.progressiveUrl!)).body.equals(expected)).toBe(true);
    await expect(w.client.request('nfx.play.open', { ...low })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await w.client.request('nfx.play.close', { sid: low.sid });
    await expect(
      w.client.request('nfx.play.open', args({ renditions: ['4k'] })),
    ).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(
      w.client.request('nfx.play.open', args({ segs: v.segs + 1 })),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(w.client.request('nfx.play.open', args({ peers: [empty] }))).rejects.toMatchObject(
      {
        code: 'no-seeders',
      },
    );
    const sessions = Array.from({ length: MAX_NFX_SESSIONS }, () => args());
    for (const a of sessions) await w.client.request('nfx.play.open', a);
    expect((await w.client.request('status', {})).playSessions).toBe(MAX_NFX_SESSIONS);
    await expect(w.client.request('nfx.play.open', args())).rejects.toMatchObject({
      code: 'rate-limited',
    });
    for (const a of sessions) await w.client.request('nfx.play.close', { sid: a.sid });
    expect((await w.client.request('status', {})).playSessions).toBe(0);
    expect(w.fatal).toEqual([]);
  });

  it('(d) the origin serves what a web player asks for, and only that; from the store too', async () => {
    const v = vectorVideo();
    const ns = namespaceOf(v.video);
    const full = await pearSeeder(memorySource(v.files, v.video), ns);
    const { w } = await worker();

    /** What hls.js and the nfx player fetch, from the master playlist down; each verified. */
    async function playerFetches(base: string): Promise<string[]> {
      const fetched: string[] = [];
      const get = async (url: string, sha: string): Promise<string> => {
        const r = await httpGet(url);
        expect(r.status, url).toBe(200);
        expect(r.headers['access-control-allow-origin'], url).toBe('*');
        expect(sha256(r.body), url).toBe(sha);
        fetched.push(sha);
        return r.body.toString('utf8');
      };
      await get(`${base}/${v.root}`, v.root);
      const master = await get(
        `${base}/${v.root}/master.m3u8`,
        v.byName.get('master.m3u8')!.sha256,
      );
      const uri = (text: string): string[] => [
        ...text.split('\n').filter((l) => l.length > 0 && !l.startsWith('#')),
        ...[...text.matchAll(/URI="([^"]+)"/g)].map((m) => m[1]!),
      ];
      for (const variant of uri(master)) {
        const playlistUrl = new URL(variant, `${base}/${v.root}/master.m3u8`).href;
        const playlist = await get(playlistUrl, variant.slice(0, 64));
        for (const member of uri(playlist))
          await get(new URL(member, playlistUrl).href, member.slice(0, 64));
      }
      return fetched;
    }

    // Over HyperDHT. The vector's bytes are not fMP4: no progressive stream, the origin plays.
    const s = sid();
    const opened = await w.client.request('nfx.play.open', {
      sid: s,
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [full],
    });
    expect(opened.progressiveUrl).toBeNull();
    expect(opened.rendition).toBe('720p');
    const base = opened.originUrl!;
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    const fetched = await playerFetches(base);
    // The hash list, the master, the 720p playlist, its init and three segments.
    expect(fetched).toHaveLength(7);
    for (const name of ['r720.m3u8', 'init-720.mp4', 'seg0.m4s', 'seg1.m4s', 'seg2.m4s'])
      expect(fetched).toContain(v.byName.get(name)!.sha256);
    // Only under the session's token; nothing but the listed files.
    const hostPort = base.slice(0, base.lastIndexOf('/'));
    for (const url of [
      `${hostPort}/${v.root}`,
      `${hostPort}/${'0'.repeat(32)}/${v.root}`,
      `${base}/${'e'.repeat(64)}`,
      `${base}/${v.root}/${'e'.repeat(64)}.m4s`,
      `${base}/${v.root}/master.m3u8?x=1`,
    ])
      expect((await httpGet(url)).status, url).toBe(404);
    await w.client.request('nfx.play.close', { sid: s });
    expect((await httpGet(`${base}/${v.root}`)).status).toBe(404);

    // Origin only, asked for so: the same.
    const onlyOrigin = await w.client.request('nfx.play.open', {
      sid: sid(),
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [full],
      progressive: false,
    });
    expect(onlyOrigin.progressiveUrl).toBeNull();
    // Progressive only, asked for so: this video cannot be one file, and that is the answer.
    await expect(
      w.client.request('nfx.play.open', {
        sid: sid(),
        video: v.video,
        root: v.root,
        segs: v.segs,
        peers: [full],
        origin: false,
      }),
    ).rejects.toMatchObject({ code: 'unsupported-input' });

    // Stored, then played with no seeder named: from the store alone.
    await w.client.request('nfx.seed.start', {
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [full],
    });
    const local = await w.client.request('nfx.play.open', {
      sid: sid(),
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [],
      progressive: false,
    });
    expect(await playerFetches(local.originUrl!)).toHaveLength(7);
    expect(w.fatal).toEqual([]);
  });
});
