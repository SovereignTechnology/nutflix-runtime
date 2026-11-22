/**
 * The renderer's settings, kept in Web Storage under one key. Adapted from nutflix-pear's
 * `packages/app-web/src/settings/store.ts` (the submodule's pinned commit). This is the one
 * module of this package that may name a browser storage API. Nothing secret is stored: relays,
 * the theme and two playback preferences.
 *
 * - **Read as the desktop host reads `settings.json`:** unknown keys are ignored, missing ones take
 *   their defaults, and a value that is not JSON, too large, of another version or with any field
 *   this client would refuse in a patch means the defaults. An `nfx` that does not check out is
 *   replaced by the default one alone: NFX is always on here, so the default is never "off".
 * - **Written whole on every change,** and only the fields a viewer sets. A write the browser
 *   refuses (quota, a blocked origin) rejects and changes nothing; a page with no storage at all
 *   (storage disabled, some private modes) keeps its settings in memory for the session.
 * - **Open tabs agree:** a `storage` event for the key (or a cleared storage) re-reads it, and
 *   listeners hear the change.
 */
import type { Settings } from '@sovit/core';

import { RuntimeAdapterError } from '../errors.js';
import { DEFAULT_NFX, DEFAULT_SETTINGS } from './defaults.js';
import { SETTING_KEYS, isSettingsPatch } from './validate.js';

/** The Web Storage key. */
export const SETTINGS_KEY = 'nutflix.runtime.settings.v1';
/** The stored value's own version (inside the key's `v1`, as `settings.json` has one). */
const STORED_V = 1;
/** A stored value longer than this (UTF-16 code units) is not read. */
export const MAX_STORED_SETTINGS = 64 * 1024;

/** The part of Web Storage this module uses. */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Where `storage` events arrive (the page's `window`). */
export interface StorageEventTarget {
  addEventListener(type: 'storage', listener: (e: { readonly key: string | null }) => void): void;
  removeEventListener(
    type: 'storage',
    listener: (e: { readonly key: string | null }) => void,
  ): void;
}

/** A stored value → `Settings`. Never throws: anything unreadable is the defaults. */
export function parseStoredSettings(raw: string | null): Settings {
  if (raw === null || raw.length > MAX_STORED_SETTINGS) return DEFAULT_SETTINGS;
  let file: unknown;
  try {
    file = JSON.parse(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (typeof file !== 'object' || file === null || Array.isArray(file)) return DEFAULT_SETTINGS;
  const f = file as Readonly<Record<string, unknown>>;
  if (f['v'] !== STORED_V) return DEFAULT_SETTINGS;
  const s = f['settings'];
  if (typeof s !== 'object' || s === null || Array.isArray(s)) return DEFAULT_SETTINGS;
  const picked: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(s, k)) {
      picked[k] = (s as Readonly<Record<string, unknown>>)[k];
    }
  }
  const { nfx, ...rest } = picked;
  if (!isSettingsPatch(rest)) return DEFAULT_SETTINGS;
  // An `nfx` that does not check out is replaced by the default one alone: NFX is always on here,
  // so the default is never "off".
  const nfxPatch: unknown = nfx === undefined ? {} : { nfx };
  const kept: Partial<Settings> = isSettingsPatch(nfxPatch) ? nfxPatch : { nfx: DEFAULT_NFX };
  return { ...DEFAULT_SETTINGS, ...rest, ...kept };
}

/** What is written: the fields a viewer sets, nothing fixed. */
function serialise(s: Settings): string {
  const settings: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) settings[k] = s[k];
  return JSON.stringify({ v: STORED_V, settings });
}

export interface SettingsStoreOptions {
  /** `null`: nothing persists (the settings live as long as the page). */
  readonly storage: SettingsStorage | null;
  /** Other tabs' writes; absent = this tab only. */
  readonly events?: StorageEventTarget | null | undefined;
}

export class SettingsStore {
  readonly #storage: SettingsStorage | null;
  readonly #events: StorageEventTarget | null;
  readonly #listeners = new Set<(next: Settings) => void>();
  #current: Settings = DEFAULT_SETTINGS;
  readonly #onStorage = (e: { readonly key: string | null }): void => {
    // `key` null: the storage was cleared (`clear()`), which is a change too.
    if (e.key !== null && e.key !== SETTINGS_KEY) return;
    const next = this.#read();
    if (serialise(next) === serialise(this.#current)) return;
    this.#current = next;
    this.#notify();
  };

  constructor(o: SettingsStoreOptions) {
    this.#storage = o.storage;
    this.#events = o.events ?? null;
    this.#current = this.#read();
    this.#events?.addEventListener('storage', this.#onStorage);
  }

  get(): Settings {
    return this.#current;
  }

  /**
   * Checks `patch` (`isSettingsPatch`), merges it and writes the result. Throws
   * `invalid-argument` for a patch this client refuses and `internal` when the browser refuses the
   * write; either way nothing changes.
   */
  update(patch: unknown): Settings {
    if (!isSettingsPatch(patch)) {
      throw new RuntimeAdapterError(
        'invalid-argument',
        'not a settings change this client accepts',
      );
    }
    const next: Settings = { ...this.#current, ...patch };
    if (this.#storage !== null) {
      try {
        this.#storage.setItem(SETTINGS_KEY, serialise(next));
      } catch {
        throw new RuntimeAdapterError('internal', 'the browser did not save the settings');
      }
    }
    this.#current = next;
    this.#notify();
    return next;
  }

  /** Every change: this tab's `update`s and other tabs' writes. */
  onChange(cb: (next: Settings) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  /** Stops hearing other tabs. */
  close(): void {
    this.#events?.removeEventListener('storage', this.#onStorage);
    this.#listeners.clear();
  }

  /** What storage holds now; with no storage, what this page holds. */
  #read(): Settings {
    if (this.#storage === null) return this.#current;
    let raw: string | null;
    try {
      raw = this.#storage.getItem(SETTINGS_KEY);
    } catch {
      raw = null;
    }
    return parseStoredSettings(raw);
  }

  #notify(): void {
    const now = this.#current;
    for (const l of [...this.#listeners]) {
      try {
        l(now);
      } catch {
        // One listener's failure is not the store's, nor the next listener's.
      }
    }
  }
}

/**
 * The page's store: `localStorage` when the page may use it (reading the property throws where
 * storage is blocked), memory otherwise; `storage` events from `win`.
 */
export function browserSettingsStore(win: Window): SettingsStore {
  let storage: SettingsStorage | null;
  try {
    storage = win.localStorage;
  } catch {
    storage = null;
  }
  return new SettingsStore({ storage, events: win });
}
