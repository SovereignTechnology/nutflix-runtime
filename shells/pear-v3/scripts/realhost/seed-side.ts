/**
 * The real-host proof, on the SEEDING machine (X). Never on a CI runner: it joins the public
 * HyperDHT. With `play-side.ts` on another machine, on another network:
 *
 *   world      the playback clip (`pear-ci/playback-clip.ts`), signed by a throwaway creator key
 *              made here; nutflix-pear's own NFX-12 seeder (`listenNfx`, `@sovit/seeder`) serving
 *              it on the PUBLIC DHT, honest, and a lying one whose beacon is newer (so the app
 *              dials it first) and whose init and segments have every byte flipped
 *   relay      `RealhostRelay` on this machine's 127.0.0.1:RELAY_PORT, reached from X only through
 *              the HyperDHT tunnel (`common.ts`): no public relay holds anything of this proof
 *   build      `package.ts test-build` of linux-x64 with a THROWAWAY test root: its own key, the
 *              link below, `dht: null` (the public DHT) and `play` (that relay, that video)
 *   link       `pear touch`, `pear build`, `pear stage`, `pear seed`: a throwaway link on the
 *              public DHT, which the other machine installs from
 *   test 3     once the installed app on Y has played and publishes its own beacon (it seeds what
 *              it watched), both seeders here stop, and a FRESH fetcher (nutflix-pear's `dialNfx`
 *              and `FilesClient`, a new node and key, nothing stored) fetches the whole clip from
 *              the endpoint that beacon names: it can only come from Y. Its verdict is `T3`
 *   test 2     with `--t2-video <address>`: a second test build whose root's `play` is that live
 *              video on the network's own public relays (nfxd's: read only), on its own throwaway
 *              link; the playing machine installs it and plays from what the beacons name
 *   test 4     shape (b): `shells/pear-v2/proof/realhost.ts prepare` (in the background, from the
 *              start) makes a throwaway Pear v2.6.5 line and a throwaway v2 app link on the public
 *              DHT; after test 3, two new seeders (honest and lying again) serve the same clip, and
 *              Y `pear run`s that link and plays it. X's verdict is `T4` (the seeders' records)
 *
 * Prints `REALHOST_*` lines for the orchestrator (public keys, a link, a digest: no address). Exits
 * 0 only when every test it ran passed on this side (`--no-t4`: test 4 is not run).
 *
 *   node shells/pear-v3/scripts/realhost/seed-side.ts --work <dir> --nonce <hex> [--wait-min 60]
 *        [--no-t4] [--t2-video <NFX address>] [--only-t2]
 *
 * The playing machine finds this one by `--nonce` (`topicOf`): the tunnel is announced on that
 * topic from the start, and the relay's `INFO_PATH` names the link once it is seeded.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import DHT from 'hyperdht';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import type { NostrEvent } from '@sovit/core';
import {
  VideoAddr,
  beaconTags,
  parseBeacon,
  verifyHashList,
  verifyHyperdhtBind,
  type Role,
} from '@sovit/core/nfx';
import {
  dialNfx,
  hyperdhtEndpoint,
  listenNfx,
  nodeCrypto,
  type NfxFileSource,
} from '@sovit/seeder';

import { PKG_DIR } from '../../packaging/paths.ts';
import { deploymentPackageJson } from '../pear-ci/deployment.ts';
import { writeClip } from '../pear-ci/playback-clip.ts';
import {
  PLAY_NS,
  SeederLog,
  complete,
  flipped,
  loadClip,
  seederProblems,
  type Clip,
  type Served,
} from '../pear-ci/playback.ts';
import type { PlayProof, TrustRoot } from '../../src/update/root.ts';
import {
  DEFAULT_MESH_RELAYS,
  SCOPED_RELAY,
} from '../../../../packages/renderer/src/settings/defaults.ts';
import {
  PublicPear,
  RELAY_PORT,
  RELAY_URL,
  RealhostRelay,
  addrFacts,
  fetchPear,
  field,
  hex,
  lastRecord,
  minutesArg,
  natFacts,
  parseRecords,
  publicNode,
  say,
  sleep,
  succeeded,
  failureMessage,
  tail,
  tunnelServer,
  topicOf,
  announceLoop,
  type AddrFacts,
} from './common.ts';

const argv = process.argv.slice(2);
const arg = (name: string, dflt?: string): string => {
  const i = argv.indexOf(`--${name}`);
  const v = i === -1 ? dflt : argv[i + 1];
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};
const WORK = resolve(arg('work'));
const WAIT_MS = minutesArg(arg('wait-min', '60'), 'wait-min');
const NONCE = arg('nonce');
/** Test 4 (shape b) is on unless `--no-t4` says it is not run. */
const T4 = !argv.includes('--no-t4');
/**
 * Test 2: `--t2-video <NFX address>`, a live video on the network's own relays (the app's defaults,
 * read only: nothing is published there). Absent, test 2 is not run.
 */
