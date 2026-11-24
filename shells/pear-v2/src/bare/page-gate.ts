/**
 * The gate between the page's pipe and the worker, in the Bare main process. In this runtime the
 * page has Node integration and no sandbox (ADR 0001 amendment, item 1), so this gate is not a
 * security boundary against a page that has already been compromised: such a page can do anything
 * the user can. What it does is keep the page's ordinary path narrow, so that no bug in the page
 * can name a method it has no use for:
 *
 *   1. a fixed allow-list of methods: `status`, `nfx.play.open`, `nfx.play.close`, written out
 *      here and derived from no other shell's list. `init` is the shell's, and every seed,
 *      endpoint, signer (`signer.local.*` above all: no signing key on disk in this shape), Studio
 *      or wallet method is refused, including any a later worker adds;
 *   2. every byte is decoded (`FrameDecoder`: 1 MiB cap, strict UTF-8 JSON), and what reaches the
 *      worker is this gate's own encoding of a checked request. A corrupt stream ends the pipe;
 *   3. ids are remapped, so the page cannot answer for, or collide with, the shell's requests;
 *   4. at most `MAX_INFLIGHT` requests at once, and a repeated id in flight is refused;
 *   5. only sessions this page opened can be closed through it, and they close when it goes away;
 *   6. of the worker's events, only `status` reaches the page;
 *   7. a `reset` frame (a new page after a reload) closes the old page's sessions and forgets its
 *      ids, as if that page had gone.
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

/** Everything the page may ask the worker. */
export const PAGE_METHODS: ReadonlySet<string> = new Set([
  'status',
  'nfx.play.open',
  'nfx.play.close',
]);

/** Everything the page may hear from the worker. */
export const PAGE_EVENTS: ReadonlySet<string> = new Set(['status']);

export const MAX_INFLIGHT = 32;

/** A whole frame: the worker protocol's 1 MiB payload and its 4-byte header. */
export const MAX_PIPE_CHUNK = 1024 * 1024 + 4;

/** How long the shell waits for an answer to its own request. */
export const INTERNAL_TIMEOUT_MS = 60_000;

const SID = /^[0-9a-f]{32}$/;

export interface PageGateDeps {
  /** One whole frame to the worker. */
  toWorker(frame: Uint8Array): void;
  /** One whole frame to the page. */
  toPage(frame: Uint8Array): void;
  /** End the page's pipe. */
  closePage(): void;
}

