/**
 * `../rename-retry.ts` against a fake rename, unlink and tree removal and a fake clock: on Windows a
 * sharing violation (EPERM, EACCES, EBUSY; and ENOTEMPTY for a tree) is tried again within a bound;
 * nothing else is, and nothing is on any other platform. Then that the Bare adapters send every
 * rename, unlink and tree removal through it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SeederFs } from '@sovit/seeder';
import { describe, expect, it } from 'vitest';

import {
  RENAME_RETRY_BUDGET_MS,
  TRANSIENT_RENAME_CODES,
  TRANSIENT_RM_TREE_CODES,
  TRANSIENT_UNLINK_CODES,
  renameRetrying,
  rmTreeRetrying,
  unlinkRetrying,
  withSharingRetry,
} from '../rename-retry.js';

const errno = (code: string, syscall = 'rename'): Error =>
  Object.assign(new Error(`${code}: operation failed, ${syscall}`), { code, syscall });

/** A rename that fails with `codes`, in order, then works; a clock that only counts. */
function fake(codes: readonly (string | Error)[]): {
  rename: (from: string, to: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  calls: [string, string][];
  waits: number[];
} {
  const calls: [string, string][] = [];
  const waits: number[] = [];
  let i = 0;
  return {
    rename: (from, to) => {
      calls.push([from, to]);
      const next = codes[i++];
      if (next === undefined) return Promise.resolve();
      return Promise.reject(typeof next === 'string' ? errno(next) : next);
    },
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    calls,
    waits,
  };
}

describe('renameRetrying', () => {
  it('on win32, tries a transient EPERM, EACCES or EBUSY again until it works', async () => {
    expect([...TRANSIENT_RENAME_CODES].sort()).toEqual(['EACCES', 'EBUSY', 'EPERM']);
    for (const code of TRANSIENT_RENAME_CODES) {
      const f = fake([code, code, code]);
      await renameRetrying(f.rename, 'a.tmp', 'a', { platform: 'win32', sleep: f.sleep });
      expect(f.calls).toEqual([
        ['a.tmp', 'a'],
        ['a.tmp', 'a'],
        ['a.tmp', 'a'],
        ['a.tmp', 'a'],
      ]);
      expect(f.waits).toEqual([10, 20, 40]);
    }
  });

  it('on any other platform, throws an EPERM, EACCES or EBUSY at once', async () => {
    for (const platform of ['linux', 'darwin', 'android', 'ios'])
      for (const code of TRANSIENT_RENAME_CODES) {
        const f = fake([code]);
        await expect(
          renameRetrying(f.rename, 'a.tmp', 'a', { platform, sleep: f.sleep }),
        ).rejects.toMatchObject({ code });
        expect(f.calls).toHaveLength(1);
        expect(f.waits).toEqual([]);
      }
  });

  it('gives up with the last error once its waits would pass the bound', async () => {
    const last = errno('EBUSY');
    const f = fake([...Array<string>(10).fill('EPERM'), last]);
    await expect(
      renameRetrying(f.rename, 'a.tmp', 'a', { platform: 'win32', sleep: f.sleep }),
    ).rejects.toBe(last);
    expect(f.waits).toEqual([10, 20, 40, 80, 160, 320, 500, 500, 500, 500]);
    expect(f.calls).toHaveLength(11);
    const total = f.waits.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(RENAME_RETRY_BUDGET_MS);
    expect(RENAME_RETRY_BUDGET_MS).toBeLessThanOrEqual(5000);
  });

  it('never tries ENOENT again, nor any other code, nor a failure with no code, on win32', async () => {
    const odd = [
      errno('ENOENT'),
      errno('EXDEV'),
      errno('EISDIR'),
      errno('ENOTEMPTY'),
      errno('ENOSPC'),
      errno('EMFILE'),
      new Error('EPERM in the message only'),
      Object.assign(new Error('x'), { code: 'eperm' }),
      Object.assign(new Error('x'), { code: -4048 }),
    ];
    for (const err of odd) {
      const f = fake([err]);
      await expect(
        renameRetrying(f.rename, 'a.tmp', 'a', { platform: 'win32', sleep: f.sleep }),
      ).rejects.toBe(err);
      expect(f.calls).toHaveLength(1);
      expect(f.waits).toEqual([]);
    }
    const f = fake([]);
    const thrown = 'not an error';
    await expect(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point
      renameRetrying(() => Promise.reject(thrown), 'a.tmp', 'a', {
        platform: 'win32',
        sleep: f.sleep,
      }),
    ).rejects.toBe(thrown);
    expect(f.waits).toEqual([]);
  });

  it('a transient error, then another code: the other code is thrown, not tried again', async () => {
    const enoent = errno('ENOENT');
    const f = fake(['EPERM', enoent, 'EPERM']);
    await expect(
      renameRetrying(f.rename, 'a.tmp', 'a', { platform: 'win32', sleep: f.sleep }),
    ).rejects.toBe(enoent);
    expect(f.calls).toHaveLength(2);
    expect(f.waits).toEqual([10]);
  });

  it('waits on the real clock when given none', async () => {
    const f = fake(['EBUSY']);
    const start = Date.now();
    await renameRetrying(f.rename, 'a.tmp', 'a', { platform: 'win32' });
    expect(f.calls).toHaveLength(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(5);
  });
});

/** A one-path operation (unlink, tree removal) that fails with `codes`, in order, then works. */
function fakeOne(
  codes: readonly (string | Error)[],
  syscall: string,
): {
  op: (p: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  calls: string[];
  waits: number[];
} {
  const f = fake(codes.map((c) => (typeof c === 'string' ? errno(c, syscall) : c)));
  return {
    op: (p) => f.rename(p, p),
    sleep: f.sleep,
    get calls() {
      return f.calls.map(([p]) => p);
    },
    waits: f.waits,
  };
}

describe.each([
  ['unlinkRetrying', unlinkRetrying, TRANSIENT_UNLINK_CODES, 'unlink'],
  ['rmTreeRetrying', rmTreeRetrying, TRANSIENT_RM_TREE_CODES, 'rmdir'],
] as const)('%s', (_name, retrying, codes, syscall) => {
  it('on win32, tries each of its transient codes again until it works', async () => {
    for (const code of codes) {
      const f = fakeOne([code, code], syscall);
      await retrying(f.op, 'dir/x', { platform: 'win32', sleep: f.sleep });
      expect(f.calls).toEqual(['dir/x', 'dir/x', 'dir/x']);
      expect(f.waits).toEqual([10, 20]);
    }
  });

  it('on any other platform, throws every one of them at once', async () => {
    for (const platform of ['linux', 'darwin', 'android', 'ios'])
      for (const code of codes) {
        const f = fakeOne([code], syscall);
        await expect(retrying(f.op, 'dir/x', { platform, sleep: f.sleep })).rejects.toMatchObject({
          code,
        });
        expect(f.calls).toHaveLength(1);
        expect(f.waits).toEqual([]);
      }
  });

  it('gives up with the last error once its waits would pass the bound', async () => {
    const last = errno('EBUSY', syscall);
    const f = fakeOne([...Array<string>(10).fill('EPERM'), last], syscall);
    await expect(retrying(f.op, 'dir/x', { platform: 'win32', sleep: f.sleep })).rejects.toBe(last);
    expect(f.waits).toEqual([10, 20, 40, 80, 160, 320, 500, 500, 500, 500]);
    expect(f.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(RENAME_RETRY_BUDGET_MS);
    expect(f.calls).toHaveLength(11);
  });

  it('never tries ENOENT again, nor any other code, nor a failure with no code, on win32', async () => {
    const odd = [
      errno('ENOENT', syscall),
      errno('EISDIR', syscall),
      errno('ENOSPC', syscall),
      errno('EMFILE', syscall),
      errno('EROFS', syscall),
      new Error('EBUSY in the message only'),
      Object.assign(new Error('x'), { code: 'ebusy' }),
      Object.assign(new Error('x'), { code: -4082 }),
    ];
    for (const err of odd) {
      const f = fakeOne([err], syscall);
      await expect(retrying(f.op, 'dir/x', { platform: 'win32', sleep: f.sleep })).rejects.toBe(
        err,
      );
      expect(f.calls).toHaveLength(1);
      expect(f.waits).toEqual([]);
    }
  });
});

describe('which codes are transient', () => {
  it('a rename and an unlink: a sharing violation; a tree: that, or a folder not yet empty', () => {
    expect([...TRANSIENT_UNLINK_CODES].sort()).toEqual(['EACCES', 'EBUSY', 'EPERM']);
    expect([...TRANSIENT_RM_TREE_CODES].sort()).toEqual(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);
  });

  it('ENOTEMPTY is tried again for a tree only, never for an unlink or a rename', async () => {
    const tree = fakeOne(['ENOTEMPTY'], 'rmdir');
    await rmTreeRetrying(tree.op, 'dir', { platform: 'win32', sleep: tree.sleep });
    expect(tree.calls).toHaveLength(2);

    const unlink = fakeOne(['ENOTEMPTY'], 'unlink');
    await expect(
      unlinkRetrying(unlink.op, 'dir/x', { platform: 'win32', sleep: unlink.sleep }),
    ).rejects.toMatchObject({ code: 'ENOTEMPTY' });
    expect(unlink.calls).toHaveLength(1);

    const rename = fake(['ENOTEMPTY']);
    await expect(
      renameRetrying(rename.rename, 'a', 'b', { platform: 'win32', sleep: rename.sleep }),
    ).rejects.toMatchObject({ code: 'ENOTEMPTY' });
    expect(rename.calls).toHaveLength(1);
  });
});

describe('withSharingRetry', () => {
  it('sends rename and unlink through it, with the same arguments, and nothing else', async () => {
    const f = fake(['EPERM']);
    const unlinked = fakeOne(['EBUSY'], 'unlink');
    const touched: string[] = [];
    const base = {
      rename: f.rename,
      unlink: unlinked.op,
      writeFile: (p: string) => {
        touched.push(`writeFile ${p}`);
        return Promise.reject(errno('EPERM', 'open'));
      },
      join: (...parts: string[]) => parts.join('/'),
    } as unknown as SeederFs;
    const fs = withSharingRetry(base, { platform: 'win32', sleep: f.sleep });
    await fs.rename('dir/x.tmp', 'dir/x');
    expect(f.calls).toEqual([
      ['dir/x.tmp', 'dir/x'],
      ['dir/x.tmp', 'dir/x'],
    ]);
    await fs.unlink('dir/y');
    expect(unlinked.calls).toEqual(['dir/y', 'dir/y']);
    // Nothing else: a write that fails is thrown at once, as it was.
    await expect(fs.writeFile('dir/z', new Uint8Array(0))).rejects.toMatchObject({ code: 'EPERM' });
    expect(touched).toEqual(['writeFile dir/z']);
    expect(fs.join('a', 'b')).toBe('a/b');

    const linux = fake(['EPERM']);
    const linuxUnlink = fakeOne(['EPERM'], 'unlink');
    const onLinux = withSharingRetry(
      { ...base, rename: linux.rename, unlink: linuxUnlink.op },
      { platform: 'linux' },
    );
    await expect(onLinux.rename('dir/x.tmp', 'dir/x')).rejects.toMatchObject({ code: 'EPERM' });
    await expect(onLinux.unlink('dir/y')).rejects.toMatchObject({ code: 'EPERM' });
    expect(linux.calls).toHaveLength(1);
    expect(linuxUnlink.calls).toHaveLength(1);
  });
});

describe('the Bare adapters', () => {
  // They load bare-fs, which cannot load under Node: what they send through the helper is read
  // from their source. The worker's Bare suites run them for real.
  const src = (f: string): string =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', f), 'utf8');

  it('the data plane: its SeederFs and its rmTree go through it', () => {
    const data = src('bare-data.ts');
    expect(data).toMatch(
      /export const bareSeederFs: SeederFs = withSharingRetry\(bareFiles, \{ platform: Bare\.platform \}\);/,
    );
    expect(data).toMatch(
      /export function bareRmTree\(p: string\): Promise<void> \{\s*return rmTreeRetrying\(\s*\(q\) => fs\.promises\.rm\(q, \{ recursive: true, force: true \}\),\s*p,\s*\{\s*platform: Bare\.platform,?\s*\},?\s*\);\s*\}/,
    );
    // No other rm, and the raw rename and unlink only inside `bareFiles`.
    expect(data.match(/fs\.promises\.rm\(/g)).toHaveLength(1);
    expect(data.match(/fs\.promises\.(rename|unlink)\(/g)).toHaveLength(2);
  });

  it('the system adapter: every rename and unlink it makes itself goes through it', () => {
    const lines = src('bare.ts').split('\n');
    const raw = lines.filter((l) => /fs\.promises\.(rename|unlink|rm)\(/.test(l));
    expect(raw.length).toBeGreaterThan(0);
    for (const l of raw)
      expect(l).toMatch(/(renameRetrying|unlinkRetrying)\(\([\w, ]*\) => fs\.promises\./);
  });
});
