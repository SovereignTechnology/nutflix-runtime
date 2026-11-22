/**
 * The renderer's settings checks: what a `Partial<Settings>` patch may hold here. Adapted from
 * nutflix-pear's `packages/app-web/src/settings/validate.ts` (the submodule's pinned commit),
 * itself the web counterpart of the desktop app's `isSettingsPatch`. The URL rules are the desktop
 * guards' own, so a relay one app accepts the other does too. Differences from the web's:
 *
 * - **NFX is always on**, on the one network this build speaks, with no iroh relays, and no
 *   signaling relays yet (the WebRTC player is slice B, which adds `meshRelays` here).
 * - **No wallet, seeding or auto top-up** fields: there is none to set (`defaultMints`, `seeding`,
 *   `autoTopUp` are refused).
 * - **`loadRemoteImages` stays `false`**: only images whose sha256 their publisher signed are
 *   shown, so a patch turning it on is refused.
 *
 * Every guard is total: anything that is not exactly the expected shape is `false`, never an
 * exception (a hostile getter or Proxy included). Objects must be plain with no unknown keys;
 * optional keys are absent, never `undefined`. Strings and arrays have caps.
 */
import type { NfxSettings, RelayConfig, RelayUrl, Settings } from '@sovit/core';

import { NFX_NETWORK } from './defaults.js';

type Guard<T> = (x: unknown) => x is T;

/** Relay and server URLs: the desktop's `LIMITS.maxServerUrl`, Settings' `MAX_URL_LENGTH`. */
export const MAX_SERVER_URL = 512;
/** Read relays (the desktop's `LIMITS.maxArray`). */
export const MAX_RELAYS = 256;
/** NFX-04 scoped relays (contracts' `MAX_NFX_SCOPED_RELAYS`). */
export const MAX_SCOPED_RELAYS = 8;
/** Prefetch depth ceiling, seconds (the desktop's `LIMITS.maxPrefetchSec`). */
export const MAX_PREFETCH_SEC = 600;

function safe<T>(g: Guard<T>): Guard<T> {
  return (x: unknown): x is T => {
    try {
      return g(x);
    } catch {
      return false;
    }
  };
}

function isPlainObject(x: unknown): x is Readonly<Record<string, unknown>> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto: unknown = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** An exact-keys plain object: `req` present and valid, `opt` absent or valid, nothing else. */
function obj<T>(
  req: Readonly<Record<string, Guard<unknown>>>,
  opt: Readonly<Record<string, Guard<unknown>>> = {},
): Guard<T> {
  const known = new Set([...Object.keys(req), ...Object.keys(opt)]);
  return (x): x is T => {
    if (!isPlainObject(x)) return false;
    for (const k of Object.keys(x)) if (!known.has(k)) return false;
    for (const [k, g] of Object.entries(req)) if (!hasOwn(x, k) || !g(x[k])) return false;
    for (const [k, g] of Object.entries(opt)) if (hasOwn(x, k) && !g(x[k])) return false;
    return true;
  };
}

/** A dense array of at most `max` elements, each passing `g`. */
function arrayOf<T>(g: Guard<T>, max: number): Guard<readonly T[]> {
  return (x): x is readonly T[] => {
    if (!Array.isArray(x) || x.length > max) return false;
    for (const v of x as readonly unknown[]) if (!g(v)) return false;
    return true;
  };
}

function unique<T>(g: Guard<readonly T[]>): Guard<readonly T[]> {
  return (x): x is readonly T[] => g(x) && new Set(x).size === x.length;
}

const bool: Guard<boolean> = (x): x is boolean => typeof x === 'boolean';

function matches(re: RegExp): Guard<string> {
  return (x): x is string => typeof x === 'string' && x.length <= MAX_SERVER_URL && re.test(x);
}

// ---- URLs: the desktop guards' grammar ------------------------------------------------------

const LABEL = '[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?';
const HOST = `(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9A-Fa-f:.]{2,45}\\])`;
const PORT = '(?::[0-9]{1,5})?';
const PCHAR = "[A-Za-z0-9\\-._~!$&'()*+,;=:@%]";
const PATH_NO_TRAILING = `(?:/[A-Za-z0-9\\-._~!$&'()*+,;=:@%/]*${PCHAR})?`;
const QUERY = "(?:\\?[A-Za-z0-9\\-._~!$&'()*+,;=:@%/?]*)?";
const RELAY_RE = new RegExp(`^[Ww][Ss][Ss]://${HOST}${PORT}${PATH_NO_TRAILING}${QUERY}$`);
const LOOPBACK_WS_RE = new RegExp(
  `^[Ww][Ss]://(?:127\\.0\\.0\\.1|\\[::1\\]|localhost)${PORT}${PATH_NO_TRAILING}$`,
);
/** A read relay: `wss://`, no user-info or fragment, no trailing slash. */
export const isRelayUrl = safe(matches(RELAY_RE)) as Guard<RelayUrl>;

/** An NFX-04 scoped relay: as `isRelayUrl`, or `ws://` to a loopback address (a local node). */
export const isScopedRelayUrl = safe(
  (x: unknown): x is string => isRelayUrl(x) || matches(LOOPBACK_WS_RE)(x),
) as Guard<RelayUrl>;

const isRelayConfig = obj<RelayConfig>({ url: isRelayUrl, read: bool, write: bool });

/** NFX here: always on, one network, no iroh relays and no signaling relays (yet). */
const isRuntimeNfx = obj<NfxSettings>({
  enabled: (x): x is true => x === true,
  network: (x): x is string => x === NFX_NETWORK,
  scopedRelays: unique(arrayOf(isScopedRelayUrl, MAX_SCOPED_RELAYS)),
});

/** The fields a viewer sets; every other `Settings` field is fixed. */
export const SETTING_KEYS = [
  'relays',
  'prefetchSeconds',
  'hoverPreview',
  'theme',
  'nfx',
  'loadRemoteImages',
] as const;

const isPatch = obj<Partial<Settings>>(
  {},
  {
    relays: arrayOf(isRelayConfig, MAX_RELAYS),
    prefetchSeconds: (x): x is number =>
      typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_PREFETCH_SEC,
    hoverPreview: bool,
    theme: (x): x is Settings['theme'] => x === 'dark' || x === 'light' || x === 'system',
    nfx: isRuntimeNfx,
    // Only signed images, so the only value is the one it already has.
    loadRemoteImages: (x): x is false => x === false,
  },
);

/** True when `patch` is a `Partial<Settings>` this renderer accepts. */
export const isSettingsPatch: Guard<Partial<Settings>> = safe(isPatch);
