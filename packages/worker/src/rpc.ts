/**
 * The worker's side of the host ⇄ worker wire, after nutflix-pear's `worker/rpc.ts`.
 * Runtime-neutral: it is handed a `write` function and fed raw chunks, so tests drive it
 * directly and the Bare entry wires it to `Bare.IPC`.
 *
 *   - every decoded frame goes through `isRequest` (a known method with valid arguments); junk is
 *     refused: a frame that looks like a request with a usable `id` gets an `invalid-argument`
 *     response, anything else is dropped. Nothing unchecked reaches a handler;
 *   - requests run concurrently up to `maxInflight` (then `rate-limited`), so a host cannot make
 *     the worker hold unbounded work; a handler's failure becomes a `WireError` (`toWireError`:
 *     only this package's own codes and messages cross);
 *   - the `ready` event follows a successful `init` response;
 *   - a corrupt stream (`FramingError`: an oversize length, bad UTF-8 or JSON) is terminal:
 *     `onFatal`, no resync (the entry exits). The frame cap bounds what one frame can buffer.
 *
 * `push()` never throws.
 */
import { INTERNAL, toWireError } from './errors.js';
import { FrameDecoder, FramingError, encodeFrame } from './framing.js';
import { isRequest, requestId } from './guards.js';
import type { ArgsOf, ResultOf, WorkerEvent, WorkerMethod } from './protocol.js';
import { PROTOCOL_V } from './protocol.js';

export interface WorkerRpcHandler {
  handle<M extends WorkerMethod>(m: M, a: ArgsOf<M>): Promise<ResultOf<M>>;
}

export interface WorkerRpcOptions {
  /** Bytes to the host (one frame per call). */
  readonly write: (bytes: Uint8Array) => void;
  readonly handler: WorkerRpcHandler;
  /** The stream is corrupt: tear the worker down (no resync). */
  readonly onFatal: (err: FramingError) => void;
  /** Host requests in flight at once (default `DEFAULT_MAX_INFLIGHT`). */
  readonly maxInflight?: number;
  /** Payload cap per frame, both ways (default and maximum: `MAX_FRAME_BYTES`). */
  readonly maxFrameBytes?: number;
}

export interface WorkerRpcStats {
  readonly requests: number;
  readonly refused: number;
  readonly droppedFrames: number;
}

export const DEFAULT_MAX_INFLIGHT = 64;

export class WorkerRpc {
  private readonly o: WorkerRpcOptions;
  private readonly decoder: FrameDecoder;
  private inflight = 0;
  private dead = false;
  private readonly counters = { requests: 0, refused: 0, droppedFrames: 0 };

  constructor(o: WorkerRpcOptions) {
    this.o = o;
    this.decoder = new FrameDecoder(
      (msg) => {
        this.onMessage(msg);
      },
      o.maxFrameBytes === undefined ? undefined : { maxFrameBytes: o.maxFrameBytes },
    );
  }

  stats(): WorkerRpcStats {
    return { ...this.counters };
  }

  /** Raw bytes from the host. Never throws. */
  push(chunk: Uint8Array): void {
    if (this.dead) return;
    try {
      this.decoder.push(chunk);
    } catch (err) {
      this.die(
        err instanceof FramingError ? err : new FramingError('invalid-json', 'decode failed'),
      );
    }
  }

  /** The pipe ended: a partial frame is corrupt. */
  end(): void {
    if (this.dead) return;
    try {
      this.decoder.end();
    } catch (err) {
      this.die(err instanceof FramingError ? err : new FramingError('truncated', 'stream ended'));
    }
  }

  /** Send an event (dropped when it cannot be framed). */
  emit(ev: WorkerEvent): void {
    this.send(ev);
  }

  private onMessage(msg: unknown): void {
    if (!isRequest(msg)) {
      this.counters.refused++;
      const id = requestId(msg);
      if (id === null) {
        this.counters.droppedFrames++;
        return;
      }
      this.send({
        op: 'res',
        id,
        ok: false,
        e: { code: 'invalid-argument', message: 'invalid-argument: the request failed validation' },
      });
      return;
    }
    this.counters.requests++;
    if (this.inflight >= (this.o.maxInflight ?? DEFAULT_MAX_INFLIGHT)) {
      this.send({
        op: 'res',
        id: msg.id,
        ok: false,
        e: { code: 'rate-limited', message: 'rate-limited: too many requests in flight' },
      });
      return;
    }
    this.inflight++;
    const { id, m } = msg;
    void this.o.handler
      .handle(m, msg.a)
      .then(
        (r) => {
          if (!this.send({ op: 'res', id, ok: true, r: r ?? null })) {
            this.send({ op: 'res', id, ok: false, e: INTERNAL });
            return;
          }
          if (m === 'init') this.send({ op: 'ev', e: 'ready', v: PROTOCOL_V });
        },
        (err: unknown) => {
          this.send({ op: 'res', id, ok: false, e: toWireError(err) });
        },
      )
      .finally(() => {
        this.inflight--;
      });
  }

  /** Frame and write; `false` when the message could not be framed or written. */
  private send(msg: object): boolean {
    if (this.dead) return false;
    let bytes: Uint8Array;
    try {
      bytes = encodeFrame(
        msg,
        this.o.maxFrameBytes === undefined ? undefined : { maxFrameBytes: this.o.maxFrameBytes },
      );
    } catch {
      return false;
    }
    try {
      this.o.write(bytes);
    } catch {
      return false;
    }
    return true;
  }

  private die(err: FramingError): void {
    if (this.dead) return;
    this.dead = true;
    this.o.onFatal(err);
  }
}
