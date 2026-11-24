/**
 * The page's plain HTTP reaches the worker's own loopback ports and nothing else (`loopback.ts`):
 * main learns the ports from the worker's `nfx.play.open` answers as they pass the gate, forgets
 * them when the worker is gone, and cancels every other `http:` request of the window's session.
 */
import { FrameDecoder, encodeFrame } from '@nutflix-runtime/worker';
import { describe, expect, it } from 'vitest';

import {
  REFUSALS_LOGGED,
  WorkerPorts,
  allowRequest,
  installLoopbackGuard,
  workerPort,
  type GuardedSession,
} from '../main/loopback.ts';
import { MAIN_WINDOW_POLICY, RpcGate } from '../main/rpc-gate.ts';

type Msg = Record<string, unknown>;

const TOKEN = 'a'.repeat(32);
const SID = 'ab'.repeat(16);
const stream = (port: number): string => `http://127.0.0.1:${String(port)}/${TOKEN}/${SID}`;
const origin = (port: number): string => `http://127.0.0.1:${String(port)}/${TOKEN}`;

function gateWith(ports: WorkerPorts): {
  gate: RpcGate;
  toWorker: Msg[];
  toWindow: Msg[];
  /** What the set held when each frame reached the window. */
  heldWhenSent: boolean[][];
  ask(msg: object): void;
  answer(msg: object): void;
} {
  const toWorker: Msg[] = [];
  const toWindow: Msg[] = [];
  const heldWhenSent: boolean[][] = [];
  const workerSide = new FrameDecoder((m) => toWorker.push(m as Msg));
  const windowSide = new FrameDecoder((m) => toWindow.push(m as Msg));
  const gate = new RpcGate({
    toWorker: (f) => {
      workerSide.push(f);
    },
    toWindow: (_id, f) => {
      heldWhenSent.push([ports.has(4100), ports.has(4101)]);
      windowSide.push(f);
    },
    closeWindow: () => undefined,
    loopback: ports,
  });
  gate.attach(1, MAIN_WINDOW_POLICY);
  return {
    gate,
    toWorker,
    toWindow,
    heldWhenSent,
    ask: (msg) => {
      gate.fromWindow(1, encodeFrame(msg));
    },
    answer: (msg) => {
      gate.fromWorker(encodeFrame(msg));
    },
  };
}

/** A play the window opens, answered by the worker with its two loopback servers. */
function openPlay(
  h: ReturnType<typeof gateWith>,
  id: number,
  r: Record<string, unknown>,
  ok = true,
): void {
  h.ask({ op: 'req', id, m: 'nfx.play.open', a: { sid: SID } });
  const wid = h.toWorker.at(-1)?.['id'];
  h.answer(
    ok
      ? { op: 'res', id: wid, ok: true, r }
      : { op: 'res', id: wid, ok: false, e: { code: 'no-seeders', message: 'no-seeders: x' } },
  );
}

describe('a worker port', () => {
  it.each([
    [stream(41234), 41234],
    [origin(1), 1],
    [origin(65535), 65535],
  ])('is read from %s', (url, port) => {
    expect(workerPort(url)).toBe(port);
  });

  it.each([
    ['https', `https://127.0.0.1:4000/${TOKEN}`],
    ['another loopback name', `http://localhost:4000/${TOKEN}`],
    ['another loopback address', `http://127.0.0.2:4000/${TOKEN}`],
    ['IPv6 loopback', `http://[::1]:4000/${TOKEN}`],
    ['a LAN host', `http://10.0.0.1:4000/${TOKEN}`],
    ['no port (80)', `http://127.0.0.1/${TOKEN}`],
    ['port 80 named', `http://127.0.0.1:80/${TOKEN}`],
    ['port 0', `http://127.0.0.1:0/${TOKEN}`],
    ['user-info', `http://u:p@127.0.0.1:4000/${TOKEN}`],
    ['not a URL', 'not a url'],
    ['too long', `${origin(4000)}/${'x'.repeat(2100)}`],
  ])('is not read from %s', (_what, url) => {
    expect(workerPort(url)).toBeNull();
  });

  it.each([[null], [4000], [{ url: origin(4000) }], [undefined]])('nor from %j', (x) => {
    expect(workerPort(x)).toBeNull();
  });
});

