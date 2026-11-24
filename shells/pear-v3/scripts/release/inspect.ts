/**
 * Reads a file out of a packaged app WITHOUT running it: the version a package says it is, and the
 * trust root baked into its updater. A production build is never launched on a runner (it would
 * join the public DHT), so this is how one is checked.
 *
 *   - `.AppImage`: a static ELF, then a squashfs image; `unsquashfs` reads the file.
 *   - `.msix`: a ZIP (with ZIP64 records); `unzip` reads the file.
 *   - `.app.zip`: the macOS bundle as the `shell` job uploads it; `unzip` again.
 *   - `.app`: a directory.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { APP, STAGED } from '../../packaging/identity.ts';
import { assertReleaseRoot, bakedRootIn } from '../../packaging/update-root.ts';
import type { TrustRoot } from '../../src/update/root.ts';
import { assertVersion, refuse } from './guards.ts';

/** No file this tool reads out of a package is larger (the updater bundle is the big one). */
const MAX_READ = 64 * 1024 * 1024;

/** Where a type-2 AppImage's squashfs starts: right after the runtime's ELF section headers. */
export function appImageOffset(file: string): number {
  const fd = openSync(file, 'r');
  try {
    const h = Buffer.alloc(64);
    if (readSync(fd, h, 0, 64, 0) !== 64) return refuse(`${file} is too short to be an AppImage`);
    if (h.toString('latin1', 0, 4) !== '\x7fELF' || h[4] !== 2 || h[5] !== 1)
      return refuse(`${file} is not a 64-bit little-endian ELF`);
    const offset = Number(h.readBigUInt64LE(0x28)) + h.readUInt16LE(0x3a) * h.readUInt16LE(0x3c);
    if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= statSync(file).size)
      return refuse(`${file}: no squashfs after the ELF`);
    const magic = Buffer.alloc(4);
    readSync(fd, magic, 0, 4, offset);
    if (magic.toString('latin1') !== 'hsqs') return refuse(`${file}: no squashfs at ${offset}`);
    return offset;
  } finally {
    closeSync(fd);
  }
}

function tool(bin: string, args: readonly string[], what: string): string {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: MAX_READ });
  if (r.error !== undefined)
    return refuse(`${what}: could not run ${bin} (${r.error.message}); is it installed?`);
  if (r.status !== 0)
    return refuse(`${what}: ${bin} exit ${String(r.status)}: ${r.stderr.slice(0, 300)}`);
  return r.stdout;
}

/** The text of `rel` (relative to the packaged `resources/app/`) in the package at `path`. */
export function readPackaged(path: string, rel: string): string {
  const what = `${rel} in ${path}`;
  if (path.endsWith('.AppImage'))
    return tool(
      'unsquashfs',
      [
        '-o',
        String(appImageOffset(path)),
        '-cat',
        path,
        `usr/lib/${APP.productName}/resources/app/${rel}`,
      ],
      what,
    );
  if (path.endsWith('.msix')) return tool('unzip', ['-p', path, `app/resources/app/${rel}`], what);
  if (path.endsWith('.app.zip'))
    return tool(
      'unzip',
      ['-p', path, `${APP.productName}.app/Contents/Resources/app/${rel}`],
      what,
    );
  if (path.endsWith('.app'))
    return readFileSync(join(path, 'Contents', 'Resources', 'app', ...rel.split('/')), 'utf8');
  return refuse(`${path} is not a package this tool knows`);
}

export interface PackageFacts {
  readonly version: string;
  readonly root: TrustRoot;
}

/** What a package says about itself, read from its bytes. */
export function packageFacts(path: string): PackageFacts {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readPackaged(path, 'package.json'));
  } catch (e) {
    if (e instanceof SyntaxError) return refuse(`${path}: its package.json is not JSON`);
    throw e;
  }
  const version = assertVersion((pkg as { version?: unknown } | null)?.version, `${path}: version`);
  return { version, root: bakedRootIn(readPackaged(path, STAGED.updateWorker)) };
}

/** Throws unless the package's baked root is exactly the production root this source declares. */
export function assertProductionRoot(path: string, facts: PackageFacts): void {
  try {
    assertReleaseRoot(facts.root);
  } catch (e) {
    refuse(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
