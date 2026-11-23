/**
 * The Bare worker, started the Pear v3 way: `pear-runtime`'s `run(entry, args)`, which spawns
 * `bare-sidecar`'s prebuilt `bare` on the entry and hands the worker `Bare.IPC` as the sidecar's
 * duplex. Only `run` is used: no `PearRuntime` is constructed here and nothing here can call
 * `applyUpdate()`. The updater is a process of its own (`src/update/update-worker.ts`).
 *
 * The sidecar's bytes go to the gate; its stderr is printed (bounded) so that a worker that dies
 * at load says why; its exit ends the gate. `run` is a parameter: main loads pear-runtime, the
 * tests pass a fake.
 */
import type { SidecarLike } from 'pear-runtime';

import type { Fields } from './log.ts';

export interface WorkerGateSide {
  fromWorker(bytes: Uint8Array): void;
  workerGone(): void;
}

export interface StartWorkerDeps {
  readonly entry: string;
  run(entry: string, args: readonly string[]): SidecarLike;
  readonly gate: WorkerGateSide;
  log(name: string, fields?: Fields): void;
  /** Where worker stderr goes (default: main's stderr). */
  readonly stderr?: (text: string) => void;
}

export interface WorkerHandle {
  /** Bytes to the worker (`Bare.IPC`). Throws when the worker is gone. */
  write(bytes: Uint8Array): void;
  /** Ends the worker. Idempotent. */
  stop(): void;
}

/** At most this much worker stderr is printed in all; a loop cannot flood a log. */
export const STDERR_BUDGET_BYTES = 64 * 1024;

export function startWorker(d: StartWorkerDeps): WorkerHandle {
  const sidecar = d.run(d.entry, []);
  const printStderr =
    d.stderr ??
    ((t: string): void => {
      process.stderr.write(t);
    });
  let budget = STDERR_BUDGET_BYTES;
  let gone = false;
  const end = (name: string, fields?: Fields): void => {
    if (gone) return;
    gone = true;
    d.log(name, fields);
    d.gate.workerGone();
  };
  sidecar.on('data', (chunk) => {
    d.gate.fromWorker(chunk);
  });
  sidecar.on('exit', (code) => {
    end('worker-exit', { code: code ?? -1 });
  });
  sidecar.on('error', () => {
    end('worker-error');
  });
  sidecar.on('close', () => {
    end('worker-closed');
  });
  // The worker's stdout carries nothing the shell reads; drained so that the pipe never fills.
  sidecar.stdout?.on('data', () => undefined);
  sidecar.stderr?.on('data', (chunk) => {
    if (budget <= 0) return;
    const text = Buffer.from(chunk.subarray(0, budget)).toString('utf8');
    budget -= chunk.length;
    printStderr(`[worker] ${text}${text.endsWith('\n') ? '' : '\n'}`);
  });
  return {
    write: (bytes) => {
      if (gone) throw new Error('the worker is not running');
      sidecar.write(bytes);
    },
    stop: () => {
      if (gone) return;
      gone = true;
      try {
        sidecar.destroy();
      } catch {
        // Already gone.
      }
    },
  };
}
