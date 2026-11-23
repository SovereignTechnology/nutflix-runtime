/**
 * What stays private, and what a window may undo, on a loopback hyperdht testnet. A video Studio
 * packaged is the user's until they confirm publishing it, and a compromised page must not be able
 * to read it, keep it, or quietly destroy what they did publish.
 *
 * The drafts here are recorded the way Studio records them (`published`, no author) and their files
 * come through nutflix-pear's own seeder, so that no encode is needed. The real encode is in
 * `packages/renderer/e2e/publish/`.
 */
import { hyperdhtEndpoint, listenNfx, type NfxFileSource } from '@sovit/seeder';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkerError } from '../errors.js';
import type { NfxHyperdhtEndpointWire, SignedEventWire } from '../protocol.js';
import { nodeRuntime, startWorker, tempDir, until, type RunningWorker } from './helpers/harness.js';
import { memorySource, segments, testNfxVideo, type TestNfxVideo } from './helpers/nfx-video.js';

vi.setConfig({ testTimeout: 120_000 });

const SID = 'ab'.repeat(16);
const AUTHOR = 'cd'.repeat(32);

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof WorkerError ? e.code : 'not-a-worker-error';
  }
};

function signedManifest(v: TestNfxVideo): SignedEventWire {
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
        ['license', 'open'],
        ['root', v.root],
        ['segs', String(v.segs)],
      ],
    },
    generateSecretKey(),
  );
  return JSON.parse(JSON.stringify(event)) as SignedEventWire;
}

