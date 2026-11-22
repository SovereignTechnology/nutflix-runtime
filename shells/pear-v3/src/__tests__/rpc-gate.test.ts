import { FrameDecoder, encodeFrame } from '@nutflix-runtime/worker';
import { describe, expect, it, vi } from 'vitest';

import { MAIN_WINDOW_POLICY, RpcGate, type WindowPolicy } from '../main/rpc-gate.ts';

const SID = 'ab'.repeat(16);
const SID2 = 'cd'.repeat(16);

type Msg = Record<string, unknown>;

function harness(): {
  gate: RpcGate;
  toWorker: Msg[];
  toWindow: Map<number, Msg[]>;
  closed: number[];
  ask(windowId: number, msg: object): void;
  answer(msg: object): void;
} {
  const toWorker: Msg[] = [];
  const toWindow = new Map<number, Msg[]>();
  const closed: number[] = [];
  const decode = (sink: (m: Msg) => void): FrameDecoder =>
    new FrameDecoder((m) => {
      sink(m as Msg);
    });
  const workerSide = decode((m) => toWorker.push(m));
  const windowSides = new Map<number, FrameDecoder>();
  const gate = new RpcGate({
    toWorker: (f) => {
      workerSide.push(f);
    },
    toWindow: (id, f) => {
      let d = windowSides.get(id);
      if (d === undefined) {
        const list: Msg[] = [];
        toWindow.set(id, list);
        d = decode((m) => list.push(m));
        windowSides.set(id, d);
      }
      d.push(f);
    },
    closeWindow: (id) => {
      closed.push(id);
    },
  });
  return {
    gate,
    toWorker,
    toWindow,
    closed,
    ask: (windowId, msg) => {
      gate.fromWindow(windowId, encodeFrame(msg));
    },
    answer: (msg) => {
      gate.fromWorker(encodeFrame(msg));
    },
  };
}

const req = (id: number, m: string, a: object = {}): object => ({ op: 'req', id, m, a });

describe('RpcGate: what a window may call', () => {
  it('forwards the three allowed methods, remapping the id, and returns the answer under the original id', () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(7, 'status'));
    h.ask(1, req(8, 'nfx.play.open', { sid: SID, video: 'x' }));
    h.ask(1, req(9, 'nfx.play.close', { sid: SID }));
    expect(h.toWorker.map((m) => m['m'])).toEqual(['status', 'nfx.play.open', 'nfx.play.close']);
    const ids = h.toWorker.map((m) => m['id'] as number);
    expect(new Set(ids).size).toBe(3);
    h.answer({ op: 'res', id: ids[0], ok: true, r: { dht: true } });
    expect(h.toWindow.get(1)).toEqual([{ op: 'res', id: 7, ok: true, r: { dht: true } }]);
  });

  it.each([
    'init',
    'nfx.seed.start',
    'nfx.seed.stop',
    'nfx.seed.list',
    'nfx.endpoint',
    'nope',
    '__proto__',
    'constructor',
  ])('refuses %s in the window and never sends it to the worker', (m) => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(5, m, { v: 1, storage: '/etc/passwd' }));
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

  it("forwards main's own re-encoding, never the window's fields", () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, { op: 'req', id: 1, m: 'status', a: {}, extra: 'x', timeoutMs: 1 });
    expect(Object.keys(h.toWorker[0] ?? {}).sort()).toEqual(['a', 'id', 'm', 'op']);
  });

  it('drops anything that is not a request, and answers a bad argument list', () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, { op: 'res', id: 1, ok: true, r: null });
    h.ask(1, { op: 'ev', e: 'status' });
    h.ask(1, { op: 'req', id: -1, m: 'status', a: {} });
    h.ask(1, { op: 'req', id: 1.5, m: 'status', a: {} });
    h.ask(1, { op: 'req', id: 2, m: 'status', a: [] });
    h.ask(1, { op: 'req', id: 3, m: 'status', a: 'x' });
    expect(h.toWorker).toEqual([]);
    expect(h.toWindow.get(1)?.map((m) => m['id'])).toEqual([2, 3]);
  });

  it('refuses a repeated id in flight and more than maxInflight requests', () => {
    const h = harness();
    const policy: WindowPolicy = { ...MAIN_WINDOW_POLICY, maxInflight: 2 };
    h.gate.attach(1, policy);
    h.ask(1, req(1, 'status'));
    h.ask(1, req(1, 'status'));
    h.ask(1, req(2, 'status'));
    h.ask(1, req(3, 'status'));
    expect(h.toWorker).toHaveLength(2);
    const codes = h.toWindow.get(1)?.map((m) => (m['e'] as Msg)['code']);
    expect(codes).toEqual(['invalid-argument', 'rate-limited']);
  });

  it('ends a window whose stream is corrupt, and ignores what it sent after', () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.gate.fromWindow(1, new Uint8Array([0x7f, 0xff, 0xff, 0xff, 1]));
    expect(h.closed).toEqual([1]);
    h.ask(1, req(1, 'status'));
    expect(h.toWorker).toEqual([]);
  });

  it('ends a window that writes something that is not bytes, nothing, or too much', () => {
    for (const bad of ['x', null, new Uint8Array(0), new Uint8Array(1024 * 1024 + 5)]) {
      const h = harness();
      h.gate.attach(1, MAIN_WINDOW_POLICY);
      h.gate.fromWindow(1, bad);
      expect(h.closed).toEqual([1]);
    }
  });
});

