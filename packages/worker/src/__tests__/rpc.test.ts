/**
 * The host ⇄ worker wire (`../rpc.ts`, `../client.ts`, `../guards.ts`): requests before `init`
 * are refused, `init` answers once and is followed by `ready`, junk never reaches a handler (a
 * request-shaped frame is answered `invalid-argument`, anything else dropped), requests in flight
 * are bounded, only the package's own error codes and messages cross, a failure with no code is
 * logged as its method, code, syscall and class and nothing else, and a corrupt stream is terminal
 * on both sides.
 */
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkerClient } from '../client.js';
import { INTERNAL, WorkerError, uncodedCause } from '../errors.js';
import { FrameDecoder, MAX_FRAME_BYTES, encodeFrame } from '../framing.js';
import { isAbsolutePath, isPlayOpenArgs } from '../guards.js';
import { createWorkerLogger } from '../log.js';
import type { NfxPlayOpenArgs, WorkerToHost } from '../protocol.js';
import { WorkerRpc } from '../rpc.js';
import type { RunningWorker } from './helpers/harness.js';
import { sleep, startWorker, tempDir, until } from './helpers/harness.js';

vi.setConfig({ testTimeout: 60_000 });

/** A `WorkerRpc` with a handler of the test's own; what it wrote, decoded. */
function bareRpc(
  handle: (m: string, a: unknown) => Promise<unknown>,
  maxInflight?: number,
): { rpc: WorkerRpc; out: WorkerToHost[]; fatal: Error[]; logged: string[] } {
  const out: WorkerToHost[] = [];
  const fatal: Error[] = [];
  const logged: string[] = [];
  const decoder = new FrameDecoder((m) => out.push(m as WorkerToHost));
  const rpc = new WorkerRpc({
    write: (b) => {
      decoder.push(b);
    },
    handler: { handle: handle as never },
    onFatal: (err) => fatal.push(err),
    log: createWorkerLogger({ emit: (ev) => logged.push(ev.msg) }),
    ...(maxInflight === undefined ? {} : { maxInflight }),
  });
  return { rpc, out, fatal, logged };
}

const req = (id: number, m: string, a: unknown): Uint8Array => encodeFrame({ op: 'req', id, m, a });

describe('WorkerRpc', () => {
  it('answers a request-shaped frame that fails a guard, drops the rest', async () => {
    const calls: string[] = [];
    const { rpc, out } = bareRpc((m) => {
      calls.push(m);
      return Promise.resolve({ v: 1 });
    });
    rpc.push(req(1, 'nope', {}));
    rpc.push(req(2, 'status', { extra: 1 }));
    rpc.push(req(3, 'init', { v: 1, storage: 'relative/dir' }));
    rpc.push(req(4, 'nfx.play.close', { sid: 'A'.repeat(32) }));
    rpc.push(encodeFrame({ op: 'req', id: 5, m: 'status', a: {}, more: true }));
    // A JSON "__proto__" key is an own key, and an unknown one.
    const proto = new TextEncoder().encode('{"op":"req","id":7,"m":"status","a":{"__proto__":{}}}');
    const framed = new Uint8Array(4 + proto.length);
    new DataView(framed.buffer).setUint32(0, proto.length, false);
    framed.set(proto, 4);
    rpc.push(framed);
    // No usable id: dropped without an answer.
    rpc.push(encodeFrame({ op: 'req', id: -1, m: 'status', a: {} }));
    rpc.push(encodeFrame({ op: 'res', id: 1, ok: true }));
    rpc.push(encodeFrame({ hello: 'world' }));
    await sleep(10);
    expect(calls).toEqual([]);
    expect(out.map((m) => (m.op === 'res' ? [m.id, m.ok ? 'ok' : m.e.code] : m.e))).toEqual([
      [1, 'invalid-argument'],
      [2, 'invalid-argument'],
      [3, 'invalid-argument'],
      [4, 'invalid-argument'],
      [5, 'invalid-argument'],
      [7, 'invalid-argument'],
    ]);
    expect(rpc.stats()).toMatchObject({ requests: 0, refused: 9, droppedFrames: 3 });
  });

  it('bounds requests in flight, sends ready after init, and lets only its own errors through', async () => {
    const never = new Promise<never>(() => undefined);
    const { rpc, out } = bareRpc((m) => (m === 'init' ? Promise.resolve({ v: 1 }) : never), 2);
    const storage = '/tmp/nf-rpc/storage';
    rpc.push(req(1, 'init', { v: 1, storage }));
    await sleep(10);
    expect(out).toEqual([
      { op: 'res', id: 1, ok: true, r: { v: 1 } },
      { op: 'ev', e: 'ready', v: 1 },
    ]);
    out.length = 0;
    rpc.push(req(2, 'status', {}));
    rpc.push(req(3, 'status', {}));
    rpc.push(req(4, 'status', {}));
    await sleep(10);
    expect(out).toEqual([
      {
        op: 'res',
        id: 4,
        ok: false,
        e: { code: 'rate-limited', message: 'rate-limited: too many requests in flight' },
      },
    ]);

    const { rpc: rpc2, out: out2 } = bareRpc((_m, a) => {
      const video = (a as { video: string }).video;
      return Promise.reject(
        video.endsWith('-aaaaaaa')
          ? new Error('boom at /home/x/secret')
          : new WorkerError('no-seeders', 'nobody had it'),
      );
    });
    rpc2.push(req(1, 'nfx.seed.stop', { video: 'nfx:testnet:1:video-aaaaaaa' }));
    rpc2.push(req(2, 'nfx.seed.stop', { video: 'nfx:testnet:1:video-bbbbbbb' }));
    await sleep(10);
    expect(out2).toEqual([
      { op: 'res', id: 1, ok: false, e: { code: 'internal', message: 'internal: internal error' } },
      {
        op: 'res',
        id: 2,
        ok: false,
        e: { code: 'no-seeders', message: 'no-seeders: nobody had it' },
      },
    ]);
  });

  it('a corrupt stream is terminal: an oversize length, bad JSON, a truncated end', () => {
    const big = new Uint8Array(4);
    new DataView(big.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false);
    const a = bareRpc(() => Promise.resolve(null));
    a.rpc.push(big);
    expect(a.fatal).toHaveLength(1);
    a.rpc.push(req(1, 'status', {}));
    expect(a.out).toEqual([]);

    const b = bareRpc(() => Promise.resolve(null));
    const junk = new TextEncoder().encode('{not json');
    const frame = new Uint8Array(4 + junk.length);
    new DataView(frame.buffer).setUint32(0, junk.length, false);
    frame.set(junk, 4);
    b.rpc.push(frame);
    expect(b.fatal).toHaveLength(1);

    const c = bareRpc(() => Promise.resolve(null));
    c.rpc.push(req(1, 'status', {}).subarray(0, 6));
    c.rpc.end();
    expect(c.fatal).toHaveLength(1);
  });
});

