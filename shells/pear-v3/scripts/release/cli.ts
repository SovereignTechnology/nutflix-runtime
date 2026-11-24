/**
 * The release tool (`docs/release.md` is the runbook; it says which step is whose).
 *
 *   node shells/pear-v3/scripts/release/cli.ts <command> [options]
 *
 * From a CI run on `main` to a deployment, all local:
 *   download     --run <id> --commit <sha> --artifacts <dir>   the five `release-*` artifacts
 *   check        --run <id> --commit <sha> --artifacts <dir>   one verified run, one version, one
 *                                     commit, the production root, the right CPU
 *   assemble     --run <id> --commit <sha> --artifacts <dir> --out <dir>
 *   record-signed --out <dir> --target <target> --signed <Nutflix.app|Nutflix.msix>
 *                                     a package the owner signed: CI's, plus signatures, only
 *   build        --out <dir>          `pear build`: one deployment from the five
 *   digest       --out <dir>          what a notice names for each, read from the deployment
 *   notice-draft --out <dir> [--created-at <unix>]
 *                                     an UNSIGNED kind-30071 event for the version `multisig commit`
 *                                     recorded; its commit is the packages'
 *   verify-root  --app <resources/app dir>    the baked root and main's switch (never launches)
 *   bundle-digest --app <Nutflix.app> --write <file>    CI only, on the Mac that zips the bundle
 *
 * On a real link, on the public DHT:
 *   stage        --link <link> --out <dir>
 *   provision    --source <verlink> --target <link> --production <verlink> --out <dir>
 *   multisig request --config <pear.json> --verlink <verlink>
 *   verify-request --run <id> --commit <sha> --config <pear.json> --verlink <verlink>
 *                --request <r> --work <empty dir> [--signed-target <target>]...
 *                [--without-apple-check]
 *                                     EACH SIGNER, before `pear multisig sign`
 *   multisig verify  --config <pear.json> --source <link> --request <r> --response <s>...
 *   multisig commit  --config <pear.json> --source <link> --production <link> --out <dir>
 *                --request <r> --response <s>...
 *   seed         --link <link>
 *
 * The second group only PRINTS the exact command by default. `--execute` runs it, after the link is
 * typed back on a terminal, and is refused on CI and while the source has no production link. These
 * gates stop mistakes. They are not a boundary against hostile code on the same machine.
 *
 * This tool never reads, stores or prints a signing key: `pear multisig sign` is each signer's own
 * step, in their own terminal, and only its public response comes back here.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { STAGED } from '../../packaging/identity.ts';
import { PKG_DIR } from '../../packaging/paths.ts';
import {
  assertMainMatchesRoot,
  assertReleaseRoot,
  bakedRootIn,
  releaseRoot,
} from '../../packaging/update-root.ts';
import { sha256File } from '../pear-ci/deployment.ts';
import { Pear, fetchPear, isolatedEnv } from '../pear-ci/pear.ts';
import { PEAR_PINS, PEAR_VERSION, type TargetName } from '../pear-ci/pins.ts';
import { failureMessage, field, lastRecord, parseRecords, succeeded } from '../pear-ci/records.ts';
import {
  RELEASE_PREFIX,
  assemble,
  buildAppFlags,
  checkRelease,
  digestRelease,
  downloadRelease,
  productionRules,
  readDigests,
  readRelease,
  unpackAll,
} from './assemble.ts';
import {
  committed,
  planBuild,
  planCommit,
  planDump,
  planInfo,
  planMultisigLink,
  planProvision,
  planRequest,
  planSeed,
  planStage,
  planVerify,
  planVerifyRequest,
  renderCommand,
  type PlannedCommand,
} from './commands.ts';
import { digestOf } from './digest.ts';
import { releaseNoticeDraft } from './draft.ts';
import {
  ReleaseRefusal,
  askOnTerminal,
  assertLink,
  assertVerlink,
  confirmLink,
  linkKeyOf,
  onCi,
  refuse,
  refuseOnCi,
  type AskLine,
} from './guards.ts';
import { assertCommit, ghApi, parseRunId, type GitHubApi } from './provenance.ts';
import { assertReleasable, assertSignable } from './release-gate.ts';
import { checkRequestInOneHome, compareDrive, type PearInOneHome } from './signer.ts';
import { productionSigningPolicy, type SigningPolicy } from './signing-policy.ts';
import { recordSigned } from './signing.ts';
import { RELEASE_TARGETS, deploymentEntry } from './targets.ts';

export interface PearOutcome {
  readonly code: number;
  /** What it printed, up to the last megabyte. */
  readonly out: string;
}

