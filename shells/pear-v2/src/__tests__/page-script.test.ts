// @vitest-environment jsdom
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_NFX } from '../../../../packages/renderer/src/settings/defaults.ts';
import {
  SETTINGS_KEY,
  parseStoredSettings,
  type SettingsStorage,
} from '../../../../packages/renderer/src/settings/store.ts';
import { WEBRTC_NOTE_ID } from '../../../../packages/renderer/src/settings/webrtc-note.ts';
import { removeWebRtc, webrtcOffUnlessChosen } from '../page/first-run.ts';
import {
  LABEL_ID,
  LABEL_TEXT_UNVERSIONED,
  LABEL_TITLE,
  LEGACY_NOTE_ID,
  WEBRTC_LEGACY_NOTE,
  installLabel,
  installWebRtcWarning,
  isVersionedLink,
  type WindowControls,
} from '../page/notices.ts';
import { LINK_LIMIT, LINK_WINDOW_MS, checkedLink, linkOpener } from '../page/open-link.ts';
import { workerPipeOver } from '../page/pipe.ts';

class FakeStream extends EventEmitter {
  readonly written: Uint8Array[] = [];
  destroyed = 0;
  write(b: Uint8Array): void {
    this.written.push(b);
  }
  destroy(): void {
    this.destroyed++;
  }
}

function memory(initial?: string): SettingsStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key) {
      expect(key).toBe(SETTINGS_KEY);
      return this.value;
    },
    setItem(_key, v) {
      this.value = v;
    },
  };
}

describe('the worker pipe over the page stream', () => {
  it('carries bytes both ways, as plain copies', () => {
    const s = new FakeStream();
    const p = workerPipeOver(s);
    const got: Uint8Array[] = [];
    p.onData((b) => got.push(b));
    p.write(Uint8Array.of(1, 2));
    expect(s.written).toEqual([Uint8Array.of(1, 2)]);
    const chunk = Buffer.from([3, 4]);
    s.emit('data', chunk);
    expect(got[0]).toEqual(Uint8Array.of(3, 4));
    expect(got[0]).not.toBe(chunk);
    expect(Buffer.isBuffer(got[0])).toBe(false);
  });

  it('survives a listener that throws', () => {
    const s = new FakeStream();
    const p = workerPipeOver(s);
    const seen: number[] = [];
    p.onData(() => {
      throw new Error('no');
    });
    p.onData((b) => seen.push(b.length));
    s.emit('data', Uint8Array.of(9));
    expect(seen).toEqual([1]);
  });

  it.each(['end', 'close', 'error'])('tells listeners on %s, once', (ev) => {
    const s = new FakeStream();
    const p = workerPipeOver(s);
    const closed = vi.fn();
    p.onClose(closed);
    s.emit(ev, new Error('x'));
    s.emit('close');
    expect(closed).toHaveBeenCalledTimes(1);
    expect(() => {
      p.write(Uint8Array.of(1));
    }).toThrow(/closed/);
  });

  it('never destroys the shared stream when the page is done with it', () => {
    const s = new FakeStream();
    const p = workerPipeOver(s);
    p.close();
    expect(s.destroyed).toBe(0);
  });
});

