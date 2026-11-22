/**
 * `shell.openExternal`, and the one rule in front of it. A viewer's click on a link reaches main
 * from the preload as a string; the renderer already applied its `externalLink` rule before it
 * called `nutflixOpenLink`, but a compromised renderer sends anything, so main applies the SAME
 * rule again (the function itself, not a copy) and opens only what it returns, `https:`, no
 * user-info, a public host, as the URL parser normalised it. The result must pass the rule again
 * (a normalisation never turns a refused link into an allowed one). At most `LINK_LIMIT` links
 * per `LINK_WINDOW_MS`: a page cannot bury the browser in tabs.
 *
 * Electron-free: `main.ts` passes `shell.openExternal`.
 */
import { externalLink } from '../../../../packages/renderer/src/links.ts';
import type { Fields } from './log.ts';

export const LINK_LIMIT = 5;
export const LINK_WINDOW_MS = 60_000;

/** The link as main will open it, or `undefined` when main may not. Never throws. */
export function checkedLink(raw: unknown): string | undefined {
  try {
    const href = externalLink(raw);
    if (href === null) return undefined;
    return externalLink(href) === href ? href : undefined;
  } catch {
    return undefined;
  }
}

export interface LinkOpenerDeps {
  open(url: string): void;
  now(): number;
  log(name: string, fields?: Fields): void;
}

export class LinkOpener {
  readonly #d: LinkOpenerDeps;
  #asked: number[] = [];

  constructor(d: LinkOpenerDeps) {
    this.#d = d;
  }

  /** A link from the app's own window. Never throws. */
  request(raw: unknown): boolean {
    const url = checkedLink(raw);
    if (url === undefined) {
      this.#d.log('link-refused');
      return false;
    }
    const now = this.#d.now();
    this.#asked = this.#asked.filter((t) => now - t < LINK_WINDOW_MS);
    if (this.#asked.length >= LINK_LIMIT) {
      this.#d.log('link-throttled');
      return false;
    }
    this.#asked.push(now);
    try {
      this.#d.open(url);
      this.#d.log('link-opened');
      return true;
    } catch {
      this.#d.log('link-open-failed');
      return false;
    }
  }
}
