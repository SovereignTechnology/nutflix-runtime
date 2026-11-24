/**
 * From the five packages CI made to one folder ready for `pear build`, and from the deployment
 * `pear build` made to the digests a notice names.
 *
 *   <out>/release.json                     the version and the five packages it was assembled from
 *   <out>/package.json                     the deployment's manifest
 *   <out>/apps/<target>/Nutflix.<ext>      the input of `pear build` (the name it requires)
 *   <out>/notice-files/Nutflix-<target>.<ext>   the same bytes under the names a notice gives them
 *   <out>/deployment/                      what `pear build` makes
 *   <out>/digests.json                     name, sha256 and bytes of each deployment entry
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { APP } from '../../packaging/identity.ts';
import { deploymentPackageJson } from '../pear-ci/deployment.ts';
import { artifactBytes, digestOf } from './digest.ts';
import { assertVersion, refuse } from './guards.ts';
import { assertProductionRoot, packageFacts } from './inspect.ts';
import { RELEASE_TARGETS, deploymentEntry, type ReleaseTarget } from './targets.ts';

export const RELEASE_SCHEMA = 'nutflix-runtime-release/1';
export const DIGESTS_SCHEMA = 'nutflix-runtime-digests/1';

/** The name a package has in the CI artifacts: a macOS bundle travels as a zip. */
export const inputName = (t: ReleaseTarget): string =>
  t.platform === 'darwin' ? `${APP.productName}-${t.name}.app.zip` : t.file;

function findFile(dir: string, name: string): string | undefined {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const found = findFile(p, name);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * The package of `t` in a folder of downloaded CI artifacts. `release-<target>` first: once the
 * source has an upgrade link, `shell-<target>` holds a test build with a throwaway root and only
 * `release-<target>` is the production build (a wrong pick is refused by the root check).
 */
export function locatePackage(artifacts: string, t: ReleaseTarget): string | undefined {
  for (const prefix of ['release', 'shell']) {
    const dir = join(artifacts, `${prefix}-${t.name}`);
    if (!existsSync(dir)) continue;
    const found = findFile(dir, inputName(t));
    if (found !== undefined) return found;
  }
  return undefined;
}

export interface CheckedPackage {
  readonly target: ReleaseTarget;
  readonly path: string;
}

export interface CheckResult {
  readonly version: string;
  readonly packages: readonly CheckedPackage[];
}

/**
 * All five present, one version, each carrying exactly the production root. Everything is read from
 * the packages' bytes; none is run.
 */
export function checkPackages(artifacts: string): CheckResult {
  const missing = RELEASE_TARGETS.filter((t) => locatePackage(artifacts, t) === undefined);
  if (missing.length > 0)
    return refuse(`missing: ${missing.map((t) => `${t.name} (${inputName(t)})`).join(', ')}`);
  const packages: CheckedPackage[] = [];
  const versions = new Map<string, string>();
  for (const target of RELEASE_TARGETS) {
    const path = locatePackage(artifacts, target) ?? '';
    const facts = packageFacts(path);
    assertProductionRoot(path, facts);
    versions.set(target.name, facts.version);
    packages.push({ target, path });
  }
  const distinct = new Set(versions.values());
  if (distinct.size !== 1)
    return refuse(
      `the packages are not one version: ${[...versions].map(([t, v]) => `${t} ${v}`).join(', ')}`,
    );
  return { version: [...distinct][0] ?? '', packages };
}

function unpackBundle(zip: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const r =
    process.platform === 'darwin'
      ? spawnSync('ditto', ['-x', '-k', zip, dir], { encoding: 'utf8' })
      : spawnSync('unzip', ['-q', '-o', zip, '-d', dir], { encoding: 'utf8' });
  if (r.status !== 0) refuse(`could not unpack ${zip}: ${(r.stderr || r.stdout).slice(0, 300)}`);
}

/** Beside `Nutflix-<target>.app.zip`: the bundle's digest, taken on the Mac that zipped it. */
export const bundleDigestFile = (zip: string): string => `${zip.replace(/\.zip$/, '')}.digest`;

/**
 * The unpacked bundle is the tree the Mac runner packed: every file, executable bit and symlink.
 * A zip made on macOS and unpacked elsewhere could lose any of them, and the code signature seals
 * them all, so this is checked rather than assumed.
 */
export async function assertBundleUnpacked(zip: string, app: string): Promise<void> {
  const file = bundleDigestFile(zip);
  if (!existsSync(file)) return refuse(`${file} is missing: the Mac job writes it beside the zip`);
  const want = readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(want)) return refuse(`${file} is not a digest`);
  const got = await digestOf(app);
  if (got !== want) refuse(`${app} unpacked to ${got}, but the Mac runner packed ${want}`);
}

/** The same bytes under a second name: a hard link for a file, a copy for a bundle. */
function secondName(from: string, to: string): void {
  if (lstatSync(from).isDirectory()) {
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    return;
  }
  try {
    linkSync(from, to);
  } catch {
    cpSync(from, to);
  }
}

export interface ReleaseFile {
  readonly schema: typeof RELEASE_SCHEMA;
  readonly version: string;
  readonly targets: readonly { readonly target: string; readonly app: string }[];
}

