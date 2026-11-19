/**
 * The built entry (`dist/main.js`, what a shell runs) under the REAL Bare runtime: bare-sidecar's
 * prebuilt `bare`, which hands the worker `Bare.IPC` on fd 3 as pear-runtime's `run()` does
 * (nutflix-pear runs its own worker the same way, `worker/__tests__/helpers/bare.ts`). It proves
 * what the Node suites cannot: the `bare` export conditions resolve, bare-fs, bare-path and the
 * lazily loaded bare-http1 work, Corestore and HyperDHT load, and the worker exits cleanly when
 * the host goes. It fails, never skips: `npm run build` comes first (CI's `test` job, kata-run).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nfx } from '@sovit/core';
import { hyperdhtEndpoint, listenNfx } from '@sovit/seeder';
import Sidecar from 'bare-sidecar';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkerClient } from '../client.js';
import type { WorkerEvent } from '../protocol.js';
import { httpGet, tempDir, until } from './helpers/harness.js';
import { NFX_NS, memorySource, testNfxVideo } from './helpers/nfx-video.js';

vi.setConfig({ testTimeout: 120_000 });

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'main.js');
const SEEDER_NOSTR = 'cd'.repeat(32);
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('dist/main.js under the real Bare', () => {
  let testnet: Testnet;
  const cleanups: (() => Promise<void>)[] = [];
  beforeEach(async () => {
    testnet = await createTestnet(3);
  });
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    await testnet.destroy();
  });

  it('inits, plays and seeds over NFX-12, serves both loopback endpoints, exits 0', async () => {
    expect(existsSync(MAIN), `${MAIN} (run npm run build first)`).toBe(true);
    const v = testNfxVideo();
    const dht = new DHT({ bootstrap: testnet.bootstrap });
    cleanups.push(() => dht.destroy());
    await dht.fullyBootstrapped();
    const keyPair = DHT.keyPair();
    const listener = await listenNfx(dht, { keyPair, source: memorySource(v.files, v.video) });
    cleanups.push(() => listener.close());
    const peer = hyperdhtEndpoint(keyPair, SEEDER_NOSTR, NFX_NS);

    const d = await tempDir('nf-bare-');
    cleanups.push(() => d.rm());
    const sidecar = new Sidecar(MAIN);
    const stderr: string[] = [];
    sidecar.stderr?.on('data', (c: unknown) => {
      if (c instanceof Uint8Array) stderr.push(Buffer.from(c).toString('utf8'));
    });
    sidecar.stdout?.resume();
    sidecar.on('error', () => undefined);
    const exited = new Promise<number | null>((resolve) => {
      sidecar.once('exit', (code: number | null) => {
        resolve(code);
      });
    });
    cleanups.push(async () => {
      sidecar.destroy();
      await exited;
    });
    const events: WorkerEvent[] = [];
    const client = new WorkerClient({
      write: (b) => {
        sidecar.write(b);
      },
      onEvent: (ev) => events.push(ev),
      timeoutMs: 60_000,
    });
    sidecar.on('data', (c: unknown) => {
      if (c instanceof Uint8Array) client.push(c);
    });
    const why = (): string => `; bare stderr: ${stderr.join('').slice(0, 2000)}`;

    expect(
      await client.request('init', { v: 1, storage: d.dir, bootstrap: testnet.bootstrap }),
      why(),
    ).toEqual({ v: 1 });
    await until(() => events.some((e) => e.e === 'ready'), `the ready event${why()}`);

    const opened = await client.request('nfx.play.open', {
      sid: 'ab'.repeat(16),
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [peer],
    });
    const whole = await httpGet(opened.progressiveUrl!);
    expect(whole.status).toBe(200);
    expect(whole.body.equals(Buffer.from(v.expected))).toBe(true);
    const ranged = await httpGet(opened.progressiveUrl!, { range: 'bytes=10-99' });
    expect(ranged.status).toBe(206);
    expect(ranged.body.equals(Buffer.from(v.expected.subarray(10, 100)))).toBe(true);
    const list = await httpGet(`${opened.originUrl!}/${v.root}`);
    expect(list.status).toBe(200);
    expect(sha256(list.body)).toBe(v.root);
    const seg = v.segmentShas[1]!;
    const segment = await httpGet(`${opened.originUrl!}/${v.root}/${seg}.m4s`);
    expect(sha256(segment.body)).toBe(seg);
    await client.request('nfx.play.close', { sid: 'ab'.repeat(16) });

    const stored = await client.request('nfx.seed.start', {
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [peer],
    });
    expect(stored.files).toBe(v.files.size);
    const { hyperdht } = await client.request('nfx.endpoint', {
      seeder: SEEDER_NOSTR,
      namespace: NFX_NS,
    });
    expect(hyperdht).not.toBeNull();
    expect(nfx.verifyHyperdhtBind(hyperdht!.peer, hyperdht!.bind, SEEDER_NOSTR, NFX_NS)).toBe(true);

    // The host goes (EOF on fd 3): the worker closes everything and exits 0.
    (sidecar as unknown as { readonly _ipc: { end(): void } })._ipc.end();
    expect(await exited, why()).toBe(0);
  });
});
