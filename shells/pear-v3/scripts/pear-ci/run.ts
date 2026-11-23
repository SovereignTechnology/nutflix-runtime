/**
 * The install job (ADR 0001 amendment, item 5: "each target must pass a real `pear install` and
 * launch before a release"). On one runner, for its own target:
 *
 *   tripwire   drop and count every packet to the public HyperDHT bootstrap, and prove it counts
 *   pear       the pinned CLI, from the platform's release (an HTTPS download, no DHT)
 *   dht        a private HyperDHT on 127.0.0.1 (the only bootstrap anything here is given)
 *   merged     `pear build`: the five packaged artifacts of the `shell` job, one deployment folder
 *   staged     `pear stage` onto a throwaway link
 *   seeded     `pear seed` on the private DHT, until the install is done
 *   installed  `pear install pear://<link>` from the private DHT
 *   launched   the INSTALLED app, started as installed, prints its ready line
 *   gate       the update gate, on two more real builds (`update-proof.ts`)
 *
 * The app takes no test switch. The builds of the `shell` job have no upgrade link and run no
 * updater, and each must say so. Nothing here provisions or multisigs. Every link is made on the
 * private DHT and exists nowhere else; no peer of the public network can reach it, and nothing here
 * reaches the public network: the app's public relay names are blackholed (`sinkhole.ts`) and the
 * tripwire counts their real addresses too.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { release as osRelease, version as osVersion } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { APP, MSIX, TARGETS } from '../../packaging/identity.ts';
import { PKG_DIR, REPO_ROOT } from '../../packaging/paths.ts';
import { makeAppx } from '../../packaging/windows-kit.ts';
import { launch, readyProblems, type LaunchResult, type ReadyFields } from '../smoke.ts';
import {
  deploymentPackageJson,
  expectedDeploymentEntries,
  filesOnly,
  listFiles,
  manifestProblems,
  manifestSummary,
  sha256File,
  treeManifest,
  type TreeManifest,
} from './deployment.ts';
import { Pear, fetchPear, isolatedEnv, killTree, unzip, type Started } from './pear.ts';
import {
  CANARY_IP,
  PEAR_VERSION,
  PUBLIC_BOOTSTRAP_IPS,
  appFileName,
  type TargetName,
} from './pins.ts';
import {
  assertLoopbackBootstrap,
  bootstrapProof,
  failureMessage,
  field,
  lastRecord,
  parseRecords,
  succeeded,
  type PearRecord,
} from './records.ts';
import { applySinkhole, assertSinkholed, publicHosts, resolvePublicIps } from './sinkhole.ts';
import { barrier, createTripwire, proveTripwire, publicBootstrapHits } from './tripwire.ts';
import { proveUpdateGate, type UpdateProofReport } from './update-proof.ts';
import {
  aliasPath,
  appxLog,
  ensureSideloading,
  newTestCert,
  packageInfo,
  removePackage,
  removeTestCert,
  signMsix,
  windowsFacts,
  type PackageFacts,
  type TestCert,
} from './windows.ts';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

export interface Options {
  readonly target: TargetName;
  /** The `shell-<target>` artifact directories, as `download-artifact` laid them out. */
  readonly artifacts: string;
  /** A scratch directory the run may fill. */
  readonly work: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

class Handled extends Error {}

/** What the summary says, per phase. */
interface Report {
  target: string;
  pear?: { version: string; asset: string; sha256: string };
  dht?: { bootstrap: string };
  tripwire?: {
    kind: string;
    canaryCounted: number;
    publicBootstrapHitsDuringPear: number;
    publicBootstrapHitsFromTheApp: number;
  };
  bootstrapProof?: {
    set: boolean;
    names: boolean;
    readKnownNodes: boolean;
    lines: readonly string[];
  };
  link?: string;
  merged?: string;
  staged?: string;
  seeded?: string;
  installed?: string;
  launched?: string;
  ready?: ReadyFields | null;
  /** The public relay and STUN names blackholed on this runner. */
  sinkholed?: readonly string[];
  /** Packets to the public addresses while the update gate's proof ran. */
  publicHitsDuringGate?: number;
  updateGate?: UpdateProofReport;
  notes: string[];
  failures: string[];
}

function tail(text: string, n: number): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l !== '')
    .slice(-n)
    .join('\n');
}

