/**
 * What the runtime-neutral worker (`./host.ts`) needs from its runtime: the subset of
 * nutflix-pear's `worker/runtime.ts` (the submodule's pinned commit) this data plane uses. Bare's
 * implementation is `./adapters/bare.ts` (bare-fs, bare-path, bare-http1); tests build a Node one
 * from `@sovit/seeder`'s `nodeFs` and node:http. Hashing and randomness are not here:
 * `./crypto.ts` (libsodium) loads under both runtimes.
 */
import type { SeederFs } from '@sovit/seeder';

/**
 * One request to a loopback HTTP server the worker owns: the part of node:http's and
 * bare-http1's `IncomingMessage` that the range server and the origin read (bare-http1 mirrors
 * node:http).
 */
export interface HttpRequestLike {
  readonly method?: string | undefined;
  /** The request target as sent: the path (and query). */
  readonly url?: string | undefined;
  /** By lowercase name. */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/** Its response: the part of `ServerResponse` (a writable stream in both) used here. */
export interface HttpResponseLike {
  /** The response was destroyed or the client went away. */
  readonly destroyed: boolean;
  writeHead(status: number, headers: Readonly<Record<string, string>>): unknown;
  /** `false`: buffered past the high-water mark; wait for `drain`. */
  write(chunk: Uint8Array): boolean;
  end(): unknown;
  destroy(): unknown;
  on(event: 'drain' | 'close', listener: () => void): unknown;
  off(event: 'drain' | 'close', listener: () => void): unknown;
}

/** The server, created but not listening. */
export interface HttpServerLike {
  listen(port: number, host: string, onListening: () => void): unknown;
  /** `{ port, … }` once listening, else `null`. */
  address(): unknown;
  /** Stop accepting; `onClose` runs once every connection is gone. */
  close(onClose: () => void): unknown;
  /** Destroy every connection, in flight or not (both runtimes have it). */
  closeAllConnections?(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type HttpRequestHandler = (req: HttpRequestLike, res: HttpResponseLike) => void;

export interface WorkerRuntime {
  /** `@sovit/seeder`'s filesystem: the NFX store and the play spools. */
  readonly fs: SeederFs;
  /** Remove a directory and everything in it; a missing one is fine. */
  readonly rmTree: (path: string) => Promise<void>;
  /**
   * An HTTP/1 server for the worker's own loopback endpoints: bare-http1 under Bare (loaded on
   * the first call: its native addons cannot load under Node, where tests import that module),
   * node:http in tests.
   */
  readonly createHttpServer: (onRequest: HttpRequestHandler) => Promise<HttpServerLike>;
}