/** What bare-fs throws (its `lib/errors.js`): `name` and `syscall` are getters. */
class FileErrorLike extends Error {
  readonly code: string;
  readonly operation: string;
  readonly path: string;
  readonly destination: string;
  constructor(code: string, operation: string, path: string, destination: string) {
    super(`${code}: operation not permitted, ${operation} "${path}" -> "${destination}"`);
    this.code = code;
    this.operation = operation;
    this.path = path;
    this.destination = destination;
  }
  get syscall(): string {
    return this.operation;
  }
}
Object.defineProperty(FileErrorLike.prototype, 'name', { get: () => 'FileError' });

describe('a failure with no code', () => {
  const PRIVATE = '/home/someone/Videos/a private title';
  const VIDEO = 'nfx:testnet:1:video-secretarg';
  const parsed = (line: string | undefined): Record<string, unknown> =>
    JSON.parse(line ?? 'null') as Record<string, unknown>;

  it('crosses as internal, and is logged as its method, code, syscall and class only', async () => {
    const errors: Error[] = [
      // Node's: the message, `path` and `dest` name the files.
      Object.assign(new Error(`EPERM: operation not permitted, rename '${PRIVATE}.tmp'`), {
        errno: -4048,
        code: 'EPERM',
        syscall: 'rename',
        path: `${PRIVATE}.tmp`,
        dest: PRIVATE,
        info: { title: PRIVATE },
      }),
      new FileErrorLike('EBUSY', 'rename', `${PRIVATE}.tmp`, PRIVATE),
    ];
    const { rpc, out, logged } = bareRpc((_m, a) => {
      const err = errors[Number((a as { video: string }).video.at(-1))];
      return err === undefined ? Promise.resolve(null) : Promise.reject(err);
    });
    rpc.push(req(1, 'seeding.stop', { video: `${VIDEO}0` }));
    rpc.push(req(2, 'nfx.seed.stop', { video: `${VIDEO}1` }));
    await sleep(10);
    expect(out).toEqual([
      { op: 'res', id: 1, ok: false, e: INTERNAL },
      { op: 'res', id: 2, ok: false, e: INTERNAL },
    ]);
    expect(logged).toHaveLength(2);
    const [first, second] = logged.map((l) => parsed(l));
    expect(Object.keys(first ?? {}).sort()).toEqual(['fields', 'level', 'msg', 'ts']);
    expect(first).toMatchObject({ level: 'error', msg: 'rpc: a request failed with no code' });
    expect(first?.['fields']).toEqual({
      component: 'worker',
      method: 'seeding.stop',
      code: 'EPERM',
      syscall: 'rename',
      name: 'Error',
    });
    expect(second?.['fields']).toEqual({
      component: 'worker',
      method: 'nfx.seed.stop',
      code: 'EBUSY',
      syscall: 'rename',
      name: 'FileError',
    });
    const leaks = ['someone', 'Videos', 'private title', 'secretarg', 'not permitted', '4048'];
    for (const line of logged) for (const leak of leaks) expect(line).not.toContain(leak);
  });

  it('a code, syscall or class not shaped like one is left out', () => {
    const odd = Object.assign(new Error('x'), {
      code: PRIVATE,
      syscall: 'rename /home/someone',
      name: 'Error: at /home/someone',
    });
    expect(uncodedCause(odd)).toEqual({ code: null, syscall: null, name: null });
    const throwing = Object.defineProperty(new Error('x'), 'code', {
      get: (): never => {
        throw new Error(PRIVATE);
      },
    });
    expect(uncodedCause(throwing)).toEqual({ code: null, syscall: null, name: 'Error' });
    expect(uncodedCause(`boom at ${PRIVATE}`)).toEqual({ code: null, syscall: null, name: null });
    expect(uncodedCause(undefined)).toEqual({ code: null, syscall: null, name: null });
    expect(uncodedCause({ code: 'ERR_STREAM_PREMATURE_CLOSE', name: 'AbortError' })).toEqual({
      code: 'ERR_STREAM_PREMATURE_CLOSE',
      syscall: null,
      name: 'AbortError',
    });
  });

  it('a failure with a code of its own is not logged: its message says what went wrong', async () => {
    expect(uncodedCause(new WorkerError('io', 'the store could not write'))).toBeNull();
    expect(uncodedCause(new Error('no-seeders: nobody had it'))).toBeNull();
    const { rpc, out, logged } = bareRpc(() =>
      Promise.reject(new WorkerError('io', 'the store could not write')),
    );
    rpc.push(req(1, 'seeding.stop', { video: `${VIDEO}0` }));
    await sleep(10);
    expect(out).toEqual([
      { op: 'res', id: 1, ok: false, e: { code: 'io', message: 'io: the store could not write' } },
    ]);
    expect(logged).toEqual([]);
  });

  it('an answer that cannot be sent crosses as internal, logged by its method alone', async () => {
    const { rpc, out, logged } = bareRpc(() =>
      Promise.resolve({ big: 'x'.repeat(MAX_FRAME_BYTES), title: PRIVATE }),
    );
    rpc.push(req(1, 'status', {}));
    await sleep(10);
    expect(out).toEqual([{ op: 'res', id: 1, ok: false, e: INTERNAL }]);
    expect(logged).toHaveLength(1);
    expect(parsed(logged[0])).toMatchObject({
      msg: 'rpc: an answer could not be sent',
      fields: { component: 'worker', method: 'status' },
    });
    expect(Object.keys(parsed(logged[0])['fields'] as object).sort()).toEqual([
      'component',
      'method',
    ]);
    expect(logged[0]).not.toContain('someone');
  });

  it('a logger that throws does not keep the answer back', async () => {
    const out: WorkerToHost[] = [];
    const decoder = new FrameDecoder((m) => out.push(m as WorkerToHost));
    const rpc = new WorkerRpc({
      write: (b) => {
        decoder.push(b);
      },
      handler: { handle: () => Promise.reject(new Error(PRIVATE)) },
      onFatal: () => undefined,
      log: {
        error: () => {
          throw new Error('the log is gone');
        },
      },
    });
    rpc.push(req(1, 'status', {}));
    await sleep(10);
    expect(out).toEqual([{ op: 'res', id: 1, ok: false, e: INTERNAL }]);
  });
});

