/**
 * Copying the runtime closure into the staged tree: the small, pure pieces of `stage.ts`, apart
 * from it so that the tests can read them. After nutflix-pear's `app-desktop/packaging/stage.ts`
 * (the submodule's pinned commit): `copyPackage`, `npmFilter`, `workspaceFilter`, `normalizeModes`.
 */
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { keepPrebuild } from '../../../vendor/nutflix-pear/packages/app-desktop/packaging/closure.ts';

export class StageError extends Error {
  override readonly name = 'StageError' as const;
}

export function fail(msg: string): never {
  throw new StageError(msg);
}

export interface CopyStats {
  files: number;
  bytes: number;
}

/**
 * Copies one package directory. Symlinks are refused (their content would come from outside the
 * reviewed tree); nested `node_modules` are separate closure entries. Modes are kept
 * (`copyFileSync` copies permission bits), so the `bare` runtime stays executable.
 */
export function copyPackage(
  src: string,
  dst: string,
  keep: (rel: string, isDir: boolean) => boolean,
  stats: CopyStats,
): void {
  const walk = (rel: string): void => {
    const from = join(src, rel);
    const st = lstatSync(from);
    if (st.isSymbolicLink()) fail(`symlink in a shipped package is refused: ${from}`);
    if (st.isDirectory()) {
      mkdirSync(join(dst, rel), { recursive: true });
      for (const name of readdirSync(from).sort()) {
        const child = rel === '' ? name : `${rel}/${name}`;
        const childSt = lstatSync(join(src, child));
        if (keep(child, childSt.isDirectory())) walk(child);
      }
      return;
    }
    if (!st.isFile()) fail(`unsupported entry in a shipped package: ${from}`);
    copyFileSync(from, join(dst, rel));
    stats.files++;
    stats.bytes += st.size;
  };
  walk('');
}

/** npm package filter: no nested node_modules, other platforms' prebuilds dropped. */
export function npmFilter(
  platform: string,
  arch: string,
): (rel: string, isDir: boolean) => boolean {
  return (rel, isDir) => {
    const parts = rel.split('/');
    if (parts.includes('node_modules')) return false;
    if (isDir && parts.length === 2 && parts[0] === 'prebuilds')
      return keepPrebuild(parts[1] ?? '', platform, arch);
    return true;
  };
}

/** Workspace package filter: package.json + its `files`, without tests, maps or declarations. */
export function workspaceFilter(
  files: readonly string[],
): (rel: string, isDir: boolean) => boolean {
  return (rel, isDir) => {
    const parts = rel.split('/');
    const top = parts[0] ?? '';
    if (parts.length === 1 && !isDir) return top === 'package.json' || files.includes(top);
    if (!files.includes(top)) return false;
    if (parts.includes('__tests__') || parts.includes('node_modules')) return false;
    if (isDir) return true;
    return !/\.(?:map|d\.ts|tsbuildinfo)$/.test(rel) && !rel.endsWith('.test.js');
  };
}

/** Every staged directory 0755, every file 0644, or 0755 if it was executable (`bare`). */
export function normalizeModes(root: string): void {
  const walk = (p: string): void => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) fail(`symlink in the staged tree: ${p}`);
    if (st.isDirectory()) {
      chmodSync(p, 0o755);
      for (const e of readdirSync(p)) walk(join(p, e));
    } else chmodSync(p, (st.mode & 0o111) !== 0 ? 0o755 : 0o644);
  };
  walk(root);
}
