import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SYSTEM_ONLY_PACKAGES } from '../../scripts/stage-checks.ts';
import { PEAR_V2, RELEASE_LINE, isReleaseLine, runtimeMismatch } from '../shared/pins.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');

interface LockEntry {
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
  readonly link?: boolean;
  readonly engines?: { readonly bare?: string };
}
interface Lock {
  readonly packages: Readonly<Record<string, LockEntry>>;
}
const read = (...p: string[]): unknown => JSON.parse(readFileSync(join(...p), 'utf8'));
const appLock = read(here, '..', '..', 'app', 'package-lock.json') as Lock;
const rootLock = read(repo, 'package-lock.json') as Lock;
const appPkg = read(here, '..', '..', 'app', 'package.json') as {
  dependencies: Record<string, string>;
  overrides: Record<string, string>;
  pear: { links: Record<string, string>; pre: string };
};

const LINE = { key: 'y'.repeat(52), fork: 0, length: 3100 };
const good = {
  platform: { key: LINE.key, fork: 0, length: 3100 },
  runtimes: { pear: '2.6.5', bare: '1.24.3' },
};

describe('the runtime check', () => {
  it('accepts the exact platform', () => {
    expect(runtimeMismatch(good, LINE.key, LINE)).toBeNull();
  });

  it.each([
    ['another Pear', { ...good, runtimes: { pear: '2.6.6', bare: '1.24.3' } }, LINE.key],
    ['Pear v3', { ...good, runtimes: { pear: '3.7.0', bare: '1.24.3' } }, LINE.key],
    ['another Bare', { ...good, runtimes: { pear: '2.6.5', bare: '1.24.4' } }, LINE.key],
    ['no versions', {}, LINE.key],
    ['another key', good, PEAR_V2.upstream.key],
    ['no key', good, null],
    ['a later length', { ...good, platform: { ...good.platform, length: 3101 } }, LINE.key],
    ['another fork', { ...good, platform: { ...good.platform, fork: 1 } }, LINE.key],
    ['a length as text', { ...good, platform: { ...good.platform, length: '3100' } }, LINE.key],
  ])('refuses %s', (_name, v, key) => {
    expect(runtimeMismatch(v, key, LINE)).not.toBeNull();
  });

  it.each([
    [null],
    [{}],
    [{ key: 'short', fork: 0, length: 1 }],
    [{ key: 'l'.repeat(52), fork: 0, length: 1 }],
    [{ key: LINE.key, fork: -1, length: 1 }],
    [{ key: LINE.key, fork: 0, length: 0 }],
    [{ key: LINE.key, fork: 0.5, length: 1 }],
  ])('a malformed line is not a line: %j', (x) => {
    expect(isReleaseLine(x)).toBe(false);
  });

  it('names no release line until the owner has made one', () => {
    // When this changes it must be a key SovTech controls, never Holepunch's.
    expect(RELEASE_LINE).toBeNull();
  });
});

describe("the app's own pins", () => {
  const atOrBelow = (want: string, have: string): boolean => {
    const a = want.split('.').map(Number);
    const b = have.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
    }
    return true;
  };

  it('holds no package that needs a Bare newer than the pinned one', () => {
    const over = Object.entries(appLock.packages).flatMap(([k, v]) => {
      const min = />=\s*([\d.]+)/.exec(v.engines?.bare ?? '')?.[1];
      return min !== undefined && !atOrBelow(min, PEAR_V2.bare) ? [`${k} needs ${min}`] : [];
    });
    expect(over).toEqual([]);
  });

  it('resolves only to the npm registry, with an integrity hash', () => {
    const bad = Object.entries(appLock.packages).filter(
      ([k, v]) =>
        k !== '' &&
        (v.resolved?.startsWith('https://registry.npmjs.org/') !== true ||
          v.integrity === undefined),
    );
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it('pins every direct dependency and override exactly', () => {
    for (const v of [...Object.values(appPkg.dependencies), ...Object.values(appPkg.overrides)])
      expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps the versions S1 recorded for the runtime pieces', () => {
    expect(appPkg.dependencies['pear-electron']).toBe('1.7.28');
    expect(appPkg.dependencies['bare-fs']).toBe('4.7.1');
    expect(appPkg.dependencies['bare-http1']).toBe('4.5.6');
    expect(appLock.packages['node_modules/bare-fs']?.version).toBe('4.7.1');
    expect(appPkg.pear.pre).toBe('pear-electron/pre');
  });

  it('lets the window reach loopback and nothing else', () => {
    expect(appPkg.pear.links).toEqual({ loopback: 'http://127.0.0.1' });
  });

  it('pins what the worker and nutflix-pear declare, but for two older modules and no system ones', () => {
    // Older for Bare 1.24.3 (S1): the worker's own versions need Bare 1.28 or later.
    const older: Record<string, string> = { 'bare-fs': '4.7.1', 'bare-http1': '4.5.6' };
    const declared = [
      read(repo, 'packages', 'worker', 'package.json'),
      read(repo, 'vendor', 'nutflix-pear', 'packages', 'core', 'package.json'),
      read(repo, 'vendor', 'nutflix-pear', 'packages', 'seeder', 'package.json'),
    ] as { dependencies: Record<string, string> }[];
    const drift: string[] = [];
    for (const { dependencies } of declared)
      for (const [name, version] of Object.entries(dependencies)) {
        if (name.startsWith('@sovit/') || name.startsWith('@nutflix-runtime/')) continue;
        if (SYSTEM_ONLY_PACKAGES.includes(name)) {
          if (name in appPkg.dependencies) drift.push(`${name} is system-only, and pinned`);
          continue;
        }
        const want = older[name] ?? version;
        if (appPkg.dependencies[name] !== want)
          drift.push(`${name}: app ${String(appPkg.dependencies[name])}, want ${want}`);
      }
    expect(drift).toEqual([]);
  });

  it("leaves shape (a)'s own bare-fs where it was", () => {
    expect(rootLock.packages['node_modules/bare-fs']?.version).toBe('4.8.4');
  });
});
