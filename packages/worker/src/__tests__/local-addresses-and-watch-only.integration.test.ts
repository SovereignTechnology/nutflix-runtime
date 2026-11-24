/**
 * Two things a viewer's machine must not do, on a local hyperdht testnet against nutflix-pear's own
 * NFX-12 code:
 *
 *   - tell a peer its local addresses: unless its node's socket is really bound to 127.0.0.1
 *     (read at each dial, and when a listener starts, after the bind), the worker dials with
 *     `localConnection: false` and listens with `shareLocalAddress: false`
 *     (`../net/no-local-addresses.ts`). On a loopback test network the node is bound there and
 *     keeps hyperdht's defaults, so peers on one host still meet. The test switch only forces
 *     hiding on. The same two options can be set on a whole node (`hideLocalAddressesOn`, for
 *     shape (a)'s updater, whose Hyperswarm takes one);
 *   - serve anything when it is watch only (`InitArgs.watchOnly`): no listener opens at `init`
 *     even with a served video on disk, and the methods that would start one are refused.
 */
import { randomBytes } from 'node:crypto';

import type { NfxFileSource } from '@sovit/seeder';
import { hyperdhtEndpoint, listenNfx } from '@sovit/seeder';
import DHT from 'hyperdht';
import type { KeyPair } from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkerError } from '../errors.js';
import type { BindableNode } from '../net/no-local-addresses.js';
import {
  hideLocalAddressesOn,
  hidesLocalAddresses,
  isLoopbackTestnet,
  localAddressesByBind,
} from '../net/no-local-addresses.js';
import type { NfxHyperdhtEndpointWire, WorkerMethod } from '../protocol.js';
import { startWorker, tempDir } from './helpers/harness.js';
import { memorySource, testNfxVideo, vectorVideo } from './helpers/nfx-video.js';

vi.setConfig({ testTimeout: 120_000 });

const SEEDER_NOSTR = 'ab'.repeat(32);
const namespaceOf = (video: string): string => video.slice(0, video.lastIndexOf(':'));

/**
 * A stand-in node bound to `host` (`null`: not yet; `'throws'`: its `address()` throws), recording
 * what each call was given.
 */