async function waitFor<T>(
  what: string,
  timeoutMs: number,
  probe: () => T | undefined | Promise<T | undefined>,
  everyMs = 500,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > until)
      throw new Error(`timed out after ${String(timeoutMs / 1000)} s waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** Finds `name` anywhere under `dir`. */
function find(dir: string, name: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) {
      const f = find(p, name);
      if (f !== undefined) return f;
    }
  }
  return undefined;
}

function tree(dir: string, depth = 2, prefix = ''): string[] {
  if (!existsSync(dir) || depth < 0) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    out.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
    if (e.isDirectory()) out.push(...tree(join(dir, e.name), depth - 1, `${prefix}  `));
  }
  return out;
}

/** Unpacks a macOS `.app.zip` with the tool that keeps what a bundle needs (symlinks, modes). */
function unzipApp(zip: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (process.platform === 'darwin') {
    const r = spawnSync('ditto', ['-x', '-k', zip, dir], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`ditto -x -k: exit ${String(r.status)} ${r.stderr}`);
  } else if (process.platform === 'win32') {
    // A Windows file system holds no symlinks a bundle can use, and 7-Zip may refuse some of them
    // (it exits 2 and lists them). This runner's macOS payload is a stand-in either way (the
    // report says so), so what must be there is the bundle's executable.
    const sevenZip = ['C:\\Program Files\\7-Zip\\7z.exe', '7z'].find(
      (c) => spawnSync(c, ['i'], { stdio: 'ignore' }).status === 0,
    );
    if (sevenZip === undefined) unzip(zip, dir);
    else {
      const r = spawnSync(sevenZip, ['x', '-y', `-o${dir}`, zip], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (r.status !== 0) {
        const lines = r.stdout
          .split(/\r?\n/)
          .filter((l) => /error|cannot|can not|denied|privilege|symbolic|link/i.test(l));
        say(`7z x ${zip}: exit ${String(r.status)}; ${lines.slice(0, 12).join(' | ')}`);
        if (!existsSync(join(dir, `${APP.productName}.app`, 'Contents', 'MacOS', APP.productName)))
          throw new Error(`7z x: exit ${String(r.status)} and no bundle executable`);
      }
    }
  } else unzip(zip, dir);
}

const TARGET_NAMES = TARGETS.map((t) => ({
  ...t,
  name: `${t.platform}-${t.arch}` as TargetName,
  file: appFileName(t.platform, APP.productName),
}));

export async function run(o: Options): Promise<number> {
  const own = TARGET_NAMES.find((t) => t.name === o.target);
  if (own === undefined) throw new Error(`${o.target} is not a target`);
  if (`${process.platform}-${process.arch}` !== o.target)
    throw new Error(`this runner is ${process.platform}-${process.arch}, not ${o.target}`);

  const work = resolve(o.work);
  const home = join(work, 'home');
  const logs = join(work, 'logs');
  const tools = join(work, 'tools');
  const src = join(work, 'deploy-src');
  const deploy = join(work, 'deployment');
  mkdirSync(logs, { recursive: true });
  const report: Report = { target: o.target, notes: [], failures: [] };

  // The app's public relay and STUN hosts, and where they really are, BEFORE the names are
  // blackholed: the tripwire watches those addresses too.
  const relayHosts = publicHosts(REPO_ROOT);
  const relayIps = (await resolvePublicIps(relayHosts)).filter(
    (ip) => !PUBLIC_BOOTSTRAP_IPS.includes(ip) && ip !== CANARY_IP,
  );
  const tw = createTripwire(process.platform, work, SCRIPTS_DIR, [
    ...PUBLIC_BOOTSTRAP_IPS,
    ...relayIps,
    CANARY_IP,
  ]);
  let dht: ChildProcess | undefined;
  let seed: Started | undefined;
  let pear: Pear | undefined;
  let cert: TestCert | undefined;
  let armed = false;
  let sidecarUp = false;
  let privateBootstrap = '';
  const bootstrapOf = (): string => privateBootstrap;

  const phase = async <T>(title: string, fn: () => Promise<T> | T): Promise<T> => {
    say(`::group::${title}`);
    const t0 = Date.now();
    try {
      const v = await fn();
      say(`::endgroup::`);
      say(`ok    ${title} (${String(Math.round((Date.now() - t0) / 100) / 10)} s)`);
      return v;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      say(`FAIL  ${title}: ${msg}`);
      say(`::endgroup::`);
      report.failures.push(`${title}: ${msg.split('\n')[0] ?? msg}`);
      throw new Handled(msg);
    }
  };

  /** Prints what a Pear call did, the tail of its output, and refuses a failure. */
  const pearOk = (what: string, r: Awaited<ReturnType<Pear['run']>>): void => {
    say(
      `$ pear ${what}: exit ${String(r.code)}${r.timedOut ? ' (timed out)' : ''}, ${String(r.ms)} ms, ${r.logFile}`,
    );
    say(tail(r.out, 12));
    if (r.code !== 0 || r.timedOut || !succeeded(r.records)) {
      const why = failureMessage(r.records) ?? tail(r.out, 6);
      throw new Error(`pear ${what} failed: ${why}`);
    }
  };

  /**
   * `pear install` moves the app into a folder and does not make it (pear-install 1.5.0 and 1.6.0).
   * One more install, into a home that has no such folder, shows what happens (ENOENT on the
   * first four legs that ran it); it only adds a note, whatever the answer.
   */
  const probeBareHome = async (link: string): Promise<void> => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const folder = process.platform === 'linux' ? '~/.local/bin' : '~/Applications';
    try {
      const bare = join(work, 'bare-home');
      mkdirSync(bare, { recursive: true });
      const r = await pear?.run(
        'install-bare-home',
        ['install', '--dht-bootstrap', bootstrapOf(), '--json', '--timeout', '60', link],
        300,
        isolatedEnv(bare),
      );
      const said =
        r === undefined
          ? 'no result'
          : r.code === 0 && succeeded(r.records)
            ? 'it installed'
            : (failureMessage(r.records) ?? tail(r.out, 2)).split('\n')[0];
      report.notes.push(
        `pear install into a home with no ${folder}: exit ${String(r?.code)}; ${String(said)}`,
      );
      say(report.notes[report.notes.length - 1] ?? '');
    } catch (e) {
      say(`probe: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  try {
    // ---- the tripwire ------------------------------------------------------------------------
    await phase('environment', () => {
      say(`target ${o.target}, node ${process.version}, pear ${PEAR_VERSION}`);
      say(`work ${work}`);
      say(`os ${osRelease()} ${osVersion()}`);
      if (process.platform === 'win32') say(`windows ${windowsFacts()}`);
      if (existsSync(home))
        throw new Error('the home directory already exists: a sidecar may be in it');
      mkdirSync(home, { recursive: true });
    });

    const canary = await phase(`tripwire (${tw.kind}): arm it, and prove it counts`, async () => {
      tw.arm();
      armed = true;
      const hits = await proveTripwire(tw, process.platform === 'win32' ? 90_000 : 15_000);
      say(`counted: ${JSON.stringify(hits)}`);
      return hits[CANARY_IP] ?? 0;
    });

    await phase('sinkhole: the public relay names point at loopback', async () => {
      applySinkhole(process.platform, relayHosts);
      await assertSinkholed(relayHosts);
      report.sinkholed = relayHosts;
      say(`${String(relayHosts.length)} hosts: ${relayHosts.join(' ')}`);
      say(`the tripwire also watches their ${String(relayIps.length)} real IPv4 addresses`);
    });

    // ---- the CLI and the private DHT --------------------------------------------------------
    const fetched = await phase(
      'Pear CLI: the pinned release asset, checked before it is run',
      async () => {
        const f = await fetchPear(o.target, tools);
        say(f.url);
        say(`sha256 ${f.sha256} (pinned; checked)`);
        return f;
      },
    );
    report.pear = { version: PEAR_VERSION, asset: fetched.asset, sha256: fetched.sha256 };

    const bootstrap = await phase(
      'private DHT: ten nodes on 127.0.0.1, no other bootstrap',
      async () => {
        const child = spawn(
          process.execPath,
          [...process.execArgv, join(SCRIPTS_DIR, 'dht-node.ts')],
          {
            stdio: ['pipe', 'pipe', 'inherit'],
            windowsHide: true,
          },
        );
        dht = child;
        let out = '';
        child.stdout.on('data', (c: Buffer) => {
          out += c.toString('utf8');
        });
        const line = await waitFor('the DHT to print its bootstrap', 90_000, () => {
          if (child.exitCode !== null)
            throw new Error(`the DHT process exited ${String(child.exitCode)}: ${out}`);
          return /^BOOTSTRAP (\S+)$/m.exec(out)?.[1];
        });
        assertLoopbackBootstrap(line);
        say(`bootstrap ${line}`);
        return line;
      },
    );
    report.dht = { bootstrap };
    privateBootstrap = bootstrap;
    pear = new Pear({ bin: fetched.bin, home, bootstrap, logDir: logs });

    // ---- the artifacts of the shell job ------------------------------------------------------
    const prepared = await phase('artifacts: the five packages of the shell job', async () => {
      say(tree(o.artifacts, 2).join('\n'));
      const out = new Map<TargetName, { path: string; sha256?: string; manifest?: TreeManifest }>();
      for (const t of TARGET_NAMES) {
        const dir = join(o.artifacts, `shell-${t.name}`);
        const wanted = t.platform === 'darwin' ? `${APP.productName}-${t.name}.app.zip` : t.file;
        const found = find(dir, wanted);
        if (found === undefined) throw new Error(`${wanted} is not in ${dir}`);
        const to = join(src, t.name);
        mkdirSync(to, { recursive: true });
        const dest = join(to, t.file);
        if (t.platform === 'darwin') {
          unzipApp(found, to);
          if (!existsSync(join(dest, 'Contents', 'MacOS', APP.productName)))
            throw new Error(`${found} holds no ${t.file}/Contents/MacOS/${APP.productName}`);
          const m = await treeManifest(dest);
          out.set(t.name, { path: dest, manifest: m });
          const s = manifestSummary(m);
          say(
            `${t.name}: ${t.file} ${String(s.files)} files, ${String(s.links)} symlinks, tree ${s.digest}`,
          );
        } else {
          copyFileSync(found, dest);
          if (t.platform === 'linux') chmodSync(dest, 0o755);
          if (t.name === o.target && t.platform === 'win32') {
            const cerPath = join(work, 'test-cert.cer');
            say(ensureSideloading());
            cert = newTestCert(SCRIPTS_DIR, cerPath);
            say(
              `ephemeral certificate ${cert.subject} (thumbprint ${cert.thumbprint}), trusted on this runner only`,
            );
            say(signMsix(dest, cert));
          }
          const sha256 = await sha256File(dest);
          out.set(t.name, { path: dest, sha256 });
          say(`${t.name}: ${t.file} ${String(statSync(dest).size)} bytes, sha256 ${sha256}`);
        }
      }
      if (process.platform === 'win32')
        report.notes.push(
          'Windows cannot hold the macOS bundles faithfully (symlinks), so the macOS entries of this deployment are stand-ins; the other four legs unpack them exactly.',
        );
      return out;
    });

    // ---- the link, then build --------------------------------------------------------------
    const link = await phase(
      'pear touch: a throwaway link (also starts the sidecar on the private DHT)',
      async () => {
        // The first call starts the sidecar and waits up to 20 s for it; a slow runner may need a
        // second call, which finds that sidecar (every call carries the private bootstrap, so any
        // sidecar a call has to start is on it too).
        let r: Awaited<ReturnType<Pear['run']>> | undefined;
        for (let attempt = 1; attempt <= 3; attempt++) {
          r = await pear?.run(`touch-${String(attempt)}`, ['touch', '--json'], 180);
          if (r?.code === 0 && succeeded(r.records)) break;
          say(
            `touch attempt ${String(attempt)}: exit ${String(r?.code)}: ${tail(r?.out ?? '', 3)}`,
          );
          await sleep(10_000);
        }
        if (r === undefined) throw new Error('no pear');
        sidecarUp = true;
        pearOk('touch', r);
        const l = field(lastRecord(r.records, 'final'), 'link');
        if (l === undefined || !/^pear:\/\/[a-z0-9]{52}$/.test(l))
          throw new Error(`no link in ${tail(r.out, 3)}`);
        say(
          `link ${l} (a public key, made on the private DHT: nothing outside this machine can reach it)`,
        );
        return l;
      },
    );
    report.link = link;

    const version = (
      JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as { version: string }
    ).version;
    await phase('pear build: merge the five packages into one deployment', async () => {
      const projectDir = join(work, 'project');
      mkdirSync(projectDir, { recursive: true });
      const pkg = join(projectDir, 'package.json');
      writeFileSync(pkg, deploymentPackageJson({ version }));
      const args = ['build', '--package', pkg, '--target', deploy, '--json'];
      for (const t of TARGET_NAMES) args.push(`--${t.name}-app`, prepared.get(t.name)?.path ?? '');
      const r = await pear?.run('build', args, 900);
      if (r === undefined) throw new Error('no pear');
      pearOk('build', r);
      // What `pear build` made, against what it was given.
      const problems: string[] = [];
      const want = expectedDeploymentEntries(TARGETS);
      for (const e of want)
        if (!existsSync(join(deploy, ...e.split('/')))) problems.push(`missing ${e}`);
      if (readFileSync(join(deploy, 'package.json'), 'utf8') !== readFileSync(pkg, 'utf8'))
        problems.push('package.json is not the one given');
      for (const t of TARGET_NAMES) {
        const made = join(deploy, 'by-arch', t.name, 'app', t.file);
        const given = prepared.get(t.name);
        if (given === undefined || !existsSync(made)) continue;
        if (t.platform === 'darwin') {
          // Windows makes of a bundle's symlinks what it can (links with other targets, files):
          // there only the files are compared.
          const a = given.manifest ?? new Map();
          const b = await treeManifest(made);
          const diff =
            process.platform === 'win32'
              ? manifestProblems(filesOnly(a), filesOnly(b), 5)
              : manifestProblems(a, b, 5);
          for (const d of diff) problems.push(`${t.name}: ${d}`);
        } else if ((await sha256File(made)) !== given.sha256)
          problems.push(`${t.name}: the bytes differ`);
      }
      if (problems.length > 0) throw new Error(problems.join('; '));
      const files = await listFiles(deploy);
      report.merged = `${String(want.length)} entries, ${String(files.length)} files, package.json, every entry equal to its input`;
      say(report.merged);
    });

    // ---- stage -----------------------------------------------------------------------------
    await phase('pear stage: the deployment onto the throwaway link', async () => {
      const r = await pear?.run('stage', ['stage', '--json', link, deploy], 1500);
      if (r === undefined) throw new Error('no pear');
      pearOk('stage', r);
      const summary = lastRecord(r.records, 'summary');
      const added = lastRecord(r.records, 'addendum');
      const files = await listFiles(deploy);
      // What the drive holds, listed by the sidecar that holds it.
      const l = await pear?.run('dump-list', ['dump', '--list', '--json', link], 600);
      if (l === undefined) throw new Error('no pear');
      say(`$ pear dump --list: exit ${String(l.code)}, ${String(l.ms)} ms`);
      const keys = new Set(
        l.records.filter((x: PearRecord) => x.tag === 'file').map((x) => field(x, 'key') ?? ''),
      );
      const missing = files.filter((f) => !keys.has(`/${f}`));
      if (l.code !== 0 || missing.length > 0)
        throw new Error(
          `the drive does not list the deployment: ${String(missing.length)} of ${String(files.length)} files missing, e.g. ${missing.slice(0, 3).join(', ')}; ${tail(l.out, 4)}`,
        );
      report.staged = `${String(keys.size)} entries listed (${String(files.length)} files in the deployment), ${JSON.stringify(summary?.data['blobs'] ?? null)} blobs, ${field(added, 'verlink') ?? 'no verlink'}`;
      say(report.staged);
    });

    // ---- seed, on the private DHT ---------------------------------------------------------
    await phase('pear seed: announce on the private DHT, serve it to the installer', async () => {
      seed = pear?.start('seed', ['seed', '--no-tty', '--json', link]);
      if (seed === undefined) throw new Error('no pear');
      const s = seed;
      await waitFor('"announced" from pear seed', 240_000, () => {
        if (s.exited()) throw new Error(`pear seed exited: ${tail(s.read(), 6)}`);
        return lastRecord(parseRecords(s.read()), 'announced') === undefined ? undefined : true;
      });
      const stats = lastRecord(parseRecords(s.read()), 'stats');
      say(`announced; dht ${JSON.stringify(stats?.data['dht'] ?? null)}`);
      report.seeded = `announced on ${bootstrap}`;
      // The sidecar says which DHT it was given (its log is written a moment after the fact).
      const proof = await waitFor('the sidecar log to name its bootstrap', 90_000, () => {
        const text = existsSync(pear?.sidecarLog ?? '')
          ? readFileSync(pear?.sidecarLog ?? '', 'utf8')
          : '';
        const p = bootstrapProof(text, bootstrap);
        return p.set ? p : undefined;
      });
      report.bootstrapProof = proof;
      say(proof.lines.join('\n'));
      if (!proof.names) throw new Error(`the sidecar's bootstrap line does not name ${bootstrap}`);
      if (proof.readKnownNodes)
        throw new Error(
          'the sidecar read its known-nodes cache: it was not given the private bootstrap alone',
        );
    });

    // ---- install ---------------------------------------------------------------------------
    const installed = await phase(
      'pear install: from the private DHT, as a user would',
      async () => {
        // The folders a user who has Pear has: `pear install` moves the app into one of them and
        // does not make it (the bare-home probe below shows ENOENT), and it registers a launcher
        // only when the applications folder exists (S2).
        for (const d of process.platform === 'linux'
          ? [join('.local', 'bin'), join('.local', 'share', 'applications')]
          : process.platform === 'darwin'
            ? ['Applications']
            : [])
          mkdirSync(join(home, d), { recursive: true });
        let last: Awaited<ReturnType<Pear['run']>> | undefined;
        for (let attempt = 1; attempt <= 3; attempt++) {
          last = await pear?.run(
            `install-${String(attempt)}`,
            ['install', '--dht-bootstrap', bootstrap, '--json', '--timeout', '120', link],
            600,
          );
          if (last === undefined) throw new Error('no pear');
          if (last.code === 0 && succeeded(last.records)) break;
          if (!/ERR_NETWORK_TIMEOUT|Network Timeout/.test(last.out)) break;
          say(`attempt ${String(attempt)}: network timeout on the private DHT, again`);
        }
        if (last === undefined) throw new Error('no pear');
        try {
          pearOk('install', last);
        } catch (e) {
          if (process.platform === 'win32') say(`Windows says:\n${appxLog()}`);
          throw e;
        }
        await probeBareHome(link);
        const final = lastRecord(last.records, 'final');
        const app = lastRecord(last.records, 'app');
        if (final?.data['installed'] !== 1)
          throw new Error(`installed ${JSON.stringify(final?.data['installed'])}, not 1`);
        const dest = field(app, 'dest');
        const peers = last.records.filter((r) => r.tag === 'stats').map((r) => r.data['peers']);
        say(
          `app ${JSON.stringify(app?.data ?? null)}; peers seen ${JSON.stringify(peers.slice(-1))}`,
        );
        return { dest, app: app?.data ?? {} };
      },
    );

    // ---- stop Pear, then read the tripwire -----------------------------------------------------
    const duringPear = await phase(
      'stop the seed, the sidecar and the DHT; read the tripwire',
      async () => {
        await seed?.stop();
        const sc = await pear?.run('sidecar-shutdown', ['sidecar', 'shutdown'], 90);
        say(`sidecar shutdown: exit ${String(sc?.code)}`);
        if (sc?.code === 0) sidecarUp = false;
        if (dht !== undefined) {
          dht.stdin?.end();
          await sleep(1500);
          killTree(dht.pid);
          dht = undefined;
        }
        // A complete reading: the barrier datagram is counted after everything before it.
        const hits = await barrier(tw, process.platform === 'win32' ? 120_000 : 15_000);
        say(`tripwire: ${JSON.stringify(hits)}`);
        const n = publicBootstrapHits(hits);
        if (n !== 0)
          throw new Error(`${String(n)} packets went to the public bootstrap while Pear ran`);
        if ((hits[CANARY_IP] ?? 0) !== canary + 1)
          throw new Error(
            `the canary count is ${String(hits[CANARY_IP])}, not ${String(canary + 1)}: something else sent to the documentation address`,
          );
        report.tripwire = {
          kind: tw.kind,
          canaryCounted: hits[CANARY_IP] ?? 0,
          publicBootstrapHitsDuringPear: n,
          publicBootstrapHitsFromTheApp: 0,
        };
        return hits;
      },
    );

    // ---- the installed payload ---------------------------------------------------------------
    const installedPath = await phase('what pear install put on this machine', async () => {
      return await verifyInstalled(
        own.platform,
        o.target,
        installed.dest,
        prepared.get(o.target),
        home,
        work,
        report,
      );
    });
    report.installed = installedPath.summary;

    // ---- launch the installed app -------------------------------------------------------------
    const launched = await phase('launch the installed app; its ready line', async () => {
      const result = await launchInstalled(own.platform, installedPath.launch, home, report);
      report.ready = result.ready;
      if (!result.ok) throw new Error(`${result.reason}\n${result.tail.slice(-30).join('\n')}`);
      const bad = result.ready === null ? ['no ready fields'] : readyProblems(result.ready, 'on');
      if (bad.length > 0) throw new Error(`the ready line is wrong: ${bad.join('; ')}`);
      say(`ready ${JSON.stringify(result.ready)}`);
      return result;
    });
    report.launched = `${installedPath.launch}: ${launched.reason}`;

    // The app starts no DHT node until a play or a stored video needs one, and this one has
    // neither: a packet here would be a GitHub runner talking to the public network.
    await phase('read the tripwire again: the launched app sent nothing', async () => {
      const hits = await barrier(tw, process.platform === 'win32' ? 120_000 : 15_000);
      const total = publicBootstrapHits(hits);
      const fromApp = total - publicBootstrapHits(duringPear);
      say(`tripwire: ${JSON.stringify(hits)}`);
      say(
        `packets to the public bootstrap during Pear: 0; during the app's launch: ${String(fromApp)}`,
      );
      if (report.tripwire !== undefined)
        report.tripwire = { ...report.tripwire, publicBootstrapHitsFromTheApp: fromApp };
      if (fromApp !== 0)
        throw new Error(`${String(fromApp)} packets went to the public bootstrap from the app`);
    });

    // ---- the update gate, on two more real builds ------------------------------------------
    report.updateGate = await proveUpdateGate({
      target: o.target,
      platform: own.platform,
      arch: own.arch,
      file: own.file,
      work,
      logs,
      pearBin: fetched.bin,
      scriptsDir: SCRIPTS_DIR,
      cert,
      baseVersion: version,
      phase,
      say,
    });
    await phase(
      'read the tripwire: the update proof sent nothing to a public address',
      async () => {
        const hits = await barrier(tw, process.platform === 'win32' ? 120_000 : 15_000);
        const n = publicBootstrapHits(hits);
        say(`tripwire: ${JSON.stringify(hits)}`);
        report.publicHitsDuringGate = n;
        if (n !== 0) throw new Error(`${String(n)} packets went to a public address`);
      },
    );
  } catch (e) {
    if (!(e instanceof Handled)) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      say(`FAIL  ${msg}`);
      report.failures.push(msg.split('\n')[0] ?? msg);
    }
  } finally {
    await teardown();
  }

  async function teardown(): Promise<void> {
    say('::group::teardown');
    try {
      await seed?.stop();
      if (pear !== undefined && sidecarUp)
        await pear.run('sidecar-shutdown-final', ['sidecar', 'shutdown'], 60);
    } catch (e) {
      say(`teardown: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (dht !== undefined) killTree(dht.pid);
    if (pear !== undefined && existsSync(pear.sidecarLog)) {
      // The sidecar's own words, for the record.
      const text = readFileSync(pear.sidecarLog, 'utf8');
      copyFileSync(pear.sidecarLog, join(logs, 'sidecar-pear.log'));
      say(tail(text, 25));
      const proof = bootstrapProof(text, report.dht?.bootstrap ?? '');
      report.bootstrapProof ??= proof;
    }
    if (process.platform === 'win32') {
      try {
        removePackage(SCRIPTS_DIR);
      } catch {
        // not installed
      }
      if (cert !== undefined) removeTestCert(SCRIPTS_DIR, cert.thumbprint);
    }
    if (armed) {
      try {
        const hits = tw.read();
        say(`tripwire at the end: ${JSON.stringify(hits)}`);
        // A run that stopped early still says what the tripwire counted.
        report.tripwire ??= {
          kind: tw.kind,
          canaryCounted: hits[CANARY_IP] ?? 0,
          publicBootstrapHitsDuringPear: publicBootstrapHits(hits),
          publicBootstrapHitsFromTheApp: 0,
        };
        tw.disarm();
      } catch (e) {
        say(`tripwire: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    say('::endgroup::');
    writeSummary(work, report);
  }

  return report.failures.length === 0 ? 0 : 1;
}

interface Verified {
  readonly summary: string;
  /** What to start: the file `pear install` placed, or the alias of the installed package. */
  readonly launch: string;
}

/** Proves that what is on disk is what was staged, in the form this platform keeps it. */
async function verifyInstalled(
  platform: string,
  target: TargetName,
  dest: string | undefined,
  given: { path: string; sha256?: string; manifest?: TreeManifest } | undefined,
  home: string,
  work: string,
  report: Report,
): Promise<Verified> {
  if (given === undefined) throw new Error('no input to compare with');
  if (platform === 'linux') {
    if (dest === undefined || !existsSync(dest))
      throw new Error(`pear install says ${String(dest)}, which is not there`);
    const sha256 = await sha256File(dest);
    if (sha256 !== given.sha256)
      throw new Error(`the installed AppImage differs from the staged one (${sha256})`);
    if ((statSync(dest).mode & 0o111) === 0)
      throw new Error('the installed AppImage is not executable');
    const desktop = join(home, '.local', 'share', 'applications', `${APP.productName}.desktop`);
    if (!existsSync(desktop)) throw new Error(`no launcher entry at ${desktop}`);
    const entry = readFileSync(desktop, 'utf8');
    const exec = /^Exec=(.*)$/m.exec(entry)?.[1];
    if (exec !== dest) throw new Error(`the launcher entry runs ${String(exec)}, not ${dest}`);
    const icons = join(home, '.local', 'share', 'icons', 'hicolor');
    const nIcons = existsSync(icons) ? (await listFiles(icons)).length : 0;
    // The icon the launcher names must be one the system now has.
    const iconName = /^Icon=(.*)$/m.exec(entry)?.[1];
    if (iconName === undefined) throw new Error('the launcher entry names no icon');
    const icon = iconName.startsWith('/')
      ? iconName
      : join(icons, '512x512', 'apps', `${iconName}.png`);
    if (!existsSync(icon)) throw new Error(`the launcher's icon ${iconName} was not installed`);
    return {
      summary: `${dest} (${String(statSync(dest).size)} bytes, sha256 equal to the staged file), launcher ${desktop} runs it, ${String(nIcons)} icons`,
      launch: dest,
    };
  }
  if (platform === 'darwin') {
    if (dest === undefined || !existsSync(dest))
      throw new Error(`pear install says ${String(dest)}, which is not there`);
    const m = await treeManifest(dest);
    const diff = manifestProblems(given.manifest ?? new Map(), m);
    if (diff.length > 0)
      throw new Error(`the installed bundle differs from the staged one: ${diff.join('; ')}`);
    const s = manifestSummary(m);
    // The ad-hoc signature seals every file and every symlink of the bundle: it verifies only if
    // the round trip kept all of them. It says nothing about who signed (nobody) or Gatekeeper.
    const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', dest], {
      encoding: 'utf8',
    });
    say(
      `codesign --verify --deep --strict: exit ${String(verify.status)} ${(verify.stderr || verify.stdout).trim()}`,
    );
    if (verify.status !== 0)
      throw new Error('the installed bundle does not verify against its ad-hoc signature');
    const info = spawnSync('codesign', ['-dv', '--verbose=2', dest], { encoding: 'utf8' });
    const sig = /^Signature=(.*)$/m.exec(info.stderr)?.[1] ?? 'unknown';
    const assess = spawnSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', dest], {
      encoding: 'utf8',
    });
    report.notes.push(
      `macOS: codesign verifies the installed bundle (Signature=${sig}); spctl (Gatekeeper) says exit ${String(assess.status)}: ${(assess.stderr || assess.stdout).trim().split('\n')[0] ?? ''}. Ad-hoc proves the bytes and symlinks survived the trip; it does not prove a developer identity, notarization or that Gatekeeper accepts the app.`,
    );
    return {
      summary: `${dest}: ${String(s.files)} files and ${String(s.links)} symlinks equal to the staged bundle (tree ${s.digest}); codesign --verify --deep --strict passes (Signature=${sig})`,
      launch: join(dest, 'Contents', 'MacOS', APP.productName),
    };
  }
  // Windows: the package is registered, signed by the test publisher, and its payload is the .msix's.
  const info = packageInfo(SCRIPTS_DIR);
  const p: PackageFacts | null = info.package;
  if (p === null) throw new Error(`Windows has no package ${MSIX.identity} after pear install`);
  say(JSON.stringify(p));
  if (p.Publisher !== MSIX.publisher) throw new Error(`the package's publisher is ${p.Publisher}`);
  if (String(p.Status) !== 'Ok' && String(p.Status) !== '0')
    throw new Error(`the package's status is ${String(p.Status)}`);
  const notes: string[] = [];
  try {
    const unpack = join(work, 'msix-unpacked');
    rmSync(unpack, { recursive: true, force: true });
    const u = spawnSync(makeAppx(), ['unpack', '/p', given.path, '/d', unpack, '/o'], {
      encoding: 'utf8',
    });
    if (u.status !== 0) throw new Error(`makeappx unpack: exit ${String(u.status)}`);
    const before = await treeManifest(join(unpack, 'app'));
    const after = await treeManifest(join(p.InstallLocation, 'app'));
    const diff = manifestProblems(before, after);
    if (diff.length > 0)
      throw new Error(`the installed payload differs from the .msix: ${diff.join('; ')}`);
    notes.push(`${String(before.size)} files under app\\ equal to the .msix's`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/EPERM|EACCES|ENOENT|UNKNOWN/.test(msg)) {
      notes.push(
        `payload not compared (Windows does not let this process read ${p.InstallLocation}: ${msg.slice(0, 120)})`,
      );
      report.notes.push(notes[notes.length - 1] ?? '');
    } else throw e;
  }
  return {
    summary: `package ${p.PackageFullName}, publisher ${p.Publisher}, signature ${String(p.SignatureKind)}, status ${String(p.Status)}; ${notes.join('; ')}`,
    launch: aliasPath(),
  };
}

