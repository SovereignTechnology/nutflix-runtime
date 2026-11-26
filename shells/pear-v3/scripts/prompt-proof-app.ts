/**
 * Main's prompt window in real Electron, driven by this script (`executeJavaScript` plays the user).
 * It uses the code `main.ts` uses: `wireAccountMenu`, `MainCalls`, `installPromptSession`, `openPrompt`,
 * `promptSender`, `PromptHost`, the real preload and the real page. Only the worker and the native
 * message box are stand-ins. It checks, from outside the page:
 *
 *   - the renderer process is under a seccomp-bpf filter;
 *   - the page's world has no Node, no Electron and nothing from the preload;
 *   - the page's policy refuses fetch, WebSocket, inline script, eval and images;
 *   - a value sent on the prompt's channel by ANOTHER window is dropped;
 *   - two fields that differ cannot be submitted;
 *   - a refused value shows its reason, clears the field and leaves the window open;
 *   - an accepted value closes it, and Cancel and closing the window both count as a cancel;
 *   - Enter on a focused Cancel never submits;
 *   - closing it during a submit waits for the call and reports what really happened;
 *   - a prompt that never loads is destroyed by its watchdog, which counts as a cancel;
 *   - a prompt whose renderer process dies before its first paint ends as a cancel, by a named
 *     path, with no value delivered and its window destroyed, and the real dialog lock is free:
 *     the next prompt opens and answers normally;
 *   - so does one whose renderer dies once it is on screen, and the log says how it died;
 *   - the real window keeps the real Account menu on screen, its item opens the prompt, a real key
 *     event reaches main's shortcut before the page, and a page's synthetic one does not;
 *   - a real click can take the page to fullscreen, a real Esc leaves it and the menu bar is back.
 *     What the menu bar does during fullscreen is recorded in the log, not asserted;
 *   - the app's guard (`loopback.ts`), in the app's session: a redirect from a port the worker
 *     serves to another loopback port is cancelled before that server sees it, which is what shows
 *     that Electron hands a redirect's target to the same `onBeforeRequest` listener (the guard's
 *     `https:` rule for private IP literals relies on it; a TLS origin here would need a trusted
 *     certificate, so the redirect is plain HTTP);
 *   - the app's guard on plain HTTP (`loopback.ts`), in the app's session: a page's `fetch` and
 *     `<video>` reach a port the worker serves, never another loopback port (that server sees no
 *     request at all), and once the worker is gone and another took a new port, only the new port
 *     passes. The page for this is served from loopback; what an `app://nutflix` page gets from a
 *     worker port is recorded in the log, not asserted.
 *
 * The verdict is `prompt-proof-verdict.ts`: a failure is final, and the success line is printed only
 * when every check above ran and held. The menu item is clicked and the keys are sent by this
 * script. What it does not show: a person using the menu or the window, how they look, and any
 * native message box.
 */
import { mkdtempSync, readFileSync, writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BrowserWindow,
  Menu,
  app,
  ipcMain,
  protocol,
  session,
  webContents,
  type WebContents,
} from 'electron';

import { WorkerError } from '@nutflix-runtime/worker';

import {
  ACCOUNT_ITEMS,
  ACCOUNT_MENU_LABEL,
  accountMenuPresent,
  menuBarState,
  wireAccountMenu,
  type AccountAction,
} from '../src/main/account-menu.ts';
import { WorkerPorts, installLoopbackGuard } from '../src/main/loopback.ts';
import { MainCalls, PROMPT_DECLINED_WAIT_MS } from '../src/main/main-calls.ts';
import {
  PROMPT_PARTITION,
  PROMPT_URL,
  PromptHost,
  installPromptSession,
  openPrompt,
  promptSender,
  type PromptEndPath,
  type PromptSpec,
} from '../src/main/prompt-window.ts';
import { fromProcStatus } from '../src/main/sandbox-proof.ts';
import { APP_SCHEME, APP_URL, privilegedSchemes } from '../src/main/schemes.ts';
import { hardenWebContents, installSessionPolicy } from '../src/main/security.ts';
import { createMainWindow } from '../src/main/window.ts';
import { PROMPT_CANCEL, PROMPT_SUBMIT } from '../src/shared/ids.ts';
import { ProofVerdict, runProof, withDeadline, type VerdictIo } from './prompt-proof-verdict.ts';

/** What the proof's stand-in for the worker answers: nobody has a signer yet. */
const NO_SIGNER = {
  kind: 'none',
  pubkey: null,
  locked: true,
  keyFile: false,
  localAllowed: true,
} as const;

const SPEC: PromptSpec = {
  title: 'A proof',
  message: 'This window is being driven by a script.',
  label: 'Value',
  repeatLabel: 'The same value again',
  submit: 'Submit',
  minChars: 8,
  maxChars: 64,
};
const FIRST = 'the first value';
const SECOND = 'the second value';
const OVERALL_MS = 90_000;
/** How long a prompt's answer may take once the thing that ends it has happened. */
const ANSWER_MS = 15_000;
/** How long the crash API gets to end the renderer before this script kills it outright. */
const FORCE_CRASH_MS = 12_000;
/** The watchdog's deadline for the prompt that never loads. */
const NEVER_SHOWN_MS = 1_500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, f: () => Promise<T | null> | T | null): Promise<T> {
  const end = Date.now() + 20_000;
  for (;;) {
    const v = await f();
    if (v !== null) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(50);
  }
}