describe('private until confirmed', () => {
  let testnet: Testnet;
  const cleanups: (() => Promise<void> | void)[] = [];

  beforeEach(async () => {
    testnet = await createTestnet(3);
  });
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    await testnet.destroy();
  });

  async function seeder(
    v: TestNfxVideo,
    source: NfxFileSource = memorySource(v.files, v.video),
  ): Promise<NfxHyperdhtEndpointWire> {
    const dht = new DHT({ bootstrap: testnet.bootstrap });
    cleanups.push(() => dht.destroy());
    await dht.fullyBootstrapped();
    const keyPair = DHT.keyPair();
    const listener = await listenNfx(dht, { keyPair, source });
    cleanups.push(() => listener.close());
    return hyperdhtEndpoint(keyPair, 'ef'.repeat(32), 'nfx:testnet:1');
  }

  async function worker(
    dir?: string,
    over: { readonly maxWatchBytesPerHour?: number } = {},
  ): Promise<{ w: RunningWorker; dir: string }> {
    let storage = dir;
    if (storage === undefined) {
      const d = await tempDir('nf-private-');
      cleanups.push(() => d.rm());
      storage = d.dir;
    }
    const w = startWorker({ runtime: nodeRuntime(), ...over });
    cleanups.push(() => w.close());
    await w.client.request('init', { v: 1, storage, bootstrap: testnet.bootstrap });
    return { w, dir: storage };
  }

  /** A stored video recorded as Studio records a draft: `published`, signed by nobody yet. */
  async function storedDraft(w: RunningWorker, v: TestNfxVideo): Promise<void> {
    const endpoint = await seeder(v);
    await w.host.internals?.policy.set(v.video, {
      origin: 'published',
      root: v.root,
      author: null,
    });
    await w.client.request('nfx.seed.start', {
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [endpoint],
    });
  }

  const open = (w: RunningWorker, v: TestNfxVideo): Promise<unknown> =>
    w.client.request('nfx.play.open', {
      sid: SID,
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [],
      progressive: false,
    });

  it('a play cannot read an unsigned draft', async () => {
    const v = testNfxVideo();
    const { w } = await worker();
    await storedDraft(w, v);
    expect((await w.client.request('status', {})).storedVideos).toBe(1);
    expect(await code(open(w, v))).toBe('not-found');
    expect((await w.client.request('status', {})).playSessions).toBe(0);
  });

  it('once signed it plays', async () => {
    const v = testNfxVideo();
    const { w } = await worker();
    await storedDraft(w, v);
    await w.host.internals?.policy.set(v.video, {
      origin: 'published',
      root: v.root,
      author: AUTHOR,
    });
    expect(await code(open(w, v))).toBe('ok');
  });

  it('seeding.status gives a window nothing of a draft’s hash list', async () => {
    const v = testNfxVideo();
    const { w } = await worker();
    await storedDraft(w, v);
    const [shown] = (await w.client.request('seeding.status', {})).videos;
    expect(shown).toMatchObject({ video: v.video, origin: 'published', served: false });
    expect(shown).not.toHaveProperty('root');
    expect(shown).not.toHaveProperty('segs');
    expect(JSON.stringify(shown)).not.toContain(v.root);
  });

  it('a restart deletes an unsigned draft, bytes and record', async () => {
    const v = testNfxVideo();
    const { w, dir } = await worker();
    await storedDraft(w, v);
    await w.close();
    const again = await worker(dir);
    expect((await again.w.client.request('status', {})).storedVideos).toBe(0);
    expect((await again.w.client.request('seeding.status', {})).videos).toEqual([]);
    expect(again.w.host.internals?.policy.record(v.video)).toBeUndefined();
  });

  it('a restart keeps what the user did publish', async () => {
    const v = testNfxVideo();
    const { w, dir } = await worker();
    await storedDraft(w, v);
    await w.host.internals?.policy.set(v.video, {
      origin: 'published',
      root: v.root,
      author: AUTHOR,
    });
    await w.close();
    const again = await worker(dir);
    expect((await again.w.client.request('status', {})).storedVideos).toBe(1);
  });

  it('declining deletes the draft; it cannot delete anything else', async () => {
    const v = testNfxVideo();
    const { w } = await worker();
    await storedDraft(w, v);
    expect(await w.client.request('studio.discard', { video: v.video })).toEqual({ removed: true });
    expect((await w.client.request('status', {})).storedVideos).toBe(0);

    const kept = testNfxVideo(segments(2));
    await storedDraft(w, kept);
    await w.host.internals?.policy.set(kept.video, {
      origin: 'published',
      root: kept.root,
      author: AUTHOR,
    });
    expect(await w.client.request('studio.discard', { video: kept.video })).toEqual({
      removed: false,
    });
    expect((await w.client.request('status', {})).storedVideos).toBe(1);
  });

  it('a window’s stop keeps the bytes; only the main-only delete removes them', async () => {
    const v = testNfxVideo();
    const endpoint = await seeder(v);
    const { w } = await worker();
    await w.client.request('nfx.seed.start', {
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [endpoint],
    });
    expect(await w.client.request('seeding.stop', { video: v.video })).toEqual({ stopped: true });
    let s = await w.client.request('status', {});
    expect(s.storedVideos).toBe(1);
    expect(s.listening).toEqual([]);
    expect((await w.client.request('seeding.status', {})).videos).toMatchObject([
      { video: v.video, served: false, stopped: true },
    ]);
    expect(await w.client.request('seeding.resume', { video: v.video })).toEqual({ resumed: true });
    s = await w.client.request('status', {});
    expect(s.listening).toHaveLength(1);
    expect(await w.client.request('seeding.delete', { video: v.video })).toEqual({ removed: true });
    expect((await w.client.request('status', {})).storedVideos).toBe(0);
  });

  it('a stopped video stays stopped across a restart', async () => {
    const v = testNfxVideo();
    const endpoint = await seeder(v);
    const { w, dir } = await worker();
    await w.client.request('nfx.seed.start', {
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [endpoint],
    });
    await w.client.request('seeding.stop', { video: v.video });
    await w.close();
    const again = await worker(dir);
    const s = await again.w.client.request('status', {});
    expect(s.storedVideos).toBe(1);
    expect(s.dht).toBe('idle');
    expect(s.listening).toEqual([]);
  });

  it('a draft cannot be resumed into being served', async () => {
    const v = testNfxVideo();
    const { w } = await worker();
    await storedDraft(w, v);
    expect(await code(w.client.request('seeding.resume', { video: v.video }))).toBe(
      'invalid-argument',
    );
    expect((await w.client.request('status', {})).listening).toEqual([]);
  });

  it('a stored video no record explains cannot be made public by watching it', async () => {
    const v = testNfxVideo();
    const endpoint = await seeder(v);
    const { w } = await worker();
    await w.client.request('nfx.seed.start', {
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [endpoint],
    });
    await w.client.request('nfx.play.open', {
      sid: SID,
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [endpoint],
      progressive: false,
    });
    await w.client.request('seeding.set', { watched: true });
    // The record is lost, as with a damaged `seeding.json`.
    await w.host.internals?.policy.remove(v.video);
    await w.host.internals?.seeds.refresh();
    expect(
      await code(
        w.client.request('seeding.watch', {
          sid: SID,
          manifest: signedManifest(v),
          peers: [endpoint],
        }),
      ),
    ).toBe('invalid-argument');
    expect(w.host.internals?.policy.served(v.video)).toBe(false);
  });

  it('turning the switch off stops a fetch in flight and drops what was handed over', async () => {
    const v = testNfxVideo();
    const sha = v.segmentShas[1];
    if (sha === undefined) throw new Error('no segment');
    const whole = memorySource(v.files, v.video);
    // A seeder that never finishes sending one file: the fetch is still running.
    let release: () => void = () => undefined;
    const hung = new Promise<Uint8Array>((_resolve, reject) => {
      release = () => {
        reject(new Error('the test is over'));
      };
    });
    hung.catch(() => undefined);
    const endpoint = await seeder(v, {
      hasVideo: (x) => whole.hasVideo(x),
      file: (x, s) => {
        if (s !== sha) return whole.file(x, s);
        const held = v.files.get(s);
        return held === undefined ? undefined : { size: held.byteLength, read: () => hung };
      },
    });
    cleanups.push(() => {
      release();
    });
    const { w } = await worker();
    await w.client.request('seeding.set', { watched: true });
    await w.client.request('nfx.play.open', {
      sid: SID,
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [endpoint],
      progressive: false,
    });
    const first = v.segmentShas[0];
    const bytes = first === undefined ? undefined : v.files.get(first);
    if (first === undefined || bytes === undefined) throw new Error('no bytes');
    expect(
      await w.client.request('seeding.segment', {
        sid: SID,
        sha256: first,
        size: bytes.length,
        offset: 0,
        data: Buffer.from(bytes).toString('base64'),
      }),
    ).toEqual({ accepted: true, complete: true });
    expect(w.host.internals?.offers.keptBytes).toBe(bytes.length);

    const watch = code(
      w.client.request('seeding.watch', {
        sid: SID,
        manifest: signedManifest(v),
        peers: [endpoint],
      }),
    );
    await until(
      () => w.events.some((e) => e.e === 'nfx.seed' && e.state === 'fetching'),
      'the fetch to start',
      30_000,
    );
    await w.client.request('seeding.set', { watched: false });
    expect(await watch).not.toBe('ok');
    const s = await w.client.request('status', {});
    expect(s.storedVideos).toBe(0);
    expect(s.listening).toEqual([]);
    expect(w.host.internals?.offers.keptBytes).toBe(0);
    expect(w.host.internals?.policy.record(v.video)).toBeUndefined();
  });

  it('deleting and fetching again does not reset the hourly byte budget', async () => {
    const v = testNfxVideo();
    let total = 0;
    for (const f of v.files.values()) total += f.byteLength;
    const endpoint = await seeder(v);
    const { w } = await worker(undefined, { maxWatchBytesPerHour: total + 1 });
    await w.client.request('seeding.set', { watched: true });
    await w.client.request('nfx.play.open', {
      sid: SID,
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [endpoint],
      progressive: false,
    });
    const manifest = signedManifest(v);
    await w.client.request('seeding.watch', { sid: SID, manifest, peers: [endpoint] });
    await w.client.request('seeding.delete', { video: v.video });
    expect(
      await code(w.client.request('seeding.watch', { sid: SID, manifest, peers: [endpoint] })),
    ).toBe('rate-limited');
    expect((await w.client.request('status', {})).storedVideos).toBe(0);
  });
});
