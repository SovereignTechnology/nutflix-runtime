/**
 * Where the worker's `WorkerRpc` notes a request that failed with no wire code (it crosses as
 * `internal`; PR #26): this Bare process's stderr, the one place this shell writes about itself
 * (`nutflix: refusing to start …`). Not the page: `PageGate` passes the page the `status` event and
 * nothing else, and its allow-list stays exactly `status`, `nfx.play.open` and `nfx.play.close`. The
 * worker's own `log` events stop at that gate as before; this is the RPC's note alone.
 *
 * The line is the worker's own logger's, as shape (a) sends it as a `log` event: the method, and
 * the error's code, syscall and class (`uncodedCause`), never its message, a path or the request's
 * arguments, then re-redacted and clamped (`createWorkerLogger`, `toLogEvent`).
 */
import type { Logger } from '@sovit/seeder';

import { createWorkerLogger } from '../../../../packages/worker/src/log.js';

/** What every line starts with, so it reads as this app's among the runtime's own. */
export const WORKER_LOG_PREFIX = 'nutflix: worker';

/** `WorkerRpcOptions.log` for shape (b): one line per note, through `write` (`console.error`). */
export function stderrWorkerLog(write: (line: string) => void): Pick<Logger, 'error'> {
  return createWorkerLogger({
    emit: (ev) => {
      write(`${WORKER_LOG_PREFIX} ${ev.level}: ${ev.msg}`);
    },
  });
}
