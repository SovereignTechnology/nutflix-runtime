/**
 * Getting the Pear CLI onto the runner, and running it against the private DHT.
 *
 * The CLI: an HTTPS download of the platform's GitHub release asset, checked against the sha256 in
 * `pins.ts` before it is unpacked or run. No DHT, no peer, nothing to listen on or seed.
 *
 * The private DHT: `pear --dht-bootstrap <host:port> <command>` is the one way that reaches the
 * sidecar. The CLI starts the sidecar itself when none is running and passes that flag on
 * (`cli.js`, `tryboot`); a sidecar that is already up keeps the DHT it was started with, and any
 * other way of starting one is the public bootstrap. So every call here carries the flag, the first
 * call is the one that starts the sidecar (`touch`, in a home directory that has never held one),
 * and `pear install` gets the flag a second time as its own option, because it opens its own
 * swarm in the CLI process and takes its bootstrap from that option and nothing else.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { PEAR_PINS, pearDownloadUrl, type TargetName } from './pins.ts';
import { assertLoopbackBootstrap, parseRecords, type PearRecord } from './records.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Ends a process we started, and what it started, by its recorded pid only. */
export function killTree(pid: number | undefined, force = false): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // already gone
  }
}

// ---- the CLI itself ----------------------------------------------------------------------------

/** Downloads `url` to `file`, refusing anything but the pinned sha256 and size. */
export async function downloadPinned(
  url: string,
  file: string,
  sha256: string,
  size: number,
): Promise<void> {
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || res.body === null) throw new Error(`HTTP ${String(res.status)}`);
      const hash = createHash('sha256');
      let bytes = 0;
      const body = Readable.fromWeb(res.body as WebReadableStream<Uint8Array>);
      body.on('data', (c: Buffer) => {
        hash.update(c);
        bytes += c.length;
      });
      await pipeline(body, createWriteStream(file));
      const got = hash.digest('hex');
      if (got !== sha256 || bytes !== size) {
        rmSync(file, { force: true });
        // A wrong hash is never retried: it is not a network error.
        throw Object.assign(
          new Error(
            `${url}: sha256 ${got} and ${String(bytes)} bytes, pinned ${sha256} and ${String(size)}`,
          ),
          { fatal: true },
        );
      }
      return;
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal === true) throw e;
      last = e instanceof Error ? e.message : String(e);
      await sleep(attempt * 3000);
    }
  }
  throw new Error(`could not download ${url}: ${last}`);
}

