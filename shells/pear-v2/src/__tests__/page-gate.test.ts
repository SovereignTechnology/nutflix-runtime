import { FrameDecoder, WINDOW_METHODS, WORKER_METHODS, encodeFrame } from '@nutflix-runtime/worker';
import { describe, expect, it } from 'vitest';

import { MAX_INFLIGHT, PAGE_EVENTS, PAGE_METHODS, PageGate } from '../bare/page-gate.ts';

type Msg = Record<string, unknown>;

function rig(): {
  gate: PageGate;
  toWorker: Msg[];
  toPage: Msg[];
  closed: () => number;
  answer: (id: number, r: unknown) => void;
} {
  const toWorker: Msg[] = [];
  const toPage: Msg[] = [];
  const workerDecoder = new FrameDecoder((m) => toWorker.push(m as Msg));
  const pageDecoder = new FrameDecoder((m) => toPage.push(m as Msg));
  let closes = 0;
  const gate = new PageGate({
    toWorker: (f) => {
      workerDecoder.push(f);
    },
    toPage: (f) => {
      pageDecoder.push(f);
    },
    closePage: () => {
      closes++;
    },
  });
  return {
    gate,
    toWorker,
    toPage,
    closed: () => closes,
    answer: (id, r) => {
      gate.fromWorker(encodeFrame({ op: 'res', id, ok: true, r }));
    },
  };
}

const req = (id: number, m: string, a: unknown = {}): Uint8Array =>
  encodeFrame({ op: 'req', id, m, a });
const SID_A = 'a'.repeat(32);
const SID_B = 'b'.repeat(32);

describe('what the page may ask', () => {
  it('is exactly status, play open and play close', () => {
    expect([...PAGE_METHODS].sort()).toEqual(['nfx.play.close', 'nfx.play.open', 'status']);
    expect([...PAGE_EVENTS]).toEqual(['status']);
  });

  // Every worker method but the three, and every method a v3 window asks main for: this shell's
  // main answers none of them, and the gate never passes one on.
  it.each([...WORKER_METHODS.filter((m) => !PAGE_METHODS.has(m)), ...WINDOW_METHODS])(
    'refuses %s',
    (m) => {
      const r = rig();
      r.gate.fromPage(req(7, m));
      expect(r.toWorker).toEqual([]);
      expect(r.toPage).toMatchObject([{ op: 'res', id: 7, ok: false }]);
    },
  );

  // ADR 0001 amendment, item 1: no signing key on disk in this shape. Named here, not taken from
  // the worker's method list, so that they are refused before and after the worker has them.
  it.each([
    'signer.local.create',
    'signer.local.unlock',
    'signer.status',
    'signer.nip46.connect',
    'signer.lock',
    'signer.check',
    'signer.sign',
    'studio.source',
    'studio.publish',
    'studio.ffmpeg',
    'seeding.set',
    'seeding.watch',
    'seeding.status',
    'app.seeding.set',
    'app.publish.sign',
    'app.pickVideo',
  ])('refuses %s, whatever its arguments', (m) => {
    for (const a of [{}, { passphrase: 'correct horse battery staple' }, { watched: true }]) {
      const r = rig();
      r.gate.fromPage(req(5, m, a));
      expect(r.toWorker).toEqual([]);
      expect(r.toPage).toMatchObject([
        { op: 'res', id: 5, ok: false, e: { code: 'invalid-argument' } },
      ]);
    }
  });

  it.each(['key.export', 'sign.event', 'wallet.pay', 'constructor', '__proto__', ''])(
    'refuses a method no worker has: %j',
    (m) => {
      const r = rig();
      r.gate.fromPage(req(1, m));
      expect(r.toWorker).toEqual([]);
      expect(r.toPage[0]).toMatchObject({ ok: false, e: { code: 'invalid-argument' } });
    },
  );

  it('sends an allowed request on under its own id, and answers with the page id', () => {
    const r = rig();
    r.gate.fromPage(req(41, 'status'));
    expect(r.toWorker).toHaveLength(1);
    const wid = r.toWorker[0]?.['id'] as number;
    expect(wid).not.toBe(41);
    r.answer(wid, { ok: 1 });
    expect(r.toPage).toEqual([{ op: 'res', id: 41, ok: true, r: { ok: 1 } }]);
  });

  it('drops responses and events the page sends', () => {
    const r = rig();
    r.gate.fromPage(encodeFrame({ op: 'res', id: 1, ok: true, r: 1 }));
    r.gate.fromPage(encodeFrame({ op: 'ev', e: 'status', status: {} }));
    expect(r.toWorker).toEqual([]);
    expect(r.toPage).toEqual([]);
  });

  it('refuses arguments that are not an object, a repeated id, and too many at once', () => {
    const r = rig();
    r.gate.fromPage(req(1, 'status', 'nope'));
    expect(r.toPage.pop()).toMatchObject({ ok: false, e: { code: 'invalid-argument' } });
    r.gate.fromPage(req(2, 'status'));
    r.gate.fromPage(req(2, 'status'));
    expect(r.toPage.pop()).toMatchObject({ id: 2, ok: false });
    for (let i = 3; i < MAX_INFLIGHT + 2; i++) r.gate.fromPage(req(i, 'status'));
    expect(r.toWorker).toHaveLength(MAX_INFLIGHT);
    r.gate.fromPage(req(1000, 'status'));
    expect(r.toPage.pop()).toMatchObject({ id: 1000, e: { code: 'rate-limited' } });
  });

  it('ends the pipe on a corrupt stream, and on something that is not bytes', () => {
    const a = rig();
    a.gate.fromPage(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0));
    expect(a.closed()).toBe(1);
    a.gate.fromPage(req(1, 'status'));
    expect(a.toWorker).toEqual([]);
    const b = rig();
    b.gate.fromPage('a string');
    expect(b.closed()).toBe(1);
  });
});

