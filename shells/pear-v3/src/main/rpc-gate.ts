/**
 * The gate between each window's pipe and the one Bare worker. The renderer holds a `WorkerPipe`
 * (framed bytes); this is the only thing at the other end of it. The worker trusts its host, so
 * everything a window may reach is decided here, in main:
 *
 *   1. every window has a POLICY: the methods it may call and the events it may hear. A request
 *      for any other method is answered `invalid-argument` here and never reaches the worker;
 *   2. every byte from a window is decoded (`FrameDecoder`: 1 MiB cap, strict UTF-8 JSON) and what
 *      reaches the worker is main's own re-encoding of a checked request, never the window's
 *      bytes. A corrupt stream ends that window's pipe;
 *   3. ids are remapped: the worker sees one id space (main's), so two windows cannot collide, a
 *      window cannot answer for another, and the worker's answers return to the window that asked,
 *      with the id it used;
 *   4. at most `maxInflight` requests per window; a repeated id in flight is refused;
 *   5. a play session belongs to the window that opened it: another window's `nfx.play.close`
 *      is a no-op, and a window that goes away closes its sessions;
 *   6. events reach only the windows whose policy lists them, as main re-encoded them.
 *
 * Main itself uses the same id space through `request()` (`init`, `status`). Runtime-neutral and
 * Electron-free: bytes in, bytes out, so the tests drive it with fakes.
 */
import {
  ERROR_CODES,
  FrameDecoder,
  FramingError,
  MAX_MSG_ID,
  WorkerError,
  encodeFrame,
  fromWireError,
  type ErrorCode,
  type WireError,
} from '@nutflix-runtime/worker';

import { MAX_PIPE_CHUNK } from '../shared/ids.ts';

export interface WindowPolicy {
  /** The worker methods this window may call. */
  readonly methods: ReadonlySet<string>;
  /** The worker events this window may hear. */
  readonly events: ReadonlySet<string>;
  readonly maxInflight: number;
}

/**
 * The renderer's window: what `packages/renderer` uses (`status` to wait for the worker,
 * `nfx.play.open` and `nfx.play.close`), and the one event that follows `status`. No `init`
 * (main sends it, with the storage directory), no `nfx.seed.*`, no `nfx.endpoint`, no logs.
 */
export const MAIN_WINDOW_POLICY: WindowPolicy = {
  methods: new Set(['status', 'nfx.play.open', 'nfx.play.close']),
  events: new Set(['status']),
  maxInflight: 32,
};

const SID = /^[0-9a-f]{32}$/;
/** How long main waits for an answer to its own request. */
export const INTERNAL_TIMEOUT_MS = 60_000;

export interface RpcGateDeps {
  /** One whole frame to the worker. */
  toWorker(frame: Uint8Array): void;
  /** One whole frame to window `windowId`'s pipe. */
  toWindow(windowId: number, frame: Uint8Array): void;
  /** End window `windowId`'s pipe (its renderer sees `close`). */
  closeWindow(windowId: number): void;
  now?(): number;
}