/** Everything that reaches outside the process, so that the tests can stand in for it. */
export interface Io {
  readonly env: NodeJS.ProcessEnv;
  readonly ask: AskLine;
  readonly api: GitHubApi;
  /** The link this source's builds follow: `RELEASE_UPGRADE_LINK`. */
  productionLink(): string | null;
  print(line: string): void;
  /** Where the pinned `pear` is, or will be: printed in a dry run. */
  pearPath(): string;
  /** Fetches the pinned CLI, checked against its sha256, and returns its path. */
  ensurePear(): Promise<string>;
  /** Runs `pear <args>` on the real network; its output also goes to the terminal. */
  runPublic(bin: string, args: readonly string[]): Promise<PearOutcome>;
  /** The same, as a user whose home is `home`: a Pear sidecar and local cores of its own. */
  runIsolated(bin: string, home: string, args: readonly string[]): Promise<PearOutcome>;
  /**
   * `codesign --verify --strict --deep` of a bundle: Apple's own check, on macOS. `null` where
   * there is no `codesign` (any other OS).
   */
  codesignVerify(bundle: string): { code: number; out: string } | null;
  /** `pear build`, local and offline. */
  runBuild(bin: string, out: string, args: readonly string[]): Promise<void>;
  /** What signatures a release may carry: `productionSigningPolicy()`, always, outside tests. */
  signingPolicy(): SigningPolicy;
  nowS(): number;
}

interface Parsed {
  readonly options: ReadonlyMap<string, string>;
  readonly responses: readonly string[];
  readonly signedTargets: readonly string[];
  readonly execute: boolean;
  /** `verify-request`: go on without Apple's own check, off a Mac, with a Team ID pinned. */
  readonly withoutAppleCheck: boolean;
}

const VALUE_OPTIONS = new Set([
  '--artifacts',
  '--write',
  '--out',
  '--run',
  '--verlink',
  '--commit',
  '--created-at',
  '--app',
  '--link',
  '--source',
  '--target',
  '--production',
  '--config',
  '--request',
  '--response',
  '--signed',
  '--signed-target',
  '--work',
]);

export function parseOptions(argv: readonly string[]): Parsed {
  const options = new Map<string, string>();
  const responses: string[] = [];
  const signedTargets: string[] = [];
  let execute = false;
  let withoutAppleCheck = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--execute') {
      execute = true;
      continue;
    }
    if (a === '--without-apple-check') {
      withoutAppleCheck = true;
      continue;
    }
    const v = argv[i + 1];
    if (!VALUE_OPTIONS.has(a) || v === undefined)
      return refuse(`unknown or incomplete option ${a}`);
    i++;
    if (a === '--response') responses.push(v);
    else if (a === '--signed-target') signedTargets.push(v);
    else if (options.has(a)) return refuse(`${a} is given twice`);
    else options.set(a, v);
  }
  return { options, responses, signedTargets, execute, withoutAppleCheck };
}

const need = (p: Parsed, name: string): string =>
  p.options.get(name) ?? refuse(`${name} is required`);

const needPath = (p: Parsed, name: string): string => resolve(need(p, name));

const runAndCommit = (p: Parsed): { run: number; commit: string } => ({
  run: parseRunId(p.options.get('--run')),
  commit: assertCommit(p.options.get('--commit'), '--commit'),
});

