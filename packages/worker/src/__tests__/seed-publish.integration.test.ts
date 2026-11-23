/**
 * Seeding, through the real wire, on a loopback hyperdht testnet, with nutflix-pear's own seeder
 * and client (`listenNfx`, `dialNfx`) on the other end:
 *
 *   - a launch with nothing to play or seed starts no DHT node;
 *   - the switch is off by default, and a video is stored for seeding only with it on;
 *   - what is served is announced by beacons that verify, and fetched byte for byte;
 *   - turning the switch off stops serving at once, and a restart stays off;
 *   - a file handed over from WebRTC counts only if the session's hash list names it, and is then
 *     re-seeded though no other seeder has it.
 */
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { NostrEvent } from '@sovit/core';
import { nfx } from '@sovit/core';
import { dialNfx, hyperdhtEndpoint, listenNfx, nodeCrypto, type NfxListener } from '@sovit/seeder';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkerError } from '../errors.js';
import { SEEDING_FILE } from '../nfx/seed-policy.js';
import type { NfxHyperdhtEndpointWire, SignedEventWire } from '../protocol.js';
import { nodeRuntime, startWorker, tempDir, type RunningWorker } from './helpers/harness.js';
import { memorySource, segments, testNfxVideo, type TestNfxVideo } from './helpers/nfx-video.js';

vi.setConfig({ testTimeout: 120_000 });

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const SID = 'ab'.repeat(16);

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof WorkerError ? e.code : 'not-a-worker-error';
  }
};

function signedManifest(
  v: TestNfxVideo,
  over: { readonly license?: string; readonly extra?: string[][] } = {},
): SignedEventWire {
  const at = Math.floor(Date.now() / 1000) - 60;
  const event = finalizeEvent(
    {
      kind: 38504,
      created_at: at,
      content: 'a free test video',
      tags: [
        ['d', v.video],
        ['n', 'nfx:testnet:1'],
        ['title', 'Test video'],
        ['published_at', String(at)],
        ['license', over.license ?? 'open'],
        ['root', v.root],
        ['segs', String(v.segs)],
        ...(over.extra ?? []),
      ],
    },
    generateSecretKey(),
  );
  return JSON.parse(JSON.stringify(event)) as SignedEventWire;
}

