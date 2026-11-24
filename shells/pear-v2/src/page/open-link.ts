/**
 * Opening a link from this page. The runtime hands anything given to `window.open` to
 * `shell.openExternal` with no scheme check (S1), so nothing reaches it without passing the
 * renderer's own `externalLink` rule first: `https:`, no user-info, a public host. At most
 * `LINK_LIMIT` links per `LINK_WINDOW_MS`, so a page cannot bury the browser in tabs.
 */
import { externalLink } from '../../../../packages/renderer/src/links.js';

export const LINK_LIMIT = 5;
export const LINK_WINDOW_MS = 60_000;

/** The link as it may be opened, or `null`. A normalised link must pass the rule again. */
export function checkedLink(raw: unknown): string | null {
  try {
    const href = externalLink(raw);
    if (href === null) return null;
    return externalLink(href) === href ? href : null;
  } catch {
    return null;
  }
}

export function linkOpener(
  open: (url: string) => void,
  now: () => number = Date.now,
): (raw: unknown) => boolean {
  let asked: number[] = [];
  return (raw) => {
    const url = checkedLink(raw);
    if (url === null) return false;
    const t = now();
    asked = asked.filter((at) => t - at < LINK_WINDOW_MS);
    if (asked.length >= LINK_LIMIT) return false;
    asked.push(t);
    try {
      open(url);
      return true;
    } catch {
      return false;
    }
  };
}