function fakeNode(host: string | null, bindTo?: string): {
  node: BindableNode;
  seen: unknown[];
  listened: KeyPair[];
} {
  const seen: unknown[] = [];
  const listened: KeyPair[] = [];
  let bound = host;
  const node: BindableNode = {
    address: () => {
      if (bound === 'throws') throw new Error('no socket');
      return bound === null ? null : { host: bound };
    },
    bind: () => {
      if (bindTo !== undefined) bound = bindTo;
      return Promise.resolve();
    },
    connect: (_k, opts) => {
      seen.push(opts);
      return {} as never;
    },
    createServer: (opts) => {
      seen.push(opts);
      return {
        publicKey: null,
        listen: (kp: KeyPair) => {
          listened.push(kp);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      };
    },
  };
  return { node, seen, listened };
}

describe('localAddressesByBind', () => {
  const keyPair = DHT.keyPair();
  const firewall = (): boolean => false;

  it('keeps the defaults only on a socket really bound to 127.0.0.1', async () => {
    const { node, seen } = fakeNode('127.0.0.1');
    const view = localAddressesByBind(node);
    view.connect(new Uint8Array(32), { keyPair });
    await view.createServer({ firewall }, () => undefined).listen(keyPair);
    expect(seen).toEqual([{ keyPair }, { firewall }]);
  });

  it.each([['0.0.0.0'], ['10.0.0.2'], ['127.0.0.2'], [null], ['throws']] as const)(
    'hides on a socket bound to %j (or not bound, or unreadable), and a caller cannot undo it',
    async (host) => {
      const { node, seen } = fakeNode(host);
      const view = localAddressesByBind(node);
      view.connect(new Uint8Array(32), { keyPair, localConnection: true });
      await view
        .createServer({ firewall, shareLocalAddress: true }, () => undefined)
        .listen(keyPair);
      expect(seen).toEqual([
        { keyPair, localConnection: false },
        { firewall, shareLocalAddress: false },
      ]);
    },
  );

  it('the switch only forces hiding on', async () => {
    const { node, seen } = fakeNode('127.0.0.1');
    const view = localAddressesByBind(node, { force: true });
    view.connect(new Uint8Array(32));
    await view.createServer({}, () => undefined).listen(keyPair);
    expect(seen).toEqual([{ localConnection: false }, { shareLocalAddress: false }]);
  });

  it('a listener decides after the bind, on what the socket got', async () => {
    // Unbound when the listener is made; the bind then gives 127.0.0.1, or every interface.
    for (const [bindTo, want] of [
      ['127.0.0.1', {}],
      ['0.0.0.0', { shareLocalAddress: false }],
    ] as const) {
      const { node, seen, listened } = fakeNode(null, bindTo);
      const server = localAddressesByBind(node).createServer({}, () => undefined);
      expect(seen).toEqual([]);
      expect(server.publicKey).toBeNull();
      await server.listen(keyPair);
      expect(seen).toEqual([want]);
      expect(listened).toEqual([keyPair]);
    }
  });

  it('a listener closed before it listens never listens', async () => {
    const { node, seen } = fakeNode('127.0.0.1');
    const server = localAddressesByBind(node).createServer({}, () => undefined);
    await server.close();
    await expect(server.listen(keyPair)).rejects.toThrow(/^backend-down/);
    expect(seen).toEqual([]);
  });

  it.each([
    [null, false, true],
    ['0.0.0.0', false, true],
    ['127.0.0.1', false, false],
    ['127.0.0.1', true, true],
    ['127.1.2.3', false, true],
  ])('bound to %j, forced: %s, hides: %s', (host, force, want) => {
    expect(hidesLocalAddresses({ boundHost: host, force })).toBe(want);
  });

  it.each([
    [null, false],
    [[], false],
    [[{ host: '127.0.0.1', port: 1 }], true],
    [
      [
        { host: '127.0.0.1', port: 1 },
        { host: '127.0.0.1', port: 2 },
      ],
      true,
    ],
    [
      [
        { host: '127.0.0.1', port: 1 },
        { host: '88.99.3.86', port: 49737 },
      ],
      false,
    ],
    [[{ host: '127.0.0.2', port: 1 }], false],
    [[{ host: 'localhost', port: 1 }], false],
    [[{ host: '10.0.0.1', port: 1 }], false],
  ])('treats %j as a loopback test network: %s', (b, want) => {
    expect(isLoopbackTestnet(b)).toBe(want);
  });
});

describe('hideLocalAddressesOn', () => {
  it('sets the two options on the node itself, last, in both createServer forms', () => {
    const seen: unknown[] = [];
    const node = {
      connect: (_k: Uint8Array, opts?: unknown) => {
        seen.push(opts);
        return {} as never;
      },
      createServer: (opts: unknown, cb?: unknown) => {
        seen.push([opts, cb]);
        return {} as never;
      },
    };
    const onconnection = (): void => undefined;
    const firewall = (): boolean => false;
    expect(hideLocalAddressesOn(node)).toBe(node);
    node.connect(new Uint8Array(32), { localConnection: true });
    node.connect(new Uint8Array(32));
    node.createServer({ firewall, shareLocalAddress: true }, onconnection);
    (node.createServer as (cb: unknown) => unknown)(onconnection);
    expect(seen).toEqual([
      { localConnection: false },
      { localConnection: false },
      [{ firewall, shareLocalAddress: false }, onconnection],
      [{ shareLocalAddress: false }, onconnection],
    ]);
  });

  it('a Hyperswarm given such a node dials and listens with both off', async () => {
    const testnet = await createTestnet(3);
    const calls: { kind: 'connect' | 'server'; opts: unknown }[] = [];
    const proto = DHT.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const realConnect = proto['connect'];
    const realServer = proto['createServer'];
    if (realConnect === undefined || realServer === undefined)
      throw new Error('no hyperdht methods');
    let mine: DHT | null = null;
    vi.spyOn(DHT.prototype, 'connect').mockImplementation(function (this: DHT, key, opts) {
      if (this === mine) calls.push({ kind: 'connect', opts });
      return Reflect.apply(realConnect, this, [key, opts]) as ReturnType<DHT['connect']>;
    });
    vi.spyOn(DHT.prototype, 'createServer').mockImplementation(function (this: DHT, opts, cb) {
      if (this === mine) calls.push({ kind: 'server', opts });
      return Reflect.apply(realServer, this, [opts, cb]) as ReturnType<DHT['createServer']>;
    });
    const topic = randomBytes(32);
    const server = new Hyperswarm({ bootstrap: testnet.bootstrap });
    const client = new Hyperswarm({
      dht: hideLocalAddressesOn((mine = new DHT({ bootstrap: testnet.bootstrap }))),
    });
    try {
      await server.join(topic, { server: true, client: false }).flushed();
      client.join(topic, { server: false, client: true });
      const end = Date.now() + 30_000;
      while (!calls.some((c) => c.kind === 'connect') && Date.now() < end)
        await new Promise((r) => setTimeout(r, 50));
      // The swarm's own server, made in its constructor, and its dial to the announced peer.
      expect(calls.some((c) => c.kind === 'server')).toBe(true);
      expect(calls.some((c) => c.kind === 'connect')).toBe(true);
      for (const c of calls)
        expect(c.opts).toMatchObject(
          c.kind === 'connect' ? { localConnection: false } : { shareLocalAddress: false },
        );
    } finally {
      vi.restoreAllMocks();
      await client.destroy();
      await server.destroy();
      await testnet.destroy();
    }
  });
});

describe('the worker on a testnet', () => {
  let testnet: Testnet;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    testnet = await createTestnet(3);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const c of cleanups.splice(0).reverse()) await c();
    await testnet.destroy();
  });

  async function node(): Promise<DHT> {
    // Bound to 127.0.0.1, as the worker's node is on a loopback testnet: on one host, hyperdht
    // connects two peers only when they bind alike (`src/net/no-local-addresses.ts`).
    const n = new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' });
    cleanups.push(() => n.destroy());
    await n.fullyBootstrapped();
    return n;
  }

  async function pearSeeder(
    source: NfxFileSource,
    namespace: string,
  ): Promise<NfxHyperdhtEndpointWire> {
    const dht = await node();
    const keyPair = DHT.keyPair();
    const listener = await listenNfx(dht, { keyPair, source });
    cleanups.push(() => listener.close());
    return hyperdhtEndpoint(keyPair, SEEDER_NOSTR, namespace);
  }

  it('off the loopback test network it shares no local address, dialing or serving', async () => {
    const calls: { self: unknown; kind: 'connect' | 'server'; opts: unknown }[] = [];
    // The real methods, called through: the spies only record who asked, with what.
    const proto = DHT.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const realConnect = proto['connect'];
    const realServer = proto['createServer'];
    if (realConnect === undefined || realServer === undefined)
      throw new Error('no hyperdht methods');
    vi.spyOn(DHT.prototype, 'connect').mockImplementation(function (this: DHT, key, opts) {
      calls.push({ self: this, kind: 'connect', opts });
      return Reflect.apply(realConnect, this, [key, opts]) as ReturnType<DHT['connect']>;
    });
    vi.spyOn(DHT.prototype, 'createServer').mockImplementation(function (this: DHT, opts, cb) {
      calls.push({ self: this, kind: 'server', opts });
      return Reflect.apply(realServer, this, [opts, cb]) as ReturnType<DHT['createServer']>;
    });

    const v = vectorVideo();
    const ns = namespaceOf(v.video);
    const d = await tempDir('nf-local-');
    cleanups.push(() => d.rm());
    const init = { v: 1, storage: d.dir, bootstrap: testnet.bootstrap } as const;

    // On the loopback test network: hyperdht's defaults, and the fetch works.
    const first = startWorker();
    cleanups.push(() => first.close());
    await first.client.request('init', init);
    await first.client.request('nfx.seed.start', {
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [await pearSeeder(memorySource(v.files, v.video), ns)],
    });
    const firstDht = first.host.internals?.dht.dht;
    // Bound to 127.0.0.1, and only then hyperdht's defaults.
    expect(first.host.internals?.dht.loopbackOnly).toBe(true);
    expect(firstDht?.address()?.host).toBe('127.0.0.1');
    expect(first.host.internals?.hidesLocalAddresses()).toBe(false);
    const firstCalls = calls.filter((c) => c.self === firstDht);
    expect(firstCalls.map((c) => c.kind).sort()).toEqual(['connect', 'server']);
    for (const c of firstCalls) {
      expect(c.opts).not.toHaveProperty('localConnection');
      expect(c.opts).not.toHaveProperty('shareLocalAddress');
    }
    await first.close();

    // As on any other network: it listens for the stored video, and dials, with both turned off.
    const second = startWorker({ hideLocalAddresses: true, dialTimeoutMs: 2000 });
    cleanups.push(() => second.close());
    await second.client.request('init', init);
    const other = testNfxVideo();
    await second.client
      .request('nfx.seed.start', {
        video: other.video,
        root: other.root,
        segs: other.segs,
        peers: [await pearSeeder(memorySource(other.files, other.video), namespaceOf(other.video))],
      })
      .catch(() => undefined);
    const secondDht = second.host.internals?.dht.dht;
    expect(secondDht).toBeTruthy();
    expect(second.host.internals?.hidesLocalAddresses()).toBe(true);
    const mine = calls.filter((c) => c.self === secondDht);
    expect(mine.some((c) => c.kind === 'server')).toBe(true);
    expect(mine.some((c) => c.kind === 'connect')).toBe(true);
    for (const c of mine)
      expect(c.opts).toMatchObject(
        c.kind === 'connect' ? { localConnection: false } : { shareLocalAddress: false },
      );
    // The test's own nodes were seen too, with hyperdht's defaults: the spies see every call.
    expect(calls.some((c) => c.self !== firstDht && c.self !== secondDht)).toBe(true);
    expect([...first.fatal, ...second.fatal]).toEqual([]);
  });

  it('real nodes: the view reads the bound socket, 127.0.0.1 keeps the defaults, any other hides', async () => {
    const calls: { self: unknown; kind: 'connect' | 'server'; opts: unknown }[] = [];
    const proto = DHT.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const realConnect = proto['connect'];
    const realServer = proto['createServer'];
    if (realConnect === undefined || realServer === undefined)
      throw new Error('no hyperdht methods');
    vi.spyOn(DHT.prototype, 'connect').mockImplementation(function (this: DHT, key, opts) {
      calls.push({ self: this, kind: 'connect', opts });
      return Reflect.apply(realConnect, this, [key, opts]) as ReturnType<DHT['connect']>;
    });
    vi.spyOn(DHT.prototype, 'createServer').mockImplementation(function (this: DHT, opts, cb) {
      calls.push({ self: this, kind: 'server', opts });
      return Reflect.apply(realServer, this, [opts, cb]) as ReturnType<DHT['createServer']>;
    });
    for (const [host, hidden] of [
      ['127.0.0.1', false],
      [undefined, true],
    ] as const) {
      const n = new DHT({ bootstrap: testnet.bootstrap, ...(host === undefined ? {} : { host }) });
      cleanups.push(() => n.destroy());
      const view = localAddressesByBind(n);
      // A listener made before the bind decides only once it is bound.
      const server = view.createServer({}, () => undefined);
      await server.listen(DHT.keyPair());
      cleanups.push(() => server.close());
      expect(n.address()?.host).toBe(host ?? '0.0.0.0');
      const stream = view.connect(DHT.keyPair().publicKey);
      stream.on('error', () => undefined);
      stream.destroy();
      const mine = calls.filter((c) => c.self === n);
      expect(mine.map((c) => c.kind).sort()).toEqual(['connect', 'server']);
      for (const c of mine)
        if (hidden)
          expect(c.opts).toMatchObject(
            c.kind === 'connect' ? { localConnection: false } : { shareLocalAddress: false },
          );
        else {
          expect(c.opts ?? {}).not.toHaveProperty('localConnection');
          expect(c.opts ?? {}).not.toHaveProperty('shareLocalAddress');
        }
    }
  });

  it('a node not bound to 127.0.0.1 hides, whatever the bootstrap or the test switch says', async () => {
    const d = await tempDir('nf-bind-');
    cleanups.push(() => d.rm());
    const cases: { bootstrap: { host: string; port: number }[] | null; force?: true }[] = [
      { bootstrap: null },
      { bootstrap: [{ host: '127.0.0.2', port: 49737 }] },
      { bootstrap: [...testnet.bootstrap, { host: '10.0.0.1', port: 49737 }] },
      // A JavaScript caller's `false` is not "share them": the switch only forces hiding on.
      { bootstrap: null, force: false as unknown as true },
    ];
    for (const c of cases) {
      const w = startWorker(c.force === undefined ? {} : { hideLocalAddresses: c.force });
      cleanups.push(() => w.close());
      // `init` starts no node (on demand): nothing here sends a packet.
      await w.client.request('init', { v: 1, storage: d.dir, bootstrap: c.bootstrap });
      expect(w.host.internals?.dht.state).toBe('idle');
      expect(w.host.internals?.dht.loopbackOnly).toBe(false);
      expect(w.host.internals?.hidesLocalAddresses()).toBe(true);
      await w.close();
    }
  });

  it('watch only: serves nothing at init with a served video on disk, and refuses to seed', async () => {
    const v = vectorVideo();
    const ns = namespaceOf(v.video);
    const peer = await pearSeeder(memorySource(v.files, v.video), ns);
    const d = await tempDir('nf-watch-');
    cleanups.push(() => d.rm());
    const init = { v: 1, storage: d.dir, bootstrap: testnet.bootstrap } as const;

    // A run that seeds leaves a served video behind.
    const first = startWorker();
    cleanups.push(() => first.close());
    await first.client.request('init', init);
    await first.client.request('nfx.seed.start', {
      video: v.video,
      root: v.root,
      segs: v.segs,
      peers: [peer],
    });
    expect((await first.client.request('status', {})).listening).toHaveLength(1);
    await first.close();

    // Watch only: no node, no listener, at init or after anything it may still be asked.
    const second = startWorker();
    cleanups.push(() => second.close());
    await second.client.request('init', { ...init, watchOnly: true });
    let status = await second.client.request('status', {});
    expect(status.dht).toBe('idle');
    expect(status.listening).toEqual([]);
    expect(status.storedVideos).toBe(1);

    const code = async (m: WorkerMethod, a: unknown): Promise<string> => {
      try {
        await second.host.handle(m, a as never);
        return 'ok';
      } catch (e) {
        return e instanceof WorkerError ? e.code : 'other';
      }
    };
    expect(
      await code('nfx.seed.start', { video: v.video, root: v.root, segs: v.segs, peers: [peer] }),
    ).toBe('unsupported-input');
    expect(await code('seeding.resume', { video: v.video })).toBe('unsupported-input');
    expect(
      await code('seeding.watch', {
        sid: randomBytes(16).toString('hex'),
        manifest: {},
        peers: [],
      }),
    ).toBe('unsupported-input');
    expect(await code('seeding.set', { watched: true })).toBe('unsupported-input');
    expect(await code('seeding.set', { watched: false })).toBe('ok');
    expect(
      (await second.client.request('nfx.endpoint', { seeder: SEEDER_NOSTR, namespace: ns }))
        .hyperdht,
    ).toBeNull();
    status = await second.client.request('status', {});
    expect(status.dht).toBe('idle');
    expect(status.listening).toEqual([]);

    // The same storage without the flag serves again: the flag is what held it.
    await second.close();
    const third = startWorker();
    cleanups.push(() => third.close());
    await third.client.request('init', init);
    expect((await third.client.request('status', {})).listening).toHaveLength(1);
    expect([...first.fatal, ...second.fatal, ...third.fatal]).toEqual([]);
  });
});