/** With no user gesture: the only activation a page gets here is from a real input event. */
const inPage = <T>(wc: WebContents, js: string): Promise<T> =>
  wc.executeJavaScript(js, false) as Promise<T>;

const fill = (wc: WebContents, id: string, value: string): Promise<void> =>
  inPage(
    wc,
    `(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  );

/**
 * The click runs after this call has answered: a click that closes the window would otherwise
 * dispose of the frame while the call is still waiting for its result.
 */
const click = (wc: WebContents, id: string): Promise<void> =>
  inPage(wc, `void setTimeout(() => document.getElementById(${JSON.stringify(id)}).click(), 0)`);

/** The kernel's view of a process: its state letter, or `gone`. */
function procState(pid: number): string {
  try {
    return /^State:\s*(\S+)/m.exec(readFileSync(`/proc/${String(pid)}/status`, 'utf8'))?.[1] ?? '?';
  } catch {
    return 'gone';
  }
}

const POLICY_PROBE = `(async () => {
  const out = {};
  try { await fetch('app://prompt/prompt.html'); out.fetchSelf = 'reached'; } catch { out.fetchSelf = 'refused'; }
  try { await fetch('http://127.0.0.1:9/'); out.fetchLoopback = 'reached'; } catch { out.fetchLoopback = 'refused'; }
  const s = document.createElement('script');
  s.textContent = 'globalThis.__inlineRan = true';
  document.head.append(s);
  s.remove();
  out.inlineScript = globalThis.__inlineRan === true ? 'ran' : 'refused';
  try { eval('1'); out.eval = 'ran'; } catch { out.eval = 'refused'; }
  out.image = await new Promise((r) => {
    const i = new Image();
    i.onload = () => r('loaded');
    i.onerror = () => r('refused');
    i.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  });
  out.webSocket = await new Promise((r) => {
    try {
      const w = new WebSocket('ws://127.0.0.1:9/');
      w.onopen = () => r('open');
      w.onerror = () => r('refused');
    } catch { r('refused'); }
  });
  return JSON.stringify(out);
})()`;

const WORLD_PROBE = `JSON.stringify({
  require: typeof require,
  process: typeof process,
  module: typeof module,
  Buffer: typeof Buffer,
  ipcRenderer: typeof ipcRenderer,
  electron: typeof electron,
  exposed: Object.getOwnPropertyNames(globalThis).filter((k) => /electron|nutflix|ipc/i.test(k)),
})`;

/** `true` once `f` holds, `false` if it has not within `ms`. For observing, not for asserting. */
async function holdsWithin(f: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await f()) return true;
    if (Date.now() > end) return false;
    await sleep(50);
  }
}

interface FullscreenPageState {
  readonly clicks: number;
  readonly activated: boolean;
  readonly request: string | null;
  readonly inFullscreen: boolean;
}

/**
 * Takes the page to fullscreen with a real click, leaves with a real Esc, and reports what the window
 * did at each stage. It never throws for what it sees: the checks come at the end of the proof, so
 * that this observation is in the log whatever the other steps do.
 */
async function observeFullscreen(win: BrowserWindow): Promise<{
  readonly clicked: boolean;
  readonly activated: boolean;
  readonly request: string | null;
  readonly entered: boolean;
  readonly leftByEsc: boolean;
  readonly before: Record<string, unknown>;
  readonly during: Record<string, unknown>;
  readonly after: Record<string, unknown>;
  readonly menuBarBack: boolean;
}> {
  const wc = win.webContents;
  const windowState = (): Record<string, unknown> => ({
    menuBarVisible: win.isMenuBarVisible(),
    menuBarAutoHide: win.isMenuBarAutoHide(),
    windowFullScreen: win.isFullScreen(),
    contentSize: win.getContentSize(),
  });
  const pageState = async (): Promise<FullscreenPageState> =>
    JSON.parse(
      await inPage<string>(
        wc,
        `JSON.stringify({ ...globalThis.__fullscreen, inFullscreen: document.fullscreenElement !== null })`,
      ),
    ) as FullscreenPageState;
  await inPage(
    wc,
    `(() => {
      globalThis.__fullscreen = { clicks: 0, activated: false, request: null };
      const b = document.createElement('button');
      b.id = 'go-fullscreen';
      b.textContent = 'fullscreen';
      b.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%';
      b.addEventListener('click', () => {
        const s = globalThis.__fullscreen;
        s.clicks += 1;
        s.activated = navigator.userActivation.isActive;
        document.documentElement.requestFullscreen().then(
          () => { s.request = 'entered'; },
          (e) => { s.request = 'refused: ' + e.name; },
        );
      });
      document.body.append(b);
    })()`,
  );
  await sleep(300);
  const before = windowState();
  win.focus();
  wc.focus();
  wc.sendInputEvent({ type: 'mouseMove', x: 100, y: 100 });
  wc.sendInputEvent({ type: 'mouseDown', x: 100, y: 100, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: 100, y: 100, button: 'left', clickCount: 1 });
  const entered = await holdsWithin(async () => (await pageState()).inFullscreen, 8_000);
  // Long enough for the window to have acted on it.
  await sleep(700);
  const during = windowState();
  const clickedState = await pageState();
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  const leftByEsc =
    entered && (await holdsWithin(async () => !(await pageState()).inFullscreen, 8_000));
  await sleep(500);
  // Whatever Esc did, the steps after this one need the window back.
  if ((await pageState()).inFullscreen) {
    await inPage(wc, `document.exitFullscreen().catch(() => undefined)`);
    await sleep(500);
  }
  const after = windowState();
  await inPage(wc, `document.getElementById('go-fullscreen').remove()`);
  return {
    clicked: clickedState.clicks === 1,
    activated: clickedState.activated,
    request: clickedState.request,
    entered,
    leftByEsc,
    before,
    during,
    after,
    menuBarBack: win.isMenuBarVisible() && !win.isMenuBarAutoHide(),
  };
}

/** A loopback HTTP server that answers every request with a 302 to `to`, and records its paths. */
async function redirectingServer(to: string): Promise<{
  readonly port: number;
  readonly paths: string[];
  close(): void;
}> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? '');
    res.writeHead(302, {
      location: to,
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    paths,
    close: () => {
      server.close();
    },
  };
}

/** A loopback HTTP server that records the path of every request it gets. */
async function countingServer(
  body: string,
  type: string,
): Promise<{
  readonly port: number;
  readonly paths: string[];
  close(): void;
}> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? '');
    res.writeHead(200, {
      'content-type': type,
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    paths,
    close: () => {
      server.close();
    },
  };
}

const LOOP_TOKEN = 'a'.repeat(32);
const LOOP_SID = 'b'.repeat(32);
const fetchPath = `/${LOOP_TOKEN}`;
const mediaPath = `/${LOOP_TOKEN}/${LOOP_SID}`;

/**
 * From the page: one `fetch` and one `<video>` load of `port`, as the app's page makes them. Each
 * gives up after a few seconds, so that a request nothing answers cannot hold the proof.
 */
const httpProbe = (port: number): string => `(async () => {
  const origin = 'http://127.0.0.1:${String(port)}';
  const fetched = await fetch(origin + '${fetchPath}', {
    mode: 'no-cors',
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  }).then(
    () => 'reached',
    (e) => (e && e.name === 'TimeoutError' ? 'timeout' : 'refused'),
  );
  const media = await new Promise((r) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    let over = false;
    const done = (x) => {
      if (over) return;
      over = true;
      v.removeAttribute('src');
      v.load();
      v.remove();
      r(x);
    };
    v.addEventListener('loadedmetadata', () => done('loaded'));
    v.addEventListener('error', () => done('error'));
    setTimeout(() => done('timeout'), 3000);
    v.src = origin + '${mediaPath}';
    document.body.append(v);
  });
  return JSON.stringify({ fetched, media });
})()`;

async function run(v: ProofVerdict): Promise<void> {
  const ses = session.fromPartition(PROMPT_PARTITION, { cache: false });
  installPromptSession(ses, () => readFile(join(__dirname, 'prompt.html')));
  const preload = join(__dirname, 'prompt-preload.cjs');

  // The app's real window options, origin and permission policy, so that what hides or shows its
  // menu bar, and what lets a page go fullscreen, is what ships.
  installSessionPolicy(session.defaultSession);
  // And its guard on plain HTTP, as `main.ts` installs it; checked at the end.
  const ports = new WorkerPorts();
  const refusedPorts: number[] = [];
  installLoopbackGuard(session.defaultSession, ports, (_name, fields) => {
    refusedPorts.push(Number(fields?.['port']));
  });
  protocol.handle(
    APP_SCHEME,
    () =>
      new Response('<!doctype html><title>Nutflix</title><p>the other window</p>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
  );
  const parent = createMainWindow(BrowserWindow, join(__dirname, 'proof-preload.cjs'));
  parent.show();
  await parent.loadURL(APP_URL);

  let current: WebContents | null = null;
  const gone: {
    reason: string | null;
    exitCode: number | null;
    at: number;
    path: PromptEndPath | null;
  } = {
    reason: null,
    exitCode: null,
    at: 0,
    path: null,
  };
  const host = new PromptHost({
    open: (_windowId, spec, onGone) => {
      const surface = openPrompt(BrowserWindow, parent, preload, ses, spec, onGone, {
        onRendererGone: (reason, exitCode) => {
          gone.reason = reason;
          gone.exitCode = exitCode;
          gone.at = Date.now();
          v.note('render-process-gone', { reason, exitCode });
        },
        onEnded: (path) => {
          gone.path = path;
        },
      });
      current = webContents.fromId(surface.id) ?? null;
      return surface;
    },
  });
  ipcMain.on(PROMPT_SUBMIT, (e, value: unknown) => {
    host.message(promptSender(e), PROMPT_SUBMIT, value);
  });
  ipcMain.on(PROMPT_CANCEL, (e) => {
    host.message(promptSender(e), PROMPT_CANCEL, undefined);
  });

  const form = async (): Promise<WebContents> => {
    const wc = await until('the prompt window', () => current);
    // Not into a page still loading: its first frame is replaced, and a call into it is lost.
    await until('the page to load', () =>
      wc.getURL() === PROMPT_URL && !wc.isLoading() ? true : null,
    );
    await until('the form', async () =>
      (await inPage<boolean>(wc, `document.getElementById('prompt-submit') !== null`))
        ? true
        : null,
    );
    return wc;
  };

  // ---- the Account menu: the real wiring, on the real dialog lock ------------------------------
  const got: string[] = [];
  const answers: (string | null)[] = ['not that one', null];
  const workerCalls: { method: string; args: Record<string, unknown> }[] = [];
  const clock = { skew: 0 };
  const route: { host: PromptHost } = { host };
  const calls = new MainCalls({
    pickFile: () => Promise.resolve(null),
    confirmSeeding: () => Promise.resolve(false),
    confirmPublish: () => Promise.resolve(false),
    confirmVideo: () => Promise.resolve(false),
    askSecret: (id, spec, submit) => route.host.ask(id, spec, submit),
    // The one stand-in: it refuses the first passphrase, and nobody has a signer.
    worker: (method, args) => {
      workerCalls.push({ method, args });
      if (method !== 'signer.local.create') return Promise.resolve(NO_SIGNER);
      const value = args['passphrase'];
      got.push(typeof value === 'string' ? value : '');
      const problem = answers.shift() ?? null;
      return problem === null
        ? Promise.resolve(NO_SIGNER)
        : Promise.reject(new WorkerError('bad-passphrase', problem));
    },
    now: () => Date.now() + clock.skew,
  });
  const outcomes: { action: AccountAction; problem: string | null }[] = [];
  const pageTold = { times: 0 };
  const wiring = wireAccountMenu({
    platform: process.platform,
    menu: Menu,
    window: () => parent,
    account: async (id, action) => {
      const out = await calls.account(id, action);
      outcomes.push({ action, problem: out.problem });
      return out;
    },
    tellPage: () => {
      pageTold.times += 1;
    },
    showProblem: (_win, problem) => {
      v.note('account-problem', { problem });
      return Promise.resolve();
    },
  });
  wiring.attach(parent.webContents);
  const locks = (): number => workerCalls.filter((c) => c.method === 'signer.lock').length;

  const menu = Menu.getApplicationMenu();
  v.check('accountMenuPresent', accountMenuPresent(menu));
  const menuBar = menuBarState(process.platform, parent);
  v.check('menuBarVisible', menuBar === 'visible', `the menu bar is ${menuBar}`);

  await inPage(
    parent.webContents,
    `document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true, bubbles: true,
    }))`,
  );
  await sleep(200);
  v.check('syntheticKeyIgnored', locks() === 0);

  await inPage(
    parent.webContents,
    `(() => {
      globalThis.__keys = 0;
      addEventListener('keydown', () => { globalThis.__keys += 1; }, true);
    })()`,
  );
  parent.focus();
  parent.webContents.focus();
  parent.webContents.sendInputEvent({
    type: 'keyDown',
    keyCode: 'L',
    modifiers: ['control', 'shift'],
  });
  parent.webContents.sendInputEvent({
    type: 'keyUp',
    keyCode: 'L',
    modifiers: ['control', 'shift'],
  });
  await until('the shortcut', () => (pageTold.times === 1 ? true : null));
  v.check(
    'realKeyReachedMain',
    locks() === 1 && outcomes[0]?.action === 'lock' && outcomes[0].problem === null,
    `locks ${String(locks())}, outcome ${JSON.stringify(outcomes[0] ?? null)}`,
  );
  await sleep(200);
  v.check(
    'pageDidNotSeeKey',
    (await inPage<number>(parent.webContents, 'globalThis.__keys')) === 0,
  );

  // Observed here, checked at the end, so that this is in the log whatever the later steps do.
  const fullscreen = await observeFullscreen(parent);
  v.note('fullscreen', fullscreen);

  const create = ACCOUNT_ITEMS.find((x) => x.action === 'create')?.label;
  const item = menu?.items
    .find((i) => i.label === ACCOUNT_MENU_LABEL)
    ?.submenu?.items.find((i) => i.label === create);
  if (item === undefined) throw new Error('no Create Key item');
  (item as unknown as { click(): void }).click();

  // ---- the first prompt: confinement, the sender check, a refusal, then an accepted value ----
  const wc = await form();
  v.check('menuItemOpensPrompt', host.open, 'the menu item did not open the prompt');
  const win = BrowserWindow.fromWebContents(wc);
  await until('the window to show', () => (win?.isVisible() === true ? true : null));
  v.check('promptWasVisible', win?.isVisible() === true);

  const sandbox = fromProcStatus(
    readFileSync(`/proc/${String(wc.getOSProcessId())}/status`, 'utf8'),
  );
  v.check('rendererSandboxed', sandbox === 'enforced', `the renderer's sandbox is ${sandbox}`);
  v.check('modal', win?.isModal() === true, 'the window is not modal');
  v.check('modal', win?.getParentWindow()?.id === parent.id, 'it does not belong to its parent');
  v.check('showsPromptUrl', wc.getURL() === PROMPT_URL);

  const world = JSON.parse(await inPage<string>(wc, WORLD_PROBE)) as Record<string, unknown>;
  for (const k of ['require', 'process', 'module', 'Buffer', 'ipcRenderer', 'electron'])
    v.check('pageWorldClean', world[k] === 'undefined', `the page has ${k}`);
  v.check('pageWorldClean', JSON.stringify(world['exposed']) === '[]', 'the preload exposed some');

  const policy = JSON.parse(await inPage<string>(wc, POLICY_PROBE)) as Record<string, string>;
  v.note('policy', policy);
  for (const k of ['fetchSelf', 'fetchLoopback', 'inlineScript', 'eval', 'image', 'webSocket'])
    v.check('policyRefusesAll', policy[k] === 'refused', `${k} is ${policy[k] ?? 'absent'}`);

  await inPage(parent.webContents, `forgePrompt('a value from another window')`);
  await sleep(400);
  v.check('otherWindowDropped', got.length === 0, 'a value from another window arrived');
  v.check('otherWindowDropped', host.open, 'a cancel from another window arrived');

  await fill(wc, 'prompt-value', FIRST);
  await fill(wc, 'prompt-repeat', FIRST);
  await inPage(
    wc,
    `(() => {
      const c = document.getElementById('prompt-cancel');
      c.focus();
      c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    })()`,
  );
  await sleep(200);
  v.check('enterOnCancelIgnored', got.length === 0 && host.open);

  await fill(wc, 'prompt-value', FIRST);
  await fill(wc, 'prompt-repeat', 'something else');
  v.check(
    'differentFieldsBlocked',
    await inPage<boolean>(wc, `document.getElementById('prompt-submit').disabled`),
  );
  await fill(wc, 'prompt-repeat', FIRST);
  v.check(
    'differentFieldsBlocked',
    !(await inPage<boolean>(wc, `document.getElementById('prompt-submit').disabled`)),
    'two fields that match cannot be submitted',
  );
  await click(wc, 'prompt-submit');
  await until('the first value', () => (got.length === 1 ? true : null));
  v.check('valueReachedMain', got[0] === FIRST);
  await until('the reason on screen', async () =>
    (await inPage<string>(wc, `document.getElementById('prompt-error').textContent`)) ===
    'not that one'
      ? true
      : null,
  );
  v.check('refusalKeptOpen', host.open);
  v.check(
    'fieldCleared',
    (await inPage<string>(wc, `document.getElementById('prompt-value').value`)) === '',
  );

  await fill(wc, 'prompt-value', SECOND);
  await fill(wc, 'prompt-repeat', SECOND);
  await click(wc, 'prompt-submit');
  const created = await until(
    'the menu action to answer',
    () => outcomes.find((o) => o.action === 'create') ?? null,
  );
  v.check('acceptedCloses', created.problem === null, `problem ${String(created.problem)}`);
  v.check('valueReachedMain', got[1] === SECOND);
  await until('the window to close', () => (wc.isDestroyed() ? true : null));

  // ---- Cancel ----
  current = null;
  const cancelled = host.ask(parent.webContents.id, SPEC, () => {
    got.push('unexpected');
    return Promise.resolve(null);
  });
  await click(await form(), 'prompt-cancel');
  v.check('cancelIsCancel', !(await withDeadline(cancelled, ANSWER_MS, 'Cancel')));

  // ---- closing the window ----
  current = null;
  const closed = host.ask(parent.webContents.id, SPEC, () => {
    got.push('unexpected');
    return Promise.resolve(null);
  });
  BrowserWindow.fromWebContents(await form())?.close();
  v.check('closeIsCancel', !(await withDeadline(closed, ANSWER_MS, 'closing the window')));
  v.check('nothingElseReachedMain', got.length === 2);

  // ---- closed during a submit: the call cannot be taken back, so the answer waits for it ------
  current = null;
  let finishBusy: (problem: string | null) => void = () => undefined;
  const running = { now: false };
  const busy = host.ask(parent.webContents.id, SPEC, () => {
    running.now = true;
    return new Promise<string | null>((r) => {
      finishBusy = r;
    });
  });
  const busyWc = await form();
  await fill(busyWc, 'prompt-value', FIRST);
  await fill(busyWc, 'prompt-repeat', FIRST);
  await click(busyWc, 'prompt-submit');
  await until('the submit to start', () => (running.now ? true : null));
  BrowserWindow.fromWebContents(busyWc)?.close();
  await until('the busy window to close', () => (busyWc.isDestroyed() ? true : null));
  const heard = { now: false };
  void busy.then(() => {
    heard.now = true;
  });
  await sleep(200);
  v.check('closeDuringSubmitWaited', !heard.now);
  finishBusy(null);
  v.check('closeDuringSubmitReported', await withDeadline(busy, ANSWER_MS, 'the busy prompt'));

  // ---- a prompt that never loads: its page is never answered, so nothing ever paints ----------
  const stuckSession = session.fromPartition(`${PROMPT_PARTITION}-never`, { cache: false });
  installPromptSession(stuckSession, () => new Promise<Uint8Array>(() => undefined));
  const watchdog = { fired: false };
  const neverHost = new PromptHost({
    open: (_windowId, spec, onGone) =>
      openPrompt(BrowserWindow, parent, preload, stuckSession, spec, onGone, {
        showWithinMs: NEVER_SHOWN_MS,
        onNeverShown: () => {
          watchdog.fired = true;
        },
      }),
  });
  const neverStarted = Date.now();
  const never = await withDeadline(
    neverHost.ask(parent.webContents.id, SPEC, () => Promise.resolve(null)),
    ANSWER_MS,
    'the prompt that never loads',
  );
  v.note('never-shown', { watchdogFired: watchdog.fired, ms: Date.now() - neverStarted });
  v.check('neverShownIsCancel', !never && watchdog.fired, 'the watchdog did not end the prompt');

  // ---- a renderer that dies before its first paint: the page commits and never finishes -------
  const noPaintSession = session.fromPartition(`${PROMPT_PARTITION}-no-paint`, { cache: false });
  noPaintSession.protocol.handle(APP_SCHEME, () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start: (c) => {
            c.enqueue(new TextEncoder().encode('<!doctype html><html>'));
          },
        }),
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      ),
    ),
  );
  const early: {
    wc: WebContents | null;
    committed: boolean;
    reason: string | null;
    path: PromptEndPath | null;
  } = {
    wc: null,
    committed: false,
    reason: null,
    path: null,
  };
  // A function: the events set these while this step waits.
  const heardEarly = (): typeof early => early;
  const earlyHost = new PromptHost({
    open: (_windowId, spec, onGone) => {
      const surface = openPrompt(BrowserWindow, parent, preload, noPaintSession, spec, onGone, {
        // Far past this step: a watchdog cannot be what ends this prompt here.
        showWithinMs: OVERALL_MS * 2,
        onRendererGone: (reason, exitCode) => {
          early.reason = reason;
          v.note('render-process-gone', { before: 'first paint', reason, exitCode });
        },
        onEnded: (path) => {
          early.path = path;
        },
      });
      early.wc = webContents.fromId(surface.id) ?? null;
      early.wc?.once('did-navigate', () => {
        early.committed = true;
      });
      return surface;
    },
  });

  // The same real dialog lock as the menu uses.
  route.host = earlyHost;
  workerCalls.length = 0;

  const diesEarly = calls.account(parent.webContents.id, 'connect');
  const earlyWc = await until('the no-paint prompt', () => heardEarly().wc);
  await until('its page to commit', () => (heardEarly().committed ? true : null));
  const earlyWin = BrowserWindow.fromWebContents(earlyWc);
  if (earlyWin === null) throw new Error('the no-paint prompt has no window');
  const earlyPid = earlyWc.getOSProcessId();
  if (earlyPid <= 1) throw new Error('the no-paint prompt has no renderer process');
  const visibleAtDeath = earlyWin.isVisible();
  v.check(
    'deathBeforePaintWasOpen',
    earlyHost.open && !earlyWin.isDestroyed() && !visibleAtDeath && heardEarly().path === null,
    `open ${String(earlyHost.open)}, visible ${String(visibleAtDeath)}, ended ${String(heardEarly().path)}`,
  );
  const earlyAt = Date.now();
  process.kill(earlyPid, 'SIGKILL');
  const earlyOut = await withDeadline(diesEarly, ANSWER_MS, 'the prompt that died unpainted');
  const earlyMs = Date.now() - earlyAt;
  await until('the unpainted window to close', () => (earlyWin.isDestroyed() ? true : null));
  const endedBy = heardEarly().path;
  const earlyMethods = workerCalls.map((c) => c.method);
  // A "no" is remembered for a moment. Being told so proves the lock is free and this was a cancel.
  const declined = await calls.account(parent.webContents.id, 'connect');
  v.note('death-before-paint', {
    endedBy,
    visibleAtDeath,
    problem: earlyOut.problem,
    workerCalls: earlyMethods,
    windowDestroyed: earlyWin.isDestroyed(),
    renderProcessGone: heardEarly().reason,
    asAgainSays: declined.problem,
    ms: earlyMs,
  });
  v.check(
    'deathBeforePaintNamedPath',
    endedBy === 'load-failed' || endedBy === 'render-process-gone' || endedBy === 'watchdog',
    `ended by ${String(endedBy)}`,
  );
  v.check(
    'deathBeforePaintIsCancel',
    earlyOut.problem === null &&
      earlyMethods.length === 1 &&
      earlyMethods[0] === 'signer.status' &&
      declined.problem?.includes('try again') === true,
    `problem ${String(earlyOut.problem)}, calls ${earlyMethods.join()}, then ${String(declined.problem)}`,
  );
  v.check(
    'deathBeforePaintNoValue',
    !workerCalls.some((c) => c.method === 'signer.nip46.connect' || 'uri' in c.args),
  );
  v.check('deathBeforePaintWindowDestroyed', earlyWin.isDestroyed());

  // The lock was released: the same action, past its back-off, opens a real prompt and works.
  clock.skew = PROMPT_DECLINED_WAIT_MS;
  route.host = host;
  current = null;
  workerCalls.length = 0;
  const afterDeath = 'bunker://a-value-typed-after-the-renderer-died';
  const second = calls.account(parent.webContents.id, 'connect');
  const secondWc = await form();
  await fill(secondWc, 'prompt-value', afterDeath);
  await click(secondWc, 'prompt-submit');
  const secondOut = await withDeadline(second, ANSWER_MS, 'the prompt after the death');
  await until('the second prompt to close', () => (secondWc.isDestroyed() ? true : null));
  const secondMethods = workerCalls.map((c) => c.method);
  v.note('lock-after-death', { problem: secondOut.problem, workerCalls: secondMethods });
  v.check(
    'lockReleasedAfterDeath',
    secondOut.problem === null &&
      workerCalls.length === 1 &&
      workerCalls[0]?.method === 'signer.nip46.connect' &&
      workerCalls[0].args['uri'] === afterDeath,
    `problem ${String(secondOut.problem)}, calls ${secondMethods.join()}`,
  );

  // ---- a renderer that dies ----------------------------------------------------------------------
  current = null;
  gone.reason = null;
  gone.exitCode = null;
  gone.path = null;
  // A function: the event sets these while this step waits.
  const heardGone = (): typeof gone => gone;
  const crashed = host.ask(parent.webContents.id, SPEC, () => Promise.resolve(null));
  const crashedWc = await form();
  const pid = crashedWc.getOSProcessId();
  const heardCrash = { now: false };
  void crashed.then(() => {
    heardCrash.now = true;
  });
  const started = Date.now();
  crashedWc.forcefullyCrashRenderer();
  while (!heardCrash.now && Date.now() - started < FORCE_CRASH_MS) await sleep(100);
  v.note('force-crash', {
    answered: heardCrash.now,
    ms: Date.now() - started,
    eventFired: heardGone().reason !== null,
    reason: heardGone().reason,
    exitCode: heardGone().exitCode,
    processState: procState(pid),
  });
  let how = 'forcefullyCrashRenderer';
  if (!heardCrash.now) {
    // The crash API did not end it. Whether a renderer that really dies is handled is still the
    // question, so it dies for certain here, and the note above says what the API did.
    how = 'SIGKILL';
    try {
      process.kill(pid, 'SIGKILL');
    } catch (e) {
      v.note('sigkill', { error: e instanceof Error ? e.message : 'unknown' });
    }
  }
  const answer = await withDeadline(crashed, ANSWER_MS, `the prompt after ${how}`);
  await until('the crashed window to close', () => (crashedWc.isDestroyed() ? true : null));
  const died = heardGone();
  v.note('renderer-death', {
    how,
    endedBy: died.path,
    answer,
    eventFired: died.reason !== null,
    reason: died.reason,
    exitCode: died.exitCode,
    msToEvent: died.reason === null ? null : died.at - started,
    processState: procState(pid),
  });
  v.check(
    'rendererDeathIsCancel',
    !answer && died.reason !== null,
    `answer ${String(answer)}, render-process-gone ${String(died.reason)}`,
  );

  // ---- fullscreen, as observed earlier -----------------------------------------------------------
  v.check(
    'fullscreenFromRealClick',
    fullscreen.clicked && fullscreen.activated && fullscreen.entered,
    `clicked ${String(fullscreen.clicked)}, activated ${String(fullscreen.activated)}, request ${String(fullscreen.request)}`,
  );
  v.check('escLeavesFullscreen', fullscreen.leftByEsc);
  v.check('menuBarBackAfterEsc', fullscreen.menuBarBack, JSON.stringify(fullscreen.after));

  // ---- the page's plain HTTP: the worker's ports, and nothing else (`loopback.ts`) -------------
  const pageServer = await countingServer(
    '<!doctype html><title>loopback</title><p>a page served from loopback</p>',
    'text/html; charset=utf-8',
  );
  const workerServer = await countingServer('not a video', 'video/mp4');
  const otherServer = await countingServer('a service the page must not reach', 'text/plain');
  const nextServer = await countingServer('not a video', 'video/mp4');
  const redirectTarget = await countingServer('a service a redirect must not reach', 'text/plain');
  const redirector = await redirectingServer(
    `http://127.0.0.1:${String(redirectTarget.port)}/redirected`,
  );
  try {
    // What the gate learns from a worker's `nfx.play.open` answer. The proof's own page is served
    // from loopback (so that no other rule of Chromium's can stand in for the guard), and its port
    // is learned the same way.
    ports.served(`http://127.0.0.1:${String(pageServer.port)}${fetchPath}`);
    ports.served(`http://127.0.0.1:${String(workerServer.port)}${mediaPath}`);
    ports.served(`http://127.0.0.1:${String(workerServer.port)}${fetchPath}`);

    // What a page at the app's own origin gets from a worker port: evidence, not a check.
    const fromApp = JSON.parse(
      await inPage<string>(parent.webContents, httpProbe(workerServer.port)),
    ) as Record<string, string>;
    v.note('http-from-app-origin', { ...fromApp, serverSaw: [...workerServer.paths] });
    workerServer.paths.length = 0;

    const page = createMainWindow(BrowserWindow, join(__dirname, 'proof-preload.cjs'));
    page.show();
    await page.loadURL(`http://127.0.0.1:${String(pageServer.port)}/`);
    const probe = async (port: number): Promise<Record<string, string>> =>
      JSON.parse(await inPage<string>(page.webContents, httpProbe(port))) as Record<string, string>;

    const toWorker = await probe(workerServer.port);
    const toOther = await probe(otherServer.port);
    v.note('http-guard', {
      toWorker,
      workerSaw: [...workerServer.paths],
      toOther,
      otherSaw: [...otherServer.paths],
      refusedPorts: [...refusedPorts],
    });
    v.check(
      'httpWorkerPortReached',
      toWorker['fetched'] === 'reached' &&
        workerServer.paths.includes(fetchPath) &&
        workerServer.paths.includes(mediaPath),
      `fetch ${String(toWorker['fetched'])}, the server saw ${workerServer.paths.join(' ')}`,
    );
    v.check(
      'httpOtherPortRefused',
      toOther['fetched'] === 'refused' &&
        otherServer.paths.length === 0 &&
        refusedPorts.filter((p) => p === otherServer.port).length >= 2,
      `fetch ${String(toOther['fetched'])}, the server saw ${String(otherServer.paths.length)}`,
    );

    // A port the worker serves answers with a redirect to one it does not: Electron restarts the
    // followed redirect through `onBeforeRequest`, so the guard cancels it there.
    ports.served(`http://127.0.0.1:${String(redirector.port)}${fetchPath}`);
    const toRedirect = await probe(redirector.port);
    v.note('http-guard-redirect', {
      toRedirect,
      redirectorSaw: [...redirector.paths],
      targetSaw: [...redirectTarget.paths],
      refusedPorts: [...refusedPorts],
    });
    v.check(
      'httpRedirectTargetRefused',
      redirector.paths.includes(fetchPath) &&
        toRedirect['fetched'] === 'refused' &&
        redirectTarget.paths.length === 0 &&
        refusedPorts.includes(redirectTarget.port),
      `fetch ${String(toRedirect['fetched'])}, the redirector saw ${String(redirector.paths.length)}, its target ${String(redirectTarget.paths.length)}`,
    );

    // The worker is gone, and the next one's server took a new port.
    ports.reset();
    ports.served(`http://127.0.0.1:${String(nextServer.port)}${mediaPath}`);
    const workerBefore = workerServer.paths.length;
    const toGone = await probe(workerServer.port);
    const toNext = await probe(nextServer.port);
    v.note('http-guard-after-restart', {
      toGone,
      goneSaw: workerServer.paths.length - workerBefore,
      toNext,
      nextSaw: [...nextServer.paths],
    });
    v.check(
      'httpFollowsWorker',
      toGone['fetched'] === 'refused' &&
        workerServer.paths.length === workerBefore &&
        toNext['fetched'] === 'reached' &&
        nextServer.paths.includes(fetchPath) &&
        nextServer.paths.includes(mediaPath),
      `old ${String(toGone['fetched'])}, new ${String(toNext['fetched'])}`,
    );
    page.destroy();
  } finally {
    for (const s of [pageServer, workerServer, otherServer, nextServer, redirectTarget, redirector])
      s.close();
  }
}

protocol.registerSchemesAsPrivileged(privilegedSchemes());
app.setPath('userData', mkdtempSync(join(tmpdir(), 'nutflix-prompt-data-')));
app.on('web-contents-created', (_e, wc) => {
  hardenWebContents(wc);
});
app.on('window-all-closed', () => undefined);

const io: VerdictIo = {
  line: (text) => {
    writeSync(2, `${text}\n`);
  },
  exit: (code) => {
    if (code === 0) app.exit(0);
    // Not `app.exit`: its shutdown closes the windows, and that is what once resolved the await a
    // timed-out proof was stuck on. A failed proof ends here, at once.
    else process.kill(process.pid, 'SIGKILL');
  },
};
const verdict = new ProofVerdict(io);

void app.whenReady().then(() => runProof(verdict, run, OVERALL_MS));
