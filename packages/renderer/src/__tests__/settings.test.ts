// @vitest-environment node
/**
 * The renderer's settings: the desktop app's defaults (the scoped relay `relay.nutflix.xyz` first),
 * what a patch may hold, what is read back from storage, and that nothing fixed is ever written.
 */
import { describe, expect, it } from 'vitest';

import type { RelayUrl } from '@sovit/core';

import { RuntimeAdapterError } from '../errors.js';
import { DEFAULT_NFX, DEFAULT_SETTINGS, NFX_NETWORK, SCOPED_RELAY } from '../settings/defaults.js';
import {
  MAX_STORED_SETTINGS,
  SETTINGS_KEY,
  SettingsStore,
  parseStoredSettings,
} from '../settings/store.js';
import { isSettingsPatch } from '../settings/validate.js';

function memory(): {
  get: (k: string) => string | null;
  set: (k: string, v: string) => void;
  m: Map<string, string>;
} {
  const m = new Map<string, string>();
  return { m, get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v) };
}

describe('the defaults', () => {
  it('are nutflix-pear’s: the scoped relay first, the four public read relays, NFX on', () => {
    expect(SCOPED_RELAY).toBe('wss://relay.nutflix.xyz');
    expect(DEFAULT_NFX).toEqual({
      enabled: true,
      network: 'nfx:testnet:1',
      scopedRelays: [SCOPED_RELAY],
    });
    expect(NFX_NETWORK).toBe('nfx:testnet:1');
    expect(DEFAULT_SETTINGS.relays.map((r) => r.url)).toEqual([
      'wss://relay.primal.net',
      'wss://relay.ditto.pub',
    ]);
    expect(DEFAULT_SETTINGS.nfx?.scopedRelays[0]).toBe(SCOPED_RELAY);
    expect(DEFAULT_SETTINGS).toMatchObject({
      prefetchSeconds: 30,
      loadRemoteImages: false,
      defaultMints: [],
      seeding: { enabled: false },
    });
  });
});

describe('isSettingsPatch', () => {
  it('takes what a viewer sets', () => {
    expect(isSettingsPatch({})).toBe(true);
    expect(isSettingsPatch({ theme: 'dark', prefetchSeconds: 60, hoverPreview: false })).toBe(true);
    expect(
      isSettingsPatch({ relays: [{ url: 'wss://a.example', read: true, write: false }] }),
    ).toBe(true);
    expect(
      isSettingsPatch({
        nfx: {
          enabled: true,
          network: NFX_NETWORK,
          scopedRelays: ['ws://127.0.0.1:7777', 'wss://b.example'],
        },
      }),
    ).toBe(true);
  });

  it.each([
    ['remote images on', { loadRemoteImages: true }],
    ['a mint', { defaultMints: ['https://mint.example'] }],
    ['seeding', { seeding: { enabled: true, diskCapBytes: 1 } }],
    ['another network', { nfx: { enabled: true, network: 'nfx:mainnet:1', scopedRelays: [] } }],
    ['NFX off', { nfx: { enabled: false, network: NFX_NETWORK, scopedRelays: [] } }],
    [
      'signaling relays (slice B)',
      { nfx: { enabled: true, network: NFX_NETWORK, scopedRelays: [], meshRelays: [] } },
    ],
    [
      'iroh relays',
      { nfx: { enabled: true, network: NFX_NETWORK, scopedRelays: [], irohRelays: [] } },
    ],
    ['a plain ws relay', { relays: [{ url: 'ws://relay.example', read: true, write: true }] }],
    [
      'a relay with user-info',
      { relays: [{ url: 'wss://u@relay.example', read: true, write: true }] },
    ],
    ['an unknown key', { nope: 1 }],
    [
      'an unknown relay key',
      { relays: [{ url: 'wss://a.example', read: true, write: true, x: 1 }] },
    ],
    [
      'a scoped ws relay that is not loopback',
      { nfx: { enabled: true, network: NFX_NETWORK, scopedRelays: ['ws://relay.example'] } },
    ],
    [
      'a repeated scoped relay',
      {
        nfx: {
          enabled: true,
          network: NFX_NETWORK,
          scopedRelays: ['wss://a.example', 'wss://a.example'],
        },
      },
    ],
    ['prefetch past the cap', { prefetchSeconds: 601 }],
    ['negative prefetch', { prefetchSeconds: -1 }],
    ['NaN prefetch', { prefetchSeconds: Number.NaN }],
    ['a bad theme', { theme: 'blue' }],
    ['an array', []],
    ['null', null],
  ])('refuses %s', (_n, patch) => {
    expect(isSettingsPatch(patch)).toBe(false);
  });

  it('never throws, even on a hostile getter', () => {
    const hostile = {
      get theme(): never {
        throw new Error('boom');
      },
    };
    expect(isSettingsPatch(hostile)).toBe(false);
  });
});

