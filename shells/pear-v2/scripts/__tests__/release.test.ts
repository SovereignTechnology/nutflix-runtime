/**
 * `scripts/release.ts`, the release entry: what it may import before the copy exists, where it
 * puts the copy, and what it refuses above it. A release is staged on Linux only, so the file
 * system cases do not run on Windows.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CLEAN_COPY_ENV, ancestorPlants, defaultWorkDir, privateDir } from '../release.ts';

const here = dirname(fileURLToPath(import.meta.url));
const source = (name: string): string => readFileSync(join(here, '..', name), 'utf8');
// Comments may name what is not imported; code may not import it.
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the release entry', () => {
  it('imports only node:* before the copy exists, and then only files of the copy', () => {
    const src = code(source('release.ts'));
    const statics = [...src.matchAll(/^\s*import\b[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(
      (m) => m[1],
    );
    expect(statics.length).toBeGreaterThan(3);
    expect(statics.filter((s) => !s?.startsWith('node:'))).toEqual([]);
    expect(src).not.toMatch(/\brequire\(/);
    const dynamic = [...src.matchAll(/\bimport\(\s*([^)]*)/g)].map((m) => m[1]?.trim());
    expect(dynamic).toHaveLength(2);
    for (const d of dynamic) expect(d).toMatch(/^pathToFileURL\(join\(scripts, /);
  });

  it('names the variable the copy reads, as stage.ts does', () => {
    expect(code(source('stage.ts'))).toContain(`const CLEAN_COPY_ENV = '${CLEAN_COPY_ENV}';`);
    expect(code(source('stage.ts'))).not.toMatch(/stageFromCleanCopy|'--clean'/);
  });

  it('finds a node_modules or package.json in the folder or any above it', () => {
    const root = resolve('/');
    const dir = join(root, 'a', 'b', 'c');
    const planted = new Set([join(root, 'a', 'package.json'), join(root, 'node_modules')]);
    expect(ancestorPlants(dir, (p) => planted.has(p))).toEqual([
      join(root, 'a', 'package.json'),
      join(root, 'node_modules'),
    ]);
    expect(ancestorPlants(dir, () => false)).toEqual([]);
  });

  it('puts the copy in the user cache, never in a shared temporary folder', () => {
    expect(defaultWorkDir({ XDG_CACHE_HOME: '/x/cache' })).toBe(
      join('/x/cache', 'nutflix-runtime', 'release-stage'),
    );
    for (const env of [{}, { XDG_CACHE_HOME: 'relative' }, { XDG_CACHE_HOME: '' }])
      expect(defaultWorkDir(env)).toBe(
        join(homedir(), '.cache', 'nutflix-runtime', 'release-stage'),
      );
    expect(defaultWorkDir({}).startsWith(tmpdir())).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('the copy’s folder', () => {
  const scratch = (): { dir: string; rm: () => void } => {
    const dir = mkdtempSync(join(tmpdir(), 'nf-release-'));
    return {
      dir,
      rm: () => {
        rmSync(dir, { recursive: true, force: true });
      },
    };
  };

  it('is made 0700, and a real planted package.json above it is found', () => {
    const s = scratch();
    try {
      const work = privateDir(join(s.dir, 'cache', 'work'));
      // The real path: on macOS the temporary folder is under /var, a symlink to /private/var.
      const base = realpathSync(s.dir);
      expect(work).toBe(join(base, 'cache', 'work'));
      expect(lstatSync(work).mode & 0o777).toBe(0o700);
      expect(ancestorPlants(work).filter((p) => p.startsWith(base))).toEqual([]);
      mkdirSync(join(s.dir, 'cache', 'node_modules'));
      expect(ancestorPlants(work).filter((p) => p.startsWith(base))).toEqual([
        join(base, 'cache', 'node_modules'),
      ]);
    } finally {
      s.rm();
    }
  });

  it('is refused when others can enter it, or when it is a symlink', () => {
    const s = scratch();
    try {
      const open = join(s.dir, 'open');
      mkdirSync(open);
      chmodSync(open, 0o755);
      expect(() => privateDir(open)).toThrow(/open to other users/);
      const real = privateDir(join(s.dir, 'real'));
      const link = join(s.dir, 'link');
      symlinkSync(real, link);
      expect(() => privateDir(link)).toThrow(/not a directory of its own/);
    } finally {
      s.rm();
    }
  });
});
