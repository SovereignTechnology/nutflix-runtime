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
 *   reverse    once the installed app on Y has played and publishes its own beacon (it seeds what
 *              it watched), both seeders here stop, and a FRESH fetcher (nutflix-pear's `dialNfx`
 *              and `FilesClient`, a new node and key, nothing stored) fetches the whole clip from
 *              the endpoint that beacon names: it can only come from Y
 *
 * Prints `REALHOST_*` lines for the orchestrator (public keys, a link, a digest: no address).
 *
 *   node shells/pear-v3/scripts/realhost/seed-side.ts --work <dir> --nonce <hex> [--wait-min 60]
 *
 * The playing machine finds this one by `--nonce` (`topicOf`): the tunnel is announced on that
 * topic from the start, and the relay's `INFO_PATH` names the link once it is seeded.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
import { dialNfx, hyperdhtEndpoint, listenNfx, nodeCrypto, type NfxFileSource } from '@sovit/seeder';

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
import type { TrustRoot } from '../../src/update/root.ts';
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
const WAIT_MS = Number(arg('wait-min', '60')) * 60_000;
const NONCE = arg('nonce');

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
    const child = spawn(process.execPath, [...args], { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('exit', resolveRun);
    child.once('error', () => {
      resolveRun(null);
    });
  });
}

