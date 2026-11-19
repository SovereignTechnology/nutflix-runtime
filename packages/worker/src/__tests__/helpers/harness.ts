/**
 * Test support (not a suite), after nutflix-pear's `worker/__tests__/helpers/harness.ts`: a Node
 * runtime for the worker (`@sovit/seeder`'s `nodeFs`, node:http), the worker itself wired to a
 * `WorkerClient` through the real framing and guards over an in-memory pipe (chunks delivered
 * asynchronously, as a pipe does), and HTTP helpers.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nodeFs } from '@sovit/seeder';

import { WorkerClient } from '../../client.js';
import type { WorkerHostOptions } from '../../host.js';
import { WorkerHost } from '../../host.js';
import type { WorkerEvent } from '../../protocol.js';
import { WorkerRpc } from '../../rpc.js';
import type { HttpRequestHandler, HttpServerLike, WorkerRuntime } from '../../runtime.js';

/** `WorkerRuntime.createHttpServer` on node:http (tests; production is bare-http1). */
export function nodeHttpServer(onRequest: HttpRequestHandler): Promise<HttpServerLike> {
  return Promise.resolve(
    http.createServer((req, res) => {
      onRequest(req, res);
    }),
  );
}

export function nodeRuntime(): WorkerRuntime {
  return {
    fs: nodeFs,
    rmTree: (p) => rm(p, { recursive: true, force: true }),
    createHttpServer: nodeHttpServer,
  };
}

export async function tempDir(prefix: string): Promise<{ dir: string; rm: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return {
    dir,
    rm: async () => {
      for (let i = 0; ; i++) {
        try {
          await rm(dir, { recursive: true, force: true });
          return;
        } catch (err) {
          if (i >= 20) throw err;
          await new Promise((r) => setTimeout(r, 25));
        }
      }
    },
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Bounded wait for `cond`, polled. */
export async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

export interface RunningWorker {
  readonly client: WorkerClient;
  readonly host: WorkerHost;
  readonly rpc: WorkerRpc;
  readonly events: WorkerEvent[];
  /** Fatal stream errors either side saw. */
  readonly fatal: Error[];
  /** Write raw bytes to the worker, as a host would. */
  raw(bytes: Uint8Array): void;
  close(): Promise<void>;
}

/** The worker over the real wire (framing, guards, the client), in this process. */
export function startWorker(over: Partial<Omit<WorkerHostOptions, 'emit'>> = {}): RunningWorker {
  const events: WorkerEvent[] = [];
  const fatal: Error[] = [];
  const later = (f: () => void): void => {
    setImmediate(f);
  };
  // Each side's closures reach the other only once a chunk is delivered, after both exist.
  const client: WorkerClient = new WorkerClient({
    write: (b) => {
      later(() => {
        rpc.push(b);
      });
    },
    onEvent: (ev) => {
      events.push(ev);
    },
    onFatal: (err) => {
      fatal.push(err);
    },
    timeoutMs: 120_000,
  });
  const rpc: WorkerRpc = new WorkerRpc({
    write: (b) => {
      later(() => {
        client.push(b);
      });
    },
    handler: { handle: (m, a) => host.handle(m, a) },
    onFatal: (err) => {
      fatal.push(err);
    },
  });
  const host = new WorkerHost({
    runtime: nodeRuntime(),
    emit: (ev) => {
      rpc.emit(ev);
    },
    bootstrapWaitMs: 5000,
    dialTimeoutMs: 10_000,
    ...over,
  });
  return {
    client,
    host,
    rpc,
    events,
    fatal,
    raw: (bytes) => {
      later(() => {
        rpc.push(bytes);
      });
    },
    close: () => host.close(),
  };
}

export interface HttpResult {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

/** GET with a fresh connection; the whole body. */
export function httpGet(url: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/**
 * One request of any method, sent as written (`path` is not normalised, so a test can send
 * `..` or `%2e`); how it ended — `complete` false when the connection was cut mid-body, status 0
 * when it was cut before any header arrived.
 */
export function request(
  url: string,
  o: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly path?: string;
  } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; complete: boolean }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: o.path ?? `${u.pathname}${u.search}`,
        method: o.method ?? 'GET',
        headers: o.headers ?? {},
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', () => undefined);
        res.on('close', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            complete: res.complete,
          });
        });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNRESET')
        resolve({ status: 0, headers: {}, body: Buffer.alloc(0), complete: false });
      else reject(err);
    });
    req.end();
  });
}