type Pending =
  | {
      readonly kind: 'page';
      readonly id: number;
      readonly addedSid: string | undefined;
      readonly closesSid: string | undefined;
    }
  | {
      readonly kind: 'shell';
      readonly resolve: (r: unknown) => void;
      readonly reject: (e: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  | { readonly kind: 'drop' };

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

export class PageGate {
  readonly #d: PageGateDeps;
  readonly #pending = new Map<number, Pending>();
  readonly #inflight = new Map<number, number>();
  readonly #sids = new Set<string>();
  readonly #fromPage: FrameDecoder;
  readonly #fromWorker: FrameDecoder;
  #next = 1;
  #pageOpen = true;
  #workerUp = true;

  constructor(d: PageGateDeps) {
    this.#d = d;
    this.#fromPage = new FrameDecoder((msg) => {
      this.#onPageMessage(msg);
    });
    this.#fromWorker = new FrameDecoder((msg) => {
      this.#onWorkerMessage(msg);
    });
  }

  /** Requests in flight to the worker, the shell's included. */
  get inflight(): number {
    return this.#pending.size;
  }

  /** Bytes the page wrote to its pipe. */
  fromPage(bytes: unknown): void {
    if (!this.#pageOpen) return;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_PIPE_CHUNK) {
      this.#endPage();
      return;
    }
    try {
      this.#fromPage.push(bytes);
    } catch (e) {
      if (e instanceof FramingError) this.#endPage();
      else throw e;
    }
  }

  /** The page's pipe ended: its answers are dropped and the sessions it opened are closed. */
  pageGone(): void {
    if (!this.#pageOpen) return;
    this.#pageOpen = false;
    this.#forgetPage();
  }

  /** A new page on the same pipe: the old one's sessions close and its ids are forgotten. */
  #resetPage(): void {
    this.#forgetPage();
  }

  #forgetPage(): void {
    for (const [wid, p] of this.#pending)
      if (p.kind === 'page') this.#pending.set(wid, { kind: 'drop' });
    this.#inflight.clear();
    for (const sid of this.#sids) this.#sendDropped('nfx.play.close', { sid });
    this.#sids.clear();
  }

  #endPage(): void {
    this.pageGone();
    this.#d.closePage();
  }

  #send(msg: object): void {
    if (!this.#pageOpen) return;
    try {
      this.#d.toPage(encodeFrame(msg));
    } catch {
      // A message that cannot be framed is not sent; the page's own request times out.
    }
  }

  #onPageMessage(msg: unknown): void {
    if (!this.#pageOpen || !isRecord(msg)) return;
    if (msg['op'] === 'reset') {
      this.#resetPage();
      return;
    }
    const id = msg['id'];
    // Only requests go this way. A response or an event from the page is nonsense: dropped.
    if (msg['op'] !== 'req' || !isMsgId(id)) return;
    const refuse = (code: ErrorCode, detail: string): void => {
      this.#send({ op: 'res', id, ok: false, e: wire(code, detail) });
    };
    const m = msg['m'];
    const a = msg['a'];
    if (typeof m !== 'string' || !PAGE_METHODS.has(m)) {
      refuse('invalid-argument', 'method not allowed');
      return;
    }
    if (!isRecord(a)) {
      refuse('invalid-argument', 'arguments must be an object');
      return;
    }
    if (this.#inflight.has(id)) {
      refuse('invalid-argument', 'request id already in flight');
      return;
    }
    if (this.#inflight.size >= MAX_INFLIGHT) {
      refuse('rate-limited', 'too many requests in flight');
      return;
    }
    if (!this.#workerUp) {
      refuse('backend-down', 'the worker is not running');
      return;
    }
    const sidArg = a['sid'];
    const sid = typeof sidArg === 'string' && SID.test(sidArg) ? sidArg : undefined;
    let addedSid: string | undefined;
    let closesSid: string | undefined;
    if (m === 'nfx.play.open' && sid !== undefined && !this.#sids.has(sid)) {
      addedSid = sid;
      this.#sids.add(sid);
    } else if (m === 'nfx.play.close' && sid !== undefined) {
      // A session this page did not open is not its to close; `close` is idempotent.
      if (!this.#sids.has(sid)) {
        this.#send({ op: 'res', id, ok: true, r: null });
        return;
      }
      closesSid = sid;
    }
    const wid = this.#allocate();
    let frame: Uint8Array;
    try {
      frame = encodeFrame({ op: 'req', id: wid, m, a });
    } catch {
      if (addedSid !== undefined) this.#sids.delete(addedSid);
      refuse('invalid-argument', 'request cannot be framed');
      return;
    }
    this.#pending.set(wid, { kind: 'page', id, addedSid, closesSid });
    this.#inflight.set(id, wid);
    this.#write(frame);
  }

  /** Bytes from the worker. */
  fromWorker(bytes: Uint8Array): void {
    if (!this.#workerUp) return;
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
      if (p.kind === 'shell') {
        clearTimeout(p.timer);
        if (ok) p.resolve(msg['r']);
        else p.reject(fromWireError(failure));
        return;
      }
      if (p.kind === 'drop') return;
      this.#inflight.delete(p.id);
      if (ok) {
        if (p.closesSid !== undefined) this.#sids.delete(p.closesSid);
        this.#send({ op: 'res', id: p.id, ok: true, r: msg['r'] });
      } else {
        if (p.addedSid !== undefined) this.#sids.delete(p.addedSid);
        this.#send({ op: 'res', id: p.id, ok: false, e: failure });
      }
      return;
    }
    if (msg['op'] === 'ev') {
      const name = msg['e'];
      if (typeof name === 'string' && PAGE_EVENTS.has(name)) this.#send(msg);
    }
  }

  /** The worker stopped, or its stream broke: every request fails and the page's pipe ends. */
  workerGone(): void {
    if (!this.#workerUp) return;
    this.#workerUp = false;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#inflight.clear();
    const down = wire('backend-down', 'the worker is not running');
    for (const p of pending) {
      if (p.kind === 'shell') {
        clearTimeout(p.timer);
        p.reject(fromWireError(down));
      } else if (p.kind === 'page') {
        this.#send({ op: 'res', id: p.id, ok: false, e: down });
      }
    }
    if (this.#pageOpen) this.#endPage();
  }

  /** The shell's own request (`init`, `status`), in the same id space as the page's. */
  request(
    m: string,
    a: Record<string, unknown>,
    timeoutMs = INTERNAL_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.#workerUp)
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
      this.#pending.set(wid, { kind: 'shell', resolve, reject, timer });
      this.#write(frame);
    });
  }

  #sendDropped(m: string, a: Record<string, unknown>): void {
    if (!this.#workerUp) return;
    const wid = this.#allocate();
    try {
      const frame = encodeFrame({ op: 'req', id: wid, m, a });
      this.#pending.set(wid, { kind: 'drop' });
      this.#write(frame);
    } catch {
      // Nothing to close with.
    }
  }

  /** One frame to the worker; a pipe that cannot be written means the worker is gone. */
  #write(frame: Uint8Array): void {
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
