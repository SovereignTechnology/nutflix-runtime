/**
 * The Bare worker entry, after nutflix-pear's `app-desktop/src/worker/entry.ts` (the submodule's
 * pinned commit). A shell starts it with `pear-runtime`'s `run()` (Pear v3) or `bare-sidecar`;
 * both hand it `Bare.IPC`, the host duplex.
 *
 * The FIRST import installs `bare-encoding`'s `TextEncoder`/`TextDecoder` as globals (Bare has
 * neither; `@sovit/core` builds a `TextDecoder` at module load). ES modules evaluate in import
 * order, so everything below sees them. A bundle must keep that two-step boot (nutflix-pear's
 * `worker/__tests__/helpers/bare.ts` says why).
 *
 * Wiring: `Bare.IPC` (unframed chunks) ⇄ `WorkerRpc` (framing + guards) ⇄ `WorkerHost` with the
 * Bare runtime and a Corestore keyring. Lifecycle:
 *   - a corrupt frame is terminal: exit 3 (no resync);
 *   - the pipe ending or closing = the host is gone: graceful close, then exit 0 (a `close`
 *     listener disables the launcher's auto-exit, so the worker exits itself);
 *   - an uncaught exception is logged (redacted) and exits 1; an unhandled rejection is logged
 *     and survives (Bare would otherwise abort the process on either).
 */
import './bare-globals.js';

import { bareRuntime } from './adapters/bare.js';
import { toWireError } from './errors.js';
import { WorkerHost } from './host.js';
import { openCorestoreKeyring } from './keys.js';
import { createWorkerLogger, toLogEvent } from './log.js';
import { WorkerRpc } from './rpc.js';

const EXIT_CORRUPT = 3;
const EXIT_NO_IPC = 10;
const SHUTDOWN_GRACE_MS = 10_000;

const ipc = Bare.IPC;
if (ipc === null) {
  Bare.exit(EXIT_NO_IPC);
} else {
  let shuttingDown = false;
  const rpc: WorkerRpc = new WorkerRpc({
    write: (b) => {
      ipc.write(b);
    },
    handler: {
      handle: (m, a) => host.handle(m, a),
    },
    onFatal: () => {
      Bare.exit(EXIT_CORRUPT);
    },
    // A failure that crosses as `internal`: its method, code, syscall and class, as a `log` event.
    log: createWorkerLogger({
      emit: (ev) => {
        rpc.emit(ev);
      },
    }),
  });
  const host: WorkerHost = new WorkerHost({
    runtime: bareRuntime(),
    emit: (ev) => {
      rpc.emit(ev);
    },
    openKeyring: openCorestoreKeyring,
  });

  const report = (what: string, err: unknown): void => {
    rpc.emit(
      toLogEvent(JSON.stringify({ msg: what, error: toWireError(err).message }), {
        level: 'error',
      }),
    );
  };

  const shutdown = (code: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const force = setTimeout(() => {
      Bare.exit(code);
    }, SHUTDOWN_GRACE_MS);
    void host
      .close()
      .catch((err: unknown) => {
        report('worker close failed', err);
      })
      .finally(() => {
        clearTimeout(force);
        Bare.exit(code);
      });
  };

  Bare.on('uncaughtException', (err) => {
    report('uncaught exception', err);
    Bare.exit(1);
  });
  Bare.on('unhandledRejection', (reason) => {
    report('unhandled rejection', reason);
  });

  ipc.on('data', (chunk) => {
    rpc.push(chunk);
  });
  // The host ending its side (EOF) or the pipe closing both mean the host is gone.
  const hostGone = (): void => {
    rpc.end();
    shutdown(0);
  };
  ipc.on('end', hostGone);
  ipc.on('close', hostGone);
  ipc.on('error', () => {
    shutdown(0);
  });
}
