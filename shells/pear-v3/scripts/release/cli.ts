/**
 * The release tool (`docs/release.md` is the runbook; it says which step is whose).
 *
 *   node shells/pear-v3/scripts/release/cli.ts <command> [options]
 *
 *   check        --artifacts <dir>    the five packages: present, one version, the production root
 *   assemble     --artifacts <dir> --out <dir>    the same, then the folder `pear build` takes
 *   build        --out <dir>          `pear build`: one deployment from the five
 *   digest       --out <dir>          what a notice names for each, read from the deployment
 *   notice-draft --out <dir> --verlink <pear://f.l.key> [--commit <sha>] [--created-at <unix>]
 *                                     an UNSIGNED kind-30071 event, as JSON
 *   verify-root  --app <resources/app dir>    the baked root is the production root (never launches)
 *   bundle-digest --app <Nutflix.app> --write <file>    on the Mac that zips it: the bundle's digest
 *
 *   stage        --link <link> --out <dir>
 *   provision    --source <verlink> --target <link> --production <verlink>
 *   multisig request --config <pear.json> --verlink <verlink>
 *   multisig verify  --config <pear.json> --source <link> --request <r> --response <s>...
 *   multisig commit  --config <pear.json> --source <link> --production <link> --request <r> --response <s>...
 *   seed         --link <link>
 *
 * The second group acts on a real link on the public DHT. By default each only PRINTS the exact
 * command. `--execute` runs it, after the link is typed back on a terminal, and is refused on CI.
 *
 * This tool never reads, stores or prints a signing key: `pear multisig sign` is the owner's own
 * step, in the owner's terminal, and only its public response comes back here.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { STAGED } from '../../packaging/identity.ts';
import { PKG_DIR } from '../../packaging/paths.ts';
import { assertReleaseRoot, bakedRootIn } from '../../packaging/update-root.ts';
import { sha256File } from '../pear-ci/deployment.ts';
import { Pear, fetchPear } from '../pear-ci/pear.ts';
import { PEAR_PINS, PEAR_VERSION, type TargetName } from '../pear-ci/pins.ts';
import { failureMessage, succeeded } from '../pear-ci/records.ts';
import {
  assemble,
  buildAppFlags,
  checkPackages,
  digestRelease,
  readDigests,
  readRelease,
} from './assemble.ts';
import { digestOf } from './digest.ts';
import { releaseNoticeDraft } from './draft.ts';
import {
  planBuild,
  planCommit,
  planMultisigLink,
  planProvision,
  planRequest,
  planSeed,
  planStage,
  planVerify,
  renderCommand,
  type PlannedCommand,
} from './commands.ts';
import {
  ReleaseRefusal,
  askOnTerminal,
  assertLink,
  confirmLink,
  refuse,
  refuseOnCi,
  type AskLine,
} from './guards.ts';
import { RELEASE_TARGETS } from './targets.ts';

/** Everything that reaches outside the process, so that the tests can stand in for it. */
export interface Io {
  readonly env: NodeJS.ProcessEnv;
  readonly ask: AskLine;
  print(line: string): void;
  /** Where the pinned `pear` is, or will be: printed in a dry run. */
  pearPath(): string;
  /** Fetches the pinned CLI, checked against its sha256, and returns its path. */
  ensurePear(): Promise<string>;
  /** Runs `pear <args>` on the real network with the caller's terminal. */
  runPublic(bin: string, args: readonly string[]): Promise<number>;
  /** `pear multisig link`: the link this config derives. */
  multisigLink(bin: string, args: readonly string[]): Promise<string>;
  /** `pear build`, local and offline. */
  runBuild(bin: string, out: string, args: readonly string[]): Promise<void>;
  nowS(): number;
}

interface Parsed {
  readonly options: ReadonlyMap<string, string>;
  readonly responses: readonly string[];
  readonly execute: boolean;
}

const VALUE_OPTIONS = new Set([
  '--artifacts',
  '--write',
  '--out',
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
]);

export function parseOptions(argv: readonly string[]): Parsed {
  const options = new Map<string, string>();
  const responses: string[] = [];
  let execute = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--execute') {
      execute = true;
      continue;
    }
    const v = argv[i + 1];
    if (!VALUE_OPTIONS.has(a) || v === undefined)
      return refuse(`unknown or incomplete option ${a}`);
    i++;
    if (a === '--response') responses.push(v);
    else if (options.has(a)) return refuse(`${a} is given twice`);
    else options.set(a, v);
  }
  return { options, responses, execute };
}

const need = (p: Parsed, name: string): string =>
  p.options.get(name) ?? refuse(`${name} is required`);

const needPath = (p: Parsed, name: string): string => resolve(need(p, name));

