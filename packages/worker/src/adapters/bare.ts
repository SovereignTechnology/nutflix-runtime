/**
 * The Bare runtime for the worker: nutflix-pear's `app-desktop/src/worker/adapters/bare.ts` (the
 * submodule's pinned commit), cut to what this worker uses: `bareSeederFs`, `bareHttpServer` and
 * its process runner (`transcode/bare-process-runner.ts` there, here bounded and with a minimal
 * environment), plus `rmTree`, a 0600 file writer and a relay socket on `bare-ws`. The state
 * files, the iroh helper and the DLEQ thread stay behind (iroh and the Rust helper are not this
 * app's, ADR 0001). The ONLY module that imports `bare-*` addons, which cannot load under Node:
 * `../main.ts` alone imports it.
 */
import { TextDecoder } from 'bare-encoding';
import type { ProcessRunner } from '@sovit/core';
import { media } from '@sovit/core';
import type { FileStat, SeederFs } from '@sovit/seeder';
import env from 'bare-env';
import fs from 'bare-fs';
import path from 'bare-path';
import { constants, spawn, type Subprocess } from 'bare-subprocess';
import { Socket as WebSocket } from 'bare-ws';

import { randomHex } from '../crypto.js';
import type {
  HttpRequestHandler,
  HttpServerLike,
  RelayConnect,
  WorkerRuntime,
  WorkerSystem,
} from '../runtime.js';
import { MAX_RELAY_MESSAGE_CHARS } from '../signer/relay-pool.js';

function errno(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** bare-fs types `readFile` as `string | Buffer`; without an encoding it is always a Buffer. */
function bytes(b: unknown): Uint8Array {
  if (!(b instanceof Uint8Array)) throw new TypeError('readFile returned text');
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

export const bareSeederFs: SeederFs = {
  readFile: async (p) => bytes(await fs.promises.readFile(p)),
  writeFile: (p, data) => fs.promises.writeFile(p, data),
  rename: (from, to) => fs.promises.rename(from, to),
  unlink: (p) => fs.promises.unlink(p),
  mkdir: async (p, opts) => {
    await fs.promises.mkdir(p, { recursive: opts?.recursive ?? false });
  },
  stat: async (p): Promise<FileStat | null> => {
    try {
      const s = await fs.promises.stat(p);
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
    } catch (err) {
      if (errno(err) === 'ENOENT') return null;
      throw err;
    }
  },
  readStream: (p) => fs.createReadStream(p) as AsyncIterable<Uint8Array>,
  readRange: async (p, offset, length) => {
    if (length === 0) return new Uint8Array(0);
    const parts: Uint8Array[] = [];
    // `end` is inclusive (bare-fs `ReadStreamOptions`).
    const stream = fs.createReadStream(p, { start: offset, end: offset + length - 1 });
    for await (const chunk of stream as AsyncIterable<Uint8Array>) parts.push(chunk);
    let n = 0;
    for (const part of parts) n += part.byteLength;
    const out = new Uint8Array(n);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  },
  join: (...parts) => path.join(...parts),
};

/** Remove a directory tree; a missing one is fine. */
export async function bareRmTree(p: string): Promise<void> {
  await fs.promises.rm(p, { recursive: true, force: true });
}

/**
 * `WorkerRuntime.createHttpServer` on bare-http1 (nutflix-pear slice 5d), whose server, request
 * and response mirror node:http's — the shapes `../runtime.ts` names. Imported on the first
 * call, not at the top: it loads bare-tcp and bare-dns, native addons that cannot load under
 * Node.
 */
async function bareHttpServer(onRequest: HttpRequestHandler): Promise<HttpServerLike> {
  const http = (await import('bare-http1')).default;
  return http.createServer({}, (req, res) => {
    onRequest(req, res);
  });
}

/** What ffmpeg's stdout (ffprobe's JSON) and stderr may hold; past it the process is killed. */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;

const osName = (): WorkerSystem['os'] =>
  Bare.platform === 'win32' ? 'windows' : Bare.platform === 'darwin' ? 'macos' : 'linux';

/**
 * Only what a program needs to start: no `LD_*` from the AppImage (it would break the system's
 * ffmpeg) and no `FFREPORT` or proxy settings.
 */
function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** `ProcessRunner` over `bare-subprocess`: argv only, no shell, bounded output. */
function bareRunner(): ProcessRunner {
  return {
    run: (file, args, opts) =>
      new Promise((resolve, reject) => {
        if (opts?.signal?.aborted === true) {
          reject(new media.ProcessRunnerError('aborted', file));
          return;
        }
        let child: Subprocess;
        try {
          child = spawn(file, [...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: false,
            env: childEnv(),
            windowsHide: true,
            ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }),
          });
        } catch (e) {
          // `spawn` throws synchronously when the program cannot start.
          const errno = (e as { code?: unknown }).code;
          reject(
            new media.ProcessRunnerError('spawn-failed', file, {
              ...(typeof errno === 'string' ? { errno } : {}),
            }),
          );
          return;
        }
        const out: Uint8Array[] = [];
        let outBytes = 0;
        let errText = '';
        let partial = '';
        let settled = false;
        let tooMuch = false;
        const decoder = new TextDecoder();
        const kill = (): void => {
          try {
            child.kill(constants['SIGKILL']);
          } catch {
            // Already gone.
          }
        };
        child.stdout?.on('data', (c: unknown) => {
          if (!(c instanceof Uint8Array)) return;
          outBytes += c.byteLength;
          if (outBytes > MAX_STDOUT_BYTES) {
            tooMuch = true;
            kill();
            return;
          }
          out.push(c);
        });
        child.stderr?.on('data', (c: unknown) => {
          if (!(c instanceof Uint8Array)) return;
          const text = decoder.decode(c, { stream: true });
          if (errText.length < MAX_STDERR_CHARS) errText += text.slice(0, MAX_STDERR_CHARS);
          // ffmpeg's `-progress` lines, split on \n or \r; a line with no end is bounded too.
          const parts = (partial + text).split(/\r\n|\r|\n/);
          partial = (parts.pop() ?? '').slice(-4096);
          for (const l of parts) if (l !== '') opts?.onStderrLine?.(l);
        });
        child.on('error', (err: Error) => {
          if (settled) return;
          settled = true;
          reject(new media.ProcessRunnerError('spawn-failed', file, { message: err.message }));
        });
        // `close` follows `exit` once every stdio pipe has drained (bare-subprocess `_onexit`).
        (child as unknown as { on(e: 'close', cb: (code: number | null) => void): void }).on(
          'close',
          (code) => {
            if (settled) return;
            settled = true;
            if (partial !== '') opts?.onStderrLine?.(partial);
            const stdout = new Uint8Array(tooMuch ? 0 : outBytes);
            if (!tooMuch) {
              let at = 0;
              for (const part of out) {
                stdout.set(part, at);
                at += part.byteLength;
              }
            }
            resolve({ exitCode: tooMuch ? -1 : (code ?? -1), stdout, stderr: errText });
          },
        );
        opts?.signal?.addEventListener('abort', () => {
          if (settled) return;
          settled = true;
          kill();
          reject(new media.ProcessRunnerError('aborted', file));
        });
      }),
  };
}

