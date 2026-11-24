/**
 * Settings › "Chromium's sandbox": shown only once main says this run is without it, first in the
 * Settings body (the seeding panel stays last), and its button asks main to forget the stored
 * "Run anyway" with no argument. What main answered is shown; the page decides nothing itself.
 */
import { afterEach, describe, expect, it } from 'vitest';

import type { WorkerEvent } from '@nutflix-runtime/worker';

import { SeedPublish } from '../seeding/controller.js';
import { PANEL_ID, installSeedPublishPanel } from '../seeding/panel.js';
import {
  SANDBOX_EVENT,
  SANDBOX_FORGOTTEN_TEXT,
  SANDBOX_KEPT_TEXT,
  SANDBOX_OFF_TEXT,
  SANDBOX_SECTION_ID,
  installSandboxChoice,
} from '../settings/sandbox-choice.js';
import type { ControlMethod, ControlWorker } from '../worker/pipe.js';

class FakeControl implements ControlWorker {
  readonly calls: { m: string; a: unknown; timeoutMs: number | undefined }[] = [];
  readonly listeners = new Set<(ev: WorkerEvent) => void>();
  answers: Partial<Record<ControlMethod, (a: never) => unknown>> = {};

  call(m: ControlMethod, a: unknown, opts?: { readonly timeoutMs?: number }): Promise<never> {
    this.calls.push({ m, a, timeoutMs: opts?.timeoutMs });
    const f = this.answers[m] as ((x: unknown) => unknown) | undefined;
    if (f === undefined) return Promise.reject(new Error(`internal: no answer for ${m}`));
    try {
      return Promise.resolve(f(a) as never);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error('failed'));
    }
  }

  onEvent(cb: (ev: WorkerEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  emit(ev: unknown): void {
    for (const l of [...this.listeners]) l(ev as WorkerEvent);
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const roots: HTMLElement[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.remove();
});

/** A Settings screen: the design system's body with a section of its own in it. */
function settingsScreen(): { root: HTMLElement; body: HTMLElement } {
  const root = document.createElement('div');
  const body = document.createElement('div');
  body.className = 'nf-settings__body';
  const theirs = document.createElement('section');
  theirs.id = 'design-system-section';
  body.append(theirs);
  root.append(body);
  document.body.append(root);
  roots.push(root);
  return { root, body };
}

const OFF = { op: 'ev', e: SANDBOX_EVENT, off: true, forgotten: false };
const section = (root: HTMLElement): HTMLElement | null =>
  root.querySelector(`#${SANDBOX_SECTION_ID}`);
const button = (root: HTMLElement): HTMLButtonElement | null =>
  root.querySelector('#nutflix-sandbox-forget');
const status = (root: HTMLElement): HTMLElement | null =>
  root.querySelector('#nutflix-sandbox-status');

describe('the sandbox section', () => {
  it('is not there until main says the sandbox is off', async () => {
    const { root } = settingsScreen();
    const w = new FakeControl();
    const s = installSandboxChoice(root, w);
    await settle();
    expect(section(root)).toBeNull();
    // Another event, or the worker's own, says nothing about the sandbox.
    w.emit({ op: 'ev', e: 'status', status: {} });
    w.emit({ op: 'ev', e: SANDBOX_EVENT, off: 'yes' });
    await settle();
    expect(section(root)).toBeNull();
    w.emit(OFF);
    await settle();
    expect(section(root)?.querySelector('#nutflix-sandbox-off')?.textContent).toBe(
      SANDBOX_OFF_TEXT,
    );
    expect(w.calls).toEqual([]);
    s.stop();
    expect(section(root)).toBeNull();
  });

  it('stays first in the Settings body while the seeding panel stays last', async () => {
    const { root, body } = settingsScreen();
    const w = new FakeControl();
    w.answers['seeding.status'] = () => ({ watched: false, videos: [], listening: [] });
    w.answers['signer.status'] = () => ({
      kind: 'none',
      pubkey: null,
      locked: true,
      keyFile: false,
      localAllowed: false,
    });
    w.answers['studio.ffmpeg'] = () => ({ found: true, install: 'x' });
    const panel = installSeedPublishPanel(
      root,
      new SeedPublish({
        worker: w,
        pool: { publish: () => Promise.resolve([]) },
        settings: { get: () => ({}) as never },
      }),
    );
    const s = installSandboxChoice(root, w);
    w.emit(OFF);
    await settle();
    expect(body.firstElementChild?.id).toBe(SANDBOX_SECTION_ID);
    expect(body.lastElementChild?.id).toBe(PANEL_ID);
    // The design system adds a section of its own at either end: both move back, once.
    body.prepend(document.createElement('section'));
    body.append(document.createElement('section'));
    await settle();
    expect(body.firstElementChild?.id).toBe(SANDBOX_SECTION_ID);
    expect(body.lastElementChild?.id).toBe(PANEL_ID);
    expect(body.querySelectorAll(`#${SANDBOX_SECTION_ID}`)).toHaveLength(1);
    // Another screen: gone; Settings again: back.
    body.remove();
    await settle();
    expect(section(root)).toBeNull();
    root.append(body);
    await settle();
    expect(body.firstElementChild?.id).toBe(SANDBOX_SECTION_ID);
    s.stop();
    panel.stop();
  });

  it('asks main with no argument, and shows "forgotten" once main says so', async () => {
    const { root } = settingsScreen();
    const w = new FakeControl();
    w.answers['app.sandbox.forget'] = () => ({ forgotten: true });
    installSandboxChoice(root, w);
    w.emit(OFF);
    await settle();
    button(root)?.click();
    await settle();
    expect(w.calls.map((c) => [c.m, c.a])).toEqual([['app.sandbox.forget', {}]]);
    // The native dialog waits on a person.
    expect(w.calls[0]?.timeoutMs).toBeGreaterThanOrEqual(600_000);
    expect(status(root)?.textContent).toBe(SANDBOX_FORGOTTEN_TEXT);
    expect(status(root)?.dataset['state']).toBe('forgotten');
    expect(button(root)?.hidden).toBe(true);
    // Nothing more to ask.
    button(root)?.click();
    await settle();
    expect(w.calls).toHaveLength(1);
  });

  it('"Keep the choice" changes nothing, and the button stays', async () => {
    const { root } = settingsScreen();
    const w = new FakeControl();
    w.answers['app.sandbox.forget'] = () => ({ forgotten: false });
    installSandboxChoice(root, w);
    w.emit(OFF);
    await settle();
    button(root)?.click();
    await settle();
    expect(status(root)?.textContent).toBe(SANDBOX_KEPT_TEXT);
    expect(button(root)?.hidden).toBe(false);
    expect(button(root)?.disabled).toBe(false);
  });

  it('one question at a time, and a refusal is shown in main’s words', async () => {
    const { root } = settingsScreen();
    const w = new FakeControl();
    let answer: (v: unknown) => void = () => undefined;
    w.answers['app.sandbox.forget'] = () =>
      new Promise((r) => {
        answer = r;
      });
    installSandboxChoice(root, w);
    w.emit(OFF);
    await settle();
    button(root)?.click();
    button(root)?.click();
    await settle();
    expect(w.calls).toHaveLength(1);
    expect(button(root)?.disabled).toBe(true);
    answer(Promise.reject(new Error('rate-limited: a dialog is already open')));
    await settle();
    expect(status(root)?.textContent).toBe('a dialog is already open');
    expect(status(root)?.dataset['state']).toBe('error');
    expect(button(root)?.disabled).toBe(false);
  });

  it('a page loaded after the choice was forgotten says so, with no button', async () => {
    const { root } = settingsScreen();
    const w = new FakeControl();
    installSandboxChoice(root, w);
    w.emit({ ...OFF, forgotten: true });
    await settle();
    expect(status(root)?.textContent).toBe(SANDBOX_FORGOTTEN_TEXT);
    expect(button(root)?.hidden).toBe(true);
  });
});
