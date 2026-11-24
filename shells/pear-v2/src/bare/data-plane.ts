/**
 * What this shell gives the worker: the data plane, by name, and never a spread. A worker runtime
 * may also carry `system`, which is what builds the worker's user signer (a key file on disk) and
 * Studio. Shape (b) holds no signing key (ADR 0001 amendment, item 1), so that field is left out
 * here and the worker itself answers every signer and Studio method `unsupported-input`. This is
 * the second barrier, behind `PageGate`'s allow-list, and it holds even if a method gets past it.
 */
import type { WorkerRuntime } from '@nutflix-runtime/worker/runtime';

export function dataPlaneOnly(r: WorkerRuntime): WorkerRuntime {
  return { fs: r.fs, rmTree: r.rmTree, createHttpServer: r.createHttpServer };
}
