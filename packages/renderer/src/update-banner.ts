/**
 * Shows the update status main sends down the worker pipe (`{op:'ev', e:'update', state}`, allowed
 * for this window by `rpc-gate.ts`). The renderer only displays: it holds no key, reads no notice
 * and has no way to ask for an update. Text comes from `update-text.ts`, by state; styles go through
 * the CSSOM because the page's policy has no inline style.
 */
import { FrameDecoder } from '@nutflix-runtime/worker';

import { UPDATE_BANNER_ID, updateBannerText } from './update-text.js';

/** The part of a `WorkerPipe` this needs. */
interface UpdatePipe {
  onData(cb: (bytes: Uint8Array) => void): () => void;
  onClose(cb: () => void): () => void;
}

export function showUpdateStatus(doc: Document, state: unknown): void {
  const text = updateBannerText(state);
  const existing = doc.getElementById(UPDATE_BANNER_ID);
  if (text === null) {
    existing?.remove();
    return;
  }
  const el = existing ?? doc.createElement('div');
  if (existing === null) {
    el.id = UPDATE_BANNER_ID;
    el.setAttribute('role', 'status');
    const s = el.style;
    s.position = 'fixed';
    s.bottom = '0';
    s.left = '0';
    s.right = '0';
    s.zIndex = '2147483646';
    s.background = '#23272f';
    s.color = '#ffffff';
    s.padding = '6px 12px';
    s.font = '600 13px system-ui, sans-serif';
    s.textAlign = 'center';
    s.pointerEvents = 'none';
    doc.body.appendChild(el);
  }
  el.dataset['updateState'] = String(state);
  el.textContent = text;
}

/** Listens on `pipe` for update events until it closes. */
export function installUpdateBanner(doc: Document, pipe: UpdatePipe): () => void {
  const decoder = new FrameDecoder((msg) => {
    const m = msg as Record<string, unknown>;
    if (m['op'] === 'ev' && m['e'] === 'update') showUpdateStatus(doc, m['state']);
  });
  let offData: (() => void) | null = null;
  const off = (): void => {
    offData?.();
    offData = null;
  };
  offData = pipe.onData((bytes) => {
    try {
      decoder.push(bytes);
    } catch {
      // The pipe's own client reports a corrupt stream; this listener just stops.
      off();
    }
  });
  const offClose = pipe.onClose(off);
  return () => {
    off();
    offClose();
  };
}
