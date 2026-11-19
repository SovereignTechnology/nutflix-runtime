/**
 * The host's side of the host ⇄ worker wire: numbered requests with a deadline, responses
 * matched by id, events handed on. Runtime-neutral like `./rpc.ts` (bytes in through `push`,
 * out through `write`), so a Pear shell's main process, a renderer bridge and the tests share it.
 *
 * Corrupt input (`FramingError`) is terminal, as on the worker's side: every pending request
 * fails `backend-down` and `onFatal` runs; the owner tears the worker down.
 */
import { INTERNAL, MAX_ERROR_MESSAGE, WorkerError, fromWireError, isErrorCode } from './errors.js';
import { FrameDecoder, FramingError, encodeFrame } from './framing.js';
import type { ArgsOf, ResultOf, WireError, WorkerEvent, WorkerMethod } from './protocol.js';
import { MAX_MSG_ID } from './protocol.js';

/** A request's default deadline: a seed fetches a whole video before it answers. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60_000;

export interface WorkerClientOptions {
  /** Bytes to the worker (one frame per call). */
  readonly write: (bytes: Uint8Array) => void;
  readonly onEvent?: (ev: WorkerEvent) => void;
  /** The stream from the worker is corrupt, or it ended inside a frame. */
  readonly onFatal?: (err: FramingError) => void;
  readonly timeoutMs?: number;
}

interface Pending {
  readonly resolve: (r: unknown) => void;
  readonly reject: (e: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** No `./guards.ts` here: it loads `@sovit/core`, which a renderer bridge need not carry. */
function isWireError(x: unknown): x is WireError {
  if (!isRecord(x)) return false;
  const message = x['message'];
  return (
    isErrorCode(x['code']) && typeof message === 'string' && message.length <= MAX_ERROR_MESSAGE
  );
}

export class WorkerClient {
  private readonly o: WorkerClientOptions;
  private readonly decoder: FrameDecoder;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private dead: Error | null = null;

  constructor(o: WorkerClientOptions) {
    this.o = o;
    this.decoder = new FrameDecoder((msg) => {
      this.onMessage(msg);
    });
  }

  /** Requests waiting for an answer. */
  get inflight(): number {
    return this.pending.size;
  }

  request<M extends WorkerMethod>(
    m: M,
    a: ArgsOf<M>,
    opts: { readonly timeoutMs?: number } = {},
  ): Promise<ResultOf<M>> {
    if (this.dead !== null) return Promise.reject(this.dead);
    const id = this.nextId;
    this.nextId = this.nextId >= MAX_MSG_ID ? 1 : this.nextId + 1;
    let bytes: Uint8Array;
    try {
      bytes = encodeFrame({ op: 'req', id, m, a });
    } catch {
      return Promise.reject(new WorkerError('invalid-argument', `${m}: not serialisable`));
    }
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          if (this.pending.delete(id))
            reject(new WorkerError('backend-down', `the worker did not answer ${m} in time`));
        },
        opts.timeoutMs ?? this.o.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
      try {
        this.o.write(bytes);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new WorkerError('backend-down', 'the worker pipe is closed'));
      }
    });
  }

  /** Raw bytes from the worker. Never throws. */
  push(chunk: Uint8Array): void {
    if (this.dead !== null) return;
    try {
      this.decoder.push(chunk);
    } catch (err) {
      this.die(
        err instanceof FramingError ? err : new FramingError('invalid-json', 'decode failed'),
      );
    }
  }

  /** The worker's side ended: everything pending fails. */
  end(): void {
    if (this.dead !== null) return;
    try {
      this.decoder.end();
    } catch (err) {
      this.die(err instanceof FramingError ? err : new FramingError('truncated', 'stream ended'));
      return;
    }
    this.failAll(new WorkerError('backend-down', 'the worker pipe closed'));
  }

  private onMessage(msg: unknown): void {
    if (!isRecord(msg)) return;
    if (msg['op'] === 'ev') {
      if (typeof msg['e'] === 'string') this.o.onEvent?.(msg as unknown as WorkerEvent);
      return;
    }
    if (msg['op'] !== 'res' || typeof msg['id'] !== 'number') return;
    const p = this.pending.get(msg['id']);
    if (p === undefined) return;
    this.pending.delete(msg['id']);
    clearTimeout(p.timer);
    if (msg['ok'] === true) p.resolve(msg['r']);
    else p.reject(fromWireError(isWireError(msg['e']) ? msg['e'] : INTERNAL));
  }

  private die(err: FramingError): void {
    if (this.dead !== null) return;
    this.dead = new WorkerError('backend-down', 'the worker pipe is corrupt');
    this.failAll(this.dead);
    this.o.onFatal?.(err);
  }

  private failAll(err: Error): void {
    if (this.dead === null) this.dead = err;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err);
    }
  }
}
