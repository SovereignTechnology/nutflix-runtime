/**
 * The install job's packaged-playback proof, on the runner's side (`update-proof.ts` calls it). The
 * installed app is build A of the update proof: a real package (`package.ts test-build`), installed
 * by a real `pear install` from the private DHT. Its baked TEST root carries `play`: this world's
 * relay and video (`src/update/root.ts`; `src/main/play-proof.ts` is the app's side). On loopback:
 *
 *   relay     nutflix-pear's e2e relay (`packages/renderer/e2e/helpers/relay.ts`): the signed
 *             kind-38504 manifest, and each seeder's live beacon (kind 20464) on every subscription
 *   honest    nutflix-pear's own NFX-12 seeder (`listenNfx`) on the private DHT, serving the clip
 *   liar      the same, whose beacon is newer (so the app dials it first), serving the hash list and
 *             the playlists as they are but every init and segment with each byte flipped
 *   clip      a real VP9 package (`playback-clip.ts`), every file checked here against its hash list
 *
 * What passes is decided HERE, from measurements: the app reports what Chromium counted in its
 * `<video>` (media time, `getVideoPlaybackQuality()` frames, size, error, what it plays from) and how
 * many of the window's requests left loopback; the seeders report who dialed them and every file they
 * handed out, in order. The sha256 check is proved by the liar: each file it served wrong must have
 * been fetched again, later, from the honest seeder, and the video must still play.
 *
 * Then the refusal: a release-shaped build of this target carries no `play` and no DHT in either
 * bundle, and every path that could put one into a release refuses it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import DHT from 'hyperdht';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import type { NostrEvent } from '@sovit/core';
import { VideoAddr, beaconTags, verifyHashList, type Role } from '@sovit/core/nfx';
import {
  hyperdhtEndpoint,
  listenNfx,
  type HyperdhtEndpoint,
  type NfxFileSource,
} from '@sovit/seeder';

import { TestRelay } from '../../../../packages/renderer/e2e/helpers/relay.ts';
import { STAGED } from '../../packaging/identity.ts';
import { PKG_DIR } from '../../packaging/paths.ts';
import { bakedRootIn, releaseRoot } from '../../packaging/update-root.ts';
import type { PlayPath } from '../../src/main/play-proof.ts';
import { TrustRootError, parseTrustRoot, type PlayProof } from '../../src/update/root.ts';
import { readPackaged } from '../release/inspect.ts';
import { throwawayLaunchRoot } from '../release/launch-subject.ts';
import { launch, stopLine } from '../smoke.ts';

/** The network the test builds play on (the renderer's own, `settings/defaults.ts`). */
export const PLAY_NS = 'nfx:testnet:1';
export const CLIP_FILE = 'clip.json';
export const CLIP_SECONDS = 20;
export const CLIP_WIDTH = 320;
export const CLIP_HEIGHT = 240;
/** Media time a play must advance while it is measured (`play-proof.ts` watches 6 s), seconds. */
export const MIN_ADVANCE_S = 4;
/** Frames Chromium must count while it is measured: 3 s of the clip's 25 fps. */
export const MIN_FRAMES = 75;
/** Frames decoded in all (counted minus dropped): 4 s of it. */
export const MIN_DECODED = 100;
/** What each path must play from: the worker's stream, or a MediaSource fed by nfx's player. */
export const SOURCE_OF: Readonly<Record<PlayPath, string>> = {
  progressive: 'progressive',
  webrtc: 'mse',
};

const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

// ---- the clip ----------------------------------------------------------------------------------

/** `clip.json`, as `playback-clip.ts` writes it. */
export interface ClipFile {
  readonly v: 1;
  /** `nfx:testnet:1:<video id>`. */
  readonly video: string;
  /** The hash list's sha256: the manifest's `root`. */
  readonly root: string;
  /** Files the hash list names. */
  readonly segs: number;
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  /** Every file's sha256, the hash list's included: `<dir>/<sha256>`. */
  readonly files: readonly string[];
}

export interface Clip {
  readonly video: string;
  readonly root: string;
  readonly segs: number;
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** What each file is, by the verified hash list. */
  readonly roles: ReadonlyMap<string, Role>;
}

