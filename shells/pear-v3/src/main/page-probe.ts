/**
 * What main reads from the page, read only, in an isolated world of its own (the page's scripts
 * cannot see it). Nothing from the page is trusted beyond the three facts `parseProbe` accepts:
 * the renderer mounted and its own `status` came back through the preload, main's gate and the
 * worker (no answer until then), whether its WebRTC player is available (the renderer's own capability
 * probe: `RTCPeerConnection`, WebAssembly and `MediaSource`), and whether this Chromium can
 * decode the two codecs a video is likely to carry, which says what the packaged engine can
 * play. Whether a video plays needs a seeder and a relay, and is not asserted here (README).
 */

/** Which part of the page's start is missing, read once when `PROBE_CODE` never answered. */
export const NOT_MOUNTED_CODE =
  "(() => { const r = document.getElementById('root');" +
  " if (r === null) return { root: false, children: 0, player: 'none', workerLink: 'none' };" +
  ' return { root: true, children: r.childElementCount,' +
  " player: r.dataset.webrtcPlayer ?? 'none', workerLink: r.dataset.workerLink ?? 'none' }; })()";

/** The page's side: null until `startRenderer` has run and rendered, and null after a failed start. */
export const PROBE_CODE =
  "(() => { const r = document.getElementById('root');" +
  ' if (r === null || r.dataset.webrtcPlayer === undefined || r.childElementCount === 0) return null;' +
  " if (r.dataset.workerLink !== 'up') return null;" +
  " if ((r.textContent ?? '').startsWith('Nutflix could not start')) return null;" +
  " const ok = (t) => typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(t);" +
  ' return { player: r.dataset.webrtcPlayer,' +
  ' vp9: ok(\'video/mp4; codecs="vp09.00.10.08"\'),' +
  ' h264: ok(\'video/mp4; codecs="avc1.42E01E"\') }; })()';

export interface Probe {
  readonly player: 'available' | 'unavailable';
  readonly vp9: boolean;
  readonly h264: boolean;
}

export interface NotMounted {
  readonly root: boolean;
  readonly children: number;
  readonly player: 'available' | 'unavailable' | 'none';
  readonly workerLink: 'up' | 'down' | 'none';
}

/** `NOT_MOUNTED_CODE`'s answer as fixed values for the log: the page chooses none of the text. */
export function parseNotMounted(x: unknown): NotMounted {
  const o = typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : {};
  const { player, workerLink, children } = o;
  return {
    root: o['root'] === true,
    children: typeof children === 'number' && Number.isSafeInteger(children) ? children : 0,
    player: player === 'available' || player === 'unavailable' ? player : 'none',
    workerLink: workerLink === 'up' || workerLink === 'down' ? workerLink : 'none',
  };
}

/** The probe's answer as main will use it, or `null` when the renderer has not mounted. Never throws. */
export function parseProbe(x: unknown): Probe | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const player = o['player'];
  if (player !== 'available' && player !== 'unavailable') return null;
  return { player, vp9: o['vp9'] === true, h264: o['h264'] === true };
}
