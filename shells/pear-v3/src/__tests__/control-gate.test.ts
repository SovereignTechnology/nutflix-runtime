/**
 * The gate for seeding, publishing and the signer: what the renderer's window may reach, and what
 * it must not do alone. It never names a path or holds a secret (main's picker and prompt window
 * do), and whatever shares the user's IP address or deletes a video takes a native confirmation.
 */
import {
  FrameDecoder,
  WorkerError,
  encodeFrame,
  type SignerStatusWire,
} from '@nutflix-runtime/worker';
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  MenuItemConstructorOptions,
  Session,
} from 'electron';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROMPT_CANCEL, PROMPT_SUBMIT } from '../shared/ids.ts';
import {
  ACCOUNT_ITEMS,
  ACCOUNT_MENU_LABEL,
  ACCOUNT_REPEAT_MS,
  AccountRunner,
  accountMenuPresent,
  accountShortcut,
  applicationMenu,
  menuBarState,
  type KeyInput,
} from '../main/account-menu.ts';
import {
  CONFIRM_SEEDING_DIALOG,
  CONNECT_BUNKER_PROMPT,
  CREATE_KEY_PROMPT,
  DECLINED_WAIT_MS,
  MainCalls,
  NO_SANDBOX_KEY_TEXT,
  PICK_VIDEO_DIALOG,
  PROMPT_DECLINED_WAIT_MS,
  UNLOCK_KEY_PROMPT,
  publishDialog,
  shownText,
  videoDialog,
  type MainCallDeps,
  type PublishShown,
  type VideoShown,
} from '../main/main-calls.ts';
import {
  PROMPT_CSP,
  PROMPT_SHOW_DEADLINE_MS,
  PROMPT_URL,
  PromptHost,
  allowPromptRequest,
  createPromptProtocolHandler,
  createPromptWindow,
  openPrompt,
  type OpenPromptOptions,
  type PromptSpec,
  type PromptWindowCtor,
} from '../main/prompt-window.ts';
import { MAIN_WINDOW_POLICY, RpcGate, type RpcGateDeps } from '../main/rpc-gate.ts';

type Msg = Record<string, unknown>;

const SID = 'ab'.repeat(16);
const SID2 = 'cd'.repeat(16);

function harness(mainCall?: RpcGateDeps['mainCall']): {
  gate: RpcGate;
  toWorker: Msg[];
  toWindow: Map<number, Msg[]>;
  ask(windowId: number, msg: object): void;
  answer(msg: object): void;
} {
  const toWorker: Msg[] = [];
  const toWindow = new Map<number, Msg[]>();
  const workerSide = new FrameDecoder((m) => toWorker.push(m as Msg));
  const windows = new Map<number, FrameDecoder>();
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
    ...(mainCall === undefined ? {} : { mainCall }),
  });
  return {
    gate,
    toWorker,
    toWindow,
    ask: (windowId, msg) => {
      gate.fromWindow(windowId, encodeFrame(msg));
    },
    answer: (msg) => {
      gate.fromWorker(encodeFrame(msg));
    },
  };
}

const req = (id: number, m: string, a: object = {}): object => ({ op: 'req', id, m, a });
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('the window’s allow-list', () => {
  it.each([
    'signer.status',
    'seeding.status',
    'seeding.stop',
    'seeding.beacons',
    'studio.ffmpeg',
    'studio.probe',
    'studio.publish',
    'studio.cancel',
  ])('forwards %s to the worker', (m) => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(1, m));
    expect(h.toWorker.map((x) => x['m'])).toEqual([m]);
  });

  it.each([
    // Main's own, or the host's: a page must never reach them.
    'init',
    'seeding.set',
    'seeding.resume',
    'seeding.delete',
    'studio.source',
    'studio.discard',
    'signer.local.create',
    'signer.local.unlock',
    'signer.nip46.connect',
    'signer.check',
    'signer.sign',
    'nfx.seed.start',
    'nfx.seed.stop',
    'nfx.seed.list',
    'nfx.endpoint',
    // Nothing of a paid path exists to call.
    'wallet.send',
    'pay.open',
    'cashu.melt',
    'signer.nip44.decrypt',
    'signer.export',
  ])('refuses %s, which never reaches the worker', (m) => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(5, m, { path: '/etc/passwd', watched: true }));
    expect(h.toWorker).toEqual([]);
    expect(h.toWindow.get(1)).toEqual([
      {
        op: 'res',
        id: 5,
        ok: false,
        e: { code: 'invalid-argument', message: 'invalid-argument: method not allowed' },
      },
    ]);
  });

  it('hears Studio’s progress; it hears no log and no seed events', () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.answer({ op: 'ev', e: 'studio.progress', stage: 'encoding', percent: 5 });
    h.answer({ op: 'ev', e: 'log', level: 'info', msg: 'x' });
    h.answer({ op: 'ev', e: 'nfx.seed', video: 'v', state: 'seeding' });
    expect(h.toWindow.get(1)?.map((m) => m['e'])).toEqual(['studio.progress']);
  });

  it('a `serving` from main reaches the window; the same name from the worker does not', () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.answer({ op: 'ev', e: 'serving', networks: 9 });
    expect(h.toWindow.get(1)).toBeUndefined();
    h.gate.fromMain('serving', { networks: 1 });
    expect(h.toWindow.get(1)).toEqual([{ op: 'ev', e: 'serving', networks: 1 }]);
  });
});