/** Reads the clip and checks it as a watcher would: the hash list against `root`, each file by sha256. */
export function loadClip(dir: string): Clip {
  const raw: unknown = JSON.parse(readFileSync(join(dir, CLIP_FILE), 'utf8'));
  const c = (raw ?? {}) as Partial<Record<keyof ClipFile, unknown>>;
  const { video, root, segs, durationSec, width, height } = c;
  const files: unknown[] = Array.isArray(c.files) ? c.files : [];
  if (
    c.v !== 1 ||
    typeof video !== 'string' ||
    typeof root !== 'string' ||
    !HEX64.test(root) ||
    typeof segs !== 'number' ||
    !Number.isSafeInteger(segs) ||
    typeof durationSec !== 'number' ||
    durationSec < MIN_ADVANCE_S * 2 ||
    width !== CLIP_WIDTH ||
    height !== CLIP_HEIGHT ||
    !Array.isArray(c.files) ||
    files.length > 256 ||
    files.some((f) => typeof f !== 'string' || !HEX64.test(f))
  )
    throw new Error(`${CLIP_FILE} is not a clip`);
  const bytes = new Map<string, Uint8Array>();
  for (const sha of files as string[]) {
    const b = new Uint8Array(readFileSync(join(dir, sha)));
    if (sha256(b) !== sha) throw new Error(`the clip's file ${sha} is not its own sha256`);
    bytes.set(sha, b);
  }
  const addr = VideoAddr.parse(video);
  if (!addr.ok || addr.value.namespace.toString() !== PLAY_NS)
    throw new Error(`${video} is not a video on ${PLAY_NS}`);
  const listBytes = bytes.get(root);
  if (listBytes === undefined) throw new Error('the clip has no hash list');
  const list = verifyHashList(listBytes, root, addr.value, BigInt(segs));
  if (!list.ok) throw new Error(`the clip's hash list does not verify: ${list.error.reason}`);
  const roles = new Map<string, Role>();
  for (const e of list.value.files) {
    if (bytes.get(e.sha256)?.byteLength !== Number(e.size))
      throw new Error(`the clip has no file of the right size for ${e.name}`);
    roles.set(e.sha256, e.role);
  }
  if (bytes.size !== roles.size + 1)
    throw new Error('the clip holds a file its hash list does not name');
  return {
    video,
    root,
    segs,
    durationSec,
    width: CLIP_WIDTH,
    height: CLIP_HEIGHT,
    files: bytes,
    roles,
  };
}

// ---- the world: a relay and two seeders on the private DHT -------------------------------------

