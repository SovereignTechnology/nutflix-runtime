/**
 * pear-runtime 1.3.1 ships no types (its package.json lists `index.d.ts`; the tarball has none).
 * Only the static `run()` is used here: the shell never constructs a `PearRuntime`, so no updater
 * exists (README, "Updates are off").
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
