/**
 * The page's script, bundled to `app.js` by `scripts/build.ts`. The shell that serves this page
 * puts the worker's pipe on `globalThis.nutflixWorkerPipe` before it runs (a preload bridge, or a
 * test's init script), and optionally `globalThis.nutflixOpenLink(url)`, which receives an
 * `https:` link a viewer clicked. The renderer checks the pipe's shape and starts. Without a pipe
 * it says so, as text. The build writes the pinned WASM's sha256 into this bundle.
 */
import { startRenderer } from './main.js';
import { createPlayerLoader } from './player/load.js';
import { asWorkerPipe } from './worker/pipe.js';

/** The sha256 of `nfx/wasm.js`'s bytes, written in by `scripts/build.ts`. */
declare const __NFX_WASM_SHA256__: string;

const root = document.getElementById('root');
if (root !== null) {
  const bridge = globalThis as Record<string, unknown>;
  const pipe = asWorkerPipe(bridge['nutflixWorkerPipe']);
  const open = bridge['nutflixOpenLink'];
  if (pipe === null) {
    root.textContent = 'Nutflix could not start: no worker is connected to this window.';
  } else {
    try {
      const client = startRenderer({
        container: root,
        pipe,
        openLink: typeof open === 'function' ? (open as (url: string) => void) : undefined,
        loadPlayer: createPlayerLoader({
          baseUrl: document.baseURI,
          wasmSha256: __NFX_WASM_SHA256__,
        }),
      });
      // The page's own round trip to the worker, through the pipe the shell gave it. A shell's
      // launch check reads this: the worker answering the SHELL says nothing about this path.
      void client.workerReady().then(
        () => {
          root.dataset['workerLink'] = 'up';
        },
        () => {
          root.dataset['workerLink'] = 'down';
        },
      );
    } catch (e) {
      root.textContent = `Nutflix could not start: ${e instanceof Error ? e.message : 'unknown error'}`;
    }
  }
}
