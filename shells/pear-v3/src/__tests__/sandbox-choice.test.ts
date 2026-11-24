/**
 * Forgetting the stored "Run anyway" from Settings (`app.sandbox.forget`): main's own method, behind
 * the gate's allow-list and a native confirmation. Forgetting only makes the app safer, but a page
 * must not be able to do anything else through it: it takes no argument, only the main window's
 * policy lists it, it waits for no other dialog and is refused while one is open, a "no" is not
 * asked again for a minute, and a "yes" deletes the choice, so that the next start asks again.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FrameDecoder, encodeFrame } from '@nutflix-runtime/worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsentFile } from '../main/consent-file.ts';
import {
  DECLINED_WAIT_MS,
  MainCalls,
  type MainCallDeps,
  type SandboxChoice,
} from '../main/main-calls.ts';
import { MAIN_WINDOW_POLICY, RpcGate, type WindowPolicy } from '../main/rpc-gate.ts';
import {
  CONSENT_FILE,
  FORGET_DIALOG,
  FORGET_YES,
  WARNING,
  sandboxGate,
  type SandboxGateDeps,
} from '../main/sandbox-gate.ts';

type Msg = Record<string, unknown>;

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const req = (id: number, m: string, a: object = {}): object => ({ op: 'req', id, m, a });

/** A choice that main's deps record, and a dialog the test answers. */
function choice(o: { off?: boolean; yes?: boolean } = {}): {
  sandbox: SandboxChoice;
  asked: () => number;
  forgot: () => number;
  answer: { yes: boolean };
} {
  let asked = 0;
  let forgot = 0;
  const answer = { yes: o.yes ?? false };
  return {
    answer,
    asked: () => asked,
    forgot: () => forgot,
    sandbox: {
      off: () => o.off ?? true,
      confirmForget: () => {
        asked += 1;
        return Promise.resolve(answer.yes);
      },
      forget: () => {
        forgot += 1;
        return Promise.resolve();
      },
    },
  };
}

function deps(extra: Partial<MainCallDeps> = {}): MainCallDeps & { clock: { t: number } } {
  const clock = { t: 1_000_000 };
  return {
    clock,
    now: () => clock.t,
    pickFile: () => Promise.resolve(null),
    confirmSeeding: () => Promise.resolve(false),
    confirmPublish: () => Promise.resolve(false),
    confirmVideo: () => Promise.resolve(false),
    askSecret: () => Promise.resolve(false),
    worker: (m) => Promise.resolve({ answered: m }),
    ...extra,
  };
}

/** The real gate in front of the real `MainCalls`, as `main.ts` wires them. */
function harness(calls: MainCalls) {
  const toWorker: Msg[] = [];
  const toWindow = new Map<number, Msg[]>();
  const workerSide = new FrameDecoder((m) => toWorker.push(m as Msg));
  const windows = new Map<number, FrameDecoder>();
  const mainCall = vi.fn((id: number, m: string, a: Record<string, unknown>) =>
    calls.answer(id, m, a),
  );
  const gate = new RpcGate({
    toWorker: (f) => {
      workerSide.push(f);
    },
    toWindow: (id, f) => {
      let d = windows.get(id);
      if (d === undefined) {
        const list: Msg[] = [];
        toWindow.set(id, list);
        d = new FrameDecoder((m) => list.push(m as Msg));
        windows.set(id, d);
      }
      d.push(f);
    },
    closeWindow: () => undefined,
    mainCall,
  });
  return {
    gate,
    toWorker,
    toWindow,
    mainCall,
    ask: (windowId: number, msg: object): void => {
      gate.fromWindow(windowId, encodeFrame(msg));
    },
  };
}

const codeOf = (m: Msg | undefined): unknown => (m?.['e'] as Msg | undefined)?.['code'];

