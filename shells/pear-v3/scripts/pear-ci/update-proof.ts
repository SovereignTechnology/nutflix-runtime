/**
 * The install job's proof of the update gate, on this runner's own target, with real builds, a real
 * `pear install`, and the packaged app making its own decision:
 *
 *   setup      a private DHT, a relay on 127.0.0.1, a throwaway release key, a throwaway link
 *   builds     two packages made by `package.ts test-build`, with that key, relay and link baked in
 *   installed  build A, by `pear install`, from the private DHT
 *   staged     build B, on the same link
 *   (a)        no notice:                     A runs, holds B, and A stays installed
 *   (b)        a notice with the wrong hash:  held
 *   (b)        notices from the wrong signer: refused, held
 *   (c)        a notice naming B exactly:     applied, the swap proved by hash
 *   restart    the installed app IS B
 *
 * Nothing here reaches the public network: every address baked into these builds is on loopback
 * (the package step refuses anything else), and the job's tripwire is read after this ran.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure';

import type { Arch, Platform } from '../../packaging/identity.ts';
import { PKG_DIR } from '../../packaging/paths.ts';
import { makeAppx } from '../../packaging/windows-kit.ts';
import { artifactName } from '../../src/update/gate.ts';
import { NOTICE_D, NOTICE_KIND, type TrustRoot } from '../../src/update/root.ts';
import { digestOf } from '../release/digest.ts';
import { launch, type LaunchResult } from '../smoke.ts';
import { deploymentPackageJson, manifestProblems, treeManifest } from './deployment.ts';
import { NoticeRelay } from './notice-relay.ts';
import { Pear, isolatedEnv, killTree, type RunResult, type Started } from './pear.ts';
import type { TargetName } from './pins.ts';
import {
  assertLoopbackBootstrap,
  failureMessage,
  field,
  lastRecord,
  parseRecords,
  succeeded,
} from './records.ts';
import {
  aliasPath,
  appxLog,
  packageInfo,
  removePackage,
  signMsix,
  type TestCert,
} from './windows.ts';

export interface ProofContext {
  readonly target: TargetName;
  readonly platform: Platform;
  readonly arch: Arch;
  /** `Nutflix.AppImage`, `Nutflix.app` or `Nutflix.msix`. */
  readonly file: string;
  readonly work: string;
  readonly logs: string;
  readonly pearBin: string;
  readonly scriptsDir: string;
  /** The Windows leg's ephemeral certificate. */
  readonly cert: TestCert | undefined;
  /** This package's version; the two test builds are the next two patch versions. */
  readonly baseVersion: string;
  phase<T>(title: string, fn: () => Promise<T> | T): Promise<T>;
  say(line: string): void;
}

export interface ProofRow {
  readonly step: string;
  readonly result: string;
}

