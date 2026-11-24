/**
 * What stays private, and what a window may undo, on a loopback hyperdht testnet. A video Studio
 * packaged is the user's until they confirm publishing it, and a compromised page must not be able
 * to read it, keep it, or quietly destroy what they did publish.
 *
 * The drafts here are recorded the way Studio records them (`published`, no author) and their files
 * come through nutflix-pear's own seeder, so that no encode is needed. The real encode is in
 * `packages/renderer/e2e/publish/`.
 */
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { hyperdhtEndpoint, listenNfx, nodeFs, type NfxFileSource } from '@sovit/seeder';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkerError } from '../errors.js';
import { SEEDING_FILE, SeedPolicy, type SeedRecord } from '../nfx/seed-policy.js';
import type { NfxHyperdhtEndpointWire, SignedEventWire } from '../protocol.js';
import type { WorkerRuntime } from '../runtime.js';
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

  /** A worker whose writes of `seeding.json` the test can hold or break. */
  async function workerOnFs(): Promise<{
    w: RunningWorker;
    dir: string;
    ctl: { hold: boolean; held: number; breakSave: boolean; release: () => void };
  }> {
    const d = await tempDir('nf-private-');
    cleanups.push(() => d.rm());
    const ctl = { hold: false, held: 0, breakSave: false, release: (): void => undefined };
    const base = nodeRuntime();
    const runtime: WorkerRuntime = {
      ...base,
      fs: {
        ...base.fs,
        writeFile: async (p, data) => {
          if (ctl.hold && p.includes(SEEDING_FILE)) {
            ctl.hold = false;
            ctl.held += 1;
            await new Promise<void>((r) => {
              ctl.release = r;
            });
          }
          await base.fs.writeFile(p, data);
        },
        rename: (from, to) =>
          ctl.breakSave && to.endsWith(SEEDING_FILE)
            ? Promise.reject(new Error('the disk is full'))
            : base.fs.rename(from, to),
      },
    };
    const w = startWorker({ runtime });
    cleanups.push(() => w.close());
    await w.client.request('init', { v: 1, storage: d.dir, bootstrap: testnet.bootstrap });
    return { w, dir: d.dir, ctl };
  }

  it('a switch turned off during the record’s write stops the fetch before it starts', async () => {
    const v = testNfxVideo();
    const endpoint = await seeder(v);
    const { w, ctl } = await workerOnFs();
    await w.client.request('seeding.set', { watched: true });
    await w.client.request('nfx.play.open', {
      sid: SID,
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [endpoint],
      progressive: false,
    });
    ctl.hold = true;
    const watch = code(
      w.client.request('seeding.watch', {
        sid: SID,
        manifest: signedManifest(v),
        peers: [endpoint],
      }),
    );
    await until(() => ctl.held === 1, 'the record’s write to start', 10_000);
    const off = w.client.request('seeding.set', { watched: false });
    await until(() => w.host.internals?.policy.watched === false, 'the switch to flip', 10_000);
    ctl.release();
    await off;
    expect(await watch).toBe('invalid-argument');
    expect((await w.client.request('status', {})).storedVideos).toBe(0);
    expect(w.host.internals?.policy.record(v.video)).toBeUndefined();
  });

  it('a save that fails still shuts down what the switch was running', async () => {
    const v = testNfxVideo();
    const endpoint = await seeder(v);
    const { w, ctl } = await workerOnFs();
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
    await w.client.request('seeding.segment', {
      sid: SID,
      sha256: first,
      size: bytes.length,
      offset: 0,
      data: Buffer.from(bytes).toString('base64'),
    });
    expect(w.host.internals?.offers.keptBytes).toBe(bytes.length);
    ctl.breakSave = true;
    expect(await code(w.client.request('seeding.set', { watched: false }))).toBe('io');
    expect(w.host.internals?.policy.watched).toBe(false);
    expect(w.host.internals?.offers.keptBytes).toBe(0);
  });

  it('an "on" that could not be saved does not stay on', async () => {
    const { w, ctl } = await workerOnFs();
    ctl.breakSave = true;
    expect(await code(w.client.request('seeding.set', { watched: true }))).toBe('io');
    expect(w.host.internals?.policy.watched).toBe(false);
  });

  it('a draft that cannot be purged does not stop the worker from starting', async () => {
    const v = testNfxVideo();
    const { w, dir } = await worker();
    await storedDraft(w, v);
    await w.close();
    const base = nodeRuntime();
    const broken: WorkerRuntime = {
      ...base,
      fs: {
        ...base.fs,
        rename: (from, to) =>
          to.endsWith(SEEDING_FILE)
            ? Promise.reject(new Error('read-only'))
            : base.fs.rename(from, to),
      },
    };
    const again = startWorker({ runtime: broken });
    cleanups.push(() => again.close());
    await again.client.request('init', { v: 1, storage: dir, bootstrap: testnet.bootstrap });
    const s = await again.client.request('status', {});
    expect(s.dht).toBe('idle');
    expect(s.listening).toEqual([]);
  });

  it('records the title of what it seeds, for the native dialogs', async () => {
    const v = testNfxVideo();
    const endpoint = await seeder(v);
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
    await w.client.request('seeding.watch', {
      sid: SID,
      manifest: signedManifest(v),
      peers: [endpoint],
    });
    const [shown] = (await w.client.request('seeding.status', {})).videos;
    expect(shown?.title).toBe('Test video');
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

describe('the seed policy on disk', () => {
  const VIDEO = `nfx:testnet:1:nutflix-${'a'.repeat(32)}`;
  const DRAFT: SeedRecord = { origin: 'published', root: 'ab'.repeat(32), author: null };
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });
  const dir = async (): Promise<string> => {
    const d = await tempDir('nf-policy-');
    cleanups.push(() => d.rm());
    return d.dir;
  };
  const onDisk = (d: string): { videos: Record<string, SeedRecord> } =>
    JSON.parse(readFileSync(join(d, SEEDING_FILE), 'utf8')) as {
      videos: Record<string, SeedRecord>;
    };

  it('a signed record is on disk, through the durable write, when setDurable resolves', async () => {
    const d = await dir();
    let durableWrites = 0;
    const policy = new SeedPolicy(nodeFs, d, {
      durable: async (p, data) => {
        durableWrites += 1;
        await writeFile(p, data);
        return true;
      },
    });
    await policy.set(VIDEO, DRAFT);
    await policy.setDurable(VIDEO, { ...DRAFT, author: AUTHOR });
    expect(durableWrites).toBe(2);
    expect(onDisk(d).videos[VIDEO]?.author).toBe(AUTHOR);
  });

  it('a durable write that fails leaves the record as it was', async () => {
    const d = await dir();
    let fail = false;
    const policy = new SeedPolicy(nodeFs, d, {
      durable: async (p, data) => {
        if (fail) throw new Error('the disk is full');
        await writeFile(p, data);
        return true;
      },
    });
    await policy.set(VIDEO, DRAFT);
    fail = true;
    await expect(policy.setDurable(VIDEO, { ...DRAFT, author: AUTHOR })).rejects.toThrow();
    expect(policy.record(VIDEO)?.author).toBeNull();
    expect(policy.isPrivate(VIDEO)).toBe(true);
  });

  it('a directory that would not sync is a warning, not a failed save', async () => {
    const d = await dir();
    const warned: string[] = [];
    const policy = new SeedPolicy(nodeFs, d, {
      durable: async (p, data) => {
        await writeFile(p, data);
        return false;
      },
      warn: (t) => warned.push(t),
    });
    await policy.setDurable(VIDEO, { ...DRAFT, author: AUTHOR });
    expect(warned).toHaveLength(1);
    expect(onDisk(d).videos[VIDEO]?.author).toBe(AUTHOR);
  });

  it('keeps a title, and treats an oversized one as a damaged record', async () => {
    const d = await dir();
    const first = new SeedPolicy(nodeFs, d);
    await first.set(VIDEO, { ...DRAFT, author: AUTHOR, title: 'A title' });
    const again = new SeedPolicy(nodeFs, d);
    await again.load();
    expect(again.record(VIDEO)?.title).toBe('A title');
    await writeFile(
      join(d, SEEDING_FILE),
      JSON.stringify({
        v: 1,
        watched: false,
        videos: { [VIDEO]: { ...DRAFT, title: 'x'.repeat(257) } },
      }),
    );
    const damaged = new SeedPolicy(nodeFs, d);
    await damaged.load();
    expect(damaged.record(VIDEO)).toBeUndefined();
  });
});
