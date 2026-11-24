/**
 * The page's loopback port, the same on every launch of the same app. The page's origin includes
 * the port, and its settings live in that origin's storage, so a port picked at random would lose
 * the viewer's settings at each start. A port that is taken moves to the next, and after
 * `PAGE_PORT_TRIES` the shell takes any free one: that launch then starts from first-run settings,
 * which in this shape means WebRTC off.
 */
export const PAGE_PORT_MIN = 49152;
export const PAGE_PORT_SPAN = 16384;
export const PAGE_PORT_TRIES = 8;

/** The app's key when `link` is a `pear://` link (any version of it), else the link itself. */
function appIdentity(link: string): string {
  return /^pear:\/\/(?:\d+\.\d+\.)?([a-z0-9]{52})(?:\/|$)/.exec(link)?.[1] ?? link;
}

/** FNV-1a over the identity: a spread, not a secret. */
export function pagePort(link: string, attempt = 0): number {
  let h = 0x811c9dc5;
  for (const c of appIdentity(link)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return PAGE_PORT_MIN + (((h >>> 0) + attempt) % PAGE_PORT_SPAN);
}
