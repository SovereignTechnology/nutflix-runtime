/**
 * The renderer's side of the worker wire (ADR 0001 decision 3). A shell owns the worker and the
 * means of reaching it; the renderer sees only a `WorkerPipe`: a framed byte duplex, the same
 * 4-byte-length frames the worker's `WorkerClient` writes and reads (packages/worker/README.md).
 * The two shells each supply one (a preload bridge, a Bare pipe over the runtime's IPC); the tests
 * supply an in-memory one, and the end-to-end test a Playwright bridge.
 *
 * `WorkerLink` is the one consumer: the worker's `WorkerClient` over a pipe, narrowed to what
 * playing needs. The shell sends `init` (it knows the storage directory and the bootstrap) before
 * it hands the pipe over: a renderer never names a path for the worker to write.
 */
import {
  WorkerClient,
  WorkerError,
  type ArgsOf,
  type ErrorCode,
  type NfxPlayOpenArgs,
  type ResultOf,
  type WindowMethod,
  type WindowMethodTable,
  type WorkerEvent,
  type WorkerMethod,
  type WorkerMethodTable,
} from '@nutflix-runtime/worker';

/** A framed byte duplex to the worker. Bytes are whole frames or any chunking of them. */
export interface WorkerPipe {
  /** Bytes to the worker. Throws when the pipe is closed. */
  write(bytes: Uint8Array): void;
  /** Bytes from the worker. Returns the unsubscribe. */
  onData(cb: (bytes: Uint8Array) => void): () => void;
  /** The worker went away, or the shell closed the pipe. Returns the unsubscribe. */
  onClose(cb: () => void): () => void;
  /** The renderer is done with the pipe. */
  close(): void;
}

/** `x` as a `WorkerPipe`, when it has the four methods. The shell's bridge is not trusted to be typed. */
export function asWorkerPipe(x: unknown): WorkerPipe | null {
  if (typeof x !== 'object' || x === null) return null;
  const p = x as Record<string, unknown>;
  for (const k of ['write', 'onData', 'onClose', 'close']) {
    if (typeof p[k] !== 'function') return null;
  }
  return x as WorkerPipe;
}

/** What the adapter needs of the worker; `WorkerLink` is the real one, the tests fake it. */
export interface PlayWorker {
  /** Resolves once the worker has been `init`ed, rejects `worker-down` when it never is. */
  ready(): Promise<void>;
  open(args: NfxPlayOpenArgs): Promise<ResultOf<'nfx.play.open'>>;
  close(sid: string): Promise<void>;
  /** The worker's pipe ended or went corrupt. */
  onDown(cb: () => void): () => void;
}

/** What Settings' seeding, signer and Studio panel may ask for, through the shell's gate. */
export type ControlMethod =
  | Exclude<
      WorkerMethod,
      | 'init'
      | 'nfx.seed.start'
      | 'nfx.seed.stop'
      | 'nfx.seed.list'
      | 'nfx.endpoint'
      | 'seeding.set'
      | 'studio.source'
      | 'signer.check'
      | 'signer.sign'
    >
  | WindowMethod;
type ControlTable = WorkerMethodTable & WindowMethodTable;
export type ControlArgs<M extends ControlMethod> = ControlTable[M][0];
export type ControlResult<M extends ControlMethod> = ControlTable[M][1];

export interface ControlWorker {
  call<M extends ControlMethod>(
    m: M,
    a: ControlArgs<M>,
    opts?: { readonly timeoutMs?: number },
  ): Promise<ControlResult<M>>;
  /** Worker events; returns the unsubscribe. */
  onEvent(cb: (ev: WorkerEvent) => void): () => void;
}

/** How long `ready` waits for a worker that is still starting, ms. */
export const READY_WAIT_MS = 20_000;
/** How often `ready` asks `status` while it waits, ms. */
export const READY_POLL_MS = 250;
/** How long one `status` may go unanswered before `ready` asks again, ms. */
export const READY_ASK_MS = 5_000;
/** A play's open fetches the init and the first segment over HyperDHT before it answers, ms. */
export const OPEN_TIMEOUT_MS = 60_000;

