/**
 * `../rename-retry.ts` against a fake rename and a fake clock: on Windows a sharing violation
 * (EPERM, EACCES, EBUSY) is tried again within a bound; nothing else is, and nothing is on any
 * other platform.
 */
import type { SeederFs } from '@sovit/seeder';
import { describe, expect, it } from 'vitest';

import {
  RENAME_RETRY_BUDGET_MS,
  TRANSIENT_RENAME_CODES,
  renameRetrying,
  withRenameRetry,
} from '../rename-retry.js';

const errno = (code: string): Error =>
  Object.assign(new Error(`${code}: operation failed, rename`), { code, syscall: 'rename' });

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

describe('withRenameRetry', () => {
  it('sends only rename through it, with the same arguments', async () => {
    const f = fake(['EPERM']);
    const touched: string[] = [];
    const base = {
      rename: f.rename,
      unlink: (p: string) => {
        touched.push(`unlink ${p}`);
        return Promise.reject(errno('EPERM'));
      },
      join: (...parts: string[]) => parts.join('/'),
    } as unknown as SeederFs;
    const fs = withRenameRetry(base, { platform: 'win32', sleep: f.sleep });
    await fs.rename('dir/x.tmp', 'dir/x');
    expect(f.calls).toEqual([
      ['dir/x.tmp', 'dir/x'],
      ['dir/x.tmp', 'dir/x'],
    ]);
    // Only rename: an unlink that fails is thrown at once, as it was.
    await expect(fs.unlink('dir/y')).rejects.toMatchObject({ code: 'EPERM' });
    expect(touched).toEqual(['unlink dir/y']);
    expect(fs.join('a', 'b')).toBe('a/b');

    const linux = fake(['EPERM']);
    const onLinux = withRenameRetry({ ...base, rename: linux.rename }, { platform: 'linux' });
    await expect(onLinux.rename('dir/x.tmp', 'dir/x')).rejects.toMatchObject({ code: 'EPERM' });
    expect(linux.calls).toHaveLength(1);
  });
});
