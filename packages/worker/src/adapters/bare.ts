/**
 * The Bare runtime for the worker: nutflix-pear's `app-desktop/src/worker/adapters/bare.ts` (the
 * submodule's pinned commit), cut to what this worker uses: `bareSeederFs`, `bareHttpServer` and
 * its process runner (`transcode/bare-process-runner.ts` there, here bounded and with a minimal
 * environment), plus `rmTree`, a 0600 file writer and a relay socket on `bare-ws`. The state
 * files, the iroh helper and the DLEQ thread stay behind (iroh and the Rust helper are not this
 * app's, ADR 0001). The data plane is `./bare-data.ts`. These two are the only modules that import
 * `bare-*` addons, which cannot load under Node: `../main.ts` alone imports this one.
 */
import { TextDecoder } from 'bare-encoding';
import type { ProcessRunner } from '@sovit/core';
import { media } from '@sovit/core';
import env from 'bare-env';
import fs from 'bare-fs';
import path from 'bare-path';
import { constants, spawn, type Subprocess } from 'bare-subprocess';
import { Socket as WebSocket } from 'bare-ws';

import { randomHex } from '../crypto.js';
import { renameRetrying, unlinkRetrying } from '../rename-retry.js';
import { bareDataPlane } from './bare-data.js';
import type { RelayConnect, WorkerRuntime, WorkerSystem } from '../runtime.js';
import { MAX_RELAY_MESSAGE_CHARS } from '../signer/relay-pool.js';

export { bareRmTree, bareSeederFs } from './bare-data.js';

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

/**
 * Linux: `setpriv --pdeathsig KILL` makes the kernel kill ffmpeg when this worker dies, however it
 * dies (a crash, or `bare-sidecar`'s SIGTERM, which runs no handler). Absent on a system without
 * util-linux: then only an orderly exit and a cancel reach the child.
 */
const SETPRIV = '/usr/bin/setpriv';

/** What is running now, so an orderly exit can take it along. */
const liveChildren = new Set<Subprocess>();
let exitHooked = false;

function killOnExit(child: Subprocess): void {
  liveChildren.add(child);
  if (exitHooked) return;
  exitHooked = true;
  Bare.on('exit', () => {
    for (const c of liveChildren) {
      try {
        c.kill(constants['SIGKILL']);
      } catch {
        // Already gone.
      }
    }
  });
}

/** `ProcessRunner` over `bare-subprocess`: argv only, no shell, bounded output. */
function bareRunner(): ProcessRunner {
  const wrap =
    Bare.platform === 'linux' && fs.existsSync(SETPRIV)
      ? (file: string, args: readonly string[]): [string, string[]] => [
          SETPRIV,
          ['--pdeathsig', 'KILL', '--', file, ...args],
        ]
      : (file: string, args: readonly string[]): [string, string[]] => [file, [...args]];
  return {
    run: (file, args, opts) =>
      new Promise((resolve, reject) => {
        if (opts?.signal?.aborted === true) {
          reject(new media.ProcessRunnerError('aborted', file));
          return;
        }
        let child: Subprocess;
        try {
          const [program, argv] = wrap(file, args);
          child = spawn(program, argv, {
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
        killOnExit(child);
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
            liveChildren.delete(child);
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

/**
 * Atomic and on disk: a temporary file, synced, renamed over `p`, and the directory synced. A power
 * cut leaves the old file or the whole new one, never an empty one. Resolves `false` when only the
 * directory's sync failed: the file is in place, so this is not a failed save. On Windows the
 * rename, and the removal of a temporary file left by a failure, ride out a sharing violation
 * (`../rename-retry.ts`); the order stays the same.
 */
async function replaceDurably(p: string, data: Uint8Array): Promise<boolean> {
  const tmp = `${p}.${randomHex(6)}.tmp`;
  try {
    const h = await fs.promises.open(tmp, 'wx', 0o600);
    try {
      // bare-fs's typings say a number; its FileHandle answers `{ bytesWritten, buffer }`.
      const wrote = (await h.write(data)) as unknown as { readonly bytesWritten: number };
      if (wrote.bytesWritten !== data.byteLength) throw new Error('io: a short write');
      await h.sync();
    } finally {
      await h.close();
    }
    await renameRetrying((from, to) => fs.promises.rename(from, to), tmp, p, {
      platform: Bare.platform,
    });
  } catch (e) {
    await unlinkRetrying((q) => fs.promises.unlink(q), tmp, { platform: Bare.platform }).catch(
      () => undefined,
    );
    throw e;
  }
  if (Bare.platform === 'win32') return true;
  try {
    const d = await fs.promises.open(path.dirname(p), 'r');
    try {
      await d.sync();
    } finally {
      await d.close();
    }
    return true;
  } catch {
    return false;
  }
}

/** `replaceDurably`, private: mode 0600 in a 0700 directory. */
async function writePrivate(p: string, data: Uint8Array): Promise<boolean> {
  const dir = path.dirname(p);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  if (Bare.platform !== 'win32') await fs.promises.chmod(dir, 0o700);
  return replaceDurably(p, data);
}

/** The bytes this user may still write on the disk holding `p`. */
async function freeBytes(p: string): Promise<number | null> {
  try {
    const s = await fs.promises.statfs(p);
    const free = s.bavail * s.bsize;
    return Number.isSafeInteger(free) && free >= 0 ? free : null;
  } catch {
    return null;
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
    // A local WebSocket service that checks origins sees who this is, and can refuse it.
    headers: { Origin: 'app://nutflix' },
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
    ...bareDataPlane(),
    system: {
      os: osName(),
      pathEnv: env['PATH'],
      runner: bareRunner(),
      isExecutable,
      writePrivate,
      writeDurable: replaceDurably,
      freeBytes,
      connectRelay,
    },
  };
}
