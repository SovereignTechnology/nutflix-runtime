/**
 * What this shell gives the worker: the data plane, by name, and never a spread. A worker runtime
 * may also carry `system`, which is what builds the worker's user signer and Studio. Shape (b) v1
 * is watch only (ADR 0001 amendment, item 1): no signing, publishing or seeding. So that field is
 * left out, and the worker itself answers every signer and Studio method `unsupported-input`. This
 * is the second barrier, behind `PageGate`'s allow-list, and it holds even if a method gets past
 * it. The runtime comes from the worker's `adapters/bare-data.ts`, which loads none of the modules
 * `system` needs, and `scripts/stage.ts` refuses a staged worker that imports one.
 */
import type { WorkerRuntime } from '@nutflix-runtime/worker/runtime';

export function dataPlaneOnly(r: WorkerRuntime): WorkerRuntime {
  return { fs: r.fs, rmTree: r.rmTree, createHttpServer: r.createHttpServer };
}

/** The worker's `seeding.status` as a watch-only shell needs it: off, and listening nowhere. */
export function watchOnly(status: unknown): boolean {
  if (typeof status !== 'object' || status === null) return false;
  const s = status as Record<string, unknown>;
  return (
    s['watched'] === false &&
    Array.isArray(s['listening']) &&
    s['listening'].length === 0 &&
    Array.isArray(s['videos']) &&
    s['videos'].length === 0
  );
}
