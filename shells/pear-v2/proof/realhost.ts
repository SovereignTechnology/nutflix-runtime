/**
 * Test 4 of the real-host proof (`shells/pear-v3/scripts/realhost/`): test 1 under shape (b). The
 * same video, played by `pear run` of a versioned link on the pinned Pear v2.6.5, over the PUBLIC
 * HyperDHT, between two machines on two networks. Watch only: the app seeds nothing.
 *
 * Only in a throwaway VM, as `proof/run.sh`, never on a CI runner or a developer machine. Unlike the
 * proof's own tools (`release-line.ts`, `install-line.ts`), which never serve off loopback, this
 * serves a THROWAWAY copy of the platform and a throwaway app link on the public DHT, for the other
 * machine to install and run. Both keys are made here and die with the VM.
 *
 *   node shells/pear-v2/proof/realhost.ts prepare --work <dir>                 (the seeding machine)
 *       Pear v2.6.5 fetched as a client at its pinned length (S1's `pin-bootstrap.js`), copied to a
 *       new key, served on the public DHT and on a private loopback one (its own install); the
 *       platform installed from that line; the app staged for it (`scripts/stage.ts --test-line`);
 *       `pear touch`, `pear stage` and `pear seed` on the public DHT. Prints `REALHOST_V2 {...}`
 *       (the line and the versioned link), then serves until its stdin closes or SIGTERM.
 *   node shells/pear-v2/proof/realhost.ts play --work <dir> --line <key>:<fork>:<length>
 *       --verlink <pear://f.l.key> --addr <NFX address> --relay ws://127.0.0.1:<port>
 *                                                                               (the playing machine)
 *       The platform installed from that line over the public DHT, the link run with `pear run`, and
 *       the address played from the relay's beacons by the worker over HyperDHT, measured through the
 *       debugger port. Prints `REALHOST_V2_PLAY {...}`.
 *
 * Prints numbers, booleans, keys, links and fixed words: never an address.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, symlinkSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import createTestnet from 'hyperdht/testnet.js';

import { SETTINGS_KEY } from '../../../packages/renderer/src/settings/store.ts';
import { PEAR_V2, isReleaseLine, type ReleaseLine } from '../src/shared/pins.ts';
import { Cdp } from './cdp.ts';
import { S1_DIR, platformRequire } from './platform-modules.ts';

/** The network the app plays (`world.ts`'s `NS`). */
const NS = 'nfx:testnet:1';

const here = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(here, '..');
const t0 = Date.now();
const say = (line: string): void => {
  process.stdout.write(
    `[v2 ${String(Math.round((Date.now() - t0) / 1000)).padStart(5)} s] ${line}\n`,
  );
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const arg = (name: string): string => {
  const i = argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : argv[i + 1];
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
};

/** Pear starts as from a terminal: no test runner's variables (the display, for its window). */
const pearEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
  LANG: 'C.UTF-8',
  ...(process.env['DISPLAY'] === undefined ? {} : { DISPLAY: process.env['DISPLAY'] }),
  ...(process.env['XAUTHORITY'] === undefined ? {} : { XAUTHORITY: process.env['XAUTHORITY'] }),
});

interface Ran {
  readonly code: number | null;
  readonly out: string;
  readonly timedOut: boolean;
}

/**
 * `cmd args` with its output in `log`, without blocking this process's event loop (it may be
 * serving the line meanwhile). On the deadline: SIGTERM, then SIGKILL, and the wait ends either way.
 */
function runAsync(
  cmd: string,
  args: readonly string[],
  timeoutS: number,
  log: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Ran> {
  const fd = openSync(log, 'a');
  const child = spawn(cmd, [...args], { env, stdio: ['ignore', fd, fd] });
  return new Promise((done) => {
    const st = { timedOut: false, settled: false };
    const finish = (code: number | null): void => {
      if (st.settled) return;
      st.settled = true;
      clearTimeout(timer);
      closeSync(fd);
      done({ code, out: readFileSync(log, 'utf8'), timedOut: st.timedOut });
    };
    const timer = setTimeout(() => {
      st.timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        child.kill('SIGKILL');
        setTimeout(() => {
          finish(null);
        }, 5_000);
      }, 10_000);
    }, timeoutS * 1000);
    child.once('exit', (code) => {
      finish(code);
    });
    child.once('error', () => {
      finish(null);
    });
  });
}