describe.each(['seeding.segment', 'seeding.watch'])('%s', (method) => {
  const offer = (sid: string): object => ({
    sid,
    sha256: 'ef'.repeat(32),
    size: 3,
    offset: 0,
    data: 'AAAA',
  });

  it('needs a play session this window opened', () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.gate.attach(2, MAIN_WINDOW_POLICY);
    h.ask(1, req(1, 'nfx.play.open', { sid: SID }));
    h.answer({ op: 'res', id: h.toWorker[0]?.['id'], ok: true, r: {} });
    h.toWorker.length = 0;

    h.ask(2, req(1, method, offer(SID)));
    h.ask(1, req(2, method, offer(SID2)));
    h.ask(1, req(3, method, { ...offer(SID), sid: 42 }));
    expect(h.toWorker).toEqual([]);
    for (const list of [h.toWindow.get(2), h.toWindow.get(1)?.slice(1)])
      for (const m of list ?? [])
        expect(m['e']).toEqual({
          code: 'invalid-argument',
          message: 'invalid-argument: not a play session of this window',
        });

    h.ask(1, req(4, method, offer(SID)));
    expect(h.toWorker.map((m) => m['m'])).toEqual([method]);
  });
});

describe('what main answers itself', () => {
  it('answers on the window’s id, and the worker never sees the method', async () => {
    const call = vi.fn(() => Promise.resolve({ source: 'x', name: 'clip.mp4', bytes: 1 }));
    const h = harness(call);
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(9, 'app.pickVideo'));
    await flush();
    expect(h.toWorker).toEqual([]);
    expect(call).toHaveBeenCalledWith(1, 'app.pickVideo', {});
    expect(h.toWindow.get(1)).toEqual([
      { op: 'res', id: 9, ok: true, r: { source: 'x', name: 'clip.mp4', bytes: 1 } },
    ]);
  });

  it.each([
    'app.pickVideo',
    'app.seeding.set',
    'app.seeding.resume',
    'app.seeding.delete',
    'app.publish.sign',
  ])('%s is main’s', (m) => {
    expect(MAIN_WINDOW_POLICY.mainMethods?.has(m)).toBe(true);
    expect(MAIN_WINDOW_POLICY.methods.has(m)).toBe(false);
  });

  it.each([
    'app.signer.create',
    'app.signer.unlock',
    'app.signer.connect',
    'signer.lock',
    'signer.local.create',
    'signer.local.unlock',
    'signer.nip46.connect',
  ])('no window can call %s: secret entry is the native menu’s', async (m) => {
    const call = vi.fn(() => Promise.resolve(null));
    const h = harness(call);
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(7, m));
    await flush();
    expect(call).not.toHaveBeenCalled();
    expect(h.toWorker).toEqual([]);
    expect(h.toWindow.get(1)?.map((x) => (x['e'] as Msg)['code'])).toEqual(['invalid-argument']);
    expect(MAIN_WINDOW_POLICY.methods.has(m)).toBe(false);
    expect(MAIN_WINDOW_POLICY.mainMethods?.has(m)).toBe(false);
  });

  it('passes on only a WorkerError’s words', async () => {
    const h = harness((_w, m) =>
      Promise.reject(
        m === 'app.pickVideo'
          ? new WorkerError('not-found', 'that is not a file')
          : new Error('secret /home/user/path'),
      ),
    );
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(1, 'app.pickVideo'));
    h.ask(1, req(2, 'app.seeding.set', { on: true }));
    await flush();
    expect(h.toWindow.get(1)?.map((m) => m['e'])).toEqual([
      { code: 'not-found', message: 'not-found: that is not a file' },
      { code: 'internal', message: 'internal: internal error' },
    ]);
  });

  it('counts against the window’s limit while a dialog is open', async () => {
    let finish: (v: unknown) => void = () => undefined;
    const h = harness(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    h.gate.attach(1, { ...MAIN_WINDOW_POLICY, maxInflight: 1 });
    h.ask(1, req(1, 'app.pickVideo'));
    h.ask(1, req(2, 'status'));
    h.ask(1, req(1, 'app.pickVideo'));
    expect(h.toWorker).toEqual([]);
    expect(h.toWindow.get(1)?.map((m) => (m['e'] as Msg)['code'])).toEqual([
      'rate-limited',
      'invalid-argument',
    ]);
    finish(null);
    await flush();
    h.ask(1, req(3, 'status'));
    expect(h.toWorker.map((m) => m['m'])).toEqual(['status']);
  });

  it('with no handler, refuses', () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(1, 'app.pickVideo'));
    expect(h.toWindow.get(1)?.[0]?.['ok']).toBe(false);
    expect(h.toWorker).toEqual([]);
  });

  it('drops the answer for a window that went away', async () => {
    let finish: (v: unknown) => void = () => undefined;
    const h = harness(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(1, 'app.pickVideo'));
    h.gate.detach(1);
    finish({ source: 'x' });
    await flush();
    expect(h.toWindow.get(1)).toBeUndefined();
  });
});

const NO_KEY: SignerStatusWire = {
  kind: 'none',
  pubkey: null,
  locked: true,
  keyFile: false,
  localAllowed: true,
};
const SEALED: SignerStatusWire = {
  ...NO_KEY,
  kind: 'local',
  pubkey: 'ab'.repeat(32),
  keyFile: true,
};
const KEY = 'ab'.repeat(32);
const VIDEO = `nfx:testnet:1:nutflix-${'a'.repeat(32)}`;
const CHECK: PublishShown = {
  video: VIDEO,
  event: { kind: 38504, created_at: 1, tags: [], content: '' },
  signer: KEY,
  npub: 'npub1thewholekeyasthebechtext',
  title: 'The worker’s title',
  tags: ['cats'],
  description: 'A line.',
  file: { name: 'holiday.mp4', bytes: 12 * 1024 * 1024, durationSec: 83 },
};