describe('sessions and events', () => {
  it('lets the page close only the sessions it opened', () => {
    const r = rig();
    r.gate.fromPage(req(1, 'nfx.play.close', { sid: SID_B }));
    expect(r.toWorker).toEqual([]);
    expect(r.toPage.pop()).toEqual({ op: 'res', id: 1, ok: true, r: null });
    r.gate.fromPage(req(2, 'nfx.play.open', { sid: SID_A }));
    r.answer(r.toWorker[0]?.['id'] as number, { ok: 1 });
    r.gate.fromPage(req(3, 'nfx.play.close', { sid: SID_A }));
    expect(r.toWorker[1]).toMatchObject({ m: 'nfx.play.close', a: { sid: SID_A } });
  });

  it('closes what the page opened when the page goes away, and drops late answers', () => {
    const r = rig();
    r.gate.fromPage(req(1, 'nfx.play.open', { sid: SID_A }));
    const wid = r.toWorker[0]?.['id'] as number;
    r.answer(wid, { ok: 1 });
    r.gate.fromPage(req(2, 'status'));
    const late = r.toWorker[1]?.['id'] as number;
    const seen = r.toPage.length;
    r.gate.pageGone();
    expect(r.toWorker[2]).toMatchObject({ m: 'nfx.play.close', a: { sid: SID_A } });
    r.answer(late, {});
    expect(r.toPage).toHaveLength(seen);
  });

  it('passes the status event on and no other', () => {
    const r = rig();
    r.gate.fromWorker(encodeFrame({ op: 'ev', e: 'log', level: 'info', msg: 'x' }));
    r.gate.fromWorker(encodeFrame({ op: 'ev', e: 'nfx.seed', video: 'v', state: 'seeding' }));
    expect(r.toPage).toEqual([]);
    r.gate.fromWorker(encodeFrame({ op: 'ev', e: 'status', status: { a: 1 } }));
    expect(r.toPage).toEqual([{ op: 'ev', e: 'status', status: { a: 1 } }]);
  });
});

describe("the shell's requests and a worker that goes away", () => {
  it('answers the shell, not the page', async () => {
    const r = rig();
    const p = r.gate.request('init', { v: 1 });
    r.answer(r.toWorker[0]?.['id'] as number, { done: true });
    await expect(p).resolves.toEqual({ done: true });
    expect(r.toPage).toEqual([]);
  });

  it('fails everything in flight and ends the page when the worker goes', async () => {
    const r = rig();
    const p = r.gate.request('status', {});
    r.gate.fromPage(req(9, 'status'));
    r.gate.workerGone();
    await expect(p).rejects.toThrow(/not running/);
    expect(r.toPage).toMatchObject([{ id: 9, ok: false, e: { code: 'backend-down' } }]);
    expect(r.closed()).toBe(1);
    await expect(r.gate.request('status', {})).rejects.toThrow(/not running/);
  });

  it('treats a corrupt worker stream as a worker that went away', () => {
    const r = rig();
    r.gate.fromWorker(Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0));
    expect(r.closed()).toBe(1);
  });
});
