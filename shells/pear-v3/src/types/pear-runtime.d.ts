/**
 * pear-runtime 1.3.1 ships no types (its package.json lists `index.d.ts`; the tarball has none).
 * Main uses only the static `run()`.
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
  const PearRuntime: {
    run(entrypoint: string, args?: readonly string[], opts?: object): SidecarLike;
  };
  export default PearRuntime;
}

/**
 * `pear-runtime-updater` 3.4.0 (its own `index.d.ts` declares nothing), as far as the updater
 * process uses it (`src/update/update-worker.ts`, the one module that builds one). S2 measured each
 * field.
 */
declare module 'pear-runtime-updater' {
  import type Corestore from 'corestore';

  export interface PearRuntimeUpdaterOptions {
    readonly dir: string;
    readonly app: string;
    readonly updates: boolean;
    readonly version: string;
    readonly upgrade: string;
    readonly name: string;
    readonly store: Corestore;
    readonly delay?: number;
  }

  export default class PearRuntimeUpdater {
    constructor(opts: PearRuntimeUpdaterOptions);
    readonly next: string | null;
    readonly nextVersion: string | null;
    readonly app?: string | undefined;
    readonly drive: { readonly core: { readonly discoveryKey: Uint8Array } };
    applyUpdate(): Promise<void>;
    ready(): Promise<void>;
    close(): Promise<void>;
    on(event: 'updated', cb: () => void): unknown;
    on(event: 'error', cb: (err: Error) => void): unknown;
  }
}
