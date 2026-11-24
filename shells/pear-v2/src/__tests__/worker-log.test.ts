/**
 * Shape (b) notes a request that failed with no wire code on the Bare process's stderr, as shape
 * (a) does in a `log` event: page ⇄ `PageGate` ⇄ the worker's own `WorkerRpc`, wired as `main.ts`
 * wires them, with `stderrWorkerLog` as the RPC's log. The page hears the answer and nothing else.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FrameDecoder, WorkerError, encodeFrame } from '@nutflix-runtime/worker';
import { WorkerRpc } from '@nutflix-runtime/worker/rpc';
import { describe, expect, it } from 'vitest';

import { PAGE_EVENTS, PAGE_METHODS, PageGate } from '../bare/page-gate.ts';
import { WORKER_LOG_PREFIX, stderrWorkerLog } from '../bare/worker-log.ts';

type Msg = Record<string, unknown>;

const here = dirname(fileURLToPath(import.meta.url));
const PRIVATE = '/home/someone/Videos/a private title';

/** The page, the gate and the worker's RPC with a handler of the test's own; what reached stderr. */
function rig(handle: () => Promise<unknown>): {
  gate: PageGate;
  rpc: WorkerRpc;
  toPage: Msg[];
  stderr: string[];
} {
  const toPage: Msg[] = [];
  const stderr: string[] = [];
  const pageDecoder = new FrameDecoder((m) => toPage.push(m as Msg));
  const gate: PageGate = new PageGate({
    toWorker: (f) => {
      rpc.push(f);
    },
    toPage: (f) => {
      pageDecoder.push(f);
    },
    closePage: () => undefined,
  });
  const rpc: WorkerRpc = new WorkerRpc({
    write: (b) => {
      gate.fromWorker(b);
    },
    handler: { handle: handle as never },
    onFatal: () => undefined,
    log: stderrWorkerLog((line) => stderr.push(line)),
  });
  return { gate, rpc, toPage, stderr };
}

const settle = (): Promise<void> =>
  new Promise((res) => {
    setImmediate(res);
  });

describe('a request that fails with no code, in shape (b)', () => {
  it('is one stderr line: its method, code, syscall and class, never its message or a path', async () => {
    const err = Object.assign(
      new Error(`EPERM: operation not permitted, rename '${PRIVATE}.tmp'`),
      {
        errno: -4048,
        code: 'EPERM',
        syscall: 'rename',
        path: `${PRIVATE}.tmp`,
        dest: PRIVATE,
      },
    );
    const r = rig(() => Promise.reject(err));
    r.gate.fromPage(encodeFrame({ op: 'req', id: 7, m: 'status', a: {} }));
    await settle();
    // The page hears that it failed, as `internal`, and nothing else: no log event crosses.
    expect(r.toPage).toEqual([
      { op: 'res', id: 7, ok: false, e: { code: 'internal', message: 'internal: internal error' } },
    ]);
    expect(r.stderr).toHaveLength(1);
    const line = r.stderr[0] ?? '';
    const head = `${WORKER_LOG_PREFIX} error: `;
    expect(line.startsWith(head)).toBe(true);
    const record = JSON.parse(line.slice(head.length)) as Msg;
    expect(record).toMatchObject({ level: 'error', msg: 'rpc: a request failed with no code' });
    expect(record['fields']).toEqual({
      component: 'worker',
      method: 'status',
      code: 'EPERM',
      syscall: 'rename',
      name: 'Error',
    });
    for (const leak of ['someone', 'Videos', 'private title', 'not permitted', '4048'])
      expect(line).not.toContain(leak);
  });

  it('a failure with a code of its own writes nothing: the page reads its message', async () => {
    const r = rig(() => Promise.reject(new WorkerError('not-ready', 'not yet')));
    r.gate.fromPage(encodeFrame({ op: 'req', id: 1, m: 'status', a: {} }));
    await settle();
    expect(r.toPage).toMatchObject([{ op: 'res', id: 1, ok: false, e: { code: 'not-ready' } }]);
    expect(r.stderr).toEqual([]);
  });

  it('the gate is unchanged: three methods, the status event alone, no log event to the page', async () => {
    expect([...PAGE_METHODS].sort()).toEqual(['nfx.play.close', 'nfx.play.open', 'status']);
    expect([...PAGE_EVENTS]).toEqual(['status']);
    const r = rig(() => Promise.resolve(null));
    r.rpc.emit({ op: 'ev', e: 'log', level: 'error', msg: 'x' });
    await settle();
    expect(r.toPage).toEqual([]);
    expect(r.stderr).toEqual([]);
  });

  it('main.ts hands it to the worker’s RPC, writing with console.error', () => {
    const src = readFileSync(join(here, '..', 'bare', 'main.ts'), 'utf8');
    expect(src).toMatch(
      /new WorkerRpc\(\{[\s\S]*?log: stderrWorkerLog\(\(line\) => \{\s*console\.error\(line\);\s*\}\),[\s\S]*?\}\);/,
    );
  });
});
