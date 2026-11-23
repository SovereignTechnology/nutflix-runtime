/**
 * Settings says why WebRTC is off (ADR 0001 decision 4). The NFX section is `@sovit/ui`'s and has
 * no place for a line from its shell, and the submodule is not changed for one: so this keeps one
 * text-only `<p>` directly after the section's WebRTC switch row, for as long as there is a
 * reason to show. The row is found by the id `@sovit/ui` gives its switch (`…-nfx-webrtc`), the
 * line is set with `textContent` only, and a page without that row (any other screen) has none.
 */

export const WEBRTC_NOTE_ID = 'nutflix-webrtc-status';

export interface WebRtcNote {
  /** Reads `text()` again: the probe finished, or a setting changed. */
  refresh(): void;
  stop(): void;
}

/** Finds the switch's row in `root` and keeps the note after it. */
export function installWebRtcNote(root: HTMLElement, text: () => string | null): WebRtcNote {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  if (view === null) return { refresh: () => undefined, stop: () => undefined };
  let note: HTMLParagraphElement | null = null;

  const render = (): void => {
    const line = text();
    const toggle = root.querySelector('input[role="switch"][id$="-nfx-webrtc"]');
    const row = toggle?.closest('.nf-settings__row') ?? null;
    if (line === null || row === null) {
      note?.remove();
      return;
    }
    if (note === null) {
      note = doc.createElement('p');
      note.id = WEBRTC_NOTE_ID;
      note.className = 'nf-settings__desc';
      note.setAttribute('role', 'status');
    }
    if (note.textContent !== line) note.textContent = line;
    if (row.nextElementSibling !== note) row.after(note);
  };

  const observer = new view.MutationObserver(render);
  observer.observe(root, { childList: true, subtree: true });
  render();
  return {
    refresh: render,
    stop: () => {
      observer.disconnect();
      note?.remove();
    },
  };
}