function deps(
  o: {
    path?: string | null;
    yes?: boolean;
    publish?: boolean;
    video?: boolean;
    secrets?: readonly (string | null)[];
    status?: SignerStatusWire;
  } = {},
): {
  d: MainCallDeps;
  m: MainCalls;
  calls: [string, Record<string, unknown>][];
  picks: () => number;
  confirms: () => number;
  shown: PublishShown[];
  videos: [string, VideoShown][];
  specs: PromptSpec[];
  problems: (string | null)[];
  clock: { t: number };
} {
  const calls: [string, Record<string, unknown>][] = [];
  const shown: PublishShown[] = [];
  const videos: [string, VideoShown][] = [];
  const specs: PromptSpec[] = [];
  const problems: (string | null)[] = [];
  const clock = { t: 1_000_000 };
  let picks = 0;
  let confirms = 0;
  const d: MainCallDeps = {
    now: () => clock.t,
    pickFile: () => {
      picks += 1;
      return Promise.resolve(o.path === undefined ? '/home/u/clip.mp4' : o.path);
    },
    confirmSeeding: () => {
      confirms += 1;
      return Promise.resolve(o.yes === true);
    },
    confirmPublish: (_id, x) => {
      shown.push(x);
      return Promise.resolve(o.publish === true);
    },
    confirmVideo: (_id, action, v) => {
      videos.push([action, v]);
      return Promise.resolve(o.video === true);
    },
    askSecret: async (_id, spec, submit) => {
      specs.push(spec);
      for (const value of o.secrets ?? []) {
        if (value === null) return false;
        const problem = await submit(value);
        problems.push(problem);
        if (problem === null) return true;
      }
      return false;
    },
    worker: (m, a) => {
      calls.push([m, a]);
      if (m === 'signer.check') return Promise.resolve(CHECK);
      if (m === 'signer.status') return Promise.resolve(o.status ?? NO_KEY);
      if (m === 'seeding.status')
        return Promise.resolve({
          answered: m,
          videos: [{ video: VIDEO, origin: 'published', bytes: 1024 }],
        });
      if (a['passphrase'] === 'the wrong one')
        return Promise.reject(new WorkerError('bad-passphrase', 'that does not open this key'));
      return Promise.resolve({ answered: m });
    },
  };
  return {
    d,
    m: new MainCalls(d),
    calls,
    picks: () => picks,
    confirms: () => confirms,
    shown,
    videos,
    specs,
    problems,
    clock,
  };
}

