/**
 * The whole release, on a private DHT with throwaway keys, ending in a really installed app:
 *
 *   signers    three `pear multisig` keys, each in a home of its own, quorum 2
 *   link       the production link those keys derive: it is baked into both test builds
 *   release A  build, stage, provision onto a pre-production drive, seed, request, sign, verify, commit
 *   installed  `pear install` of the production link
 *   release B  the same again, on top of A
 *   notice     this tool's digest and draft, signed by a test root, served by the loopback relay
 *   gate       the installed app holds B (no notice, a wrong hash, a wrong signer), then applies it
 *
 * Every command is the one `commands.ts` plans for the real release; only the DHT differs, and
 * `Pear` refuses any bootstrap off 127.0.0.1. The job's tripwire counts packets to the public
 * bootstrap and relays while this runs, and must read zero.
 *
 * It runs on Linux: `pear multisig keys get` and `sign` read their password from a terminal, and
 * `script(1)` is how a job gives them one.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import { PKG_DIR } from '../../packaging/paths.ts';
import { STAGED } from '../../packaging/identity.ts';
import { bakedRootIn } from '../../packaging/update-root.ts';
import { readNotice } from '../../src/update/notice.ts';
import { parseTrustRoot, type TrustRoot } from '../../src/update/root.ts';
import { deploymentPackageJson } from '../pear-ci/deployment.ts';
import { NoticeRelay } from '../pear-ci/notice-relay.ts';
import { Pear, isolatedEnv, killTree, type RunResult, type Started } from '../pear-ci/pear.ts';
import {
  assertLoopbackBootstrap,
  failureMessage,
  field,
  lastRecord,
  parseRecords,
  succeeded,
} from '../pear-ci/records.ts';
import {
  installedIs,
  patchVersion,
  proveGateMatrix,
  type NoticeEventTemplate,
  type ProofContext,
  type ProofRow,
} from '../pear-ci/update-proof.ts';
import { digestTargets, type Digest } from './assemble.ts';
import {
  planBuild,
  planCommit,
  planMultisigLink,
  planProvision,
  planRequest,
  planSeed,
  planStage,
  planVerify,
  type PlannedCommand,
} from './commands.ts';
import { artifactBytes, digestOf } from './digest.ts';
import { noticeDraft, type UnsignedNotice } from './draft.ts';
import { linkKeyOf } from './guards.ts';
import { RELEASE_TARGETS, type ReleaseTarget } from './targets.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The namespace of the throwaway multisig: the production link depends on it. */
export const PROOF_NAMESPACE = 'nutflix-runtime/release-proof';
export const PROOF_QUORUM = 2;

