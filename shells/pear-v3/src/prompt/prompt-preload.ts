/**
 * The prompt window's preload (bundled to `main/prompt-preload.cjs`). It is the whole of that
 * window's code: the page runs no script (`default-src 'none'`), so the form is built here, in the
 * isolated world, with `textContent` only. Nothing is exposed to the page: no `contextBridge`.
 *
 * What the user types goes to main on one channel and the field is cleared at once. Main decides
 * what happens to it (`src/main/prompt-window.ts`).
 */
import { ipcRenderer } from 'electron';

import { PROMPT_CANCEL, PROMPT_ERROR, PROMPT_SHOW, PROMPT_SUBMIT } from '../shared/ids.ts';

interface Spec {
  readonly title: string;
  readonly message: string;
  readonly label: string;
  readonly repeatLabel?: string;
  readonly submit: string;
  readonly minChars: number;
  readonly maxChars: number;
}

function field(id: string, label: string, maxChars: number): [HTMLElement, HTMLInputElement] {
  const row = document.createElement('div');
  row.style.margin = '10px 0';
  const l = document.createElement('label');
  l.htmlFor = id;
  l.textContent = label;
  l.style.display = 'block';
  l.style.marginBottom = '4px';
  const input = document.createElement('input');
  input.id = id;
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = maxChars;
  input.style.width = '100%';
  input.style.boxSizing = 'border-box';
  input.style.padding = '7px';
  input.style.background = '#262626';
  input.style.color = '#f2f2f2';
  input.style.border = '1px solid #555';
  input.style.borderRadius = '4px';
  row.append(l, input);
  return [row, input];
}

function button(id: string, text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.id = id;
  b.type = 'button';
  b.textContent = text;
  b.style.padding = '7px 14px';
  b.style.marginLeft = '8px';
  return b;
}

function show(spec: Spec): void {
  const root = document.getElementById('prompt');
  if (root === null) return;
  document.title = spec.title;
  const body = document.body;
  body.style.margin = '0';
  body.style.padding = '18px';
  body.style.background = '#181818';
  body.style.color = '#f2f2f2';
  body.style.font = '14px system-ui, sans-serif';

  const heading = document.createElement('h1');
  heading.textContent = spec.title;
  heading.style.fontSize = '17px';
  heading.style.margin = '0 0 8px';
  const message = document.createElement('p');
  message.textContent = spec.message;
  message.style.margin = '0 0 6px';
  message.style.lineHeight = '1.4';
  const [row, input] = field('prompt-value', spec.label, spec.maxChars);
  const repeat =
    spec.repeatLabel === undefined ? null : field('prompt-repeat', spec.repeatLabel, spec.maxChars);
  const problem = document.createElement('p');
  problem.id = 'prompt-error';
  problem.setAttribute('role', 'alert');
  problem.style.color = '#ff8a80';
  problem.style.minHeight = '18px';
  problem.style.margin = '6px 0';
  const cancel = button('prompt-cancel', 'Cancel');
  const submit = button('prompt-submit', spec.submit);
  submit.disabled = true;
  const actions = document.createElement('div');
  actions.style.textAlign = 'right';
  actions.append(cancel, submit);
  root.replaceChildren(
    heading,
    message,
    row,
    ...(repeat === null ? [] : [repeat[0]]),
    problem,
    actions,
  );

  const ready = (): boolean =>
    input.value.length >= spec.minChars &&
    input.value.length <= spec.maxChars &&
    (repeat === null || repeat[1].value === input.value);
  const refresh = (): void => {
    submit.disabled = !ready();
  };
  const send = (): void => {
    if (!ready()) return;
    const value = input.value;
    input.value = '';
    if (repeat !== null) repeat[1].value = '';
    submit.disabled = true;
    problem.textContent = '';
    ipcRenderer.send(PROMPT_SUBMIT, value);
  };
  input.addEventListener('input', refresh);
  repeat?.[1].addEventListener('input', refresh);
  submit.addEventListener('click', send);
  cancel.addEventListener('click', () => {
    input.value = '';
    if (repeat !== null) repeat[1].value = '';
    ipcRenderer.send(PROMPT_CANCEL);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      ipcRenderer.send(PROMPT_CANCEL);
    }
  });
  input.focus();
}

ipcRenderer.on(PROMPT_SHOW, (_event, spec: Spec) => {
  if (document.readyState === 'loading')
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        show(spec);
      },
      { once: true },
    );
  else show(spec);
});

ipcRenderer.on(PROMPT_ERROR, (_event, text: unknown) => {
  const el = document.getElementById('prompt-error');
  if (el !== null && typeof text === 'string') el.textContent = text;
  document.getElementById('prompt-value')?.focus();
});