/** Unpacks a zip with the tool this platform ships: unzip (Linux, macOS), PowerShell (Windows). */
export function unzip(zip: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  // `-Command` takes the rest of the command line as the script, not as arguments: quote the paths.
  const q = (p: string): string => `'${p.replaceAll("'", "''")}'`;
  const r =
    process.platform === 'win32'
      ? spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(dir)} -Force`,
          ],
          { encoding: 'utf8' },
        )
      : spawnSync('unzip', ['-q', '-o', zip, '-d', dir], { encoding: 'utf8' });
  if (r.status !== 0)
    throw new Error(`unzip ${zip}: exit ${String(r.status)} ${r.stdout}${r.stderr}`.slice(0, 600));
}

export interface FetchedPear {
  readonly bin: string;
  readonly sha256: string;
  readonly asset: string;
  readonly url: string;
}

/** The pinned Pear CLI for `target`, downloaded, verified and unpacked under `dir`. */
export async function fetchPear(target: TargetName, dir: string): Promise<FetchedPear> {
  const pin = PEAR_PINS[target];
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, pin.asset);
  const url = pearDownloadUrl(pin);
  await downloadPinned(url, zip, pin.sha256, pin.size);
  const out = join(dir, 'pear');
  unzip(zip, out);
  const bin = join(out, pin.binary);
  if (!existsSync(bin)) throw new Error(`${pin.asset} holds no ${pin.binary}`);
  if (process.platform !== 'win32') chmodSync(bin, 0o755);
  return { bin, sha256: pin.sha256, asset: pin.asset, url };
}

// ---- running it ------------------------------------------------------------------------------

/** Where the sidecar keeps its state and its log, for a home directory (`constants.js`). */
export function platformDir(home: string, platform: string): string {
  if (platform === 'win32') return join(home, 'AppData', 'Roaming', 'pear');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'pear');
  return join(home, '.config', 'pear');
}

/** An environment whose home is `home`, for Pear and for the app it installs. */
export function isolatedEnv(
  home: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const xdg = new Set(['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(base).filter(([k]) => !xdg.has(k)),
  );
  env['HOME'] = home;
  // libuv's home directory on Windows is USERPROFILE, which is where Pear keeps its state.
  if (process.platform === 'win32') env['USERPROFILE'] = home;
  // pear install edits shell start-up files (and the user PATH on Windows) for apps with a `bin`.
  env['PEAR_INSTALL_NO_PATH'] = '1';
  return env;
}

export interface RunResult {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly out: string;
  readonly records: PearRecord[];
  readonly logFile: string;
  readonly ms: number;
}

export interface Started {
  readonly logFile: string;
  readonly pid: number | undefined;
  read(): string;
  exited(): boolean;
  stop(): Promise<void>;
}

export class Pear {
  readonly bin: string;
  readonly home: string;
  readonly bootstrap: string;
  readonly logDir: string;
  readonly env: NodeJS.ProcessEnv;
  private seq = 0;

  constructor(o: { bin: string; home: string; bootstrap: string; logDir: string }) {
    assertLoopbackBootstrap(o.bootstrap);
    this.bin = o.bin;
    this.home = o.home;
    this.bootstrap = o.bootstrap;
    this.logDir = o.logDir;
    mkdirSync(o.home, { recursive: true });
    mkdirSync(o.logDir, { recursive: true });
    this.env = isolatedEnv(o.home);
  }

  get sidecarLog(): string {
    return join(platformDir(this.home, process.platform), 'pear.log');
  }

  private open(name: string): { logFile: string; fd: number } {
    this.seq++;
    const logFile = join(this.logDir, `${String(this.seq).padStart(2, '0')}-${name}.log`);
    return { logFile, fd: openSync(logFile, 'a') };
  }

  /** `pear --dht-bootstrap <private> <args>`, output to its own log file, to the end or the timeout. */
  async run(
    name: string,
    args: readonly string[],
    timeoutS: number,
    env: NodeJS.ProcessEnv = this.env,
  ): Promise<RunResult> {
    const { logFile, fd } = this.open(name);
    const started = Date.now();
    const child = spawn(this.bin, ['--dht-bootstrap', this.bootstrap, ...args], {
      env,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (c) => {
        resolve(c);
      });
      child.once('error', (e) => {
        appendFileSync(logFile, `spawn error: ${e.message}\n`);
        resolve(null);
      });
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutS * 1000);
    const code = await exited;
    clearTimeout(timer);
    closeSync(fd);
    const out = readFileSync(logFile, 'utf8');
    return { code, timedOut, out, records: parseRecords(out), logFile, ms: Date.now() - started };
  }

  /** The same, left running (`pear seed`). */
  start(name: string, args: readonly string[]): Started {
    const { logFile, fd } = this.open(name);
    const child = spawn(this.bin, ['--dht-bootstrap', this.bootstrap, ...args], {
      env: this.env,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    let done = false;
    const isDone = (): boolean => done;
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        done = true;
        closeSync(fd);
        resolve();
      });
      child.once('error', (e) => {
        appendFileSync(logFile, `spawn error: ${e.message}\n`);
        done = true;
        resolve();
      });
    });
    return {
      logFile,
      pid: child.pid,
      read: () => readFileSync(logFile, 'utf8'),
      exited: isDone,
      stop: async () => {
        if (isDone()) return;
        killTree(child.pid);
        await Promise.race([exited, sleep(10_000)]);
        if (!isDone()) {
          killTree(child.pid, true);
          await Promise.race([exited, sleep(5_000)]);
        }
      },
    };
  }
}