describe('WorkerClient', () => {
  it('times out a request, and fails everything pending when the worker goes', async () => {
    const written: Uint8Array[] = [];
    const client = new WorkerClient({ write: (b) => written.push(b), timeoutMs: 50 });
    await expect(client.request('status', {})).rejects.toMatchObject({ code: 'backend-down' });
    const pending = client.request('status', {}, { timeoutMs: 10_000 });
    client.end();
    await expect(pending).rejects.toMatchObject({ code: 'backend-down' });
    await expect(client.request('status', {})).rejects.toMatchObject({ code: 'backend-down' });
    expect(written).toHaveLength(2);
  });
});

describe('guards', () => {
  it('storage: absolute, two names deep, no dot names', () => {
    for (const ok of ['/tmp/nf-a', '/home/u/.local/share/nutflix', 'C:\\Users\\u\\nutflix'])
      expect(isAbsolutePath(ok), ok).toBe(true);
    for (const bad of [
      '',
      '/',
      '/home',
      'rel/dir',
      '/a/../b',
      '/a/./b',
      '/a/..',
      'C:\\x',
      '/a/b\u0000',
    ])
      expect(isAbsolutePath(bad), JSON.stringify(bad)).toBe(false);
  });

  it('nfx.play.open: one way to serve at least, unique peers and renditions, held adds up', () => {
    const base: NfxPlayOpenArgs = {
      sid: 'a'.repeat(32),
      video: 'nfx:testnet:1:nutflix-video',
      root: 'b'.repeat(64),
      segs: 3,
      peers: [{ t: 'hyperdht', peer: 'c'.repeat(64), bind: 'd'.repeat(128) }],
    };
    expect(isPlayOpenArgs(base)).toBe(true);
    expect(isPlayOpenArgs({ ...base, progressive: false })).toBe(true);
    expect(isPlayOpenArgs({ ...base, progressive: false, origin: false })).toBe(false);
    expect(isPlayOpenArgs({ ...base, peers: [...base.peers, ...base.peers] })).toBe(false);
    expect(isPlayOpenArgs({ ...base, renditions: ['720p', '720p'] })).toBe(false);
    expect(isPlayOpenArgs({ ...base, renditions: [] })).toBe(false);
    // Video ids are 7..63 characters (NFX-02 §2); a short one is no address at all.
    expect(isPlayOpenArgs({ ...base, video: 'nfx:testnet:1:short' })).toBe(false);
    expect(isPlayOpenArgs({ ...base, video: 'nfx:testnet:1:Nutflix-video' })).toBe(false);
    expect(isPlayOpenArgs({ ...base, root: 'B'.repeat(64) })).toBe(false);
    expect(isPlayOpenArgs({ ...base, segs: 0 })).toBe(false);
    expect(isPlayOpenArgs({ ...base, prefetchSeconds: 601 })).toBe(false);
    expect(isPlayOpenArgs({ ...base, held: { seeders: 2, all: 1, named: [['720p', 1]] } })).toBe(
      true,
    );
    expect(isPlayOpenArgs({ ...base, held: { seeders: 2, all: 1, named: [['720p', 2]] } })).toBe(
      false,
    );
    expect(
      isPlayOpenArgs({
        ...base,
        held: {
          seeders: 2,
          all: 0,
          named: [
            ['720p', 1],
            ['720p', 1],
          ],
        },
      }),
    ).toBe(false);
  });
});