describe('WebRTC starts off', () => {
  it('writes off on a first run, in a form the renderer reads back', () => {
    const m = memory();
    expect(webrtcOffUnlessChosen(() => m)).toBe('written');
    const s = parseStoredSettings(m.value);
    expect(s.nfx?.webrtc).toBe(false);
    expect(s.nfx?.scopedRelays).toEqual(DEFAULT_NFX.scopedRelays);
  });

  it.each(['not json', '{"v":2,"settings":{}}', '{"v":1,"settings":{"nfx":{"webrtc":"yes"}}}'])(
    'treats an unreadable value as no choice: %s',
    (raw) => {
      const m = memory(raw);
      expect(webrtcOffUnlessChosen(() => m)).toBe('written');
      expect(parseStoredSettings(m.value).nfx?.webrtc).toBe(false);
    },
  );

  it('keeps the other settings when it turns WebRTC off', () => {
    const m = memory(JSON.stringify({ v: 1, settings: { theme: 'dark' } }));
    expect(webrtcOffUnlessChosen(() => m)).toBe('written');
    const s = parseStoredSettings(m.value);
    expect(s.theme).toBe('dark');
    expect(s.nfx?.webrtc).toBe(false);
  });

  it.each([true, false])('keeps a choice the viewer made: %s', (webrtc) => {
    const raw = JSON.stringify({ v: 1, settings: { nfx: { ...DEFAULT_NFX, webrtc } } });
    const m = memory(raw);
    expect(webrtcOffUnlessChosen(() => m)).toBe('kept');
    expect(m.value).toBe(raw);
  });

  it('does not count a choice the renderer would refuse', () => {
    const raw = JSON.stringify({
      v: 1,
      settings: { nfx: { ...DEFAULT_NFX, webrtc: true, network: 'nfx:other:1' } },
    });
    const m = memory(raw);
    webrtcOffUnlessChosen(() => m);
    expect(parseStoredSettings(m.value).nfx?.webrtc).toBe(false);
  });

  it('says so when storage refuses a read, a write, or cannot even be reached', () => {
    const noRead: SettingsStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => undefined,
    };
    const noWrite: SettingsStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(webrtcOffUnlessChosen(() => noRead)).toBe('no-storage');
    expect(webrtcOffUnlessChosen(() => noWrite)).toBe('no-storage');
    expect(
      webrtcOffUnlessChosen(() => {
        throw new Error('SecurityError');
      }),
    ).toBe('no-storage');
  });

  it('with no storage, takes WebRTC out so that the probe cannot find it', () => {
    const g: Record<string, unknown> = {
      RTCPeerConnection: vi.fn(),
      webkitRTCPeerConnection: vi.fn(),
    };
    removeWebRtc(g);
    expect(typeof g['RTCPeerConnection']).toBe('undefined');
    expect(typeof g['webkitRTCPeerConnection']).toBe('undefined');
    expect(() => {
      g['RTCPeerConnection'] = vi.fn();
    }).toThrow(TypeError);
  });
});

