/**
 * ADR 0001 amendment, item 3: without FUSE the app still starts, and says how to start faster.
 * The patched AppImage runtime (`packaging/appimage-runtime/`) sets `NUTFLIX_APPIMAGE_NO_FUSE=1`
 * when it had to extract the app. The notice is fixed text, blocks nothing, goes away by itself,
 * and is shown once per version: the extraction is kept, so later starts are not slow.
 */
export const FUSE_NOTICE_ENV = 'NUTFLIX_APPIMAGE_NO_FUSE';
export const FUSE_NOTICE_FILE = 'fuse-notice-seen';
export const FUSE_NOTICE_MS = 20_000;
export const FUSE_NOTICE_TEXT =
  'Nutflix could not use FUSE on this system, so it runs from an unpacked copy. For faster startup, install your system’s fuse3 package.';

export function shouldShowFuseNotice(
  env: string | undefined,
  seen: string | null,
  version: string,
): boolean {
  return env === '1' && seen?.trim() !== version;
}

/** Runs in main's isolated world. Set through the CSSOM: the page's policy has no inline style. */
export function fuseNoticeCode(): string {
  return `(() => {
    if (document.getElementById('nutflix-fuse-notice') !== null) return true;
    const n = document.createElement('div');
    n.id = 'nutflix-fuse-notice';
    n.setAttribute('role', 'status');
    n.textContent = ${JSON.stringify(FUSE_NOTICE_TEXT)};
    const s = n.style;
    s.position = 'fixed'; s.right = '16px'; s.bottom = '16px'; s.zIndex = '2147483646';
    s.maxWidth = 'min(420px, calc(100vw - 32px))'; s.padding = '10px 14px'; s.borderRadius = '8px';
    s.background = '#1f2937'; s.color = '#ffffff'; s.font = '13px system-ui, sans-serif';
    s.pointerEvents = 'none';
    document.body.appendChild(n);
    setTimeout(() => { n.remove(); }, ${String(FUSE_NOTICE_MS)});
    return document.getElementById('nutflix-fuse-notice') !== null;
  })()`;
}