export interface UpdateProofReport {
  readonly rows: ProofRow[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export { digestOf };

/** `0.1.0` + 2 = `0.1.2`. */
export function patchVersion(version: string, by: number): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (m === null) throw new Error(`${version} is not a.b.c`);
  return `${String(m[1])}.${String(m[2])}.${String(Number(m[3]) + by)}`;
}

export interface NoticeFields {
  readonly createdAt: number;
  readonly version: string;
  readonly verlink: string;
  readonly artifact: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** The unsigned event: the shape `src/update/notice.ts` reads. */
export function noticeTemplate(n: NoticeFields): {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
} {
  const content = `${n.sha256}  ${n.artifact}\n`;
  return {
    kind: NOTICE_KIND,
    created_at: n.createdAt,
    content,
    tags: [
      ['d', NOTICE_D],
      ['version', n.version],
      ['verlink', n.verlink],
      ['x', createHash('sha256').update(content, 'utf8').digest('hex')],
      ['files', '1'],
      ['size', String(n.bytes)],
      ['artifact', n.artifact, n.sha256, String(n.bytes)],
    ],
  };
}

/** What a notice is before it is signed. */
export interface NoticeEventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/** `template`, claiming `claimed` as its author, with a signature made by another key. */
export function forgedFrom(
  template: NoticeEventTemplate,
  claimed: string,
  other: Uint8Array,
): object {
  const signed = finalizeEvent({ ...template }, other);
  const unsigned = { ...template, pubkey: claimed };
  return { ...unsigned, id: getEventHash(unsigned), sig: signed.sig };
}

/** A notice claiming `claimed` as its author, carrying a signature made by another key. */
export function forgedNotice(n: NoticeFields, claimed: string, other: Uint8Array): object {
  return forgedFrom(noticeTemplate(n), claimed, other);
}

const TERMINAL = (s: Record<string, unknown>): boolean =>
  s['state'] === 'held' || s['state'] === 'applied' || s['state'] === 'failed';

function byteSize(p: string): number {
  const st = statSync(p);
  return st.isFile() ? st.size : 0;
}

/** What is installed, as a digest (Linux, macOS) or the package's version (Windows). */
export async function installedIs(
  c: Pick<ProofContext, 'platform' | 'scriptsDir'>,
  installed: string | undefined,
  digest: string,
  version: string,
): Promise<boolean> {
  if (c.platform === 'win32') {
    const v = packageInfo(c.scriptsDir).package?.Version;
    return v === `${version}.0`;
  }
  return (await digestOf(installed ?? '')) === digest;
}

/** What the gate's matrix needs: a build A installed, and a build B waiting on its link. */
export interface GateMatrix {
  readonly c: ProofContext;
  readonly relay: NoticeRelay;
  /** A scratch directory. */
  readonly work: string;
  /** The throwaway key the installed app trusts. */
  readonly releaseKey: Uint8Array;
  readonly wrongKey: Uint8Array;
  readonly releasePubkey: string;
  /** How the installed app is started, and with what environment. */
  readonly exe: string;
  readonly env: NodeJS.ProcessEnv;
  readonly installed: string | undefined;
  readonly versionA: string;
  readonly versionB: string;
  readonly shaA: string;
  readonly shaB: string;
  readonly appB: string;
  /** The unsigned notice naming B, with this date and this digest. */
  readonly template: (createdAt: number, sha256: string) => NoticeEventTemplate;
  readonly row: (step: string, result: string) => void;
}

/**
 * The installed app decides, four times: no notice, a wrong hash and a wrong signer are held and
 * leave A installed; the notice that names B is applied, and the restarted app is B.
 */
export async function proveGateMatrix(m: GateMatrix): Promise<void> {
  const { c, exe, env, installed, versionA, versionB, shaA, shaB, appB, row } = m;
  const base = Math.floor(Date.now() / 1000);

  const isInstalled = (digest: string, version: string): Promise<boolean> =>
    installedIs(c, installed, digest, version);

  /** One launch of the installed app: it must decide, and A must still be installed after it. */
  const heldCase = async (step: string, wantReason: string, minRefused: number): Promise<void> => {
    // `update-shown`: main read the words back from the window.
    const r = await launch(exe, [], 'ready', 360, {
      env,
      updates: 'on',
      untilUpdate: TERMINAL,
      waitFor: 'update-shown',
    });
    const last = r.updates[r.updates.length - 1];
    c.say(`updates: ${JSON.stringify(r.updates)}; events: ${r.events.join(', ')}`);
    if (!r.ok) throw new Error(`${r.reason}\n${r.tail.slice(-25).join('\n')}`);
    if (last?.['state'] !== 'held' || last['reason'] !== wantReason)
      throw new Error(`wanted held/${wantReason}, got ${JSON.stringify(last)}`);
    if (typeof last['refused'] === 'number' ? last['refused'] < minRefused : minRefused > 0)
      throw new Error(`wanted at least ${String(minRefused)} refused, got ${JSON.stringify(last)}`);
    if (r.ready?.version !== versionA)
      throw new Error(`build ${String(r.ready?.version)} ran, not A`);
    if (!(await isInstalled(shaA, versionA)))
      throw new Error('the installed app changed while the build was held');
    row(
      step,
      `HELD (${wantReason}${typeof last['refused'] === 'number' ? `, ${String(last['refused'])} refused` : ''}); the window said so; installed app still build A`,
    );
  };

  // ---- (a) no notice -------------------------------------------------------------------------
  await c.phase('update gate (a): no notice, the build is held', async () => {
    m.relay.hold([]);
    await heldCase('(a) no notice', 'no-notice', 0);
  });

  // ---- (b) a wrong hash, then a wrong signer ---------------------------------------------------
  await c.phase('update gate (b): a notice with the wrong hash, the build is held', async () => {
    const wrong = shaB.replace(/^./, (x) => (x === '0' ? '1' : '0'));
    m.relay.hold([finalizeEvent(m.template(base, wrong), m.releaseKey)]);
    await heldCase('(b) wrong hash', 'hash-mismatch', 0);
  });
  await c.phase('update gate (b): notices from the wrong signer, the build is held', async () => {
    // Right fields and right hash, a later date: one signed by another key under its own name,
    // and one that claims the release key with a signature that key never made. The floor
    // from the step before stays; neither may move it.
    const n = m.template(base + 5, shaB);
    m.relay.hold([finalizeEvent({ ...n }, m.wrongKey), forgedFrom(n, m.releasePubkey, m.wrongKey)]);
    await heldCase('(b) wrong signer', 'no-notice', 2);
  });

  // ---- (c) the notice that names B ------------------------------------------------------------
  const applied = await c.phase(
    'update gate (c): a matching notice, the build is applied',
    async () => {
      m.relay.hold([finalizeEvent(m.template(base + 10, shaB), m.releaseKey)]);
      const r: LaunchResult = await launch(exe, [], 'ready', 360, {
        env,
        updates: 'on',
        untilUpdate: TERMINAL,
        waitFor: 'update-shown',
      });
      const last = r.updates[r.updates.length - 1];
      c.say(`updates: ${JSON.stringify(r.updates)}; events: ${r.events.join(', ')}`);
      if (!r.ok) throw new Error(`${r.reason}\n${r.tail.slice(-25).join('\n')}`);
      if (last?.['state'] !== 'applied')
        throw new Error(`wanted applied, got ${JSON.stringify(last)}`);
      if (c.platform === 'win32') {
        if (last['proof'] !== 'msix-deployed')
          throw new Error(`wanted the MSIX proof, got ${JSON.stringify(last)}`);
        // Windows registers the update once the running package has exited.
        const until = Date.now() + 120_000;
        while (!(await isInstalled(shaB, versionB)) && Date.now() < until) await sleep(3000);
      } else {
        if (last['proof'] !== 'sha256')
          throw new Error(`wanted the sha256 proof, got ${JSON.stringify(last)}`);
        // The job's own hash of the installed app, apart from the one the app reported.
        const now = await digestOf(installed ?? '');
        if (now !== shaB) throw new Error(`the installed app is ${now}, not build B (${shaB})`);
      }
      return last['proof'];
    },
  );
  row(
    '(c) matching notice',
    c.platform === 'win32'
      ? 'APPLIED (Windows accepted the signed package; checked below)'
      : `APPLIED; the job's own hash of the installed app equals build B (${shaB.slice(0, 16)}…), app's proof ${applied}`,
  );

  // ---- the restart ---------------------------------------------------------------------------
  await c.phase('update gate: the restarted app is build B', async () => {
    const r = await launch(exe, [], 'ready', 240, { env, updates: 'on', settleMs: 5000 });
    c.say(`updates: ${JSON.stringify(r.updates)}; ready ${JSON.stringify(r.ready)}`);
    if (!r.ok) throw new Error(`${r.reason}\n${r.tail.slice(-25).join('\n')}`);
    if (r.ready?.version !== versionB)
      throw new Error(`the restarted app says ${String(r.ready?.version)}, not ${versionB}`);
    if (r.updates.some((s) => s['state'] === 'held' || s['state'] === 'failed'))
      throw new Error(`the restarted app is not current: ${JSON.stringify(r.updates)}`);
    if (c.platform === 'darwin') {
      const v = spawnSync('codesign', ['--verify', '--deep', '--strict', installed ?? ''], {
        encoding: 'utf8',
      });
      if (v.status !== 0) throw new Error(`the swapped bundle fails codesign: ${v.stderr.trim()}`);
    }
    if (c.platform === 'win32') {
      const p = packageInfo(c.scriptsDir).package;
      if (p?.Version !== `${versionB}.0`)
        throw new Error(`Windows has ${String(p?.Version)} installed, not ${versionB}`);
      const unpack = join(m.work, 'msix-b');
      rmSync(unpack, { recursive: true, force: true });
      const u = spawnSync(makeAppx(), ['unpack', '/p', appB, '/d', unpack, '/o'], {
        encoding: 'utf8',
      });
      if (u.status !== 0) throw new Error(`makeappx unpack: exit ${String(u.status)}`);
      const diff = manifestProblems(
        await treeManifest(join(unpack, 'app')),
        await treeManifest(join(p.InstallLocation, 'app')),
      );
      if (diff.length > 0)
        throw new Error(`the installed package is not build B: ${diff.join('; ')}`);
      row('swap proof', `every file under app\\ of ${p.PackageFullName} equals build B's .msix`);
    }
    row('restart', `the installed app runs as ${versionB} (build B)`);
  });
}

export async function proveUpdateGate(c: ProofContext): Promise<UpdateProofReport> {
  const rows: ProofRow[] = [];
  const row = (step: string, result: string): void => {
    rows.push({ step, result });
    c.say(`gate ${step}: ${result}`);
  };
  const root = join(c.work, 'update');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const logDir = join(c.logs, 'update');

  let dht: ChildProcess | undefined;
  let relay: NoticeRelay | undefined;
  let seed: Started | undefined;
  let pear: Pear | undefined;

  const pearOk = (what: string, r: RunResult): void => {
    c.say(`$ pear ${what}: exit ${String(r.code)}, ${String(r.ms)} ms, ${r.logFile}`);
    if (r.code !== 0 || r.timedOut || !succeeded(r.records))
      throw new Error(
        `pear ${what} failed: ${failureMessage(r.records) ?? r.out.split('\n').slice(-6).join(' ')}`,
      );
  };

  /** `pear build` of this target's one package; returns the deployment folder. */
  const deploy = async (name: string, version: string, artifact: string): Promise<string> => {
    const dir = join(root, `deploy-${name}`);
    const project = join(root, `project-${name}`);
    mkdirSync(project, { recursive: true });
    const pkg = join(project, 'package.json');
    writeFileSync(pkg, deploymentPackageJson({ version }));
    const r = await pear?.run(
      `update-build-${name}`,
      ['build', '--package', pkg, '--target', dir, '--json', `--${c.target}-app`, artifact],
      900,
    );
    if (r === undefined) throw new Error('no pear');
    pearOk(`build ${name}`, r);
    return dir;
  };

  /** `pear stage`; returns the versioned link it reports. */
  const stage = async (name: string, link: string, dir: string): Promise<string> => {
    const r = await pear?.run(`update-stage-${name}`, ['stage', '--json', link, dir], 1500);
    if (r === undefined) throw new Error('no pear');
    pearOk(`stage ${name}`, r);
    const verlink = field(lastRecord(r.records, 'addendum'), 'verlink');
    if (verlink === undefined) throw new Error(`pear stage ${name} reported no versioned link`);
    return verlink;
  };

  try {
    // ---- what the builds will trust ---------------------------------------------------------
    const setup = await c.phase(
      'update gate: a private DHT, a loopback relay, a throwaway key and link',
      async () => {
        const child = spawn(
          process.execPath,
          [...process.execArgv, join(c.scriptsDir, 'dht-node.ts')],
          { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true },
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
        pear = new Pear({ bin: c.pearBin, home, bootstrap, logDir });
        const startedRelay = await NoticeRelay.start();
        relay = startedRelay;
        const releaseKey = generateSecretKey();
        const wrongKey = generateSecretKey();
        let touched: RunResult | undefined;
        for (let attempt = 1; attempt <= 3; attempt++) {
          touched = await pear.run(`update-touch-${String(attempt)}`, ['touch', '--json'], 180);
          if (touched.code === 0 && succeeded(touched.records)) break;
          await sleep(10_000);
        }
        if (touched === undefined) throw new Error('no pear');
        pearOk('touch', touched);
        const link = field(lastRecord(touched.records, 'final'), 'link');
        if (link === undefined || !/^pear:\/\/[a-z0-9]{52}$/.test(link))
          throw new Error('pear touch printed no link');
        const trust: TrustRoot = {
          v: 1,
          channel: 'test',
          pubkey: getPublicKey(releaseKey),
          relays: [startedRelay.url],
          upgrade: link,
          dht: bootstrap.split(','),
          delayMs: 0,
        };
        const rootFile = join(root, 'trust-root.json');
        writeFileSync(rootFile, `${JSON.stringify(trust)}\n`);
        c.say(
          `relay ${startedRelay.url}, DHT ${bootstrap}, link ${link}, release key ${trust.pubkey}`,
        );
        return { bootstrap, link, rootFile, releaseKey, wrongKey, trust, relay: startedRelay };
      },
    );

    // ---- two real packages ------------------------------------------------------------------
    const versionA = patchVersion(c.baseVersion, 1);
    const versionB = patchVersion(c.baseVersion, 2);
    const packaged = (name: string): string => {
      const out = join(root, `out-${name}`);
      if (c.platform === 'darwin') return join(out, `Nutflix-darwin-${c.arch}`, c.file);
      if (c.platform === 'linux') return join(out, 'make', 'appimage', c.arch, c.file);
      return join(out, 'make', 'msix', c.arch, c.file);
    };
    const build = (name: string, version: string): string => {
      const out = join(root, `out-${name}`);
      const args = [
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
      ];
      const r = spawnSync(process.execPath, args, {
        cwd: PKG_DIR,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      if (r.status !== 0)
        throw new Error(`package.ts test-build ${version}: exit ${String(r.status)}`);
      const made = packaged(name);
      if (!existsSync(made)) throw new Error(`no ${made}`);
      if (c.platform === 'win32') {
        if (c.cert === undefined) throw new Error('no test certificate');
        c.say(signMsix(made, c.cert));
      }
      return made;
    };
    const appA = await c.phase(`update gate: package build A (${versionA})`, () =>
      build('a', versionA),
    );
    const appB = await c.phase(`update gate: package build B (${versionB})`, () =>
      build('b', versionB),
    );
    const shaA = await digestOf(appA);
    const shaB = await digestOf(appB);
    if (shaA === shaB) throw new Error('the two builds have the same digest');
    row('builds', `A ${versionA} ${shaA.slice(0, 16)}…, B ${versionB} ${shaB.slice(0, 16)}…`);

    // ---- A, installed as a user installs it ---------------------------------------------------
    const installed = await c.phase(
      'update gate: stage, seed and pear install build A',
      async () => {
        const dir = await deploy('a', versionA, appA);
        await stage('a', setup.link, dir);
        seed = pear?.start('update-seed', ['seed', '--no-tty', '--json', setup.link]);
        if (seed === undefined) throw new Error('no pear');
        const s = seed;
        const until = Date.now() + 240_000;
        while (lastRecord(parseRecords(s.read()), 'announced') === undefined) {
          if (s.exited()) throw new Error('pear seed exited');
          if (Date.now() > until) throw new Error('pear seed never announced');
          await sleep(500);
        }
        if (c.platform === 'win32') removePackage(c.scriptsDir);
        for (const d of c.platform === 'linux'
          ? [join('.local', 'bin'), join('.local', 'share', 'applications')]
          : c.platform === 'darwin'
            ? ['Applications']
            : [])
          mkdirSync(join(home, d), { recursive: true });
        let last: RunResult | undefined;
        for (let attempt = 1; attempt <= 3; attempt++) {
          last = await pear?.run(
            `update-install-${String(attempt)}`,
            [
              'install',
              '--dht-bootstrap',
              setup.bootstrap,
              '--json',
              '--timeout',
              '120',
              setup.link,
            ],
            600,
          );
          if (last === undefined) throw new Error('no pear');
          if (last.code === 0 && succeeded(last.records)) break;
          if (!/ERR_NETWORK_TIMEOUT|Network Timeout/.test(last.out)) break;
        }
        if (last === undefined) throw new Error('no pear');
        try {
          pearOk('install', last);
        } catch (e) {
          if (c.platform === 'win32') c.say(`Windows says:\n${appxLog()}`);
          throw e;
        }
        return field(lastRecord(last.records, 'app'), 'dest');
      },
    );

    const exe =
      c.platform === 'linux'
        ? (installed ?? '')
        : c.platform === 'darwin'
          ? join(installed ?? '', 'Contents', 'MacOS', 'Nutflix')
          : aliasPath();
    if (c.platform !== 'win32' && (installed === undefined || !existsSync(installed)))
      throw new Error(`pear install says ${String(installed)}, which is not there`);
    const env = c.platform === 'win32' ? process.env : isolatedEnv(home);

    if (!(await installedIs(c, installed, shaA, versionA)))
      throw new Error('the installed app is not build A');
    row('installed', `build A from the private DHT (${versionA})`);

    // ---- B, on the link ------------------------------------------------------------------------
    const verlinkB = await c.phase('update gate: stage build B on the same link', async () => {
      const dir = await deploy('b', versionB, appB);
      return stage('b', setup.link, dir);
    });
    row('staged', `build B at ${verlinkB}`);

    const artifact = artifactName(c.target, c.file);
    await proveGateMatrix({
      c,
      relay: setup.relay,
      work: root,
      releaseKey: setup.releaseKey,
      wrongKey: setup.wrongKey,
      releasePubkey: setup.trust.pubkey,
      exe,
      env,
      installed,
      versionA,
      versionB,
      shaA,
      shaB,
      appB,
      template: (createdAt, sha256) =>
        noticeTemplate({
          createdAt,
          version: versionB,
          verlink: verlinkB,
          artifact,
          sha256,
          bytes: byteSize(appB),
        }),
      row,
    });
    return { rows };
  } finally {
    try {
      await seed?.stop();
      await pear?.run('update-sidecar-shutdown', ['sidecar', 'shutdown'], 90);
    } catch (e) {
      c.say(`update teardown: ${e instanceof Error ? e.message : String(e)}`);
    }
    await relay?.stop().catch(() => undefined);
    const d = dht;
    if (d !== undefined) {
      d.stdin?.end();
      await sleep(1000);
      killTree(d.pid);
    }
  }
}