describe('links', () => {
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'file:///etc/passwd',
    'data:text/html,x',
    'pear://abc',
    'http://example.org/',
    'https://user:pw@example.org/',
    'https://127.0.0.1/',
    'https://localhost/',
    'https://[::1]/',
    'https://192.168.1.1/',
    ' https://example.org/',
    '',
    null,
    42,
    { href: 'https://example.org/' },
  ])('refuses %j', (raw) => {
    expect(checkedLink(raw)).toBeNull();
    const open = vi.fn();
    expect(linkOpener(open)(raw)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('opens a public https link, once per call', () => {
    const open = vi.fn();
    expect(linkOpener(open)('https://example.org/a?b=1')).toBe(true);
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.org/a?b=1');
  });

  it('limits how many a page can open', () => {
    let t = 1000;
    const open = vi.fn();
    const go = linkOpener(open, () => t);
    for (let i = 0; i < LINK_LIMIT; i++) expect(go('https://example.org/')).toBe(true);
    expect(go('https://example.org/')).toBe(false);
    t += LINK_WINDOW_MS;
    expect(go('https://example.org/')).toBe(true);
  });

  it('reports a failed open as not opened', () => {
    const go = linkOpener(() => {
      throw new Error('no');
    });
    expect(go('https://example.org/')).toBe(false);
  });
});

describe('what the window says', () => {
  function controls(): {
    readonly ui: WindowControls;
    readonly minimize: ReturnType<typeof vi.fn>;
    readonly maximize: ReturnType<typeof vi.fn>;
    readonly restore: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
    setMaximized(v: boolean): void;
  } {
    const minimize = vi.fn();
    const maximize = vi.fn();
    const restore = vi.fn();
    const close = vi.fn();
    let maximized = false;
    return {
      ui: {
        minimize: () => {
          minimize();
        },
        maximize: () => {
          maximize();
        },
        restore: () => {
          restore();
        },
        close: () => {
          close();
        },
        isMaximized: () => Promise.resolve(maximized),
      },
      minimize,
      maximize,
      restore,
      close,
      setMaximized: (v) => {
        maximized = v;
      },
    };
  }

  it('puts the label first in the body, as text, with the advice', () => {
    document.body.textContent = '';
    const first = document.createElement('div');
    document.body.append(first);
    const bar = installLabel(document, null, true);
    expect(document.body.firstElementChild).toBe(bar);
    expect(bar.id).toBe(LABEL_ID);
    expect(bar.getAttribute('role')).toBe('status');
    expect(bar.textContent).toContain(LABEL_TITLE);
    expect(bar.textContent).toContain('no sandbox');
    expect(bar.textContent).toContain('pear install');
    expect(bar.querySelectorAll('button')).toHaveLength(0);
  });

  it('says so on a link that updates by itself, and still names the risk', () => {
    document.body.textContent = '';
    const bar = installLabel(document, null, false);
    expect(bar.textContent).toContain(LABEL_TEXT_UNVERSIONED);
    expect(bar.textContent).toContain('no sandbox');
    expect(bar.textContent).toContain('no signed notice');
    expect(bar.textContent).toContain('pear install');
  });

  it.each([
    [`pear://0.42.${'y'.repeat(52)}`, true],
    [`pear://3.1000.${'a'.repeat(52)}/`, true],
    [`pear://${'y'.repeat(52)}`, false],
    [`pear://0.${'y'.repeat(52)}`, false],
    [`pear://0.42.${'y'.repeat(51)}`, false],
    [`https://0.42.${'y'.repeat(52)}`, false],
    ['file:///home/x/app', false],
    [undefined, false],
    [42, false],
  ])('reads %j as versioned: %s', (link, want) => {
    expect(isVersionedLink(link)).toBe(want);
  });

  it('gives a frameless window its controls', async () => {
    document.body.textContent = '';
    const c = controls();
    const bar = installLabel(document, c.ui, true);
    const byName = (n: string): HTMLButtonElement => {
      const b = bar.querySelector<HTMLButtonElement>(`button[aria-label="${n}"]`);
      if (b === null) throw new Error(n);
      return b;
    };
    byName('Minimize').click();
    byName('Close').click();
    byName('Maximize').click();
    await vi.waitFor(() => {
      expect(c.maximize).toHaveBeenCalledOnce();
    });
    expect(c.minimize).toHaveBeenCalledOnce();
    expect(c.close).toHaveBeenCalledOnce();
    c.setMaximized(true);
    byName('Maximize').click();
    await vi.waitFor(() => {
      expect(c.restore).toHaveBeenCalledOnce();
    });
  });

  function settingsRow(root: HTMLElement): HTMLElement {
    const row = document.createElement('div');
    row.className = 'nf-settings__row';
    const input = document.createElement('input');
    input.setAttribute('role', 'switch');
    input.id = 'x-nfx-webrtc';
    row.append(input);
    root.append(row);
    return row;
  }

  it('keeps the WebRTC warning after the switch, and after the renderer’s line', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const stop = installWebRtcWarning(root);
    expect(document.getElementById(LEGACY_NOTE_ID)).toBeNull();
    const row = settingsRow(root);
    await vi.waitFor(() => {
      expect(document.getElementById(LEGACY_NOTE_ID)).not.toBeNull();
    });
    const note = document.getElementById(LEGACY_NOTE_ID);
    expect(note?.textContent).toBe(WEBRTC_LEGACY_NOTE);
    expect(row.nextElementSibling).toBe(note);

    // The renderer puts its own status line directly after the row.
    const status = document.createElement('p');
    status.id = WEBRTC_NOTE_ID;
    row.after(status);
    await vi.waitFor(() => {
      expect(status.nextElementSibling).toBe(note);
    });
    expect(row.nextElementSibling).toBe(status);

    row.remove();
    await vi.waitFor(() => {
      expect(document.getElementById(LEGACY_NOTE_ID)).toBeNull();
    });
    stop();
    root.remove();
  });

  it('names the setting the runtime lacks and what a peer could see', () => {
    expect(WEBRTC_LEGACY_NOTE).toContain('webRTCIPHandlingPolicy');
    expect(WEBRTC_LEGACY_NOTE).toContain('starts off');
    expect(WEBRTC_LEGACY_NOTE).toContain('local network and VPN addresses');
  });
});