/** A dry run prints; `--execute` checks every gate, then runs. */
async function act(io: Io, p: Parsed, plan: PlannedCommand): Promise<number> {
  if (!p.execute) {
    io.print(`DRY RUN (${plan.step}): nothing was run. The command is:`);
    io.print(`  ${renderCommand(io.pearPath(), plan.args)}`);
    if (plan.confirm !== null)
      io.print(`To run it: add --execute, and type this link back: ${plan.confirm}`);
    return 0;
  }
  if (plan.publicDht) refuseOnCi(io.env, plan.step);
  if (plan.confirm !== null) await confirmLink(plan.confirm, io.ask);
  const bin = await io.ensurePear();
  io.print(`$ ${renderCommand(bin, plan.args)}`);
  const code = await io.runPublic(bin, plan.args);
  if (code !== 0) io.print(`${plan.step}: pear exited ${String(code)}`);
  return code;
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
    const production = assertLink(need(p, '--production'), '--production');
    const plan = planCommit({
      config,
      source: need(p, '--source'),
      production,
      request: need(p, '--request'),
      responses: p.responses,
    });
    if (p.execute) {
      // The link the signers' keys derive must be the one typed: before anything is written.
      refuseOnCi(io.env, plan.step);
      const derived = await io.multisigLink(
        await io.ensurePear(),
        planMultisigLink({ config }).args,
      );
      if (derived !== production)
        refuse(`this config derives ${derived}, not ${production}: nothing was committed`);
    }
    return act(io, p, plan);
  }
  return refuse('multisig takes request, verify or commit');
}

/** How far ahead of this machine's clock a notice's date may be. */
const MAX_CLOCK_SKEW_S = 60;

/** Runs one command of the tool; returns the process's exit code. */
export async function runCli(argv: readonly string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  switch (command ?? '') {
    case 'check': {
      const p = parseOptions(rest);
      const r = checkPackages(needPath(p, '--artifacts'));
      for (const x of r.packages) io.print(`ok  ${x.target.name}  ${r.version}  ${x.path}`);
      io.print(`five targets, version ${r.version}, each with the production root`);
      return 0;
    }
    case 'assemble': {
      const p = parseOptions(rest);
      const r = await assemble(needPath(p, '--artifacts'), needPath(p, '--out'));
      io.print(`assembled ${String(r.targets.length)} targets, version ${r.version}`);
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
      const out = needPath(p, '--out');
      const d = readDigests(out);
      const at = p.options.get('--created-at');
      const file = join(out, 'release-event.unsigned.json');
      if (existsSync(file)) refuse(`${file} exists: move it away first`);
      const createdAt = at === undefined ? io.nowS() : Number(at);
      // A date ahead of the clock raises every install's replay floor, or is refused outright.
      if (createdAt > io.nowS() + MAX_CLOCK_SKEW_S) refuse('--created-at is in the future');
      const event = releaseNoticeDraft({
        version: d.version,
        verlink: need(p, '--verlink'),
        commit: p.options.get('--commit'),
        createdAt,
        artifacts: d.artifacts,
      });
      writeFileSync(file, `${JSON.stringify(event, null, 2)}\n`, { flag: 'wx' });
      io.print(`${file} (UNSIGNED: the owner signs and publishes it)`);
      return 0;
    }
    case 'bundle-digest': {
      // On the Mac that zips the bundle: what `assemble` compares the unpacked tree with.
      const p = parseOptions(rest);
      const digest = await digestOf(needPath(p, '--app'));
      writeFileSync(needPath(p, '--write'), `${digest}\n`);
      io.print(digest);
      return 0;
    }
    case 'verify-root': {
      const p = parseOptions(rest);
      const root = bakedRootIn(
        readFileSync(join(needPath(p, '--app'), ...STAGED.updateWorker.split('/')), 'utf8'),
      );
      assertReleaseRoot(root);
      io.print(
        `the baked root is the production root: key ${root.pubkey}, ${String(root.relays.length)} relays, upgrade link ${root.upgrade ?? 'none'}`,
      );
      return 0;
    }
    case 'stage': {
      const p = parseOptions(rest);
      const deployment = join(needPath(p, '--out'), 'deployment');
      if (!existsSync(deployment)) refuse(`${deployment} is missing: run build first`);
      return act(io, p, planStage({ link: need(p, '--link'), deployment }));
    }
    case 'provision': {
      const p = parseOptions(rest);
      return act(
        io,
        p,
        planProvision({
          source: need(p, '--source'),
          target: need(p, '--target'),
          production: need(p, '--production'),
        }),
      );
    }
    case 'multisig':
      return multisig(io, rest[0], rest.slice(1));
    case 'seed': {
      const p = parseOptions(rest);
      return act(io, p, planSeed({ link: need(p, '--link') }));
    }
    default:
      return refuse(
        'usage: cli.ts <check|assemble|build|digest|notice-draft|verify-root|bundle-digest|stage|provision|multisig|seed> [options]',
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

export const realIo: Io = {
  env: process.env,
  ask: askOnTerminal,
  print: (line) => {
    process.stdout.write(`${line}\n`);
  },
  pearPath: () => join(toolsDir(), 'pear', PEAR_PINS[hostTarget()].binary),
  ensurePear: () => ensurePinnedPear(hostTarget(), toolsDir()),
  runPublic: (bin, args) =>
    new Promise((res) => {
      const child = spawn(bin, [...args], { stdio: 'inherit' });
      child.once('error', () => {
        res(1);
      });
      child.once('exit', (code) => {
        res(code ?? 1);
      });
    }),
  multisigLink: (bin, args) =>
    new Promise((res, rej) => {
      const child = spawn(bin, [...args], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.once('error', rej);
      child.once('exit', () => {
        const m = /"link":"(pear:\/\/[a-z0-9]{52})"/.exec(out);
        if (m?.[1] === undefined) rej(new ReleaseRefusal('pear multisig link printed no link'));
        else res(m[1]);
      });
    }),
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
