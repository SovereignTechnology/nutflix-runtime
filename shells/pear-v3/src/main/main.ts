/**
 * Electron main, the Pear v3 shell: lifecycle, the one window, the security handlers, the `app:`
 * protocol, the gate in front of the worker, and the worker itself. This is the only module that
 * imports `electron` at runtime; everything it wires is Electron-free and unit-tested with fakes.
 *
 * Layout it expects (the stage step, `packaging/stage.ts`, writes it; Forge copies it to
 * `resources/app/`, unpacked: `pear-runtime` spawns Bare from real file paths, so no asar):
 *   main/main.cjs, main/preload.cjs     this bundle and the preload
 *   renderer/                           index.html, app.js, ui.css, shell.css (served by `app:`)
 *   node_modules/                       the runtime closure: pear-runtime, bare-sidecar and the
 *                                       worker (`@nutflix-runtime/worker`) with its dependencies
 *
 * Updates: this file constructs no `PearRuntime` and cannot apply anything. A build packaged with
 * an upgrade link starts one more Bare process, the updater (`src/update/update-worker.ts`), which
 * holds the gate; main only passes its checked status to the window. A build without a link, as
 * every shipped build is until a real link exists, starts nothing (README, "Updates").
 */
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
  webContents,
  type IpcMainEvent,
  type WebContents,
} from 'electron';

import {
  OPEN_LINK,
  PIPE_CLOSE,
  PIPE_DATA,
  PIPE_WRITE,
  SANDBOX_PREFLIGHT_SWITCH,
} from '../shared/ids.ts';
import {
  UPDATE_BANNER_ID,
  updateBannerText,
} from '../../../../packages/renderer/src/update-text.ts';
import type { UpdateStatus } from '../update/status.ts';
import { createAppProtocolHandler } from './app-protocol.ts';
import { headerPolicy } from './csp.ts';
import { LinkOpener } from './external-links.ts';
import {
  FUSE_NOTICE_ENV,
  FUSE_NOTICE_FILE,
  fuseNoticeCode,
  shouldShowFuseNotice,
} from './fuse-notice.ts';
import { event, readyLine } from './log.ts';
import { PROBE_CODE, parseProbe, type Probe } from './page-probe.ts';
import { MAIN_WINDOW_POLICY, RpcGate } from './rpc-gate.ts';
import {
  BANNER_TEXT,
  CONSENT_FILE,
  FORGET_SWITCH,
  WARNING,
  parseConsent,
  sandboxGate,
} from './sandbox-gate.ts';
import { fromMetrics, fromProcStatus, type RendererSandbox } from './sandbox-proof.ts';
import { APP_SCHEME, APP_URL, isAppUrl, privilegedSchemes } from './schemes.ts';
import { hardenWebContents, installSessionPolicy, refusedSwitch } from './security.ts';
import { installedApp, startUpdater } from './update-proc.ts';
import { startWorker, type WorkerHandle } from './worker-proc.ts';
import { WEBRTC_IP_POLICY, createMainWindow } from './window.ts';

/** Replaced by the bundler (`packaging/stage.ts`): this build was packaged with an upgrade link. */
declare const __NUTFLIX_UPDATES__: boolean;

/** `resources/app` (the staged tree): this file is `<app>/main/main.cjs`. */
const appDir = join(__dirname, '..');
const WORKER_ENTRY = join(appDir, 'node_modules', '@nutflix-runtime', 'worker', 'dist', 'main.js');
const UPDATE_ENTRY = join(appDir, 'main', 'update-worker.cjs');
const PKG = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as { version: string };

/** Chromium's own `--user-data-dir` wins when given; otherwise one stable directory for this app. */
if (!app.commandLine.hasSwitch('user-data-dir'))
  app.setPath('userData', join(app.getPath('appData'), 'nutflix-runtime'));
const consentFile = join(app.getPath('userData'), CONSENT_FILE);

// ---- before ready ------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged(privilegedSchemes());

// A packaged build's argv is `[exe, ...args]`; the default app's is `[electron, app, ...args]`.
const userArgv = process.argv.slice(app.isPackaged ? 1 : 2);

const refused = refusedSwitch(app.commandLine, userArgv, app.isPackaged);
if (refused !== undefined) {
  // Never a run with a sandbox layer off (other than the one the user chose), a debugger
  // attached, or a child process wrapped. 78 is EX_CONFIG.
  event('refused-switch', { switch: refused.slice(0, 64) });
  app.exit(78);
  throw new Error('a refused switch is on the command line');
}