describe('seeding, on a loopback testnet', () => {
  let testnet: Testnet;
  const cleanups: (() => Promise<void> | void)[] = [];

  beforeEach(async () => {
    testnet = await createTestnet(3);
  });
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    await testnet.destroy();
  });

  async function dhtNode(): Promise<DHT> {
    const n = new DHT({ bootstrap: testnet.bootstrap });
    cleanups.push(() => n.destroy());
    await n.fullyBootstrapped();
    return n;
  }

  /** nutflix-pear's own seeder, holding `files`. */
  async function otherSeeder(
    v: TestNfxVideo,
    files: ReadonlyMap<string, Uint8Array> = v.files,
  ): Promise<{ endpoint: NfxHyperdhtEndpointWire; listener: NfxListener }> {
    const dht = await dhtNode();
    const keyPair = DHT.keyPair();
    const listener = await listenNfx(dht, { keyPair, source: memorySource(files, v.video) });
    cleanups.push(() => listener.close());
    return { endpoint: hyperdhtEndpoint(keyPair, 'cd'.repeat(32), 'nfx:testnet:1'), listener };
  }

  /** A play of `v`: what makes it a video this viewer is watching. */
  async function play(
    w: RunningWorker,
    v: TestNfxVideo,
    endpoint: NfxHyperdhtEndpointWire,
  ): Promise<void> {
    await w.client.request('nfx.play.open', {
      sid: SID,
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [endpoint],
      progressive: false,
    });
  }

  async function worker(
    dir?: string,
    over: { readonly maxWatchedBytes?: number } = {},
  ): Promise<{ w: RunningWorker; dir: string }> {
    let storage = dir;
    if (storage === undefined) {
      const d = await tempDir('nf-seed-');
      cleanups.push(() => d.rm());
      storage = d.dir;
    }
    const w = startWorker({ runtime: nodeRuntime(), ...over });
    cleanups.push(() => w.close());
    await w.client.request('init', { v: 1, storage, bootstrap: testnet.bootstrap });
    return { w, dir: storage };
  }

  /** Every file of `v`, fetched from `endpoint` by nutflix-pear's own client, byte for byte. */
  async function fetchAll(v: TestNfxVideo, endpoint: { peer: string }): Promise<number> {
    const dht = await dhtNode();
    const dialed = await dialNfx(dht, Buffer.from(endpoint.peer, 'hex'), {
      keyPair: DHT.keyPair(),
      crypto: nodeCrypto,
      timeoutMs: 20_000,
    });
    if (!dialed.ok) throw new Error(`dial failed: ${dialed.reason}`);
    cleanups.push(() => {
      dialed.connection.destroy('test over');
    });
    const addr = nfx.VideoAddr.parse(v.video);
    if (!addr.ok) throw new Error('bad test video');
    const client = dialed.connection.files(addr.value);
    if (client === undefined) throw new Error('no files channel');
    let n = 0;
    for (const [sha, bytes] of v.files) {
      const chunks: Uint8Array[] = [];
      const r = await client.fetch({
        sha,
        size: bytes.byteLength,
        sink: { write: (c) => void chunks.push(c) },
      });
      expect(r).toEqual({ ok: true, bytes: bytes.byteLength });
      const got = Buffer.concat(chunks);
      expect(got.equals(Buffer.from(bytes))).toBe(true);
      expect(sha256(got)).toBe(sha);
      n += 1;
    }
    return n;
  }

  it('a launch with nothing to play or seed starts no DHT node', async () => {
    const { w } = await worker();
    expect((await w.client.request('seeding.status', {})).watched).toBe(false);
    expect((await w.client.request('seeding.beacons', {})).events).toEqual([]);
    await w.client.request('signer.status', {});
    await w.client.request('seeding.set', { watched: true });
    await w.client.request('seeding.set', { watched: false });
    const s = await w.client.request('status', {});
    expect(s.dht).toBe('idle');
    expect(s.listening).toEqual([]);
  });

  it('the switch is off by default: a watched video is not stored', async () => {
    const v = testNfxVideo();
    const { endpoint } = await otherSeeder(v);
    const { w } = await worker();
    expect(
      await code(
        w.client.request('seeding.watch', {
          sid: SID,
          manifest: signedManifest(v),
          peers: [endpoint],
        }),
      ),
    ).toBe('invalid-argument');
    expect((await w.client.request('status', {})).storedVideos).toBe(0);
    expect((await w.client.request('status', {})).dht).toBe('idle');
  });

  it('with the switch on, it stores, serves and announces; off, it stops; a restart stays off', async () => {
    const v = testNfxVideo();
    const { endpoint, listener } = await otherSeeder(v);
    const { w, dir } = await worker();
    await w.client.request('seeding.set', { watched: true });
    await play(w, v, endpoint);
    const manifest = signedManifest(v);
    const stored = await w.client.request('seeding.watch', {
      sid: SID,
      manifest,
      peers: [endpoint],
    });
    expect(stored.files).toBe(v.files.size);
    const status = await w.client.request('seeding.status', {});
    expect(status.videos).toMatchObject([{ video: v.video, origin: 'watched', served: true }]);
    expect(status.listening).toHaveLength(1);

    const { events } = await w.client.request('seeding.beacons', {});
    expect(events).toHaveLength(1);
    const beacon = nfx.parseBeacon(events[0], Math.floor(Date.now() / 1000));
    if (!beacon.ok) throw new Error(beacon.error.reason);
    expect(beacon.value.creator).toBe(manifest.pubkey);
    expect(beacon.value.content.free).toBe(true);
    expect(beacon.value.content.priceHint).toBe(0n);
    expect(beacon.value.content.video.toString()).toBe(v.video);
    // The seeder key is not the creator's.
    expect((events[0] as NostrEvent).pubkey).not.toBe(manifest.pubkey);
    const ep = beacon.value.content.endpoints[0];
    if (ep?.t !== 'hyperdht') throw new Error('no hyperdht endpoint');

    // Nobody else holds it any more: what is fetched now comes from this worker.
    await listener.close();
    expect(await fetchAll(v, ep)).toBe(v.files.size);

    await w.client.request('seeding.set', { watched: false });
    expect((await w.client.request('seeding.beacons', {})).events).toEqual([]);
    expect((await w.client.request('status', {})).listening).toEqual([]);
    await w.close();

    const again = await worker(dir);
    const after = await again.w.client.request('status', {});
    expect(after.storedVideos).toBe(1);
    expect(after.dht).toBe('idle');
    expect(after.listening).toEqual([]);
    expect((await again.w.client.request('seeding.status', {})).watched).toBe(false);
  });

  it('a restart with the switch on serves again; stopping a video deletes it', async () => {
    const v = testNfxVideo();
    const { endpoint } = await otherSeeder(v);
    const { w, dir } = await worker();
    await w.client.request('seeding.set', { watched: true });
    await play(w, v, endpoint);
    await w.client.request('seeding.watch', {
      sid: SID,
      manifest: signedManifest(v),
      peers: [endpoint],
    });
    await w.close();

    const again = await worker(dir);
    expect((await again.w.client.request('status', {})).listening).toHaveLength(1);
    expect((await again.w.client.request('seeding.beacons', {})).events).toHaveLength(1);
    expect(await again.w.client.request('seeding.stop', { video: v.video })).toEqual({
      removed: true,
    });
    const s = await again.w.client.request('status', {});
    expect(s.storedVideos).toBe(0);
    expect(s.listening).toEqual([]);
  });

  it('refuses a manifest that does not verify, or is not free', async () => {
    const v = testNfxVideo();
    const { endpoint } = await otherSeeder(v);
    const { w } = await worker();
    await w.client.request('seeding.set', { watched: true });
    await play(w, v, endpoint);
    const tampered = { ...signedManifest(v), content: 'changed after signing' };
    const priced = signedManifest(v, { extra: [['price_hint', '5']] });
    for (const manifest of [tampered, priced])
      expect(
        await code(w.client.request('seeding.watch', { sid: SID, manifest, peers: [endpoint] })),
      ).toBe('invalid-argument');
    expect((await w.client.request('status', {})).storedVideos).toBe(0);
  });

  it('seeds only the video of an open play', async () => {
    const v = testNfxVideo();
    const other = testNfxVideo(segments(2));
    const { endpoint } = await otherSeeder(v);
    const { w } = await worker();
    await w.client.request('seeding.set', { watched: true });
    const manifest = signedManifest(v);
    // No play at all.
    expect(
      await code(w.client.request('seeding.watch', { sid: SID, manifest, peers: [endpoint] })),
    ).toBe('session-closed');
    await play(w, v, endpoint);
    // A play of this address, and a manifest naming another hash list.
    const otherRoot = signedManifest({ ...v, root: other.root });
    expect(
      await code(
        w.client.request('seeding.watch', { sid: SID, manifest: otherRoot, peers: [endpoint] }),
      ),
    ).toBe('invalid-argument');
    expect((await w.client.request('status', {})).storedVideos).toBe(0);
  });

  it('keeps watched videos within their own byte budget', async () => {
    const v = testNfxVideo();
    const { endpoint } = await otherSeeder(v);
    const { w } = await worker(undefined, { maxWatchedBytes: 16 });
    await w.client.request('seeding.set', { watched: true });
    await play(w, v, endpoint);
    expect(
      await code(
        w.client.request('seeding.watch', {
          sid: SID,
          manifest: signedManifest(v),
          peers: [endpoint],
        }),
      ),
    ).toBe('disk-cap');
    expect((await w.client.request('status', {})).storedVideos).toBe(0);
  });

  it('a stored video no record explains is not served, and starts no DHT node', async () => {
    const v = testNfxVideo();
    const { endpoint } = await otherSeeder(v);
    const { w, dir } = await worker();
    await w.client.request('nfx.seed.start', {
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [endpoint],
    });
    expect((await w.client.request('status', {})).listening).toHaveLength(1);
    await w.close();
    // The record is lost: a crash, or a damaged file.
    await rm(join(dir, SEEDING_FILE));

    const again = await worker(dir);
    const s = await again.w.client.request('status', {});
    expect(s.storedVideos).toBe(1);
    expect(s.dht).toBe('idle');
    expect(s.listening).toEqual([]);
    expect((await again.w.client.request('seeding.status', {})).videos).toMatchObject([
      { video: v.video, origin: 'unknown', served: false },
    ]);
    expect((await again.w.client.request('seeding.beacons', {})).events).toEqual([]);
  });

  describe('a file handed over from WebRTC', () => {
    const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

    async function playing(v: TestNfxVideo): Promise<{ w: RunningWorker; missing: string }> {
      // The seeder has every file but one segment: only the hand-over can supply it.
      const missing = v.segmentShas[1];
      if (missing === undefined) throw new Error('no segment');
      const { endpoint } = await otherSeeder(
        v,
        new Map([...v.files].filter(([sha]) => sha !== missing)),
      );
      const { w } = await worker();
      await w.client.request('nfx.play.open', {
        sid: SID,
        video: v.video,
        root: v.root,
        segs: v.segs,
        peers: [endpoint],
        progressive: false,
      });
      await w.client.request('seeding.set', { watched: true });
      return { w, missing };
    }

    it('is re-seeded, though no other seeder holds it', async () => {
      const v = testNfxVideo();
      const missing = v.segmentShas[1];
      if (missing === undefined) throw new Error('no segment');
      const partial = new Map([...v.files].filter(([sha]) => sha !== missing));
      const { endpoint, listener } = await otherSeeder(v, partial);
      const { w } = await worker();
      await w.client.request('seeding.set', { watched: true });
      const manifest = signedManifest(v);
      await play(w, v, endpoint);
      // Without the hand-over the store cannot be completed.
      expect(
        await code(w.client.request('seeding.watch', { sid: SID, manifest, peers: [endpoint] })),
      ).toBe('no-seeders');
      const bytes = v.files.get(missing);
      if (bytes === undefined) throw new Error('no bytes');
      // In two chunks, as the renderer sends a larger file.
      const cut = Math.floor(bytes.length / 2);
      const first = bytes.subarray(0, cut);
      const a = first.length % 3 === 0 ? first : bytes.subarray(0, cut - (cut % 3));
      expect(
        await w.client.request('seeding.segment', {
          sid: SID,
          sha256: missing,
          size: bytes.length,
          offset: 0,
          data: b64(a),
        }),
      ).toEqual({ accepted: true, complete: false });
      expect(
        await w.client.request('seeding.segment', {
          sid: SID,
          sha256: missing,
          size: bytes.length,
          offset: a.length,
          data: b64(bytes.subarray(a.length)),
        }),
      ).toEqual({ accepted: true, complete: true });

      const stored = await w.client.request('seeding.watch', {
        sid: SID,
        manifest,
        peers: [endpoint],
      });
      expect(stored.files).toBe(v.files.size);
      await listener.close();
      const { events } = await w.client.request('seeding.beacons', {});
      const beacon = nfx.parseBeacon(events[0], Math.floor(Date.now() / 1000));
      if (!beacon.ok) throw new Error(beacon.error.reason);
      const ep = beacon.value.content.endpoints[0];
      if (ep?.t !== 'hyperdht') throw new Error('no hyperdht endpoint');
      expect(await fetchAll(v, ep)).toBe(v.files.size);
    });

    it('is not taken while the switch is off', async () => {
      const v = testNfxVideo();
      const { endpoint } = await otherSeeder(v);
      const { w } = await worker();
      await play(w, v, endpoint);
      const sha = v.segmentShas[0];
      if (sha === undefined) throw new Error('no segment');
      const real = v.files.get(sha);
      if (real === undefined) throw new Error('no bytes');
      expect(
        await w.client.request('seeding.segment', {
          sid: SID,
          sha256: sha,
          size: real.length,
          offset: 0,
          data: b64(real),
        }),
      ).toEqual({ accepted: false, complete: false });
    });

    it('is refused when the hash list does not name it', async () => {
      const v = testNfxVideo();
      const { w } = await playing(v);
      const bytes = new Uint8Array(12).fill(9);
      expect(
        await code(
          w.client.request('seeding.segment', {
            sid: SID,
            sha256: sha256(bytes),
            size: bytes.length,
            offset: 0,
            data: b64(bytes),
          }),
        ),
      ).toBe('invalid-argument');
    });

    it('is refused when its bytes are not the listed file, and nothing is kept', async () => {
      const v = testNfxVideo();
      const { w, missing } = await playing(v);
      const real = v.files.get(missing);
      if (real === undefined) throw new Error('no bytes');
      const wrong = new Uint8Array(real.length).fill(7);
      expect(
        await code(
          w.client.request('seeding.segment', {
            sid: SID,
            sha256: missing,
            size: wrong.length,
            offset: 0,
            data: b64(wrong),
          }),
        ),
      ).toBe('invalid-argument');
      // And the store still has no way to complete the video.
      expect(
        await code(
          w.client.request('seeding.watch', { sid: SID, manifest: signedManifest(v), peers: [] }),
        ),
      ).toBe('no-seeders');
    });

    it('is refused at a size the hash list does not say, or out of order', async () => {
      const v = testNfxVideo();
      const { w, missing } = await playing(v);
      const real = v.files.get(missing);
      if (real === undefined) throw new Error('no bytes');
      const base = { sid: SID, sha256: missing, size: real.length };
      expect(
        await code(
          w.client.request('seeding.segment', {
            ...base,
            size: real.length + 1,
            offset: 0,
            data: b64(real.subarray(0, 3)),
          }),
        ),
      ).toBe('invalid-argument');
      expect(
        await code(
          w.client.request('seeding.segment', {
            ...base,
            offset: 3,
            data: b64(real.subarray(3, 6)),
          }),
        ),
      ).toBe('invalid-argument');
    });

    it('is refused for a session that is not open', async () => {
      const v = testNfxVideo();
      const { w, missing } = await playing(v);
      await w.client.request('nfx.play.close', { sid: SID });
      const real = v.files.get(missing);
      if (real === undefined) throw new Error('no bytes');
      expect(
        await code(
          w.client.request('seeding.segment', {
            sid: SID,
            sha256: missing,
            size: real.length,
            offset: 0,
            data: b64(real.subarray(0, 3)),
          }),
        ),
      ).toBe('session-closed');
    });
  });
});