describe('RpcGate: windows and the worker', () => {
  it('keeps two windows apart: ids, answers and sessions', () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.gate.attach(2, MAIN_WINDOW_POLICY);
    h.ask(1, req(1, 'status'));
    h.ask(2, req(1, 'status'));
    const [a, b] = h.toWorker.map((m) => m['id'] as number);
    expect(a).not.toBe(b);
    h.answer({ op: 'res', id: b, ok: true, r: 'two' });
    h.answer({ op: 'res', id: a, ok: true, r: 'one' });
    expect(h.toWindow.get(1)).toEqual([{ op: 'res', id: 1, ok: true, r: 'one' }]);
    expect(h.toWindow.get(2)).toEqual([{ op: 'res', id: 1, ok: true, r: 'two' }]);
  });

  it('lets a window close only a session it opened', () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.gate.attach(2, MAIN_WINDOW_POLICY);
    h.ask(1, req(1, 'nfx.play.open', { sid: SID }));
    h.answer({ op: 'res', id: h.toWorker[0]?.['id'], ok: true, r: {} });
    h.toWorker.length = 0;
    h.ask(2, req(1, 'nfx.play.close', { sid: SID }));
    expect(h.toWorker).toEqual([]);
    expect(h.toWindow.get(2)).toEqual([{ op: 'res', id: 1, ok: true, r: null }]);
    h.ask(1, req(2, 'nfx.play.close', { sid: SID }));
    expect(h.toWorker.map((m) => m['m'])).toEqual(['nfx.play.close']);
  });

  it('closes the sessions of a window that goes away, and drops its answers', () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(1, 'nfx.play.open', { sid: SID }));
    h.ask(1, req(2, 'nfx.play.open', { sid: SID2 }));
    h.toWorker.length = 0;
    h.gate.detach(1);
    expect(h.toWorker.map((m) => [m['m'], (m['a'] as Msg)['sid']])).toEqual([
      ['nfx.play.close', SID],
      ['nfx.play.close', SID2],
    ]);
    h.answer({ op: 'res', id: 1, ok: true, r: {} });
    expect(h.toWindow.get(1)).toBeUndefined();
  });

  it('forgets a session whose open failed, so it is not closed twice', () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(1, 'nfx.play.open', { sid: SID }));
    h.answer({
      op: 'res',
      id: h.toWorker[0]?.['id'],
      ok: false,
      e: { code: 'no-seeders', message: 'no-seeders: none' },
    });
    h.toWorker.length = 0;
    h.gate.detach(1);
    expect(h.toWorker).toEqual([]);
    expect(h.toWindow.get(1)?.[0]).toMatchObject({ ok: false, e: { code: 'no-seeders' } });
  });

  it('shapes a failure it does not understand as an internal error', () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(1, 'status'));
    h.answer({
      op: 'res',
      id: h.toWorker[0]?.['id'],
      ok: false,
      e: { code: 'bogus', message: '/home/x' },
    });
    expect(h.toWindow.get(1)).toEqual([
      { op: 'res', id: 1, ok: false, e: { code: 'internal', message: 'internal: internal error' } },
    ]);
  });

  it('sends an event only to the windows whose policy lists it', () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.gate.attach(2, { ...MAIN_WINDOW_POLICY, events: new Set() });
    h.answer({ op: 'ev', e: 'status', status: { dht: true } });
    h.answer({ op: 'ev', e: 'log', level: 'info', msg: 'a line' });
    h.answer({ op: 'ev', e: 'nfx.seed', video: 'v', state: 'seeding' });
    expect(h.toWindow.get(1)).toEqual([{ op: 'ev', e: 'status', status: { dht: true } }]);
    expect(h.toWindow.get(2)).toBeUndefined();
  });

  it("answers main's own requests in the same id space", async () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(1, 'status'));
    const p = h.gate.request('init', { v: 1 }, 1000);
    const init = h.toWorker.find((m) => m['m'] === 'init');
    expect(init?.['id']).not.toBe(h.toWorker[0]?.['id']);
    h.answer({ op: 'res', id: init?.['id'], ok: true, r: { v: 1 } });
    await expect(p).resolves.toEqual({ v: 1 });
    expect(h.toWindow.get(1)).toBeUndefined();
  });

  it("rejects main's request with the worker's code", async () => {
    const h = harness();
    const p = h.gate.request('init', {}, 1000);
    h.answer({
      op: 'res',
      id: h.toWorker[0]?.['id'],
      ok: false,
      e: { code: 'invalid-argument', message: 'invalid-argument: bad' },
    });
    await expect(p).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it("times out main's request", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const p = h.gate.request('status', {}, 50);
      const assertion = expect(p).rejects.toMatchObject({ code: 'backend-down' });
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      expect(h.gate.inflight).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails everything when the worker goes, and ends every window pipe', async () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.ask(1, req(1, 'status'));
    const p = h.gate.request('status', {});
    h.gate.workerGone();
    await expect(p).rejects.toMatchObject({ code: 'backend-down' });
    expect(h.toWindow.get(1)).toMatchObject([{ id: 1, ok: false, e: { code: 'backend-down' } }]);
    expect(h.closed).toEqual([1]);
    await expect(h.gate.request('status', {})).rejects.toMatchObject({ code: 'backend-down' });
  });

  it('treats a corrupt stream from the worker as the worker gone', () => {
    const h = harness();
    h.gate.attach(1, MAIN_WINDOW_POLICY);
    h.gate.fromWorker(new Uint8Array([0x7f, 0xff, 0xff, 0xff, 1]));
    expect(h.closed).toEqual([1]);
  });

  it('treats a pipe that cannot be written as the worker gone', () => {
    const closed: number[] = [];
    const out: Msg[] = [];
    const dec = new FrameDecoder((m) => out.push(m as Msg));
    const gate = new RpcGate({
      toWorker: (f) => {
        if (out.length > 0) throw new Error('EPIPE');
        dec.push(f);
      },
      toWindow: () => undefined,
      closeWindow: (id) => closed.push(id),
    });
    gate.attach(1, MAIN_WINDOW_POLICY);
    gate.fromWindow(1, encodeFrame(req(1, 'status')));
    gate.fromWindow(1, encodeFrame(req(2, 'status')));
    expect(closed).toEqual([1]);
  });
});