/** Atomic and private: a temporary file with mode 0600, renamed over `p`, in a 0700 directory. */
async function writePrivate(p: string, data: Uint8Array): Promise<void> {
  const dir = path.dirname(p);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (Bare.platform !== 'win32') await fs.promises.chmod(dir, 0o700);
  const tmp = `${p}.${randomHex(6)}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
    await fs.promises.rename(tmp, p);
  } catch (e) {
    await fs.promises.unlink(tmp).catch(() => undefined);
    throw e;
  }
}

const isExecutable = async (p: string): Promise<boolean> => {
  try {
    await fs.promises.access(p, fs.constants.X_OK);
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
};

/** A `wss://` (or loopback `ws://`) relay on `bare-ws`; writes before it opens are queued. */
const connectRelay: RelayConnect = (url) => {
  // Already checked by `parseBunkerUri`; Bare has no `URL` global.
  const m = /^(wss?):\/\/([^:/]+)(?::([0-9]+))?(\/.*)?$/.exec(url);
  if (m === null) throw new Error('invalid-argument: not a relay URL');
  const secure = m[1] === 'wss';
  const ws = new WebSocket({
    secure,
    host: m[2] ?? '',
    port: m[3] === undefined ? (secure ? 443 : 80) : Number(m[3]),
    path: m[4] ?? '/',
    maxPayload: MAX_RELAY_MESSAGE_CHARS,
    handshakeTimeout: 10_000,
  });
  const text = new TextDecoder();
  // A socket error with no listener would be an uncaught exception.
  ws.on('error', () => undefined);
  return {
    onMessage: (cb) => {
      ws.on('data', (d: unknown) => {
        if (d instanceof Uint8Array) cb(text.decode(d));
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
      ws.write(s);
    },
    destroy: () => {
      ws.destroy();
    },
  };
};

export function bareRuntime(): WorkerRuntime {
  return {
    fs: bareSeederFs,
    rmTree: bareRmTree,
    createHttpServer: bareHttpServer,
    system: {
      os: osName(),
      pathEnv: env['PATH'],
      runner: bareRunner(),
      isExecutable,
      writePrivate,
      connectRelay,
    },
  };
}
