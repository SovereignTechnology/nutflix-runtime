/**
 * The processes a launched app started, read from the OS's own process table, so that a harness can
 * wait for every one of them to exit before it calls a launch over and deletes what the app wrote.
 * A process is named by its pid AND its start time (a pid can be reused), found by parent from the
 * pid the harness spawned, and on Linux and macOS also by process group. Never by name.
 *
 *   - Linux: `/proc/<pid>/stat` (ppid, process group, start time in clock ticks, zombie state).
 *   - macOS: `ps -A -o pid= -o ppid= -o pgid= -o stat= -o lstart= -o comm=`.
 *   - Windows: `Win32_Process` through PowerShell (no process groups there).
 *
 * The parsers are pure and tested; `processTable` is the only part that reads the OS.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  /** The process group; -1 where the OS has none (Windows). */
  readonly pgid: number;
  /** The start time as the OS gives it: with the pid, what names this process. */
  readonly start: string;
  readonly name: string;
  /** Exited, not yet reaped by its parent: not running. */
  readonly zombie: boolean;
}

const int = (s: string | undefined): number | null =>
  s !== undefined && /^[0-9]+$/.test(s) ? Number(s) : null;

/** One `/proc/<pid>/stat` line. The name sits in parentheses and may hold spaces or parentheses. */
export function parseLinuxStat(text: string): Proc | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 1 || close < open) return null;
  const pid = int(text.slice(0, open).trim());
  // After the name: state (field 3), ppid (4), pgrp (5), … starttime (22).
  const f = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = int(f[1]);
  const pgid = int(f[2]);
  const start = int(f[19]);
  const state = f[0];
  if (pid === null || ppid === null || pgid === null || start === null || state === undefined)
    return null;
  return {
    pid,
    ppid,
    pgid,
    start: String(start),
    name: text.slice(open + 1, close).slice(0, 64),
    zombie: state === 'Z' || state === 'X',
  };
}

/** One line of `ps -o pid= -o ppid= -o pgid= -o stat= -o lstart= -o comm=` (lstart is 5 words). */
export function parsePsLine(line: string): Proc | null {
  const w = line.trim().split(/\s+/);
  if (w.length < 10) return null;
  const pid = int(w[0]);
  const ppid = int(w[1]);
  const pgid = int(w[2]);
  const stat = w[3] ?? '';
  if (pid === null || ppid === null || pgid === null) return null;
  return {
    pid,
    ppid,
    pgid,
    start: w.slice(4, 9).join(' '),
    name: w.slice(9).join(' ').slice(-64),
    zombie: stat.startsWith('Z'),
  };
}

/** One line of `<pid> <ppid> <creation as a FILETIME> <name>` (the PowerShell below prints it). */
export function parseWindowsLine(line: string): Proc | null {
  const m = /^\s*([0-9]+) ([0-9]+) ([0-9]+) (.*)$/.exec(line);
  if (m === null) return null;
  const pid = int(m[1]);
  const ppid = int(m[2]);
  if (pid === null || ppid === null || m[3] === undefined) return null;
  return {
    pid,
    ppid,
    pgid: -1,
    start: m[3],
    name: (m[4] ?? '').trim().slice(0, 64),
    zombie: false,
  };
}

const WINDOWS_TABLE =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $(if ($null -ne $_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }), $_.Name }";

/** Every process this user can see, by pid. Throws when the table cannot be read at all. */
export function processTable(platform: NodeJS.Platform = process.platform): Map<number, Proc> {
  const table = new Map<number, Proc>();
  const add = (p: Proc | null): void => {
    if (p !== null) table.set(p.pid, p);
  };
  if (platform === 'linux') {
    for (const e of readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(e)) continue;
      try {
        add(parseLinuxStat(readFileSync(`/proc/${e}/stat`, 'utf8')));
      } catch {
        // It exited while the table was read.
      }
    }
    return table;
  }
  const r =
    platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TABLE], {
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
          timeout: 30_000,
          killSignal: 'SIGKILL',
        })
      : spawnSync(
          'ps',
          [
            '-A',
            '-o',
            'pid=',
            '-o',
            'ppid=',
            '-o',
            'pgid=',
            '-o',
            'stat=',
            '-o',
            'lstart=',
            '-o',
            'comm=',
          ],
          // The C locale: `lstart` is then always five words.
          {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, LC_ALL: 'C' },
            timeout: 15_000,
            killSignal: 'SIGKILL',
          },
        );
  // A hung `ps` or WMI is killed by the timeout: no table, and the caller fails closed.
  if (r.status !== 0) throw new Error(`the process table: exit ${String(r.status)}`);
  for (const line of r.stdout.split(/\r?\n/))
    add(platform === 'win32' ? parseWindowsLine(line) : parsePsLine(line));
  return table;
}

/**
 * `root` and every process descended from it, by parent. A child must not have started before its
 * parent did (where the start times compare), so a reused pid does not adopt strangers.
 */
export function treeOf(table: ReadonlyMap<number, Proc>, root: number): Proc[] {
  const top = table.get(root);
  if (top === undefined) return [];
  const byParent = new Map<number, Proc[]>();
  for (const p of table.values()) {
    if (p.pid === p.ppid) continue;
    const list = byParent.get(p.ppid) ?? [];
    list.push(p);
    byParent.set(p.ppid, list);
  }
  const notBefore = (child: Proc, parent: Proc): boolean => {
    const a = Number(child.start);
    const b = Number(parent.start);
    return !Number.isFinite(a) || !Number.isFinite(b) || a >= b;
  };
  const out: Proc[] = [top];
  const seen = new Set([root]);
  for (let i = 0; i < out.length; i++) {
    const parent = out[i];
    if (parent === undefined) break;
    for (const c of byParent.get(parent.pid) ?? []) {
      if (seen.has(c.pid) || !notBefore(c, parent)) continue;
      seen.add(c.pid);
      out.push(c);
    }
  }
  return out;
}

/**
 * Which of `tracked` are still running (same pid, same start time, not a zombie), and any other
 * running member of process group `pgid` (Linux, macOS): one the app started after `tracked` was read.
 */
export function stillRunning(
  table: ReadonlyMap<number, Proc>,
  tracked: readonly Proc[],
  pgid?: number,
): Proc[] {
  const out: Proc[] = [];
  const seen = new Set<number>();
  for (const t of tracked) {
    const now = table.get(t.pid);
    if (now !== undefined && now.start === t.start && !now.zombie) {
      out.push(now);
      seen.add(now.pid);
    }
  }
  if (pgid !== undefined && pgid > 0)
    for (const p of table.values())
      if (p.pgid === pgid && !p.zombie && !seen.has(p.pid)) out.push(p);
  return out;
}

/** `pid name`, for a log line. */
export function describe(p: Proc): string {
  return `${String(p.pid)} ${p.name.replace(/[^\x20-\x7e]/g, '?')}`;
}
