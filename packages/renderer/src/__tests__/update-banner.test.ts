import { encodeFrame } from '@nutflix-runtime/worker';
import { afterEach, describe, expect, it } from 'vitest';

import { installUpdateBanner, showUpdateStatus } from '../update-banner.js';
import { UPDATE_BANNER_ID, UPDATE_HELD_TEXT, updateBannerText } from '../update-text.js';

const banner = (): HTMLElement | null => document.getElementById(UPDATE_BANNER_ID);

function pipe(): {
  onData(cb: (b: Uint8Array) => void): () => void;
  onClose(cb: () => void): () => void;
  push(b: Uint8Array): void;
  close(): void;
} {
  let data: ((b: Uint8Array) => void) | null = null;
  let closed: (() => void) | null = null;
  return {
    onData: (cb) => {
      data = cb;
      return () => {
        data = null;
      };
    },
    onClose: (cb) => {
      closed = cb;
      return () => {
        closed = null;
      };
    },
    push: (b) => {
      data?.(b);
    },
    close: () => {
      closed?.();
    },
  };
}

describe('the update banner', () => {
  afterEach(() => {
    banner()?.remove();
  });

  it('says "unverified update held" for a held build', () => {
    expect(UPDATE_HELD_TEXT.toLowerCase()).toContain('unverified update held');
    showUpdateStatus(document, 'held');
    expect(banner()?.textContent).toBe(UPDATE_HELD_TEXT);
    expect(banner()?.dataset['updateState']).toBe('held');
    expect(banner()?.getAttribute('role')).toBe('status');
  });

  it('has words only for the states a viewer needs, and none from the wire', () => {
    for (const s of ['watching', 'checking', 'applying', 'nope', '<img src=x>', 1, null])
      expect(updateBannerText(s)).toBeNull();
    showUpdateStatus(document, '<img src=x onerror=alert(1)>');
    expect(banner()).toBeNull();
  });

  it('goes away when the state has nothing to say', () => {
    showUpdateStatus(document, 'held');
    showUpdateStatus(document, 'checking');
    expect(banner()).toBeNull();
  });

  it('follows update events on the pipe and ignores everything else', () => {
    const p = pipe();
    const off = installUpdateBanner(document, p);
    p.push(encodeFrame({ op: 'ev', e: 'status', state: 'held' }));
    expect(banner()).toBeNull();
    p.push(encodeFrame({ op: 'res', id: 1, ok: true, r: { state: 'held' } }));
    expect(banner()).toBeNull();
    p.push(encodeFrame({ op: 'ev', e: 'update', state: 'held' }));
    expect(banner()?.textContent).toBe(UPDATE_HELD_TEXT);
    off();
    p.push(encodeFrame({ op: 'ev', e: 'update', state: 'checking' }));
    expect(banner()).not.toBeNull();
  });

  it('stops listening on a corrupt stream, and when the pipe closes', () => {
    const a = pipe();
    installUpdateBanner(document, a);
    a.push(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0]));
    a.push(encodeFrame({ op: 'ev', e: 'update', state: 'held' }));
    expect(banner()).toBeNull();
    const b = pipe();
    installUpdateBanner(document, b);
    b.close();
    b.push(encodeFrame({ op: 'ev', e: 'update', state: 'held' }));
    expect(banner()).toBeNull();
  });
});
