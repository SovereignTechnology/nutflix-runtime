/**
 * The one place the user types a secret: a small modal window that main owns. A passphrase or a
 * `bunker://` URI (which holds a pairing secret) must never enter the app's page, because a stranger's
 * title rendering in that page is the threat this whole design assumes. Electron has no native
 * text prompt, so this is a separate, much smaller page:
 *
 *   - **its own origin and session:** `app://prompt`, in an in-memory partition that shares nothing
 *     with the app's page and refuses every request except its one file;
 *   - **no page script at all:** the policy is `default-src 'none'`. The form is built by the
 *     preload, in the isolated world, and exposes nothing to the page;
 *   - **its own IPC:** main takes a value only from this exact webContents' top frame, at this exact
 *     URL. The value goes from main to the worker (`gate.request`); no other window sees it.
 *
 * Electron-free apart from types: `main.ts` passes the constructor and the window in, and the tests
 * drive `PromptHost` with fakes.
 */
import type {
  BrowserWindow as ElectronBrowserWindow,
  BrowserWindowConstructorOptions,
  IpcMainEvent,
  Session,
} from 'electron';

import {
  MAX_PROMPT_CHARS,
  PROMPT_CANCEL,
  PROMPT_ERROR,
  PROMPT_SHOW,
  PROMPT_SUBMIT,
} from '../shared/ids.ts';
import { appResponseHeaders } from './csp.ts';
import { APP_SCHEME } from './schemes.ts';
import { installSessionPolicy } from './security.ts';

export const PROMPT_HOST = 'prompt';
export const PROMPT_URL = 'app://prompt/prompt.html';
/** In-memory (no `persist:`): nothing typed or cached here reaches the disk. */
export const PROMPT_PARTITION = 'nutflix-prompt';
/** No script, no style sheet, no connection, no image, no frame: the page is inert markup. */
export const PROMPT_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** How long a prompt may take to load and paint before it counts as dead. */
export const PROMPT_SHOW_DEADLINE_MS = 30_000;

/** What the preload builds. Fixed text from `main-calls.ts`: nothing here comes from a page. */
export interface PromptSpec {
  readonly title: string;
  readonly message: string;
  readonly label: string;
  /** A second field that must match, where a typing mistake would lose the key. */
  readonly repeatLabel?: string;
  readonly submit: string;
  readonly minChars: number;
  readonly maxChars: number;
}

export type PromptWindowCtor = new (
  options: BrowserWindowConstructorOptions,
) => ElectronBrowserWindow;

/** The window, its security posture written out as literals (as `window.ts` does). */
export function createPromptWindow(
  BrowserWindow: PromptWindowCtor,
  parent: ElectronBrowserWindow,
  preload: string,
  session: Session,
  title: string,
): ElectronBrowserWindow {
  return new BrowserWindow({
    parent,
    modal: true,
    width: 480,
    height: 340,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title,
    backgroundColor: '#181818',
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      session,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      devTools: false,
      spellcheck: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
    },
  });
}

/** The prompt session's whole network: its one file. Anything else is cancelled. */
export function allowPromptRequest(url: string): boolean {
  return url === PROMPT_URL;
}

/** `app://prompt/prompt.html`, and nothing else, with the policy as a header too. */
export function createPromptProtocolHandler(
  readHtml: () => Promise<Uint8Array>,
): (req: Request) => Promise<Response> {
  const headers = appResponseHeaders(PROMPT_CSP);
  return async (req) => {
    if (req.method !== 'GET' || req.url !== PROMPT_URL)
      return new Response(null, { status: 404, headers });
    try {
      const body = await readHtml();
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
      });
    } catch {
      return new Response(null, { status: 500, headers });
    }
  };
}

/** The prompt session: every permission denied, its one file served, every other request cancelled. */
export function installPromptSession(ses: Session, readHtml: () => Promise<Uint8Array>): void {
  installSessionPolicy(ses);
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !allowPromptRequest(details.url) });
  });
  ses.protocol.handle(APP_SCHEME, createPromptProtocolHandler(readHtml));
}

/** What ended a prompt that never became usable, or stopped being. */
export type PromptEndPath = 'load-failed' | 'render-process-gone' | 'watchdog';

export interface OpenPromptOptions {
  /** Default `PROMPT_SHOW_DEADLINE_MS`. */
  readonly showWithinMs?: number;
  /** Chromium's reason and exit code, for the log. */
  readonly onRendererGone?: (reason: string, exitCode: number) => void;
  readonly onNeverShown?: () => void;
  /** The first of those to end this prompt, once. A user closing it is none of them. */
  readonly onEnded?: (path: PromptEndPath) => void;
}

/**
 * Opens the window and shows `spec`. Every way it can fail to become a usable prompt ends in the
 * window being destroyed, which is a cancel, so a dead prompt cannot hold the dialog lock: a page
 * that fails to load, a renderer that dies, and a window that has not loaded and painted in time.
 */
