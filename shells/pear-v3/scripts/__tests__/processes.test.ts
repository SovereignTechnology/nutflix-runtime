/**
 * A launch is over only when every process the app started has exited (`smoke.ts` `stop`, reading
 * `processes.ts`): the parsers read each OS's table, the tree is found by parent from the recorded
 * pid with start times guarding against a reused one, and a real process tree is waited for, or
 * named as still running and killed.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  describe as describeProc,
  parseLinuxStat,
  parsePsLine,
  parseWindowsLine,
  processTable,
  stillRunning,
  treeOf,
  type Proc,
} from '../processes.ts';
import { stop } from '../smoke.ts';

describe('the process tables', () => {
  it('reads a Linux stat line, a name with spaces and parentheses included', () => {
    const line =
      '4242 (Nutflix (a b)) S 4241 4200 4200 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 30 0 987654 1000 10 18446744073709551615';
    expect(parseLinuxStat(line)).toEqual({
      pid: 4242,
      ppid: 4241,
      pgid: 4200,
      start: '987654',
      name: 'Nutflix (a b)',
      zombie: false,
    });
    expect(parseLinuxStat(line.replace(') S ', ') Z '))?.zombie).toBe(true);
    expect(parseLinuxStat('garbage')).toBeNull();
  });

  it('reads a macOS ps line in the C locale', () => {
    expect(
      parsePsLine(
        ' 501   500   500 S    Mon Nov 24 13:06:11 2026     /Applications/Nutflix Helper',
      ),
    ).toEqual({
      pid: 501,
      ppid: 500,
      pgid: 500,
      start: 'Mon Nov 24 13:06:11 2026',
      name: '/Applications/Nutflix Helper',
      zombie: false,
    });
    expect(parsePsLine(' 9 1 9 Z+ Mon Nov 24 13:06:11 2026 x')?.zombie).toBe(true);
    expect(parsePsLine('1 2 3')).toBeNull();
  });

  it('reads the Windows line the PowerShell prints', () => {
    expect(parseWindowsLine('7000 6000 134087000000000000 Nutflix.exe')).toEqual({
      pid: 7000,
      ppid: 6000,
      pgid: -1,
      start: '134087000000000000',
      name: 'Nutflix.exe',
      zombie: false,
    });
    expect(parseWindowsLine('')).toBeNull();
  });
});

const proc = (pid: number, ppid: number, start: number, pgid = 1): Proc => ({
  pid,
  ppid,
  pgid,
  start: String(start),
  name: `p${String(pid)}`,
  zombie: false,
});

describe('the tree and what is left of it', () => {
  const table = new Map(
    [
      proc(10, 1, 100, 10),
      proc(11, 10, 101, 10),
      proc(12, 11, 102, 10),
      // A reused pid: its "parent" 11 started after it did, so it is not the app's.
      proc(13, 11, 50, 13),
      proc(14, 10, 103, 14),
      proc(20, 1, 100, 20),
    ].map((p) => [p.pid, p]),
  );

  it('follows parents from the recorded pid, and adopts no older stranger', () => {
    expect(
      treeOf(table, 10)
        .map((p) => p.pid)
        .sort(),
    ).toEqual([10, 11, 12, 14]);
    expect(treeOf(table, 99)).toEqual([]);
  });

  it('keeps a process only while its pid and start time are the same, and adds any group member', () => {
    const tracked = treeOf(table, 10);
    const later = new Map(table);
    later.delete(11);
    later.set(12, { ...proc(12, 1, 999, 10) }); // pid 12 reused
    later.set(30, proc(30, 1, 200, 10)); // started after the reading, in the group
    later.set(14, { ...proc(14, 10, 103, 14), zombie: true });
    expect(
      stillRunning(later, tracked, 10)
        .map((p) => p.pid)
        .sort(),
    ).toEqual([10, 12, 30]);
    expect(stillRunning(later, tracked).map((p) => p.pid)).toEqual([10]);
    expect(describeProc(proc(10, 1, 1))).toBe('10 p10');
  });
});

// ---- a real tree ----------------------------------------------------------------------------------

/**
 * A node parent that starts one child running `childCode`, prints its pid, and stays (or exits after
 * `parentExitsMs`, leaving the child in its process group, as the AppImage runtime can).
 */
