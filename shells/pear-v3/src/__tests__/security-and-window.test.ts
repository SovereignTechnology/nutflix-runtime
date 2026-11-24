import type { BrowserWindowConstructorOptions } from 'electron';
import { describe, expect, it } from 'vitest';

import {
  PACKAGED_REFUSED_SWITCHES,
  SANDBOX_BYPASS_SWITCHES,
  allowPermissionCheck,
  allowPermissionRequest,
  hardenWebContents,
  installSessionPolicy,
  refusedSwitch,
  type PolicySession,
} from '../main/security.ts';
import { APP_ORIGIN, APP_URL, isAppOrigin, isAppUrl, privilegedSchemes } from '../main/schemes.ts';
import { NOT_MOUNTED_CODE, PROBE_CODE, parseNotMounted, parseProbe } from '../main/page-probe.ts';
import { WEBRTC_IP_POLICY, createMainWindow, type BrowserWindowCtor } from '../main/window.ts';

const cl = (switches: Record<string, string> = {}) => ({
  hasSwitch: (n: string): boolean => n in switches,
  getSwitchValue: (n: string): string => switches[n] ?? '',
});

describe('the switch policy', () => {
  it("lets --no-sandbox through to the warning: it is the user's choice, not a refusal", () => {
    expect(refusedSwitch(cl({ 'no-sandbox': '' }), ['--no-sandbox'], true)).toBeUndefined();
    expect(refusedSwitch(cl({ 'no-sandbox': '' }), ['--no-sandbox'], false)).toBeUndefined();
  });

  it.each([...SANDBOX_BYPASS_SWITCHES])('refuses --%s in every build', (s) => {
    expect(refusedSwitch(cl({ [s]: '' }), [], false)).toBe(s);
    expect(refusedSwitch(cl({ [s]: '' }), [], true)).toBe(s);
  });

  it.each([...PACKAGED_REFUSED_SWITCHES])('refuses --%s in a packaged build only', (s) => {
    expect(refusedSwitch(cl({ [s]: '' }), [], true)).toBe(s);
    expect(refusedSwitch(cl({ [s]: '' }), [], false)).toBeUndefined();
  });

  it('allows only the two Wayland features, from the command line Chromium reports and from argv', () => {
    const ok = 'UseOzonePlatform,WaylandWindowDecorations';
    expect(
      refusedSwitch(cl({ 'enable-features': ok }), [`--enable-features=${ok}`], true),
    ).toBeUndefined();
    expect(refusedSwitch(cl({ 'enable-features': 'Evil' }), [], true)).toBe('features:Evil');
    expect(refusedSwitch(cl({ 'disable-features': 'NetworkServiceSandbox' }), [], true)).toBe(
      'features:NetworkServiceSandbox',
    );
    // A repeated switch cannot hide a name from the one Chromium reports.
    expect(
      refusedSwitch(
        cl({ 'enable-features': 'UseOzonePlatform' }),
        ['--enable-features=UseOzonePlatform', '/enable-features=Evil<Trial:a/b'],
        true,
      ),
    ).toBe('features:Evil<Trial:a/b');
    expect(refusedSwitch(cl({ 'enable-features': '' }), [], true)).toBe('features:(empty)');
    expect(refusedSwitch(cl({ 'enable-features': 'Evil' }), [], false)).toBeUndefined();
  });
});

describe('the window', () => {
  const capture = (): { opts: BrowserWindowConstructorOptions } => {
    const box = { opts: {} as BrowserWindowConstructorOptions };
    const Ctor = function (this: unknown, o: BrowserWindowConstructorOptions) {
      box.opts = o;
    } as unknown as BrowserWindowCtor;
    createMainWindow(Ctor, '/app/main/preload.cjs');
    return box;
  };

  it('is sandboxed, isolated, without Node and without DevTools, written as literals', () => {
    const { opts } = capture();
    expect(opts.webPreferences).toMatchObject({
      preload: '/app/main/preload.cjs',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      devTools: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
    });
  });

  it('keeps the menu bar on screen: the Account menu is the only way to secret entry', () => {
    expect(capture().opts.autoHideMenuBar).toBe(false);
  });

  it('leaves webSecurity, webviewTag and the other defaults alone, and shows nothing before it is ready', () => {
    const { opts } = capture();
    const keys = Object.keys(opts.webPreferences ?? {});
    for (const k of [
      'webSecurity',
      'webviewTag',
      'allowRunningInsecureContent',
      'experimentalFeatures',
      'enableBlinkFeatures',
      'contextIsolation',
    ])
      if (k !== 'contextIsolation') expect(keys).not.toContain(k);
    expect(opts.show).toBe(false);
  });

  it('pins the WebRTC policy of ADR 0001 decision 5', () => {
    expect(WEBRTC_IP_POLICY).toBe('default_public_interface_only');
  });
});