/** `checkPackages`, then the folder `pear build` takes. Never over an earlier one. */
export async function assemble(artifacts: string, out: string): Promise<ReleaseFile> {
  if (existsSync(join(out, 'release.json')) || existsSync(join(out, 'apps')))
    refuse(`${out} already holds a release: use an empty folder`);
  // A Windows file system cannot keep a macOS bundle's symlinks, so the digest would be wrong.
  if (process.platform === 'win32') refuse('assemble on Linux or macOS');
  const { version, packages } = checkPackages(artifacts);
  const noticeDir = join(out, 'notice-files');
  mkdirSync(noticeDir, { recursive: true });
  const targets: { target: string; app: string }[] = [];
  for (const { target: t, path } of packages) {
    const dir = join(out, 'apps', t.name);
    mkdirSync(dir, { recursive: true });
    const app = join(dir, t.file);
    if (t.platform === 'darwin') {
      unpackBundle(path, dir);
      if (!existsSync(join(app, 'Contents', 'MacOS', APP.productName)))
        refuse(`${path} holds no ${t.file}/Contents/MacOS/${APP.productName}`);
      await assertBundleUnpacked(path, app);
    } else {
      cpSync(path, app);
      if (t.platform === 'linux') chmodSync(app, 0o755);
    }
    secondName(app, join(noticeDir, t.noticeName));
    targets.push({ target: t.name, app });
  }
  writeFileSync(join(out, 'package.json'), deploymentPackageJson({ version }));
  const release: ReleaseFile = { schema: RELEASE_SCHEMA, version, targets };
  writeFileSync(join(out, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

export function readRelease(out: string): ReleaseFile {
  const file = join(out, 'release.json');
  if (!existsSync(file)) return refuse(`${file} is missing: run assemble first`);
  const r = JSON.parse(readFileSync(file, 'utf8')) as Partial<ReleaseFile>;
  const rows = r.targets;
  if (r.schema !== RELEASE_SCHEMA || rows === undefined || !Array.isArray(rows))
    return refuse(`${file} is not a release file`);
  assertVersion(r.version, `${file}: version`);
  const names = (rows as ReleaseFile['targets']).map((t) => t.target).sort();
  const want = RELEASE_TARGETS.map((t) => t.name as string).sort();
  if (JSON.stringify(names) !== JSON.stringify(want))
    return refuse(`${file} does not list the five targets`);
  return r as ReleaseFile;
}

/** The `--<target>-app <path>` pairs of `pear build`, in target order. */
export function buildAppFlags(release: ReleaseFile): string[] {
  return release.targets.flatMap((t) => [`--${t.target}-app`, t.app]);
}

export interface Digest {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface DigestsFile {
  readonly schema: typeof DIGESTS_SCHEMA;
  readonly version: string;
  readonly artifacts: readonly Digest[];
}

/**
 * One target's digest, from the deployment `pear build` made: that is what gets staged and what the
 * app hashes. It must equal the digest of the package `build` was given, or the trip through
 * `pear build` changed it.
 */
export async function digestTargets(
  deployment: string,
  appOf: (t: ReleaseTarget) => string,
  targets: readonly ReleaseTarget[] = RELEASE_TARGETS,
): Promise<Digest[]> {
  const out: Digest[] = [];
  for (const t of targets) {
    const entry = join(deployment, ...deploymentEntry(t).split('/'));
    if (!existsSync(entry)) refuse(`the deployment has no ${deploymentEntry(t)}`);
    const [sha256, given] = await Promise.all([digestOf(entry), digestOf(appOf(t))]);
    if (sha256 !== given)
      refuse(`${t.name}: the deployment's bytes are not the package's: ${sha256} against ${given}`);
    out.push({ name: t.noticeName, sha256, bytes: await artifactBytes(entry) });
  }
  return out;
}

/** The digests of a whole release, written to `<out>/digests.json`. */
export async function digestRelease(out: string): Promise<DigestsFile> {
  const release = readRelease(out);
  const deployment = join(out, 'deployment');
  if (!existsSync(deployment)) refuse(`${deployment} is missing: run build first`);
  const artifacts = await digestTargets(deployment, (t) => {
    const row = release.targets.find((x) => x.target === t.name);
    return row === undefined ? refuse(`release.json has no ${t.name}`) : row.app;
  });
  // What the publish script checks the notice against must be these same bytes.
  for (const a of artifacts) {
    const copy = await digestOf(join(out, 'notice-files', a.name));
    if (copy !== a.sha256) refuse(`notice-files/${a.name} is not the deployment's entry`);
  }
  const file: DigestsFile = { schema: DIGESTS_SCHEMA, version: release.version, artifacts };
  writeFileSync(join(out, 'digests.json'), `${JSON.stringify(file, null, 2)}\n`);
  return file;
}

export function readDigests(out: string): DigestsFile {
  const p = join(out, 'digests.json');
  if (!existsSync(p)) return refuse(`${p} is missing: run digest first`);
  const d = JSON.parse(readFileSync(p, 'utf8')) as Partial<DigestsFile>;
  const rows = d.artifacts;
  if (d.schema !== DIGESTS_SCHEMA || rows === undefined || !Array.isArray(rows))
    return refuse(`${p} is not a digests file`);
  assertVersion(d.version, `${p}: version`);
  const names = (rows as DigestsFile['artifacts']).map((a) => a.name).sort();
  const want = RELEASE_TARGETS.map((t) => t.noticeName).sort();
  if (JSON.stringify(names) !== JSON.stringify(want))
    return refuse(`${p} does not list the five targets`);
  return d as DigestsFile;
}
