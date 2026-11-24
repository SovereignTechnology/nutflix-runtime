/**
 * From the five packages of one CI run to one folder ready for `pear build`, and from the deployment
 * `pear build` made to the digests a notice names.
 *
 *   <artifacts>/release-<target>.zip       the artifacts, as `download` fetched them
 *   <out>/release.json                     the run, the commit, and each package's digest
 *   <out>/package.json                     the deployment's manifest
 *   <out>/apps/<target>/Nutflix.<ext>      the package CI built, unpacked and checked
 *   <out>/signed/<target>/Nutflix.<ext>    the same package after the owner signed it, if they did
 *   <out>/notice-files/Nutflix-<target>.<ext>   what the notice names, under the names it uses
 *   <out>/deployment/                      what `pear build` makes
 *   <out>/digests.json                     name, sha256 and bytes of each deployment entry
 *
 * The record in `release.json` is what later steps compare against. Nothing after `assemble` trusts
 * the files in `<out>` to still be what was checked.
 */
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { APP } from '../../packaging/identity.ts';
import { deploymentPackageJson } from '../pear-ci/deployment.ts';
import { artifactBytes, digestOf } from './digest.ts';
import { assertVersion, refuse } from './guards.ts';
import {
  assertPackageArch,
  assertProductionRoot,
  packageFacts,
  type PackageFacts,
} from './inspect.ts';
import {
  assertArtifactBytes,
  downloadArtifact,
  runArtifacts,
  verifyMainRun,
  type GitHubApi,
  type RunArtifact,
} from './provenance.ts';
import { RELEASE_TARGETS, deploymentEntry, type ReleaseTarget } from './targets.ts';
import { extractZip } from './zip.ts';

export const RELEASE_SCHEMA = 'nutflix-runtime-release/2';
export const DIGESTS_SCHEMA = 'nutflix-runtime-digests/2';

/** The name a package has inside its CI artifact: a macOS bundle travels as a zip. */
export const inputName = (t: ReleaseTarget): string =>
  t.platform === 'darwin' ? `${APP.productName}-${t.name}.app.zip` : t.file;

/** Beside the bundle's zip in the artifact: its digest, taken on the Mac that zipped it. */
export const bundleDigestName = (t: ReleaseTarget): string =>
  `${APP.productName}-${t.name}.app.digest`;

export const artifactName = (prefix: string, t: ReleaseTarget): string => `${prefix}-${t.name}`;
export const artifactZip = (artifacts: string, prefix: string, t: ReleaseTarget): string =>
  join(artifacts, `${artifactName(prefix, t)}.zip`);

/** The production packages are only ever `release-<target>`, uploaded by a push to main. */
export const RELEASE_PREFIX = 'release';

/** What a package must be to go into this release. */
export interface PackageRules {
  /** All five must carry this commit. */
  readonly commit: string;
  /** Throws unless this is the root this release wants. The CLI's is the production root. */
  readonly assertRoot: (path: string, facts: PackageFacts) => void;
  /** How the facts are read; the tests stand in for packages they cannot make. */
  readonly factsOf?: (path: string) => PackageFacts;
  /** Tests only, for the same reason. */
  readonly assertArch?: (path: string, target: ReleaseTarget) => void;
}

export const productionRules = (commit: string): PackageRules => ({
  commit,
  assertRoot: assertProductionRoot,
});

export interface UnpackedPackage {
  readonly target: ReleaseTarget;
  readonly app: string;
  readonly version: string;
  readonly digest: string;
  readonly bytes: number;
}

/**
 * Unpacks one artifact into `dir` and checks the RESULT: what is read is what ships. A macOS bundle
 * must also be the exact tree the Mac runner zipped.
 */
export async function unpackPackage(
  t: ReleaseTarget,
  zip: string,
  dir: string,
  rules: PackageRules,
): Promise<UnpackedPackage> {
  const inner = `${dir}.artifact`;
  rmSync(inner, { recursive: true, force: true });
  extractZip(zip, inner);
  try {
    const input = join(inner, inputName(t));
    if (!existsSync(input)) refuse(`${zip} holds no ${inputName(t)}`);
    const app = join(dir, t.file);
    if (t.platform === 'darwin') {
      extractZip(input, dir);
      if (!existsSync(join(app, 'Contents', 'MacOS', APP.productName)))
        refuse(`${input} holds no ${t.file}/Contents/MacOS/${APP.productName}`);
      const recorded = join(inner, bundleDigestName(t));
      if (!existsSync(recorded)) refuse(`${zip} holds no ${bundleDigestName(t)}`);
      const want = readFileSync(recorded, 'utf8').trim();
      if (!/^[0-9a-f]{64}$/.test(want)) refuse(`${bundleDigestName(t)} is not a digest`);
      const got = await digestOf(app);
      if (got !== want) refuse(`${app} unpacked to ${got}, but the Mac runner packed ${want}`);
    } else {
      mkdirSync(dir, { recursive: true });
      cpSync(input, app);
      if (t.platform === 'linux') chmodSync(app, 0o755);
    }
    const facts = (rules.factsOf ?? packageFacts)(app);
    rules.assertRoot(app, facts);
    if (facts.commit !== rules.commit)
      refuse(`${app} was built from ${String(facts.commit)}, not ${rules.commit}`);
    if (rules.assertArch === undefined) assertPackageArch(app, t.arch);
    else rules.assertArch(app, t);
    return {
      target: t,
      app,
      version: facts.version,
      digest: await digestOf(app),
      bytes: await artifactBytes(app),
    };
  } finally {
    rmSync(inner, { recursive: true, force: true });
  }
}

