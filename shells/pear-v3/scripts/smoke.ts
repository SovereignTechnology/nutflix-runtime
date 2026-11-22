/**
 * Launches the PACKAGED app and says what it proved. It runs the real artifact (the AppImage, the
 * `.app`'s executable, the executable inside the unpacked `.msix`) with no switch of its own:
 * what it waits for is the line `main.ts` prints, once, in every build, when the window has
 * loaded `app://nutflix`, the renderer has mounted in it, and the worker has answered `status`
 * (`NUTFLIX_SHELL_READY {...}`). A build that does not print it, or that prints a failure event
 * first, fails here.
 *
 *   node scripts/smoke.ts ready    --exe <file> [--timeout s]
 *   node scripts/smoke.ts warning  --exe <file> [--timeout s]    adds --no-sandbox: expects the warning, no window
 *   node scripts/smoke.ts appimage --file <file>                 native FUSE first, then --appimage-extract-and-run
 *   node scripts/smoke.ts msix     --file <file>                 `makeappx unpack`, then `ready` on app/Nutflix.exe
 *   node scripts/smoke.ts bare     --app <resources/app dir> --platform p --arch a
 *
 * The app is killed by its recorded process group (its pid on Windows, with its tree), never by
 * a name match. Output is the verdict plus, on a failure, the tail of what the app printed.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EVENT_PREFIX, READY_PREFIX } from '../src/shared/ids.ts';
import { MIN_BARE, bareBinary } from '../packaging/identity.ts';
import { makeAppx } from '../packaging/windows-kit.ts';

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Events main prints that mean the run is broken. */
export const FAILURE_EVENTS = [
  'refused-switch',
  'startup-failed',
  'worker-start-failed',
  'worker-init-failed',
  'worker-exit',
  'worker-error',
  'window-load-failed',
  'renderer-not-mounted',
] as const;

export interface ReadyFields {
  readonly shell?: unknown;
  readonly version?: unknown;
  readonly window?: unknown;
  readonly renderer?: unknown;
  readonly worker?: unknown;
  readonly sandbox?: unknown;
}

/** The fields of a READY line, or `null` when `line` is not one. */
export function parseReadyLine(line: string): ReadyFields | null {
  if (!line.startsWith(`${READY_PREFIX} `)) return null;
  try {
    const j: unknown = JSON.parse(line.slice(READY_PREFIX.length + 1));
    return typeof j === 'object' && j !== null && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/** What is wrong with a READY line (empty = it proves what it claims). */
export function readyProblems(f: ReadyFields, sandbox: 'on' | 'off' = 'on'): string[] {
  const want: [keyof ReadyFields, string][] = [
    ['shell', 'pear-v3'],
    ['window', 'loaded'],
    ['renderer', 'mounted'],
    ['worker', 'status-ok'],
    ['sandbox', sandbox],
  ];
  return want
    .filter(([k, v]) => f[k] !== v)
    .map(([k, v]) => `${k}: expected ${v}, got ${JSON.stringify(f[k])}`);
}

/** The event name of an `NUTFLIX_SHELL <name> {...}` line, or `null`. */
export function eventName(line: string): string | null {
  if (!line.startsWith(`${EVENT_PREFIX} `)) return null;
  return /^\S+/.exec(line.slice(EVENT_PREFIX.length + 1))?.[0] ?? null;
}

/** `a` against `b`, numerically by part (`1.29.4` against `1.31.0`). */
export function compareVersions(a: string, b: string): number {
  const x = a.replace(/^v/, '').split('.').map(Number);
  const y = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Ends the app and what it started: its process group, or its tree on Windows. Recorded pids only. */
async function stop(child: ChildProcess, exited: Promise<unknown>): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const signal = (sig: 'SIGTERM' | 'SIGKILL'): void => {
    try {
      if (process.platform === 'win32')
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-pid, sig);
    } catch {
      // Already gone.
    }
  };
  signal('SIGTERM');
  const done = await Promise.race([exited.then(() => true), sleep(15_000).then(() => false)]);
  if (!done) {
    signal('SIGKILL');
    await Promise.race([exited, sleep(10_000)]);
  }
}

export interface LaunchResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly tail: string[];
  readonly ms: number;
  readonly ready: ReadyFields | null;
}

export type Expect = 'ready' | 'warning';

