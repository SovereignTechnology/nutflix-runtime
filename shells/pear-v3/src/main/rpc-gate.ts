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
 *   6. events reach only the windows whose policy lists them, as main re-encoded them;
 *   7. a `seeding.segment` must name a play session this window holds: a file handed over from
 *      WebRTC is checked against THAT session's hash list, so it cannot borrow another's;
 *   8. `mainMethods` are answered here and never reach the worker: `app.pickVideo` (main's native
 *      file dialog, so a page never names a path) and `app.seeding.set` (turning seeding on takes
 *      a native confirmation, so a page cannot start sharing the user's IP address).
 *
 * What the worker checks is the arguments, strictly, for every method (`guards.ts`): the methods
 * that take a path or turn the switch directly (`studio.source`, `seeding.set`) are in no window's
 * list, and only main's own `request()` reaches them.
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
  /**
   * The events only MAIN may send this window (`fromMain`). The same name from the worker is
   * dropped, so a compromised data worker cannot tell the page an update was verified.
   */
  readonly mainEvents?: ReadonlySet<string>;
  /**
   * The methods main answers itself (`RpcGateDeps.mainCall`); the worker never sees them. A
   * window that may call one has it here and NOT in `methods`.
   */
  readonly mainMethods?: ReadonlySet<string>;
  readonly maxInflight: number;
}

/**
 * The renderer's window: what `packages/renderer` uses, each with its own guard in the worker.
 *
 *   play      `status`, `nfx.play.open`, `nfx.play.close`
 *   signer    `signer.*`: a key sealed in the worker or a bunker session held there. `signer.sign`
 *             takes only the kinds in `SIGNABLE_KINDS`, and only a manifest of a video this node
 *             packaged. No key, passphrase-derived key or bunker secret ever comes back.
 *   seeding   `seeding.status`, `.watch` (refused while the switch is off), `.stop`, `.beacons`
 *             (the worker signs, the renderer publishes), `.segment` (a file its own play verified)
 *   Studio    `studio.ffmpeg`, `.probe`, `.publish`, `.cancel`, on a token from `app.pickVideo`
 *
 * Not here, ever: `init` (main sends it, with the storage directory), `nfx.seed.*` and
 * `nfx.endpoint` (the page would pick what this machine serves), `seeding.set` and `studio.source`
 * (main's alone, below), logs, and any method that touches the updater.
 */
export const MAIN_WINDOW_POLICY: WindowPolicy = {
  methods: new Set([
    'status',
    'nfx.play.open',
    'nfx.play.close',
    'signer.status',
    'signer.local.create',
    'signer.local.unlock',
    'signer.nip46.connect',
    'signer.lock',
    'signer.sign',
    'seeding.status',
    'seeding.watch',
    'seeding.stop',
    'seeding.beacons',
    'seeding.segment',
    'studio.ffmpeg',
    'studio.probe',
    'studio.publish',
    'studio.cancel',
  ]),
  events: new Set(['status', 'studio.progress']),
  mainEvents: new Set(['update', 'serving']),
  mainMethods: new Set(['app.pickVideo', 'app.seeding.set']),
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
  /**
   * Answers a `mainMethods` call (a native dialog, usually). Rejects with a `WorkerError`, whose
   * code and message cross; anything else crosses as `internal`. Absent: such a call is refused.
   */
  mainCall?(windowId: number, method: string, args: Record<string, unknown>): Promise<unknown>;
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

  /** Resolves once nothing is in flight to the worker, or after `ms`, whichever is first. */
  async drained(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (this.#pending.size > 0 && !this.#dead && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 10));
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
    const isMain = typeof m === 'string' && w.policy.mainMethods?.has(m) === true;
    if (typeof m !== 'string' || (!isMain && !w.policy.methods.has(m))) {
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
    if (isMain) {
      this.#runMainCall(windowId, w, id, m, a);
      return;
    }

    const sidArg = a['sid'];
    const sid = typeof sidArg === 'string' && SID.test(sidArg) ? sidArg : undefined;
    let addedSid: string | undefined;
    let closesSid: string | undefined;
    if (m === 'seeding.segment' && (sid === undefined || !w.sids.has(sid))) {
      refuse('invalid-argument', 'not a play session of this window');
      return;
    }
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

  /** A method main answers itself; it counts against the window's in-flight limit. */
  #runMainCall(
    windowId: number,
    w: WindowState,
    id: number,
    m: string,
    a: Record<string, unknown>,
  ): void {
    const answer = (r: { ok: true; r: unknown } | { ok: false; e: WireError }): void => {
      if (this.#windows.get(windowId) !== w) return;
      w.inflight.delete(id);
      this.#toWindow(windowId, { op: 'res', id, ...r });
    };
    if (this.#d.mainCall === undefined) {
      this.#toWindow(windowId, {
        op: 'res',
        id,
        ok: false,
        e: wire('invalid-argument', 'method not allowed'),
      });
      return;
    }
    // Not a worker id: only this entry's presence counts.
    w.inflight.set(id, -1);
    let running: Promise<unknown>;
    try {
      running = this.#d.mainCall(windowId, m, a);
    } catch (e) {
      running = Promise.reject(e instanceof Error ? e : new Error('main call failed'));
    }
    running.then(
      (r) => {
        answer({ ok: true, r: r ?? null });
      },
      (e: unknown) => {
        answer({
          ok: false,
          e:
            e instanceof WorkerError
              ? { code: e.code, message: e.message.slice(0, 512) }
              : wire('internal', 'internal error'),
        });
      },
    );
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

  // ---- main's own events ---------------------------------------------------------------------

  /** An event of main's own, to the windows whose policy lists it in `mainEvents`. */
  fromMain(name: string, fields: Readonly<Record<string, string | number | boolean>>): void {
    for (const [windowId, w] of this.#windows)
      if (w.policy.mainEvents?.has(name) === true)
        this.#toWindow(windowId, { ...fields, op: 'ev', e: name });
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
