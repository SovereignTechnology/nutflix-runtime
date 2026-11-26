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
 *   node scripts/smoke.ts appimage --file <file>                 mounted with FUSE: ready, and no no-FUSE notice
 *   node scripts/smoke.ts no-fuse  --file <file>                 no fusermount: private extraction, the notice once
 *   node scripts/smoke.ts stock-warning   --file <file>          restricted kernel, no stored choice: the warning
 *   node scripts/smoke.ts stock-consented --file <file>          restricted kernel, "Run anyway" stored: runs, sandbox off
 *   node scripts/smoke.ts seccomp-warning   --file <file>        a seccomp filter refuses user namespaces: the warning
 *   node scripts/smoke.ts seccomp-consented --file <file>        the same, "Run anyway" stored: runs, sandbox off
 *   node scripts/smoke.ts seccomp-sandboxed --file <file>        a seccomp filter that allows them: runs, sandbox on
 *   node scripts/smoke.ts msix     --file <file>                 `makeappx unpack`, then `ready` on app/Nutflix.exe
 *   node scripts/smoke.ts bare     --app <resources/app dir> --platform p --arch a
 *
 * The app is stopped by its recorded process group (its pid on Windows, with its tree), never by
 * a name match, and a launch is over only once EVERY process it started has exited: the ones read
 * from the process table by parent just before the stop (pid and start time, `processes.ts`), and
 * any other member of its process group. One still running `STOP_GRACE_MS` after the stop fails the
 * launch, whatever it proved before: Quit must end everything the app started. Output is the
 * verdict plus, on a failure, the tail of what the app printed.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EVENT_PREFIX, READY_PREFIX } from '../src/shared/ids.ts';
