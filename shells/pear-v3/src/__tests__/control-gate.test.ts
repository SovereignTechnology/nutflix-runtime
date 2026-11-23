/**
 * The gate for seeding, publishing and the signer: what the renderer's window may reach, and the
 * two things it must not do alone. It never names a path (main's native dialog does), and it
 * cannot turn seeding on (that shares the user's IP address, so it takes a native confirmation).
 */
import { FrameDecoder, WorkerError, encodeFrame } from '@nutflix-runtime/worker';
import { describe, expect, it, vi } from 'vitest';

import {
  CONFIRM_SEEDING_DIALOG,
  PICK_VIDEO_DIALOG,
  answerMainCall,
  type MainCallDeps,
} from '../main/main-calls.ts';
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
    'signer.local.create',
    'signer.local.unlock',
    'signer.nip46.connect',
    'signer.lock',
    'signer.sign',
    'seeding.status',
    'seeding.watch',
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
    'studio.source',
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

describe('seeding.segment', () => {
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

    h.ask(2, req(1, 'seeding.segment', offer(SID)));
    h.ask(1, req(2, 'seeding.segment', offer(SID2)));
    h.ask(1, req(3, 'seeding.segment', { ...offer(SID), sid: 42 }));
    expect(h.toWorker).toEqual([]);
    for (const list of [h.toWindow.get(2), h.toWindow.get(1)?.slice(1)])
      for (const m of list ?? [])
        expect(m['e']).toEqual({
          code: 'invalid-argument',
          message: 'invalid-argument: not a play session of this window',
        });

    h.ask(1, req(4, 'seeding.segment', offer(SID)));
    expect(h.toWorker.map((m) => m['m'])).toEqual(['seeding.segment']);
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

describe('the two native dialogs', () => {
  function deps(o: { path?: string | null; yes?: boolean } = {}): MainCallDeps & {
    calls: [string, Record<string, unknown>][];
    picks: () => number;
    confirms: () => number;
  } {
    const calls: [string, Record<string, unknown>][] = [];
    let picks = 0;
    let confirms = 0;
    return {
      calls,
      picks: () => picks,
      confirms: () => confirms,
      pickFile: () => {
        picks += 1;
        return Promise.resolve(o.path === undefined ? '/home/u/clip.mp4' : o.path);
      },
      confirmSeeding: () => {
        confirms += 1;
        return Promise.resolve(o.yes === true);
      },
      worker: (m, a) => {
        calls.push([m, a]);
        return Promise.resolve({ answered: m });
      },
    };
  }

  it('a picked path goes to the worker; the page gets only the worker’s token', async () => {
    const d = deps();
    expect(await answerMainCall('app.pickVideo', {}, d)).toEqual({ answered: 'studio.source' });
    expect(d.calls).toEqual([['studio.source', { path: '/home/u/clip.mp4' }]]);
  });

  it('a cancelled pick reaches nothing', async () => {
    const d = deps({ path: null });
    expect(await answerMainCall('app.pickVideo', {}, d)).toBeNull();
    expect(d.calls).toEqual([]);
  });

  it.each([
    [{ path: '/etc/passwd' }],
    [{ file: '/etc/passwd' }],
    [{ defaultPath: '/etc' }],
    [{ filters: [] }],
  ])('a page cannot steer the picker: %j', async (args) => {
    const d = deps();
    await expect(answerMainCall('app.pickVideo', args, d)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(d.picks()).toBe(0);
    expect(d.calls).toEqual([]);
  });

  it('turning seeding on takes the user’s yes', async () => {
    const yes = deps({ yes: true });
    await answerMainCall('app.seeding.set', { on: true }, yes);
    expect(yes.confirms()).toBe(1);
    expect(yes.calls).toEqual([['seeding.set', { watched: true }]]);
  });

  it('a no leaves it off, and answers with the current state', async () => {
    const no = deps({ yes: false });
    expect(await answerMainCall('app.seeding.set', { on: true }, no)).toEqual({
      answered: 'seeding.status',
    });
    expect(no.confirms()).toBe(1);
    expect(no.calls).toEqual([['seeding.status', {}]]);
  });

  it('turning it off asks nothing', async () => {
    const d = deps();
    await answerMainCall('app.seeding.set', { on: false }, d);
    expect(d.confirms()).toBe(0);
    expect(d.calls).toEqual([['seeding.set', { watched: false }]]);
  });

  it.each([[{}], [{ on: 'true' }], [{ on: 1 }], [{ on: true, watched: true }]])(
    'refuses %j',
    async (args) => {
      const d = deps({ yes: true });
      await expect(answerMainCall('app.seeding.set', args, d)).rejects.toMatchObject({
        code: 'invalid-argument',
      });
      expect(d.confirms()).toBe(0);
      expect(d.calls).toEqual([]);
    },
  );

  it('says plainly what seeding shares, with "off" as the default answer', () => {
    expect(CONFIRM_SEEDING_DIALOG.message).toMatch(/shares your IP address with viewers/);
    expect(CONFIRM_SEEDING_DIALOG.defaultId).toBe(0);
    expect(CONFIRM_SEEDING_DIALOG.cancelId).toBe(0);
    expect(CONFIRM_SEEDING_DIALOG.buttons[0]).toBe('Keep it off');
  });

  it('the picker opens one file and no directory', () => {
    expect(PICK_VIDEO_DIALOG.properties).toEqual(['openFile']);
  });
});
