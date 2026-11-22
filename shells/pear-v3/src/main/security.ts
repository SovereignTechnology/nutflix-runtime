/**
 * Window-level and process-level security controls. After nutflix-pear's `app-desktop/src/main/
 * security.ts` (the submodule's pinned commit); what differs is named in the comments.
 *
 *   - `hardenWebContents`, installed for EVERY webContents from `web-contents-created`:
 *     `window.open` is denied always; navigation, redirects and `<webview>` are cancelled (the app
 *     is one document; a programmatic `loadURL` does not emit these events);
 *   - `installSessionPolicy`: every permission denied except `fullscreen`, and that only for the
 *     top frame of `app://nutflix`; no device grants, no downloads, no spell-check downloads;
 *   - the switch policy: Chromium switches that turn the sandbox layers off, open a DevTools
 *     target, wrap or replace a child process, or switch features are refused (exit 78). The one
 *     exception is `--no-sandbox`, which is NOT refused here: ADR 0001 amendment, item 2 makes it
 *     a choice the user takes in a native warning (`sandbox-gate.ts`). The app never adds it.
 *
 * Structural types only (no runtime `electron` import), so the tests drive fakes.
 */
import { isAppOrigin, isAppUrl } from './schemes.ts';

/** The only permission the renderer may have (Watch fullscreen). */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['fullscreen']);

interface PreventableEvent {
  preventDefault(): void;
}

/** The `webContents` members `hardenWebContents` uses. */
export interface HardenableWebContents {
  setWindowOpenHandler(handler: (details: unknown) => { action: 'deny' }): void;
  on(
    event: 'will-navigate' | 'will-frame-navigate' | 'will-redirect' | 'will-attach-webview',
    listener: (event: PreventableEvent, ...rest: unknown[]) => void,
  ): unknown;
}

export function hardenWebContents(wc: HardenableWebContents): void {
  // A `window.open` is denied whatever it names. (nutflix-pear asks in a prompt window; this
  // shell has none: a clicked `https:` link reaches `shell.openExternal` only through the
  // preload's `nutflixOpenLink` and `external-links.ts`.)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const block = (e: PreventableEvent): void => {
    e.preventDefault();
  };
  wc.on('will-navigate', block);
  wc.on('will-frame-navigate', block);
  wc.on('will-redirect', block);
  wc.on('will-attach-webview', block);
}

export function allowPermissionRequest(
  permission: string,
  details: { readonly isMainFrame: boolean; readonly requestingUrl?: string | undefined },
): boolean {
  return (
    ALLOWED_PERMISSIONS.has(permission) &&
    details.isMainFrame &&
    isAppUrl(details.requestingUrl ?? '')
  );
}

export function allowPermissionCheck(
  permission: string,
  requestingOrigin: string,
  details: { readonly isMainFrame: boolean; readonly embeddingOrigin?: string | undefined },
): boolean {
  return (
    ALLOWED_PERMISSIONS.has(permission) &&
    details.isMainFrame &&
    details.embeddingOrigin === undefined &&
    isAppOrigin(requestingOrigin)
  );
}

/** The `session` members `installSessionPolicy` uses. */
export interface PolicySession {
  setPermissionRequestHandler(
    handler: (
      wc: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: { readonly isMainFrame: boolean; readonly requestingUrl?: string },
    ) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (
      wc: unknown,
      permission: string,
      requestingOrigin: string,
      details: { readonly isMainFrame: boolean; readonly embeddingOrigin?: string },
    ) => boolean,
  ): void;
  setDevicePermissionHandler(handler: () => boolean): void;
  setSpellCheckerEnabled(enabled: boolean): void;
  on(event: 'will-download', listener: (event: PreventableEvent) => void): unknown;
}

export function installSessionPolicy(ses: PolicySession): void {
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(allowPermissionRequest(permission, details));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) =>
    allowPermissionCheck(permission, origin, details),
  );
  ses.setDevicePermissionHandler(() => false);
  // Chromium's spell checker downloads dictionaries from a Google CDN; the window also sets
  // `spellcheck: false`.
  ses.setSpellCheckerEnabled(false);
  ses.on('will-download', (e) => {
    e.preventDefault();
  });
}