import { APP, MIN_BARE, bareBinary } from '../packaging/identity.ts';
import { USERNS_LIMITS, USERNS_PROBE } from '../packaging/apprun.ts';
import { CONSENT_FILE } from '../src/main/sandbox-gate.ts';
import { makeAppx } from '../packaging/windows-kit.ts';
import { describe, processTable, stillRunning, treeOf, type Proc } from './processes.ts';

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
  readonly pipe?: unknown;
  readonly rendererSandbox?: unknown;
  readonly webrtcPolicy?: unknown;
  readonly player?: unknown;
  readonly vp9?: unknown;
  readonly h264?: unknown;
  /** Whether this build was packaged with an upgrade link, and so runs the updater. */
  readonly updates?: unknown;
  /** The native Account menu, the only way to secret entry, is in place with all its items. */
  readonly accountMenu?: unknown;
  /** `visible` on Linux and Windows; `system` on macOS, whose menu bar is not the window's. */
  readonly menuBar?: unknown;
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
export function readyProblems(
  f: ReadyFields,
  sandbox: 'on' | 'off' = 'on',
  updates: 'on' | 'off' = 'off',
): string[] {
  const want: [keyof ReadyFields, string][] = [
    ['shell', 'pear-v3'],
    ['window', 'loaded'],
    ['renderer', 'mounted'],
    ['worker', 'status-ok'],
    ['sandbox', sandbox],
    ['pipe', 'round-trip'],
    ['rendererSandbox', sandbox === 'on' ? 'enforced' : 'absent'],
    // ADR 0001 decision 5, as Chromium reports it for this window.
    ['webrtcPolicy', 'default_public_interface_only'],
    // The renderer's whole probe passed in the packaged app: the pinned library loaded through
    // `app:` under the real policy, and its WASM verifier started.
    ['player', 'available'],
    // A build for release has no upgrade link and starts no updater: every launch checks it.
    ['updates', updates],
    ['accountMenu', 'present'],
    ['menuBar', process.platform === 'darwin' ? 'system' : 'visible'],
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

/** The JSON fields of an `NUTFLIX_SHELL <name> {...}` line, or `null`. */
export function eventFields(line: string): Record<string, unknown> | null {
  const start = line.indexOf('{');
  if (!line.startsWith(`${EVENT_PREFIX} `) || start === -1) return null;
  try {
    const j: unknown = JSON.parse(line.slice(start));
    return typeof j === 'object' && j !== null && !Array.isArray(j)
      ? (j as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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

/** How long every process the app started has, after the stop, to exit. */
export const STOP_GRACE_MS = 15_000;

export interface StopReport {
  /** How it was asked to stop: SIGTERM (a quit), or SIGKILL for an app held in its modal warning. */
  readonly signal: 'SIGTERM' | 'SIGKILL';
  /** The app's processes read just before the stop: the launched one and its descendants. */
  readonly tracked: number;
  /** How long until every one of them, and its whole process group, had exited; null if not in time. */
  readonly exitedMs: number | null;
  /** What was still running `STOP_GRACE_MS` after the stop (then killed hard), as `pid name`. */
  readonly lingering: readonly string[];
}

/** The app's processes now, by the table; `null` when the table cannot be read. */
function treeNow(pid: number): Proc[] | null {
  try {
    return treeOf(processTable(), pid);
  } catch {
    return null;
  }
}

/** What stands for the launched process while it runs and no table can be read. */
const launched = (pid: number): Proc => ({
  pid,
  ppid: 0,
  pgid: -1,
  start: '',
  name: 'the launched process',
  zombie: false,
});

/** What stands for "unknown" when no table can be read: nothing proves the app is gone. Never signaled. */
const UNREAD: Proc = {
  pid: 0,
  ppid: 0,
  pgid: -1,
  start: '',
  name: '(the process table could not be read)',
  zombie: false,
};

/**
 * Ends the app and what it started: SIGTERM to its process group (`taskkill /T /F` on Windows, which
 * is always a hard kill), then waits until the launched process, every process recorded just before
 * (`processes.ts`) and every member of its group have exited. Whatever is left after `graceMs` is
 * killed hard and named in the report; so is a table that could not be read (nothing then proves
 * the app is gone). Recorded pids with their start times, and the recorded group, never a name
 * match: a process is signaled only while the table still shows it with the start time it had, and
 * the group only while its leader's pid is not someone else's.
 *
 * `SIGKILL` is for an app parked in its sandbox warning: that box is modal and native, so on Linux
 * and macOS main's thread handles no SIGTERM until it is answered (before this, every such launch
 * on those two ran out the 15 s SIGTERM wait and was killed: about 25 s a launch where a ready one
 * takes 5). Every process must still be gone within `graceMs`.
 */
export async function stop(
  child: ChildProcess,
  exited: Promise<unknown>,
  graceMs: number = STOP_GRACE_MS,
  signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM',
): Promise<StopReport> {
  const posix = process.platform !== 'win32';
  const used = posix ? signal : 'SIGKILL';
  const pid = child.pid;
  if (pid === undefined || pid <= 1)
    return { signal: used, tracked: 0, exitedMs: 0, lingering: [] };
  // Already reaped: its pid, and so its group's id, may be another process's by now.
  const reaped = child.exitCode !== null || child.signalCode !== null;
  const tracked = treeNow(pid);
  const self = tracked?.find((p) => p.pid === pid);
  let gone = reaped;
  void exited.then(() => {
    gone = true;
  });
  /**
   * The group whose members are ours: the launched pid's, while that pid is still the process we
   * spawned, or has no process at all (POSIX does not reuse a pid while a group of that id has
   * members, so the members of a group whose leader is gone are still the ones it left). Never
   * while the pid names another process.
   */
  const groupOf = (table: ReadonlyMap<number, Proc>): number | undefined => {
    if (!posix) return undefined;
    const now = table.get(pid);
    if (now === undefined) return pid;
    return self?.start === now.start ? pid : undefined;
  };
  const running = (): Proc[] => {
    if (tracked === null) return gone ? [UNREAD] : [launched(pid)];
    try {
      const table = processTable();
      return stillRunning(table, tracked, groupOf(table));
    } catch {
      return gone ? [UNREAD] : [launched(pid)];
    }
  };
  const kill = (p: Proc, sig: 'SIGTERM' | 'SIGKILL'): void => {
    if (p.pid <= 1 || p === UNREAD) return;
    if (posix) {
      try {
        process.kill(p.pid, sig);
      } catch {
        // Gone meanwhile.
      }
      return;
    }
    // Windows reuses pids quickly: kill it only if it is still the process that started then.
    if (!/^[0-9]+$/.test(p.start)) return;
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${String(p.pid)}"; if ($null -ne $p -and $null -ne $p.CreationDate -and $p.CreationDate.ToFileTimeUtc() -eq ${p.start}) { Stop-Process -Id ${String(p.pid)} -Force }`,
      ],
      { stdio: 'ignore', windowsHide: true, timeout: 30_000 },
    );
  };
  const t0 = Date.now();
  if (!reaped) {
    try {
      if (posix) process.kill(-pid, signal);
      else spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // Already gone.
    }
  }
  // Each recorded process too, where it may have left the group or the tree walk.
  if (signal === 'SIGKILL' || reaped) for (const p of running()) kill(p, signal);
  // Windows' table costs a PowerShell start: read it less often.
  const every = posix ? 250 : 1000;
  const done = (): StopReport | null => {
    const left = running();
    return gone && left.length === 0
      ? { signal: used, tracked: tracked?.length ?? 0, exitedMs: Date.now() - t0, lingering: [] }
      : null;
  };
  while (Date.now() - t0 < graceMs) {
    const r = done();
    if (r !== null) return r;
    await sleep(every);
  }
  const r = done();
  if (r !== null) return r;
  const left = running();
  const lingering = (left.length > 0 ? left : [launched(pid)]).map(describe);
  for (const p of left) kill(p, 'SIGKILL');
  const until = Date.now() + 10_000;
  while (Date.now() < until && !(gone && running().every((p) => p === UNREAD))) {
    await sleep(every);
    for (const p of running()) kill(p, 'SIGKILL');
  }
  return { signal: used, tracked: tracked?.length ?? 0, exitedMs: null, lingering };
}

export interface LaunchResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly tail: string[];
  readonly ms: number;
  readonly ready: ReadyFields | null;
  /** The names of the events main printed before the harness began to stop it. */
  readonly events: readonly string[];
  /** The names of the events it printed while being stopped (SIGTERM to its process group). */
  readonly teardown: readonly string[];
  /** Every `update` status main printed, in order. */
  readonly updates: readonly Record<string, unknown>[];
  /** The fields of every event `LaunchOptions.collect` names, in order. */
  readonly collected: readonly {
    readonly name: string;
    readonly fields: Record<string, unknown>;
  }[];
  /** How the stop went: every process the app started must have exited. */
  readonly stopped: StopReport;
}

export type Expect = 'ready' | 'warning';

export interface LaunchOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** What the ready line must say about the sandbox. */
  readonly sandbox?: 'on' | 'off';
  /** What the ready line must say about the updater (default: off, a release build). */
  readonly updates?: 'on' | 'off';
  /** The launch also waits for an `update` status this accepts (the install job's gate proof). */
  readonly untilUpdate?: (status: Record<string, unknown>) => boolean;
  /** An event that must also be printed before the launch counts. */
  readonly waitFor?: string;
  /** How long to keep watching after the verdict, for an event that must not come. */
  readonly settleMs?: number;
  /** Called with the app's pid once it is ready and still running (the install job asks Windows whose it is). */
  readonly onReady?: (pid: number) => Promise<void> | void;
  /** Events whose fields the result keeps (`collected`), before the stop. */
  readonly collect?: readonly string[];
}

export async function launch(
  exe: string,
  args: readonly string[],
  expect: Expect,
  timeoutS: number,
  opts: LaunchOptions = {},
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
    ...(opts.env === undefined ? {} : { env: opts.env }),
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
    events: Set<string>;
    teardown: Set<string>;
    stopping: boolean;
    /** A failure event after the verdict, before the stop: the run still fails. */
    late: string | null;
    updates: Record<string, unknown>[];
    updateSeen: boolean;
    collected: { name: string; fields: Record<string, unknown> }[];
  } = {
    verdict: null,
    ready: null,
    warned: false,
    exited: false,
    exitCode: null,
    events: new Set(),
    teardown: new Set(),
    stopping: false,
    late: null,
    updates: [],
    updateSeen: false,
    collected: [],
  };
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
          const bad = readyProblems(f, opts.sandbox ?? 'on', opts.updates ?? 'off');
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
      if (name !== null) (st.stopping ? st.teardown : st.events).add(name);
      if (name === 'update') {
        const status = eventFields(line);
        if (status !== null) {
          st.updates.push(status);
          if (opts.untilUpdate?.(status) === true) st.updateSeen = true;
        }
      }
      if (name !== null && !st.stopping && opts.collect?.includes(name) === true)
        st.collected.push({ name, fields: eventFields(line) ?? {} });
      if (name === 'sandbox-warning') st.warned = true;
      if (name !== null && (FAILURE_EVENTS as readonly string[]).includes(name) && !st.stopping) {
        const fields = eventFields(line);
        const described = `${name}${fields !== null && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : ''}`;
        if (st.verdict === null)
          st.verdict = { ok: false, reason: `the app reported ${described}` };
        else st.late ??= described;
      }
    }
  });

  const deadline = started + timeoutS * 1000;
  let warnedAt = 0;
  const missing = (): boolean =>
    (opts.waitFor !== undefined && !st.events.has(opts.waitFor)) ||
    (opts.untilUpdate !== undefined && !st.updateSeen);
  while ((st.verdict === null || (st.verdict.ok && missing())) && Date.now() < deadline) {
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
  if (st.verdict?.ok === true && missing())
    st.verdict = {
      ok: false,
      reason: `no ${opts.waitFor ?? 'expected update status'} in ${String(timeoutS)} s (updates seen: ${JSON.stringify(st.updates)})`,
    };
  const verdict = st.verdict ?? {
    ok: false,
    reason: `no ${expect === 'warning' ? 'warning' : 'ready line'} in ${String(timeoutS)} s`,
  };
  if (verdict.ok && opts.settleMs !== undefined) await sleep(opts.settleMs);
  if (verdict.ok && opts.onReady !== undefined && child.pid !== undefined && !st.exited) {
    try {
      await opts.onReady(child.pid);
    } catch (e) {
      keep('onReady', e instanceof Error ? e.message : String(e));
    }
  }
  // What the app said before the harness stops it is the run; what it says while being killed is
  // teardown, kept apart. A failure event after the ready line still fails the run.
  st.stopping = true;
  const events = [...st.events];
  const updates = [...st.updates];
  const collected = [...st.collected];
  const late =
    verdict.ok && st.late !== null
      ? { ok: false, reason: `the app reported ${st.late} after it was ready` }
      : verdict;
  // The sandbox warning is a modal native box that holds main's thread: it is killed (`stop`).
  const stopped = await stop(
    child,
    exited,
    STOP_GRACE_MS,
    expect === 'warning' ? 'SIGKILL' : 'SIGTERM',
  );
  // Everything the app started must be gone in time, whatever the run proved before.
  const final =
    stopped.lingering.length > 0
      ? {
          ok: false,
          reason: `${late.ok ? '' : `${late.reason}; and `}${String(stopped.lingering.length)} of its processes were still running ${String(STOP_GRACE_MS / 1000)} s after ${stopped.signal}: ${stopped.lingering.slice(0, 8).join(', ')}`,
        }
      : late;
  return {
    ok: final.ok,
    reason: final.reason,
    tail,
    ms: Date.now() - started,
    ready: st.ready,
    events,
    teardown: [...st.teardown],
    updates,
    collected,
    stopped,
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
    const stopped = await stop(child, exited);
    if (stopped.lingering.length > 0)
      return { detail: `still running after the stop: ${stopped.lingering.join(', ')}` };
    return { ...(version === undefined ? {} : { version }), detail: `${out}${err}`.slice(0, 400) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What `stop` measured, as one line. */
export function stopLine(s: StopReport): string {
  return s.lingering.length > 0
    ? `${String(s.tracked)} processes sent ${s.signal}; still running after ${String(STOP_GRACE_MS / 1000)} s: ${s.lingering.join(', ')}`
    : `${String(s.tracked)} processes sent ${s.signal}; every one${process.platform === 'win32' ? '' : ', and its process group,'} exited in ${String(s.exitedMs)} ms`;
}

function report(label: string, r: LaunchResult): void {
  process.stdout.write(
    `SMOKE ${r.ok ? 'PASS' : 'FAIL'} ${label}: ${r.reason} (${String(r.ms)} ms)\n`,
  );
  process.stdout.write(`SMOKE   stop: ${stopLine(r.stopped)}\n`);
  if (r.ok && r.ready !== null)
    process.stdout.write(
      `SMOKE   proved: window loaded, renderer mounted, worker answered status, page round trip ${JSON.stringify(r.ready.pipe)}, sandbox ${JSON.stringify(r.ready.sandbox)}, OS reports renderer ${JSON.stringify(r.ready.rendererSandbox)}\n` +
        `SMOKE   engine: webrtc player ${JSON.stringify(r.ready.player)}, webrtc ip policy ${JSON.stringify(r.ready.webrtcPolicy)}, vp9-in-mp4 ${JSON.stringify(r.ready.vp9)}, h264 ${JSON.stringify(r.ready.h264)}\n` +
        `SMOKE   account menu ${JSON.stringify(r.ready.accountMenu)}, menu bar ${JSON.stringify(r.ready.menuBar)}\n`,
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

/** Refuses a machine that does not restrict user namespaces: the stock checks would prove nothing. */
function assertRestricted(): void {
  const v = readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim();
  if (v !== '1') throw new Error(`this kernel does not restrict user namespaces (${v})`);
}

/**
 * Refuses a machine that is not what the seccomp checks are about: every process here under a
 * seccomp filter that is not Chromium's (a container's), no kernel setting reporting a limit on user
 * namespaces, and the namespaces the sandbox needs refused or allowed, as `userns` says. With a
 * setting reporting a limit, AppRun would ask Chromium because of it, and the run would prove
 * nothing about the filter.
 */
function assertFiltered(userns: 'refused' | 'allowed'): void {
  const mode = /^Seccomp:\s*(\d+)\s*$/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1];
  if (mode !== '2')
    throw new Error(`this process is under no seccomp filter (Seccomp: ${String(mode)})`);
  for (const [file, limited] of USERNS_LIMITS) {
    let v: string;
    try {
      v = readFileSync(file, 'utf8').trim();
    } catch {
      continue;
    }
    if (v === limited) throw new Error(`a kernel setting limits user namespaces (${file} is ${v})`);
  }
  const [cmd = '', ...args] = USERNS_PROBE;
  const probe = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (probe.error !== undefined) throw new Error(`no ${cmd} here: ${probe.error.message}`);
  const got = probe.status === 0 ? 'allowed' : 'refused';
  if (got !== userns)
    throw new Error(
      `the namespaces the sandbox needs are ${got} here, not ${userns} (${probe.stderr.trim().slice(0, 200)})`,
    );
  process.stdout.write(
    `SMOKE   here: a seccomp filter on every process, no kernel limit, user namespaces ${got}\n`,
  );
}

/** A launch with its own empty config directory, holding a stored "Run anyway" if asked. */
async function stockLaunch(
  file: string,
  consented: boolean,
  timeout: number,
  premise: () => void = assertRestricted,
): Promise<LaunchResult> {
  premise();
  const dir = mkdtempSync(join(tmpdir(), 'shell-v3-config-'));
  try {
    if (consented) {
      mkdirSync(join(dir, APP.name));
      const choice = { v: 1, choice: 'run-anyway', at: new Date().toISOString() };
      writeFileSync(join(dir, APP.name, CONSENT_FILE), `${JSON.stringify(choice)}\n`, {
        mode: 0o600,
      });
    }
    const env = { ...process.env, XDG_CONFIG_HOME: dir };
    return await launch(
      file,
      [],
      consented ? 'ready' : 'warning',
      timeout,
      consented ? { env, sandbox: 'off' } : { env },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NOTICE_EVENT = 'fuse-notice-shown';

/**
 * The real AppImage with no `fusermount` on PATH (AppRun's three tools only), twice, in its own
 * config and cache: the first start extracts privately and shows the notice; the second reuses the
 * extraction and does not show it again. With no `unshare` on PATH either, AppRun asks Chromium
 * first, and a sandbox that starts must let both starts go on as usual.
 */
async function noFuse(file: string, timeout: number): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'shell-v3-nofuse-'));
  try {
    const tools = join(dir, 'tools');
    mkdirSync(tools);
    for (const t of ['dirname', 'readlink', 'cat']) symlinkSync(`/usr/bin/${t}`, join(tools, t));
    const cache = join(dir, 'cache');
    const env = {
      ...process.env,
      PATH: tools,
      XDG_CONFIG_HOME: join(dir, 'config'),
      XDG_CACHE_HOME: cache,
    };
    const first = await launch(file, [], 'ready', timeout, { env, waitFor: NOTICE_EVENT });
    report('no FUSE, first start', first);
    if (!first.ok) return 1;
    const base = join(cache, 'nutflix-runtime');
    const found = readdirSync(base);
    const [only] = found;
    if (found.length !== 1 || only === undefined || !/^appimage-[0-9a-f]{32}$/.test(only)) {
      process.stdout.write(`SMOKE FAIL no FUSE: the cache holds ${String(found.length)} entries\n`);
      return 1;
    }
    const modes = [base, join(base, only)].map((p) => statSync(p).mode & 0o777);
    if (modes.some((m) => m !== 0o700)) {
      process.stdout.write('SMOKE FAIL no FUSE: the extraction is not private\n');
      return 1;
    }
    process.stdout.write('SMOKE   proved: extracted to a private cache, notice shown\n');
    const second = await launch(file, [], 'ready', timeout, { env, settleMs: 3000 });
    report('no FUSE, second start', second);
    if (!second.ok) return 1;
    if (second.events.includes(NOTICE_EVENT)) {
      process.stdout.write('SMOKE FAIL no FUSE: the notice came twice\n');
      return 1;
    }
    process.stdout.write('SMOKE   proved: the second start reuses it, with no second notice\n');
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
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
      const fuse = await launch(file, [], 'ready', timeout, { settleMs: 3000 });
      report('appimage (FUSE)', fuse);
      if (fuse.events.includes(NOTICE_EVENT)) {
        process.stdout.write('SMOKE FAIL appimage: FUSE is here, but it extracted\n');
        return 1;
      }
      return fuse.ok ? 0 : 1;
    }
    case 'no-fuse':
      return noFuse(resolve(need(rest, '--file')), timeout);
    case 'stock-warning': {
      const r = await stockLaunch(resolve(need(rest, '--file')), false, timeout);
      report('stock kernel: the warning', r);
      return r.ok ? 0 : 1;
    }
    case 'stock-consented': {
      const r = await stockLaunch(resolve(need(rest, '--file')), true, timeout);
      report('stock kernel: after Run anyway', r);
      return r.ok ? 0 : 1;
    }
    // No kernel setting says so, but a seccomp filter (Docker's default profile) refuses the user
    // namespaces: AppRun must still find out, and the renderer must not read as confined because of
    // the container's own filter.
    case 'seccomp-warning': {
      const r = await stockLaunch(resolve(need(rest, '--file')), false, timeout, () => {
        assertFiltered('refused');
      });
      report('seccomp filter, no user namespaces: the warning', r);
      return r.ok ? 0 : 1;
    }
    case 'seccomp-consented': {
      const r = await stockLaunch(resolve(need(rest, '--file')), true, timeout, () => {
        assertFiltered('refused');
      });
      report('seccomp filter, no user namespaces: after Run anyway', r);
      return r.ok ? 0 : 1;
    }
    // A filter that allows them: the sandbox starts, and reads as confined, main's filter or not.
    case 'seccomp-sandboxed': {
      assertFiltered('allowed');
      const dir = mkdtempSync(join(tmpdir(), 'shell-v3-config-'));
      try {
        const env = { ...process.env, XDG_CONFIG_HOME: dir };
        const r = await launch(resolve(need(rest, '--file')), [], 'ready', timeout, { env });
        report('seccomp filter, user namespaces allowed: the sandbox on', r);
        return r.ok ? 0 : 1;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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
      process.stderr.write(
        'usage: smoke.ts <ready|warning|appimage|no-fuse|stock-…|seccomp-…|msix|bare> …\n',
      );
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