export function openPrompt(
  BrowserWindow: PromptWindowCtor,
  parent: ElectronBrowserWindow,
  preload: string,
  ses: Session,
  spec: PromptSpec,
  onGone: () => void,
  o: OpenPromptOptions = {},
): PromptSurface {
  const win = createPromptWindow(BrowserWindow, parent, preload, ses, spec.title);
  const wc = win.webContents;
  const id = wc.id;
  win.setMenu(null);
  const state = { loaded: false, painted: false, ended: false };
  const endedBy = (path: PromptEndPath): void => {
    if (state.ended) return;
    state.ended = true;
    o.onEnded?.(path);
  };
  const watchdog = setTimeout(() => {
    o.onNeverShown?.();
    if (win.isDestroyed()) return;
    endedBy('watchdog');
    win.destroy();
  }, o.showWithinMs ?? PROMPT_SHOW_DEADLINE_MS);
  const settled = (): void => {
    if (state.loaded && state.painted) clearTimeout(watchdog);
  };
  win.once('closed', () => {
    clearTimeout(watchdog);
    onGone();
  });
  wc.once('render-process-gone', (_e, details) => {
    o.onRendererGone?.(details.reason, details.exitCode);
    if (!win.isDestroyed()) endedBy('render-process-gone');
    // Not from inside the event: the contents is still being told that its renderer is gone.
    setImmediate(() => {
      if (!win.isDestroyed()) win.destroy();
    });
  });
  wc.once('did-finish-load', () => {
    state.loaded = true;
    wc.send(PROMPT_SHOW, spec);
    settled();
  });
  win.once('ready-to-show', () => {
    state.painted = true;
    win.show();
    settled();
  });
  win.loadURL(PROMPT_URL).catch(() => {
    if (win.isDestroyed()) return;
    endedBy('load-failed');
    win.destroy();
  });
  return {
    id,
    error: (text) => {
      if (!wc.isDestroyed()) wc.send(PROMPT_ERROR, text);
    },
    close: () => {
      if (!win.isDestroyed()) win.close();
    },
  };
}

/** Who sent an IPC message, in the terms `PromptHost.message` checks. */
export function promptSender(e: IpcMainEvent): PromptSender {
  const f = e.senderFrame;
  return {
    webContentsId: e.sender.id,
    topFrame: f !== null && f === e.sender.mainFrame,
    url: f?.url,
  };
}

/** One open prompt window, as `PromptHost` needs it. */
export interface PromptSurface {
  /** Its webContents' id: the only sender a value is taken from. */
  readonly id: number;
  error(text: string): void;
  close(): void;
}

export interface PromptHostDeps {
  /** Opens the window for `windowId`, showing `spec`. `onGone` runs once when it is closed. */
  open(windowId: number, spec: PromptSpec, onGone: () => void): PromptSurface;
}

/** Who sent a prompt message, as Electron reports it. */
export interface PromptSender {
  readonly webContentsId: number;
  /** The message came from that webContents' main frame. */
  readonly topFrame: boolean;
  readonly url: string | undefined;
}

interface Active {
  readonly surface: PromptSurface;
  readonly spec: PromptSpec;
  readonly submit: (value: string) => Promise<string | null>;
  readonly resolve: (done: boolean) => void;
  busy: boolean;
  finished: boolean;
}

export class PromptHost {
  readonly #d: PromptHostDeps;
  #active: Active | null = null;

  constructor(d: PromptHostDeps) {
    this.#d = d;
  }

  get open(): boolean {
    return this.#active !== null;
  }

  /**
   * Shows the prompt. Each value the user submits goes to `submit`, which answers `null` when it
   * is done, or a line to show so that they can try again. Resolves `true` when done, `false` when
   * they cancelled or closed the window. If it closes while a value is being handled, that call
   * cannot be taken back, so this waits for it and answers what really happened.
   */
  ask(
    windowId: number,
    spec: PromptSpec,
    submit: (value: string) => Promise<string | null>,
  ): Promise<boolean> {
    if (this.#active !== null) return Promise.reject(new Error('a prompt is already open'));
    return new Promise<boolean>((resolve, reject) => {
      const holder: { active: Active | null } = { active: null };
      try {
        const surface = this.#d.open(windowId, spec, () => {
          if (holder.active !== null) this.#finish(holder.active, false);
        });
        holder.active = { surface, spec, submit, resolve, busy: false, finished: false };
        this.#active = holder.active;
      } catch (e) {
        reject(e instanceof Error ? e : new Error('the prompt did not open'));
      }
    });
  }

  /** An IPC message on a prompt channel. Anything not from the open prompt is dropped. */
  message(from: PromptSender, channel: string, value: unknown): void {
    const a = this.#active;
    if (a === null) return;
    if (from.webContentsId !== a.surface.id || !from.topFrame || from.url !== PROMPT_URL) return;
    if (channel === PROMPT_CANCEL) {
      this.#finish(a, false);
      return;
    }
    if (channel !== PROMPT_SUBMIT || a.busy) return;
    if (
      typeof value !== 'string' ||
      value.length < a.spec.minChars ||
      value.length > Math.min(a.spec.maxChars, MAX_PROMPT_CHARS)
    ) {
      a.surface.error('That is not the right length.');
      return;
    }
    a.busy = true;
    const settled = (problem: string | null): void => {
      a.busy = false;
      if (a.finished) a.resolve(problem === null);
      else if (problem === null) this.#finish(a, true);
      else a.surface.error(problem);
    };
    a.submit(value).then(settled, () => {
      settled('That did not work.');
    });
  }

  #finish(a: Active, done: boolean): void {
    if (a.finished) return;
    a.finished = true;
    if (this.#active === a) this.#active = null;
    try {
      a.surface.close();
    } catch {
      // Already gone.
    }
    // A value still being handled decides the answer (`message`).
    if (!a.busy) a.resolve(done);
  }
}
