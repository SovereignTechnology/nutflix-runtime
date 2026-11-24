/**
 * CI's check of this shell's pins on a real Bare, with no Pear and no network: the worker loads
 * from the staged `node_modules`, answers through `PageGate`, and the gate refuses `init` from the
 * page. Only `stage.ts --with-smoke` (test builds) writes it into the staged app.
 *
 *   bare out/app/smoke.js <empty storage directory>
 */
import '../../../../packages/worker/src/bare-globals.js';

import { FrameDecoder, encodeFrame } from '@nutflix-runtime/worker';
import { WorkerHost } from '@nutflix-runtime/worker/host';
import { WorkerRpc } from '@nutflix-runtime/worker/rpc';

import { bareRuntime } from '../../../../packages/worker/src/adapters/bare.js';
import { openCorestoreKeyring } from '../../../../packages/worker/src/keys.js';
import { dataPlaneOnly } from './data-plane.ts';
import { PageGate } from './page-gate.ts';

interface Answer {
  readonly op?: string;
  readonly id?: number;
  readonly ok?: boolean;
  readonly r?: { readonly dht?: string; readonly playSessions?: number };
  readonly e?: { readonly code?: string };
}

async function main(): Promise<void> {
  const storage = Bare.argv[2];
  if (storage === undefined) throw new Error('usage: smoke <storage directory>');
  const answers = new Map<number, Answer>();
  const decoder = new FrameDecoder((m) => {
    const a = m as Answer;
    if (a.op === 'res' && a.id !== undefined) answers.set(a.id, a);
  });
  const gate: PageGate = new PageGate({
    toWorker: (f) => {
      rpc.push(f);
    },
    toPage: (f) => {
      decoder.push(f);
    },
    closePage: () => {
      throw new Error('the gate closed the page');
    },
  });
  const rpc: WorkerRpc = new WorkerRpc({
    write: (b) => {
      gate.fromWorker(b);
    },
    handler: { handle: (m, a) => host.handle(m, a) },
    onFatal: () => {
      throw new Error('the worker stream is corrupt');
    },
  });
  const host: WorkerHost = new WorkerHost({
    runtime: dataPlaneOnly(bareRuntime()),
    emit: (ev) => {
      rpc.emit(ev);
    },
    openKeyring: openCorestoreKeyring,
  });
  // A loopback bootstrap nothing listens on: the node stays idle and could not leave this host.
  await gate.request('init', { v: 1, storage, bootstrap: [{ host: '127.0.0.1', port: 9 }] });

  gate.fromPage(encodeFrame({ op: 'req', id: 11, m: 'status', a: {} }));
  gate.fromPage(encodeFrame({ op: 'req', id: 12, m: 'init', a: { v: 1, storage: '/tmp/x' } }));
  gate.fromPage(encodeFrame({ op: 'req', id: 13, m: 'nfx.seed.list', a: {} }));
  const end = Date.now() + 10_000;
  while (answers.size < 3 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));

  const status = answers.get(11);
  const refused = [answers.get(12), answers.get(13)];
  if (status?.ok !== true || status.r?.dht !== 'idle' || status.r.playSessions !== 0)
    throw new Error('the worker did not answer status through the gate');
  if (refused.some((a) => a?.ok !== false || a.e?.code !== 'invalid-argument'))
    throw new Error('the gate did not refuse a method the page may not call');

  const server = await bareRuntime().createHttpServer((_req, res) => {
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await host.close();
  console.error(`NUTFLIX_V2_SMOKE ok bare ${Bare.version}`);
  Bare.exit(0);
}

main().catch((err: unknown) => {
  console.error(`NUTFLIX_V2_SMOKE failed: ${err instanceof Error ? err.message : 'unknown'}`);
  Bare.exit(1);
});