function oneVersion(packages: readonly UnpackedPackage[]): string {
  const distinct = new Set(packages.map((p) => p.version));
  if (distinct.size !== 1)
    return refuse(
      `the packages are not one version: ${packages.map((p) => `${p.target.name} ${p.version}`).join(', ')}`,
    );
  return [...distinct][0] ?? '';
}

/** All five, unpacked under `root` and checked. */
export async function unpackAll(
  artifacts: string,
  prefix: string,
  root: string,
  rules: PackageRules,
): Promise<{ version: string; packages: UnpackedPackage[] }> {
  const missing = RELEASE_TARGETS.filter((t) => !existsSync(artifactZip(artifacts, prefix, t)));
  if (missing.length > 0)
    return refuse(`missing: ${missing.map((t) => `${artifactName(prefix, t)}.zip`).join(', ')}`);
  mkdirSync(root, { recursive: true });
  const packages: UnpackedPackage[] = [];
  for (const t of RELEASE_TARGETS)
    packages.push(
      await unpackPackage(t, artifactZip(artifacts, prefix, t), join(root, t.name), rules),
    );
  return { version: oneVersion(packages), packages };
}

const releaseNames = (): string[] => RELEASE_TARGETS.map((t) => artifactName(RELEASE_PREFIX, t));

/** Fetches the five production artifacts of a verified run, each checked against GitHub's digest. */
export async function downloadRelease(
  api: GitHubApi,
  run: number,
  commit: string,
  artifacts: string,
): Promise<void> {
  await verifyMainRun(api, run, commit);
  const listed = await runArtifacts(api, run, commit, releaseNames());
  mkdirSync(artifacts, { recursive: true });
  for (const a of listed.values()) await downloadArtifact(api, a, join(artifacts, `${a.name}.zip`));
}

/** The run is a release build, and the zips on this disk are the ones it made. */
export async function verifyDownloaded(
  api: GitHubApi,
  run: number,
  commit: string,
  artifacts: string,
): Promise<void> {
  await verifyMainRun(api, run, commit);
  const listed: Map<string, RunArtifact> = await runArtifacts(api, run, commit, releaseNames());
  for (const a of listed.values()) {
    const file = join(artifacts, `${a.name}.zip`);
    if (!existsSync(file)) refuse(`${file} is missing: run download first`);
    await assertArtifactBytes(file, a);
  }
}

export interface CheckResult {
  readonly version: string;
  readonly packages: readonly { readonly target: ReleaseTarget; readonly digest: string }[];
}

/**
 * All five present, from one verified run, one version, one commit, each with exactly the production
 * root and for the right CPU. Everything is read from the unpacked packages; none is run.
 */