const Z32_KEY = /(?:^|\s)([ybndrfg8ejkmcpqxot1uwisza345h769]{52})(?:\s|$)/m;
// eslint-disable-next-line no-control-regex -- the colour codes Pear prints to a terminal
const ANSI = /\x1b\[[0-9;]*m/g;

/** The public key `pear multisig keys get` printed, from the human form of its output. */
export function publicKeyIn(output: string): string | undefined {
  return Z32_KEY.exec(output.replace(ANSI, ''))?.[1];
}

/** A shell word for `script -c`. */
const shellWord = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * Runs `pear <args>` on a real terminal, answering each password prompt. The password is a random
 * throwaway that exists only in this process.
 */
export function withTerminal(
  pear: Pear,
  args: readonly string[],
  password: string,
  prompts: number,
  timeoutMs = 120_000,
): Promise<{ code: number | null; out: string }> {
  const command = [pear.bin, '--dht-bootstrap', pear.bootstrap, ...args].map(shellWord).join(' ');
  return new Promise((resolvePromise) => {
    const child = spawn('script', ['-qfec', command, '/dev/null'], {
      env: pear.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let answered = 0;
    const onData = (d: Buffer): void => {
      out += d.toString('utf8');
      const asked = (out.match(/assword: /g) ?? []).length;
      while (answered < Math.min(asked, prompts)) {
        answered++;
        child.stdin.write(`${password}\r`);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.on('error', () => undefined);
    const timer = setTimeout(() => {
      killTree(child.pid);
    }, timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      resolvePromise({ code: null, out: `${out}\n${e.message}` });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out });
    });
  });
}

interface Signer {
  readonly name: string;
  readonly pear: Pear;
  readonly password: string;
  readonly publicKey: string;
}

export interface ChainReport {
  readonly rows: ProofRow[];
  /** The production link of the throwaway quorum. */
  readonly link: string;
}

/** What the seed process last said about how much of the drive it holds. */
export function seedProgress(
  log: string,
): { driveLength: number; driveSynced: number; blobsLength: number; blobsSynced: number } | null {
  const stats = lastRecord(parseRecords(log), 'stats')?.data;
  if (stats === undefined) return null;
  const n = (k: string): number => (typeof stats[k] === 'number' ? stats[k] : -1);
  return {
    driveLength: n('driveLength'),
    driveSynced: n('driveSynced'),
    blobsLength: n('blobsLength'),
    blobsSynced: n('blobsSynced'),
  };
}

export interface CoreLengths {
  readonly db: number;
  readonly blobs: number;
}

/** A seed holds the whole drive at these lengths. */
export function holdsAll(p: ReturnType<typeof seedProgress>, want: CoreLengths): boolean {
  return (
    p !== null &&
    p.driveLength >= want.db &&
    p.driveSynced >= want.db &&
    p.blobsLength >= want.blobs &&
    p.blobsSynced >= want.blobs
  );
}

/** The two lengths in a `pear provision` final record's `target`. */
export function provisionedLengths(data: Readonly<Record<string, unknown>> | undefined): {
  verlink: string;
  lengths: CoreLengths;
} {
  const t = data?.['target'] as
    { verlink?: unknown; core?: { length?: unknown }; blobs?: { length?: unknown } } | undefined;
  const verlink = t?.verlink;
  const db = t?.core?.length;
  const blobs = t?.blobs?.length;
  if (typeof verlink !== 'string' || typeof db !== 'number' || typeof blobs !== 'number')
    throw new Error('pear provision reported no target');
  return { verlink, lengths: { db, blobs } };
}

/** The production verlink and lengths in a `pear multisig commit` final record. */
export function committed(
  data: Readonly<Record<string, unknown>> | undefined,
  key: string,
): { verlink: string; lengths: CoreLengths } {
  const r = data?.['result'] as
    | {
        db?: { destCore?: { length?: unknown; key?: unknown } };
        blobs?: { destCore?: { length?: unknown } };
      }
    | undefined;
  const db = r?.db?.destCore?.length;
  const blobs = r?.blobs?.destCore?.length;
  if (typeof db !== 'number' || typeof blobs !== 'number')
    throw new Error('pear multisig commit reported no lengths');
  if (r?.db?.destCore?.key !== key)
    throw new Error('pear multisig commit wrote to another key than the production link');
  return { verlink: `pear://0.${String(db)}.${key}`, lengths: { db, blobs } };
}

/** The event as the signer sees it: nothing of the draft but what is signed. */
export function toTemplate(d: UnsignedNotice): NoticeEventTemplate {
  return {
    kind: d.kind,
    created_at: d.created_at,
    tags: d.tags.map((t) => [...t]),
    content: d.content,
  };
}

export async function proveReleaseChain(c: ProofContext): Promise<ChainReport> {
  if (c.platform !== 'linux') throw new Error('the release chain proof runs on Linux');
  const rows: ProofRow[] = [];
  const row = (step: string, result: string): void => {
    rows.push({ step, result });
    c.say(`chain ${step}: ${result}`);
  };
  const root = join(c.work, 'chain');
  mkdirSync(root, { recursive: true });
  const logRoot = join(c.logs, 'chain');
  const target: ReleaseTarget | undefined = RELEASE_TARGETS.find((t) => t.name === c.target);
  if (target === undefined) throw new Error(`${c.target} is not a target`);

  let dht: ChildProcess | undefined;
  let relay: NoticeRelay | undefined;
  const seeds: Started[] = [];
  const pears: Pear[] = [];

  const ok = (what: string, r: RunResult): RunResult => {
    c.say(`$ pear ${what}: exit ${String(r.code)}, ${String(r.ms)} ms, ${r.logFile}`);
    if (r.code !== 0 || r.timedOut || !succeeded(r.records))
      throw new Error(
        `pear ${what} failed: ${failureMessage(r.records) ?? r.out.split('\n').slice(-8).join(' ')}`,
      );
    return r;
  };
  const planned = async (
    p: Pear,
    name: string,
    plan: PlannedCommand,
    timeoutS: number,
  ): Promise<RunResult> => ok(`${plan.step} (${name})`, await p.run(name, plan.args, timeoutS));

  try {
    // ---- the network and the keys --------------------------------------------------------------
    const setup = await c.phase(
      'release chain: a private DHT, a loopback relay, throwaway signers and root',
      async () => {
        const child = spawn(
          process.execPath,
          [...process.execArgv, join(c.scriptsDir, 'dht-node.ts')],
          { stdio: ['pipe', 'pipe', 'inherit'] },
        );
        dht = child;
        let out = '';
        child.stdout.on('data', (d: Buffer) => {
          out += d.toString('utf8');
        });
        const until = Date.now() + 90_000;
        let bootstrap: string | undefined;
        while (bootstrap === undefined) {
          if (child.exitCode !== null) throw new Error(`the DHT exited: ${out}`);
          if (Date.now() > until) throw new Error('the DHT printed no bootstrap');
          bootstrap = /^BOOTSTRAP (\S+)$/m.exec(out)?.[1];
          if (bootstrap === undefined) await sleep(200);
        }
        assertLoopbackBootstrap(bootstrap);
        const net = bootstrap;
        const peer = (name: string): Pear => {
          const p = new Pear({
            bin: c.pearBin,
            home: join(root, `home-${name}`),
            bootstrap: net,
            logDir: join(logRoot, name),
          });
          pears.push(p);
          return p;
        };
        const coordinator = peer('coordinator');
        const seedA = peer('seed-a');
        const seedB = peer('seed-b');
        const user = peer('user');
        const startedRelay = await NoticeRelay.start();
        relay = startedRelay;

        const signers: Signer[] = [];
        for (const name of ['signer-1', 'signer-2', 'signer-3']) {
          const pear = new Pear({
            bin: c.pearBin,
            home: join(root, `home-${name}`),
            bootstrap: net,
            logDir: join(logRoot, name),
          });
          const password = randomBytes(18).toString('base64url');
          const r = await withTerminal(pear, ['multisig', 'keys', 'get', name], password, 2);
          const publicKey = publicKeyIn(r.out);
          if (r.code !== 0 || publicKey === undefined)
            throw new Error(`pear multisig keys get ${name}: exit ${String(r.code)}, no key`);
          signers.push({ name, pear, password, publicKey });
        }

        const config = join(root, 'pear.json');
        writeFileSync(
          config,
          `${JSON.stringify(
            {
              multisig: {
                publicKeys: signers.map((s) => s.publicKey),
                namespace: PROOF_NAMESPACE,
                quorum: PROOF_QUORUM,
              },
            },
            null,
            2,
          )}\n`,
        );
        // The first call starts this home's sidecar, on the private DHT.
        let linked: RunResult | undefined;
        for (let attempt = 1; attempt <= 3; attempt++) {
          linked = await coordinator.run(
            `multisig-link-${String(attempt)}`,
            planMultisigLink({ config }).args,
            180,
          );
          if (linked.code === 0 && succeeded(linked.records)) break;
          await sleep(5000);
        }
        if (linked === undefined) throw new Error('no pear');
        ok('multisig link', linked);
        const production = field(lastRecord(linked.records, 'final'), 'link');
        if (production === undefined || !/^pear:\/\/[a-z0-9]{52}$/.test(production))
          throw new Error('pear multisig link printed no link');

        const touch = async (name: string): Promise<string> => {
          const r = ok(
            `touch ${name}`,
            await coordinator.run(`touch-${name}`, ['touch', '--json'], 180),
          );
          const l = field(lastRecord(r.records, 'final'), 'link');
          if (l === undefined) throw new Error('pear touch printed no link');
          return l;
        };
        const staging = await touch('staging');
        const preProduction = await touch('pre-production');

        const releaseKey = generateSecretKey();
        const wrongKey = generateSecretKey();
        const trust: TrustRoot = parseTrustRoot({
          v: 1,
          channel: 'test',
          pubkey: getPublicKey(releaseKey),
          relays: [startedRelay.url],
          upgrade: production,
          dht: net.split(','),
          delayMs: 0,
        });
        const rootFile = join(root, 'trust-root.json');
        writeFileSync(rootFile, `${JSON.stringify(trust)}\n`);
        c.say(
          `DHT ${net}, relay ${startedRelay.url}, production link ${production} (quorum ${String(PROOF_QUORUM)} of ${String(signers.length)})`,
        );
        return {
          net,
          coordinator,
          seedA,
          seedB,
          user,
          signers,
          config,
          production,
          staging,
          preProduction,
          releaseKey,
          wrongKey,
          trust,
          rootFile,
          relay: startedRelay,
        };
      },
    );
    row(
      'signers',
      `${String(setup.signers.length)} keys made by pear multisig keys get, quorum ${String(PROOF_QUORUM)}; production link ${setup.production}`,
    );

    // ---- two real packages, with that link baked in -------------------------------------------
    const versionA = patchVersion(c.baseVersion, 1);
    const versionB = patchVersion(c.baseVersion, 2);
    const packageBuild = (name: string, version: string): string => {
      const out = join(root, `out-${name}`);
      const r = spawnSync(
        process.execPath,
        [
          ...process.execArgv,
          join(PKG_DIR, 'scripts', 'package.ts'),
          'test-build',
          '--platform',
          c.platform,
          '--arch',
          c.arch,
          '--out',
          out,
          '--update-root',
          setup.rootFile,
          '--app-version',
          version,
          '--appimage-runtime-dir',
          join(PKG_DIR, 'out', 'appimage-runtime'),
        ],
        { cwd: PKG_DIR, stdio: ['ignore', 'inherit', 'inherit'] },
      );
      if (r.status !== 0) throw new Error(`test-build ${version}: exit ${String(r.status)}`);
      const made = join(out, 'make', 'appimage', c.arch, c.file);
      if (!existsSync(made)) throw new Error(`no ${made}`);
      return made;
    };
    const appA = await c.phase(`release chain: package build A (${versionA})`, () =>
      packageBuild('a', versionA),
    );
    const appB = await c.phase(`release chain: package build B (${versionB})`, () =>
      packageBuild('b', versionB),
    );
    const shaA = await digestOf(appA);
    const shaB = await digestOf(appB);
    if (shaA === shaB) throw new Error('the two builds have the same digest');
    row('builds', `A ${versionA} ${shaA.slice(0, 16)}…, B ${versionB} ${shaB.slice(0, 16)}…`);

    /** The guard must trip on what CI would refuse to launch: a real build with a link. */
    const unpacked = join(root, 'out-b', `Nutflix-${c.platform}-${c.arch}`, 'resources', 'app');
    const bundle = spawnSync(process.execPath, [join(c.scriptsDir, 'no-updater.ts'), unpacked], {
      encoding: 'utf8',
    });
    if (bundle.status === 0) throw new Error('no-updater.ts passed a build that has a link');
    const baked = bakedRootIn(
      readFileSync(join(unpacked, ...STAGED.updateWorker.split('/')), 'utf8'),
    );
    if (JSON.stringify(baked) !== JSON.stringify(setup.trust))
      throw new Error('the build does not hold the test root it was given');
    row('guard', 'no-updater.ts refuses this real build, whose baked root has a link');

    // ---- one release through the whole pipeline -----------------------------------------------
    const seedsOnProduction: Started[] = [];
    const seedsOnPre: Started[] = [];
    const startSeed = async (p: Pear, name: string, link: string): Promise<Started> => {
      const s = p.start(name, planSeed({ link }).args);
      seeds.push(s);
      const until = Date.now() + 240_000;
      while (lastRecord(parseRecords(s.read()), 'announced') === undefined) {
        if (s.exited()) throw new Error(`pear seed ${name} exited: ${s.read().slice(-400)}`);
        if (Date.now() > until) throw new Error(`pear seed ${name} never announced`);
        await sleep(300);
      }
      return s;
    };
    const waitHeld = async (group: readonly Started[], want: CoreLengths, what: string) => {
      const until = Date.now() + 420_000;
      for (;;) {
        const all = group.map((s) => seedProgress(s.read()));
        if (all.every((p) => holdsAll(p, want))) return;
        if (Date.now() > until)
          throw new Error(
            `${what}: the seeders hold ${JSON.stringify(all)}, want ${JSON.stringify(want)}`,
          );
        await sleep(1000);
      }
    };

    const release = async (
      name: string,
      version: string,
      app: string,
      production: string,
    ): Promise<{ verlink: string; lengths: CoreLengths; deployment: string }> => {
      const project = join(root, `project-${name}`);
      mkdirSync(project, { recursive: true });
      const packageJson = join(project, 'package.json');
      writeFileSync(packageJson, deploymentPackageJson({ version }));
      const deployment = join(root, `deployment-${name}`);
      await planned(
        setup.coordinator,
        `build-${name}`,
        planBuild({ packageJson, target: deployment, appFlags: [`--${c.target}-app`, app] }),
        900,
      );
      const staged = await planned(
        setup.coordinator,
        `stage-${name}`,
        planStage({ link: setup.staging, deployment }),
        1500,
      );
      const source = field(lastRecord(staged.records, 'addendum'), 'verlink');
      if (source === undefined) throw new Error('pear stage reported no versioned link');
      const provisioned = await planned(
        setup.coordinator,
        `provision-${name}`,
        planProvision({ source, target: setup.preProduction, production }),
        1500,
      );
      const pre = provisionedLengths(lastRecord(provisioned.records, 'final')?.data);
      if (seedsOnPre.length === 0)
        for (const [p, n] of [
          [setup.coordinator, 'coordinator'],
          [setup.seedA, 'a'],
          [setup.seedB, 'b'],
        ] as const)
          seedsOnPre.push(await startSeed(p, `seed-pre-${n}`, setup.preProduction));
      await waitHeld(seedsOnPre.slice(1), pre.lengths, `release ${name}: pre-production`);

      const requested = await planned(
        setup.coordinator,
        `request-${name}`,
        planRequest({ config: setup.config, verlink: pre.verlink }),
        900,
      );
      const request = field(lastRecord(requested.records, 'final'), 'request');
      if (request === undefined) throw new Error('pear multisig request printed no request');

      // Quorum 2 of 3: the third signer does not sign.
      const responses: string[] = [];
      for (const s of setup.signers.slice(0, PROOF_QUORUM)) {
        const r = await withTerminal(
          s.pear,
          ['multisig', 'sign', request, s.name, '--json'],
          s.password,
          1,
        );
        const response = lastRecord(parseRecords(r.out.replaceAll('\r', '\n')), 'sign')?.data[
          'response'
        ];
        if (r.code !== 0 || typeof response !== 'string')
          throw new Error(`pear multisig sign (${s.name}): exit ${String(r.code)}, no response`);
        responses.push(response);
      }

      // One signature is below the quorum: a commit must refuse it (before anything is written).
      const quorum = {
        config: setup.config,
        source: setup.preProduction,
        request,
      };
      const short = await setup.coordinator.run(
        `commit-short-${name}`,
        planCommit({ ...quorum, production: setup.production, responses: responses.slice(0, 1) })
          .args,
        420,
      );
      if (short.code === 0 && succeeded(short.records))
        throw new Error('pear multisig commit accepted one signature of a quorum of two');
      if (!/Insufficient quorum/i.test(short.out))
        throw new Error(`the short commit failed for another reason: ${short.out.slice(-400)}`);

      await planned(setup.coordinator, `verify-${name}`, planVerify({ ...quorum, responses }), 900);
      if (seedsOnProduction.length === 0)
        for (const [p, n] of [
          [setup.seedA, 'a'],
          [setup.seedB, 'b'],
        ] as const)
          seedsOnProduction.push(await startSeed(p, `seed-prod-${n}`, setup.production));
      const done = await planned(
        setup.coordinator,
        `commit-${name}`,
        planCommit({ ...quorum, production: setup.production, responses }),
        900,
      );
      const made = committed(lastRecord(done.records, 'final')?.data, linkKeyOf(setup.production));
      await waitHeld(seedsOnProduction, made.lengths, `release ${name}: production`);
      row(
        `release ${name}`,
        `built, staged, provisioned, signed 2 of 3 (1 of 3 refused), committed at ${made.verlink}`,
      );
      return { ...made, deployment };
    };

    const firstProduction = `pear://0.0.${linkKeyOf(setup.production)}`;
    const a = await c.phase('release chain: release A, through the multisig', () =>
      release('a', versionA, appA, firstProduction),
    );

    // ---- installed from the production link, as a user would ----------------------------------
    const installed = await c.phase(
      'release chain: pear install of the production link',
      async () => {
        const home = setup.user.home;
        for (const d of [join('.local', 'bin'), join('.local', 'share', 'applications')])
          mkdirSync(join(home, d), { recursive: true });
        let last: RunResult | undefined;
        for (let attempt = 1; attempt <= 3; attempt++) {
          last = await setup.user.run(
            `install-${String(attempt)}`,
            [
              'install',
              '--dht-bootstrap',
              setup.net,
              '--json',
              '--timeout',
              '120',
              setup.production,
            ],
            600,
          );
          if (last.code === 0 && succeeded(last.records)) break;
          if (!/ERR_NETWORK_TIMEOUT|Network Timeout/.test(last.out)) break;
        }
        if (last === undefined) throw new Error('no pear');
        ok('install', last);
        const dest = field(lastRecord(last.records, 'app'), 'dest');
        if (dest === undefined || !existsSync(dest))
          throw new Error(`pear install says ${String(dest)}, which is not there`);
        return dest;
      },
    );
    if (!(await installedIs(c, installed, shaA, versionA)))
      throw new Error('the installed app is not build A');
    row('installed', `build A, from the production link, by pear install (${a.verlink})`);

    const b = await c.phase('release chain: release B, on top of A', () =>
      release('b', versionB, appB, a.verlink),
    );

    // ---- the digest and the notice, by this tool ----------------------------------------------
    const digests: Digest[] = await digestTargets(b.deployment, () => appB, [target]);
    const [digest] = digests;
    if (digest?.sha256 !== shaB)
      throw new Error('the digest of the deployment is not the digest of build B');
    if (digest.bytes !== (await artifactBytes(appB)))
      throw new Error('the size of the deployment entry is not the size of build B');
    const draftFor = (createdAt: number, sha256: string): UnsignedNotice =>
      noticeDraft({
        version: versionB,
        verlink: b.verlink,
        commit: process.env['GITHUB_SHA'],
        createdAt,
        artifacts: [{ ...digest, sha256 }],
      });
    const check = finalizeEvent(
      toTemplate(draftFor(Math.floor(Date.now() / 1000), shaB)),
      setup.releaseKey,
    );
    const read = readNotice(check, setup.trust, Math.floor(Date.now() / 1000));
    if (read.notice?.verlink !== b.verlink)
      throw new Error(`the app's notice.ts refused the draft: ${String(read.refused)}`);
    row('notice', `drafted by this tool, signed by the test root, read by the app's notice.ts`);

    // ---- the installed app decides -------------------------------------------------------------
    await proveGateMatrix({
      c,
      relay: setup.relay,
      work: root,
      releaseKey: setup.releaseKey,
      wrongKey: setup.wrongKey,
      releasePubkey: setup.trust.pubkey,
      exe: installed,
      env: isolatedEnv(setup.user.home),
      installed,
      versionA,
      versionB,
      shaA,
      shaB,
      appB,
      template: (createdAt, sha256) => toTemplate(draftFor(createdAt, sha256)),
      row,
    });

    return { rows, link: setup.production };
  } finally {
    for (const s of seeds) await s.stop().catch(() => undefined);
    for (const p of pears)
      await p.run('sidecar-shutdown', ['sidecar', 'shutdown'], 60).catch(() => undefined);
    await relay?.stop().catch(() => undefined);
    const d = dht;
    if (d !== undefined) {
      d.stdin?.end();
      await sleep(1000);
      killTree(d.pid);
    }
  }
}