function tailOf(text: string, n: number): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l !== '')
    .slice(-n)
    .join('\n');
}

/** The last `--json` record of `tag` in a v2 CLI's output, or undefined. */
function record(out: string, tag: string): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  for (const l of out.split('\n')) {
    if (!l.includes(`"${tag}"`)) continue;
    try {
      const r = JSON.parse(l) as { tag?: string; data?: Record<string, unknown> };
      if (r.tag === tag) found = r.data ?? {};
    } catch {
      // Not a record.
    }
  }
  return found;
}

// ---- the platform's modules (S1's lockfile: hypercore at v2.6.5's own version) ----------------

interface Store {
  replicate(c: unknown): unknown;
  close(): Promise<void>;
}
interface Drive {
  readonly key: Uint8Array;
  readonly discoveryKey: Uint8Array;
  readonly core: {
    readonly length: number;
    readonly fork: number;
    update(o: { wait: boolean }): Promise<unknown>;
  };
  ready(): Promise<void>;
  findingPeers(): () => void;
  checkout(length: number): Drive;
  get(path: string): Promise<Uint8Array | null>;
  mirror(
    to: Drive,
    o: { filter: (k: string) => boolean; preload: boolean; prune: boolean },
  ): { done(): Promise<unknown>; readonly count: { readonly files: number } };
  close(): Promise<void>;
}
interface Swarm {
  on(e: 'connection', f: (c: unknown) => void): void;
  join(
    t: Uint8Array,
    o: { client: boolean; server: boolean },
  ): { flushed(): Promise<void>; destroy(): Promise<void> };
  flush(): Promise<void>;
  destroy(): Promise<void>;
  readonly connections: { readonly size: number };
}
interface SwarmOptions {
  bootstrap?: unknown;
}

const loadPlatform = (): {
  Corestore: new (dir: string) => Store;
  Hyperdrive: new (s: Store, key?: Uint8Array) => Drive;
  Hyperswarm: new (o?: SwarmOptions) => Swarm;
  id: { decode(k: string): Uint8Array; normalize(k: Uint8Array): string };
  bootstrap: (key: string, dir: string, o: SwarmOptions) => Promise<unknown>;
} => ({
  Corestore: platformRequire('corestore') as new (dir: string) => Store,
  Hyperdrive: platformRequire('hyperdrive') as new (s: Store, key?: Uint8Array) => Drive,
  Hyperswarm: platformRequire('hyperswarm') as new (o?: SwarmOptions) => Swarm,
  id: platformRequire('hypercore-id-encoding') as {
    decode(k: string): Uint8Array;
    normalize(k: Uint8Array): string;
  },
  bootstrap: platformRequire('pear-updater-bootstrap') as (
    key: string,
    dir: string,
    o: SwarmOptions,
  ) => Promise<unknown>,
});

const keepArch = (key: string): boolean => {
  const arch = /\/(by-arch|prebuilds)\/([^/]+)/.exec(key);
  return arch === null || arch[2] === 'linux-x64';
};

const pearBin = (pd: string): string => {
  const bin = join(pd, 'bin', 'pear');
  mkdirSync(join(pd, 'bin'), { recursive: true });
  symlinkSync(join(pd, 'current', 'by-arch', 'linux-x64', 'bin', 'pear-runtime'), bin);
  return bin;
};

// ---- prepare: the seeding machine ------------------------------------------------------------