export interface WorkerLinkOptions {
  readonly pipe: WorkerPipe;
  readonly readyWaitMs?: number;
  readonly readyPollMs?: number;
  readonly readyAskMs?: number;
  readonly openTimeoutMs?: number;
  /** Worker events (`status`, `nfx.seed`, `log`); none are needed to play. */
  readonly onEvent?: ((ev: WorkerEvent) => void) | undefined;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class WorkerLink implements PlayWorker, ControlWorker {
  readonly #o: WorkerLinkOptions;
  readonly #client: WorkerClient;
  readonly #down = new Set<() => void>();
  readonly #offs: (() => void)[] = [];
  readonly #eventListeners = new Set<(ev: WorkerEvent) => void>();
  #isDown = false;
  #ready: Promise<void> | null = null;

  constructor(o: WorkerLinkOptions) {
    this.#o = o;
    this.#client = new WorkerClient({
      write: (bytes) => {
        try {
          o.pipe.write(bytes);
        } catch (e) {
          // A pipe that refuses a write has ended: `ready` must not wait for it.
          this.#goDown();
          throw e;
        }
      },
      onEvent: (ev) => {
        o.onEvent?.(ev);
        for (const cb of [...this.#eventListeners]) {
          try {
            cb(ev);
          } catch {
            // A listener's failure is its own.
          }
        }
      },
      onFatal: () => {
        this.#goDown();
      },
      timeoutMs: o.openTimeoutMs ?? OPEN_TIMEOUT_MS,
    });
    this.#offs.push(
      o.pipe.onData((bytes) => {
        this.#client.push(bytes);
      }),
      o.pipe.onClose(() => {
        this.#client.end();
        this.#goDown();
      }),
    );
  }

  #goDown(): void {
    if (this.#isDown) return;
    this.#isDown = true;
    for (const cb of [...this.#down]) {
      try {
        cb();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  onDown(cb: () => void): () => void {
    if (this.#isDown) {
      cb();
      return () => undefined;
    }
    this.#down.add(cb);
    return () => {
      this.#down.delete(cb);
    };
  }

  /** The first `status` the worker answers (it answers `not-ready` until `init`). Memoised. */
  ready(): Promise<void> {
    this.#ready ??= this.#waitReady().catch((e: unknown) => {
      this.#ready = null;
      throw e;
    });
    return this.#ready;
  }

  async #waitReady(): Promise<void> {
    const end = Date.now() + (this.#o.readyWaitMs ?? READY_WAIT_MS);
    for (;;) {
      try {
        await this.#client.request('status', {}, { timeoutMs: this.#o.readyAskMs ?? READY_ASK_MS });
        return;
      } catch (e) {
        // A worker that is still starting answers `not-ready`, or does not answer yet (its Bare
        // runtime can take longer than one ask to boot). A pipe that ended will never answer.
        const starting =
          e instanceof WorkerError &&
          (e.code === 'not-ready' || (e.code === 'backend-down' && !this.#isDown));
        if (!starting || Date.now() >= end) throw e;
      }
      await sleep(this.#o.readyPollMs ?? READY_POLL_MS);
    }
  }

  open(args: ArgsOf<'nfx.play.open'>): Promise<ResultOf<'nfx.play.open'>> {
    return this.#client.request('nfx.play.open', args);
  }

  async close(sid: string): Promise<void> {
    await this.#client.request('nfx.play.close', { sid }, { timeoutMs: 10_000 });
  }

  /** A control call: the gate in the shell decides whether this window may make it. */
  call<M extends ControlMethod>(
    m: M,
    a: ControlArgs<M>,
    opts: { readonly timeoutMs?: number } = {},
  ): Promise<ControlResult<M>> {
    return this.#client.request(m as WorkerMethod, a as never, opts) as Promise<ControlResult<M>>;
  }

  onEvent(cb: (ev: WorkerEvent) => void): () => void {
    this.#eventListeners.add(cb);
    return () => {
      this.#eventListeners.delete(cb);
    };
  }

  /** Detaches from the pipe (the shell owns it and the worker; nothing here stops either). */
  dispose(): void {
    for (const off of this.#offs.splice(0)) off();
    this.#client.end();
    this.#goDown();
  }
}

/** The adapter-facing code of a worker error. */
export function codeOf(e: unknown): ErrorCode | null {
  return e instanceof WorkerError ? e.code : null;
}
