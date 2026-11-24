/**
 * The playback proof's world, end to end in this process, on a hyperdht testnet on 127.0.0.1: what
 * its relay carries reads as the app's renderer reads it (`hyperdhtEndpoints`, the liar first), and
 * the REAL worker (`WorkerHost`, its own fetcher and origin) fed those seeders fetches every file
 * from the honest one after refusing the liar's, as `seederProblems` must then find. It runs in the
 * `test` and `platform` jobs, so the world is known to work on every target before `install` uses it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type { NfxAddress, NostrEvent, NostrPubkey } from '@sovit/core';
import type { NfxHyperdhtEndpointWire } from '@nutflix-runtime/worker';
import { nodeFs } from '@sovit/seeder';
import { WorkerHost } from '@nutflix-runtime/worker/host';
import type { HttpServerLike, WorkerRuntime } from '@nutflix-runtime/worker/runtime';

import { hyperdhtEndpoints } from '../../../../../packages/renderer/src/adapter/endpoints.ts';
import {
  PLAY_NS,
  loadClip,
  seederProblems,
  startPlaybackWorld,
  type Clip,
  type PlaybackWorld,
} from '../playback.ts';
import { writeTestClip } from './clip-fixture.ts';

const runtime: WorkerRuntime = {
  fs: nodeFs,
  rmTree: (p) => rm(p, { recursive: true, force: true }),
  createHttpServer: (onRequest): Promise<HttpServerLike> =>
    Promise.resolve(
      http.createServer((req, res) => {
        onRequest(req, res);
      }),
    ),
};

function get(url: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) });
        });
      })
      .on('error', reject);
  });
}

/** What the relay sends a subscription for `kinds` in `ms`. */
function read(url: string, kinds: number[], ms: number): Promise<NostrEvent[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const got: NostrEvent[] = [];
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', 's', { kinds }]));
    });
    ws.on('message', (d: Buffer) => {
      const m = JSON.parse(d.toString('utf8')) as unknown[];
      if (m[0] === 'EVENT') got.push(m[2] as NostrEvent);
    });
    setTimeout(() => {
      ws.close();
      resolve(got);
    }, ms);
  });
}

describe('the playback world, with the real worker', () => {
  let testnet: Testnet | undefined;
  let world: PlaybackWorld | undefined;
  let peers = { honest: '', liar: '' };
  let clip: Clip;
  const dirs: string[] = [];

  /** The relay's manifest and beacons, read as the app's renderer reads them. */
  const fromRelay = async (
    w: PlaybackWorld,
  ): Promise<{ author: string; peers: readonly NfxHyperdhtEndpointWire[]; reachable: number }> => {
    const manifests = await read(w.relay.url, [38504], 300);
    expect(manifests).toHaveLength(1);
    const author = manifests[0]?.pubkey ?? '';
    const found = hyperdhtEndpoints(
      { id: w.play.video as NfxAddress, author: author as NostrPubkey, namespace: PLAY_NS },
      await read(w.relay.url, [20464], 300),
      Math.floor(Date.now() / 1000),
    );
    return { author, peers: found.peers, reachable: found.reachable };
  };

  beforeAll(async () => {
    testnet = await createTestnet(3, { host: '127.0.0.1' });
    const dir = writeTestClip();
    dirs.push(dir);
    clip = loadClip(dir);
    const bootstrap = testnet.bootstrap.map((b) => `${b.host}:${String(b.port)}`).join(',');
    world = await startPlaybackWorld(bootstrap, clip);
    // The relay carries no beacon until the seeders are up.
    expect(await read(world.relay.url, [20464], 300)).toEqual([]);
    peers = await world.startSeeders();
  }, 60_000);

  afterAll(async () => {
    await world?.close();
    await testnet?.destroy();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('carries a manifest and two beacons the renderer reads, the liar first', async () => {
    const w = world;
    if (w === undefined) throw new Error('no world');
    expect(w.play.relays).toEqual([w.relay.url]);
    const found = await fromRelay(w);
    expect(`38504:${found.author}:${clip.video}`).toBe(w.play.video);
    expect(found.reachable).toBe(2);
    expect(found.peers.map((p) => p.peer)).toEqual([peers.liar, peers.honest]);
  });

  it('the worker refuses every file the liar serves wrong and fetches it from the honest seeder', async () => {
    const w = world;
    if (w === undefined || testnet === undefined) throw new Error('no world');
    const storage = mkdtempSync(join(tmpdir(), 'playback-world-'));
    dirs.push(storage);
    const host = new WorkerHost({
      runtime,
      emit: () => undefined,
      bootstrapWaitMs: 5000,
      dialTimeoutMs: 10_000,
    });
    try {
      await host.handle('init', { v: 1, storage, bootstrap: [...testnet.bootstrap] });
      // As the renderer hands them over: the liar first.
      const peers = [...(await fromRelay(w)).peers];
      const opened = await host.handle('nfx.play.open', {
        sid: 'ab'.repeat(16),
        video: clip.video,
        root: clip.root,
        segs: clip.segs,
        peers,
        progressive: false,
      });
      expect(opened.originUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
      const media = [...clip.roles].filter(([, r]) => r === 'init' || r === 'segment');
      for (const [sha] of media) {
        const r = await get(`${opened.originUrl ?? ''}/${sha}`);
        expect(r.status).toBe(200);
        expect(Buffer.compare(r.body, Buffer.from(clip.files.get(sha) ?? []))).toBe(0);
      }
      expect(seederProblems(w.honest, w.liar, clip.roles)).toEqual([]);
      expect(w.liar.served.filter((s) => s.bad).length).toBeGreaterThan(0);
      expect(w.liar.dialers.size).toBeGreaterThan(0);
    } finally {
      await host.close();
    }
  }, 60_000);
});