// ---- state -------------------------------------------------------------------------------

const windowIds = new Set<number>();
let worker: WorkerHandle | undefined;
let updater: WorkerHandle | undefined;
let lastUpdate: UpdateStatus | undefined;
let mainWindow: BrowserWindow | undefined;
let unsandboxed = false;

const sendTo = (id: number, channel: string, ...args: unknown[]): void => {
  const wc = webContents.fromId(id);
  if (wc !== undefined && !wc.isDestroyed()) wc.send(channel, ...args);
};

const gate = new RpcGate({
  toWorker: (frame) => {
    if (worker === undefined) throw new Error('no worker');
    worker.write(frame);
  },
  toWindow: (id, frame) => {
    sendTo(id, PIPE_DATA, frame);
  },
  closeWindow: (id) => {
    sendTo(id, PIPE_CLOSE);
  },
});

const links = new LinkOpener({
  open: (url) => {
    shell.openExternal(url).catch(() => {
      event('link-open-failed');
    });
  },
  now: () => Date.now(),
  log: (name) => {
    event(name);
  },
});

/** An IPC message is the app's only if it came from the top frame of a window main made, at `app://nutflix`. */
function fromAppTopFrame(e: IpcMainEvent): boolean {
  const f = e.senderFrame;
  return f !== null && f === e.sender.mainFrame && isAppUrl(f.url) && windowIds.has(e.sender.id);
}

ipcMain.on(PIPE_WRITE, (e, bytes: unknown) => {
  if (fromAppTopFrame(e)) gate.fromWindow(e.sender.id, bytes);
});
ipcMain.on(OPEN_LINK, (e, url: unknown) => {
  if (fromAppTopFrame(e)) links.request(url);
});

app.on('web-contents-created', (_e, wc: WebContents) => {
  hardenWebContents(wc);
});
app.on('second-instance', () => {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});
app.on('window-all-closed', () => {
  app.quit();
});
// `stop` kills the worker, so a quit first gives it time to finish each `nfx.play.close`: that is
// what deletes the temporary files of the video being watched.
const QUIT_GRACE_MS = 3000;
let quitReady = false;
app.on('before-quit', (e) => {
  if (quitReady || worker === undefined) return;
  e.preventDefault();
  quitReady = true;
  mainWindow?.hide();
  for (const id of [...windowIds]) gate.detach(id);
  void gate.drained(QUIT_GRACE_MS).finally(() => {
    app.quit();
  });
});
app.on('will-quit', () => {
  updater?.stop();
  worker?.stop();
});

// ---- start ---------------------------------------------------------------------------------

if (app.commandLine.hasSwitch(SANDBOX_PREFLIGHT_SWITCH)) {
  // Chromium started its sandbox, or this line would not run. That was the whole question.
  app.exit(0);
} else if (app.commandLine.hasSwitch(FORGET_SWITCH)) {
  void rm(consentFile, { force: true }).then(
    () => {
      event('sandbox-choice-forgotten');
      app.exit(0);
    },
    () => {
      event('sandbox-choice-not-forgotten');
      app.exit(1);
    },
  );
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main().catch((e: unknown) => {
    // A policy that is not strict, a missing file: fail closed and say so, never a silent hang.
    event('startup-failed', { error: e instanceof Error ? e.name : 'unknown' });
    app.exit(1);
  });
}

// ---- the run -----------------------------------------------------------------------------

