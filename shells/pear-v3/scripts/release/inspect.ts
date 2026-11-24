/**
 * Reads a file out of a packaged app WITHOUT running it: the version a package says it is, the
 * commit CI built it from, its CPU, and the trust root baked into its updater. A production build
 * is never launched on a runner (it would join the public DHT), so this is how one is checked.
 *
 *   - `.AppImage`: a static ELF, then a squashfs image; `unsquashfs` reads the file.
 *   - `.msix`: a ZIP, read by `zip.ts`, which refuses a duplicate or ambiguous entry.
 *   - `.app`: a directory, already unpacked by `zip.ts`.
 *
 * These are checks against a MISTAKE: the wrong folder, the wrong run, a stale build. They read what
 * a build declares; they cannot tell that hostile code declares the truth. What ties a package to
 * reviewed code is where it came from (`provenance.ts`).
 */
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { APP, STAGED, type Arch } from '../../packaging/identity.ts';
import {
  assertMainMatchesRoot,
  assertReleaseRoot,
  bakedRootIn,
} from '../../packaging/update-root.ts';
import type { TrustRoot } from '../../src/update/root.ts';
import { elfArch, machoArches } from './binary.ts';
import { assertVersion, refuse } from './guards.ts';
import { readZipFile } from './zip.ts';

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
  if (path.endsWith('.msix')) return readZipFile(path, `app/resources/app/${rel}`).toString('utf8');
  if (path.endsWith('.app'))
    return readFileSync(join(path, 'Contents', 'Resources', 'app', ...rel.split('/')), 'utf8');
  return refuse(`${path} is not a package this tool knows`);
}

export interface PackageFacts {
  readonly version: string;
  /** The commit CI baked in; `null` in a build made anywhere else. */
  readonly commit: string | null;
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
  const fields = (pkg ?? {}) as { version?: unknown; commit?: unknown };
  const version = assertVersion(fields.version, `${path}: version`);
  const commit =
    typeof fields.commit === 'string' && /^[0-9a-f]{40}$/.test(fields.commit)
      ? fields.commit
      : null;
  const root = bakedRootIn(readPackaged(path, STAGED.updateWorker));
  try {
    assertMainMatchesRoot(readPackaged(path, STAGED.main), root);
  } catch (e) {
    return refuse(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { version, commit, root };
}

/** Throws unless the package's baked root is exactly the production root this source declares. */
export function assertProductionRoot(path: string, facts: PackageFacts): void {
  try {
    assertReleaseRoot(facts.root);
  } catch (e) {
    refuse(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Throws unless the package's native code is for `arch`. An `.msix` has one target to be. */
export function assertPackageArch(path: string, arch: Arch): void {
  if (path.endsWith('.msix')) return;
  const exe = path.endsWith('.app') ? join(path, 'Contents', 'MacOS', APP.productName) : path;
  const got = path.endsWith('.app') ? machoArches(exe) : elfArch(exe);
  if (got === null) refuse(`${exe} is not a native binary of a known kind`);
  const list = Array.isArray(got) ? got : [got];
  if (list.length !== 1 || list[0] !== arch)
    refuse(`${path} is built for ${list.join(', ') || 'an unknown CPU'}, not ${arch}`);
}
