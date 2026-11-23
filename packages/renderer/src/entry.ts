/**
 * The page's script, bundled to `app.js` by `scripts/build.ts`. The shell that serves this page
 * puts the worker's pipe on `globalThis.nutflixWorkerPipe` before it runs (a preload bridge, or a
 * test's init script), and optionally `globalThis.nutflixOpenLink(url)`, which receives an
 * `https:` link a viewer clicked. The renderer checks the pipe's shape and starts. Without a pipe
 * it says so, as text.
 */
import { startRenderer } from './main.js';
import { installUpdateBanner } from './update-banner.js';
import { asWorkerPipe } from './worker/pipe.js';

const root = document.getElementById('root');
if (root !== null) {
  const bridge = globalThis as Record<string, unknown>;
  const pipe = asWorkerPipe(bridge['nutflixWorkerPipe']);
  const open = bridge['nutflixOpenLink'];
  if (pipe === null) {
    root.textContent = 'Nutflix could not start: no worker is connected to this window.';
  } else {
    try {
      installUpdateBanner(document, pipe);
      const client = startRenderer({
        container: root,
        pipe,
        openLink: typeof open === 'function' ? (open as (url: string) => void) : undefined,
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