describe('app.sandbox.forget through the gate', () => {
  it('is main’s, for the main window, and the worker never sees it', async () => {
    expect(MAIN_WINDOW_POLICY.mainMethods?.has('app.sandbox.forget')).toBe(true);
    expect(MAIN_WINDOW_POLICY.methods.has('app.sandbox.forget')).toBe(false);
    expect(MAIN_WINDOW_POLICY.mainEvents?.has('sandbox')).toBe(true);
    const c = choice({ yes: true });
    const h = harness(new MainCalls(deps({ sandboxChoice: c.sandbox })));
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(4, 'app.sandbox.forget'));
    await flush();
    expect(h.toWorker).toEqual([]);
    expect(h.toWindow.get(1)).toEqual([{ op: 'res', id: 4, ok: true, r: { forgotten: true } }]);
    expect(c.forgot()).toBe(1);
  });

  it.each([
    [{ path: '/etc/passwd' }],
    [{ file: 'sandbox-consent.json' }],
    [{ forgotten: true }],
    [{ on: false }],
    [JSON.parse('{"__proto__":{"x":1}}') as object],
  ])('refuses arguments %j: no box, nothing forgotten', async (args) => {
    const c = choice({ yes: true });
    const h = harness(new MainCalls(deps({ sandboxChoice: c.sandbox })));
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(1, 'app.sandbox.forget', args));
    await flush();
    expect(codeOf(h.toWindow.get(1)?.[0])).toBe('invalid-argument');
    expect(c.asked()).toBe(0);
    expect(c.forgot()).toBe(0);
    expect(h.toWorker).toEqual([]);
  });

  it('refuses arguments that are not an object at all', async () => {
    const c = choice({ yes: true });
    const h = harness(new MainCalls(deps({ sandboxChoice: c.sandbox })));
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    for (const [id, a] of [
      [1, []],
      [2, 'x'],
      [3, null],
    ] as const)
      h.gate.fromWindow(1, encodeFrame({ op: 'req', id, m: 'app.sandbox.forget', a }));
    await flush();
    expect(h.toWindow.get(1)?.map(codeOf)).toEqual([
      'invalid-argument',
      'invalid-argument',
      'invalid-argument',
    ]);
    expect(h.mainCall).not.toHaveBeenCalled();
    expect(c.asked() + c.forgot()).toBe(0);
  });

  it('another window cannot call it: a policy without it, or no policy at all', async () => {
    const c = choice({ yes: true });
    const h = harness(new MainCalls(deps({ sandboxChoice: c.sandbox })));
    const other: WindowPolicy = {
      ...MAIN_WINDOW_POLICY,
      mainMethods: new Set(
        [...(MAIN_WINDOW_POLICY.mainMethods ?? [])].filter((m) => m !== 'app.sandbox.forget'),
      ),
    };
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.gate.attach(2, other);
    h.ask(2, req(1, 'app.sandbox.forget'));
    // Window 3 was never attached: what it writes goes nowhere.
    h.ask(3, req(1, 'app.sandbox.forget'));
    await flush();
    expect(codeOf(h.toWindow.get(2)?.[0])).toBe('invalid-argument');
    expect(h.toWindow.get(3)).toBeUndefined();
    expect(h.toWindow.get(1)).toBeUndefined();
    expect(h.mainCall).not.toHaveBeenCalled();
    expect(c.asked() + c.forgot()).toBe(0);
  });

  it('is refused while another dialog is open, and holds the lock while its own is', async () => {
    let closeVideo: (yes: boolean) => void = () => undefined;
    const c = choice({ yes: true });
    const calls = new MainCalls(
      deps({
        sandboxChoice: c.sandbox,
        confirmVideo: () =>
          new Promise((r) => {
            closeVideo = r;
          }),
        worker: (m) =>
          Promise.resolve(
            m === 'seeding.status'
              ? { videos: [{ video: 'v', origin: 'published', bytes: 1 }] }
              : { title: null },
          ),
      }),
    );
    const h = harness(calls);
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(1, 'app.seeding.delete', { video: 'v' }));
    await flush();
    h.ask(1, req(2, 'app.sandbox.forget'));
    await flush();
    expect(h.toWindow.get(1)?.map((m) => [m['id'], codeOf(m)])).toEqual([[2, 'rate-limited']]);
    expect(c.asked() + c.forgot()).toBe(0);
    closeVideo(false);
    await flush();

    // Its own box open: every other dialog waits, and the Account menu says so.
    let closeForget: (yes: boolean) => void = () => undefined;
    const held = new MainCalls(
      deps({
        sandboxChoice: {
          ...c.sandbox,
          confirmForget: () =>
            new Promise((r) => {
              closeForget = r;
            }),
        },
      }),
    );
    const open = held.answer(1, 'app.sandbox.forget', {});
    await flush();
    await expect(held.answer(1, 'app.pickVideo', {})).rejects.toMatchObject({
      code: 'rate-limited',
    });
    expect((await held.account(1, 'connect')).problem).toMatch(/dialog is open/);
    closeForget(false);
    expect(await open).toEqual({ forgotten: false });
  });
});