class Key {
  readonly #sk = generateSecretKey();
  readonly pubkey = getPublicKey(this.#sk);

  sign(e: {
    readonly kind: number;
    readonly created_at: number;
    readonly tags: readonly (readonly string[])[];
    readonly content: string;
  }): NostrEvent {
    const signed = finalizeEvent(
      {
        kind: e.kind,
        created_at: e.created_at,
        tags: e.tags.map((t) => [...t]),
        content: e.content,
      },
      this.#sk,
    );
    return JSON.parse(JSON.stringify(signed)) as NostrEvent;
  }
}

/** One file a seeder was asked for: `seq` orders the two seeders' records against each other. */
export interface Served {
  readonly sha: string;
  readonly seq: number;
  /** Its bytes were not the file's (the liar's init and segments). */
  readonly bad: boolean;
  readonly size: number;
  /** How many of its bytes were read out to the watcher. */
  sent: number;
}

/** Every byte of it went out: the watcher had all of it to check. */
export const complete = (s: Pick<Served, 'sent' | 'size'>): boolean => s.sent >= s.size;

export class SeederLog {
  /** The watcher keys that dialed this seeder, hex. */
  readonly dialers = new Set<string>();
  readonly served: Served[] = [];
  bytes = 0;
}

/** Bytes that are not `b`, of its size. */
export function flipped(b: Uint8Array): Uint8Array {
  return b.map((x) => x ^ 0xff);
}

interface Seeder {
  readonly log: SeederLog;
  readonly key: Key;
  readonly endpoint: HyperdhtEndpoint;
  close(): Promise<void>;
}

const isMedia = (role: Role | undefined): boolean => role === 'init' || role === 'segment';

async function startSeeder(
  nodes: readonly { host: string; port: number }[],
  clip: Clip,
  liar: boolean,
  order: { n: number },
  log: SeederLog,
): Promise<Seeder> {
  // Bound to 127.0.0.1, as the app's worker is on a loopback testnet: on one host, hyperdht
  // connects two peers only when they bind alike (packages/worker/src/net/no-local-addresses.ts).
  const dht = new DHT({ bootstrap: [...nodes], host: '127.0.0.1' });
  await dht.fullyBootstrapped();
  const keyPair = DHT.keyPair();
  const key = new Key();
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
  const listener = await listenNfx(dht, {
    keyPair,
    source,
    firewall: (remotePublicKey) => {
      log.dialers.add(Buffer.from(remotePublicKey).toString('hex'));
      return false;
    },
  });
  return {
    log,
    key,
    endpoint: hyperdhtEndpoint(keyPair, key.pubkey, PLAY_NS),
    close: async () => {
      await listener.close().catch(() => undefined);
      await dht.destroy().catch(() => undefined);
    },
  };
}

export interface PlaybackWorld {
  /** What the test root carries: this relay and this video. */
  readonly play: PlayProof;
  readonly honest: SeederLog;
  readonly liar: SeederLog;
  /** Every subscription the relay answered (the app's catalog and beacon reads among them). */
  readonly relay: TestRelay;
  /**
   * Starts the two seeders on the private DHT (once), and from then on the relay carries their
   * beacons. Apart from the relay because the job's process blocks for minutes while it packages
   * the builds, and a DHT node that cannot answer that long is not one to dial right after.
   */
  startSeeders(): Promise<{ readonly honest: string; readonly liar: string }>;
  close(): Promise<void>;
}

/** `127.0.0.1:<port>,…` as hyperdht takes it. Loopback only. */
export function loopbackNodes(bootstrap: string): { host: string; port: number }[] {
  const nodes = bootstrap.split(',').map((n) => {
    const m = /^127\.0\.0\.1:([0-9]{2,5})$/.exec(n);
    if (m === null) throw new Error(`${n} is not a node on 127.0.0.1`);
    return { host: '127.0.0.1', port: Number(m[1]) };
  });
  if (nodes.length === 0) throw new Error('no bootstrap');
  return nodes;
}

/**
 * The relay, with the clip's signed manifest, at once; the seeders on `startSeeders`. Each seeder's
 * peer key (hex) is what `startSeeders` resolves with, and what its beacon names.
 */
export async function startPlaybackWorld(bootstrap: string, clip: Clip): Promise<PlaybackWorld> {
  const nodes = loopbackNodes(bootstrap);
  const order = { n: 0 };
  const honestLog = new SeederLog();
  const liarLog = new SeederLog();
  let seeders: { honest: Seeder; liar: Seeder } | null = null;
  let starting: Promise<{ honest: Seeder; liar: Seeder }> | null = null;
  const creator = new Key();
  const addr = `38504:${creator.pubkey}:${clip.video}`;
  const beacon = (s: Seeder, at: number): NostrEvent => {
    const tags = beaconTags(addr, at, 120);
    if (!tags.ok) throw new Error(tags.error.reason);
    return s.key.sign({
      kind: 20464,
      created_at: at,
      tags: tags.value,
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
  const relay = await TestRelay.start({
    beaconEveryMs: 2_000,
    // The liar's beacon is the newer one, so the app lists it first and dials it first.
    beacon: () => {
      if (seeders === null) return [];
      const at = Math.floor(Date.now() / 1000);
      return [beacon(seeders.honest, at - 1), beacon(seeders.liar, at)];
    },
  });
  const at = Math.floor(Date.now() / 1000) - 3600;
  relay.store(
    creator.sign({
      kind: 38504,
      created_at: at,
      content: 'The install job’s packaged-playback proof: a counter, in VP9.',
      tags: [
        ['d', clip.video],
        ['n', PLAY_NS],
        ['title', 'Nutflix packaged-playback proof'],
        ['published_at', String(at)],
        ['license', 'open'],
        ['root', clip.root],
        ['segs', String(clip.segs)],
        ['duration', String(Math.round(clip.durationSec))],
        ['t', 'test'],
      ],
    }),
  );
  return {
    play: Object.freeze({ relays: Object.freeze([relay.url]), video: addr }),
    honest: honestLog,
    liar: liarLog,
    relay,
    startSeeders: async () => {
      starting ??= (async () => {
        const honest = await startSeeder(nodes, clip, false, order, honestLog);
        const liar = await startSeeder(nodes, clip, true, order, liarLog).catch(
          async (e: unknown) => {
            await honest.close();
            throw e;
          },
        );
        return { honest, liar };
      })();
      const s = await starting;
      seeders = s;
      return { honest: s.honest.endpoint.peer, liar: s.liar.endpoint.peer };
    },
    close: async () => {
      await relay.close().catch(() => undefined);
      const s = seeders ?? (starting === null ? null : await starting.catch(() => null));
      await s?.honest.close();
      await s?.liar.close();
    },
  };
}

// ---- what passes ---------------------------------------------------------------------------------

const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : Number.NaN);

/**
 * What is wrong with one `play-proof` report for `path` (empty: it played, measured). `first`: the
 * run's first play, whose page loaded with the renderer's defaults before the proof's settings; any
 * later one must have had nothing off loopback before it either.
 */
export function playProblems(
  m: Readonly<Record<string, unknown>> | undefined,
  path: PlayPath,
  clip: Pick<Clip, 'width' | 'height'>,
  first = path === 'progressive',
): string[] {
  if (m === undefined) return [`${path}: no report`];
  if (m['stage'] !== 'measured') return [`${path}: stopped at ${JSON.stringify(m['stage'])}`];
  const out: string[] = [];
  const want = (ok: boolean, what: string): void => {
    if (!ok) out.push(`${path}: ${what}`);
  };
  const frames = n(m['frames1']) - n(m['frames0']);
  const decoded = n(m['frames1']) - n(m['dropped']);
  want(
    m['source'] === SOURCE_OF[path],
    `plays from ${JSON.stringify(m['source'])}, not ${SOURCE_OF[path]}`,
  );
  want(
    n(m['advanced']) >= MIN_ADVANCE_S,
    `media time advanced ${String(m['advanced'])} s, under ${String(MIN_ADVANCE_S)}`,
  );
  want(
    frames >= MIN_FRAMES,
    `${String(frames)} frames counted while measured, under ${String(MIN_FRAMES)}`,
  );
  want(decoded >= MIN_DECODED, `${String(decoded)} frames decoded, under ${String(MIN_DECODED)}`);
  want(
    m['width'] === clip.width && m['height'] === clip.height,
    `the frame is ${String(m['width'])}x${String(m['height'])}`,
  );
  want(m['error'] === 0, `media error ${String(m['error'])}`);
  want(
    m['offLoopback'] === 0,
    `${String(m['offLoopback'])} requests left loopback during the play`,
  );
  if (!first)
    want(
      m['offLoopbackBefore'] === 0,
      `${String(m['offLoopbackBefore'])} requests left loopback before the play`,
    );
  return out;
}

/**
 * What the seeders' own records say is wrong: the honest seeder must have been dialed and have sent
 * the init and segments whole; the liar must have sent at least one file wrong, every byte of it
 * (so the app had it all to check), and every file it sent wrong must have been sent again, later
 * and whole, by the honest seeder: the app refused the bad copy.
 */
export function seederProblems(
  honest: Pick<SeederLog, 'dialers' | 'served'>,
  liar: Pick<SeederLog, 'served'>,
  roles: ReadonlyMap<string, Role>,
): string[] {
  const out: string[] = [];
  if (honest.dialers.size === 0) out.push('the honest seeder was never dialed');
  const whole = honest.served.filter(complete);
  const inits = whole.filter((s) => roles.get(s.sha) === 'init').length;
  const segs = new Set(whole.filter((s) => roles.get(s.sha) === 'segment').map((s) => s.sha));
  if (inits === 0) out.push('the honest seeder never sent the init whole');
  if (segs.size < 2) out.push(`the honest seeder sent ${String(segs.size)} segments whole`);
  // Only a bad file sent whole proves anything: a transfer cut short was never checked.
  const bad = liar.served.filter((s) => s.bad && complete(s));
  if (bad.length === 0)
    out.push('the liar sent no bad file whole: nothing proved the sha256 check');
  for (const b of bad)
    if (!whole.some((h) => h.sha === b.sha && h.seq > b.seq))
      out.push(
        `${b.sha.slice(0, 12)}…, sent wrong by the liar, was never sent again whole by the honest seeder`,
      );
  return out;
}

// ---- the launch ----------------------------------------------------------------------------------

export interface PlaybackContext {
  readonly world: PlaybackWorld;
  readonly clip: Clip;
  /** How the installed app is started, and with what environment. */
  readonly exe: string;
  readonly env: NodeJS.ProcessEnv;
  phase<T>(title: string, fn: () => Promise<T> | T): Promise<T>;
  say(line: string): void;
  row(step: string, result: string): void;
}

const fmt = (x: unknown): string => (typeof x === 'number' ? String(x) : JSON.stringify(x));

/** Launches the installed app once; it must find, fetch and play the clip on both paths. */
export async function provePlayback(p: PlaybackContext): Promise<void> {
  const { world, clip } = p;
  await p.phase(
    'playback: the installed app finds the video on the loopback relay, fetches it over the private DHT and plays it',
    async () => {
      const peers = await world.startSeeders();
      p.say(
        `seeders up on the private DHT: honest ${peers.honest}, liar ${peers.liar} (its beacon is the newer)`,
      );
      const servedBefore = { honest: world.honest.served.length, liar: world.liar.served.length };
      const r = await launch(p.exe, [], 'ready', 420, {
        env: p.env,
        updates: 'on',
        waitFor: 'play-proof-done',
        collect: ['play-proof', 'play-proof-done'],
      });
      for (const e of r.collected) p.say(`${e.name} ${JSON.stringify(e.fields)}`);
      p.say(`events: ${r.events.join(', ')}; stop: ${stopLine(r.stopped)}`);
      if (!r.ok) throw new Error(`${r.reason}\n${r.tail.slice(-40).join('\n')}`);
      const byPath = (path: PlayPath): Record<string, unknown> | undefined =>
        r.collected.find((e) => e.name === 'play-proof' && e.fields['path'] === path)?.fields;
      const done = r.collected.find((e) => e.name === 'play-proof-done')?.fields;
      const problems = [
        ...playProblems(byPath('progressive'), 'progressive', clip),
        ...playProblems(byPath('webrtc'), 'webrtc', clip),
      ];
      if (done?.['offLoopback'] !== 0)
        problems.push(
          `${String(done?.['offLoopback'])} requests left loopback after the last play`,
        );
      const honest = {
        dialers: world.honest.dialers,
        served: world.honest.served.slice(servedBefore.honest),
      };
      const liar = { served: world.liar.served.slice(servedBefore.liar) };
      problems.push(...seederProblems(honest, liar, clip.roles));
      p.say(
        `honest seeder: ${String(honest.dialers.size)} watcher key(s), ${String(honest.served.length)} files asked for (${String(honest.served.filter(complete).length)} sent whole), ${String(world.honest.bytes)} bytes read out; liar: ${String(liar.served.length)} asked for, ${String(liar.served.filter((s) => s.bad && complete(s)).length)} sent wrong and whole; relay subscriptions ${String(world.relay.reqs.length)}`,
      );
      if (problems.length > 0) throw new Error(problems.join('; '));
      for (const path of ['progressive', 'webrtc'] as const) {
        const m = byPath(path) ?? {};
        p.row(
          `playback (${path})`,
          `${path === 'progressive' ? "the worker's progressive stream" : "nfx's web player on the worker's origin (a MediaSource)"}: media time ${fmt(m['t0'])} → ${fmt(m['t1'])} s (+${fmt(m['advanced'])}), ${String(n(m['frames1']) - n(m['frames0']))} frames counted in ${fmt(m['measureMs'])} ms, ${String(n(m['frames1']) - n(m['dropped']))} decoded in all (${fmt(m['dropped'])} dropped), ${fmt(m['width'])}x${fmt(m['height'])}, no media error, first frame ${fmt(m['waitMs'])} ms after Play, window visible ${fmt(m['visible'])}; requests off loopback: 0 (before the proof's settings: ${fmt(m['offLoopbackBefore'])})`,
        );
      }
      const bad = liar.served.filter((s) => s.bad && complete(s));
      p.row(
        'sha256 check',
        `the liar (dialed first) sent ${String(bad.length)} file(s) whole with every byte flipped (${[...new Set(bad.map((b) => clip.roles.get(b.sha)))].join(', ')}); the app refused each and got it again, whole, from the honest seeder, and the video played`,
      );
      const roleCount = (role: Role): number =>
        new Set(
          honest.served
            .filter((s) => complete(s) && clip.roles.get(s.sha) === role)
            .map((s) => s.sha),
        ).size;
      p.row(
        'seeder',
        `the honest seeder was dialed (its firewall saw ${String(honest.dialers.size)} watcher key(s); nothing else on the private DHT dials it) and sent ${String(honest.served.filter(complete).length)} files whole (${String(roleCount('init'))} init, ${String(roleCount('segment'))} distinct segments, ${String(roleCount('playlist') + roleCount('playlist-master'))} playlists), ${String(world.honest.bytes)} bytes in all`,
      );
    },
  );
}

// ---- the refusal ----------------------------------------------------------------------------------

export interface RefusalContext {
  /** The release-shaped package of this target: the `shell` job's (`package.ts build`). */
  readonly releaseShaped: string;
  /** Build A's unpacked app (`resources/app`), whose root carries `play`. */
  readonly testApp: string;
  readonly play: PlayProof;
  readonly platform: string;
  readonly arch: string;
  /** A scratch directory. */
  readonly work: string;
  phase<T>(title: string, fn: () => Promise<T> | T): Promise<T>;
  say(line: string): void;
  row(step: string, result: string): void;
}

function refusedWith(f: () => unknown, words: string): void {
  try {
    f();
  } catch (e) {
    if (e instanceof TrustRootError && e.message.includes(words)) return;
    throw new Error(`refused for another reason: ${e instanceof Error ? e.message : String(e)}`);
  }
  throw new Error(`not refused (wanted: ${words})`);
}

/** Runs a script of this package; it must exit `code` and say `words` on stderr. */
function cliRefuses(script: string, args: readonly string[], code: number, words: string): void {
  const r = spawnSync(process.execPath, [join(PKG_DIR, 'scripts', ...script.split('/')), ...args], {
    cwd: PKG_DIR,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (r.status !== code || !r.stderr.includes(words))
    throw new Error(
      `${script} ${args[0] ?? ''}: exit ${String(r.status)}, wanted ${String(code)} and "${words}": ${r.stderr.slice(-400)}`,
    );
}

/**
 * A release-shaped build cannot carry the playback proof: this target's release build holds the
 * production root in main and the updater (no DHT, no `play`), the parser refuses `play` in a release
 * root and a launch root, the release commands take no root, `test-build` refuses a release root
 * with `play`, and `verify-root` refuses build A and a release updater spliced with build A's main.
 */
export async function proveReleaseRefusal(r: RefusalContext): Promise<void> {
  await r.phase('playback: a release-shaped build refuses the playback proof', () => {
    const want = JSON.stringify(releaseRoot());
    const updater = readPackaged(r.releaseShaped, STAGED.updateWorker);
    const main = readPackaged(r.releaseShaped, STAGED.main);
    for (const [what, bundle] of [
      ['updater', updater],
      ['main', main],
    ] as const) {
      const root = bakedRootIn(bundle);
      if (JSON.stringify(root) !== want || root.play !== undefined || root.dht !== null)
        throw new Error(`the release-shaped build's ${what} holds another root`);
    }
    r.say(
      'the release-shaped build holds the production root in main and the updater: no DHT, no play',
    );

    const releasePlay = { ...releaseRoot(), play: r.play };
    refusedWith(() => parseTrustRoot(releasePlay), 'a release build opens no video by itself');
    refusedWith(
      () => parseTrustRoot({ ...throwawayLaunchRoot(), play: r.play }),
      'a launch build opens no video by itself',
    );
    r.say('the parser refuses play in a release root and in a launch root');

    const dir = join(r.work, 'refusal');
    mkdirSync(join(dir, 'splice', 'main'), { recursive: true });
    const rootFile = join(dir, 'release-with-play.json');
    writeFileSync(rootFile, `${JSON.stringify(releasePlay)}\n`);
    cliRefuses('package.ts', ['build', '--update-root', rootFile], 2, 'refused outside test-build');
    cliRefuses(
      'package.ts',
      [
        'test-build',
        '--update-root',
        rootFile,
        '--app-version',
        '9.9.9',
        '--platform',
        r.platform,
        '--arch',
        r.arch,
        '--out',
        join(dir, 'out'),
      ],
      1,
      'a release build opens no video by itself',
    );
    r.say('package.ts build takes no root at all; test-build refuses a release root with play');

    cliRefuses(
      'release/cli.ts',
      ['verify-root', '--app', r.testApp],
      1,
      'a release build needs the release channel',
    );
    const splice = join(dir, 'splice');
    writeFileSync(join(splice, ...STAGED.updateWorker.split('/')), updater);
    writeFileSync(
      join(splice, ...STAGED.main.split('/')),
      readFileSync(join(r.testApp, ...STAGED.main.split('/'))),
    );
    cliRefuses(
      'release/cli.ts',
      ['verify-root', '--app', splice],
      1,
      "main's bundle holds another root than the updater's",
    );
    r.say("verify-root refuses build A, and the release updater spliced with build A's main");
    r.row(
      'release-shaped refusal',
      "this target's release build holds the production root in main and the updater (no DHT, no play); the root parser refuses play in a release and a launch root; `package.ts build` takes no root; `test-build` refuses a release root with play; `verify-root` refuses build A, and refuses the release updater spliced with build A's main",
    );
  });
}
