/**
 * Main's prompt window in real Electron, driven by this script (`executeJavaScript` plays the user).
 * It uses the code `main.ts` uses: `installPromptSession`, `openPrompt`, `promptSender`, `PromptHost`,
 * the real preload and the real page. It checks, from outside the page:
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
 *     event reaches main's shortcut before the page, and a page's synthetic one does not.
 *
 * The verdict is `prompt-proof-verdict.ts`: a failure is final, and the success line is printed only
 * when every check above ran and held. The menu item is clicked and the keys are sent by this
 * script. What it does not show: a person using the menu or the window, how they look, and any
 * native message box.
 */
import { mkdtempSync, readFileSync, writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

import {
  ACCOUNT_ITEMS,
  ACCOUNT_MENU_LABEL,
  AccountRunner,
  accountMenuPresent,
  accountShortcut,
  applicationMenu,
  menuBarState,
  type AccountAction,
} from '../src/main/account-menu.ts';
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
import { APP_SCHEME, privilegedSchemes } from '../src/main/schemes.ts';
import { hardenWebContents } from '../src/main/security.ts';
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

const inPage = <T>(wc: WebContents, js: string): Promise<T> =>
  wc.executeJavaScript(js, true) as Promise<T>;

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

async function run(v: ProofVerdict): Promise<void> {
  const ses = session.fromPartition(PROMPT_PARTITION, { cache: false });
  installPromptSession(ses, () => readFile(join(__dirname, 'prompt.html')));
  const preload = join(__dirname, 'prompt-preload.cjs');

  // The app's real window options, so that what hides or shows its menu bar is what ships.
  const parent = createMainWindow(BrowserWindow, join(__dirname, 'proof-preload.cjs'));
  parent.show();
  await parent.loadURL('data:text/html,<p>the other window</p>');

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

  // ---- the Account menu: on screen, and the one thing that opens the prompt -------------------
  const got: string[] = [];
  const answers: (string | null)[] = ['not that one', null];
  const actions: AccountAction[] = [];
  const opened: { first: Promise<boolean> | null } = { first: null };
  const account = new AccountRunner((action) => {
    actions.push(action);
    if (action === 'connect')
      opened.first = host.ask(parent.webContents.id, SPEC, (value) => {
        got.push(value);
        return Promise.resolve(answers.shift() ?? null);
      });
    return Promise.resolve();
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      applicationMenu(process.platform, (action) => {
        account.trigger(action);
      }),
    ),
  );
  parent.webContents.on('before-input-event', (e, input) => {
    const action = accountShortcut(input, process.platform);
    if (action === null) return;
    e.preventDefault();
    account.trigger(action);
  });
  const menu = Menu.getApplicationMenu();
  v.check('accountMenuPresent', accountMenuPresent(menu));
  const menuBar = menuBarState(process.platform, parent);
  v.check('menuBarVisible', menuBar === 'visible', `the menu bar is ${menuBar}`);

  await inPage(
    parent.webContents,
    `document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true, bubbles: true,
    }))`,
  );
  await sleep(200);
  v.check('syntheticKeyIgnored', actions.length === 0);

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
    keyCode: 'O',
    modifiers: ['control', 'shift'],
  });
  parent.webContents.sendInputEvent({
    type: 'keyUp',
    keyCode: 'O',
    modifiers: ['control', 'shift'],
  });
  await until('the shortcut', () => (actions.includes('unlock') ? true : null));
  v.check('realKeyReachedMain', true);
  await sleep(200);
  v.check(
    'pageDidNotSeeKey',
    (await inPage<number>(parent.webContents, 'globalThis.__keys')) === 0,
  );

  const connect = ACCOUNT_ITEMS.find((x) => x.action === 'connect')?.label;
  const item = menu?.items
    .find((i) => i.label === ACCOUNT_MENU_LABEL)
    ?.submenu?.items.find((i) => i.label === connect);
  if (item === undefined) throw new Error('no Connect Bunker item');
  (item as unknown as { click(): void }).click();
  const { first } = opened;
  if (first === null) throw new Error('the menu item did not open the prompt');
  v.check('menuItemOpensPrompt', true);

  // ---- the first prompt: confinement, the sender check, a refusal, then an accepted value ----
  const wc = await form();
  const win = BrowserWindow.fromWebContents(wc);
  await until('the window to show', () => (win?.isVisible() === true ? true : null));
  v.check('promptWasVisible', true);

  const sandbox = fromProcStatus(
    readFileSync(`/proc/${String(wc.getOSProcessId())}/status`, 'utf8'),
  );
  v.check('rendererSandboxed', sandbox === 'enforced', `the renderer's sandbox is ${sandbox}`);
  v.check('modal', win?.isModal() === true, 'the window is not modal');
  v.check('modal', win?.getParentWindow()?.id === parent.id, 'it does not belong to its parent');
  v.check('oneFileOnly', wc.getURL() === PROMPT_URL);

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
  v.check('acceptedCloses', await withDeadline(first, ANSWER_MS, 'the accepted value'));
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

  // The app's real dialog lock, around the prompt. Only the worker is a stand-in.
  const workerCalls: { method: string; args: Record<string, unknown> }[] = [];
  const clock = { skew: 0 };
  const route: { host: PromptHost } = { host: earlyHost };
  const calls = new MainCalls({
    pickFile: () => Promise.resolve(null),
    confirmSeeding: () => Promise.resolve(false),
    confirmPublish: () => Promise.resolve(false),
    confirmVideo: () => Promise.resolve(false),
    askSecret: (id, spec, submit) => route.host.ask(id, spec, submit),
    worker: (method, args) => {
      workerCalls.push({ method, args });
      return Promise.resolve(NO_SIGNER);
    },
    now: () => Date.now() + clock.skew,
  });

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
