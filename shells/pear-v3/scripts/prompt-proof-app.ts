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
 *   - a prompt whose renderer dies counts as a cancel;
 *   - the real window keeps the real Account menu on screen, its item opens the prompt, a real key
 *     event reaches main's shortcut before the page, and a page's synthetic one does not.
 *
 * The menu item is clicked and the keys are sent by this script. What it does not show: a person
 * using the menu or the window, how they look, and any native message box.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
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
import {
  PROMPT_PARTITION,
  PROMPT_URL,
  PromptHost,
  installPromptSession,
  openPrompt,
  promptSender,
  type PromptSpec,
} from '../src/main/prompt-window.ts';
import { fromProcStatus } from '../src/main/sandbox-proof.ts';
import { privilegedSchemes } from '../src/main/schemes.ts';
import { hardenWebContents } from '../src/main/security.ts';
import { createMainWindow } from '../src/main/window.ts';
import { PROMPT_CANCEL, PROMPT_SUBMIT } from '../src/shared/ids.ts';

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`failed: ${what}`);
}

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

async function run(): Promise<void> {
  const ses = session.fromPartition(PROMPT_PARTITION, { cache: false });
  installPromptSession(ses, () => readFile(join(__dirname, 'prompt.html')));

  // The app's real window options, so that what hides or shows its menu bar is what ships.
  const parent = createMainWindow(BrowserWindow, join(__dirname, 'proof-preload.cjs'));
  parent.show();
  await parent.loadURL('data:text/html,<p>the other window</p>');

  let current: WebContents | null = null;
  const host = new PromptHost({
    open: (_windowId, spec, onGone) => {
      const surface = openPrompt(
        BrowserWindow,
        parent,
        join(__dirname, 'prompt-preload.cjs'),
        ses,
        spec,
        onGone,
      );
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
  check(accountMenuPresent(menu), 'the Account menu is in place');
  const menuBar = menuBarState(process.platform, parent);
  check(menuBar === 'visible', `the menu bar is ${menuBar}`);

  await inPage(
    parent.webContents,
    `document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true, bubbles: true,
    }))`,
  );
  await sleep(200);
  check(actions.length === 0, "a page's synthetic key event does not reach the shortcut");

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
  await sleep(200);
  check(
    (await inPage<number>(parent.webContents, 'globalThis.__keys')) === 0,
    'the page never saw the shortcut',
  );

  const connect = ACCOUNT_ITEMS.find((x) => x.action === 'connect')?.label;
  const item = menu?.items
    .find((i) => i.label === ACCOUNT_MENU_LABEL)
    ?.submenu?.items.find((i) => i.label === connect);
  if (item === undefined) throw new Error('failed: no Connect Bunker item');
  (item as unknown as { click(): void }).click();
  const { first } = opened;
  if (first === null) throw new Error('failed: the menu item did not open the prompt');

  // ---- the first prompt: confinement, the sender check, a refusal, then an accepted value ----
  const wc = await form();

  const sandbox = fromProcStatus(
    readFileSync(`/proc/${String(wc.getOSProcessId())}/status`, 'utf8'),
  );
  check(sandbox === 'enforced', `the renderer's sandbox is ${sandbox}`);
  const win = BrowserWindow.fromWebContents(wc);
  check(win?.isModal() === true, 'the window is modal');
  check(win?.getParentWindow()?.id === parent.id, 'it belongs to its parent');
  check(wc.getURL() === PROMPT_URL, 'it shows its one file');

  const world = JSON.parse(await inPage<string>(wc, WORLD_PROBE)) as Record<string, unknown>;
  for (const k of ['require', 'process', 'module', 'Buffer', 'ipcRenderer', 'electron'])
    check(world[k] === 'undefined', `the page has no ${k}`);
  check(JSON.stringify(world['exposed']) === '[]', 'the preload exposed nothing');

  const policy = JSON.parse(await inPage<string>(wc, POLICY_PROBE)) as Record<string, string>;
  for (const k of ['fetchSelf', 'fetchLoopback', 'inlineScript', 'eval', 'image', 'webSocket'])
    check(policy[k] === 'refused', `${k} is ${policy[k] ?? 'absent'}`);

  await inPage(parent.webContents, `forgePrompt('a value from another window')`);
  await sleep(400);
  check(got.length === 0, 'a value from another window was dropped');
  check(host.open, 'a cancel from another window was dropped');

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
  check(got.length === 0 && host.open, 'Enter on a focused Cancel did not submit');

  await fill(wc, 'prompt-value', FIRST);
  await fill(wc, 'prompt-repeat', 'something else');
  check(
    await inPage<boolean>(wc, `document.getElementById('prompt-submit').disabled`),
    'two fields that differ cannot be submitted',
  );
  await fill(wc, 'prompt-repeat', FIRST);
  check(
    !(await inPage<boolean>(wc, `document.getElementById('prompt-submit').disabled`)),
    'two fields that match can',
  );
  await click(wc, 'prompt-submit');
  await until('the first value', () => (got.length === 1 ? true : null));
  check(got[0] === FIRST, 'the value reached main intact');
  await until('the reason on screen', async () =>
    (await inPage<string>(wc, `document.getElementById('prompt-error').textContent`)) ===
    'not that one'
      ? true
      : null,
  );
  check(host.open, 'a refusal leaves the window open');
  check(
    (await inPage<string>(wc, `document.getElementById('prompt-value').value`)) === '',
    'the field was cleared',
  );

  await fill(wc, 'prompt-value', SECOND);
  await fill(wc, 'prompt-repeat', SECOND);
  await click(wc, 'prompt-submit');
  check(await first, 'an accepted value finishes the prompt');
  check(got[1] === SECOND, 'the second value reached main');
  await until('the window to close', () => (wc.isDestroyed() ? true : null));

  // ---- Cancel ----
  current = null;
  const cancelled = host.ask(parent.webContents.id, SPEC, () => {
    got.push('unexpected');
    return Promise.resolve(null);
  });
  await click(await form(), 'prompt-cancel');
  check(!(await cancelled), 'Cancel is a cancel');

  // ---- closing the window ----
  current = null;
  const closed = host.ask(parent.webContents.id, SPEC, () => {
    got.push('unexpected');
    return Promise.resolve(null);
  });
  BrowserWindow.fromWebContents(await form())?.close();
  check(!(await closed), 'closing the window is a cancel');
  check(got.length === 2, 'nothing else reached main');

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
  check(!heard.now, 'a close during a submit waits for the call');
  finishBusy(null);
  check(await busy, 'and reports that it happened');

  // ---- a renderer that dies ----------------------------------------------------------------------
  current = null;
  const crashed = host.ask(parent.webContents.id, SPEC, () => Promise.resolve(null));
  const crashedWc = await form();
  crashedWc.forcefullyCrashRenderer();
  check(!(await crashed), 'a prompt whose renderer died is a cancel');

  console.warn(
    `PROOF prompt-modal ${JSON.stringify({
      driven: 'by a script',
      sandbox,
      modal: true,
      pageWorld: 'no node, no electron, nothing exposed',
      policy,
      otherWindowDropped: true,
      refusalKeptOpen: true,
      cancelAndCloseCancel: true,
      enterOnCancelIgnored: true,
      closeDuringSubmitWaited: true,
      rendererGoneIsCancel: true,
      accountMenu: { present: true, menuBar, itemClicked: 'by a script', opensPrompt: true },
      shortcut: { realKeyEventReachedMain: true, pageSawIt: false, syntheticIgnored: true },
    })}`,
  );
}

protocol.registerSchemesAsPrivileged(privilegedSchemes());
app.setPath('userData', mkdtempSync(join(tmpdir(), 'nutflix-prompt-data-')));
app.on('web-contents-created', (_e, wc) => {
  hardenWebContents(wc);
});
app.on('window-all-closed', () => undefined);
setTimeout(() => {
  console.error('PROMPT-PROOF-FAILED timed out');
  app.exit(1);
}, OVERALL_MS).unref();

app
  .whenReady()
  .then(run)
  .then(
    () => {
      app.exit(0);
    },
    (e: unknown) => {
      console.error(`PROMPT-PROOF-FAILED ${e instanceof Error ? e.message : 'unknown'}`);
      app.exit(1);
    },
  );