function tree(
  childCode: string,
  parentOnTerm = '',
  parentExitsMs?: number,
): {
  parent: ChildProcess;
  exited: Promise<number | null>;
  child: Promise<number>;
} {
  const parentCode = `
    const { spawn } = require('node:child_process');
    const c = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore', ${parentOnTerm === '' ? '' : 'detached: true'} });
    ${parentOnTerm}
    setTimeout(() => process.stdout.write('CHILD ' + c.pid + '\\n'), 500);
    ${parentExitsMs === undefined ? 'setInterval(() => {}, 1000);' : `setTimeout(() => process.exit(0), ${String(parentExitsMs)});`}`;
  const parent = spawn(process.execPath, ['-e', parentCode], {
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: process.platform !== 'win32',
  });
  const exited = new Promise<number | null>((r) => {
    parent.once('exit', (code) => {
      r(code);
    });
  });
  const child = new Promise<number>((resolve, reject) => {
    let out = '';
    parent.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /CHILD (\d+)/.exec(out);
      if (m?.[1] !== undefined) resolve(Number(m[1]));
    });
    void exited.then(() => {
      reject(new Error('the parent exited first'));
    });
  });
  return { parent, exited, child };
}

const alive = (pid: number): boolean => {
  const p = processTable().get(pid);
  return p !== undefined && !p.zombie;
};

describe.skipIf(process.platform === 'win32')('stopping a real tree (POSIX)', () => {
  it('waits for a child that takes its time to quit after the parent is gone', async () => {
    const t = tree(
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 1500)); setInterval(() => {}, 1000);",
    );
    const kid = await t.child;
    const r = await stop(t.parent, t.exited, 8_000);
    expect(r.lingering).toEqual([]);
    expect(r.tracked).toBeGreaterThanOrEqual(2);
    expect(r.exitedMs).toBeGreaterThanOrEqual(1_200);
    expect(alive(kid)).toBe(false);
  }, 30_000);

  it('waits for a child outside the group that the parent ends when it quits', async () => {
    const t = tree(
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 500)); setInterval(() => {}, 1000);",
      "process.on('SIGTERM', () => { c.kill('SIGTERM'); c.once('exit', () => process.exit(0)); });",
    );
    const kid = await t.child;
    const r = await stop(t.parent, t.exited, 8_000);
    expect(r.lingering).toEqual([]);
    expect(alive(kid)).toBe(false);
  }, 30_000);

  it('kills at once when asked to (an app held in a modal box), and still sees every one gone', async () => {
    const t = tree("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
    const kid = await t.child;
    const r = await stop(t.parent, t.exited, 8_000, 'SIGKILL');
    expect(r).toMatchObject({ signal: 'SIGKILL', lingering: [] });
    expect(r.exitedMs).toBeLessThan(5_000);
    expect(alive(kid)).toBe(false);
  }, 30_000);

  it('finds what the launched process left in its group after it exited, and ends it', async () => {
    const t = tree('setInterval(() => {}, 1000);', '', 900);
    const kid = await t.child;
    await t.exited;
    expect(alive(kid)).toBe(true);
    const r = await stop(t.parent, t.exited, 8_000);
    expect(r.lingering).toEqual([]);
    expect(alive(kid)).toBe(false);
  }, 30_000);

  it('names a child that will not quit, and kills it', async () => {
    const t = tree("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
    const kid = await t.child;
    const r = await stop(t.parent, t.exited, 1_500);
    expect(r.exitedMs).toBeNull();
    expect(r.lingering.some((l) => l.startsWith(`${String(kid)} `))).toBe(true);
    expect(alive(kid)).toBe(false);
  }, 30_000);
});

describe.skipIf(process.platform !== 'win32')('stopping a real tree (Windows)', () => {
  it('ends the whole tree and sees every process gone', async () => {
    const t = tree('setInterval(() => {}, 1000);');
    const kid = await t.child;
    const r = await stop(t.parent, t.exited, 15_000);
    expect(r.lingering).toEqual([]);
    expect(r.tracked).toBeGreaterThanOrEqual(2);
    expect(alive(kid)).toBe(false);
  }, 60_000);
});
