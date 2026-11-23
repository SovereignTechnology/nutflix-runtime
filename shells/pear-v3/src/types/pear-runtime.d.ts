/**
 * pear-runtime 1.3.1 ships no types (its package.json lists `index.d.ts`; the tarball has none).
 * Main uses the static `run()`. The constructor and the updater are for `src/update/update-worker.ts`
 * alone, the one module that builds a `PearRuntime`.
 */
declare module 'pear-runtime' {
  /** The Bare sidecar `run()` returns: a Duplex (the worker's `Bare.IPC`) plus the child's stdio. */
  export interface SidecarLike {
    write(chunk: Uint8Array): unknown;
    on(event: 'data', cb: (chunk: Uint8Array) => void): unknown;
    on(event: 'exit', cb: (code: number | null, signal?: unknown) => void): unknown;
    on(event: 'error', cb: (err: Error) => void): unknown;
    on(event: 'close', cb: () => void): unknown;
    readonly stdout?: { on(event: 'data', cb: (chunk: Uint8Array) => void): unknown } | undefined;
    readonly stderr?: { on(event: 'data', cb: (chunk: Uint8Array) => void): unknown } | undefined;
    destroy(): unknown;
  }
  /** `pear-runtime-updater` 3.4.0, as far as the gate uses it (S2 measured each field). */
  export interface PearUpdater {
    readonly next: string | null;
    readonly nextVersion: string | null;
    readonly app?: string | undefined;
    applyUpdate(): Promise<void>;
    on(event: 'updated', cb: () => void): unknown;
    on(event: 'error', cb: (err: Error) => void): unknown;
  }
  export interface PearRuntimeOptions {
    readonly dir: string;
    readonly app: string;
    readonly updates: boolean;
    readonly version: string;
    readonly upgrade: string;
    readonly name: string;
    readonly bootstrap?: readonly string[];
    readonly delay?: number;
  }
  export default class PearRuntime {
    constructor(opts: PearRuntimeOptions);
    readonly updater: PearUpdater;
    ready(): Promise<void>;
    close(): Promise<void>;
    static run(entrypoint: string, args?: readonly string[], opts?: object): SidecarLike;
  }
}