/** The reverse direction: a fresh fetcher, the whole clip, from the one endpoint `beacon` names. */
async function fetchFromRuntime(
  clip: Clip,
  creator: string,
  beacon: NostrEvent,
): Promise<Record<string, unknown>> {
  const parsed = parseBeacon(beacon, Math.floor(Date.now() / 1000));
  if (!parsed.ok) return { ok: false, why: `the app's beacon does not parse: ${parsed.error.reason}` };
  const b = parsed.value;
  const addr = VideoAddr.parse(clip.video);
  if (!addr.ok) return { ok: false, why: 'the clip address' };
  if (b.creator !== creator || b.content.video.toString() !== clip.video)
    return { ok: false, why: "the app's beacon names another video" };
  const ep = b.content.endpoints.find(
    (e) => e.t === 'hyperdht' && verifyHyperdhtBind(e.peer, e.bind, b.seeder, addr.value.namespace.toString()),
  );
  if (ep === undefined || ep.t !== 'hyperdht')
    return { ok: false, why: "the app's beacon names no verified hyperdht endpoint" };
  const node = await publicNode();
  say(`fresh fetcher node: nat ${JSON.stringify(natFacts(node))}`);
  const keyPair = DHT.keyPair();
  const t = Date.now();
  const dialed = await dialNfx(node, Buffer.from(ep.peer, 'hex'), {
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
  say(`fresh fetcher dialed the app's endpoint in ${String(dialMs)} ms; remote ${JSON.stringify(remote)}`);
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
    appPeer: ep.peer,
    failed: failed.slice(0, 8),
  };
}

async function main(): Promise<number> {
  mkdirSync(WORK, { recursive: true });
  const summary: Record<string, unknown> = {};
  const order = { n: 0 };
  let honest: PublicSeeder | undefined;
  let liar: PublicSeeder | undefined;
  let relay: RealhostRelay | undefined;
  let tunnel: Awaited<ReturnType<typeof tunnelServer>> | undefined;
  let ctl: DHT | undefined;
  let stopAnnounce: (() => void) | undefined;
  let seed: ReturnType<PublicPear['start']> | undefined;
  let pear: PublicPear | undefined;
  try {
    // ---- the clip, the keys, the relay ----------------------------------------------------------
    writeClip(join(WORK, 'clip'));
    const clip = loadClip(join(WORK, 'clip'));
    say(`clip ${clip.video}: ${String(clip.files.size)} files, ${String(clip.durationSec)} s`);
    const creator = new Key();
    const addr = `38504:${creator.pubkey}:${clip.video}`;
    const rel = await RealhostRelay.start(RELAY_PORT);
    relay = rel;
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
    let seedersUp = true;
    rel.beacons = () => {
      if (!seedersUp || honest === undefined || liar === undefined) return [];
      const now = Math.floor(Date.now() / 1000);
      return [beaconOf(honest, now - 1), beaconOf(liar, now)];
    };

    // ---- the seeders and the tunnel, on the public DHT -----------------------------------------------
    honest = await startSeeder('honest', clip, false, order);
    liar = await startSeeder('liar', clip, true, order);
    ctl = await publicNode();
    tunnel = await tunnelServer(ctl, RELAY_PORT);
    stopAnnounce = announceLoop(ctl, topicOf(NONCE), tunnel.keyPair);
    say(`tunnel ${tunnel.key} on the meeting topic; node nat ${JSON.stringify(natFacts(ctl))}`);
    summary['natX'] = natFacts(ctl);

    // ---- Pear and the link ----------------------------------------------------------------------
    const fetched = await fetchPear('linux-x64', join(WORK, 'tools'));
    say(`pear CLI ${fetched.asset} sha256 ${fetched.sha256} (pinned, checked)`);
    pear = new PublicPear(fetched.bin, join(WORK, 'pear-home'), join(WORK, 'logs'));
    let touched: Awaited<ReturnType<PublicPear['run']>> | undefined;
    for (let attempt = 1; attempt <= 3 && !(touched?.code === 0 && succeeded(touched.records)); attempt++) {
      touched = await pear.run(`touch-${String(attempt)}`, ['touch', '--json'], 180);
      if (touched.code !== 0) await sleep(10_000);
    }
    const link = field(lastRecord(touched?.records ?? [], 'final'), 'link');
    if (link === undefined || !/^pear:\/\/[a-z0-9]{52}$/.test(link))
      throw new Error(`pear touch: no link: ${tail(touched?.out ?? '', 6)}`);
    say(`throwaway link ${link}`);

    // ---- the test build -----------------------------------------------------------------------------
    const releaseKey = generateSecretKey();
    const root: TrustRoot = {
      v: 1,
      channel: 'test',
      pubkey: getPublicKey(releaseKey),
      relays: [RELAY_URL],
      upgrade: link,
      dht: null,
      delayMs: 0,
      play: { relays: [RELAY_URL], video: addr },
    };
    const rootFile = join(WORK, 'trust-root.json');
    writeFileSync(rootFile, `${JSON.stringify(root)}\n`);
    const base = (JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as { version: string })
      .version;
    const version = base.replace(/\.(\d+)$/, (_m, p: string) => `.${String(Number(p) + 1)}`);
    const out = join(WORK, 'out');
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
    say(`test build ${version}: ${appImage} sha256 ${appSha}`);

    // ---- pear build, stage, seed on the public DHT ------------------------------------------------------
    const project = join(WORK, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'package.json'), deploymentPackageJson({ version }));
    const deploy = join(WORK, 'deployment');
    const built = await pear.run(
      'build',
      ['build', '--package', join(project, 'package.json'), '--target', deploy, '--json', '--linux-x64-app', appImage],
      900,
    );
    if (built.code !== 0 || !succeeded(built.records))
      throw new Error(`pear build: ${failureMessage(built.records) ?? tail(built.out, 6)}`);
    const staged = await pear.run('stage', ['stage', '--json', link, deploy], 1500);
    if (staged.code !== 0 || !succeeded(staged.records))
      throw new Error(`pear stage: ${failureMessage(staged.records) ?? tail(staged.out, 6)}`);
    const verlink = field(lastRecord(staged.records, 'addendum'), 'verlink');
    say(`staged: ${String(verlink)}`);
    seed = pear.start('seed', ['seed', '--no-tty', '--json', link]);
    const s = seed;
    const until = Date.now() + 300_000;
    while (lastRecord(parseRecords(s.read()), 'announced') === undefined) {
      if (s.exited()) throw new Error(`pear seed exited: ${tail(s.read(), 6)}`);
      if (Date.now() > until) throw new Error('pear seed never announced');
      await sleep(1000);
    }
    say('pear seed: announced on the public DHT');
    summary['link'] = link;
    summary['verlink'] = verlink;
    summary['appSha256'] = appSha;
    process.stdout.write(`REALHOST_LINK ${link}\n`);
    process.stdout.write(`REALHOST_TUNNEL ${tunnel.key}\n`);
    process.stdout.write(`REALHOST_APP_SHA256 ${appSha}\n`);
    process.stdout.write('REALHOST_READY\n');
    rel.info = { link, appSha256: appSha };

    // ---- wait for the app on the other machine ------------------------------------------------------
    const deadline = Date.now() + WAIT_MS;
    const appBeacon = (): NostrEvent | undefined =>
      [...rel.published]
        .reverse()
        .find((e) => e.kind === 20464 && e.pubkey !== honest?.key.pubkey && e.pubkey !== liar?.key.pubkey);
    let lastBeat = 0;
    let playedAt = 0;
    while (Date.now() < deadline) {
      const h = honest.log;
      const wholeMedia = h.served.filter((x) => complete(x) && isMedia(clip.roles.get(x.sha))).length;
      if (wholeMedia >= 3 && playedAt === 0) playedAt = Date.now();
      if (Date.now() - lastBeat > 20_000) {
        lastBeat = Date.now();
        say(
          `waiting: tunnel ${String(tunnel.stats.connections)} conn; honest ${String(h.dialers.size)} dialer(s), ${String(h.served.filter(complete).length)} files whole, ${String(h.bytes)} B; liar ${String(liar.log.served.filter((x) => x.bad && complete(x)).length)} bad whole; app beacons ${String(rel.published.length)}; pear seed ${s.exited() ? 'EXITED' : 'up'}`,
        );
      }
      const b = appBeacon();
      // The app plays first; its beacon comes once it serves what it stored (every 60 s).
      if (b !== undefined && playedAt !== 0 && Date.now() - playedAt > 20_000) break;
      await sleep(2000);
    }
    const playedProblems = seederProblems(honest.log, liar.log, clip.roles);
    summary['seederX'] = {
      honest: {
        dialers: honest.log.dialers.size,
        filesWhole: honest.log.served.filter(complete).length,
        bytes: honest.log.bytes,
        remotes: [...honest.remotes.values()],
      },
      liar: {
        dialers: liar.log.dialers.size,
        badWhole: liar.log.served.filter((x) => x.bad && complete(x)).length,
        bytes: liar.log.bytes,
        remotes: [...liar.remotes.values()],
      },
      problems: playedProblems,
      tunnel: tunnel.stats,
    };
    say(`test 1, X's records: ${JSON.stringify(summary['seederX'])}`);

    // ---- the reverse direction -------------------------------------------------------------------
    const b = appBeacon();
    if (b === undefined) {
      summary['reverse'] = { ok: false, why: 'the app published no beacon in time' };
    } else {
      say(`the app's beacon: ${JSON.stringify({ kind: b.kind, seeder: b.pubkey, content: JSON.parse(b.content) as unknown })}`);
      seedersUp = false;
      await honest.close();
      await liar.close();
      say('both seeders here are closed; their beacons are gone from the relay');
      const servedBefore = honest.log.served.length + liar.log.served.length;
      await sleep(5000);
      summary['reverse'] = await fetchFromRuntime(clip, creator.pubkey, b);
      summary['reverse_seedersXServedAfterClose'] =
        honest.log.served.length + liar.log.served.length - servedBefore;
    }
    say(`test 3: ${JSON.stringify(summary['reverse'])}`);
  } catch (e) {
    summary['error'] = e instanceof Error ? (e.stack ?? e.message) : String(e);
    say(`FAIL ${String(summary['error'])}`);
  } finally {
    if (relay !== undefined) {
      relay.done = true;
      say('done: telling the playing machine (status), 90 s');
      await sleep(90_000);
    }
    await seed?.stop();
    if (pear !== undefined) {
      const sc = await pear.run('sidecar-shutdown', ['sidecar', 'shutdown'], 90);
      say(`pear seed stopped; sidecar shutdown: exit ${String(sc.code)}`);
    }
    await honest?.close();
    await liar?.close();
    stopAnnounce?.();
    await tunnel?.close().catch(() => undefined);
    await ctl?.destroy().catch(() => undefined);
    await relay?.close().catch(() => undefined);
    process.stdout.write(`REALHOST_SEED_SUMMARY ${JSON.stringify(summary)}\n`);
  }
  return summary['error'] === undefined ? 0 : 1;
}

process.exitCode = await main();
setTimeout(() => process.exit(), 2000).unref();
