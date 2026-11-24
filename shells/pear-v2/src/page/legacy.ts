/**
 * The classic script that runs before the renderer's module (`legacy.js`, with an SRI hash, after
 * the CSP `<meta>`). It gives the renderer the two things a shell provides (`nutflixWorkerPipe`,
 * `nutflixOpenLink`), turns WebRTC off unless the viewer chose it, and keeps the legacy label and
 * the WebRTC warning on screen.
 *
 * None of this is a sandbox. This page has Node integration, and code that gets to run here can
 * do anything the user can. Keeping code from getting to run here is the job of the CSP and of
 * rendering every remote field as text.
 */
import {
  installLabel,
  installWebRtcWarning,
  isVersionedLink,
  type WindowControls,
} from './notices.ts';
import { removeWebRtc, webrtcOffUnlessChosen } from './first-run.ts';
import { linkOpener } from './open-link.ts';
import { workerPipeOver, type PageStream } from './pipe.ts';

interface PagePear {
  readonly constructor: { readonly IPC: symbol; readonly UI: symbol };
  readonly config?: { readonly link?: unknown };
}

const g = globalThis as unknown as Record<string, unknown>;
const pear = g['Pear'] as (PagePear & Record<symbol, unknown>) | undefined;

if (pear !== undefined) {
  const ipc = pear[pear.constructor.IPC] as { pipe(): PageStream };
  if (webrtcOffUnlessChosen(() => globalThis.localStorage) === 'no-storage')
    removeWebRtc(globalThis);
  g['nutflixWorkerPipe'] = workerPipeOver(ipc.pipe());
  // The one call to `window.open` in this shell: `linkOpener` has checked the URL.
  g['nutflixOpenLink'] = linkOpener((url) => {
    // eslint-disable-next-line no-restricted-syntax -- the checked exit for an https: link
    globalThis.open(url, '_blank', 'noopener');
  });

  // A file or link dropped on the window would navigate it.
  for (const type of ['dragover', 'drop'] as const)
    document.addEventListener(
      type,
      (e) => {
        e.preventDefault();
      },
      true,
    );

  const ui = pear[pear.constructor.UI] as { app?: WindowControls } | undefined;
  const whenReady = (): void => {
    installLabel(document, ui?.app ?? null, isVersionedLink(pear.config?.link));
    const root = document.getElementById('root');
    if (root !== null) installWebRtcWarning(root);
  };
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', whenReady, { once: true });
  else whenReady();
}