const T2_VIDEO = argv.includes('--t2-video') ? arg('t2-video') : undefined;
if (
  T2_VIDEO !== undefined &&
  !/^38504:[0-9a-f]{64}:nfx:testnet:1:[a-z0-9][a-z0-9-]{0,63}$/.test(T2_VIDEO)
)
  throw new Error('--t2-video is an NFX address on nfx:testnet:1');
const T2_RELAYS: readonly string[] = [SCOPED_RELAY, ...DEFAULT_MESH_RELAYS];
/** Test 2 alone (`guest.sh both --only-t2`): no clip, seeders, tunnel or tests 1, 3 and 4. */
const ONLY_T2 = argv.includes('--only-t2');

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const isMedia = (role: Role | undefined): boolean => role === 'init' || role === 'segment';

class Key {
  readonly #sk = generateSecretKey();
  readonly pubkey = getPublicKey(this.#sk);
  sign(e: { kind: number; created_at: number; tags: string[][]; content: string }): NostrEvent {
    return JSON.parse(JSON.stringify(finalizeEvent(e, this.#sk))) as NostrEvent;
  }
}

interface PublicSeeder {
  readonly name: string;
  readonly log: SeederLog;
  readonly key: Key;
  readonly node: DHT;
  readonly endpoint: ReturnType<typeof hyperdhtEndpoint>;
  /** The remote end of each connection it accepted, as facts, by watcher key. */
  readonly remotes: Map<string, AddrFacts>;
  close(): Promise<void>;
}

/** nutflix-pear's seeder (`listenNfx`) on its own node of the PUBLIC DHT. */
async function startSeeder(
  name: string,
  clip: Clip,
  liar: boolean,
  order: { n: number },
): Promise<PublicSeeder> {
  const node = await publicNode();
  const log = new SeederLog();
  const keyPair = DHT.keyPair();
  const key = new Key();
  const remotes = new Map<string, AddrFacts>();
  const source: NfxFileSource = {
    hasVideo: (v) => v.toString() === clip.video,
    file: (v, sha) => {
      const good = v.toString() === clip.video ? clip.files.get(sha) : undefined;
      if (good === undefined) return undefined;
      const bad = liar && isMedia(clip.roles.get(sha));
      const data = bad ? flipped(good) : good;
      const record: Served = { sha, seq: order.n++, bad, size: data.byteLength, sent: 0 };
      log.served.push(record);
      return {
        size: data.byteLength,
        read: (offset, length) => {
          const part = data.subarray(offset, offset + length);
          record.sent += part.byteLength;
          log.bytes += part.byteLength;
          return Promise.resolve(part);
        },
      };
    },
  };
  const listener = await listenNfx(node, {
    keyPair,
    source,
    firewall: (remotePublicKey) => {
      log.dialers.add(hex(remotePublicKey));
      return false;
    },
    onConnection: (c) => {
      const raw = (c.socket as unknown as { rawStream?: { remoteHost?: string } }).rawStream;
      remotes.set(hex(c.remotePublicKey), addrFacts(raw?.remoteHost));
    },
  });
  say(`${name} seeder up: peer ${hex(keyPair.publicKey)}; nat ${JSON.stringify(natFacts(node))}`);
  return {
    name,
    log,
    key,
    node,
    endpoint: hyperdhtEndpoint(keyPair, key.pubkey, PLAY_NS),
    remotes,
    close: async () => {
      await listener.close().catch(() => undefined);
      await node.destroy().catch(() => undefined);
    },
  };
}

/** `node <script> ...` without blocking this process's event loop (its DHT nodes must answer). */
function runNode(args: readonly string[], cwd: string): Promise<number | null> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [...args], {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('exit', resolveRun);
    child.once('error', () => {
      resolveRun(null);
    });
  });
}

/** A beacon of this clip by this creator, with a HyperDHT endpoint bound to its seeder. */
interface AppBeacon {
  readonly seeder: string;
  readonly peer: string;
  readonly createdAt: number;
  /** The endpoint types it names, counted (the proof prints nothing else of its content). */
  readonly endpointTypes: Record<string, number>;
}

/** `e` as such a beacon, or why not. Its content is read through `parseBeacon` alone. */
function appBeaconOf(e: NostrEvent, clip: Clip, creator: string): AppBeacon | string {
  const parsed = parseBeacon(e, Math.floor(Date.now() / 1000));
  if (!parsed.ok) return `does not parse: ${parsed.error.reason}`;
  const b = parsed.value;
  const addr = VideoAddr.parse(clip.video);
  if (!addr.ok) return 'the clip address';
  if (b.creator !== creator || b.content.video.toString() !== clip.video)
    return 'names another video';
  const ep = b.content.endpoints.find(
    (x) =>
      x.t === 'hyperdht' &&
      verifyHyperdhtBind(x.peer, x.bind, b.seeder, addr.value.namespace.toString()),
  );
  if (ep?.t !== 'hyperdht') return 'names no verified hyperdht endpoint';
  const endpointTypes: Record<string, number> = {};
  for (const x of b.content.endpoints) endpointTypes[x.t] = (endpointTypes[x.t] ?? 0) + 1;
  return { seeder: b.seeder, peer: ep.peer, createdAt: e.created_at, endpointTypes };
}

/** The reverse direction: a fresh fetcher, the whole clip, from the one endpoint `b` names. */
async function fetchFromRuntime(clip: Clip, b: AppBeacon): Promise<Record<string, unknown>> {
  const addr = VideoAddr.parse(clip.video);
  if (!addr.ok) return { ok: false, why: 'the clip address' };
  const node = await publicNode();
  say(`fresh fetcher node: nat ${JSON.stringify(natFacts(node))}`);
  const keyPair = DHT.keyPair();
  const t = Date.now();
  const dialed = await dialNfx(node, Buffer.from(b.peer, 'hex'), {
    keyPair,
    crypto: nodeCrypto,
    timeoutMs: 90_000,
  });
  if (!dialed.ok) {
    await node.destroy();
    return { ok: false, why: `dial: ${dialed.reason}`, dialMs: Date.now() - t };
  }
  const conn = dialed.connection;
  const raw = (conn.socket as unknown as { rawStream?: { remoteHost?: string } }).rawStream;
  const remote = addrFacts(raw?.remoteHost);
  const dialMs = Date.now() - t;
  say(
    `fresh fetcher dialed the app's endpoint in ${String(dialMs)} ms; remote ${JSON.stringify(remote)}`,
  );
  const files = conn.files(addr.value);
  if (files === undefined) {
    conn.destroy('done');
    await node.destroy();
    return { ok: false, why: 'nfx/files/1 would not open', dialMs, remote };
  }
  const grab = async (sha: string, size: number, exact: boolean): Promise<Uint8Array | string> => {
    const chunks: Uint8Array[] = [];
    const r = await files.fetch({
      sha,
      size,
      exact,
      timeoutMs: 120_000,
      sink: { write: (c) => void chunks.push(new Uint8Array(c)) },
    });
    if (!r.ok) return r.reason;
    const all = Buffer.concat(chunks);
    return sha256(all) === sha ? all : 'sha256 differs';
  };
  const list = await grab(clip.root, 16 * 1024 * 1024, false);
  if (typeof list === 'string') {
    conn.destroy('done');
    await node.destroy();
    return { ok: false, why: `the hash list: ${list}`, dialMs, remote };
  }
  const verified = verifyHashList(list, clip.root, addr.value, BigInt(clip.segs));
  if (!verified.ok) {
    conn.destroy('done');
    await node.destroy();
    return { ok: false, why: `the hash list does not verify: ${verified.error.reason}` };
  }
  let ok = 1;
  let bytes = list.byteLength;
  const failed: string[] = [];
  for (const e of verified.value.files) {
    const got = await grab(e.sha256, Number(e.size), true);
    if (typeof got === 'string') failed.push(`${e.role} ${e.sha256.slice(0, 12)}: ${got}`);
    else {
      ok += 1;
      bytes += got.byteLength;
    }
  }
  conn.destroy('done');
  await node.destroy();
  const total = verified.value.files.length + 1;
  return {
    ok: failed.length === 0,
    files: `${String(ok)} of ${String(total)} (the hash list included), each sha256-checked twice (FilesClient, and here)`,
    bytes,
    dialMs,
    totalMs: Date.now() - t,
    remote,
    appSeeder: b.seeder,
    appPeer: b.peer,
    failed: failed.slice(0, 8),
  };
}

/** The v2 link's maker (`shells/pear-v2/proof/realhost.ts prepare`), in the background. */
function startV2(): {
  result: Promise<Record<string, unknown>>;
  stop(): Promise<void>;
} {
  const script = join(PKG_DIR, '..', 'pear-v2', 'proof', 'realhost.ts');
  const child: ChildProcess = spawn(
    process.execPath,
    [script, 'prepare', '--work', join(WORK, 'v2')],
    { cwd: join(PKG_DIR, '..', '..'), stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const exited = new Promise<void>((r) => {
    child.once('exit', () => {
      r();
    });
    child.once('error', () => {
      r();
    });
  });
  const result = new Promise<Record<string, unknown>>((r) => {
    if (child.stdout === null) {
      r({ error: 'no output' });
      return;
    }
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (l) => {
      if (l.startsWith('REALHOST_V2 ')) {
        try {
          r(JSON.parse(l.slice('REALHOST_V2 '.length)) as Record<string, unknown>);
        } catch {
          r({ error: 'an unreadable REALHOST_V2 line' });
        }
      } else process.stdout.write(`${l}\n`);
    });
    void exited.then(() => {
      r({ error: 'the v2 maker exited without a link' });
    });
  });
  return {
    result,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.stdin?.end();
      await Promise.race([exited, sleep(120_000)]);
      // A no-op if it has exited meanwhile.
      child.kill('SIGKILL');
    },
  };
}

/** A link on the public DHT, seeding a throwaway test build whose root names `play`. */
interface Seeded {
  readonly link: string;
  readonly verlink: string | undefined;
  readonly appSha: string;
  readonly seed: ReturnType<PublicPear['start']>;
}

/**
 * `pear touch`, a TEST root naming that link, the public DHT and `play` (a throwaway key: its
 * notices could only come from this machine's relay), `package.ts test-build` of linux-x64, then
 * `pear build`, `pear stage` and `pear seed` on the public DHT. Each `name` has its own directory.
 */
async function seededBuild(pear: PublicPear, name: string, play: PlayProof): Promise<Seeded> {
  const dir = join(WORK, name);
  mkdirSync(dir, { recursive: true });
  let touched: Awaited<ReturnType<PublicPear['run']>> | undefined;
  for (
    let attempt = 1;
    attempt <= 3 && !(touched?.code === 0 && succeeded(touched.records));
    attempt++
  ) {
    touched = await pear.run(`${name}-touch-${String(attempt)}`, ['touch', '--json'], 180);
    if (touched.code !== 0) await sleep(10_000);
  }
  const link = field(lastRecord(touched?.records ?? [], 'final'), 'link');
  if (link === undefined || !/^pear:\/\/[a-z0-9]{52}$/.test(link))
    throw new Error(`pear touch: no link: ${tail(touched?.out ?? '', 6)}`);
  say(`${name}: throwaway link ${link}`);
  const root: TrustRoot = {
    v: 1,
    channel: 'test',
    pubkey: getPublicKey(generateSecretKey()),
    relays: [RELAY_URL],
    upgrade: link,
    dht: null,
    delayMs: 0,
    play,
  };
  const rootFile = join(dir, 'trust-root.json');
  writeFileSync(rootFile, `${JSON.stringify(root)}\n`);
  const base = (
    JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as { version: string }
  ).version;
  const version = base.replace(/\.(\d+)$/, (_m, n: string) => `.${String(Number(n) + 1)}`);
  const out = join(dir, 'out');
  const code = await runNode(
    [
      join(PKG_DIR, 'scripts', 'package.ts'),
      'test-build',
      '--platform',
      'linux',
      '--arch',
      'x64',
      '--out',
      out,
      '--update-root',
      rootFile,
      '--app-version',
      version,
      '--appimage-runtime-dir',
      join(PKG_DIR, 'out', 'appimage-runtime'),
    ],
    PKG_DIR,
  );
  if (code !== 0) throw new Error(`package.ts test-build: exit ${String(code)}`);
  const appImage = join(out, 'make', 'appimage', 'x64', 'Nutflix.AppImage');
  const appSha = sha256(readFileSync(appImage));
  say(`${name}: test build ${version}, sha256 ${appSha}`);
  const project = join(dir, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'package.json'), deploymentPackageJson({ version }));
  const deploy = join(dir, 'deployment');
  const built = await pear.run(
    `${name}-build`,
    [
      'build',
      '--package',
      join(project, 'package.json'),
      '--target',
      deploy,
      '--json',
      '--linux-x64-app',
      appImage,
    ],
    900,
  );
  if (built.code !== 0 || !succeeded(built.records))
    throw new Error(`pear build: ${failureMessage(built.records) ?? tail(built.out, 6)}`);
  const staged = await pear.run(`${name}-stage`, ['stage', '--json', link, deploy], 1500);
  if (staged.code !== 0 || !succeeded(staged.records))
    throw new Error(`pear stage: ${failureMessage(staged.records) ?? tail(staged.out, 6)}`);
  const verlink = field(lastRecord(staged.records, 'addendum'), 'verlink');
  say(`${name}: staged ${String(verlink)}`);
  const seed = pear.start(`${name}-seed`, ['seed', '--no-tty', '--json', link]);
  const until = Date.now() + 300_000;
  while (lastRecord(parseRecords(seed.read()), 'announced') === undefined) {
    if (seed.exited()) throw new Error(`pear seed exited: ${tail(seed.read(), 6)}`);
    if (Date.now() > until) {
      await seed.stop();
      throw new Error('pear seed never announced');
    }
    await sleep(1000);
  }
  say(`${name}: pear seed announced on the public DHT`);
  return { link, verlink, appSha, seed };
}

async function main(): Promise<number> {
  mkdirSync(WORK, { recursive: true });
  const summary: Record<string, unknown> = {};
  const order = { n: 0 };
  // The seeders the relay's beacons name now (test 1, then test 4's own pair).
  const live: { honest: PublicSeeder | undefined; liar: PublicSeeder | undefined } = {
    honest: undefined,
    liar: undefined,
  };
  const closed: PublicSeeder[] = [];
  let relay: RealhostRelay | undefined;
  let tunnel: Awaited<ReturnType<typeof tunnelServer>> | undefined;
  let ctl: DHT | undefined;
  let stopAnnounce: (() => void) | undefined;
  const seeds: ReturnType<PublicPear['start']>[] = [];
  let t2Prep: Promise<void> | undefined;
  let pear: PublicPear | undefined;
  let v2: ReturnType<typeof startV2> | undefined;
  const verdicts: Record<string, string> = {};
  try {
    // ---- the clip, the keys, the relay ----------------------------------------------------------
    writeClip(join(WORK, 'clip'));
    const clip = loadClip(join(WORK, 'clip'));
    say(`clip ${clip.video}: ${String(clip.files.size)} files, ${String(clip.durationSec)} s`);
    const creator = new Key();
    const addr = `38504:${creator.pubkey}:${clip.video}`;
    const rel = await RealhostRelay.start(RELAY_PORT);
    relay = rel;
    rel.state = { reverseDone: false, t4: T4 ? 'preparing' : 'off' };
    const at = Math.floor(Date.now() / 1000) - 3600;
    rel.store(
      creator.sign({
        kind: 38504,
        created_at: at,
        content: 'The real-host proof: a counter, in VP9. Throwaway keys; on no public relay.',
        tags: [
          ['d', clip.video],
          ['n', PLAY_NS],
          ['title', 'Nutflix real-host proof'],
          ['published_at', String(at)],
          ['license', 'open'],
          ['root', clip.root],
          ['segs', String(clip.segs)],
          ['duration', String(Math.round(clip.durationSec))],
          ['t', 'test'],
        ],
      }),
    );
    const beaconOf = (s: PublicSeeder, when: number): NostrEvent => {
      const tags = beaconTags(addr, when, 120);
      if (!tags.ok) throw new Error(tags.error.reason);
      return s.key.sign({
        kind: 20464,
        created_at: when,
        tags: tags.value.map((t) => [...t]),
        content: JSON.stringify({
          v: 1,
          video: clip.video,
          endpoints: [s.endpoint],
          chunks: 'all',
          price_hint: 0,
          free: true,
        }),
      });
    };
    rel.beacons = () => {
      const { honest, liar } = live;
      if (honest === undefined || liar === undefined) return [];
      const now = Math.floor(Date.now() / 1000);
      return [beaconOf(honest, now - 1), beaconOf(liar, now)];
    };
    const closeLive = async (): Promise<void> => {
      const { honest, liar } = live;
      live.honest = undefined;
      live.liar = undefined;
      for (const x of [honest, liar])
        if (x !== undefined) {
          await x.close();
          closed.push(x);
        }
    };
    const ownKeys = (): Set<string> =>
      new Set(
        [...closed, live.honest, live.liar].filter((x) => x !== undefined).map((x) => x.key.pubkey),
      );
    const records = (h: PublicSeeder, l: PublicSeeder): Record<string, unknown> => ({
      honest: {
        dialers: h.log.dialers.size,
        filesWhole: h.log.served.filter(complete).length,
        bytes: h.log.bytes,
        remotes: [...h.remotes.values()],
      },
      liar: {
        dialers: l.log.dialers.size,
        badWhole: l.log.served.filter((x) => x.bad && complete(x)).length,
        bytes: l.log.bytes,
        remotes: [...l.remotes.values()],
      },
      problems: seederProblems(h.log, l.log, clip.roles),
    });

    // `--only-t2`: test 2 alone, on the playing machine itself (`guest.sh both`): its link only.
    if (ONLY_T2) {
      if (T2_VIDEO === undefined) throw new Error('--only-t2 needs --t2-video');
      rel.state = { t4: 'off', t2: 'preparing' };
      const fetched = await fetchPear('linux-x64', join(WORK, 'tools'));
      const p = new PublicPear(fetched.bin, join(WORK, 'pear-home'), join(WORK, 'logs'));
      pear = p;
      try {
        const t2 = await seededBuild(p, 't2', { relays: [...T2_RELAYS], video: T2_VIDEO });
        seeds.push(t2.seed);
        rel.info = { t2: { link: t2.link, appSha256: t2.appSha, video: T2_VIDEO } };
        rel.state = { ...rel.state, t2: 'ready' };
        say(`test 2: link ${t2.link} seeded (its play: ${T2_VIDEO})`);
      } catch (e) {
        summary['T2prep'] = e instanceof Error ? e.message.slice(0, 600) : String(e);
        rel.state = { ...rel.state, t2: 'failed' };
        say(`test 2: no link: ${String(summary['T2prep'])}`);
      }
      const until = Date.now() + WAIT_MS;
      while (Date.now() < until && !rel.marks.includes('finished')) await sleep(2000);
      summary['marks'] = rel.marks;
      verdicts['T2-link'] = summary['T2prep'] === undefined ? 'PASS' : 'FAIL';
      return summary['T2prep'] === undefined ? 0 : 1;
    }

    // ---- the seeders and the tunnel, on the public DHT -----------------------------------------------
    const honest = await startSeeder('honest', clip, false, order);
    const liar = await startSeeder('liar', clip, true, order);
    live.honest = honest;
    live.liar = liar;
    ctl = await publicNode();
    tunnel = await tunnelServer(ctl, RELAY_PORT);
    stopAnnounce = announceLoop(ctl, topicOf(NONCE), tunnel.keyPair);
    say(`tunnel ${tunnel.key} on the meeting topic; node nat ${JSON.stringify(natFacts(ctl))}`);
    summary['natX'] = natFacts(ctl);

    // ---- Pear and the links ---------------------------------------------------------------------
    const fetched = await fetchPear('linux-x64', join(WORK, 'tools'));
    say(`pear CLI ${fetched.asset} sha256 ${fetched.sha256} (pinned, checked)`);
    const p = new PublicPear(fetched.bin, join(WORK, 'pear-home'), join(WORK, 'logs'));
    pear = p;
    const t1 = await seededBuild(p, 't1', { relays: [RELAY_URL], video: addr });
    seeds.push(t1.seed);
    summary['link'] = t1.link;
    summary['verlink'] = t1.verlink;
    summary['appSha256'] = t1.appSha;
    process.stdout.write(`REALHOST_LINK ${t1.link}\n`);
    process.stdout.write(`REALHOST_TUNNEL ${tunnel.key}\n`);
    process.stdout.write(`REALHOST_APP_SHA256 ${t1.appSha}\n`);
    process.stdout.write('REALHOST_READY\n');
    rel.info = { link: t1.link, appSha256: t1.appSha, addr };
    const s = t1.seed;

    // Test 2's link, made while test 1 runs: a test root whose `play` is nfxd's live video on the
    // network's own public relays (a root on the public DHT may name them, `src/update/root.ts`).
    if (T2_VIDEO !== undefined) {
      rel.state = { ...rel.state, t2: 'preparing' };
      t2Prep = seededBuild(p, 't2', { relays: [...T2_RELAYS], video: T2_VIDEO }).then(
        (t2) => {
          seeds.push(t2.seed);
          rel.info = { ...rel.info, t2: { link: t2.link, appSha256: t2.appSha, video: T2_VIDEO } };
          rel.state = { ...rel.state, t2: 'ready' };
          say(`test 2: link ${t2.link} seeded (its play: ${T2_VIDEO})`);
        },
        (e: unknown) => {
          summary['T2prep'] = e instanceof Error ? e.message.slice(0, 600) : String(e);
          rel.state = { ...rel.state, t2: 'failed' };
          say(`test 2: no link: ${String(summary['T2prep'])}`);
        },
      );
    }

    // Test 4's link, made while test 1 runs: Pear v2's own fetch, copy and stage take a while.
    if (T4) v2 = startV2();

    // ---- test 1: wait for the app on the other machine ---------------------------------------------
    const deadline = Date.now() + WAIT_MS;
    const appBeacon = (): AppBeacon | undefined => {
      const own = ownKeys();
      let best: AppBeacon | undefined;
      for (const e of rel.published) {
        if (e.kind !== 20464 || own.has(e.pubkey)) continue;
        const b = appBeaconOf(e, clip, creator.pubkey);
        if (typeof b !== 'string' && (best === undefined || b.createdAt >= best.createdAt))
          best = b;
      }
      return best;
    };
    let lastBeat = 0;
    let playedAt = 0;
    while (Date.now() < deadline) {
      const h = honest.log;
      const wholeMedia = h.served.filter(
        (x) => complete(x) && isMedia(clip.roles.get(x.sha)),
      ).length;
      if (wholeMedia >= 3 && playedAt === 0) playedAt = Date.now();
      if (Date.now() - lastBeat > 20_000) {
        lastBeat = Date.now();
        say(
          `waiting: tunnel ${String(tunnel.stats.connections)} conn; honest ${String(h.dialers.size)} dialer(s), ${String(h.served.filter(complete).length)} files whole, ${String(h.bytes)} B; liar ${String(liar.log.served.filter((x) => x.bad && complete(x)).length)} bad whole; beacons published ${String(rel.published.length)}; pear seed ${s.exited() ? 'EXITED' : 'up'}`,
        );
      }
      // The app plays first; its beacon comes once it serves what it stored (every 60 s).
      if (appBeacon() !== undefined && playedAt !== 0 && Date.now() - playedAt > 20_000) break;
      // The app on Y has stopped (or never ran): nothing more is coming from it.
      if (rel.marks.includes('t1-failed') || rel.marks.includes('t1-ended')) break;
      await sleep(2000);
    }
    summary['seederX'] = { ...records(honest, liar), tunnel: tunnel.stats };
    const t1Problems = seederProblems(honest.log, liar.log, clip.roles);
    verdicts['T1'] = t1Problems.length === 0 ? 'PASS' : 'FAIL';
    say(`test 1, X's records: ${verdicts['T1']} ${JSON.stringify(summary['seederX'])}`);

    // ---- test 3: the reverse direction ------------------------------------------------------------
    const b = appBeacon();
    const rejected = rel.published
      .filter((e) => !ownKeys().has(e.pubkey))
      .map((e) => appBeaconOf(e, clip, creator.pubkey))
      .filter((x) => typeof x === 'string');
    if (b === undefined) {
      summary['T3'] = {
        verdict: 'FAIL',
        problems: [
          'no beacon of this clip with a verified hyperdht endpoint came from the app in time',
        ],
        otherBeacons: rejected.length,
        rejectedBecause: [...new Set(rejected)].slice(0, 4),
      };
    } else {
      say(
        `the app's beacon: ${JSON.stringify({ seeder: b.seeder, peer: b.peer, endpointTypes: b.endpointTypes })}`,
      );
      await closeLive();
      say('both seeders here are closed; their beacons are gone from the relay');
      const servedBefore = honest.log.served.length + liar.log.served.length;
      await sleep(5000);
      const reverse = await fetchFromRuntime(clip, b);
      const servedAfter = honest.log.served.length + liar.log.served.length - servedBefore;
      const remote = reverse['remote'] as AddrFacts | undefined;
      const why: string[] = [];
      if (reverse['ok'] !== true)
        why.push(`the fetch: ${typeof reverse['why'] === 'string' ? reverse['why'] : 'failed'}`);
      if (servedAfter !== 0)
        why.push(`X's own seeders served ${String(servedAfter)} files after closing`);
      if (remote?.known !== true) why.push('the remote end of the dial is unknown');
      else if (remote.isThisMachine === true) why.push('the remote end is this machine');
      summary['T3'] = {
        ...reverse,
        verdict: why.length === 0 ? 'PASS' : 'FAIL',
        problems: why,
        seedersXServedAfterClose: servedAfter,
      };
    }
    verdicts['T3'] = (summary['T3'] as { verdict: string }).verdict;
    rel.state = { ...rel.state, reverseDone: true };
    say(`test 3: ${JSON.stringify(summary['T3'])}`);

    // ---- test 4: shape (b), the same clip from two new seeders -------------------------------------
    if (v2 !== undefined) {
      await closeLive();
      const made: Record<string, unknown> = await Promise.race([
        v2.result,
        sleep(Math.max(0, deadline - Date.now())).then((): Record<string, unknown> => ({
          error: 'not ready in time',
        })),
      ]);
      if (typeof made['verlink'] !== 'string' || typeof made['line'] !== 'object') {
        summary['T4'] = { verdict: 'FAIL', problems: [`the v2 link: ${String(made['error'])}`] };
        rel.state = { ...rel.state, t4: 'failed' };
      } else {
        const h4 = await startSeeder('honest-4', clip, false, order);
        const l4 = await startSeeder('liar-4', clip, true, order);
        live.honest = h4;
        live.liar = l4;
        rel.info = { ...rel.info, v2: { line: made['line'], verlink: made['verlink'] } };
        rel.state = { ...rel.state, t4: 'ready' };
        say(`test 4: v2 link ${made['verlink']} seeded; two new seeders up`);
        let beat4 = 0;
        while (Date.now() < deadline && !rel.marks.includes('t4-done')) {
          if (Date.now() - beat4 > 30_000) {
            beat4 = Date.now();
            say(
              `test 4 waiting: honest ${String(h4.log.dialers.size)} dialer(s), ${String(h4.log.served.filter(complete).length)} files whole; liar ${String(l4.log.served.filter((x) => x.bad && complete(x)).length)} bad whole`,
            );
          }
          await sleep(2000);
        }
        const rec = records(h4, l4);
        const problems = rec['problems'] as string[];
        summary['T4'] = { ...rec, verdict: problems.length === 0 ? 'PASS' : 'FAIL' };
      }
      verdicts['T4'] = (summary['T4'] as { verdict: string }).verdict;
      say(`test 4, X's records: ${JSON.stringify(summary['T4'])}`);
    }

    // ---- the playing machine says when it is done (test 2 needs nothing here) ----------------------
    while (Date.now() < deadline && !rel.marks.includes('finished')) await sleep(2000);
    summary['marks'] = rel.marks;
  } catch (e) {
    summary['error'] = e instanceof Error ? (e.stack ?? e.message) : String(e);
    say(`FAIL ${String(summary['error'])}`);
  } finally {
    if (relay !== undefined) {
      relay.done = true;
      say('done: telling the playing machine (status), 90 s');
      await sleep(90_000);
    }
    await v2?.stop();
    // Test 2's link may still be on its way: its seed is stopped with the others.
    if (t2Prep !== undefined) await Promise.race([t2Prep, sleep(600_000)]);
    for (const x of seeds) await x.stop();
    if (pear !== undefined) {
      const sc = await pear.run('sidecar-shutdown', ['sidecar', 'shutdown'], 90);
      say(`pear seed stopped; sidecar shutdown: exit ${String(sc.code)}`);
    }
    for (const x of [live.honest, live.liar]) await x?.close();
    stopAnnounce?.();
    await tunnel?.close().catch(() => undefined);
    await ctl?.destroy().catch(() => undefined);
    await relay?.close().catch(() => undefined);
    summary['verdicts'] = verdicts;
    process.stdout.write(`REALHOST_SEED_SUMMARY ${JSON.stringify(summary)}\n`);
  }
  const failed = Object.values(verdicts).some((v) => v !== 'PASS');
  return summary['error'] === undefined && !failed && verdicts['T1'] !== undefined ? 0 : 1;
}

process.exitCode = await main();
setTimeout(() => process.exit(), 2000).unref();
