/**
 * The renderer's `WorkerPipe` over the runtime's page-to-Bare stream
 * (`Pear[Pear.constructor.IPC].pipe()`: Electron main relays it to fd 3 of the Bare process).
 *
 * `close()` only stops this page listening. It never destroys the stream: Electron main holds one
 * shared pipe for the app, so destroying a page's end of it would end the whole app.
 */
import type { WorkerPipe } from '../../../../packages/renderer/src/worker/pipe.js';

/** The part of the runtime's stream this uses. */
export interface PageStream {
  write(chunk: Uint8Array): unknown;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'close' | 'end', listener: () => void): unknown;
  on(event: 'error', listener: (err: unknown) => void): unknown;
}

export function workerPipeOver(stream: PageStream): WorkerPipe {
  const dataListeners = new Set<(bytes: Uint8Array) => void>();
  const closeListeners = new Set<() => void>();
  let closed = false;

  const shut = (): void => {
    if (closed) return;
    closed = true;
    const ls = [...closeListeners];
    dataListeners.clear();
    closeListeners.clear();
    for (const cb of ls) {
      try {
        cb();
      } catch {
        // A listener's failure is its own.
      }
    }
  };

  stream.on('data', (chunk) => {
    if (closed) return;
    for (const cb of [...dataListeners]) {
      try {
        // One fresh, plain copy per listener: the page may keep or change what it is given.
        cb(Uint8Array.from(chunk));
      } catch {
        // A listener's failure is its own.
      }
    }
  });
  stream.on('end', shut);
  stream.on('close', shut);
  stream.on('error', shut);

  return {
    write(bytes) {
      if (closed) throw new Error('the worker pipe is closed');
      stream.write(bytes);
    },
    onData(cb) {
      if (!closed) dataListeners.add(cb);
      return () => {
        dataListeners.delete(cb);
      };
    },
    onClose(cb) {
      if (closed) queueMicrotask(cb);
      else closeListeners.add(cb);
      return () => {
        closeListeners.delete(cb);
      };
    },
    close: shut,
  };
}
