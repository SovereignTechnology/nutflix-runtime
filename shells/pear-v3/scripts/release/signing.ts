/**
 * The owner signs the macOS and Windows packages with real certificates (`docs/release.md`). That
 * changes their bytes, so a signed package cannot equal CI's digest. What it can be is CI's package
 * with signatures added and NOTHING else changed, and this is that check:
 *
 *   - A macOS bundle: every file, symlink and executable bit equal, except `_CodeSignature/`, the
 *     stapled `Contents/CodeResources`, and Mach-O binaries, whose code must be equal once their
 *     signature is taken out (`binary.ts`).
 *   - An `.msix`: every part equal, by sha256, except the signature part and the content-types part
 *     that declares it.
 *
 * CI's digest is never regenerated from a signed package: it stays the reference.
 */
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { treeManifest } from '../pear-ci/deployment.ts';
import { readRelease, writeReleaseFile, type ReleaseRow } from './assemble.ts';
import { machoCodeDigest } from './binary.ts';
import { artifactBytes, digestOf } from './digest.ts';
import { refuse } from './guards.ts';
import { assertPackageArch, assertProductionRoot, packageFacts } from './inspect.ts';
import { RELEASE_TARGETS, type ReleaseTarget } from './targets.ts';
import { forEachZipFile, type ZipEntry } from './zip.ts';

/** What signing and notarizing a bundle may add or rewrite. */
export const isBundleSignaturePath = (path: string): boolean =>
  /(^|\/)_CodeSignature\//.test(path) || path === 'Contents/CodeResources';

/**
 * The parts of an `.msix` that signing it adds or rewrites: the signature, the content types that
 * declare it, and the code-integrity catalog SignTool may add for the package's binaries.
 */
export const MSIX_SIGNATURE_PARTS: ReadonlySet<string> = new Set([
  'AppxSignature.p7x',
  '[Content_Types].xml',
  'AppxMetadata/CodeIntegrity.cat',
]);

async function compareBundle(unsigned: string, signed: string): Promise<void> {
  const a = await treeManifest(unsigned);
  const b = await treeManifest(signed);
  for (const [path, x] of a) {
    const y = b.get(path);
    if (y === undefined) {
      if (!isBundleSignaturePath(path)) refuse(`signing removed ${path}`);
      continue;
    }
    if (isBundleSignaturePath(path)) continue;
    if (x.kind !== y.kind) refuse(`signing changed ${path} from a ${x.kind} to a ${y.kind}`);
    if (x.kind === 'link') {
      if (x.target !== y.target) refuse(`signing changed the link ${path}`);
      continue;
    }
    if (x.exec !== y.exec) refuse(`signing changed the executable bit of ${path}`);
    if (x.sha256 === y.sha256) continue;
    const before = machoCodeDigest(readFileSync(join(unsigned, ...path.split('/'))));
    const after = machoCodeDigest(readFileSync(join(signed, ...path.split('/'))));
    if (before === null || after === null || before !== after)
      refuse(`signing changed more than the signature of ${path}`);
  }
  for (const path of b.keys())
    if (!a.has(path) && !isBundleSignaturePath(path)) refuse(`signing added ${path}`);
}

function msixParts(file: string): Map<string, string> {
  const parts = new Map<string, string>();
  forEachZipFile(file, (e: ZipEntry, bytes) => {
    parts.set(e.name, createHash('sha256').update(bytes).digest('hex'));
  });
  return parts;
}

function compareMsix(unsigned: string, signed: string): void {
  const a = msixParts(unsigned);
  const b = msixParts(signed);
  for (const [name, digest] of a) {
    if (MSIX_SIGNATURE_PARTS.has(name)) continue;
    const other = b.get(name);
    if (other === undefined) refuse(`signing removed ${name}`);
    if (other !== digest) refuse(`signing changed ${name}`);
  }
  for (const name of b.keys())
    if (!a.has(name) && !MSIX_SIGNATURE_PARTS.has(name)) refuse(`signing added ${name}`);
  if (!b.has('AppxSignature.p7x')) refuse(`${signed} has no signature`);
}

/** Refuses unless `signed` is `unsigned` with signatures added, and nothing else changed. */
export async function compareSigned(
  t: ReleaseTarget,
  unsigned: string,
  signed: string,
): Promise<void> {
  if (t.platform === 'linux') return refuse('an AppImage is not signed: it ships as CI built it');
  if (t.platform === 'darwin') {
    if (!lstatSync(signed).isDirectory()) return refuse(`${signed} is not a bundle`);
    await compareBundle(unsigned, signed);
    return;
  }
  if (!lstatSync(signed).isFile()) return refuse(`${signed} is not a file`);
  compareMsix(unsigned, signed);
}

export interface SignedRecord {
  readonly target: string;
  readonly before: string;
  readonly after: string;
  readonly bytes: number;
}

/**
 * Takes in a package the owner signed: CI's unsigned package must still be what was checked, the
 * signed one must differ from it only by signatures, and its root, version, commit and CPU are read
 * again from the signed tree. It then replaces the unsigned package in the deployment.
 */
export async function recordSigned(
  out: string,
  targetName: string,
  signed: string,
): Promise<SignedRecord> {
  const release = readRelease(out);
  const t = RELEASE_TARGETS.find((x) => x.name === targetName);
  if (t === undefined) return refuse(`${targetName} is not a target`);
  if (!signed.endsWith(`/${t.file}`) && !signed.endsWith(`\\${t.file}`))
    return refuse(`the signed package must be named ${t.file}`);
  const row = release.targets.find((x) => x.target === t.name);
  if (row === undefined) return refuse(`release.json has no ${t.name}`);
  if (row.signed !== undefined) return refuse(`${t.name} already has a signed package recorded`);
  if ((await digestOf(row.app)) !== row.ci.digest)
    return refuse(`${row.app} is no longer the package CI built`);

  // Copied first, and every check made on the copy: what is checked is what ships.
  const dir = join(out, 'signed', t.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const app = join(dir, t.file);
  cpSync(signed, app, { recursive: true, verbatimSymlinks: true });
  try {
    await compareSigned(t, row.app, app);
    const facts = packageFacts(app);
    assertProductionRoot(app, facts);
    if (facts.version !== release.version)
      refuse(`${signed} says version ${facts.version}, not ${release.version}`);
    if (facts.commit !== release.commit)
      refuse(`${signed} was built from ${String(facts.commit)}, not ${release.commit}`);
    assertPackageArch(app, t.arch);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const digest = await digestOf(app);
  const bytes = await artifactBytes(app);
  const notice = join(out, 'notice-files', t.noticeName);
  rmSync(notice, { recursive: true, force: true });
  cpSync(app, notice, { recursive: true, verbatimSymlinks: true });
  const targets: ReleaseRow[] = release.targets.map((x) =>
    x.target === t.name ? { ...x, signed: { app, digest, bytes } } : x,
  );
  writeReleaseFile(out, { ...release, targets });
  return { target: t.name, before: row.ci.digest, after: digest, bytes };
}
