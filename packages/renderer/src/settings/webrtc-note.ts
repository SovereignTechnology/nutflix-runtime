/**
 * Settings says why WebRTC is off (ADR 0001 decision 4), and which hosts a play may reach besides
 * peers (the `https` origins beacons name). The NFX section is `@sovit/ui`'s and has no place for
 * a line from its shell, and the submodule is not changed for one: so this keeps up to two
 * text-only `<p>`s directly after the section's WebRTC switch row, the status first, each for as
 * long as it has something to say. The row is found by the id `@sovit/ui` gives its switch
 * (`…-nfx-webrtc`), the lines are set with `textContent` only, and a page without that row (any
 * other screen) has none.
 */

export const WEBRTC_NOTE_ID = 'nutflix-webrtc-status';
export const ORIGINS_NOTE_ID = 'nutflix-https-origins';

export interface WebRtcNote {
  /** Reads `text()` again: the probe finished, or a setting changed. */
  refresh(): void;
  stop(): void;
}

/**
 * Finds the switch's row in `root` and keeps the notes after it: `text`, the status line, then
 * `disclosure`, the hosts a play may reach. Either is absent while it returns `null`.
 */
export function installWebRtcNote(
  root: HTMLElement,
  text: () => string | null,
  disclosure: () => string | null = () => null,
): WebRtcNote {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  if (view === null) return { refresh: () => undefined, stop: () => undefined };
  const notes: {
    readonly id: string;
    readonly line: () => string | null;
    p: HTMLElement | null;
  }[] = [
    { id: WEBRTC_NOTE_ID, line: text, p: null },
    { id: ORIGINS_NOTE_ID, line: disclosure, p: null },
  ];

  const render = (): void => {
    const toggle = root.querySelector('input[role="switch"][id$="-nfx-webrtc"]');
    const row = toggle?.closest('.nf-settings__row') ?? null;
    // Each note goes right after the one before it, or after the row: moved only when it is not
    // there already, so the observer's own mutations end here.
    let after: Element | null = row;
    for (const n of notes) {
      const line = n.line();
      if (line === null || after === null) {
        n.p?.remove();
        continue;
      }
      if (n.p === null) {
        n.p = doc.createElement('p');
        n.p.id = n.id;
        n.p.className = 'nf-settings__desc';
        n.p.setAttribute('role', 'status');
      }
      if (n.p.textContent !== line) n.p.textContent = line;
      if (after.nextElementSibling !== n.p) after.after(n.p);
      after = n.p;
    }
  };

  const observer = new view.MutationObserver(render);
  observer.observe(root, { childList: true, subtree: true });
  render();
  return {
    refresh: render,
    stop: () => {
      observer.disconnect();
      for (const n of notes) n.p?.remove();
    },
  };
}