/** The production link, or a refusal: a release from a source with none strands every install. */
function requireProductionLink(io: Io): string {
  const link = io.productionLink();
  if (link === null)
    return refuse(
      'this source has no production link (RELEASE_UPGRADE_LINK is null): its builds start no updater, so nothing released from it could ever be updated',
    );
  return link;
}

interface ActHooks {
  /** Checks that need no network, before anyone is asked anything. */
  readonly before?: (production: string) => void;
  /** After the link is typed back, before the step runs. */
  readonly confirmed?: (bin: string, production: string) => Promise<void>;
  /** After the step ran and exited 0. */
  readonly done?: (out: string, production: string) => void;
}

/** A dry run prints; `--execute` checks every gate, then runs. */
async function act(io: Io, p: Parsed, plan: PlannedCommand, hooks: ActHooks = {}): Promise<number> {
  if (!p.execute) {
    io.print(`DRY RUN (${plan.step}): nothing was run. The command is:`);
    io.print(`  ${renderCommand(io.pearPath(), plan.args)}`);
    if (plan.confirm !== null)
      io.print(`To run it: add --execute, and type this link back: ${plan.confirm}`);
    return 0;
  }
  if (plan.publicDht) refuseOnCi(io.env, plan.step);
  const production = requireProductionLink(io);
  hooks.before?.(production);
  if (plan.confirm !== null) await confirmLink(plan.confirm, io.ask);
  const bin = await io.ensurePear();
  await hooks.confirmed?.(bin, production);
  io.print(`$ ${renderCommand(bin, plan.args)}`);
  const { code, out } = await io.runPublic(bin, plan.args);
  if (code !== 0) {
    io.print(`${plan.step}: pear exited ${String(code)}`);
    return code;
  }
  hooks.done?.(out, production);
  return 0;
}

/** What `pear multisig link` derives from this config; refused if Pear did not answer. */
async function derivedLink(io: Io, bin: string, config: string): Promise<string> {
  const { code, out } = await io.runPublic(bin, planMultisigLink({ config }).args);
  const link = field(lastRecord(parseRecords(out), 'final'), 'link');
  if (code !== 0 || link === undefined)
    return refuse(`pear multisig link exited ${String(code)} and gave no link: nothing was done`);
  return link;
}

async function multisig(io: Io, sub: string | undefined, rest: readonly string[]): Promise<number> {
  const p = parseOptions(rest);
  const config = needPath(p, '--config');
  if (!existsSync(config)) refuse(`${config} does not exist`);
  if (sub === 'request') return act(io, p, planRequest({ config, verlink: need(p, '--verlink') }));
  if (sub === 'verify')
    return act(
      io,
      p,
      planVerify({
        config,
        source: need(p, '--source'),
        request: need(p, '--request'),
        responses: p.responses,
      }),
    );
  if (sub === 'commit') {
    const given = assertLink(need(p, '--production'), '--production');
    const plan = planCommit({
      config,
      source: need(p, '--source'),
      production: given,
      request: need(p, '--request'),
      responses: p.responses,
    });
    // What `notice-draft` will name: the version this commit makes, and no other.
    const record = needPath(p, '--out');
    return act(io, p, plan, {
      before: (production) => {
        if (given !== production)
          refuse(`--production is ${given}, but this source's production link is ${production}`);
        if (!existsSync(join(record, PROVISIONED)))
          refuse(`${join(record, PROVISIONED)} is missing: provision with --out ${record} first`);
        if (existsSync(join(record, COMMITTED)))
          refuse(`${join(record, COMMITTED)} exists: this release was committed already`);
        // macOS ships signed by the owner, and only with a Team ID unless ad hoc was chosen;
        // Windows ships signed by the owner, and only with a certificate pinned.
        assertReleasable(
          readRelease(record),
          join(record, 'release.json'),
          io.signingPolicy(),
          'Nothing was committed.',
        );
      },
      // The link the signers' keys derive must be the one typed: before anything is written.
      confirmed: async (bin) => {
        const derived = await derivedLink(io, bin, config);
        if (derived !== given)
          refuse(`this config derives ${derived}, not ${given}: nothing was committed`);
      },
      done: (out, production) => {
        const made = committed(lastRecord(parseRecords(out), 'final')?.data, linkKeyOf(production));
        writeFileSync(
          join(record, COMMITTED),
          `${JSON.stringify({ production, verlink: made.verlink, lengths: made.lengths }, null, 2)}\n`,
          { flag: 'wx' },
        );
        io.print(`production verlink: ${made.verlink} (recorded in ${join(record, COMMITTED)})`);
      },
    });
  }
  return refuse('multisig takes request, verify or commit');
}

