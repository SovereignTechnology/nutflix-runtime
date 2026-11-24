/**
 * Settings › "Chromium's sandbox", shown only while main says this run is without it: main's
 * `sandbox` event (`shells/pear-v3/src/main/rpc-gate.ts`, `mainEvents`), which only main can send
 * this window. Its one button asks main to forget the stored "Run anyway" (`app.sandbox.forget`).
 * Main confirms in a native dialog, deletes the choice, and the next start without the sandbox warns
 * again. This run stays as it is. The page names nothing: the method takes no argument.
 *
 * The section stays the first one of the Settings screen's body while that screen is shown (the
 * seeding panel keeps itself the last). Every value is set with `textContent`.
 */
import type { ControlWorker } from '../worker/pipe.js';

export const SANDBOX_SECTION_ID = 'nutflix-sandbox-choice';
/** Main's event: `{ off: true, forgotten }` while this run is without Chromium's sandbox. */
export const SANDBOX_EVENT = 'sandbox';

export const SANDBOX_OFF_TEXT =
  "Nutflix is running without Chromium's sandbox, because you chose “Run anyway” when it warned " +
  'you. That choice is remembered on this computer, so Nutflix does not warn you again.';
export const SANDBOX_FORGET_TEXT =
  'Forget it, and the next time Nutflix starts without the sandbox it warns you again, with Quit ' +
  'as the default. Nutflix asks you to confirm.';
export const SANDBOX_FORGOTTEN_TEXT =
  'Forgotten. The next time Nutflix starts without the sandbox, it warns you again. The sandbox ' +
  'stays off in this run until you quit.';
export const SANDBOX_KEPT_TEXT = 'Kept. Nothing changed.';

/** The native dialog waits on a person. */
const DIALOG_TIMEOUT_MS = 3_600_000;

export interface SandboxChoiceSection {
  stop(): void;
}

function message(e: unknown): string {
  if (e instanceof Error) {
    const m = /^[a-z-]+: (.*)$/.exec(e.message);
    return (m?.[1] ?? e.message).slice(0, 240);
  }
  return 'that did not work';
}

export function installSandboxChoice(
  root: HTMLElement,
  worker: Pick<ControlWorker, 'call' | 'onEvent'>,
): SandboxChoiceSection {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  if (view === null) return { stop: () => undefined };
  let off = false;
  let forgotten = false;
  let asking = false;

  const section = doc.createElement('section');
  section.id = SANDBOX_SECTION_ID;
  section.className = 'nf-settings__section';
  section.dataset['section'] = SANDBOX_SECTION_ID;
  const head = doc.createElement('header');
  head.className = 'nf-settings__section-head';
  // A level-2 heading in the outline; `<h2>`s are the design system's own sections.
  const heading = doc.createElement('div');
  heading.className = 'nf-settings__section-title';
  heading.textContent = 'Chromium’s sandbox';
  heading.setAttribute('role', 'heading');
  heading.setAttribute('aria-level', '2');
  head.append(heading);
  const group = doc.createElement('div');
  group.className = 'nf-settings__group';
  const why = doc.createElement('p');
  why.id = 'nutflix-sandbox-off';
  why.className = 'nf-settings__desc';
  why.textContent = SANDBOX_OFF_TEXT;
  const what = doc.createElement('p');
  what.className = 'nf-settings__desc';
  what.textContent = SANDBOX_FORGET_TEXT;
  const forget = doc.createElement('button');
  forget.type = 'button';
  forget.id = 'nutflix-sandbox-forget';
  forget.className = 'nf-settings__button';
  forget.textContent = 'Forget “Run anyway”…';
  const status = doc.createElement('p');
  status.id = 'nutflix-sandbox-status';
  status.className = 'nf-settings__desc';
  status.setAttribute('role', 'status');
  group.append(why, what, forget, status);
  section.append(head, group);

  const show = (): void => {
    why.hidden = forgotten;
    what.hidden = forgotten;
    forget.hidden = forgotten;
    forget.disabled = asking;
    if (forgotten) {
      status.textContent = SANDBOX_FORGOTTEN_TEXT;
      status.dataset['state'] = 'forgotten';
    }
  };

  /** Keeps the section first in the Settings body, while that screen is up and the sandbox off. */
  const render = (): void => {
    const body = root.querySelector('.nf-settings__body');
    if (!off || body === null) {
      if (section.isConnected) section.remove();
      return;
    }
    if (body.firstElementChild !== section) body.prepend(section);
  };

  forget.addEventListener('click', () => {
    if (asking || forgotten) return;
    asking = true;
    delete status.dataset['state'];
    status.textContent = '';
    show();
    worker.call('app.sandbox.forget', {}, { timeoutMs: DIALOG_TIMEOUT_MS }).then(
      (r) => {
        asking = false;
        if (r.forgotten) forgotten = true;
        else {
          status.textContent = SANDBOX_KEPT_TEXT;
          status.dataset['state'] = 'kept';
        }
        show();
      },
      (e: unknown) => {
        asking = false;
        status.textContent = message(e);
        status.dataset['state'] = 'error';
        show();
      },
    );
  });

  const offEvent = worker.onEvent((ev) => {
    const m = ev as unknown as Readonly<Record<string, unknown>>;
    if (m['e'] !== SANDBOX_EVENT) return;
    off = m['off'] === true;
    // Only main says so, and a choice forgotten in this run stays forgotten.
    if (m['forgotten'] === true) forgotten = true;
    show();
    render();
  });
  const observer = new view.MutationObserver(render);
  observer.observe(root, { childList: true, subtree: true });
  render();
  return {
    stop: () => {
      offEvent();
      observer.disconnect();
      section.remove();
    },
  };
}
