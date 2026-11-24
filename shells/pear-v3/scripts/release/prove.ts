/**
 * The release pipeline's proof in CI (`release-proof` job). On a Linux runner, with nothing but
 * loopback and throwaway keys:
 *
 *   tripwire   drop and count every packet to the public DHT bootstrap and the public relays
 *   provenance the real GitHub API: a green push to main passes, this run and a wrong commit do not,
 *              and each of this run's artifacts is fetched by id and held to GitHub's digest
 *   five       the five real packages of the `shell` job: unpacked, checked, assembled, `pear
 *              build`, digest, and a notice naming all five, read back by the app's `notice.ts`
 *   chain      build, stage, provision, multisig and install, then the real update gate
 *              (`chain.ts`)
 *   the day    the path for the day the source gets a real link: the build CI would launch instead,
 *              which must pass the unchanged guard and start with its updater off
 *   tripwire   read again: zero packets
 *
 *   node scripts/release/prove.ts --target linux-x64 --token-file <0600 file> --work <dir>
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import { APP, STAGED } from '../../packaging/identity.ts';
import { PKG_DIR, REPO_ROOT } from '../../packaging/paths.ts';
import {
  assertLaunchRoot,
  assertNoUpgradeLink,
  bakedRootIn,
  releaseRoot,
} from '../../packaging/update-root.ts';
import { readNotice } from '../../src/update/notice.ts';
import { parseTrustRoot } from '../../src/update/root.ts';
import { Pear, fetchPear, isolatedEnv } from '../pear-ci/pear.ts';
import { CANARY_IP, PUBLIC_BOOTSTRAP_IPS, type TargetName } from '../pear-ci/pins.ts';
import { failureMessage, succeeded } from '../pear-ci/records.ts';
import {
  applySinkhole,
  assertSinkholed,
  publicHosts,
  resolvePublicIps,
} from '../pear-ci/sinkhole.ts';
import {
  barrier,
  createTripwire,
  proveTripwire,
  publicBootstrapHits,
} from '../pear-ci/tripwire.ts';
import type { ProofRow } from '../pear-ci/update-proof.ts';
import { launch, readyProblems } from '../smoke.ts';
import {
  artifactName,
  assemblePackages,
  buildAppFlags,
  digestRelease,
  readRelease,
} from './assemble.ts';
import { proveReleaseChain, toTemplate } from './chain.ts';
import { expectRefusal } from './guards.ts';
import { planBuild } from './commands.ts';
import { digestOf } from './digest.ts';
import { releaseNoticeDraft } from './draft.ts';
import { assertProductionRoot, type PackageFacts } from './inspect.ts';
import { prepareLaunchOut } from './launch-subject.ts';
import {
  RELEASE_REPO,
  assertArtifactBytes,
  assertCommit,
  downloadArtifact,
  makeGhApi,
  parseRunId,
  runArtifacts,
  verifyMainRun,
} from './provenance.ts';
import type { CiEntry } from './signer.ts';
import { RELEASE_TARGETS, deploymentEntry } from './targets.ts';

const SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pear-ci');
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

class Handled extends Error {}

/**
 * The job's token reaches `gh` alone. The workflow writes it to a file only this user can read, in
 * an earlier step, so it is in no environment here: not this step's shell's, nor `xvfb-run`'s, nor
 * this process's. It is read and the file deleted before anything starts, and any token a runner
 * put in the environment is dropped too, so no Pear sidecar, build, `script` or launched app has
 * one, and none can write one into the uploaded logs.
 */
const TOKEN_NAMES = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;
const tokenFile = ((): string | undefined => {
  const i = process.argv.indexOf('--token-file');
  return i === -1 ? undefined : process.argv[i + 1];
})();
const githubToken = ((): string | undefined => {
  if (tokenFile === undefined) return undefined;
  const t = readFileSync(tokenFile, 'utf8').trim();
  rmSync(tokenFile, { force: true });
  return t;
})();
for (const k of TOKEN_NAMES) Reflect.deleteProperty(process.env, k);
const github = makeGhApi(githubToken);

function arg(argv: readonly string[], name: string): string {
  const i = argv.indexOf(name);
  const v = i === -1 ? undefined : argv[i + 1];
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
}

