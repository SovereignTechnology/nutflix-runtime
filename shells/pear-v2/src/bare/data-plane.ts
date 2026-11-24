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

/**
 * Why the worker's `seeding.status` is not what a watch-only shell needs (off, listening nowhere,
 * holding no video), for the person at the terminal; `null` when it is. `workerDir` is the worker's
 * storage, named in the answer when stored videos are the reason: they are what they can remove.
 */
export function watchOnlyRefusal(status: unknown, workerDir: string): string | null {
  if (typeof status !== 'object' || status === null) return 'the worker gave no seeding status';
  const s = status as Record<string, unknown>;
  if (s['watched'] !== false) return 'the worker did not turn "seed what you watch" off';
  if (!Array.isArray(s['listening']) || s['listening'].length > 0)
    return 'the worker is listening for peers';
  if (!Array.isArray(s['videos'])) return 'the worker gave no list of stored videos';
  const n = s['videos'].length;
  if (n > 0)
    return (
      `this app's storage holds ${String(n)} stored video${n === 1 ? '' : 's'}, and this build is ` +
      'watch only: it starts only with none stored, so that nothing here can ever be served. To ' +
      `start it, delete the folder ${workerDir}/nfx, which holds only the stored videos: your ` +
      'settings stay'
    );
  return null;
}

/** The worker's `seeding.status` as a watch-only shell needs it: off, and listening nowhere. */
export function watchOnly(status: unknown): boolean {
  return watchOnlyRefusal(status, '') === null;
}
