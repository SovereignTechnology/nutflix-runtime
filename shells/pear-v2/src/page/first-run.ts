/**
 * WebRTC starts OFF in this shape. Shape (a) sets `webRTCIPHandlingPolicy` so that a peer sees one
 * public address; this runtime cannot set it (ADR 0001 decision 5), so a peer could also learn
 * the addresses of every local interface, LAN and VPN included.
 *
 * The renderer reads "absent" as on, so unless the viewer's stored settings already say `webrtc`
 * in a form the renderer accepts, this writes `false` before the renderer starts. A viewer who
 * turns it on in Settings stores `true`, which is kept.
 */
import { DEFAULT_NFX } from '../../../../packages/renderer/src/settings/defaults.js';
import {
  SETTINGS_KEY,
  parseStoredSettings,
  type SettingsStorage,
} from '../../../../packages/renderer/src/settings/store.js';
import { SETTING_KEYS } from '../../../../packages/renderer/src/settings/validate.js';

export type FirstRun = 'kept' | 'written' | 'no-storage';

/** `storage` is a function because merely reading `localStorage` can throw. */
export function webrtcOffUnlessChosen(storage: () => SettingsStorage): FirstRun {
  try {
    const store = storage();
    const raw = store.getItem(SETTINGS_KEY);
    const parsed = parseStoredSettings(raw);
    // The renderer falls back to the very `DEFAULT_NFX` object (WebRTC on) for anything it refuses,
    // so a choice counts only when it read a stored `nfx` of its own and that names `webrtc`.
    if (parsed.nfx !== DEFAULT_NFX && typeof parsed.nfx?.webrtc === 'boolean') return 'kept';
    const settings: Record<string, unknown> = {};
    for (const k of SETTING_KEYS) settings[k] = parsed[k];
    settings['nfx'] = { ...(parsed.nfx ?? DEFAULT_NFX), webrtc: false };
    store.setItem(SETTINGS_KEY, JSON.stringify({ v: 1, settings }));
    return 'written';
  } catch {
    return 'no-storage';
  }
}

/**
 * With no storage the renderer keeps its defaults in memory, and its default is WebRTC on, so the
 * off switch cannot be written. This takes WebRTC out of the page instead: the renderer's probe
 * then finds no `RTCPeerConnection` and every video plays over HyperDHT alone.
 */
export function removeWebRtc(g: object): void {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection'])
    Object.defineProperty(g, name, { value: undefined, configurable: false, writable: false });
}