describe('what the window’s session may request', () => {
  const ports = new WorkerPorts();
  ports.served(stream(4100));
  ports.served(origin(4101));

  it.each([stream(4100), origin(4101), `${origin(4101)}/init.mp4`, 'http://0x7f.1:4100/x'])(
    'a worker port passes: %s',
    (url) => {
      expect(allowRequest(url, ports)).toEqual({ allow: true });
    },
  );

  it.each([
    ['another loopback port', 'http://127.0.0.1:631/', 631],
    ['a port next to the worker’s', 'http://127.0.0.1:4102/', 4102],
    ['the default port', 'http://127.0.0.1/', 80],
    ['a worker port under another name', 'http://localhost:4100/', 4100],
    ['IPv6 loopback on a worker port', 'http://[::1]:4100/', 4100],
    ['user-info on a worker port', 'http://u@127.0.0.1:4100/', 4100],
    ['a LAN host', 'http://10.0.0.1/', 80],
    ['a public host', 'http://example.com:8080/', 8080],
  ])('plain HTTP elsewhere is refused: %s', (_what, url, port) => {
    expect(allowRequest(url, ports)).toEqual({ allow: false, port });
  });

  it.each([
    'app://nutflix/index.html',
    'blob:app://nutflix/0f6c1d2e-0000-4000-8000-000000000000',
    // Local relays: the page owns the relay list, so these stay as the page's policy says.
    'ws://127.0.0.1:7777/',
    'wss://relay.example/',
    'https://images.example/a.png',
  ])('everything that is not plain HTTP is left to the page’s policy: %s', (url) => {
    expect(allowRequest(url, ports)).toEqual({ allow: true });
  });

  it('a URL that does not parse is refused', () => {
    expect(allowRequest('::not a url', ports)).toEqual({ allow: false, port: null });
  });

  it('with no play open yet, no plain HTTP passes at all', () => {
    expect(allowRequest(stream(4100), new WorkerPorts())).toMatchObject({ allow: false });
  });
});

describe('the ports main learns, through the gate', () => {
  it('from the worker’s answer to a window’s play, before the window sees it', () => {
    const ports = new WorkerPorts();
    const h = gateWith(ports);
    openPlay(h, 1, {
      progressiveUrl: stream(4100),
      originUrl: origin(4101),
      rendition: 'r',
      renditions: [],
    });
    expect(h.toWindow.map((m) => m['ok'])).toEqual([true]);
    expect(h.heldWhenSent).toEqual([[true, true]]);
    expect(allowRequest(stream(4100), ports).allow).toBe(true);
    expect(allowRequest(origin(4101), ports).allow).toBe(true);
    expect(ports.size).toBe(2);
  });

  it('a progressive-only or origin-only play adds the one it names', () => {
    const ports = new WorkerPorts();
    const h = gateWith(ports);
    openPlay(h, 1, { progressiveUrl: null, originUrl: origin(4101) });
    expect([ports.has(4100), ports.has(4101)]).toEqual([false, true]);
  });

  it('nothing from a failed play, another method’s answer, or what the window wrote', () => {
    const ports = new WorkerPorts();
    const h = gateWith(ports);
    openPlay(h, 1, { progressiveUrl: stream(4100) }, false);
    // A window's own arguments are never read for ports.
    h.ask({ op: 'req', id: 2, m: 'status', a: { progressiveUrl: stream(4100) } });
    h.answer({
      op: 'res',
      id: h.toWorker.at(-1)?.['id'],
      ok: true,
      r: { progressiveUrl: stream(4100), originUrl: origin(4101) },
    });
    // Nor an event, nor a refused method.
    h.answer({ op: 'ev', e: 'status', progressiveUrl: stream(4100) });
    h.ask({ op: 'req', id: 3, m: 'nfx.seed.start', a: { originUrl: origin(4101) } });
    expect(ports.size).toBe(0);
  });

  it('forgets them when the worker is gone, and follows a worker started again', () => {
    const ports = new WorkerPorts();
    const first = gateWith(ports);
    openPlay(first, 1, { progressiveUrl: stream(4100), originUrl: origin(4101) });
    expect(allowRequest(stream(4100), ports).allow).toBe(true);
    first.gate.workerGone();
    expect(ports.size).toBe(0);
    expect(allowRequest(stream(4100), ports)).toEqual({ allow: false, port: 4100 });
    // The next worker's servers took new ports: only those pass.
    const second = gateWith(ports);
    openPlay(second, 1, { progressiveUrl: stream(5100), originUrl: origin(5101) });
    expect(allowRequest(stream(5100), ports).allow).toBe(true);
    expect(allowRequest(origin(5101), ports).allow).toBe(true);
    expect(allowRequest(stream(4100), ports).allow).toBe(false);
    expect(allowRequest(origin(4101), ports).allow).toBe(false);
  });

  it('a corrupt stream from the worker counts as gone', () => {
    const ports = new WorkerPorts();
    const h = gateWith(ports);
    openPlay(h, 1, { progressiveUrl: stream(4100) });
    expect(ports.size).toBe(1);
    h.gate.fromWorker(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0]));
    expect(ports.size).toBe(0);
  });
});

