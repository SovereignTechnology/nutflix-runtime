/**
 * What main reads from the page, read only, in an isolated world of its own (the page's scripts
 * cannot see it). Nothing from the page is trusted beyond the three facts `parseProbe` accepts:
 * the renderer mounted, whether its WebRTC player is available (the renderer's own capability
 * probe: `RTCPeerConnection`, WebAssembly and `MediaSource`), and whether this Chromium can
 * decode the two codecs a video is likely to carry, which says what the packaged engine can
 * play. Whether a video plays needs a seeder and a relay, and is not asserted here (README).
 */

/** The page's side: null until `startRenderer` has run and rendered, and null after a failed start. */
export const PROBE_CODE =
  "(() => { const r = document.getElementById('root');" +
  ' if (r === null || r.dataset.webrtcPlayer === undefined || r.childElementCount === 0) return null;' +
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

/** The probe's answer as main will use it, or `null` when the renderer has not mounted. Never throws. */
export function parseProbe(x: unknown): Probe | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const player = o['player'];
  if (player !== 'available' && player !== 'unavailable') return null;
  return { player, vp9: o['vp9'] === true, h264: o['h264'] === true };
}
