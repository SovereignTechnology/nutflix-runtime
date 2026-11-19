/**
 * The ambient `Bare` global, as far as `../main.ts` uses it: nutflix-pear's
 * `app-desktop/src/types/bare.d.ts` (the submodule's pinned commit), read there from the Bare
 * runtime itself (`bare-sidecar`'s prebuilt, Bare 1.31).
 *
 * Both launchers this worker has give it the same pipe: `bare-sidecar` (nutflix-pear) and
 * `pear-runtime`'s `run()` (Pear v3: "In the worker, `Bare.IPC` is the other end of the pipe")
 * set `Bare.IPC`, a bare-pipe Duplex. Bare has no `TextEncoder`/`TextDecoder` global
 * (`../bare-globals.ts` installs them), no `process`, no `fetch`.
 */

/** `Bare.IPC`: the worker's end of the host duplex, unframed chunks. */
interface BareIPC {
  /** Chunks arrive as bare-buffer `Buffer`s (a `Uint8Array` subclass), unframed. */
  write(chunk: Uint8Array, cb?: (err: Error | null) => void): boolean;
  end(): this;
  destroy(err?: Error): this;
  /** Unref so an idle pipe does not keep the worker alive (bare-pipe `unref`). */
  unref(): this;
  ref(): this;
  on(event: 'data', listener: (chunk: Uint8Array) => void): this;
  on(event: 'end' | 'close' | 'drain' | 'finish', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  once(event: 'data', listener: (chunk: Uint8Array) => void): this;
  once(event: 'end' | 'close' | 'drain' | 'finish', listener: () => void): this;
  once(event: 'error', listener: (err: Error) => void): this;
  off(event: string, listener: (...args: never[]) => void): this;
}

interface BareEventMap {
  exit: [code: number];
  beforeExit: [code: number];
  uncaughtException: [err: unknown];
  unhandledRejection: [reason: unknown, promise: Promise<unknown>];
  suspend: [linger: number];
  wakeup: [deadline: number];
  idle: [];
  resume: [];
}

interface BareRuntime {
  readonly platform: string;
  readonly arch: string;
  /** [bare binary, entry script, ...the args the launcher passed]. */
  readonly argv: readonly string[];
  readonly pid: number;
  /** Masked to 0..255 on assignment. */
  exitCode: number;
  readonly version: string;
  readonly versions: Readonly<Record<string, string>>;
  /** Set by the launcher (bare-sidecar, pear-runtime); `null` when started some other way. */
  readonly IPC: BareIPC | null;
  exit(code?: number): never;
  on<E extends keyof BareEventMap>(event: E, listener: (...args: BareEventMap[E]) => void): this;
  once<E extends keyof BareEventMap>(event: E, listener: (...args: BareEventMap[E]) => void): this;
  off<E extends keyof BareEventMap>(event: E, listener: (...args: BareEventMap[E]) => void): this;
}

declare const Bare: BareRuntime;