/** Each signer, before `pear multisig sign`: see `signer.ts`. */
async function verifyRequest(io: Io, rest: readonly string[]): Promise<number> {
  const p = parseOptions(rest);
  const { run, commit } = runAndCommit(p);
  const config = needPath(p, '--config');
  const verlink = assertVerlink(need(p, '--verlink'), '--verlink');
  const request = need(p, '--request');
  const work = needPath(p, '--work');
  const signed = new Set<TargetName>();
  for (const name of p.signedTargets) {
    const t = RELEASE_TARGETS.find((x) => x.name === name);
    if (t === undefined || t.platform === 'linux')
      return refuse(`--signed-target ${name}: only a macOS or Windows target is signed`);
    signed.add(t.name);
  }
  // A release that may not ship is not signed: before anything is fetched.
  assertSignable(signed, io.signingPolicy(), 'Do not sign.');
  const source = `pear://${linkKeyOf(verlink)}`;
  const dump = planDump({ verlink, dir: join(work, 'drive') });
  const check = planVerifyRequest({ config, source, request });
  const info = planInfo({ link: source });
  if (!p.execute) {
    io.print('DRY RUN (verify-request): nothing was run. It would, in a Pear home of its own:');
    io.print(`  check run ${String(run)} on GitHub, and fetch what CI built at ${commit}`);
    for (const args of [planMultisigLink({ config }).args, info.args, check.args, dump.args])
      io.print(`  ${renderCommand(io.pearPath(), args)}`);
    io.print(`  pear provision --dry-run ${verlink} …: that version's db and blobs cores`);
    io.print("  then the request and the fork again, and hash the five entries against CI's");
    io.print('  and, on a Mac, codesign --verify --strict --deep each signed macOS bundle');
    io.print(`To run it: add --execute, and type this link back: ${source}`);
    return 0;
  }
  refuseOnCi(io.env, 'verify-request');
  const production = requireProductionLink(io);
  if (!existsSync(config)) return refuse(`${config} does not exist`);
  if (existsSync(work) && readdirSync(work).length > 0)
    return refuse(`${work} is not empty: use a fresh folder`);
  await confirmLink(source, io.ask);
  mkdirSync(work, { recursive: true });

  // 1. What CI built, from GitHub, whatever the coordinator said.
  const artifacts = join(work, 'artifacts');
  await downloadRelease(io.api, run, commit, artifacts);
  const built = await unpackAll(
    artifacts,
    RELEASE_PREFIX,
    join(work, 'ci'),
    productionRules(commit),
  );

  // 2. Every Pear answer from one home of the check's own: one set of local cores.
  const bin = await io.ensurePear();
  const home = join(work, 'pear-home');
  const pear: PearInOneHome = async (args, what) => {
    const { code, out } = await io.runIsolated(bin, home, args);
    if (code !== 0) return refuse(`${what} failed (exit ${String(code)}): do not sign`);
    return parseRecords(out);
  };
  try {
    await checkRequestInOneHome(pear, {
      config,
      verlink,
      request,
      production,
      dumpDir: join(work, 'drive'),
    });
  } finally {
    await io.runIsolated(bin, home, ['sidecar', 'shutdown']).catch(() => undefined);
  }

  // 3. The bytes.
  const rows = await compareDrive(
    join(work, 'drive'),
    built.version,
    built.packages.map((x) => ({ target: x.target, app: x.app, digest: x.digest })),
    signed,
  );
  for (const r of rows)
    io.print(
      `ok  ${r.target}  ${r.how === 'exact' ? "CI's bytes" : "CI's package, signed"}  ${r.digest}`,
    );
  // 4. Apple's own check of a signed bundle, where there is one to ask. With a Team ID pinned, a
  //    signature's chain to Apple is checked only there, so off a Mac this refuses, unless the
  //    signer says another signer in the quorum ran it on a Mac.
  const teamPinned = io.signingPolicy().appleTeamId !== null;
  const unchecked: string[] = [];
  for (const t of RELEASE_TARGETS.filter((x) => x.platform === 'darwin' && signed.has(x.name))) {
    const bundle = join(work, 'drive', ...deploymentEntry(t).split('/'));
    const r = io.codesignVerify(bundle);
    if (r === null) {
      io.print(
        `NOT CHECKED BY APPLE  ${t.name}: there is no codesign on this machine. Its page hashes, special slots and what its signature says were checked here; the resource seal's contents, nested code and any identity's chain to Apple were not. At least one signer must run this on a Mac.`,
      );
      unchecked.push(t.name);
      continue;
    }
    if (r.code !== 0)
      return refuse(
        `codesign refuses ${t.name}'s signature (exit ${String(r.code)}): do not sign. ${r.out.slice(0, 400)}`,
      );
    io.print(`ok  ${t.name}  codesign --verify --strict --deep`);
  }
  const warning = appleCheck({ teamPinned, unchecked, withoutAppleCheck: p.withoutAppleCheck });
  io.print(
    `This request releases exactly what CI built at ${commit}, version ${built.version}, to ${production}.`,
  );
  if (warning !== null) io.print(warning);
  for (const l of signInstruction(request)) io.print(l);
  return 0;
}