describe('parseStoredSettings', () => {
  const stored = (settings: unknown): string => JSON.stringify({ v: 1, settings });

  it('reads back what was written, and takes defaults for the rest', () => {
    const s = parseStoredSettings(stored({ theme: 'light', prefetchSeconds: 5 }));
    expect(s).toMatchObject({ theme: 'light', prefetchSeconds: 5, hoverPreview: true });
    expect(s.relays).toEqual(DEFAULT_SETTINGS.relays);
  });

  it.each([
    ['nothing', null],
    ['not JSON', '{'],
    ['an array', '[]'],
    ['another version', JSON.stringify({ v: 2, settings: { theme: 'dark' } })],
    ['no settings', JSON.stringify({ v: 1 })],
    ['an invalid field', stored({ theme: 'blue' })],
    ['remote images on', stored({ loadRemoteImages: true })],
    ['too large', ' '.repeat(MAX_STORED_SETTINGS + 1)],
  ])('is the defaults for %s', (_n, raw) => {
    expect(parseStoredSettings(raw)).toBe(DEFAULT_SETTINGS);
  });

  it('ignores a key the renderer does not store, and replaces an nfx that does not check out', () => {
    expect(
      parseStoredSettings(stored({ theme: 'dark', defaultMints: ['x'], wallet: 1 })).theme,
    ).toBe('dark');
    const s = parseStoredSettings(
      stored({ nfx: { enabled: false, network: 'nfx:x:1', scopedRelays: [] } }),
    );
    expect(s.nfx).toEqual(DEFAULT_NFX);
  });
});

describe('SettingsStore', () => {
  it('writes only what a viewer sets, whole, under one key, and a second store reads it back', () => {
    const st = memory();
    const storage = { getItem: st.get, setItem: st.set };
    const a = new SettingsStore({ storage });
    const heard: string[] = [];
    a.onChange((s) => heard.push(s.theme));
    a.update({ theme: 'dark' });
    expect(heard).toEqual(['dark']);
    expect([...st.m.keys()]).toEqual([SETTINGS_KEY]);
    const written = JSON.parse(st.m.get(SETTINGS_KEY) ?? '{}') as {
      v: number;
      settings: Record<string, unknown>;
    };
    expect(written.v).toBe(1);
    expect(Object.keys(written.settings).sort()).toEqual(
      ['hoverPreview', 'loadRemoteImages', 'nfx', 'prefetchSeconds', 'relays', 'theme'].sort(),
    );
    expect(new SettingsStore({ storage }).get().theme).toBe('dark');
  });

  it('refuses a patch it would not read back, and changes nothing', () => {
    const s = new SettingsStore({ storage: null });
    expect(() => s.update({ loadRemoteImages: true })).toThrow(RuntimeAdapterError);
    expect(() =>
      s.update({ relays: [{ url: 'ws://x.example' as RelayUrl, read: true, write: true }] }),
    ).toThrow(/invalid-argument/);
    expect(s.get()).toBe(DEFAULT_SETTINGS);
  });

  it('keeps going in memory when the browser refuses a write, and says so', () => {
    const s = new SettingsStore({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota');
        },
      },
    });
    expect(() => s.update({ theme: 'dark' })).toThrow(/internal/);
    expect(s.get().theme).toBe('system');
  });

  it('hears another tab’s write', () => {
    const st = memory();
    const listeners = new Set<(e: { key: string | null }) => void>();
    const events = {
      addEventListener: (_t: 'storage', l: (e: { key: string | null }) => void) =>
        void listeners.add(l),
      removeEventListener: (_t: 'storage', l: (e: { key: string | null }) => void) =>
        void listeners.delete(l),
    };
    const s = new SettingsStore({ storage: { getItem: st.get, setItem: st.set }, events });
    const heard: string[] = [];
    s.onChange((n) => heard.push(n.theme));
    st.set(SETTINGS_KEY, JSON.stringify({ v: 1, settings: { theme: 'light' } }));
    for (const l of listeners) l({ key: SETTINGS_KEY });
    for (const l of listeners) l({ key: 'something else' });
    expect(heard).toEqual(['light']);
    s.close();
    expect(listeners.size).toBe(0);
  });
});