/**
 * Switches that turn a Chromium sandbox layer off, or run sandboxed code in the unsandboxed
 * browser process. Refused in EVERY build. `no-sandbox` is the one left out (see the header).
 * Every name is one of Chromium's (`sandbox/policy/switches.cc`, `content_switches.cc`), as in
 * nutflix-pear's list.
 */
export const SANDBOX_BYPASS_SWITCHES = [
  'disable-gpu-sandbox', // the GPU process
  'no-zygote', // renderers forked without the zygote, so without its sandbox
  'no-zygote-sandbox', // the zygote itself starts unsandboxed (Linux)
  'disable-seccomp-filter-sandbox', // no seccomp-bpf filter in renderers (Linux)
  'disable-namespace-sandbox', // no user/PID/network namespaces (Linux)
  'disable-setuid-sandbox', // no setuid helper (Linux)
  'disable-landlock-sandbox', // no Landlock layer (Linux)
  'allow-sandbox-debugging', // sandboxed children stay dumpable/ptrace-able by the same user
  'gpu-sandbox-allow-sysv-shm', // loosens the GPU sandbox policy
  'disable-webnn-compiler-sandbox', // the WebNN compiler process's sandbox
  'single-process', // the renderer runs inside the (unsandboxed) browser process
  'in-process-gpu', // the GPU code runs inside the browser process
] as const;

/**
 * Switches a PACKAGED build refuses: a DevTools-protocol target (the fuses close Node's
 * `--inspect`, not these), a wrapper around or replacement of a child process, V8 flags, and
 * the other ways to switch Chromium features or its same-origin policy.
 */
export const PACKAGED_REFUSED_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'renderer-cmd-prefix',
  'utility-cmd-prefix',
  'gpu-launcher',
  'zygote-cmd-prefix',
  'browser-subprocess-path',
  'js-flags',
  'disable-site-isolation-trials',
  'disable-web-security',
  'enable-blink-features',
  'disable-blink-features',
  'force-fieldtrials',
  'force-fieldtrial-params',
] as const;

/** The only Chromium features a packaged build lets a launcher switch (Wayland users need them). */
export const PACKAGED_ALLOWED_FEATURES = ['UseOzonePlatform', 'WaylandWindowDecorations'] as const;

const FEATURE_LIST_SWITCHES = ['enable-features', 'disable-features'] as const;
/** One switch as it may appear in argv: `--name=value`, `-name=value`, `/name=value` (Windows). */
const FEATURE_ARG = /^(?:--?|\/)(enable-features|disable-features)(?:=([\s\S]*))?$/i;

interface CommandLine {
  hasSwitch(name: string): boolean;
  getSwitchValue(name: string): string;
}

/** The first switch (or feature) this build refuses, or `undefined`. `packaged` adds the packaged-only list. */
export function refusedSwitch(
  commandLine: CommandLine,
  argv: readonly string[],
  packaged: boolean,
): string | undefined {
  const names: readonly string[] = packaged
    ? [...SANDBOX_BYPASS_SWITCHES, ...PACKAGED_REFUSED_SWITCHES]
    : SANDBOX_BYPASS_SWITCHES;
  const hit = names.find((s) => commandLine.hasSwitch(s));
  if (hit !== undefined) return hit;
  if (!packaged) return undefined;
  // Fails closed: each comma-separated entry must be exactly an allowed name, so a field-trial
  // suffix, a `*` default override or an empty name is refused. Every occurrence in argv is read
  // as well as the value Chromium reports, so a repeated switch cannot hide a name.
  const values: string[] = [];
  for (const sw of FEATURE_LIST_SWITCHES)
    if (commandLine.hasSwitch(sw)) values.push(commandLine.getSwitchValue(sw));
  for (const a of argv) {
    const m = FEATURE_ARG.exec(a);
    if (m !== null) values.push(m[2] ?? '');
  }
  const allowed: readonly string[] = PACKAGED_ALLOWED_FEATURES;
  for (const v of values)
    for (const entry of v.split(',')) {
      const name = entry.trim();
      if (!allowed.includes(name)) return `features:${name === '' ? '(empty)' : name}`;
    }
  return undefined;
}