/** The refusal off a Mac with a Team ID pinned, and the warning when the signer goes on anyway. */
export const appleCheckRefusal = (targets: readonly string[]): string =>
  `Apple's own check of ${targets.join(', ')} was not run: there is no codesign on this machine, and with a Team ID pinned a forged Apple signature would pass every other check here. Run verify-request on a Mac. If another signer in the quorum ran it on a Mac and it passed, you may pass --without-apple-check. Do not sign this request until one of those is true.`;

/**
 * Whether a signer may go on without Apple's own check: refuses off a Mac with a Team ID pinned,
 * unless the signer passed `--without-apple-check`, and then returns the warning to print above the
 * sign line. With no Team ID pinned there is no CMS to check, and nothing changes.
 */
export function appleCheck(o: {
  readonly teamPinned: boolean;
  readonly unchecked: readonly string[];
  readonly withoutAppleCheck: boolean;
}): string | null {
  if (!o.teamPinned || o.unchecked.length === 0) return null;
  if (!o.withoutAppleCheck) return refuse(appleCheckRefusal(o.unchecked));
  return appleCheckWarning(o.unchecked);
}

export const appleCheckWarning = (targets: readonly string[]): string =>
  `WARNING: Apple's own check of ${targets.join(', ')} was not run on this machine (--without-apple-check). Sign only if another signer in the quorum ran verify-request on a Mac and it passed.`;

/**
 * What a signer runs next: the exact request checked, with a short hash of it to compare with what
 * the coordinator sent, so that the string signed is the string checked.
 */
export function signInstruction(request: string): string[] {
  const digest = createHash('sha256').update(request).digest('hex').slice(0, 16);
  return [
    `The request checked has sha256 ${digest}…. Sign exactly it, and nothing else:`,
    `  pear multisig sign ${request} <your key name>`,
  ];
}

/** What `provision --out` and `multisig commit --out` record, for `notice-draft`. */
const PROVISIONED = 'provisioned.json';
const COMMITTED = 'committed.json';

