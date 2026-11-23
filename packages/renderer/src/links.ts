/**
 * Where a URL from anywhere may lead (ADR 0001 amendment, item 1): the one gate every remote URL
 * passes before anything may open it, and the guard that keeps a click on a remote link from
 * navigating the window.
 *
 * - **`externalLink`** is `https:` only, no user-info, nothing the URL parser would rewrite, a
 *   public host (`isPublicHost`). Everything else is not a link.
 * - **`installLinkGuard`** stops every anchor click in the document (the default action is what
 *   a runtime may hand to `shell.openExternal` with no scheme check, S1) and passes an `https:`
 *   link on to `open`, when the shell gave the renderer one. Without `open`, a link does nothing.
 *   Nothing in this package calls `window.open` or sets `location` (an ESLint rule refuses both).
 * - **`isWorkerMediaUrl`** is what the worker's `progressiveUrl` must look like before it is
 *   given to a `<video>`: `http://127.0.0.1:<port>/<token>/<sid>`, nothing else.
 * - **`isWorkerOriginUrl`** is what the worker's `originUrl` must look like before nfx's player
 *   may fetch from it: `http://127.0.0.1:<port>/<token>`, nothing else.
 */
import { isPublicHost, parseStrictUrl } from './net/hosts.js';

/** A link longer than this is not followed. */
export const MAX_LINK_LENGTH = 2048;

/** `raw` as an `https:` link this client may hand to the shell, or `null`. */
export function externalLink(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const u = parseStrictUrl(raw, MAX_LINK_LENGTH);
  if (u?.protocol !== 'https:') return null;
  if (!isPublicHost(u.hostname)) return null;
  return u.href;
}

/** The worker's loopback media URL: `http://127.0.0.1:<port>/<hex token>/<hex sid>`. */
const WORKER_MEDIA = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[0-9a-f]{32}\/[0-9a-f]{32}$/;

export function isWorkerMediaUrl(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length <= MAX_LINK_LENGTH && WORKER_MEDIA.test(raw);
}

/** The worker's loopback NFX origin base: `http://127.0.0.1:<port>/<hex token>`. */
const WORKER_ORIGIN = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[0-9a-f]{32}$/;

export function isWorkerOriginUrl(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length <= MAX_LINK_LENGTH && WORKER_ORIGIN.test(raw);
}

/** The part of a document the guard listens on. */
export interface LinkGuardTarget {
  addEventListener(type: 'click' | 'auxclick', l: (e: MouseEvent) => void, capture: true): void;
  removeEventListener(type: 'click' | 'auxclick', l: (e: MouseEvent) => void, capture: true): void;
}

/** The anchor `target` is in (or is), if any. */
function anchorOf(target: EventTarget | null): HTMLAnchorElement | null {
  const el = target as Element | null;
  if (el === null || typeof el.closest !== 'function') return null;
  return el.closest('a');
}

/**
 * Cancels every anchor click (left, middle and the rest) in the capture phase, before any
 * handler or the browser's own default, and offers an `https:` link to `open`. Returns the undo.
 */
export function installLinkGuard(doc: LinkGuardTarget, open?: (url: string) => void): () => void {
  const onClick = (e: MouseEvent): void => {
    const a = anchorOf(e.target);
    if (a === null) return;
    e.preventDefault();
    // The `href` attribute as written, not the resolved property: a relative link is no link.
    const link = externalLink(a.getAttribute('href'));
    if (link === null || open === undefined) return;
    // A left click or the context's primary activation only: a middle click opens nothing.
    if (e.type === 'click') {
      try {
        open(link);
      } catch {
        // The shell's own failure is its own.
      }
    }
  };
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('auxclick', onClick, true);
  return () => {
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('auxclick', onClick, true);
  };
}