describe('the file picker', () => {
  it('a picked path goes to the worker; the page gets only the worker’s token', async () => {
    const t = deps();
    expect(await t.m.answer(1, 'app.pickVideo', {})).toEqual({ answered: 'studio.source' });
    expect(t.calls).toEqual([['studio.source', { path: '/home/u/clip.mp4' }]]);
  });

  it('a cancelled pick reaches nothing', async () => {
    const t = deps({ path: null });
    expect(await t.m.answer(1, 'app.pickVideo', {})).toBeNull();
    expect(t.calls).toEqual([]);
  });

  it.each([
    [{ path: '/etc/passwd' }],
    [{ file: '/etc/passwd' }],
    [{ defaultPath: '/etc' }],
    [{ filters: [] }],
  ])('a page cannot steer the picker: %j', async (args) => {
    const t = deps();
    await expect(t.m.answer(1, 'app.pickVideo', args)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(t.picks()).toBe(0);
    expect(t.calls).toEqual([]);
  });

  it('opens one file and no directory', () => {
    expect(PICK_VIDEO_DIALOG.properties).toEqual(['openFile']);
  });
});

describe('the seeding switch', () => {
  it('turning it on takes the user’s yes', async () => {
    const t = deps({ yes: true });
    await t.m.answer(1, 'app.seeding.set', { on: true });
    expect(t.confirms()).toBe(1);
    expect(t.calls).toEqual([['seeding.set', { watched: true }]]);
  });

  it('a no leaves it off, and answers with the current state', async () => {
    const t = deps({ yes: false });
    expect(await t.m.answer(1, 'app.seeding.set', { on: true })).toMatchObject({
      answered: 'seeding.status',
    });
    expect(t.calls).toEqual([['seeding.status', {}]]);
  });

  it('turning it off asks nothing, and works while another dialog is open', async () => {
    let close: (yes: boolean) => void = () => undefined;
    const t = deps();
    const m = new MainCalls({
      ...t.d,
      confirmPublish: () =>
        new Promise((r) => {
          close = r;
        }),
    });
    const open = m.answer(1, 'app.publish.sign', { video: VIDEO });
    await flush();
    await m.answer(1, 'app.seeding.set', { on: false });
    expect(t.calls.at(-1)).toEqual(['seeding.set', { watched: false }]);
    expect(t.confirms()).toBe(0);
    close(false);
    await open;
  });

  it('a "no" is not asked again for a minute', async () => {
    const t = deps({ yes: false });
    await t.m.answer(1, 'app.seeding.set', { on: true });
    await expect(t.m.answer(1, 'app.seeding.set', { on: true })).rejects.toMatchObject({
      code: 'rate-limited',
    });
    expect(t.confirms()).toBe(1);
    t.clock.t += DECLINED_WAIT_MS;
    await t.m.answer(1, 'app.seeding.set', { on: true });
    expect(t.confirms()).toBe(2);
  });

  it.each([[{}], [{ on: 'true' }], [{ on: 1 }], [{ on: true, watched: true }]])(
    'refuses %j',
    async (args) => {
      const t = deps({ yes: true });
      await expect(t.m.answer(1, 'app.seeding.set', args)).rejects.toMatchObject({
        code: 'invalid-argument',
      });
      expect(t.confirms()).toBe(0);
      expect(t.calls).toEqual([]);
    },
  );

  it('says plainly what seeding shares, with "off" as the default answer', () => {
    expect(CONFIRM_SEEDING_DIALOG.message).toMatch(/shares your IP address with viewers/);
    expect(CONFIRM_SEEDING_DIALOG.defaultId).toBe(0);
    expect(CONFIRM_SEEDING_DIALOG.cancelId).toBe(0);
    expect(CONFIRM_SEEDING_DIALOG.buttons[0]).toBe('Keep it off');
  });
});

describe('publishing', () => {
  it('signs after a yes, with the event and the key the worker named', async () => {
    const t = deps({ publish: true });
    expect(await t.m.answer(1, 'app.publish.sign', { video: VIDEO })).toEqual({
      answered: 'signer.sign',
    });
    expect(t.calls).toEqual([
      ['signer.check', { video: VIDEO }],
      ['signer.sign', { event: CHECK.event, signer: KEY }],
    ]);
    expect(t.shown).toEqual([CHECK]);
  });

  it('a "no" deletes the draft, signs nothing, and is not asked again for a minute', async () => {
    const t = deps({ publish: false });
    expect(await t.m.answer(1, 'app.publish.sign', { video: VIDEO })).toBeNull();
    expect(t.calls.map(([m]) => m)).toEqual(['signer.check', 'studio.discard']);
    expect(t.calls[1]?.[1]).toEqual({ video: VIDEO });
    await expect(t.m.answer(1, 'app.publish.sign', { video: VIDEO })).rejects.toMatchObject({
      code: 'rate-limited',
    });
    expect(t.shown).toHaveLength(1);
  });

  it('a failed signature keeps the draft, for another try', async () => {
    const t = deps({ publish: true });
    const m = new MainCalls({
      ...t.d,
      worker: (name, a) => {
        t.calls.push([name, a]);
        return name === 'signer.check'
          ? Promise.resolve(CHECK)
          : Promise.reject(new WorkerError('no-signer', 'the signer did not sign this event'));
      },
    });
    await expect(m.answer(1, 'app.publish.sign', { video: VIDEO })).rejects.toMatchObject({
      code: 'no-signer',
    });
    expect(t.calls.map(([x]) => x)).toEqual(['signer.check', 'signer.sign']);
  });

  it('asks nothing about a video the worker has no draft for', async () => {
    const t = deps({ publish: true });
    const m = new MainCalls({
      ...t.d,
      worker: () => Promise.reject(new WorkerError('invalid-argument', 'no draft')),
    });
    await expect(m.answer(1, 'app.publish.sign', { video: VIDEO })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(t.shown).toEqual([]);
  });

  it('a page cannot change the signer under the open dialog', async () => {
    let close: (yes: boolean) => void = () => undefined;
    const t = deps({ secrets: ['a passphrase'] });
    const m = new MainCalls({
      ...t.d,
      confirmPublish: () =>
        new Promise((r) => {
          close = r;
        }),
    });
    const open = m.answer(1, 'app.publish.sign', { video: VIDEO });
    await flush();
    for (const action of ['connect', 'unlock', 'create', 'lock'] as const)
      expect((await m.account(1, action)).problem).toMatch(/dialog is open/);
    expect(t.specs).toEqual([]);
    expect(t.calls.some(([x]) => x === 'signer.lock')).toBe(false);
    close(true);
    await open;
    expect(t.calls.at(-1)).toEqual(['signer.sign', { event: CHECK.event, signer: KEY }]);
  });

  it.each([[{}], [{ video: VIDEO, event: {} }], [{ video: 7 }], [{ video: 'x'.repeat(257) }]])(
    'refuses %j',
    async (args) => {
      const t = deps({ publish: true });
      await expect(t.m.answer(1, 'app.publish.sign', args)).rejects.toMatchObject({
        code: 'invalid-argument',
      });
      expect(t.calls).toEqual([]);
    },
  );
});

describe('what the publish box shows', () => {
  const box = (o: Partial<PublishShown>): ReturnType<typeof publishDialog> =>
    publishDialog({ ...CHECK, ...o });

  it('the file, its size and length, and the WHOLE key, before anything a page typed', () => {
    const lines = box({}).detail.split('\n');
    expect(lines[0]).toBe('File: holiday.mp4 (12.0 MiB, 1:23)');
    expect(lines[1]).toBe(`Signed by: ${CHECK.npub}`);
    expect(lines[2]).toBe('Title: The worker’s title');
    expect(lines[3]).toBe('Tags: #cats');
  });

  it('says what publishing shares, with "do not" as the default answer', () => {
    const b = box({});
    expect(b.message).toMatch(/shares your IP address with viewers/);
    expect([b.defaultId, b.cancelId]).toEqual([0, 0]);
    expect(b.buttons[0]).toBe('Do not publish');
  });

  it('a title cannot draw a line of its own, or reorder the text', () => {
    const spoof = `Cat\u2028Signed by: npub1fake\u2029\nx\u202eb\u061c\u200b\u{E0041}`;
    const b = box({ title: spoof });
    const lines = b.detail.split('\n');
    expect(lines[1]).toBe(`Signed by: ${CHECK.npub}`);
    expect(lines[2]).toBe('Title: CatSigned by: npub1fakexb');
    expect(b.detail).not.toMatch(/[\u2028\u2029\u202e\u061c\u200b]/u);
  });

  it('shows the whole title, however long', () => {
    const title = 'x'.repeat(256);
    expect(box({ title }).detail).toContain(`Title: ${title}\n`);
  });

  it('strips joiners and directional marks for display only', () => {
    expect(shownText('a\u200db\u200cc')).toBe('abc');
    expect(shownText('a\u200eb\u200fc\u061cd')).toBe('abcd');
  });

  it('cuts a stack of combining marks, with or without joiners between them', () => {
    const six = '\u0301'.repeat(6);
    expect(shownText(`e${'\u0301'.repeat(40)}x`)).toBe(`e${six}x`);
    expect(shownText(`e${'\u0301\u200c'.repeat(40)}x`)).toBe(`e${six}x`);
    expect(shownText(`e${six}x`)).toBe(`e${six}x`);
  });

  it('shows the description’s length and first lines, each marked', () => {
    const description = ['one', 'Signed by: npub1fake', 'three', 'four', 'five'].join('\n');
    const d = box({ description }).detail;
    expect(d).toContain(`Description (${String(description.length)} characters):`);
    expect(d).toContain('> one\n> Signed by: npub1fake\n> three\n> …');
    expect(d).not.toContain('four');
    expect(d.match(/^Signed by:/gmu)).toHaveLength(1);
  });

  it('says when there are no tags and no description', () => {
    const d = box({ tags: [], description: ' ' }).detail;
    expect(d).toContain('Tags: none');
    expect(d).toContain('Description: none');
  });
});

describe('stopping, deleting, and seeding again', () => {
  it.each([
    ['app.seeding.delete', 'delete', 'seeding.delete'],
    ['app.seeding.resume', 'resume', 'seeding.resume'],
  ])('%s asks first, then acts', async (method, action, workerMethod) => {
    const t = deps({ video: true });
    await t.m.answer(1, method, { video: VIDEO });
    expect(t.videos.map(([a]) => a)).toEqual([action]);
    expect(t.calls.map(([m]) => m)).toEqual(['seeding.status', workerMethod, 'seeding.status']);
  });

  it.each(['app.seeding.delete', 'app.seeding.resume'])('%s: a "no" does nothing', async (m) => {
    const t = deps({ video: false });
    await t.m.answer(1, m, { video: VIDEO });
    expect(t.calls.map(([x]) => x)).toEqual(['seeding.status']);
    await expect(t.m.answer(1, m, { video: VIDEO })).rejects.toMatchObject({
      code: 'rate-limited',
    });
  });

  it('refuses a video the worker does not list', async () => {
    const t = deps({ video: true });
    await expect(t.m.answer(1, 'app.seeding.delete', { video: `${VIDEO}x` })).rejects.toMatchObject(
      { code: 'not-found' },
    );
    expect(t.videos).toEqual([]);
  });

  it('names the video by its stored title, stripped like any other text', () => {
    const b = videoDialog('delete', {
      video: VIDEO,
      title: 'Holiday\u2028Video: another',
      origin: 'published',
      bytes: 2048,
    });
    expect(b.detail.split('\n')[0]).toBe('Title: HolidayVideo: another');
    expect(b.detail.split('\n')[1]).toContain(VIDEO);
    const none = videoDialog('resume', { video: VIDEO, origin: 'host', bytes: 2048 });
    expect(none.detail).toContain('Title: no title recorded');
  });

  it('says what deleting does, with "keep it" as the default answer', () => {
    const b = videoDialog('delete', { video: VIDEO, origin: 'published', bytes: 2048 });
    expect(b.message).toContain('deletes the video');
    expect(b.detail).toContain(VIDEO);
    expect([b.defaultId, b.buttons[0]]).toEqual([0, 'Keep it']);
    const r = videoDialog('resume', { video: VIDEO, origin: 'watched', bytes: 2048 });
    expect(r.message).toMatch(/shares your IP address/);
  });
});

describe('secrets go through the Account menu and main’s own prompt', () => {
  it.each([
    ['create', 'signer.local.create', 'passphrase', CREATE_KEY_PROMPT, NO_KEY],
    ['unlock', 'signer.local.unlock', 'passphrase', UNLOCK_KEY_PROMPT, SEALED],
    ['connect', 'signer.nip46.connect', 'uri', CONNECT_BUNKER_PROMPT, NO_KEY],
  ] as const)(
    '%s: the value goes to the worker, never back',
    async (action, w, f, spec, status) => {
      const value = 'a value only the prompt window saw';
      const t = deps({ secrets: [value], status });
      const out = await t.m.account(1, action);
      expect(t.specs).toEqual([spec]);
      expect(t.calls.filter(([m]) => m !== 'signer.status')).toEqual([[w, { [f]: value }]]);
      expect(out).toEqual({ status: { answered: w }, problem: null });
      expect(JSON.stringify(out)).not.toContain(value);
    },
  );

  it('Lock asks nothing', async () => {
    const t = deps();
    expect((await t.m.account(1, 'lock')).problem).toBeNull();
    expect(t.calls).toEqual([['signer.lock', {}]]);
    expect(t.specs).toEqual([]);
  });

  it('a wrong passphrase is said in the prompt, and it can be tried again', async () => {
    const t = deps({ secrets: ['the wrong one', 'the right one'], status: SEALED });
    expect(await t.m.account(1, 'unlock')).toEqual({
      status: { answered: 'signer.local.unlock' },
      problem: null,
    });
    expect(t.problems).toEqual(['that does not open this key', null]);
  });

  it('cancelling sends no value, and answers with the real status', async () => {
    const t = deps({ secrets: [null] });
    expect(await t.m.account(1, 'connect')).toEqual({ status: NO_KEY, problem: null });
    expect(t.calls).toEqual([['signer.status', {}]]);
  });

  it('a closed prompt stays closed for a moment, per action', async () => {
    const t = deps({ secrets: [null] });
    await t.m.account(1, 'connect');
    expect((await t.m.account(1, 'connect')).problem).toMatch(/try again/);
    expect(t.specs).toHaveLength(1);
    await t.m.account(1, 'create');
    expect(t.specs).toHaveLength(2);
    t.clock.t += PROMPT_DECLINED_WAIT_MS;
    await t.m.account(1, 'connect');
    expect(t.specs).toHaveLength(3);
  });

  it.each(['create', 'unlock'] as const)(
    'without the sandbox, %s says why, and opens no prompt',
    async (action) => {
      const t = deps({
        secrets: ['a passphrase'],
        status: { ...NO_KEY, keyFile: true, localAllowed: false },
      });
      const out = await t.m.account(1, action);
      expect(out).toEqual({ status: null, problem: NO_SANDBOX_KEY_TEXT });
      expect(NO_SANDBOX_KEY_TEXT).toContain('untouched');
      expect(t.specs).toEqual([]);
      expect(t.calls).toEqual([['signer.status', {}]]);
    },
  );

  it('without the sandbox, a bunker still works', async () => {
    const t = deps({
      secrets: ['bunker://value'],
      status: { ...NO_KEY, keyFile: true, localAllowed: false },
    });
    expect((await t.m.account(1, 'connect')).problem).toBeNull();
    expect(t.specs).toEqual([CONNECT_BUNKER_PROMPT]);
  });

  it('says so when there is a key to create over, or none to unlock', async () => {
    const has = deps({ secrets: ['x'], status: SEALED });
    expect((await has.m.account(1, 'create')).problem).toMatch(/already sealed/);
    const none = deps({ secrets: ['x'] });
    expect((await none.m.account(1, 'unlock')).problem).toMatch(/No key is sealed/);
    expect([...has.specs, ...none.specs]).toEqual([]);
  });

  it('a new key must be typed twice', () => {
    expect(CREATE_KEY_PROMPT.repeatLabel).toBeDefined();
    expect(UNLOCK_KEY_PROMPT.repeatLabel).toBeUndefined();
  });
});

describe('the Account menu', () => {
  const input = (over: Partial<KeyInput>): KeyInput => ({
    type: 'keyDown',
    key: 'O',
    shift: true,
    control: true,
    meta: false,
    alt: false,
    isAutoRepeat: false,
    ...over,
  });

  it.each(['linux', 'win32', 'darwin'])('on %s it holds all four actions', (platform) => {
    const run = vi.fn();
    const template = applicationMenu(platform, run);
    const account = template.find((x) => x.label === ACCOUNT_MENU_LABEL);
    const items = account?.submenu as MenuItemConstructorOptions[];
    expect(items.map((i) => i.label)).toEqual(ACCOUNT_ITEMS.map((i) => i.label));
    for (const i of items) (i.click as () => void)();
    expect(run.mock.calls.map((c) => c[0] as string)).toEqual(ACCOUNT_ITEMS.map((i) => i.action));
  });

  it.each(['linux', 'win32'])('on %s it is the whole bar: no reload, no DevTools', (platform) => {
    const template = applicationMenu(platform, () => undefined);
    expect(template).toHaveLength(1);
    expect(JSON.stringify(template)).not.toMatch(/reload|toggleDevTools|toggledevtools/i);
  });

  it('reads the menu that is really in place', () => {
    const good = {
      items: [
        { label: 'File' },
        {
          label: ACCOUNT_MENU_LABEL,
          submenu: { items: ACCOUNT_ITEMS.map((i) => ({ label: i.label })) },
        },
      ],
    };
    expect(accountMenuPresent(good)).toBe(true);
    expect(accountMenuPresent(null)).toBe(false);
    expect(accountMenuPresent({ items: [{ label: ACCOUNT_MENU_LABEL }] })).toBe(false);
    expect(
      accountMenuPresent({
        items: [{ label: ACCOUNT_MENU_LABEL, submenu: { items: [{ label: 'Lock' }] } }],
      }),
    ).toBe(false);
  });

  it('counts a hidden or auto-hidden bar as hidden; macOS uses the system bar', () => {
    const w = (visible: boolean, auto: boolean) => ({
      isMenuBarVisible: () => visible,
      isMenuBarAutoHide: () => auto,
    });
    expect(menuBarState('linux', w(true, false))).toBe('visible');
    expect(menuBarState('win32', w(false, false))).toBe('hidden');
    expect(menuBarState('linux', w(true, true))).toBe('hidden');
    expect(menuBarState('darwin', w(false, false))).toBe('system');
  });

  it('matches its shortcuts, on real key presses only', () => {
    expect(accountShortcut(input({}), 'linux')).toBe('unlock');
    expect(accountShortcut(input({ key: 'b' }), 'win32')).toBe('connect');
    expect(accountShortcut(input({ key: 'K', control: false, meta: true }), 'darwin')).toBe(
      'create',
    );
    expect(accountShortcut(input({ key: 'L', control: false, meta: true }), 'darwin')).toBe('lock');
    for (const bad of [
      input({ type: 'keyUp' }),
      input({ isAutoRepeat: true }),
      input({ shift: false }),
      input({ control: false }),
      input({ alt: true }),
      input({ key: 'x' }),
    ])
      expect(accountShortcut(bad, 'linux')).toBeNull();
    expect(accountShortcut(input({}), 'darwin')).toBeNull();
  });

  it('runs once per press, and a failure stays inside', async () => {
    let t = 1000;
    const run = vi.fn(() => Promise.reject(new Error('no')));
    const r = new AccountRunner(run, () => t);
    r.trigger('lock');
    r.trigger('lock');
    expect(run).toHaveBeenCalledTimes(1);
    r.trigger('unlock');
    expect(run).toHaveBeenCalledTimes(2);
    t += ACCOUNT_REPEAT_MS;
    r.trigger('lock');
    expect(run).toHaveBeenCalledTimes(3);
    await flush();
  });
});

describe('the prompt window', () => {
  const SPEC: PromptSpec = {
    title: 't',
    message: 'm',
    label: 'l',
    submit: 's',
    minChars: 3,
    maxChars: 10,
  };
  const right = { webContentsId: 7, topFrame: true, url: PROMPT_URL };

  function host(): {
    p: PromptHost;
    closed: () => number;
    errors: string[];
    gone: () => void;
    windows: number[];
  } {
    let closed = 0;
    let onGone: () => void = () => undefined;
    const errors: string[] = [];
    const windows: number[] = [];
    const p = new PromptHost({
      open: (id, _spec, gone) => {
        windows.push(id);
        onGone = gone;
        return {
          id: 7,
          error: (t) => {
            errors.push(t);
          },
          close: () => {
            closed += 1;
          },
        };
      },
    });
    return {
      p,
      closed: () => closed,
      errors,
      gone: () => {
        onGone();
      },
      windows,
    };
  }

  it('takes a value from its own window, and closes when it is done', async () => {
    const h = host();
    const got: string[] = [];
    const asked = h.p.ask(3, SPEC, (v) => {
      got.push(v);
      return Promise.resolve(null);
    });
    h.p.message(right, PROMPT_SUBMIT, 'secret');
    expect(await asked).toBe(true);
    expect(got).toEqual(['secret']);
    expect(h.windows).toEqual([3]);
    expect(h.closed()).toBe(1);
    expect(h.p.open).toBe(false);
  });

  it.each([
    ['another webContents', { webContentsId: 8, topFrame: true, url: PROMPT_URL }],
    ['a subframe', { webContentsId: 7, topFrame: false, url: PROMPT_URL }],
    ['another page', { webContentsId: 7, topFrame: true, url: 'app://nutflix/index.html' }],
    ['no URL', { webContentsId: 7, topFrame: true, url: undefined }],
  ])('drops a value from %s', async (_name, from) => {
    const h = host();
    const got: string[] = [];
    const asked = h.p.ask(3, SPEC, (v) => {
      got.push(v);
      return Promise.resolve(null);
    });
    h.p.message(from, PROMPT_SUBMIT, 'secret');
    h.p.message(from, PROMPT_CANCEL, undefined);
    await flush();
    expect(got).toEqual([]);
    expect(h.p.open).toBe(true);
    h.p.message(right, PROMPT_CANCEL, undefined);
    expect(await asked).toBe(false);
  });

  it('shows a refusal and stays open for another try', async () => {
    const h = host();
    let tries = 0;
    const asked = h.p.ask(3, SPEC, () => {
      tries += 1;
      return Promise.resolve(tries === 1 ? 'wrong' : null);
    });
    h.p.message(right, PROMPT_SUBMIT, 'first');
    await flush();
    expect(h.errors).toEqual(['wrong']);
    expect(h.p.open).toBe(true);
    h.p.message(right, PROMPT_SUBMIT, 'second');
    expect(await asked).toBe(true);
  });

  it('takes one value at a time', async () => {
    const h = host();
    let finish: (x: string | null) => void = () => undefined;
    const got: string[] = [];
    const asked = h.p.ask(3, SPEC, (v) => {
      got.push(v);
      return new Promise((r) => {
        finish = r;
      });
    });
    h.p.message(right, PROMPT_SUBMIT, 'first');
    h.p.message(right, PROMPT_SUBMIT, 'second');
    expect(got).toEqual(['first']);
    finish(null);
    expect(await asked).toBe(true);
  });

  it.each([['ab'], ['x'.repeat(11)], [7], [null]])('refuses the value %j', async (value) => {
    const h = host();
    const got: unknown[] = [];
    const asked = h.p.ask(3, SPEC, (v) => {
      got.push(v);
      return Promise.resolve(null);
    });
    h.p.message(right, PROMPT_SUBMIT, value);
    expect(got).toEqual([]);
    expect(h.errors).toHaveLength(1);
    h.p.message(right, PROMPT_CANCEL, undefined);
    await asked;
  });

  it('closing during a submit waits for the call, and reports that it happened', async () => {
    const h = host();
    let finish: (x: string | null) => void = () => undefined;
    const asked = h.p.ask(3, SPEC, () => new Promise((r) => (finish = r)));
    h.p.message(right, PROMPT_SUBMIT, 'value');
    h.gone();
    let answered = false;
    void asked.then(() => {
      answered = true;
    });
    await flush();
    expect(answered).toBe(false);
    finish(null);
    expect(await asked).toBe(true);
  });

  it('closing during a submit that then fails is a cancel, with nothing shown', async () => {
    const h = host();
    let finish: (x: string | null) => void = () => undefined;
    const asked = h.p.ask(3, SPEC, () => new Promise((r) => (finish = r)));
    h.p.message(right, PROMPT_SUBMIT, 'value');
    h.gone();
    finish('wrong');
    expect(await asked).toBe(false);
    expect(h.errors).toEqual([]);
  });

  it('closing the window is a cancel', async () => {
    const h = host();
    const asked = h.p.ask(3, SPEC, () => Promise.resolve(null));
    h.gone();
    expect(await asked).toBe(false);
  });

  it('opens one at a time', async () => {
    const h = host();
    const asked = h.p.ask(3, SPEC, () => Promise.resolve(null));
    await expect(h.p.ask(3, SPEC, () => Promise.resolve(null))).rejects.toThrow(/already/);
    h.gone();
    await asked;
  });

  describe('a prompt that cannot become usable', () => {
    class FakeContents extends EventEmitter {
      readonly id = 7;
      readonly sent: string[] = [];
      isDestroyed = (): boolean => false;
      send(channel: string): void {
        this.sent.push(channel);
      }
    }
    class FakeWindow extends EventEmitter {
      readonly webContents = new FakeContents();
      destroyed = false;
      shown = false;
      loadFails = false;
      setMenu(): void {
        // No menu.
      }
      loadURL(): Promise<void> {
        return this.loadFails ? Promise.reject(new Error('ERR_FAILED')) : Promise.resolve();
      }
      isDestroyed(): boolean {
        return this.destroyed;
      }
      show(): void {
        this.shown = true;
      }
      close(): void {
        this.destroy();
      }
      destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.emit('closed');
      }
    }

    function opened(
      o: OpenPromptOptions = {},
      loadFails = false,
    ): { win: FakeWindow; gone: () => number } {
      const box: { win: FakeWindow | null } = { win: null };
      const Ctor = function () {
        box.win = new FakeWindow();
        box.win.loadFails = loadFails;
        return box.win;
      } as unknown as PromptWindowCtor;
      let n = 0;
      openPrompt(
        Ctor,
        {} as BrowserWindow,
        '/p.cjs',
        {} as Session,
        SPEC,
        () => {
          n += 1;
        },
        o,
      );
      if (box.win === null) throw new Error('no window');
      return { win: box.win, gone: () => n };
    }

    beforeEach(() => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate'],
      });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a window that never loads is destroyed at its deadline, which is a cancel', () => {
      const shown = vi.fn();
      const { win, gone } = opened({ onNeverShown: shown });
      vi.advanceTimersByTime(PROMPT_SHOW_DEADLINE_MS - 1);
      expect(win.destroyed).toBe(false);
      vi.advanceTimersByTime(1);
      expect(shown).toHaveBeenCalledTimes(1);
      expect(win.destroyed).toBe(true);
      expect(gone()).toBe(1);
    });

    it.each([
      ['painted but never loaded', ['ready-to-show']],
      ['loaded but never painted', ['did-finish-load']],
    ])('%s still counts as never shown', (_name, events) => {
      const { win } = opened();
      for (const e of events) (e === 'ready-to-show' ? win : win.webContents).emit(e);
      vi.advanceTimersByTime(PROMPT_SHOW_DEADLINE_MS);
      expect(win.destroyed).toBe(true);
    });

    it('a window that loaded and painted is left alone', () => {
      const shown = vi.fn();
      const { win, gone } = opened({ onNeverShown: shown });
      win.webContents.emit('did-finish-load');
      win.emit('ready-to-show');
      vi.advanceTimersByTime(PROMPT_SHOW_DEADLINE_MS * 2);
      expect(shown).not.toHaveBeenCalled();
      expect(win.shown).toBe(true);
      expect(win.destroyed).toBe(false);
      expect(gone()).toBe(0);
    });

    it('a renderer that dies destroys the window, says why, and is a cancel', () => {
      const said = vi.fn();
      const { win, gone } = opened({ onRendererGone: said });
      win.webContents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 9 });
      expect(said).toHaveBeenCalledWith('killed', 9);
      vi.advanceTimersByTime(1);
      expect(win.destroyed).toBe(true);
      expect(gone()).toBe(1);
    });

    it('names the path that ended it: a failed load', async () => {
      const ended: string[] = [];
      const { win, gone } = opened({ onEnded: (p) => ended.push(p) }, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(ended).toEqual(['load-failed']);
      expect(win.destroyed).toBe(true);
      expect(gone()).toBe(1);
    });

    it('names the path that ended it: the renderer', async () => {
      const ended: string[] = [];
      const { win } = opened({ onEnded: (p) => ended.push(p) });
      win.webContents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 9 });
      await vi.advanceTimersByTimeAsync(1);
      expect(ended).toEqual(['render-process-gone']);
    });

    it('names the path that ended it: the watchdog', () => {
      const ended: string[] = [];
      opened({ onEnded: (p) => ended.push(p) });
      vi.advanceTimersByTime(PROMPT_SHOW_DEADLINE_MS);
      expect(ended).toEqual(['watchdog']);
    });

    it('names only the first, when a renderer dies and its load then fails', async () => {
      const ended: string[] = [];
      const { win } = opened({ onEnded: (p) => ended.push(p) }, true);
      win.webContents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 9 });
      await vi.advanceTimersByTimeAsync(1);
      expect(ended).toEqual(['render-process-gone']);
      expect(win.destroyed).toBe(true);
    });

    it('a user closing it is none of them, even if the load then fails', async () => {
      const ended: string[] = [];
      const { win } = opened({ onEnded: (p) => ended.push(p) }, true);
      win.close();
      await vi.advanceTimersByTimeAsync(PROMPT_SHOW_DEADLINE_MS);
      expect(ended).toEqual([]);
    });

    it('closing it stops the watchdog', () => {
      const shown = vi.fn();
      const { win } = opened({ onNeverShown: shown });
      win.close();
      vi.advanceTimersByTime(PROMPT_SHOW_DEADLINE_MS);
      expect(shown).not.toHaveBeenCalled();
    });
  });

  it('is sandboxed, isolated, in its own session, and modal, written as literals', () => {
    const box = { opts: {} as BrowserWindowConstructorOptions };
    const Ctor = function (this: unknown, o: BrowserWindowConstructorOptions) {
      box.opts = o;
    } as unknown as PromptWindowCtor;
    const parent = {} as BrowserWindow;
    const session = {} as Session;
    createPromptWindow(Ctor, parent, '/app/main/prompt-preload.cjs', session, 'A title');
    expect(box.opts).toMatchObject({ parent, modal: true, show: false, resizable: false });
    expect(box.opts.webPreferences).toMatchObject({
      preload: '/app/main/prompt-preload.cjs',
      session,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      devTools: false,
    });
    for (const k of ['webSecurity', 'webviewTag', 'allowRunningInsecureContent'])
      expect(Object.keys(box.opts.webPreferences ?? {})).not.toContain(k);
  });

  it('its session reaches its one file and nothing else', () => {
    expect(allowPromptRequest(PROMPT_URL)).toBe(true);
    for (const u of [
      'app://nutflix/index.html',
      'app://prompt/other.html',
      `${PROMPT_URL}?x=1`,
      'https://example.com/',
      'ws://127.0.0.1:9/',
      'file:///etc/passwd',
    ])
      expect(allowPromptRequest(u), u).toBe(false);
  });

  it('serves its one file, under a policy that allows nothing', async () => {
    const handle = createPromptProtocolHandler(() =>
      Promise.resolve(new TextEncoder().encode('<!doctype html>')),
    );
    const ok = await handle(new Request(PROMPT_URL));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-security-policy')).toBe(PROMPT_CSP);
    expect(PROMPT_CSP).toContain("default-src 'none'");
    expect(PROMPT_CSP).not.toMatch(/script-src|connect-src|unsafe/);
    const refused = await handle(new Request('https://example.com/prompt.html'));
    expect(refused.status).toBe(404);
  });
});
