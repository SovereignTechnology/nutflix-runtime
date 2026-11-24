/**
 * The signing step of the runbook, on the OS that does it, with a certificate that is NOT a real one:
 * an ad-hoc signature on macOS and a certificate made for this job on Windows. It proves that the
 * tool takes a package signed that way and refuses anything else changed. It proves nothing about
 * Apple's or a certificate authority's tools, notarization, or stapling.
 *
 *   node scripts/release/prove-signing.ts --target <darwin-arm64|win32-x64> --artifact <dir> --work <dir>
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { releaseRoot } from '../../packaging/update-root.ts';
import { deploymentPackageJson } from '../pear-ci/deployment.ts';
import { newTestCert, removeTestCert, signMsix } from '../pear-ci/windows.ts';
import {
  RELEASE_SCHEMA,
  bundleDigestName,
  inputName,
  readRelease,
  writeReleaseFile,
  type ReleaseFile,
} from './assemble.ts';
import { expectRefusal } from './guards.ts';
import { artifactBytes, digestOf } from './digest.ts';
import { assertProductionRoot, packageFacts } from './inspect.ts';
import { compareSigned, recordSigned } from './signing.ts';
import { RELEASE_TARGETS, type ReleaseTarget } from './targets.ts';
import { extractZip } from './zip.ts';

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pear-ci');
const say = (l: string): void => {
  process.stdout.write(`${l}\n`);
};

function arg(argv: readonly string[], name: string): string {
  const i = argv.indexOf(name);
  const v = i === -1 ? undefined : argv[i + 1];
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
}

function run(bin: string, args: readonly string[]): void {
  const r = spawnSync(bin, [...args], { encoding: 'utf8' });
  if (r.status !== 0)
    throw new Error(`${bin} ${args.join(' ')}: exit ${String(r.status)} ${r.stderr.slice(0, 600)}`);
}

function findUnder(dir: string, name: string): string {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const inside = findIn(p, name);
      if (inside !== undefined) return inside;
    }
  }
  throw new Error(`no ${name} under ${dir}`);
}

function findIn(dir: string, name: string): string | undefined {
  try {
    return findUnder(dir, name);
  } catch {
    return undefined;
  }
}

/** A release folder holding this one real package: what `record-signed` reads. */
function releaseFolder(out: string, t: ReleaseTarget, app: string, digest: string, bytes: number) {
  const facts = packageFacts(app);
  if (facts.commit === null) throw new Error('the package carries no commit');
  mkdirSync(join(out, 'notice-files'), { recursive: true });
  writeFileSync(join(out, 'package.json'), deploymentPackageJson({ version: facts.version }));
  const release: ReleaseFile = {
    schema: RELEASE_SCHEMA,
    version: facts.version,
    commit: facts.commit,
    run: Number(process.env['GITHUB_RUN_ID'] ?? '1'),
    targets: RELEASE_TARGETS.map((x) => ({
      target: x.name,
      app: x.name === t.name ? app : join(out, 'not-this-job', x.file),
      ci: { digest: x.name === t.name ? digest : '0'.repeat(64), bytes },
    })),
  };
  writeReleaseFile(out, release);
}