async function launchInstalled(
  platform: string,
  exe: string,
  home: string,
  report: Report,
): Promise<LaunchResult> {
  // The app runs in the home Pear installed it for (Linux, macOS); Windows keeps its own profile.
  const env = platform === 'win32' ? process.env : isolatedEnv(home);
  say(`launching ${exe}`);
  let processPackage: string | undefined;
  const result = await launch(exe, [], 'ready', 150, {
    env,
    ...(platform === 'win32'
      ? {
          // Whose is the running process? Windows says (a plain exe has no package).
          onReady: (pid: number): void => {
            processPackage = packageInfo(SCRIPTS_DIR, pid).processPackage ?? 'unknown';
            say(`process ${String(pid)} belongs to package: ${processPackage}`);
          },
        }
      : {}),
  });
  say(
    `${result.ok ? 'PASS' : 'FAIL'} ${result.reason} (${String(result.ms)} ms); events ${result.events.join(', ')}`,
  );
  if (platform === 'win32') {
    if (result.ok && processPackage?.startsWith(`${MSIX.identity}_`) !== true)
      return {
        ...result,
        ok: false,
        reason: `the launched process is not in the installed package (${String(processPackage)})`,
      };
    if (result.ok && processPackage !== undefined)
      report.notes.push(`Windows: the launched process runs in package ${processPackage}.`);
    if (!result.ok) await diagnoseAlias();
  }
  return result;
}

