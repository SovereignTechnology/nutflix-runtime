/**
 * The sandboxed preload (bundled to `main/preload.cjs`; `electron` is its one external, and a
 * sandboxed preload gets Electron's restricted `require` and nothing else). It exposes exactly two
 * things to the page, through `contextBridge`, under the two names the renderer's `entry.ts`
 * reads:
 *
 *   `nutflixWorkerPipe`  a framed `WorkerPipe` (`write`, `onData`, `onClose`, `close`): bytes
 *                        only. Which worker methods those bytes may call is main's decision
 *                        (`rpc-gate.ts`); the preload decides nothing and parses nothing.
 *   `nutflixOpenLink`    a function taking one string. Main checks it again before it opens it.
 *
 * Nothing of `ipcRenderer`, `process`, `require` or Node reaches the page. Three channels are
 * used (`shared/ids.ts`): one the page's bytes go out on, two main's go in on. A preload cannot be
 * called by a page that loaded something other than `app://nutflix`: main validates the sender.
 */
import { contextBridge, ipcRenderer } from 'electron';

import {
  MAX_LINK_CHARS,
  MAX_PIPE_CHUNK,
  OPEN_LINK,
  PIPE_CLOSE,
  PIPE_DATA,
  PIPE_WRITE,
} from '../shared/ids.ts';

const dataListeners = new Set<(bytes: Uint8Array) => void>();
const closeListeners = new Set<() => void>();
let closed = false;

function shut(): void {
  if (closed) return;
  closed = true;
  const ls = [...closeListeners];
  dataListeners.clear();
  closeListeners.clear();
  for (const cb of ls) {
    try {
      cb();
    } catch {
      // A page listener's failure is its own.
    }
  }
}

ipcRenderer.on(PIPE_DATA, (_event, bytes: unknown) => {
  if (closed || !(bytes instanceof Uint8Array)) return;
  for (const cb of [...dataListeners]) {
    try {
      // One fresh copy per listener: the page may keep or change what it is given.
      cb(new Uint8Array(bytes));
    } catch {
      // A page listener's failure is its own.
    }
  }
});
ipcRenderer.on(PIPE_CLOSE, shut);

contextBridge.exposeInMainWorld('nutflixWorkerPipe', {
  write(bytes: unknown): void {
    if (closed) throw new Error('the worker pipe is closed');
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_PIPE_CHUNK)
      throw new TypeError('write takes one frame as a Uint8Array');
    ipcRenderer.send(PIPE_WRITE, new Uint8Array(bytes));
  },
  onData(cb: unknown): () => void {
    if (typeof cb !== 'function') throw new TypeError('onData takes a function');
    const fn = cb as (bytes: Uint8Array) => void;
    if (!closed) dataListeners.add(fn);
    return () => {
      dataListeners.delete(fn);
    };
  },
  onClose(cb: unknown): () => void {
    if (typeof cb !== 'function') throw new TypeError('onClose takes a function');
    const fn = cb as () => void;
    if (closed) queueMicrotask(fn);
    else closeListeners.add(fn);
    return () => {
      closeListeners.delete(fn);
    };
  },
  close(): void {
    shut();
  },
});

contextBridge.exposeInMainWorld('nutflixOpenLink', (url: unknown): void => {
  if (typeof url === 'string' && url.length <= MAX_LINK_CHARS) ipcRenderer.send(OPEN_LINK, url);
});