async function prepare(): Promise<number> {
  // Told to stop (SIGTERM, or stdin closed): honoured between steps, and while serving.
  const stopping = new Promise<void>((done) => {
    process.once('SIGTERM', done);
    process.stdin.once('end', done);
    process.stdin.once('close', done);
  });
  const stop = { asked: false };
  void stopping.then(() => {
    stop.asked = true;
  });
  const step = (): void => {
    if (stop.asked) throw new Error('stopped before the link was seeded');
  };
  process.stdin.resume();
  const WORK = resolve(arg('work'));
  mkdirSync(join(WORK, 'logs'), { recursive: true });
  const log = (n: string): string => join(WORK, 'logs', `v2-${n}.log`);
  const P = loadPlatform();
  const closers: (() => Promise<void>)[] = [];
  let seed: ChildProcess | undefined;
  let pear: string | undefined;
  const shutdown = async (): Promise<void> => {
    if (seed?.exitCode === null) seed.kill('SIGTERM');
    if (pear !== undefined) {
      const sc = await runAsync(pear, ['sidecar', 'shutdown'], 60, log('sidecar'), pearEnv());
      say(`v2 sidecar shutdown: exit ${String(sc.code)}`);
    }
    for (const c of closers.reverse()) await c().catch(() => undefined);
  };
  try {
    // 1. Pear v2.6.5 as Holepunch published it, as a client, at its pinned length.
    const source = join(WORK, 'source');
    const fetched = await runAsync(
      process.execPath,
      [
        join(S1_DIR, 'pin-bootstrap.js'),
        source,
        String(PEAR_V2.upstream.length),
        String(PEAR_V2.upstream.fork),
      ],
      1500,
      log('fetch'),
    );
    if (fetched.code !== 0) throw new Error(`pin-bootstrap: ${tailOf(fetched.out, 6)}`);
    say('Pear v2.6.5 fetched as a client, at its pinned length');
    step();

    // 2. A throwaway line: the same platform on a key made here, at the same length.
    const srcStore = new P.Corestore(join(source, 'corestores', 'platform'));
    closers.push(() => srcStore.close());
    const src = new P.Hyperdrive(srcStore, P.id.decode(PEAR_V2.upstream.key));
    await src.ready();
    const reader = new P.Hyperswarm();
    reader.on('connection', (c) => srcStore.replicate(c));
    reader.join(src.discoveryKey, { client: true, server: false });
    const found = src.findingPeers();
    void reader.flush().then(found, found);
    while (src.core.length < PEAR_V2.upstream.length) {
      await src.core.update({ wait: true });
      if (src.core.length < PEAR_V2.upstream.length) await sleep(3000);
    }
    if (src.core.fork !== PEAR_V2.upstream.fork)
      throw new Error(`the source is on fork ${String(src.core.fork)}`);
    const dstStore = new P.Corestore(join(WORK, 'line'));
    closers.push(() => dstStore.close());
    const dst = new P.Hyperdrive(dstStore);
    await dst.ready();
    const snap = src.checkout(PEAR_V2.upstream.length);
    const m = snap.mirror(dst, { filter: keepArch, preload: false, prune: false });
    await m.done();
    await snap.close();
    await reader.destroy();
    const pkg = await dst.get('/package.json');
    const version = (JSON.parse(Buffer.from(pkg ?? '{}').toString()) as { version?: string })
      .version;
    if (version !== PEAR_V2.version) throw new Error(`the copy is version ${String(version)}`);
    const line: ReleaseLine = {
      key: P.id.normalize(dst.key),
      fork: dst.core.fork,
      length: dst.core.length,
    };
    if (!isReleaseLine(line) || line.key === PEAR_V2.upstream.key)
      throw new Error('the line is malformed');
    // Served on the public DHT (the other machine) and on a private loopback one (this install).
    const pub = new P.Hyperswarm();
    pub.on('connection', (c) => dstStore.replicate(c));
    closers.push(() => pub.destroy());
    await pub.join(dst.discoveryKey, { client: false, server: true }).flushed();
    const testnet = await createTestnet(10, { host: '127.0.0.1' });
    closers.push(() => testnet.destroy());
    const boot = testnet.bootstrap.map((b) => `${b.host}:${String(b.port)}`).join(',');
    const loc = new P.Hyperswarm({ bootstrap: testnet.bootstrap });
    loc.on('connection', (c) => dstStore.replicate(c));
    closers.push(() => loc.destroy());
    await loc.join(dst.discoveryKey, { client: false, server: true }).flushed();
    say(
      `throwaway line ${line.key} at ${String(line.fork)}.${String(line.length)}: ${String(m.count.files)} files, version ${version}, served on the public DHT`,
    );

    // 3. This machine's own platform, from that line, over the loopback DHT.
    const pd = join(WORK, 'pear');
    const installed = await runAsync(
      process.execPath,
      [join(here, 'install-line.ts'), line.key, pd, boot],
      900,
      log('install'),
    );
    if (installed.code !== 0) throw new Error(`install-line: ${tailOf(installed.out, 6)}`);
    pear = pearBin(pd);
    say('platform installed from the line');
    step();

    // 4. The app, staged for that line, then a throwaway link on the public DHT.
    const app = join(WORK, 'app');
    const staged = await runAsync(
      process.execPath,
      [
        join(PKG, 'scripts', 'stage.ts'),
        '--test-line',
        `${line.key}:${String(line.fork)}:${String(line.length)}`,
        '--out',
        app,
      ],
      1200,
      log('stage-app'),
    );
    if (staged.code !== 0) throw new Error(`stage.ts: ${tailOf(staged.out, 8)}`);
    say(`app staged for the line: ${tailOf(staged.out, 1)}`);
    step();
    let link: string | undefined;
    for (let attempt = 1; attempt <= 3 && link === undefined; attempt++) {
      const touched = await runAsync(pear, ['touch', '--json'], 300, log('touch'), pearEnv());
      const l = record(touched.out, 'final')?.['link'];
      if (typeof l === 'string' && /^pear:\/\/[a-z0-9]{52}$/.test(l)) link = l;
      else await sleep(10_000);
    }
    if (link === undefined) throw new Error('pear touch (v2) gave no link');
    const stagedLink = await runAsync(
      pear,
      ['stage', '--json', link, app],
      1500,
      log('stage'),
      pearEnv(),
    );
    const verlink = record(stagedLink.out, 'addendum')?.['verlink'];
    if (stagedLink.code !== 0 || typeof verlink !== 'string' || !verlink.startsWith('pear://'))
      throw new Error(`pear stage (v2): ${tailOf(stagedLink.out, 6)}`);
    const seedLog = log('seed');
    const fd = openSync(seedLog, 'a');
    seed = spawn(pear, ['seed', '--json', link], { env: pearEnv(), stdio: ['ignore', fd, fd] });
    closeSync(fd);
    // `pear seed` runs until stopped; it says when it is announced.
    for (let i = 0; i < 120 && seed.exitCode === null; i++) {
      if (/announced/i.test(readFileSync(seedLog, 'utf8'))) break;
      await sleep(1000);
    }
    if (seed.exitCode !== null)
      throw new Error(`pear seed (v2) exited: ${tailOf(readFileSync(seedLog, 'utf8'), 6)}`);
    say(`v2 app link ${link}, staged ${verlink}; pear seed up`);
    process.stdout.write(`REALHOST_V2 ${JSON.stringify({ line, link, verlink })}\n`);

    // 5. Until told to stop.
    await stopping;
    say(`stopping; line peers ${String(pub.connections.size)}`);
    return 0;
  } catch (e) {
    say(`FAIL ${e instanceof Error ? e.message : String(e)}`);
    process.stdout.write(
      `REALHOST_V2 ${JSON.stringify({ error: e instanceof Error ? e.message.slice(0, 600) : String(e) })}\n`,
    );
    return 1;
  } finally {
    await shutdown();
  }
}