/**
 * The version a notice may name: the one `multisig commit` recorded, on the production link, newer
 * than the version `provision` said it supersedes. A stale version would only be held by every
 * install, after raising its replay floor.
 */
export function committedVersion(out: string, production: string): string {
  const read = (name: string): Record<string, unknown> => {
    const f = join(out, name);
    if (!existsSync(f)) return refuse(`${f} is missing: provision and commit with --out ${out}`);
    return JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
  };
  const made = read(COMMITTED);
  const old = read(PROVISIONED);
  const verlink = assertVerlink(made['verlink'] as string | undefined, `${COMMITTED}: verlink`);
  const superseded = assertVerlink(old['supersedes'] as string | undefined, PROVISIONED);
  if (made['production'] !== production || linkKeyOf(verlink) !== linkKeyOf(production))
    refuse(`${COMMITTED} is for another link than ${production}`);
  if (linkKeyOf(superseded) !== linkKeyOf(production))
    refuse(`${PROVISIONED} supersedes a version of another link`);
  const length = (v: string): number => Number(v.slice('pear://'.length).split('.')[1]);
  if (length(verlink) <= length(superseded))
    refuse(`${verlink} is not newer than ${superseded}, the version it supersedes`);
  return verlink;
}

/** How far ahead of this machine's clock a notice's date may be. */
const MAX_CLOCK_SKEW_S = 60;