async function main(): Promise<void> {
  await app.whenReady();
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
      : null,
  );

  // The page's policy is the renderer's own, read from the file the protocol serves.
  const rendererDir = join(appDir, 'renderer');
  const csp = headerPolicy(readFileSync(join(rendererDir, 'index.html'), 'utf8'));
  installSessionPolicy(session.defaultSession);
  protocol.handle(
    APP_SCHEME,
    createAppProtocolHandler({
      root: rendererDir,
      csp,
      readFile: (p) => readFile(p),
      realpath: (p) => realpath(p),
    }),
  );

  // ADR 0001 amendment, item 2: before any window, and before the worker.
  const outcome = sandboxGate({
    noSandbox: app.commandLine.hasSwitch('no-sandbox'),
    readConsent: () => {
      try {
        return parseConsent(readFileSync(consentFile, 'utf8'));
      } catch {
        return null;
      }
    },
    writeConsent: (c) => {
      void writeFile(consentFile, `${JSON.stringify(c)}\n`, { mode: 0o600 }).catch(() => {
        event('sandbox-choice-not-stored');
      });
    },
    ask: () =>
      dialog.showMessageBoxSync({
        type: 'warning',
        title: WARNING.title,
        message: WARNING.message,
        detail: WARNING.detail,
        buttons: [...WARNING.buttons],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }) === 1
        ? 'run-anyway'
        : 'quit',
    now: () => new Date(),
    log: (name, fields) => {
      event(name, fields);
    },
  });
  if (!outcome.run) {
    app.quit();
    return;
  }
  unsandboxed = !outcome.sandboxed;

  const state: {
    window: boolean;
    renderer: Probe | null;
    worker: boolean;
    printed: boolean;
  } = { window: false, renderer: null, worker: false, printed: false };
  const maybeReady = (): void => {
    const probe = state.renderer;
    if (state.printed || !state.window || probe === null || !state.worker) return;
    state.printed = true;
    readyLine({
      shell: 'pear-v3',
      version: PKG.version,
      window: 'loaded',
      renderer: 'mounted',
      worker: 'status-ok',
      sandbox: unsandboxed ? 'off' : 'on',
      pipe: 'round-trip',
      rendererSandbox:
        mainWindow === undefined ? 'unknown' : rendererSandbox(mainWindow.webContents),
      player: probe.player,
      vp9: probe.vp9,
      h264: probe.h264,
      updates: __NUTFLIX_UPDATES__ ? 'on' : 'off',
    });
  };

  // The worker, then `init` (the storage directory is main's, never the renderer's), then a
  // `status` of main's own.
  try {
    const PearRuntime = (await import('pear-runtime')).default;
    worker = startWorker({
      entry: WORKER_ENTRY,
      run: (entry, args) => PearRuntime.run(entry, args),
      gate,
      log: (name, fields) => {
        event(name, fields);
      },
    });
  } catch {
    event('worker-start-failed');
    app.exit(1);
    return;
  }
  void (async (): Promise<void> => {
    try {
      await gate.request('init', { v: 1, storage: join(app.getPath('userData'), 'worker') });
      await gate.request('status', {}, 30_000);
      state.worker = true;
      maybeReady();
    } catch {
      event('worker-init-failed');
    }
  })();

  const win = createMainWindow(BrowserWindow, join(__dirname, 'preload.cjs'));
  mainWindow = win;
  const id = win.webContents.id;
  windowIds.add(id);
  gate.attach(id, MAIN_WINDOW_POLICY);
  win.on('closed', () => {
    windowIds.delete(id);
    gate.detach(id);
    mainWindow = undefined;
  });
  win.once('ready-to-show', () => {
    win.show();
  });
  win.webContents.setWebRTCIPHandlingPolicy(WEBRTC_IP_POLICY);
  if (unsandboxed) win.setTitle('Nutflix (NO SANDBOX)');
  win.webContents.on('did-fail-load', (_e, code) => {
    event('window-load-failed', { code });
  });
  win.webContents.on('did-finish-load', () => {
    if (!isAppUrl(win.webContents.getURL())) return;
    state.window = true;
    if (unsandboxed) void injectBanner(win.webContents);
    if (lastUpdate !== undefined) showUpdate(lastUpdate);
    void showFuseNotice(win.webContents);
    void untilMounted(win.webContents).then((probe) => {
      if (probe !== null) {
        state.renderer = probe;
        maybeReady();
      } else {
        event('renderer-not-mounted');
      }
    });
  });
  void win.loadURL(APP_URL);
  if (__NUTFLIX_UPDATES__) await startUpdates();
}

// ---- the updater (a build with an upgrade link only) ----------------------------------------

async function startUpdates(): Promise<void> {
  const installed = installedApp({
    platform: process.platform,
    arch: process.arch,
    execPath: process.execPath,
    appImage: process.env['APPIMAGE'],
    windowsStore: process.windowsStore,
    productName: 'Nutflix',
  });
  if (installed === null) {
    // Run from an unpacked directory: there is no installed app to swap.
    event('update-not-installed');
    return;
  }
  try {
    const PearRuntime = (await import('pear-runtime')).default;
    updater = startUpdater({
      entry: UPDATE_ENTRY,
      run: (entry, args) => PearRuntime.run(entry, args),
      start: {
        dir: join(app.getPath('userData'), 'update'),
        version: PKG.version,
        ...installed,
      },
      onStatus: (s) => {
        lastUpdate = s;
        event('update', { ...s });
        showUpdate(s);
      },
      log: (name, fields) => {
        event(name, fields);
      },
    });
  } catch {
    event('update-worker-start-failed');
  }
}