// ---- play: the playing machine ---------------------------------------------------------------

function parseLine(text: string): ReleaseLine {
  const [key, fork, length] = text.split(':');
  const line = { key, fork: Number(fork), length: Number(length) };
  if (!isReleaseLine(line)) throw new Error('--line is <z32 key>:<fork>:<length>');
  return line;
}

function freePort(): Promise<number> {
  return new Promise((done, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => {
        if (a === null || typeof a === 'string') reject(new Error('no port'));
        else done(a.port);
      });
    });
  });
}

/** The worker's `status`, through the page's own pipe (`pear-run.proof.ts`'s round trip). */
const STATUS_EXPR = `(async () => {
  const p = globalThis.nutflixWorkerPipe;
  const id = 1900000777;
  const b = new TextEncoder().encode(JSON.stringify({ op: 'req', id, m: 'status', a: {} }));
  const f = new Uint8Array(4 + b.length);
  new DataView(f.buffer).setUint32(0, b.length);
  f.set(b, 4);
  let buf = new Uint8Array(0);
  let got = null;
  const off = p.onData((d) => {
    const n = new Uint8Array(buf.length + d.length);
    n.set(buf);
    n.set(d, buf.length);
    buf = n;
    for (;;) {
      if (buf.length < 4) break;
      const len = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
      if (buf.length < 4 + len) break;
      const msg = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + len)));
      buf = buf.slice(4 + len);
      if (msg.op === 'res' && msg.id === id) got = msg;
    }
  });
  p.write(f);
  const end = Date.now() + 15000;
  while (got === null && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  off();
  return got === null || got.ok !== true ? null
    : { playSessions: got.r.playSessions, listening: Array.isArray(got.r.listening) ? got.r.listening.length : -1 };
})()`;

