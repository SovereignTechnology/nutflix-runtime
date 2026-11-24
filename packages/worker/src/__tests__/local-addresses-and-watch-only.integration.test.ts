/**
 * Two things a viewer's machine must not do, on a local hyperdht testnet against nutflix-pear's own
 * NFX-12 code:
 *
 *   - tell a peer its local addresses: unless its node is bound to 127.0.0.1, the worker dials
 *     with `localConnection: false` and listens with `shareLocalAddress: false`
 *     (`../net/no-local-addresses.ts`). On a loopback test network the node is bound there and
 *     keeps hyperdht's defaults, so peers on one host still meet. The test switch only forces
 *     hiding on. The same two options can be set on a whole node (`hideLocalAddressesOn`, for
 *     shape (a)'s updater, whose Hyperswarm takes one);
 *   - serve anything when it is watch only (`InitArgs.watchOnly`): no listener opens at `init`
 *     even with a served video on disk, and the methods that would start one are refused.
 */
import { randomBytes } from 'node:crypto';

import type { NfxDht, NfxFileSource } from '@sovit/seeder';
import { hyperdhtEndpoint, listenNfx } from '@sovit/seeder';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkerError } from '../errors.js';
import {
  hideLocalAddressesOn,
  hidesLocalAddresses,
  isLoopbackTestnet,
  withoutLocalAddresses,
} from '../net/no-local-addresses.js';
import type { NfxHyperdhtEndpointWire, WorkerMethod } from '../protocol.js';
import { startWorker, tempDir } from './helpers/harness.js';
import { memorySource, testNfxVideo, vectorVideo } from './helpers/nfx-video.js';

vi.setConfig({ testTimeout: 120_000 });

const SEEDER_NOSTR = 'ab'.repeat(32);
const namespaceOf = (video: string): string => video.slice(0, video.lastIndexOf(':'));

describe('withoutLocalAddresses', () => {
  it('adds the two options and keeps every other', () => {
    const seen: { connect?: unknown; server?: unknown } = {};
    const dht = {
      connect: (_k: Uint8Array, opts?: unknown) => {
        seen.connect = opts;
        return {} as never;
      },
      createServer: (opts: unknown) => {
        seen.server = opts;
        return {} as never;
      },
    } as unknown as NfxDht;
    const keyPair = DHT.keyPair();
    const firewall = (): boolean => false;
    const wrapped = withoutLocalAddresses(dht);
    wrapped.connect(new Uint8Array(32), { keyPair });
    wrapped.createServer({ firewall }, () => undefined);
    expect(seen.connect).toEqual({ keyPair, localConnection: false });
    expect(seen.server).toEqual({ firewall, shareLocalAddress: false });
  });

  it('a caller cannot turn them back on', () => {
    const seen: unknown[] = [];
    const dht = {
      connect: (_k: Uint8Array, opts?: unknown) => {
        seen.push(opts);
        return {} as never;
      },
      createServer: (opts: unknown) => {
        seen.push(opts);
        return {} as never;
      },
    } as unknown as NfxDht;
    const wrapped = withoutLocalAddresses(dht);
    wrapped.connect(new Uint8Array(32), { localConnection: true });
    wrapped.createServer({ shareLocalAddress: true }, () => undefined);
    expect(seen).toEqual([{ localConnection: false }, { shareLocalAddress: false }]);
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

  it.each([
    [false, false, true],
    [false, true, true],
    [true, false, false],
    [true, true, true],
  ])('a node bound to loopback only: %s, forced: %s, hides: %s', (loopbackOnly, force, want) => {
    expect(hidesLocalAddresses({ loopbackOnly, force })).toBe(want);
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
    expect(first.host.internals?.hidesLocalAddresses).toBe(false);
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
    expect(second.host.internals?.hidesLocalAddresses).toBe(true);
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
      expect(w.host.internals?.hidesLocalAddresses).toBe(true);
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
