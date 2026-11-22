import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_PIPE_CHUNK, OPEN_LINK, PIPE_CLOSE, PIPE_DATA, PIPE_WRITE } from '../shared/ids.ts';
import { STDERR_BUDGET_BYTES, startWorker } from '../main/worker-proc.ts';

// ---- the preload, against a fake electron -------------------------------------------------------

const ipc = new EventEmitter();
const sent: [string, unknown][] = [];
const exposed = new Map<string, unknown>();

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, api: unknown): void => {
      exposed.set(name, api);
    },
  },
  ipcRenderer: {
    on: (ch: string, l: (...a: unknown[]) => void): void => {
      ipc.on(ch, l);
    },
    send: (ch: string, payload: unknown): void => {
      sent.push([ch, payload]);
    },
  },
}));

interface Pipe {
  write(b: unknown): void;
  onData(cb: unknown): () => void;
  onClose(cb: unknown): () => void;
  close(): void;
}

describe('the preload', () => {
  let pipe: Pipe;
  let openLink: (u: unknown) => void;
  beforeEach(async () => {
    vi.resetModules();
    ipc.removeAllListeners();
    sent.length = 0;
    exposed.clear();
    await import('../preload/preload.ts');
    pipe = exposed.get('nutflixWorkerPipe') as Pipe;
    openLink = exposed.get('nutflixOpenLink') as (u: unknown) => void;
  });

  it('exposes exactly two names, and the pipe has exactly four methods', () => {
    expect([...exposed.keys()].sort()).toEqual(['nutflixOpenLink', 'nutflixWorkerPipe']);
    expect(Object.keys(pipe).sort()).toEqual(['close', 'onClose', 'onData', 'write']);
  });

  it('sends a frame on the one write channel, as a copy', () => {
    const frame = new Uint8Array([0, 0, 0, 2, 123, 125]);
    pipe.write(frame);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[0]).toBe(PIPE_WRITE);
    expect(sent[0]?.[1]).toEqual(frame);
    expect(sent[0]?.[1]).not.toBe(frame);
  });

  it.each([
    ['text'],
    [null],
    [[1, 2]],
    [new Uint8Array(0)],
    [new Uint8Array(MAX_PIPE_CHUNK + 1)],
    [{ length: 3 }],
  ])('refuses to write %#', (bad) => {
    expect(() => {
      pipe.write(bad);
    }).toThrow(TypeError);
    expect(sent).toEqual([]);
  });

  it("delivers the worker's bytes to each listener as its own copy, until it unsubscribes", () => {
    const a = vi.fn();
    const b = vi.fn();
    const off = pipe.onData(a);
    pipe.onData(b);
    const bytes = new Uint8Array([1, 2, 3]);
    ipc.emit(PIPE_DATA, {}, bytes);
    expect(a.mock.calls[0]?.[0]).toEqual(bytes);
    expect(a.mock.calls[0]?.[0]).not.toBe(b.mock.calls[0]?.[0]);
    off();
    ipc.emit(PIPE_DATA, {}, bytes);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    ipc.emit(PIPE_DATA, {}, 'not bytes');
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('closes when main says so, or when the page does: listeners hear it once, and writes throw', () => {
    const closed = vi.fn();
    pipe.onClose(closed);
    ipc.emit(PIPE_CLOSE, {});
    ipc.emit(PIPE_CLOSE, {});
    expect(closed).toHaveBeenCalledTimes(1);
    expect(() => {
      pipe.write(new Uint8Array(1));
    }).toThrow();
    const late = vi.fn();
    pipe.onClose(late);
    return Promise.resolve().then(() => {
      expect(late).toHaveBeenCalledTimes(1);
    });
  });

  it('a page-side close stops delivery', () => {
    const data = vi.fn();
    pipe.onData(data);
    pipe.close();
    ipc.emit(PIPE_DATA, {}, new Uint8Array(1));
    expect(data).not.toHaveBeenCalled();
  });

  it('passes a link string, bounded, on the one link channel, and nothing else', () => {
    openLink('https://example.com/');
    openLink(5);
    openLink({ toString: () => 'https://example.com/' });
    openLink('https://example.com/' + 'a'.repeat(2100));
    expect(sent).toEqual([[OPEN_LINK, 'https://example.com/']]);
  });

  it('uses no channel but the three it names', () => {
    pipe.write(new Uint8Array(1));
    openLink('https://example.com/');
    expect(new Set(sent.map(([c]) => c))).toEqual(new Set([PIPE_WRITE, OPEN_LINK]));
    expect(ipc.eventNames().sort()).toEqual([PIPE_CLOSE, PIPE_DATA].sort());
  });
});

// ---- the worker process, against a fake sidecar --------------------------------------------------

class FakeSidecar extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly written: Uint8Array[] = [];
  destroyed = 0;
  write(b: Uint8Array): boolean {
    this.written.push(b);
    return true;
  }
  destroy(): void {
    this.destroyed++;
  }
}

describe('startWorker', () => {
  const mk = () => {
    const sc = new FakeSidecar();
    const gate = { fromWorker: vi.fn(), workerGone: vi.fn() };
    const log: string[] = [];
    const err: string[] = [];
    const run = vi.fn(() => sc as never);
    const w = startWorker({
      entry: '/app/worker.js',
      run,
      gate,
      log: (n) => log.push(n),
      stderr: (t) => err.push(t),
    });
    return { sc, gate, log, err, run, w };
  };

  it('starts the entry through run() with no extra arguments, and no updater is involved', () => {
    const { run } = mk();
    expect(run).toHaveBeenCalledWith('/app/worker.js', []);
  });

  it("hands the worker's bytes to the gate and the gate's bytes to the worker", () => {
    const { sc, gate, w } = mk();
    sc.emit('data', new Uint8Array([1, 2]));
    expect(gate.fromWorker).toHaveBeenCalledWith(new Uint8Array([1, 2]));
    w.write(new Uint8Array([9]));
    expect(sc.written).toEqual([new Uint8Array([9])]);
  });

  it('tells the gate once when the worker exits, errors or closes', () => {
    const { sc, gate, log, w } = mk();
    sc.emit('exit', 3);
    sc.emit('close');
    sc.emit('error', new Error('x'));
    expect(gate.workerGone).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['worker-exit']);
    expect(() => {
      w.write(new Uint8Array(1));
    }).toThrow();
  });

  it('prints worker stderr, bounded in all, and drains stdout', () => {
    const { sc, err } = mk();
    sc.stderr.emit('data', Buffer.from('boom\n'));
    expect(err).toEqual(['[worker] boom\n']);
    sc.stderr.emit('data', Buffer.alloc(STDERR_BUDGET_BYTES, 120));
    sc.stderr.emit('data', Buffer.from('more'));
    expect(err.join('').length).toBeLessThan(STDERR_BUDGET_BYTES + 200);
    expect(() => sc.stdout.emit('data', Buffer.from('x'))).not.toThrow();
  });

  it('stops the worker once', () => {
    const { sc, w } = mk();
    w.stop();
    w.stop();
    expect(sc.destroyed).toBe(1);
  });
});
