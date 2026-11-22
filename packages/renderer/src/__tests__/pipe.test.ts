// @vitest-environment node
/**
 * `WorkerLink` over a `WorkerPipe`, against the worker's own `WorkerRpc` (real framing, real
 * argument guards): what the renderer writes is what the worker's guards accept, and what the
 * worker answers is what the link reads. The handler is scripted; the worker's behaviour is the
 * worker package's own tests'.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  WorkerError,
  type ArgsOf,
  type ResultOf,
  type WorkerMethod,
} from '@nutflix-runtime/worker';
import { WorkerRpc } from '@nutflix-runtime/worker/rpc';

import { WorkerLink, asWorkerPipe, type WorkerPipe } from '../worker/pipe.js';

class MemoryPipe implements WorkerPipe {
  readonly #data = new Set<(b: Uint8Array) => void>();
  readonly #close = new Set<() => void>();
  readonly toWorker: Uint8Array[] = [];
  closed = false;
  /** Set by the test: where the bytes the renderer writes go. */
  onWrite: (b: Uint8Array) => void = (b) => {
    this.toWorker.push(b);
  };
  write(bytes: Uint8Array): void {
    if (this.closed) throw new Error('closed');
    this.onWrite(bytes);
  }
  onData(cb: (b: Uint8Array) => void): () => void {
    this.#data.add(cb);
    return () => this.#data.delete(cb);
  }
  onClose(cb: () => void): () => void {
    this.#close.add(cb);
    return () => this.#close.delete(cb);
  }
  close(): void {
    this.closed = true;
    this.end();
  }
  /** Bytes from the worker. */
  push(bytes: Uint8Array): void {
    for (const cb of [...this.#data]) cb(bytes);
  }
  /** The worker went away. */
  end(): void {
    for (const cb of [...this.#close]) cb();
  }
}

const SID = 'ab'.repeat(16);
const OPEN: ArgsOf<'nfx.play.open'> = {
  sid: SID,
  video: 'nfx:testnet:1:nutflix-abcdefg',
  root: 'cd'.repeat(32),
  segs: 5,
  peers: [{ t: 'hyperdht', peer: 'ef'.repeat(32), bind: '01'.repeat(64) }],
  held: { seeders: 1, all: 1, named: [] },
  prefetchSeconds: 30,
  origin: false,
};

interface Rig {
  readonly pipe: MemoryPipe;
  readonly rpc: WorkerRpc;
  readonly seen: { m: string; a: unknown }[];
  readonly fatal: Error[];
  link: WorkerLink;
}

const links: WorkerLink[] = [];
afterEach(() => {
  for (const l of links.splice(0)) l.dispose();
});

function rig(
  handle: <M extends WorkerMethod>(m: M, a: ArgsOf<M>) => Promise<ResultOf<M>>,
  o: { readyPollMs?: number; readyWaitMs?: number } = {},
): Rig {
  const pipe = new MemoryPipe();
  const seen: { m: string; a: unknown }[] = [];
  const fatal: Error[] = [];
  const rpc = new WorkerRpc({
    write: (b) => {
      setImmediate(() => {
        pipe.push(b);
      });
    },
    handler: {
      handle: (m, a) => {
        seen.push({ m, a });
        return handle(m, a);
      },
    },
    onFatal: (e) => fatal.push(e),
  });
  pipe.onWrite = (b) => {
    setImmediate(() => {
      rpc.push(b);
    });
  };
  const link = new WorkerLink({ pipe, readyPollMs: 5, ...o });
  links.push(link);
  return { pipe, rpc, seen, fatal, link };
}

const OPENED: ResultOf<'nfx.play.open'> = {
  progressiveUrl: `http://127.0.0.1:4000/${'a'.repeat(32)}/${SID}`,
  originUrl: null,
  rendition: '720p',
  renditions: [{ id: '720p', bandwidth: 1000 }],
};

describe('WorkerLink', () => {
  it('opens a play with arguments the worker’s own guards accept, and closes it', async () => {
    const r = rig((m) => {
      if (m === 'nfx.play.open') return Promise.resolve(OPENED as never);
      if (m === 'nfx.play.close') return Promise.resolve(null as never);
      return Promise.reject(new WorkerError('not-ready', 'no'));
    });
    await expect(r.link.open(OPEN)).resolves.toEqual(OPENED);
    await r.link.close(SID);
    expect(r.seen).toEqual([
      { m: 'nfx.play.open', a: OPEN },
      { m: 'nfx.play.close', a: { sid: SID } },
    ]);
    expect(r.fatal).toEqual([]);
  });

  it('a request the guards refuse is refused with its code, and the worker never sees it', async () => {
    const r = rig(() => Promise.reject(new WorkerError('internal', 'unreachable')));
    await expect(r.link.open({ ...OPEN, sid: 'not hex' })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(
      r.link.open({ ...OPEN, peers: [{ t: 'hyperdht', peer: 'x', bind: 'y' }] }),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(r.seen).toEqual([]);
  });

  it('ready waits while the worker answers not-ready, then resolves once, memoised', async () => {
    let n = 0;
    const r = rig((m) => {
      if (m !== 'status') return Promise.reject(new WorkerError('internal', 'x'));
      n += 1;
      return n < 3
        ? Promise.reject(new WorkerError('not-ready', 'not yet'))
        : Promise.resolve({ dht: true, playSessions: 0, storedVideos: 0, listening: [] } as never);
    });
    await Promise.all([r.link.ready(), r.link.ready()]);
    await r.link.ready();
    expect(n).toBe(3);
  });

  it('ready gives up with the worker’s code after its wait, and may be asked again', async () => {
    let up = false;
    const r = rig(
      (m) =>
        m === 'status' && up
          ? Promise.resolve({ dht: true, playSessions: 0, storedVideos: 0, listening: [] } as never)
          : Promise.reject(new WorkerError('not-ready', 'not yet')),
      { readyWaitMs: 30 },
    );
    await expect(r.link.ready()).rejects.toMatchObject({ code: 'not-ready' });
    up = true;
    await expect(r.link.ready()).resolves.toBeUndefined();
  });

  it('a pipe that closes fails what is pending as backend-down and says the worker is down', async () => {
    const r = rig(() => new Promise(() => undefined));
    let down = 0;
    r.link.onDown(() => {
      down += 1;
    });
    const p = r.link.open(OPEN);
    const failed = p.catch((e: unknown) => e);
    await new Promise((res) => setTimeout(res, 20));
    r.pipe.end();
    expect(await failed).toMatchObject({ code: 'backend-down' });
    expect(down).toBe(1);
    // After it, a listener hears at once, and every request fails.
    let late = 0;
    r.link.onDown(() => {
      late += 1;
    });
    expect(late).toBe(1);
    await expect(r.link.open(OPEN)).rejects.toMatchObject({ code: 'backend-down' });
  });

  it('corrupt bytes from the worker end the link: no resync', async () => {
    const r = rig(() => Promise.reject(new WorkerError('internal', 'x')));
    let down = 0;
    r.link.onDown(() => {
      down += 1;
    });
    // A frame header claiming 2 GiB.
    r.pipe.push(Uint8Array.of(0x80, 0, 0, 0, 1, 2, 3));
    expect(down).toBe(1);
    await expect(r.link.close(SID)).rejects.toMatchObject({ code: 'backend-down' });
  });

  it('a pipe that throws on write fails the request, not the page', async () => {
    const r = rig(() => Promise.reject(new WorkerError('internal', 'x')));
    r.pipe.closed = true;
    await expect(r.link.open(OPEN)).rejects.toMatchObject({ code: 'backend-down' });
  });

  it('dispose detaches from the pipe', async () => {
    const r = rig(() => Promise.resolve(OPENED as never));
    const p = r.link.open(OPEN);
    r.link.dispose();
    r.pipe.push(Uint8Array.of(0));
    await expect(p).rejects.toMatchObject({ code: 'backend-down' });
  });
});

describe('asWorkerPipe', () => {
  it('takes an object with the four methods and nothing else', () => {
    const noop = (): void => undefined;
    const p = { write: noop, onData: noop, onClose: noop, close: noop };
    expect(asWorkerPipe(p)).toBe(p);
    for (const bad of [null, undefined, 1, 'x', {}, { ...p, close: 1 }, { write: noop }]) {
      expect(asWorkerPipe(bad)).toBeNull();
    }
  });
});