async function proveBundle(t: ReleaseTarget, artifact: string, work: string): Promise<string[]> {
  const zip = findUnder(artifact, inputName(t));
  const unpacked = join(work, 'unsigned');
  extractZip(zip, unpacked);
  const app = join(unpacked, t.file);
  const ciDigest = readFileSync(findUnder(artifact, bundleDigestName(t)), 'utf8').trim();
  const digest = await digestOf(app);
  if (digest !== ciDigest)
    throw new Error(`the unpacked bundle is ${digest}, CI packed ${ciDigest}`);
  assertProductionRootIfNoLink(app);

  const copy = (name: string): string => {
    const dir = join(work, name);
    mkdirSync(dir);
    const to = join(dir, t.file);
    run('ditto', [app, to]);
    return to;
  };
  const signed = copy('signed');
  run('codesign', ['--force', '--deep', '--sign', '-', signed]);
  run('codesign', ['--verify', '--deep', '--strict', signed]);
  const after = await digestOf(signed);
  if (after === digest) throw new Error('re-signing changed nothing: this proves nothing');
  await compareSigned(t, app, signed);

  const script = copy('script');
  run('codesign', ['--force', '--deep', '--sign', '-', script]);
  appendFileSync(join(script, 'Contents', 'Resources', 'app', 'main', 'main.cjs'), '\n// changed');
  await expectRefusal(
    'a signed bundle with a script changed',
    () => compareSigned(t, app, script),
    /signing changed more than the signature of Contents\/Resources\/app\/main\/main\.cjs/,
  );

  const code = copy('code');
  run('codesign', ['--force', '--deep', '--sign', '-', code]);
  const exe = join(code, 'Contents', 'MacOS', 'Nutflix');
  const bytes = readFileSync(exe);
  // A byte of the program itself, past the headers and far from the signature.
  const at = 0x4000;
  bytes[at] = (bytes[at] ?? 0) ^ 0xff;
  chmodSync(exe, 0o755);
  writeFileSync(exe, bytes);
  await expectRefusal(
    'a signed bundle with its code changed',
    () => compareSigned(t, app, code),
    /signing changed more than the signature of Contents\/MacOS\/Nutflix/,
  );

  const extra = copy('extra');
  run('codesign', ['--force', '--deep', '--sign', '-', extra]);
  writeFileSync(join(extra, 'Contents', 'Resources', 'added.js'), 'added');
  await expectRefusal(
    'a signed bundle with a file added',
    () => compareSigned(t, app, extra),
    /signing added Contents\/Resources\/added\.js/,
  );

  const out = join(work, 'release');
  releaseFolder(out, t, app, digest, await artifactBytes(app));
  const r = await recordSigned(out, t.name, signed);
  const row = readRelease(out).targets.find((x) => x.target === t.name);
  if (r.before !== digest || r.after !== after || row?.ci.digest !== digest)
    throw new Error('record-signed did not keep the CI digest and record the signed one');
  if (row.signed?.digest !== after) throw new Error('record-signed did not record the signature');
  return [
    `an ad-hoc re-signed bundle (CI ${digest.slice(0, 12)}…, signed ${after.slice(0, 12)}…) is accepted`,
    'a changed script, changed code and an added file are each refused',
    'record-signed keeps CI’s digest and records the signed one',
  ];
}

/** While the source has no link, a package from `shell-*` is the production build. */
function assertProductionRootIfNoLink(app: string): void {
  if (releaseRoot().upgrade === null) assertProductionRoot(app, packageFacts(app));
}

async function proveMsix(t: ReleaseTarget, artifact: string, work: string): Promise<string[]> {
  const unsigned = join(work, 'unsigned', t.file);
  mkdirSync(dirname(unsigned), { recursive: true });
  copyFileSync(findUnder(artifact, inputName(t)), unsigned);
  const digest = await digestOf(unsigned);
  assertProductionRootIfNoLink(unsigned);
  await expectRefusal(
    'an unsigned package offered as signed',
    () => compareSigned(t, unsigned, unsigned),
    /has no signature/,
  );
  const signedDir = join(work, 'signed');
  mkdirSync(signedDir);
  const signed = join(signedDir, t.file);
  copyFileSync(unsigned, signed);
  const cert = newTestCert(SCRIPTS_DIR, join(work, 'test-cert.cer'));
  try {
    say(signMsix(signed, cert));
  } finally {
    removeTestCert(SCRIPTS_DIR, cert.thumbprint);
  }
  const after = await digestOf(signed);
  if (after === digest) throw new Error('signing changed nothing: this proves nothing');
  await compareSigned(t, unsigned, signed);
  const out = join(work, 'release');
  releaseFolder(out, t, unsigned, digest, await artifactBytes(unsigned));
  const r = await recordSigned(out, t.name, signed);
  const row = readRelease(out).targets.find((x) => x.target === t.name);
  if (r.before !== digest || r.after !== after || row?.ci.digest !== digest)
    throw new Error('record-signed did not keep the CI digest and record the signed one');
  return [
    `an .msix signed with a certificate made for this job (CI ${digest.slice(0, 12)}…, signed ${after.slice(0, 12)}…) is accepted`,
    'an unsigned package offered as signed is refused',
    'record-signed keeps CI’s digest and records the signed one',
  ];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const name = arg(argv, '--target');
  const t = RELEASE_TARGETS.find((x) => x.name === name);
  if (t === undefined || t.platform === 'linux') throw new Error(`${name} is not a signed target`);
  if (`${process.platform}-${process.arch}` !== t.name)
    throw new Error(`this runner is not ${t.name}`);
  const work = resolve(arg(argv, '--work'));
  mkdirSync(work, { recursive: true });
  const artifact = resolve(arg(argv, '--artifact'));
  const lines =
    t.platform === 'darwin'
      ? await proveBundle(t, artifact, work)
      : await proveMsix(t, artifact, work);
  const md = [`### signing proof (${t.name}): PASS`, '', ...lines.map((l) => `- ${l}`), ''].join(
    '\n',
  );
  say(md);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') appendFileSync(summary, md);
}

main().then(
  () => {
    process.exit(0);
  },
  (e: unknown) => {
    process.stderr.write(
      `signing proof: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    process.exit(1);
  },
);