export async function checkRelease(
  api: GitHubApi,
  run: number,
  commit: string,
  artifacts: string,
  rules: PackageRules = productionRules(commit),
): Promise<CheckResult> {
  await verifyDownloaded(api, run, commit, artifacts);
  const scratch = mkdtempSync(join(artifacts, '.check-'));
  try {
    const { version, packages } = await unpackAll(artifacts, RELEASE_PREFIX, scratch, rules);
    return { version, packages };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface ReleaseRow {
  readonly target: string;
  /** The package CI built, unpacked. */
  readonly app: string;
  /** Its digest and size when it was checked. */
  readonly ci: { readonly digest: string; readonly bytes: number };
  /** After the owner signed it (`record-signed`): what goes into the deployment instead. */
  readonly signed?: {
    readonly app: string;
    readonly digest: string;
    readonly bytes: number;
  };
}

export interface ReleaseFile {
  readonly schema: typeof RELEASE_SCHEMA;
  readonly version: string;
  readonly commit: string;
  readonly run: number;
  readonly targets: readonly ReleaseRow[];
}

/** The folder `pear build` takes, from packages already verified. Never over an earlier one. */
export async function assemblePackages(
  artifacts: string,
  prefix: string,
  out: string,
  run: number,
  rules: PackageRules,
): Promise<ReleaseFile> {
  if (existsSync(join(out, 'release.json')) || existsSync(join(out, 'apps')))
    refuse(`${out} already holds a release: use an empty folder`);
  const noticeDir = join(out, 'notice-files');
  mkdirSync(noticeDir, { recursive: true });
  const { version, packages } = await unpackAll(artifacts, prefix, join(out, 'apps'), rules);
  const targets: ReleaseRow[] = [];
  for (const p of packages) {
    cpSync(p.app, join(noticeDir, p.target.noticeName), {
      recursive: true,
      verbatimSymlinks: true,
    });
    targets.push({
      target: p.target.name,
      app: p.app,
      ci: { digest: p.digest, bytes: p.bytes },
    });
  }
  writeFileSync(join(out, 'package.json'), deploymentPackageJson({ version }));
  const release: ReleaseFile = {
    schema: RELEASE_SCHEMA,
    version,
    commit: rules.commit,
    run,
    targets,
  };
  writeReleaseFile(out, release);
  return release;
}

/** `check`, then the folder `pear build` takes. */
export async function assemble(
  api: GitHubApi,
  run: number,
  commit: string,
  artifacts: string,
  out: string,
): Promise<ReleaseFile> {
  // A Windows file system cannot keep a macOS bundle's symlinks, so the digest would be wrong.
  if (process.platform === 'win32') refuse('assemble on Linux or macOS');
  await verifyDownloaded(api, run, commit, artifacts);
  return assemblePackages(artifacts, RELEASE_PREFIX, out, run, productionRules(commit));
}

export function writeReleaseFile(out: string, release: ReleaseFile): void {
  writeFileSync(join(out, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
}

export function readRelease(out: string): ReleaseFile {
  const file = join(out, 'release.json');
  if (!existsSync(file)) return refuse(`${file} is missing: run assemble first`);
  const r = JSON.parse(readFileSync(file, 'utf8')) as Partial<ReleaseFile>;
  const rows = r.targets;
  if (r.schema !== RELEASE_SCHEMA || rows === undefined || !Array.isArray(rows))
    return refuse(`${file} is not a release file`);
  assertVersion(r.version, `${file}: version`);
  if (typeof r.commit !== 'string' || !/^[0-9a-f]{40}$/.test(r.commit))
    return refuse(`${file} names no commit`);
  const names = (rows as ReleaseFile['targets']).map((t) => t.target).sort();
  const want = RELEASE_TARGETS.map((t) => t.name as string).sort();
  if (JSON.stringify(names) !== JSON.stringify(want))
    return refuse(`${file} does not list the five targets`);
  return r as ReleaseFile;
}

/** What goes into the deployment for a row: the signed package once there is one. */
export const shippedApp = (row: ReleaseRow): string => row.signed?.app ?? row.app;
export const shippedDigest = (row: ReleaseRow): string => row.signed?.digest ?? row.ci.digest;

/** The `--<target>-app <path>` pairs of `pear build`, in target order. */
export function buildAppFlags(release: ReleaseFile): string[] {
  return release.targets.flatMap((t) => [`--${t.target}-app`, shippedApp(t)]);
}

export interface Digest {
  readonly name: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface DigestsFile {
  readonly schema: typeof DIGESTS_SCHEMA;
  readonly version: string;
  /** From the packages, by way of `release.json`: never typed in. */
  readonly commit: string;
  readonly artifacts: readonly Digest[];
}

/**
 * One target's digest, from the deployment `pear build` made: that is what gets staged and what the
 * app hashes. It must equal the digest recorded when the package was checked.
 */
export async function digestTargets(
  deployment: string,
  recorded: (t: ReleaseTarget) => string,
  targets: readonly ReleaseTarget[] = RELEASE_TARGETS,
): Promise<Digest[]> {
  const out: Digest[] = [];
  for (const t of targets) {
    const entry = join(deployment, ...deploymentEntry(t).split('/'));
    if (!existsSync(entry)) refuse(`the deployment has no ${deploymentEntry(t)}`);
    const sha256 = await digestOf(entry);
    const want = recorded(t);
    if (sha256 !== want)
      refuse(`${t.name}: the deployment's bytes are not the package's: ${sha256} against ${want}`);
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
    return row === undefined ? refuse(`release.json has no ${t.name}`) : shippedDigest(row);
  });
  // What the publish script checks the notice against must be these same bytes.
  for (const a of artifacts) {
    const copy = await digestOf(join(out, 'notice-files', a.name));
    if (copy !== a.sha256) refuse(`notice-files/${a.name} is not the deployment's entry`);
  }
  const file: DigestsFile = {
    schema: DIGESTS_SCHEMA,
    version: release.version,
    commit: release.commit,
    artifacts,
  };
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
  if (typeof d.commit !== 'string' || !/^[0-9a-f]{40}$/.test(d.commit))
    return refuse(`${p} names no commit`);
  const names = (rows as DigestsFile['artifacts']).map((a) => a.name).sort();
  const want = RELEASE_TARGETS.map((t) => t.noticeName).sort();
  if (JSON.stringify(names) !== JSON.stringify(want))
    return refuse(`${p} does not list the five targets`);
  return d as DigestsFile;
}
