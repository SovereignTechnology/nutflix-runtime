/**
 * The page's plain HTTP reaches the worker's own loopback ports and nothing else (`loopback.ts`):
 * main learns the ports from the worker's `nfx.play.open` answers as they pass the gate, forgets
 * them when the worker is gone, and cancels every other `http:` request of the window's session.
 * And its `https:` reaches no private host (an IP literal that is not public, or `localhost`,
 * `*.localhost`, `*.local`), a redirect's target included, by the renderer's own rules
 * (`publicIpLiteral`, which `isPublicHost` reads too, and `isAlwaysLocalName`).
 */
import { FrameDecoder, encodeFrame } from '@nutflix-runtime/worker';
import { describe, expect, it } from 'vitest';

import {
  isAlwaysLocalName,
  isPublicHost,
  publicIpLiteral,
} from '../../../../packages/renderer/src/net/hosts.ts';
import {
  PRIVATE_HOST_SCHEMES,
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
  ])(
    'what is not plain HTTP (nor https: to a private literal) is left to the page’s policy: %s',
    (url) => {
      expect(allowRequest(url, ports)).toEqual({ allow: true });
    },
  );

  it('a URL that does not parse is refused', () => {
    expect(allowRequest('::not a url', ports)).toEqual({ allow: false, port: null });
  });

  it('with no play open yet, no plain HTTP passes at all', () => {
    expect(allowRequest(stream(4100), new WorkerPorts())).toMatchObject({ allow: false });
  });
});

describe('https: to a private host', () => {
  const ports = new WorkerPorts();
  ports.served(stream(4100));

  // Chromium hands the listener a canonical URL, and Node's WHATWG `URL` reads the other spellings
  // of an IPv4 address (hex, octal, one number) the same way, so they are refused as well.
  it.each([
    ['loopback', 'https://127.0.0.1/', 443],
    ['loopback on the worker’s port: only its plain HTTP passes', 'https://127.0.0.1:4100/x', 4100],
    ['loopback elsewhere in 127/8', 'https://127.1.2.3:8443/', 8443],
    ['loopback in hex', 'https://0x7f.1/', 443],
    ['loopback in octal', 'https://0177.0.0.1/', 443],
    ['loopback as one number', 'https://2130706433/', 443],
    ['this network', 'https://0/', 443],
    ['RFC 1918 10/8', 'https://10.0.0.1/', 443],
    ['RFC 1918 172.16/12', 'https://172.16.0.1/', 443],
    ['RFC 1918 192.168/16', 'https://192.168.1.1:8443/admin', 8443],
    ['CGNAT, and so a tailnet address', 'https://100.64.0.1/', 443],
    ['link-local (cloud metadata)', 'https://169.254.169.254/latest', 443],
    ['IPv6 loopback', 'https://[::1]/', 443],
    ['IPv6 link-local', 'https://[fe80::1]/', 443],
    ['IPv6 unique-local', 'https://[fd00::1]/', 443],
    ['IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]/', 443],
    ['IPv4-mapped LAN', 'https://[::ffff:192.168.0.1]/', 443],
    ['NAT64 of a private address', 'https://[64:ff9b::a00:1]/', 443],
    ['6to4 of a private address', 'https://[2002:c0a8:101::]/', 443],
    // Names that are local whatever DNS says: Chromium maps localhost itself; .local is mDNS.
    ['localhost', 'https://localhost/', 443],
    ['localhost in capitals', 'https://LOCALHOST:8443/', 8443],
    ['localhost with a trailing dot', 'https://localhost./', 443],
    ['a name under localhost', 'https://app.localhost/', 443],
    ['a name under localhost, mixed case, trailing dot', 'https://App.LocalHost.:9000/', 9000],
    ['an mDNS name', 'https://printer.local/', 443],
    ['an mDNS name in capitals, trailing dot', 'https://NAS.LOCAL./x', 443],
  ])('refused: %s', (_what, url, port) => {
    expect(allowRequest(url, ports)).toEqual({ allow: false, port, scheme: 'https' });
  });

  it.each([
    'https://93.184.215.14/o',
    'https://[2606:4700::6810:84e5]/o',
    'https://web.nutflix.xyz/o',
    // Names that only look local, and others whose address only DNS knows (a known limit).
    'https://localhost.example/',
    'https://local.example/',
    'https://example.localdomain/',
    'https://box.internal/',
    // Kept (the maintainer, 2026-11-26): only the viewer's Settings choose WebSocket hosts.
    'wss://192.168.1.5/',
    'wss://100.64.0.1:7777/',
    'wss://127.0.0.1/',
    'wss://localhost:7777/',
    'wss://relay.local/',
    'ws://127.0.0.1:7777/',
  ])('allowed: %s', (url) => {
    expect(allowRequest(url, ports)).toEqual({ allow: true });
  });

  it('guards https: alone, the one switch for wss:', () => {
    expect([...PRIVATE_HOST_SCHEMES]).toEqual(['https:']);
  });

  it('reads a name as always local in any case, with or without one trailing dot', () => {
    for (const n of [
      'localhost',
      'LocalHost.',
      'a.localhost',
      'b.a.LOCALHOST.',
      'nas.local',
      'NAS.Local.',
    ])
      expect(isAlwaysLocalName(n), n).toBe(true);
    for (const n of [
      'localhost.example',
      'mylocalhost',
      'local',
      'local.example',
      'nas.locale',
      'a.local..',
    ])
      expect(isAlwaysLocalName(n), n).toBe(false);
    // The page refuses every one of them already: main only repeats a narrower rule.
    for (const n of ['localhost', 'a.localhost', 'nas.local', 'nas.local.'])
      expect(isPublicHost(n), n).toBe(false);
  });

  it('reads the renderer’s own table: the same answer as isPublicHost for every literal', () => {
    for (const h of [
      '127.0.0.1',
      '10.0.0.1',
      '100.64.0.1',
      '169.254.1.1',
      '93.184.215.14',
      '8.8.8.8',
      '[::1]',
      '[fd00::1]',
      '[::ffff:7f00:1]',
      '[2606:4700::6810:84e5]',
      '[::1',
      '999.1.1.1',
    ])
      expect(publicIpLiteral(h), h).toBe(isPublicHost(h));
    for (const name of ['web.nutflix.xyz', 'localhost', 'nas.local'])
      expect(publicIpLiteral(name), name).toBeNull();
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

  it('cancels a redirect’s target too: Electron restarts a followed redirect through the same listener', () => {
    const f = fakeSession();
    const log: [string, unknown][] = [];
    installLoopbackGuard(f.ses, new WorkerPorts(), (name, fields) => log.push([name, fields]));
    // The origin a beacon named, then the URL its 302 pointed at (Electron 45.2.1:
    // `FollowRedirect` → `RestartInternal` → `onBeforeRequest` with the new URL).
    expect(f.send('https://cdn.example/o/' + 'ab'.repeat(32))).toEqual({});
    expect(f.send('https://192.168.1.1/cgi-bin/reboot')).toEqual({ cancel: true });
    expect(f.send('https://[::1]:8443/')).toEqual({ cancel: true });
    // By scheme and port only.
    expect(log).toEqual([
      ['private-refused', { scheme: 'https', port: 443 }],
      ['private-refused', { scheme: 'https', port: 8443 }],
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