describe('the answer', () => {
  it('"no" keeps the choice and is not asked again for a minute', async () => {
    const c = choice({ yes: false });
    const d = deps({ sandboxChoice: c.sandbox });
    const m = new MainCalls(d);
    expect(await m.answer(1, 'app.sandbox.forget', {})).toEqual({ forgotten: false });
    expect(c.forgot()).toBe(0);
    await expect(m.answer(1, 'app.sandbox.forget', {})).rejects.toMatchObject({
      code: 'rate-limited',
    });
    expect(c.asked()).toBe(1);
    d.clock.t += DECLINED_WAIT_MS;
    c.answer.yes = true;
    expect(await m.answer(1, 'app.sandbox.forget', {})).toEqual({ forgotten: true });
    expect([c.asked(), c.forgot()]).toEqual([2, 1]);
    expect(m.sandboxChoiceForgotten).toBe(true);
  });

  it('"yes" forgets it once; asking again opens no box', async () => {
    const c = choice({ yes: true });
    const m = new MainCalls(deps({ sandboxChoice: c.sandbox }));
    expect(m.sandboxChoiceForgotten).toBe(false);
    expect(await m.answer(1, 'app.sandbox.forget', {})).toEqual({ forgotten: true });
    expect(await m.answer(1, 'app.sandbox.forget', {})).toEqual({ forgotten: true });
    expect([c.asked(), c.forgot()]).toEqual([1, 1]);
  });

  it('is refused with the sandbox on, or with no choice wired in', async () => {
    const c = choice({ off: false, yes: true });
    await expect(
      new MainCalls(deps({ sandboxChoice: c.sandbox })).answer(1, 'app.sandbox.forget', {}),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(new MainCalls(deps()).answer(1, 'app.sandbox.forget', {})).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(c.asked() + c.forgot()).toBe(0);
  });

  it('a failed delete says so, and is not counted as forgotten', async () => {
    const c = choice({ yes: true });
    const m = new MainCalls(
      deps({
        sandboxChoice: { ...c.sandbox, forget: () => Promise.reject(new Error('EACCES /home/u')) },
      }),
    );
    await expect(m.answer(1, 'app.sandbox.forget', {})).rejects.toMatchObject({
      code: 'io',
      message: expect.not.stringContaining('/home') as unknown,
    });
    expect(m.sandboxChoiceForgotten).toBe(false);
  });

  it('the box keeps the choice by default, and says this run stays as it is', () => {
    expect(FORGET_DIALOG.buttons[FORGET_YES]).toBe('Forget it');
    expect([FORGET_DIALOG.defaultId, FORGET_DIALOG.cancelId]).toEqual([0, 0]);
    expect(FORGET_DIALOG.detail).toMatch(/warns you again/);
    expect(FORGET_DIALOG.detail).toMatch(/This run stays as it is/);
    expect(WARNING.detail).toMatch(/Settings/);
    expect(WARNING.detail).toMatch(/--forget-sandbox-choice/);
  });
});

describe('the stored choice on disk', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nutflix-consent-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** One start with `--no-sandbox`: what `main.ts` does before any window. */
  function start(
    file: ConsentFile,
    answer: 'quit' | 'run-anyway',
  ): {
    outcome: ReturnType<typeof sandboxGate>;
    asked: number;
  } {
    let asked = 0;
    const d: SandboxGateDeps = {
      noSandbox: true,
      readConsent: () => file.read(),
      writeConsent: (c) => {
        file.write(c, () => undefined);
      },
      ask: () => {
        asked += 1;
        return answer;
      },
      now: () => new Date('2026-11-23T10:00:00Z'),
      log: () => undefined,
    };
    return { outcome: sandboxGate(d), asked };
  }

  /** Settings, with the real file behind it. */
  const settings = (file: ConsentFile, yes: boolean): MainCalls =>
    new MainCalls(
      deps({
        sandboxChoice: {
          off: () => true,
          confirmForget: () => Promise.resolve(yes),
          forget: () => file.forget(),
        },
      }),
    );

  it('"no" leaves it, and the next start does not ask', async () => {
    const file = new ConsentFile(join(dir, CONSENT_FILE));
    const stored = `${JSON.stringify({ v: 1, choice: 'run-anyway', at: '2026-11-23T10:00:00.000Z' })}\n`;
    writeFileSync(file.path, stored);
    expect(start(file, 'quit')).toMatchObject({ asked: 0, outcome: { via: 'stored-choice' } });
    expect(await settings(file, false).answer(1, 'app.sandbox.forget', {})).toEqual({
      forgotten: false,
    });
    expect(readFileSync(file.path, 'utf8')).toBe(stored);
    expect(start(file, 'quit')).toMatchObject({ asked: 0, outcome: { via: 'stored-choice' } });
  });

  it('"yes" deletes it, and the next start asks again (Quit is still the default)', async () => {
    const file = new ConsentFile(join(dir, CONSENT_FILE));
    // The first start: "Run anyway", stored in the background.
    expect(start(file, 'run-anyway')).toMatchObject({ asked: 1, outcome: { via: 'asked' } });
    // Forgetting waits for that write, so the choice cannot come back after it.
    expect(await settings(file, true).answer(1, 'app.sandbox.forget', {})).toEqual({
      forgotten: true,
    });
    expect(existsSync(file.path)).toBe(false);
    expect(start(file, 'quit')).toEqual({ asked: 1, outcome: { run: false } });
  });

  it('no file counts as forgotten; one that cannot be deleted is not', async () => {
    await expect(new ConsentFile(join(dir, CONSENT_FILE)).forget()).resolves.toBeUndefined();
    // A directory where the file should be: `rm` without `recursive` refuses it.
    const stuck = join(dir, 'stuck');
    mkdirSync(stuck);
    const m = settings(new ConsentFile(stuck), true);
    await expect(m.answer(1, 'app.sandbox.forget', {})).rejects.toMatchObject({ code: 'io' });
    expect(m.sandboxChoiceForgotten).toBe(false);
    expect(existsSync(stuck)).toBe(true);
  });
});