export async function prove(o: { target: TargetName; work: string }): Promise<number> {
  const own = RELEASE_TARGETS.find((t) => t.name === o.target);
  if (own === undefined) throw new Error(`${o.target} is not a target`);
  if (own.platform !== 'linux') throw new Error('the release proof runs on Linux');
  if (`${process.platform}-${process.arch}` !== o.target)
    throw new Error(`this runner is ${process.platform}-${process.arch}, not ${o.target}`);
  const work = resolve(o.work);
  const logs = join(work, 'logs');
  mkdirSync(logs, { recursive: true });

  const rows: ProofRow[] = [];
  const failures: string[] = [];
  const row = (step: string, result: string): void => {
    rows.push({ step, result });
    say(`proof ${step}: ${result}`);
  };
  const phase = async <T>(title: string, fn: () => Promise<T> | T): Promise<T> => {
    say(`::group::${title}`);
    const t0 = Date.now();
    try {
      const v = await fn();
      say('::endgroup::');
      say(`ok    ${title} (${String(Math.round((Date.now() - t0) / 100) / 10)} s)`);
      return v;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      say(`FAIL  ${title}: ${msg}`);
      say('::endgroup::');
      failures.push(`${title}: ${msg.split('\n')[0] ?? msg}`);
      throw new Handled(msg);
    }
  };

  const relayHosts = publicHosts(REPO_ROOT);
  const relayIps = (await resolvePublicIps(relayHosts)).filter(
    (ip) => !PUBLIC_BOOTSTRAP_IPS.includes(ip) && ip !== CANARY_IP,
  );
  const tw = createTripwire(process.platform, work, SCRIPTS_DIR, [
    ...PUBLIC_BOOTSTRAP_IPS,
    ...relayIps,
    CANARY_IP,
  ]);
  const tripwire = { armed: false };

  try {
    await phase(`tripwire (${tw.kind}): arm it, and prove it counts`, async () => {
      tw.arm();
      tripwire.armed = true;
      say(`counted: ${JSON.stringify(await proveTripwire(tw, 15_000))}`);
    });
    await phase('sinkhole: the public relay names point at loopback', async () => {
      applySinkhole(process.platform, relayHosts);
      await assertSinkholed(relayHosts);
      say(`${String(relayHosts.length)} hosts, ${String(relayIps.length)} real addresses watched`);
    });
    const fetched = await phase('Pear CLI: the pinned release asset', () =>
      fetchPear(o.target, join(work, 'tools')),
    );

    // ---- where a release comes from, against the real GitHub API ------------------------------
    const runId = parseRunId(process.env['GITHUB_RUN_ID']);
    const builtCommit = assertCommit(process.env['GITHUB_SHA'], 'GITHUB_SHA');
    const artifacts = join(work, 'artifacts');
    await phase('provenance: the real GitHub API, read-only', async () => {
      const refusedHere = () => verifyMainRun(github, runId, builtCommit);
      await expectRefusal(
        'this run, as a release build',
        refusedHere,
        /triggered by "pull_request"|has not completed/,
      );
      const listing = (await github.get(
        `repos/${RELEASE_REPO}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=1`,
      )) as { workflow_runs?: { id?: unknown; head_sha?: unknown }[] };
      const main = listing.workflow_runs?.[0];
      if (typeof main?.id !== 'number' || typeof main.head_sha !== 'string')
        throw new Error('GitHub lists no successful run on main');
      await verifyMainRun(github, main.id, main.head_sha);
      await expectRefusal(
        'a run on main, for another commit',
        () => verifyMainRun(github, main.id as number, 'f'.repeat(40)),
        /it built /,
      );
      row(
        'provenance',
        `a green push to main passes; this ${String(process.env['GITHUB_EVENT_NAME'])} run and a wrong commit are refused`,
      );
      // The token is in no child's environment (checked by name; nothing is printed), and its file
      // is gone.
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          `process.exit(${JSON.stringify(TOKEN_NAMES)}.some((k) => k in process.env) ? 3 : 0)`,
        ],
        { stdio: 'ignore' },
      );
      if (child.status !== 0) throw new Error('a child process still has a GitHub token');
      if (tokenFile === undefined || existsSync(tokenFile))
        throw new Error('the token did not come from its file, or the file is still there');
      row(
        'token',
        'only `gh` gets the GitHub token: it came from a 0600 file, now deleted, and a child process started here has none',
      );

      // This run's five packages, each checked against GitHub's digest of its artifact.
      const self = (await github.get(`repos/${RELEASE_REPO}/actions/runs/${String(runId)}`)) as {
        head_sha?: string;
      };
      if (typeof self.head_sha !== 'string') throw new Error('GitHub names no head for this run');
      const names = RELEASE_TARGETS.map((t) => artifactName('shell', t));
      const listed = await runArtifacts(github, runId, self.head_sha, names);
      mkdirSync(artifacts, { recursive: true });
      for (const a of listed.values())
        await downloadArtifact(github, a, join(artifacts, `${a.name}.zip`));
      const [one, two] = [...listed.values()];
      if (one === undefined || two === undefined) throw new Error('no artifacts');
      await expectRefusal(
        'one target’s artifact in another’s place',
        () => assertArtifactBytes(join(artifacts, `${one.name}.zip`), two),
        /is not .* of this run/,
      );
      row('artifacts', 'five downloaded by id, each equal to GitHub’s digest; a swap is refused');
    });

    // ---- the five real packages ----------------------------------------------------------------
    const out = join(work, 'release');
    // These are `shell-*`: the production root until the source has a link, then the launch build.
    const assertRoot =
      releaseRoot().upgrade === null
        ? assertProductionRoot
        : (_path: string, facts: PackageFacts): void => {
            assertLaunchRoot(facts.root);
          };
    const fivePackages = await phase(
      'five packages: check, assemble, pear build, digest, notice',
      async () => {
        const assembled = await assemblePackages(artifacts, 'shell', out, runId, {
          commit: builtCommit,
          assertRoot,
        });
        row(
          'five: check',
          `five packages, version ${assembled.version}, all built from ${builtCommit}, each root and CPU read from its unpacked bytes`,
        );
        // `pear build` opens no sidecar and no swarm; the bootstrap is a dead loopback address.
        const builder = new Pear({
          bin: fetched.bin,
          home: join(work, 'home-build'),
          bootstrap: '127.0.0.1:49737',
          logDir: join(logs, 'build'),
        });
        const release = readRelease(out);
        const plan = planBuild({
          packageJson: join(out, 'package.json'),
          target: join(out, 'deployment'),
          appFlags: buildAppFlags(release),
        });
        const built = await builder.run('build', plan.args, 1200);
        if (built.code !== 0 || built.timedOut || !succeeded(built.records))
          throw new Error(`pear build: ${failureMessage(built.records) ?? built.out.slice(-400)}`);
        const digests = await digestRelease(out);
        for (const t of RELEASE_TARGETS) {
          const got = digests.artifacts.find((a) => a.name === t.noticeName);
          const direct = await digestOf(join(out, 'deployment', ...deploymentEntry(t).split('/')));
          if (got?.sha256 !== direct) throw new Error(`${t.name}: the digest is not the entry's`);
          say(`${t.noticeName}: ${direct} (${String(got.bytes)} bytes)`);
        }
        row(
          'five: digest',
          'five digests from the deployment, each equal to the record of its package',
        );

        // A key and link that exist only here: this notice is never served to anything.
        const sk = generateSecretKey();
        const key = 'y'.repeat(52);
        const draft = releaseNoticeDraft({
          version: digests.version,
          verlink: `pear://0.7.${key}`,
          commit: digests.commit,
          createdAt: Math.floor(Date.now() / 1000),
          artifacts: digests.artifacts,
          expectedLink: `pear://${key}`,
        });
        const root = parseTrustRoot({
          v: 1,
          channel: 'test',
          pubkey: getPublicKey(sk),
          relays: ['ws://127.0.0.1:7777'],
          upgrade: `pear://${key}`,
          dht: ['127.0.0.1:49737'],
          delayMs: 0,
        });
        const read = readNotice(
          finalizeEvent(toTemplate(draft), sk),
          root,
          Math.floor(Date.now() / 1000),
        );
        if (read.notice?.artifacts.size !== 5)
          throw new Error(
            `the app's notice.ts refused the five-target draft: ${String(read.refused)}`,
          );
        row(
          'five: notice',
          'an unsigned draft naming all five, signed by a test key, read by notice.ts',
        );
        const entries: CiEntry[] = release.targets.map((row_) => {
          const target = RELEASE_TARGETS.find((t) => t.name === row_.target);
          if (target === undefined) throw new Error(`no target ${row_.target}`);
          return { target, app: row_.app, digest: row_.ci.digest };
        });
        return { deployment: join(out, 'deployment'), version: digests.version, entries };
      },
    );

    // ---- the chain -------------------------------------------------------------------------------
    const baseVersion = (
      JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as { version: string }
    ).version;
    const chain = await proveReleaseChain(
      {
        target: o.target,
        platform: own.platform,
        arch: own.arch,
        file: own.file,
        work,
        logs,
        pearBin: fetched.bin,
        scriptsDir: SCRIPTS_DIR,
        cert: undefined,
        baseVersion,
        phase,
        say,
      },
      fivePackages,
    );
    rows.push(...chain.rows);

    // ---- the day the source gets a real link ------------------------------------------------------
    await phase('the day of the real link: what CI launches instead', async () => {
      const launchOut = prepareLaunchOut(
        { platform: own.platform, arch: own.arch, out: join(PKG_DIR, 'out'), rehearse: true },
        releaseRoot(),
        (args) => {
          const r = spawnSync(process.execPath, [...args], {
            cwd: PKG_DIR,
            stdio: ['ignore', 'inherit', 'inherit'],
          });
          if (r.status !== 0) throw new Error(`the launch build: exit ${String(r.status)}`);
        },
      );
      const app = join(
        resolve(launchOut),
        `${APP.productName}-${own.platform}-${own.arch}`,
        'resources',
        'app',
      );
      const worker = readFileSync(join(app, ...STAGED.updateWorker.split('/')), 'utf8');
      // The unchanged guard, on the bytes CI would launch.
      assertNoUpgradeLink(worker);
      const guard = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'no-updater.ts'), app], {
        encoding: 'utf8',
      });
      if (guard.status !== 0 || !guard.stdout.includes('this build has no upgrade link'))
        throw new Error(`no-updater.ts did not pass it: ${guard.stderr}`);
      const baked = bakedRootIn(worker);
      if (baked.channel !== 'launch' || baked.pubkey === releaseRoot().pubkey)
        throw new Error('the launch build does not hold a throwaway root');
      // And it can never pass for a production build.
      const verify = spawnSync(
        process.execPath,
        [join(PKG_DIR, 'scripts', 'release', 'cli.ts'), 'verify-root', '--app', app],
        { encoding: 'utf8' },
      );
      // Exit 1 and the production-root rule's own words: a crash is not a refusal.
      if (
        verify.status !== 1 ||
        !verify.stderr.includes('a release build needs the release channel')
      )
        throw new Error(
          `verify-root did not refuse the throwaway root for its channel: exit ${String(verify.status)}, ${verify.stderr.slice(-300)}`,
        );
      const image = join(resolve(launchOut), 'make', 'appimage', own.arch, own.file);
      if (!existsSync(image)) throw new Error(`no ${image}`);
      const home = join(work, 'home-day');
      mkdirSync(home, { recursive: true });
      const r = await launch(image, [], 'ready', 180, { env: isolatedEnv(home) });
      if (!r.ok) throw new Error(`${r.reason}\n${r.tail.slice(-25).join('\n')}`);
      const bad = r.ready === null ? ['no ready line'] : readyProblems(r.ready, 'on', 'off');
      if (bad.length > 0) throw new Error(`the ready line: ${bad.join('; ')}`);
      row(
        'the day',
        'a build with a throwaway root and no link passes no-updater.ts, is refused by verify-root, launches with its sandbox on and says updates: off',
      );
    });

    await phase('read the tripwire: nothing reached a public address', async () => {
      const hits = await barrier(tw, 15_000);
      const n = publicBootstrapHits(hits);
      say(`tripwire: ${JSON.stringify(hits)}`);
      if (n !== 0) throw new Error(`${String(n)} packets went to a public address`);
      row(
        'tripwire',
        `0 packets to the public DHT bootstrap or relays (${String(relayIps.length)} relay addresses watched)`,
      );
    });
  } catch (e) {
    if (!(e instanceof Handled)) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      say(`FAIL  ${msg}`);
      failures.push(msg.split('\n')[0] ?? msg);
    }
  } finally {
    if (tripwire.armed) {
      try {
        say(`tripwire at the end: ${JSON.stringify(tw.read())}`);
        tw.disarm();
      } catch (e) {
        say(`tripwire: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const md = [
      `### release proof (${o.target}): ${failures.length === 0 ? 'PASS' : 'FAIL'}`,
      '',
      '| step | result |',
      '| --- | --- |',
      ...rows.map((x) => `| ${x.step} | ${x.result.replaceAll('|', '/')} |`),
      '',
      ...failures.map((f) => `- FAILED: ${f}`),
      '',
    ].join('\n');
    writeFileSync(join(work, 'result.json'), `${JSON.stringify({ rows, failures }, null, 2)}\n`);
    const summary = process.env['GITHUB_STEP_SUMMARY'];
    if (summary !== undefined && summary !== '') appendFileSync(summary, md);
    say(md);
  }
  return failures.length === 0 ? 0 : 1;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(PKG_DIR, 'scripts', 'release', 'prove.ts')
) {
  const argv = process.argv.slice(2);
  prove({
    target: arg(argv, '--target') as TargetName,
    work: resolve(arg(argv, '--work')),
  }).then(
    (code) => {
      process.exit(code);
    },
    (e: unknown) => {
      process.stderr.write(
        `release proof: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
      );
      process.exit(1);
    },
  );
}
