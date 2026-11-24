/**
 * Test support (not a suite), after nutflix-pear's `worker/__tests__/helpers/harness.ts`: a Node
 * runtime for the worker (`@sovit/seeder`'s `nodeFs`, node:http), the worker itself wired to a
 * `WorkerClient` through the real framing and guards over an in-memory pipe (chunks delivered
 * asynchronously, as a pipe does), and HTTP helpers.
 */
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ProcessRunner } from '@sovit/core';
import { nodeFs } from '@sovit/seeder';
import { onTestFailed } from 'vitest';
import WebSocket from 'ws';

import { WorkerClient } from '../../client.js';
import type { WorkerHostOptions } from '../../host.js';
import { WorkerHost } from '../../host.js';
import { createWorkerLogger } from '../../log.js';
import type { WorkerEvent } from '../../protocol.js';
import { WorkerRpc } from '../../rpc.js';
import type {
  HttpRequestHandler,
  HttpServerLike,
  RelayConnect,
  WorkerRuntime,
  WorkerSystem,
} from '../../runtime.js';

/** `WorkerRuntime.createHttpServer` on node:http (tests; production is bare-http1). */
export function nodeHttpServer(onRequest: HttpRequestHandler): Promise<HttpServerLike> {
  return Promise.resolve(
    http.createServer((req, res) => {
      onRequest(req, res);
    }),
  );
}

/** `ProcessRunner` on node:child_process: argv only, no shell. */
export const nodeRunner: ProcessRunner = {
  run: (file, args, opts) =>
    new Promise((resolve, reject) => {
      const child = spawn(file, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }),
      });
      const out: Buffer[] = [];
      let err = '';
      child.stdout.on('data', (c: Buffer) => out.push(c));
      child.stderr.on('data', (c: Buffer) => {
        const t = c.toString('utf8');
        err = (err + t).slice(-64 * 1024);
        for (const l of t.split(/\r\n|\r|\n/)) if (l !== '') opts?.onStderrLine?.(l);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ exitCode: code ?? -1, stdout: Buffer.concat(out), stderr: err });
      });
      opts?.signal?.addEventListener('abort', () => {
        child.kill('SIGKILL');
      });
    }),
};

/** A relay socket on `ws`, as the worker's Bare adapter has on `bare-ws`. */
export const nodeConnectRelay: RelayConnect = (url) => {
  const ws = new WebSocket(url);
  const queue: string[] = [];
  ws.on('open', () => {
    for (const m of queue.splice(0)) ws.send(m);
  });
  ws.on('error', () => undefined);
  return {
    onMessage: (cb) => {
      ws.on('message', (d, isBinary) => {
        if (!isBinary) cb((d as Buffer).toString('utf8'));
      });
    },
    onEnd: (cb) => {
      let ended = false;
      const once = (): void => {
        if (ended) return;
        ended = true;
        cb();
      };
      ws.on('close', once);
      ws.on('error', once);
    },
    send: (s) => {
      if (ws.readyState === ws.OPEN) ws.send(s);
      else queue.push(s);
    },
    destroy: () => {
      ws.terminate();
    },
  };
};

/** What Studio and the signer need of the machine, on Node. */
export function nodeSystem(over: Partial<WorkerSystem> = {}): WorkerSystem {
  return {
    os:
      process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    pathEnv: process.env['PATH'],
    runner: nodeRunner,
    isExecutable: async (p) => {
      try {
        await access(p, fsConstants.X_OK);
        return (await stat(p)).isFile();
      } catch {
        return false;
      }
    },
    writePrivate: async (p, data) => {
      await mkdir(dirname(p), { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') await chmod(dirname(p), 0o700);
      const tmp = `${p}.tmp`;
      await writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
      await rename(tmp, p);
      return true;
    },
    writeDurable: async (p, data) => {
      const tmp = `${p}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, p);
      return true;
    },
    freeBytes: async (p) => {
      const s = await statfs(p);
      return s.bavail * s.bsize;
    },
    connectRelay: nodeConnectRelay,
    ...over,
  };
}

export function nodeRuntime(system?: WorkerSystem): WorkerRuntime {
  return {
    fs: nodeFs,
    rmTree: (p) => rm(p, { recursive: true, force: true }),
    createHttpServer: nodeHttpServer,
    ...(system === undefined ? {} : { system }),
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
  /**
   * What the rpc logged for each answer that went out as `internal` (`../../rpc.ts`): the method,
   * and the error's code, syscall and class. Each is printed as it comes; if the test fails, the
   * worker's last log lines are printed too.
   */
  readonly internal: string[];
  /** Write raw bytes to the worker, as a host would. */
  raw(bytes: Uint8Array): void;
  close(): Promise<void>;
}

/** How many of a worker's log lines a failed test prints. */
const LOG_LINES_ON_FAILURE = 50;

/** The worker over the real wire (framing, guards, the client), in this process. */
export function startWorker(over: Partial<Omit<WorkerHostOptions, 'emit'>> = {}): RunningWorker {
  const events: WorkerEvent[] = [];
  const fatal: Error[] = [];
  const internal: string[] = [];
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
    log: createWorkerLogger({
      emit: (ev) => {
        internal.push(ev.msg);
        console.error(`the worker answered internal: ${ev.msg}`);
        rpc.emit(ev);
      },
    }),
  });
  try {
    onTestFailed(() => {
      const lines = events.flatMap((ev) => (ev.e === 'log' ? [ev.msg] : []));
      if (lines.length === 0) return;
      const last = lines.slice(-LOG_LINES_ON_FAILURE).join('\n');
      console.error(`the worker's last log lines:\n${last}`);
    });
  } catch {
    // Not inside a test (a `beforeAll`): the internal answers were printed as they came.
  }
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
    internal,
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