export async function launch(
  exe: string,
  args: readonly string[],
  expect: Expect,
  timeoutS: number,
): Promise<LaunchResult> {
  const started = Date.now();
  const tail: string[] = [];
  const keep = (src: string, text: string): void => {
    for (const l of text.split(/\r?\n/)) if (l !== '') tail.push(`${src} ${l.slice(0, 400)}`);
    if (tail.length > 400) tail.splice(0, tail.length - 400);
  };
  const child = spawn(exe, [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const exited = new Promise<number | null>((r) => {
    child.once('exit', (code) => {
      r(code);
    });
  });
  child.once('error', (e) => {
    keep('spawn', e.message);
  });
  let buffer = '';
  // One object, not four `let`s: the handlers below assign it, the loop reads it.
  const st: {
    verdict: { ok: boolean; reason: string } | null;
    ready: ReadyFields | null;
    warned: boolean;
    exited: boolean;
    exitCode: number | null;
  } = { verdict: null, ready: null, warned: false, exited: false, exitCode: null };
  void exited.then((c) => {
    st.exited = true;
    st.exitCode = c;
  });
  child.stderr.on('data', (c: Buffer) => {
    keep('err', c.toString('utf8'));
  });
  child.stdout.on('data', (c: Buffer) => {
    const text = c.toString('utf8');
    keep('out', text);
    buffer += text;
    for (let i = buffer.indexOf('\n'); i !== -1; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      const f = parseReadyLine(line);
      if (f !== null) {
        st.ready = f;
        if (st.verdict === null) {
          const bad = readyProblems(f, 'on');
          st.verdict =
            expect === 'warning'
              ? { ok: false, reason: 'a window loaded although the sandbox warning was due' }
              : bad.length === 0
                ? { ok: true, reason: 'ready' }
                : { ok: false, reason: `the ready line is wrong: ${bad.join('; ')}` };
        }
        continue;
      }
      const name = eventName(line);
      if (name === 'sandbox-warning') st.warned = true;
      if (
        name !== null &&
        (FAILURE_EVENTS as readonly string[]).includes(name) &&
        st.verdict === null
      )
        st.verdict = { ok: false, reason: `the app reported ${name}` };
    }
  });

  const deadline = started + timeoutS * 1000;
  let warnedAt = 0;
  while (st.verdict === null && Date.now() < deadline) {
    if (st.exited) {
      st.verdict = {
        ok: false,
        reason: `the app exited with code ${String(st.exitCode)} before it was ready`,
      };
      break;
    }
    if (expect === 'warning' && st.warned) {
      warnedAt ||= Date.now();
      // The warning is up. A window or a ready line in the next 10 s would be a failure.
      if (Date.now() - warnedAt >= 10_000) st.verdict = { ok: true, reason: 'warned, no window' };
    }
    await sleep(250);
  }
  const verdict = st.verdict ?? {
    ok: false,
    reason: `no ${expect === 'warning' ? 'warning' : 'ready line'} in ${String(timeoutS)} s`,
  };
  await stop(child, exited);
  return {
    ok: verdict.ok,
    reason: verdict.reason,
    tail,
    ms: Date.now() - started,
    ready: st.ready,
  };
}

/**
 * The Bare version of a packaged `bare`, by asking it: bare-sidecar's runtime is a launcher, not
 * the stock `bare` binary (it has no `--version`), so a one-line script prints `Bare.version`. The
 * launcher expects its IPC pipe on fd 3, as `pear-runtime`'s `run()` gives it, so fd 3 is a pipe,
 * closed once the line is read (the launcher exits when it closes).
 */
export async function bareVersion(bin: string): Promise<{ version?: string; detail: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'shell-v3-bare-'));
  try {
    const script = join(dir, 'version.js');
    writeFileSync(script, "console.log('BARE_VERSION ' + Bare.version);\n");
    const child = spawn(bin, [script], {
      stdio: ['ignore', 'pipe', 'pipe', 'overlapped'],
      detached: process.platform !== 'win32',
    });
    const exited = new Promise<number | null>((r) => {
      child.once('exit', (code) => {
        r(code);
      });
      child.once('error', () => {
        r(null);
      });
    });
    let out = '';
    let err = '';
    const found = new Promise<string | undefined>((resolveFound) => {
      child.stdout?.on('data', (c: Buffer) => {
        out += c.toString('utf8');
        const m = /BARE_VERSION v?(\d+\.\d+\.\d+)/.exec(out);
        if (m !== null) resolveFound(m[1]);
      });
      void exited.then(() => {
        resolveFound(undefined);
      });
    });
    child.stderr?.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });
    const version = await Promise.race([found, sleep(30_000).then(() => undefined)]);
    child.stdio[3]?.destroy();
    await stop(child, exited);
    return { ...(version === undefined ? {} : { version }), detail: `${out}${err}`.slice(0, 400) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function report(label: string, r: LaunchResult): void {
  process.stdout.write(
    `SMOKE ${r.ok ? 'PASS' : 'FAIL'} ${label}: ${r.reason} (${String(r.ms)} ms)\n`,
  );
  if (r.ok && r.ready !== null)
    process.stdout.write(
      `SMOKE   proved: window loaded, renderer mounted, worker answered status, sandbox ${JSON.stringify(r.ready.sandbox)}\n`,
    );
  if (!r.ok) for (const l of r.tail.slice(-60)) process.stdout.write(`SMOKE   | ${l}\n`);
}

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function need(argv: readonly string[], name: string): string {
  const v = arg(argv, name);
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const timeout = Number(arg(rest, '--timeout') ?? '120');
  switch (cmd) {
    case 'ready': {
      const r = await launch(resolve(need(rest, '--exe')), [], 'ready', timeout);
      report('ready', r);
      return r.ok ? 0 : 1;
    }
    case 'warning': {
      const r = await launch(resolve(need(rest, '--exe')), ['--no-sandbox'], 'warning', timeout);
      report('no-sandbox warning', r);
      return r.ok ? 0 : 1;
    }
    case 'appimage': {
      const file = resolve(need(rest, '--file'));
      const fuse = await launch(file, [], 'ready', timeout);
      report('appimage (FUSE)', fuse);
      if (fuse.ok) return 0;
      const first = fuse.tail.find((l) => l.startsWith('err '))?.slice(0, 200) ?? '(no stderr)';
      process.stdout.write(`SMOKE appimage-fuse-failure: ${first}\n`);
      const extract = await launch(file, ['--appimage-extract-and-run'], 'ready', timeout);
      report('appimage (--appimage-extract-and-run)', extract);
      return extract.ok ? 0 : 1;
    }
    case 'msix': {
      const file = resolve(need(rest, '--file'));
      const dir = mkdtempSync(join(tmpdir(), 'shell-v3-msix-'));
      try {
        const u = spawnSync(makeAppx(), ['unpack', '/p', file, '/d', dir, '/o'], {
          encoding: 'utf8',
        });
        if (u.status !== 0) {
          process.stdout.write(
            `SMOKE FAIL msix: makeappx unpack exited ${String(u.status)}\n${u.stdout.slice(-2000)}${u.stderr.slice(-2000)}\n`,
          );
          return 1;
        }
        process.stdout.write('SMOKE msix unpacked by makeappx (the package is well formed)\n');
        const exe = join(dir, 'app', 'Nutflix.exe');
        if (!existsSync(exe)) {
          process.stdout.write('SMOKE FAIL msix: app/Nutflix.exe is not in the package\n');
          return 1;
        }
        const r = await launch(exe, [], 'ready', timeout);
        report('msix payload', r);
        return r.ok ? 0 : 1;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    case 'bare': {
      const platform = need(rest, '--platform');
      const arch = need(rest, '--arch');
      const bin = join(resolve(need(rest, '--app')), bareBinary(platform, arch));
      const v = await bareVersion(bin);
      if (v.version === undefined) {
        process.stdout.write(
          `SMOKE FAIL bare: no version from the packaged runtime: ${v.detail}\n`,
        );
        return 1;
      }
      const ok = compareVersions(v.version, MIN_BARE) >= 0;
      process.stdout.write(
        `SMOKE ${ok ? 'PASS' : 'FAIL'} bare ${v.version} (the worker needs ${MIN_BARE} or later)\n`,
      );
      return ok ? 0 : 1;
    }
    case undefined:
    default:
      process.stderr.write('usage: smoke.ts <ready|warning|appimage|msix|bare> …\n');
      return 2;
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(PKG_DIR, 'scripts', 'smoke.ts')
) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (e: unknown) => {
      process.stderr.write(`smoke: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    },
  );
}