/** To the window, through the gate's allow-list; then proves the window shows it. */
function showUpdate(s: UpdateStatus): void {
  gate.fromMain('update', { state: s.state });
  const text = updateBannerText(s.state);
  if (text !== null && mainWindow !== undefined)
    void confirmUpdateShown(mainWindow.webContents, s.state, text);
}

async function confirmUpdateShown(wc: WebContents, state: string, text: string): Promise<void> {
  const code = `(() => {
    const e = document.getElementById(${JSON.stringify(UPDATE_BANNER_ID)});
    return e === null ? null : { state: e.dataset.updateState, text: e.textContent };
  })()`;
  for (let i = 0; i < 40; i++) {
    if (wc.isDestroyed()) return;
    try {
      const r = (await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code }])) as {
        state?: unknown;
        text?: unknown;
      } | null;
      if (r !== null && r.state === state && r.text === text) {
        event('update-shown', { state });
        return;
      }
    } catch {
      // The page is between documents; try again.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  event('update-not-shown', { state });
}

/** What the OS is doing to this window's renderer (`sandbox-proof.ts`). */
function rendererSandbox(wc: WebContents): RendererSandbox {
  const pid = wc.getOSProcessId();
  if (process.platform !== 'linux') return fromMetrics(app.getAppMetrics(), pid);
  try {
    return fromProcStatus(readFileSync(`/proc/${String(pid)}/status`, 'utf8'));
  } catch {
    return 'unknown';
  }
}

// ---- reading the page (read only, in an isolated world) ----------------------------------------

/** A world of our own: the page's scripts cannot see what runs here. */
const ISOLATED_WORLD = 2000;

/**
 * The page's probe once the renderer has mounted (`page-probe.ts`), or null after 60 s. Polled,
 * read only.
 */
async function untilMounted(wc: WebContents): Promise<Probe | null> {
  for (let i = 0; i < 240; i++) {
    if (wc.isDestroyed()) return null;
    try {
      const r: unknown = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [
        { code: PROBE_CODE },
      ]);
      const probe = parseProbe(r);
      if (probe !== null) return probe;
    } catch {
      // The page is between documents; try again.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

let fuseNoticeDone = false;

/** Once per version, on a run the AppImage runtime had to extract (`fuse-notice.ts`). */
async function showFuseNotice(wc: WebContents): Promise<void> {
  if (fuseNoticeDone) return;
  fuseNoticeDone = true;
  const file = join(app.getPath('userData'), FUSE_NOTICE_FILE);
  let seen: string | null = null;
  try {
    seen = readFileSync(file, 'utf8').slice(0, 64);
  } catch {
    // Not shown yet.
  }
  if (!shouldShowFuseNotice(process.env[FUSE_NOTICE_ENV], seen, PKG.version)) return;
  try {
    const shown: unknown = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [
      { code: fuseNoticeCode() },
    ]);
    if (shown !== true) {
      event('fuse-notice-failed');
      return;
    }
    await writeFile(file, `${PKG.version}\n`, { mode: 0o600 });
    event('fuse-notice-shown');
  } catch {
    event('fuse-notice-failed');
  }
}

/** The banner while the sandbox is off: set through the CSSOM (the page's policy has no inline style). */
async function injectBanner(wc: WebContents): Promise<void> {
  const code = `(() => {
    if (document.getElementById('nutflix-sandbox-banner') !== null) return;
    const b = document.createElement('div');
    b.id = 'nutflix-sandbox-banner';
    b.setAttribute('role', 'alert');
    b.textContent = ${JSON.stringify(BANNER_TEXT)};
    const s = b.style;
    s.position = 'fixed'; s.top = '0'; s.left = '0'; s.right = '0'; s.zIndex = '2147483647';
    s.background = '#b00020'; s.color = '#ffffff'; s.padding = '6px 12px';
    s.font = '600 13px system-ui, sans-serif'; s.textAlign = 'center'; s.pointerEvents = 'none';
    document.body.appendChild(b);
  })()`;
  try {
    await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code }]);
  } catch {
    event('banner-failed');
  }
}
