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
 *   - an accepted value closes it, and Cancel and closing the window both count as a cancel.
 *
 * What it does not show: a person using the window, how it looks, and any native message box.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BrowserWindow,
  app,
  ipcMain,
  protocol,
  session,
  webContents,
  type WebContents,
} from 'electron';

import {
  PROMPT_PARTITION,
  PromptHost,
  installPromptSession,
  openPrompt,
  promptSender,
  type PromptSpec,
} from '../src/main/prompt-window.ts';
import { fromProcStatus } from '../src/main/sandbox-proof.ts';
import { privilegedSchemes } from '../src/main/schemes.ts';
import { hardenWebContents } from '../src/main/security.ts';
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

const click = (wc: WebContents, id: string): Promise<void> =>
  inPage(wc, `document.getElementById(${JSON.stringify(id)}).click()`);

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

  const parent = new BrowserWindow({
    width: 640,
    height: 480,
    webPreferences: {
      preload: join(__dirname, 'proof-preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
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
    await until('the form', async () =>
      (await inPage<boolean>(wc, `document.getElementById('prompt-submit') !== null`))
        ? true
        : null,
    );
    return wc;
  };

  // ---- the first prompt: confinement, the sender check, a refusal, then an accepted value ----
  const got: string[] = [];
  const answers: (string | null)[] = ['not that one', null];
  const first = host.ask(parent.webContents.id, SPEC, (value) => {
    got.push(value);
    return Promise.resolve(answers.shift() ?? null);
  });
  const wc = await form();

  const sandbox = fromProcStatus(
    readFileSync(`/proc/${String(wc.getOSProcessId())}/status`, 'utf8'),
  );
  check(sandbox === 'enforced', `the renderer's sandbox is ${sandbox}`);
  const win = BrowserWindow.fromWebContents(wc);
  check(win?.isModal() === true, 'the window is modal');
  check(win?.getParentWindow()?.id === parent.id, 'it belongs to its parent');
  check(wc.getURL() === 'app://prompt/prompt.html', 'it shows its one file');

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
