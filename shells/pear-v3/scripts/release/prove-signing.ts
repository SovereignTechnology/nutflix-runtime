/**
 * The signing step of the runbook, on the OS that does it, with a certificate that is NOT a real one:
 * an ad-hoc signature on macOS and a certificate made for this job on Windows. It proves that the
 * tool takes a package signed that way, refuses anything else changed, and holds a signature to what
 * `signing-policy.ts` pins: on macOS the production policy itself (ad hoc while no Team ID is
 * pinned), with the runbook's entitlements; on Windows the production policy refuses the package,
 * and a policy pinning this job's certificate, built here and nowhere else, takes it. It proves
 * nothing about Apple's or a certificate authority's tools, notarization, or stapling.
 *
 *   node scripts/release/prove-signing.ts --target <darwin-arm64|win32-x64> --artifact <dir> --work <dir>
 */
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
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
import { MAC_ENTITLEMENTS, productionSigningPolicy, type SigningPolicy } from './signing-policy.ts';
import { RELEASE_TARGETS, type ReleaseTarget } from './targets.ts';
import { extractZip } from './zip.ts';

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pear-ci');
const ENTITLEMENTS = resolve(SCRIPTS_DIR, '..', '..', 'packaging', 'entitlements.mac.plist');
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

/** Every file in a bundle, relative to it, deepest first. */
function filesDeepestFirst(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...filesDeepestFirst(join(dir, e.name), r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort((a, b) => b.split('/').length - a.split('/').length);
}

/**
 * Signs `app` the way the runbook does, ad hoc: everything with the hardened runtime, then each
 * binary `signing-policy.ts` entitles with `entitlements.mac.plist`, inside out, then the app.
 * `last` is the last step's options, so a negative can make one bad signature.
 */
function signLikeTheRunbook(app: string, last: readonly string[] = ['--options', 'runtime']): void {
  const sign = (opts: readonly string[], path: string): void => {
    run('codesign', ['--force', ...opts, '--sign', '-', path]);
  };
  sign(['--deep', '--options', 'runtime'], app);
  const entitled = filesDeepestFirst(app).filter(
    (f) => f !== 'Contents/MacOS/Nutflix' && MAC_ENTITLEMENTS.some((r) => r.path.test(f)),
  );
  // A helper app is signed as a bundle (its executable with it); a bare binary on its own.
  for (const f of entitled) {
    const helper = /^(Contents\/Frameworks\/[^/]+\.app)\/Contents\/MacOS\/[^/]+$/.exec(f)?.[1];
    sign(['--options', 'runtime', '--entitlements', ENTITLEMENTS], join(app, helper ?? f));
  }
  sign([...last, '--entitlements', ENTITLEMENTS], app);
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
  const production = productionSigningPolicy();
  if (production.appleTeamId !== null)
    throw new Error('a Team ID is pinned: this proof signs ad hoc, and needs a real identity now');

  const copy = (name: string): string => {
    const dir = join(work, name);
    mkdirSync(dir);
    const to = join(dir, t.file);
    run('ditto', [app, to]);
    return to;
  };
  const signed = copy('signed');
  signLikeTheRunbook(signed);
  run('codesign', ['--verify', '--deep', '--strict', signed]);
  const after = await digestOf(signed);
  if (after === digest) throw new Error('re-signing changed nothing: this proves nothing');
  await compareSigned(t, app, signed, production);

  // What a signature may say: each of these is CI's code, re-signed, and refused.
  const extra = join(work, 'get-task-allow.plist');
  writeFileSync(
    extra,
    readFileSync(ENTITLEMENTS, 'utf8').replace(
      '</dict>',
      '  <key>com.apple.security.get-task-allow</key>\n  <true/>\n</dict>',
    ),
  );
  const entitled = copy('entitled');
  signLikeTheRunbook(entitled);
  run('codesign', [
    '--force',
    '--options',
    'runtime',
    '--entitlements',
    extra,
    '--sign',
    '-',
    entitled,
  ]);
  await expectRefusal(
    'a bundle re-signed with an entitlement added',
    () => compareSigned(t, app, entitled, production),
    /Contents\/MacOS\/Nutflix has the entitlements .*get-task-allow=true/,
  );
  const soft = copy('soft');
  signLikeTheRunbook(soft, []);
  await expectRefusal(
    'a bundle re-signed without the hardened runtime',
    () => compareSigned(t, app, soft, production),
    /Contents\/MacOS\/Nutflix is not signed with the hardened runtime/,
  );
  const team: SigningPolicy = { label: 'proof', appleTeamId: 'ABCDE12345', windowsSigner: null };
  await expectRefusal(
    'a bundle not signed by the pinned Team ID',
    () => compareSigned(t, app, signed, team),
    /is signed by no team, not Team ID ABCDE12345/,
  );

  const script = copy('script');
  signLikeTheRunbook(script);
  appendFileSync(join(script, 'Contents', 'Resources', 'app', 'main', 'main.cjs'), '\n// changed');
  await expectRefusal(
    'a signed bundle with a script changed',
    () => compareSigned(t, app, script, production),
    /signing changed more than the signature of Contents\/Resources\/app\/main\/main\.cjs/,
  );

  const code = copy('code');
  signLikeTheRunbook(code);
  const exe = join(code, 'Contents', 'MacOS', 'Nutflix');
  const bytes = readFileSync(exe);
  // A byte of the program itself, past the headers and far from the signature.
  const at = 0x4000;
  bytes[at] = (bytes[at] ?? 0) ^ 0xff;
  chmodSync(exe, 0o755);
  writeFileSync(exe, bytes);
  await expectRefusal(
    'a signed bundle with its code changed',
    () => compareSigned(t, app, code, production),
    /signing changed more than the signature of Contents\/MacOS\/Nutflix/,
  );

  const added = copy('added');
  signLikeTheRunbook(added);
  writeFileSync(join(added, 'Contents', 'Resources', 'added.js'), 'added');
  await expectRefusal(
    'a signed bundle with a file added',
    () => compareSigned(t, app, added, production),
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
    `a bundle signed ad hoc as the runbook signs it (CI ${digest.slice(0, 12)}…, signed ${after.slice(0, 12)}…) passes the production policy`,
    'refused: an entitlement added, the hardened runtime removed, and (with a Team ID pinned) a signature that is not that team’s',
    'refused: a changed script, changed code and an added file',
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
  const cerPath = join(work, 'test-cert.cer');
  const cert = newTestCert(SCRIPTS_DIR, cerPath);
  try {
    say(signMsix(signed, cert));
  } finally {
    removeTestCert(SCRIPTS_DIR, cert.thumbprint);
  }
  const after = await digestOf(signed);
  if (after === digest) throw new Error('signing changed nothing: this proves nothing');

  // The production policy pins no certificate yet, so it takes no signed package.
  await expectRefusal(
    'a signed package while no certificate is pinned',
    () => compareSigned(t, unsigned, signed),
    /no Windows signing certificate is pinned \(production\)/,
  );
  // A policy pinning this job's certificate, built here: the release tool never builds one.
  const x = new X509Certificate(readFileSync(cerPath));
  const pinned = { sha256: x.fingerprint256, subject: x.subject, issuer: x.issuer };
  const proof: SigningPolicy = { label: 'proof', appleTeamId: null, windowsSigner: pinned };
  const otherSha = `${pinned.sha256.startsWith('00') ? '11' : '00'}${pinned.sha256.slice(2)}`;
  const other: SigningPolicy = { ...proof, windowsSigner: { ...pinned, sha256: otherSha } };
  await expectRefusal(
    'a package signed by another certificate than the one pinned',
    () => compareSigned(t, unsigned, signed, other),
    /not the pinned certificate/,
  );
  await compareSigned(t, unsigned, signed, proof);
  const out = join(work, 'release');
  releaseFolder(out, t, unsigned, digest, await artifactBytes(unsigned));
  await expectRefusal(
    'record-signed, with the production policy',
    () => recordSigned(out, t.name, signed),
    /no Windows signing certificate is pinned/,
  );
  const r = await recordSigned(out, t.name, signed, proof);
  const row = readRelease(out).targets.find((x) => x.target === t.name);
  if (r.before !== digest || r.after !== after || row?.ci.digest !== digest)
    throw new Error('record-signed did not keep the CI digest and record the signed one');
  return [
    `an .msix signed with a certificate made for this job (CI ${digest.slice(0, 12)}…, signed ${after.slice(0, 12)}…): its content types differ only by the signature's entries, and any catalog names only its binaries`,
    'refused: the same package under the production policy (no certificate pinned), and under a policy pinning another certificate',
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