/** Runs one command of the tool; returns the process's exit code. */
export async function runCli(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  switch (command ?? '') {
    case 'download': {
      const p = parseOptions(rest);
      const { run, commit } = runAndCommit(p);
      await downloadRelease(io.api, run, commit, needPath(p, '--artifacts'));
      io.print(`five artifacts of run ${String(run)}, each equal to GitHub's digest`);
      return 0;
    }
    case 'check': {
      const p = parseOptions(rest);
      const { run, commit } = runAndCommit(p);
      const r = await checkRelease(io.api, run, commit, needPath(p, '--artifacts'));
      for (const x of r.packages) io.print(`ok  ${x.target.name}  ${r.version}  ${x.digest}`);
      io.print(
        `five targets from run ${String(run)} on main at ${commit}, version ${r.version}, each with the production root`,
      );
      return 0;
    }
    case 'assemble': {
      const p = parseOptions(rest);
      const { run, commit } = runAndCommit(p);
      const r = await assemble(
        io.api,
        run,
        commit,
        needPath(p, '--artifacts'),
        needPath(p, '--out'),
      );
      io.print(`assembled ${String(r.targets.length)} targets, version ${r.version}, ${r.commit}`);
      return 0;
    }
    case 'record-signed': {
      const p = parseOptions(rest);
      const r = await recordSigned(
        needPath(p, '--out'),
        need(p, '--target'),
        needPath(p, '--signed'),
      );
      io.print(`${r.target}: CI built ${r.before}`);
      io.print(`${r.target}: signed    ${r.after} (${String(r.bytes)} bytes)`);
      io.print('Only signatures differ. The root, version, commit and CPU were read again.');
      return 0;
    }
    case 'build': {
      const p = parseOptions(rest);
      const out = needPath(p, '--out');
      const release = readRelease(out);
      const target = join(out, 'deployment');
      if (existsSync(target)) refuse(`${target} exists: use a fresh --out`);
      const plan = planBuild({
        packageJson: join(out, 'package.json'),
        target,
        appFlags: buildAppFlags(release),
      });
      await io.runBuild(await io.ensurePear(), out, plan.args);
      io.print(`deployment at ${target}`);
      return 0;
    }
    case 'digest': {
      const p = parseOptions(rest);
      const d = await digestRelease(needPath(p, '--out'));
      for (const a of d.artifacts) io.print(`${a.sha256}  ${a.name}  (${String(a.bytes)} bytes)`);
      return 0;
    }
    case 'notice-draft': {
      const p = parseOptions(rest);
      if (p.options.has('--commit'))
        refuse('--commit is not taken here: the commit is the one the packages carry');
      const production = requireProductionLink(io);
      const out = needPath(p, '--out');
      assertReleasable(
        readRelease(out),
        join(out, 'release.json'),
        io.signingPolicy(),
        'No notice was drafted.',
      );
      const d = readDigests(out);
      const at = p.options.get('--created-at');
      const file = join(out, 'release-event.unsigned.json');
      if (existsSync(file)) refuse(`${file} exists: move it away first`);
      const createdAt = at === undefined ? io.nowS() : Number(at);
      // A date ahead of the clock raises every install's replay floor, or is refused outright.
      if (createdAt > io.nowS() + MAX_CLOCK_SKEW_S) refuse('--created-at is in the future');
      if (p.options.has('--verlink'))
        refuse('--verlink is not taken here: the version is the one `multisig commit` recorded');
      const verlink = committedVersion(out, production);
      const event = releaseNoticeDraft({
        version: d.version,
        verlink,
        commit: d.commit,
        createdAt,
        artifacts: d.artifacts,
        expectedLink: production,
      });
      writeFileSync(file, `${JSON.stringify(event, null, 2)}\n`, { flag: 'wx' });
      io.print(`${file} (UNSIGNED: the owner signs and publishes it)`);
      return 0;
    }
    case 'bundle-digest': {
      // CI's reference for the bundle it built. Never to be remade from a signed bundle.
      if (!onCi(io.env)) refuse('bundle-digest is the CI job’s own step');
      const p = parseOptions(rest);
      const digest = await digestOf(needPath(p, '--app'));
      writeFileSync(needPath(p, '--write'), `${digest}\n`);
      io.print(digest);
      return 0;
    }
    case 'verify-root': {
      const p = parseOptions(rest);
      const app = needPath(p, '--app');
      const root = bakedRootIn(readFileSync(join(app, ...STAGED.updateWorker.split('/')), 'utf8'));
      assertReleaseRoot(root);
      assertMainMatchesRoot(readFileSync(join(app, ...STAGED.main.split('/')), 'utf8'), root);
      io.print(
        `the baked root is the production root and main's switch agrees: key ${root.pubkey}, ${String(root.relays.length)} relays, upgrade link ${root.upgrade ?? 'none'}`,
      );
      return 0;
    }
    case 'stage': {
      const p = parseOptions(rest);
      const deployment = join(needPath(p, '--out'), 'deployment');
      if (!existsSync(deployment)) refuse(`${deployment} is missing: run build first`);
      return act(
        io,
        p,
        planStage({ link: need(p, '--link'), deployment, production: io.productionLink() }),
      );
    }
    case 'provision': {
      const p = parseOptions(rest);
      const plan = planProvision({
        source: need(p, '--source'),
        target: need(p, '--target'),
        production: need(p, '--production'),
      });
      // What this release supersedes: `notice-draft` refuses anything not newer.
      const record = needPath(p, '--out');
      return act(io, p, plan, {
        before: (production) => {
          if (linkKeyOf(need(p, '--production')) !== linkKeyOf(production))
            refuse(`--production is not a version of this source's production link ${production}`);
          if (!existsSync(join(record, 'release.json')))
            refuse(`${record} holds no release: --out is the folder of this release`);
          if (existsSync(join(record, COMMITTED)))
            refuse(`${join(record, COMMITTED)} exists: this release was committed already`);
        },
        done: () => {
          writeFileSync(
            join(record, PROVISIONED),
            `${JSON.stringify({ supersedes: need(p, '--production') }, null, 2)}\n`,
          );
        },
      });
    }
    case 'multisig':
      return multisig(io, rest[0], rest.slice(1));
    case 'verify-request':
      return verifyRequest(io, rest);
    case 'seed': {
      const p = parseOptions(rest);
      return act(io, p, planSeed({ link: need(p, '--link') }));
    }
    default:
      return refuse(
        'usage: cli.ts <download|check|assemble|record-signed|build|digest|notice-draft|verify-root|bundle-digest|stage|provision|multisig|verify-request|seed> [options]',
      );
  }
}