describe('what main logs when the renderer never mounted', () => {
  it('keeps only fixed values, whatever the page says', () => {
    expect(
      parseNotMounted({ root: true, children: 2, player: 'available', workerLink: 'down' }),
    ).toEqual({ root: true, children: 2, player: 'available', workerLink: 'down' });
    for (const bad of [
      null,
      7,
      'x',
      {},
      { root: 'yes', children: 1.5, player: '<b>', workerLink: 1 },
    ])
      expect(parseNotMounted(bad)).toEqual({
        root: false,
        children: 0,
        player: 'none',
        workerLink: 'none',
      });
    expect(NOT_MOUNTED_CODE).not.toMatch(/innerHTML|textContent|location|fetch/);
  });
});

describe('web contents and the session', () => {
  it('denies window.open and cancels navigation, redirects and webviews', () => {
    const handlers = new Map<string, (e: { preventDefault(): void }) => void>();
    let open: ((d: unknown) => { action: 'deny' }) | undefined;
    hardenWebContents({
      setWindowOpenHandler: (h) => {
        open = h;
      },
      on: (ev, l) => {
        handlers.set(ev, l);
      },
    });
    expect(open?.({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    expect([...handlers.keys()].sort()).toEqual([
      'will-attach-webview',
      'will-frame-navigate',
      'will-navigate',
      'will-redirect',
    ]);
    for (const h of handlers.values()) {
      let prevented = false;
      h({
        preventDefault: () => {
          prevented = true;
        },
      });
      expect(prevented).toBe(true);
    }
  });

  it('allows fullscreen for the top frame of the app origin, and nothing else', () => {
    expect(
      allowPermissionRequest('fullscreen', { isMainFrame: true, requestingUrl: APP_URL }),
    ).toBe(true);
    for (const p of [
      'media',
      'geolocation',
      'notifications',
      'clipboard-read',
      'clipboard-sanitized-write',
      'midi',
      'openExternal',
      'hid',
      'serial',
      'usb',
    ])
      expect(allowPermissionRequest(p, { isMainFrame: true, requestingUrl: APP_URL })).toBe(false);
    expect(
      allowPermissionRequest('fullscreen', { isMainFrame: false, requestingUrl: APP_URL }),
    ).toBe(false);
    expect(
      allowPermissionRequest('fullscreen', {
        isMainFrame: true,
        requestingUrl: 'https://example.com/',
      }),
    ).toBe(false);
    expect(allowPermissionCheck('fullscreen', APP_ORIGIN, { isMainFrame: true })).toBe(true);
    expect(
      allowPermissionCheck('fullscreen', APP_ORIGIN, {
        isMainFrame: true,
        embeddingOrigin: 'https://x.test',
      }),
    ).toBe(false);
    expect(allowPermissionCheck('fullscreen', 'https://example.com', { isMainFrame: true })).toBe(
      false,
    );
  });

  it('installs the session policy: no devices, no spell-check downloads, no downloads', () => {
    const calls: string[] = [];
    let onDownload: ((e: { preventDefault(): void }) => void) | undefined;
    const ses: PolicySession = {
      setPermissionRequestHandler: () => calls.push('request'),
      setPermissionCheckHandler: () => calls.push('check'),
      setDevicePermissionHandler: (h) => calls.push(`device:${String(h())}`),
      setSpellCheckerEnabled: (b) => calls.push(`spell:${String(b)}`),
      on: (_ev, l) => {
        onDownload = l;
      },
    };
    installSessionPolicy(ses);
    expect(calls).toEqual(['request', 'check', 'device:false', 'spell:false']);
    let prevented = false;
    onDownload?.({ preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);
  });

  it('knows its own origin exactly', () => {
    expect(isAppUrl(APP_URL)).toBe(true);
    expect(isAppUrl('app://nutflix/')).toBe(true);
    for (const u of [
      'app://nutflix.evil/',
      'app://user@nutflix/',
      'https://nutflix/',
      'file:///x',
      'app:nutflix',
      '',
      5,
      null,
    ])
      expect(isAppUrl(u)).toBe(false);
    expect(isAppOrigin(APP_ORIGIN)).toBe(true);
    expect(isAppOrigin(`${APP_ORIGIN}/`)).toBe(false);
    expect(privilegedSchemes()).toEqual([
      { scheme: 'app', privileges: { standard: true, secure: true, stream: true } },
    ]);
  });
});

describe('what main reads from the page', () => {
  it('accepts only the three facts, and nothing else the page might put in the object', () => {
    expect(parseProbe({ player: 'available', vp9: true, h264: false, x: '<script>' })).toEqual({
      player: 'available',
      vp9: true,
      h264: false,
    });
    expect(parseProbe({ player: 'unavailable', vp9: 'yes', h264: 1 })).toEqual({
      player: 'unavailable',
      vp9: false,
      h264: false,
    });
  });

  it.each([null, undefined, true, 'x', [], { player: 'maybe' }, { vp9: true }])(
    'is not mounted for %j',
    (x) => {
      expect(parseProbe(x)).toBeNull();
    },
  );

  it("waits for the page's own round trip to the worker", () => {
    expect(PROBE_CODE).toContain("r.dataset.workerLink !== 'up'");
  });

  it('is a read-only expression: no eval, no HTML, no network, no navigation', () => {
    expect(PROBE_CODE).not.toMatch(
      /\b(eval|Function|innerHTML|fetch|XMLHttpRequest|location|open)\b/,
    );
  });
});