describe('the worker over the wire', () => {
  let testnet: Testnet;
  const cleanups: (() => Promise<void>)[] = [];
  beforeEach(async () => {
    testnet = await createTestnet(3);
  });
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    await testnet.destroy();
  });

  async function worker(): Promise<{ w: RunningWorker; storage: string }> {
    const d = await tempDir('nf-rpc-');
    const w = startWorker();
    cleanups.push(
      () => d.rm(),
      () => w.close(),
    );
    return { w, storage: d.dir };
  }

  it('refuses everything before init, inits once, then answers', async () => {
    const { w, storage } = await worker();
    await expect(w.client.request('status', {})).rejects.toMatchObject({ code: 'not-ready' });
    await expect(w.client.request('init', { v: 1, storage: '/' } as never)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(await w.client.request('init', { v: 1, storage, bootstrap: testnet.bootstrap })).toEqual(
      { v: 1 },
    );
    await until(() => w.events.some((e) => e.e === 'ready'), 'the ready event');
    await expect(
      w.client.request('init', { v: 1, storage, bootstrap: testnet.bootstrap }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });

    expect(await w.client.request('nfx.seed.list', {})).toEqual({ videos: [], listening: [] });
    expect(
      await w.client.request('nfx.endpoint', {
        seeder: 'ab'.repeat(32),
        namespace: 'nfx:testnet:1',
      }),
    ).toEqual({ hyperdht: null });
    // Nothing to play or seed: no DHT node, so nothing was sent.
    expect(await w.client.request('status', {})).toEqual({
      dht: 'idle',
      playSessions: 0,
      storedVideos: 0,
      listening: [],
    });
    // A play of a video nobody serves and this node does not store.
    await expect(
      w.client.request('nfx.play.open', {
        sid: 'f'.repeat(32),
        video: 'nfx:testnet:1:nutflix-video',
        root: 'b'.repeat(64),
        segs: 3,
        peers: [],
      }),
    ).rejects.toMatchObject({ code: 'no-seeders' });
    await w.client.request('nfx.play.close', { sid: 'f'.repeat(32) });

    await w.close();
    await expect(w.client.request('status', {})).rejects.toMatchObject({
      code: 'backend-down',
    });
    expect(w.fatal).toEqual([]);
  });
});