const SAMPLE_EXPR = `(() => {
  const v = document.querySelector('video');
  if (v === null) return null;
  const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
  const s = typeof v.currentSrc === 'string' ? v.currentSrc : '';
  return { t: v.currentTime, paused: v.paused, ended: v.ended, readyState: v.readyState,
    error: v.error === null ? 0 : v.error.code,
    frames: q === null ? -1 : q.totalVideoFrames, dropped: q === null ? -1 : q.droppedVideoFrames,
    width: v.videoWidth, height: v.videoHeight,
    source: /^http:\\/\\/127\\.0\\.0\\.1:[0-9]{1,5}\\//.test(s) ? 'progressive' : s.startsWith('blob:') ? 'mse' : s === '' ? 'none' : 'other' };
})()`;

interface Sample {
  readonly t: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly readyState: number;
  readonly error: number;
  readonly frames: number;
  readonly dropped: number;
  readonly width: number;
  readonly height: number;
  readonly source: string;
}

const PLAY_BUTTON = `[...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === 'Play — free')`;

async function play(): Promise<number> {
  const WORK = resolve(arg('work'));
  const line = parseLine(arg('line'));
  const verlink = arg('verlink');
  const addr = arg('addr');
  const relay = arg('relay');
  if (!/^pear:\/\/\d+\.\d+\.[a-z0-9]{52}$/.test(verlink))
    throw new Error('--verlink is pear://f.l.key');
  if (!/^ws:\/\/127\.0\.0\.1:\d{2,5}$/.test(relay))
    throw new Error('--relay is ws://127.0.0.1:<port>');
  mkdirSync(join(WORK, 'logs'), { recursive: true });
  const log = (n: string): string => join(WORK, 'logs', `v2-${n}.log`);
  const P = loadPlatform();
  const summary: Record<string, unknown> = {};
  let pear: string | undefined;
  let app: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  try {
    // 1. The platform from the other machine's line, over the public DHT.
    const pd = join(WORK, 'pear');
    const t = Date.now();
    await Promise.race([
      P.bootstrap(line.key, pd, {}),
      sleep(900_000).then(() => {
        throw new Error('no platform from the line in 900 s');
      }),
    ]);
    pear = pearBin(pd);
    summary['platformInstallMs'] = Date.now() - t;
    say(
      `platform installed from line ${line.key} over the public DHT in ${String(Date.now() - t)} ms`,
    );

    // 2. The app and the Electron UI drive, fetched before the window opens.
    const pre = await runAsync(
      pear,
      ['run', '--preflight', verlink],
      1500,
      log('preflight'),
      pearEnv(),
    );
    summary['preflight'] = { code: pre.code, timedOut: pre.timedOut };
    // Not a verdict: the run below fetches whatever this did not.
    say(
      `pear run --preflight: exit ${String(pre.code)}${pre.code === 0 ? '' : `\n${tailOf(pre.out, 6)}`}`,
    );
    await runAsync(pear, ['sidecar', 'shutdown'], 60, log('sidecar-1'), pearEnv());

    // 3. `pear run` of the versioned link, its window read over the debugger port.
    const port = await freePort();
    const appLog = log('app');
    const fd = openSync(appLog, 'a');
    const started = spawn(
      pear,
      ['run', '--trusted', verlink, `--remote-debugging-port=${String(port)}`],
      {
        env: { ...pearEnv(), ELECTRON_ENABLE_LOGGING: '1' },
        stdio: ['ignore', fd, fd],
        detached: true,
      },
    );
    closeSync(fd);
    app = started;
    const c = await Cdp.attach(port, 300_000);
    cdp = c;
    await c.waitFor(`document.readyState === 'complete'`, 60_000, 'the page to load');
    await c.waitFor(
      `document.getElementById('root')?.dataset.workerLink === 'up'`,
      90_000,
      "the renderer's round trip to the worker",
    );
    const v = await c.eval<Record<string, unknown>>(`(async () => {
      const v = await Pear.versions();
      return { pear: v.runtimes.pear, bare: v.runtimes.bare, platformKey: String(v.platform.key),
        platformFork: v.platform.fork, platformLength: v.platform.length, link: String(Pear.config.link),
        electron: process.versions.electron, chromeMajor: Number(process.versions.chrome.split('.')[0]),
        sandboxed: process.sandboxed === true };
    })()`);
    summary['runtime'] = {
      pear: v['pear'],
      bare: v['bare'],
      electron: v['electron'],
      chromeMajor: v['chromeMajor'],
      sandboxed: v['sandboxed'],
      platformIsTheLine:
        v['platformKey'] === line.key &&
        v['platformFork'] === line.fork &&
        v['platformLength'] === line.length,
      linkIsTheVerlink: v['link'] === verlink,
    };
    say(`runtime ${JSON.stringify(summary['runtime'])}`);

    // 4. The viewer's settings as Settings stores them: the relay (here, through the tunnel), WebRTC
    // off as this shape starts. Then the page again, the video's route, and Play.
    const settings = JSON.stringify({
      v: 1,
      settings: {
        relays: [],
        nfx: {
          enabled: true,
          network: NS,
          scopedRelays: [relay],
          webrtc: false,
          meshRelays: ['ws://127.0.0.1:9'],
          stunServers: ['127.0.0.1:9'],
        },
      },
    });
    await c.eval(
      `localStorage.setItem(${JSON.stringify(SETTINGS_KEY)}, ${JSON.stringify(settings)})`,
    );
    await c.send('Page.reload');
    await sleep(1000);
    await c.waitFor(
      `document.getElementById('root')?.dataset.workerLink === 'up'`,
      90_000,
      'the worker after a reload',
    );
    await c.eval(`void (location.hash = ${JSON.stringify(`#/watch/${addr}`)})`);
    await c.waitFor(`${PLAY_BUTTON} !== undefined`, 120_000, 'the Play button (the manifest)');
    await sleep(1500);
    await c.click(PLAY_BUTTON);
    const pressed = Date.now();
    let first: Sample | null = null;
    while (first === null && Date.now() - pressed < 120_000) {
      const s = await c.eval<Sample | null>(SAMPLE_EXPR).catch(() => null);
      if (s !== null && s.readyState >= 2 && s.t > 0 && !s.paused && s.error === 0) first = s;
      else await sleep(250);
    }
    if (first === null) throw new Error('the video did not play in 120 s');
    const playingAt = Date.now();
    let last = first;
    while (Date.now() - playingAt < 6_000) {
      await sleep(500);
      const s = await c.eval<Sample | null>(SAMPLE_EXPR).catch(() => null);
      if (s === null) continue;
      last = s;
      if (s.error !== 0 || s.ended) break;
    }
    const status = await c.eval<{ playSessions: number; listening: number } | null>(STATUS_EXPR);
    summary['play'] = {
      source: last.source,
      t0: Math.round(first.t * 1000) / 1000,
      t1: Math.round(last.t * 1000) / 1000,
      advanced: Math.round((last.t - first.t) * 1000) / 1000,
      frames0: first.frames,
      frames1: last.frames,
      dropped: last.dropped,
      width: last.width,
      height: last.height,
      error: last.error,
      paused: last.paused,
      waitMs: playingAt - pressed,
      measureMs: Date.now() - playingAt,
      workerStatus: status,
    };
    say(`played: ${JSON.stringify(summary['play'])}`);
  } catch (e) {
    summary['error'] = e instanceof Error ? e.message.slice(0, 800) : String(e);
    say(`FAIL ${String(summary['error'])}`);
  } finally {
    if (cdp !== undefined) {
      await cdp.eval<unknown>(`void Pear[Pear.constructor.UI].app.quit()`).catch(() => undefined);
      cdp.close();
    }
    const pid = app?.pid;
    if (app !== undefined && pid !== undefined) {
      const a = app;
      const gone = await Promise.race([
        new Promise<boolean>((r) => {
          if (a.exitCode !== null) r(true);
          a.once('exit', () => {
            r(true);
          });
        }),
        sleep(45_000).then(() => false),
      ]);
      summary['appQuit'] = gone ? 'exited' : 'killed';
      if (!gone)
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
    }
    if (pear !== undefined) {
      const sc = await runAsync(pear, ['sidecar', 'shutdown'], 60, log('sidecar-2'), pearEnv());
      summary['sidecarShutdown'] = sc.code;
    }
    process.stdout.write(`REALHOST_V2_PLAY ${JSON.stringify(summary)}\n`);
  }
  return summary['error'] === undefined ? 0 : 1;
}

const cmd = argv[0];
process.exitCode =
  cmd === 'prepare'
    ? await prepare()
    : cmd === 'play'
      ? await play()
      : (process.stderr.write('usage: realhost.ts prepare|play …\n'), 2);
setTimeout(() => process.exit(), 3000).unref();