describe('the guard in the session', () => {
  function fakeSession(): {
    ses: GuardedSession;
    registered: unknown[][];
    send(url: string): { cancel?: boolean } | undefined;
  } {
    const registered: unknown[][] = [];
    let listener:
      ((d: { url: string }, cb: (r: { readonly cancel?: boolean }) => void) => void) | undefined;
    return {
      registered,
      ses: {
        webRequest: {
          onBeforeRequest: (...args: unknown[]) => {
            registered.push(args);
            listener = args[0] as typeof listener;
          },
        },
      },
      send: (url) => {
        let got: { cancel?: boolean } | undefined;
        listener?.({ url }, (r) => {
          got = { ...r };
        });
        return got;
      },
    };
  }

  it('is one listener with no URL filter: the port is decided here, for every request', () => {
    const f = fakeSession();
    installLoopbackGuard(f.ses, new WorkerPorts(), () => undefined);
    expect(f.registered).toHaveLength(1);
    expect(f.registered[0]).toHaveLength(1);
    expect(typeof f.registered[0]?.[0]).toBe('function');
  });

  it('lets a worker port through and cancels any other loopback port', () => {
    const f = fakeSession();
    const ports = new WorkerPorts();
    ports.served(stream(4100));
    const log: [string, unknown][] = [];
    installLoopbackGuard(f.ses, ports, (name, fields) => log.push([name, fields]));
    expect(f.send(stream(4100))).toEqual({});
    expect(f.send('ws://127.0.0.1:7777/')).toEqual({});
    expect(f.send('http://127.0.0.1:631/printers')).toEqual({ cancel: true });
    expect(f.send('http://127.0.0.1:4101/')).toEqual({ cancel: true });
    // By port only: never the URL the page chose.
    expect(log).toEqual([
      ['http-refused', { port: 631 }],
      ['http-refused', { port: 4101 }],
    ]);
    // The worker is gone: its port no longer passes.
    ports.reset();
    expect(f.send(stream(4100))).toEqual({ cancel: true });
  });

  it('shows an observer every URL before deciding, and its failure decides nothing', () => {
    const f = fakeSession();
    const seen: string[] = [];
    installLoopbackGuard(
      f.ses,
      new WorkerPorts(),
      () => undefined,
      (url) => {
        seen.push(url);
        if (url.startsWith('wss:')) throw new Error('an observer that throws');
      },
    );
    expect(f.send('wss://relay.example.org/')).toEqual({});
    expect(f.send('http://127.0.0.1:631/')).toEqual({ cancel: true });
    expect(f.send('app://nutflix/index.html')).toEqual({});
    expect(seen).toEqual([
      'wss://relay.example.org/',
      'http://127.0.0.1:631/',
      'app://nutflix/index.html',
    ]);
  });

  it('logs at most a fixed number of refusals, and still refuses after that', () => {
    const f = fakeSession();
    const log: string[] = [];
    installLoopbackGuard(f.ses, new WorkerPorts(), (name) => log.push(name));
    for (let i = 0; i < REFUSALS_LOGGED + 30; i++)
      expect(f.send(`http://127.0.0.1:${String(2000 + i)}/`)).toEqual({ cancel: true });
    expect(log).toHaveLength(REFUSALS_LOGGED);
  });
});
