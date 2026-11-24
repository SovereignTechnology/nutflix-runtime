/**
 * What this window says about itself (ADR 0001 amendment, item 1). Everything is set with
 * `textContent`. The label stays on screen for as long as the window is open, and doubles as the
 * title bar, because the runtime opens a frameless window.
 */
import { WEBRTC_NOTE_ID } from '../../../../packages/renderer/src/settings/webrtc-note.js';

export const LABEL_ID = 'nutflix-legacy-label';
export const LEGACY_NOTE_ID = 'nutflix-legacy-webrtc-note';

export const LABEL_TITLE = 'Unsandboxed legacy build';
export const LABEL_TEXT =
  'Pear v2 runs this window with Node access and no sandbox. Prefer the Pear v3 app: pear install.';

/** The same label on a link with no fork and length, which the runtime updates by itself. */
export const LABEL_TEXT_UNVERSIONED =
  'Pear v2 runs this window with Node access and no sandbox. This unversioned link updates with no signed notice. Prefer the Pear v3 app: pear install.';

export const WEBRTC_LEGACY_NOTE =
  'This legacy runtime cannot set webRTCIPHandlingPolicy, so WebRTC cannot be limited to your public address. It starts off here. If you turn it on, peers may also see your local network and VPN addresses.';

export interface WindowControls {
  minimize(): unknown;
  maximize(): unknown;
  restore(): unknown;
  isMaximized(): Promise<boolean>;
  close(): unknown;
}

/** `pear://<fork>.<length>.<key>`: the only form that holds one exact build. */
export function isVersionedLink(link: unknown): boolean {
  return typeof link === 'string' && /^pear:\/\/\d+\.\d+\.[a-z0-9]{52}(\/|$)/.test(link);
}

function control(doc: Document, name: string, glyph: string, run: () => void): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.textContent = glyph;
  b.setAttribute('aria-label', name);
  b.title = name;
  b.addEventListener('click', run);
  return b;
}

/** Puts the label at the top of `doc.body`. */
export function installLabel(
  doc: Document,
  controls: WindowControls | null,
  versioned: boolean,
): HTMLElement {
  const bar = doc.createElement('div');
  bar.id = LABEL_ID;
  bar.setAttribute('role', 'status');
  const text = doc.createElement('span');
  text.className = 'nutflix-legacy-text';
  const title = doc.createElement('strong');
  title.textContent = LABEL_TITLE;
  text.append(title, doc.createTextNode(`. ${versioned ? LABEL_TEXT : LABEL_TEXT_UNVERSIONED}`));
  bar.append(text);
  if (controls !== null) {
    const box = doc.createElement('span');
    box.className = 'nutflix-legacy-controls';
    box.append(
      control(doc, 'Minimize', '–', () => void controls.minimize()),
      control(doc, 'Maximize', '□', () => {
        void controls.isMaximized().then((m) => (m ? controls.restore() : controls.maximize()));
      }),
      control(doc, 'Close', '×', () => void controls.close()),
    );
    bar.append(box);
  }
  doc.body.prepend(bar);
  return bar;
}

/**
 * Keeps one text-only `<p>` under the WebRTC switch in Settings, after the renderer's own status
 * line if it has one. The renderer keeps its line directly after the switch's row, so this one
 * follows it and the two never fight over the same place.
 */
export function installWebRtcWarning(root: HTMLElement): () => void {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  if (view === null) return () => undefined;
  let note: HTMLParagraphElement | null = null;
  const render = (): void => {
    const toggle = root.querySelector('input[role="switch"][id$="-nfx-webrtc"]');
    const row = toggle?.closest('.nf-settings__row') ?? null;
    if (row === null) {
      note?.remove();
      return;
    }
    if (note === null) {
      note = doc.createElement('p');
      note.id = LEGACY_NOTE_ID;
      note.className = 'nf-settings__desc';
      note.setAttribute('role', 'note');
      note.textContent = WEBRTC_LEGACY_NOTE;
    }
    const next = row.nextElementSibling;
    const anchor = next !== null && next.id === WEBRTC_NOTE_ID ? next : row;
    if (anchor.nextElementSibling !== note) anchor.after(note);
  };
  const observer = new view.MutationObserver(render);
  observer.observe(root, { childList: true, subtree: true });
  render();
  return () => {
    observer.disconnect();
    note?.remove();
  };
}