type Pending =
  | {
      readonly kind: 'window';
      readonly windowId: number;
      readonly id: number;
      readonly method: string;
      /** A `nfx.play.open` that added this sid to the window's set. */
      readonly addedSid: string | undefined;
      readonly closesSid: string | undefined;
    }
  | {
      readonly kind: 'internal';
      readonly resolve: (r: unknown) => void;
      readonly reject: (e: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  | { readonly kind: 'drop' };

interface WindowState {
  readonly policy: WindowPolicy;
  readonly decoder: FrameDecoder;
  readonly inflight: Map<number, number>;
  readonly sids: Set<string>;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isMsgId(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= MAX_MSG_ID;
}

const CODES = new Set<string>(ERROR_CODES);

function isWireError(x: unknown): x is WireError {
  if (!isRecord(x)) return false;
  const m = x['message'];
  const c = x['code'];
  return typeof c === 'string' && CODES.has(c) && typeof m === 'string' && m.length <= 512;
}

const wire = (code: ErrorCode, detail: string): WireError => ({
  code,
  message: `${code}: ${detail}`,
});

export class RpcGate {
  readonly #d: RpcGateDeps;
  readonly #windows = new Map<number, WindowState>();
  readonly #pending = new Map<number, Pending>();
  readonly #fromWorker: FrameDecoder;
  #next = 1;
  #dead = false;

  constructor(d: RpcGateDeps) {
    this.#d = d;
    this.#fromWorker = new FrameDecoder((msg) => {
      this.#onWorkerMessage(msg);
    });
  }

  get windows(): number {
    return this.#windows.size;
  }

  get inflight(): number {
    return this.#pending.size;
  }

  // ---- windows ---------------------------------------------------------------------------

  attach(windowId: number, policy: WindowPolicy): void {
    if (this.#windows.has(windowId)) throw new Error('window already attached');
    this.#windows.set(windowId, {
      policy,
      decoder: new FrameDecoder((msg) => {
        this.#onWindowMessage(windowId, msg);
      }),
      inflight: new Map(),
      sids: new Set(),
    });
  }

  /** The window is gone: its answers are dropped and the sessions it opened are closed. */
  detach(windowId: number): void {
    const w = this.#windows.get(windowId);
    if (w === undefined) return;
    this.#windows.delete(windowId);
    for (const [wid, p] of this.#pending)
      if (p.kind === 'window' && p.windowId === windowId) this.#pending.set(wid, { kind: 'drop' });
    for (const sid of w.sids) this.#sendDropped('nfx.play.close', { sid });
  }

  /** Bytes a window wrote to its pipe. */
  fromWindow(windowId: number, bytes: unknown): void {
    const w = this.#windows.get(windowId);
    if (w === undefined) return;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_PIPE_CHUNK) {
      this.#endWindow(windowId);
      return;
    }
    try {
      w.decoder.push(bytes);
    } catch (e) {
      if (e instanceof FramingError) this.#endWindow(windowId);
      else throw e;
    }
  }

  #endWindow(windowId: number): void {
    this.detach(windowId);
    this.#d.closeWindow(windowId);
  }

  #toWindow(windowId: number, msg: object): void {
    try {
      this.#d.toWindow(windowId, encodeFrame(msg));
    } catch {
      // A message that cannot be framed is not sent; the window's own request times out.
    }
  }

  #onWindowMessage(windowId: number, msg: unknown): void {
    const w = this.#windows.get(windowId);
    if (w === undefined || !isRecord(msg)) return;
    const id = msg['id'];
    // Only requests go this way. A response or an event from a renderer is nonsense: dropped.
    if (msg['op'] !== 'req' || !isMsgId(id)) return;
    const refuse = (code: ErrorCode, detail: string): void => {
      this.#toWindow(windowId, { op: 'res', id, ok: false, e: wire(code, detail) });
    };
    const m = msg['m'];
    const a = msg['a'];
    if (typeof m !== 'string' || !w.policy.methods.has(m)) {
      refuse('invalid-argument', 'method not allowed');
      return;
    }
    if (!isRecord(a)) {
      refuse('invalid-argument', 'arguments must be an object');
      return;
    }
    if (w.inflight.has(id)) {
      refuse('invalid-argument', 'request id already in flight');
      return;
    }
    if (w.inflight.size >= w.policy.maxInflight) {
      refuse('rate-limited', 'too many requests in flight');
      return;
    }
    if (this.#dead) {
      refuse('backend-down', 'the worker is not running');
      return;
    }

    const sidArg = a['sid'];
    const sid = typeof sidArg === 'string' && SID.test(sidArg) ? sidArg : undefined;
    let addedSid: string | undefined;
    let closesSid: string | undefined;
    if (m === 'nfx.play.open' && sid !== undefined && !w.sids.has(sid)) {
      addedSid = sid;
      w.sids.add(sid);
    } else if (m === 'nfx.play.close' && sid !== undefined) {
      // Another window's session (or none) is not this window's to close; `close` is idempotent.
      if (!w.sids.has(sid)) {
        this.#toWindow(windowId, { op: 'res', id, ok: true, r: null });
        return;
      }
      closesSid = sid;
    }
    const wid = this.#allocate();
    let frame: Uint8Array;
    try {
      frame = encodeFrame({ op: 'req', id: wid, m, a });
    } catch {
      if (addedSid !== undefined) w.sids.delete(addedSid);
      {
        refuse('invalid-argument', 'request cannot be framed');
        return;
      }
    }
    this.#pending.set(wid, { kind: 'window', windowId, id, method: m, addedSid, closesSid });
    w.inflight.set(id, wid);
    this.#send(frame);
  }

  // ---- the worker --------------------------------------------------------------------------

  /** Bytes from the worker. */
  fromWorker(bytes: Uint8Array): void {
    if (this.#dead) return;
    try {
      this.#fromWorker.push(bytes);
    } catch (e) {
      if (!(e instanceof FramingError)) throw e;
      // The worker's stream cannot be trusted any more: as if it had gone.
      this.workerGone();
    }
  }

  #onWorkerMessage(msg: unknown): void {
    if (!isRecord(msg)) return;
    if (msg['op'] === 'res') {
      const wid = msg['id'];
      if (!isMsgId(wid)) return;
      const p = this.#pending.get(wid);
      if (p === undefined) return;
      this.#pending.delete(wid);
      const ok = msg['ok'] === true;
      const failure = isWireError(msg['e']) ? msg['e'] : wire('internal', 'internal error');
      if (p.kind === 'internal') {
        clearTimeout(p.timer);
        if (ok) p.resolve(msg['r']);
        else p.reject(fromWireError(failure));
        return;
      }
      if (p.kind === 'drop') return;
      const w = this.#windows.get(p.windowId);
      if (w === undefined) return;
      w.inflight.delete(p.id);
      if (ok) {
        if (p.closesSid !== undefined) w.sids.delete(p.closesSid);
        this.#toWindow(p.windowId, { op: 'res', id: p.id, ok: true, r: msg['r'] });
      } else {
        if (p.addedSid !== undefined) w.sids.delete(p.addedSid);
        this.#toWindow(p.windowId, { op: 'res', id: p.id, ok: false, e: failure });
      }
      return;
    }
    if (msg['op'] === 'ev') {
      const name = msg['e'];
      if (typeof name !== 'string') return;
      for (const [windowId, w] of this.#windows)
        if (w.policy.events.has(name)) this.#toWindow(windowId, msg);
    }
  }

  /** The worker exited, or its pipe broke: every request fails, every window's pipe ends. */
  workerGone(): void {
    if (this.#dead) return;
    this.#dead = true;
    const pending = [...this.#pending];
    this.#pending.clear();
    const down = wire('backend-down', 'the worker is not running');
    for (const [, p] of pending) {
      if (p.kind === 'internal') {
        clearTimeout(p.timer);
        p.reject(fromWireError(down));
      } else if (p.kind === 'window') {
        this.#toWindow(p.windowId, { op: 'res', id: p.id, ok: false, e: down });
      }
    }
    for (const windowId of [...this.#windows.keys()]) {
      this.#windows.delete(windowId);
      this.#d.closeWindow(windowId);
    }
  }

  // ---- main's own requests -------------------------------------------------------------------

  /** Main's request to the worker (`init`, `status`): the same id space as every window's. */
  request(
    m: string,
    a: Record<string, unknown>,
    timeoutMs = INTERNAL_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.#dead)
      return Promise.reject(new WorkerError('backend-down', 'the worker is not running'));
    return new Promise<unknown>((resolve, reject) => {
      const wid = this.#allocate();
      let frame: Uint8Array;
      try {
        frame = encodeFrame({ op: 'req', id: wid, m, a });
      } catch {
        reject(new WorkerError('invalid-argument', `${m}: not serialisable`));
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(wid);
        reject(new WorkerError('backend-down', `${m}: no answer in ${String(timeoutMs)} ms`));
      }, timeoutMs);
      this.#pending.set(wid, { kind: 'internal', resolve, reject, timer });
      this.#send(frame);
    });
  }

  #sendDropped(m: string, a: Record<string, unknown>): void {
    if (this.#dead) return;
    const wid = this.#allocate();
    try {
      const frame = encodeFrame({ op: 'req', id: wid, m, a });
      this.#pending.set(wid, { kind: 'drop' });
      this.#send(frame);
    } catch {
      // Nothing to close with.
    }
  }

  /** One frame to the worker; a pipe that cannot be written means the worker is gone. */
  #send(frame: Uint8Array): void {
    try {
      this.#d.toWorker(frame);
    } catch {
      this.workerGone();
    }
  }

  #allocate(): number {
    for (let i = 0; i <= MAX_MSG_ID; i++) {
      const id = this.#next;
      this.#next = id >= MAX_MSG_ID ? 1 : id + 1;
      if (!this.#pending.has(id)) return id;
    }
    throw new Error('no free request id');
  }
}