/** What is at the alias, and whether the installed file runs by its own path (Windows; a failed launch). */
async function diagnoseAlias(): Promise<void> {
  const alias = aliasPath();
  say(`alias ${alias}`);
  try {
    const st = lstatSync(alias);
    say(`lstat: ${JSON.stringify({ size: st.size, symlink: st.isSymbolicLink() })}`);
  } catch (e) {
    say(`lstat: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    say(`WindowsApps: ${readdirSync(dirname(alias)).join(', ')}`);
  } catch (e) {
    say(`WindowsApps: ${e instanceof Error ? e.message : String(e)}`);
  }
  const where = spawnSync('where.exe', ['Nutflix.exe'], { encoding: 'utf8' });
  say(`where Nutflix.exe: exit ${String(where.status)} ${where.stdout.trim()}`);
  const place = packageInfo(SCRIPTS_DIR).package?.InstallLocation;
  if (place !== undefined) {
    const direct = join(place, 'app', `${APP.productName}.exe`);
    const r = await launch(direct, [], 'ready', 60);
    say(`by its own path ${direct}: ${r.ok ? 'PASS' : 'FAIL'} ${r.reason}`);
  }
}

function writeSummary(work: string, r: Report): void {
  writeFileSync(join(work, 'result.json'), `${JSON.stringify(r, null, 2)}\n`);
  const ok = (s: string | undefined): string => (s === undefined ? 'NOT REACHED' : `ok, ${s}`);
  const md = [
    `### install (${r.target}): ${r.failures.length === 0 ? 'PASS' : 'FAIL'}`,
    '',
    '| step | result |',
    '| --- | --- |',
    `| Pear CLI | ${r.pear === undefined ? 'NOT REACHED' : `${r.pear.asset} sha256 ${r.pear.sha256} (pinned), v${r.pear.version}`} |`,
    `| private DHT | ${r.dht?.bootstrap ?? 'NOT REACHED'} |`,
    `| merged (pear build) | ${ok(r.merged)} |`,
    `| staged (pear stage) | ${ok(r.staged)} |`,
    `| seeded (pear seed) | ${ok(r.seeded)} |`,
    `| installed (pear install) | ${ok(r.installed)} |`,
    `| launched (installed app) | ${ok(r.launched)} |`,
    `| ready fields | \`${JSON.stringify(r.ready ?? null)}\` |`,
    `| public bootstrap | ${
      r.tripwire === undefined
        ? 'NOT MEASURED'
        : `${r.tripwire.kind}: canary counted ${String(r.tripwire.canaryCounted)}; packets to the public bootstrap during Pear: ${String(r.tripwire.publicBootstrapHitsDuringPear)}; during the app's launch: ${String(r.tripwire.publicBootstrapHitsFromTheApp)}`
    } |`,
    `| sidecar's bootstrap | ${r.bootstrapProof === undefined ? 'NOT READ' : `${r.bootstrapProof.set ? 'set' : 'NOT SET'}, names the private node: ${String(r.bootstrapProof.names)}, read known-nodes cache: ${String(r.bootstrapProof.readKnownNodes)}`} |`,
    `| public relays blackholed | ${r.sinkholed === undefined ? 'NOT DONE' : r.sinkholed.join(', ')} |`,
    ...(r.updateGate?.rows ?? []).map((x) => `| gate: ${x.step} | ${x.result} |`),
    `| public addresses, after the gate proof | ${r.publicHitsDuringGate === undefined ? 'NOT MEASURED' : `${String(r.publicHitsDuringGate)} packets`} |`,
    '',
    ...r.notes.map((n) => `- ${n}`),
    ...r.failures.map((f) => `- FAILED: ${f}`),
    '',
  ].join('\n');
  const file = process.env['GITHUB_STEP_SUMMARY'];
  if (file !== undefined && file !== '') appendFileSync(file, md);
  say(md);
}