// ---- the real edges --------------------------------------------------------------------------

function hostTarget(): TargetName {
  const t = `${process.platform}-${process.arch}`;
  const found = RELEASE_TARGETS.find((x) => x.name === t);
  return found === undefined ? refuse(`${t} is not a release target`) : found.name;
}

const toolsDir = (): string => join(homedir(), '.cache', 'nutflix-release', `pear-${PEAR_VERSION}`);

/**
 * The pinned CLI. One already here is reused only if its zip still has the pinned sha256 and the
 * binary is byte for byte the one in that zip: a sidecar from an earlier step is running that very
 * file, so it is not unpacked over without need.
 */
export async function ensurePinnedPear(target: TargetName, dir: string): Promise<string> {
  const pin = PEAR_PINS[target];
  const zip = join(dir, pin.asset);
  const bin = join(dir, 'pear', pin.binary);
  if (existsSync(zip) && existsSync(bin) && (await sha256File(zip)) === pin.sha256) {
    const inZip = spawnSync('unzip', ['-p', zip, pin.binary], { maxBuffer: 512 * 1024 * 1024 });
    if (
      inZip.status === 0 &&
      createHash('sha256').update(inZip.stdout).digest('hex') === (await sha256File(bin))
    )
      return bin;
  }
  return (await fetchPear(target, dir)).bin;
}

const KEEP_OUTPUT = 1024 * 1024;

/** Runs `pear`, its output on this terminal and its last megabyte kept. */
function runTee(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<PearOutcome> {
  return new Promise((res) => {
    const child = spawn(bin, [...args], { stdio: ['inherit', 'pipe', 'inherit'], env });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      process.stdout.write(d);
      out = (out + d.toString('utf8')).slice(-KEEP_OUTPUT);
    });
    child.once('error', () => {
      res({ code: 1, out });
    });
    child.once('close', (code) => {
      res({ code: code ?? 1, out });
    });
  });
}

export const realIo: Io = {
  env: process.env,
  ask: askOnTerminal,
  api: ghApi,
  productionLink: () => releaseRoot().upgrade,
  print: (line) => {
    process.stdout.write(`${line}\n`);
  },
  pearPath: () => join(toolsDir(), 'pear', PEAR_PINS[hostTarget()].binary),
  ensurePear: () => ensurePinnedPear(hostTarget(), toolsDir()),
  runPublic: (bin, args) => runTee(bin, args, process.env),
  runIsolated: (bin, home, args) => {
    mkdirSync(home, { recursive: true });
    return runTee(bin, args, isolatedEnv(home));
  },
  codesignVerify: (bundle) => {
    if (process.platform !== 'darwin') return null;
    const r = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', bundle], {
      encoding: 'utf8',
    });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  },
  signingPolicy: productionSigningPolicy,
  runBuild: async (bin, out, args) => {
    // `pear build` starts no sidecar and joins no DHT. Its own home, and a loopback bootstrap, so
    // that nothing here can touch the owner's Pear state even if that ever changes.
    const pear = new Pear({
      bin,
      home: join(out, '.pear-build-home'),
      bootstrap: '127.0.0.1:49737',
      logDir: join(out, 'logs'),
    });
    const r = await pear.run('build', args, 1800);
    if (r.code !== 0 || r.timedOut || !succeeded(r.records))
      refuse(`pear build failed: ${failureMessage(r.records) ?? r.out.slice(-400)}`);
  },
  nowS: () => Math.floor(Date.now() / 1000),
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(PKG_DIR, 'scripts', 'release', 'cli.ts')
) {
  runCli(process.argv.slice(2), realIo).then(
    (code) => {
      process.exit(code);
    },
    (e: unknown) => {
      process.stderr.write(`release: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(e instanceof ReleaseRefusal ? 2 : 1);
    },
  );
}
