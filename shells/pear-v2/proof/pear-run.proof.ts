/**
 * The real thing, in a throwaway VM (`proof/run.sh`): Pear v2.6.5 copied to a release line made
 * here, installed from it, the app staged to a versioned `pear://` link on a private DHT, and that
 * link started with `pear run`. Every check reads the real window over the debugger port, which is
 * a Chromium switch on this one command line: the app has no test mode.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { encodeFrame } from '@nutflix-runtime/worker';

import { SETTINGS_KEY } from '../../../packages/renderer/src/settings/store.ts';
import { stage } from '../scripts/stage.ts';
import { LABEL_ID, LABEL_TITLE, LEGACY_NOTE_ID, WEBRTC_LEGACY_NOTE } from '../src/page/notices.ts';
import { UNVERSIONED_REFUSAL } from '../src/shared/link.ts';
import { PEAR_V2, type ReleaseLine } from '../src/shared/pins.ts';
import { Cdp } from './cdp.ts';
import { S1_DIR, loopbackNodes } from './platform-modules.ts';
import { HOSTILE_DESCRIPTION, HOSTILE_TITLE, NS, startWorld, type World } from './world.ts';

if (process.env['NUTFLIX_V2_PROOF'] !== '1')
  throw new Error('this runs only in a throwaway VM, through proof/run.sh');

const here = dirname(fileURLToPath(import.meta.url));
const say = (line: string): void => {
  process.stdout.write(`PROOF ${line}\n`);
};

/** Pear starts as it would from a terminal: no test runner's variables, not in this package. */
const PEAR_ENV = {
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
  LANG: 'C.UTF-8',
};

function run(cmd: string, args: readonly string[], timeoutSec: number): string {
  const r = spawnSync(cmd, [...args], {
    encoding: 'utf8',
    env: cmd === process.execPath ? process.env : PEAR_ENV,
    cwd: WORK,
    timeout: timeoutSec * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0)
    throw new Error(
      `${cmd} ${args.slice(0, 3).join(' ')}: exit ${String(r.status)} ${r.error?.message ?? ''}\n${r.stdout.slice(-1500)}\n${r.stderr.slice(-1500)}`,
    );
  return r.stdout;
}

function lineFrom(p: ChildProcess, re: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => {
      reject(new Error(`no line matching ${String(re)} in ${String(timeoutMs)} ms`));
    }, timeoutMs);
    p.once('exit', (code) => {
      clearTimeout(t);
      reject(new Error(`exited ${String(code)} before a line matching ${String(re)}`));
    });
    p.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = re.exec(buf);
      if (m?.[1] !== undefined) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => {
        if (a === null || typeof a === 'string') reject(new Error('no port'));
        else resolve(a.port);
      });
    });
  });
}

/** Frames a list of requests through the page's own pipe and returns the answers by id. */
function rpcExpr(calls: readonly { id: number; m: string; a: unknown }[]): string {
  return `(async (calls) => {
    const p = globalThis.nutflixWorkerPipe;
    const frame = (o) => {
      const b = new TextEncoder().encode(JSON.stringify(o));
      const f = new Uint8Array(4 + b.length);
      new DataView(f.buffer).setUint32(0, b.length);
      f.set(b, 4);
      return f;
    };
    let buf = new Uint8Array(0);
    const got = {};
    const want = new Set(calls.map((c) => c.id));
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
        if (msg.op === 'res' && want.has(msg.id)) got[msg.id] = msg;
      }
    });
    for (const c of calls) p.write(frame({ op: 'req', id: c.id, m: c.m, a: c.a }));
    const end = Date.now() + 15000;
    while (Object.keys(got).length < calls.length && Date.now() < end)
      await new Promise((r) => setTimeout(r, 50));
    off();
    return got;
  })(${JSON.stringify(calls)})`;
}

interface Answer {
  readonly ok: boolean;
  readonly r?: Record<string, unknown>;
  readonly e?: { readonly code: string };
}

const WORK = mkdtempSync('/tmp/nutflix-v2-proof-');
const PD = join(WORK, 'pear');
const PEAR = join(PD, 'bin', 'pear');
const APP = join(WORK, 'stage', 'app');
const APP_LOG = join(WORK, 'app.log');
const children: ChildProcess[] = [];

let boot = '';
let line: ReleaseLine;
let verlink = '';
/** The same app's plain, unversioned `pear://<key>` link. */
let appLink = '';
let world: World | undefined;
let app: ChildProcess | undefined;
let cdp: Cdp;
let appExit: Promise<number | null>;

const pear = (args: readonly string[], timeoutSec = 180): string =>
  run(PEAR, ['--dht-bootstrap', boot, ...args], timeoutSec);

/** Starts the staged link (the versioned one unless told) and attaches to its window. */
async function launchApp(link = verlink): Promise<void> {
  const debugPort = await freePort();
  const log = openSync(APP_LOG, 'a');
  const started = spawn(
    'xvfb-run',
    [
      '-a',
      '-s',
      '-screen 0 1280x800x24',
      PEAR,
      '--dht-bootstrap',
      boot,
      'run',
      '--trusted',
      link,
      `--remote-debugging-port=${String(debugPort)}`,
    ],
    {
      stdio: ['ignore', log, log],
      cwd: WORK,
      env: { ...PEAR_ENV, ELECTRON_ENABLE_LOGGING: '1' },
      detached: true,
    },
  );
  closeSync(log);
  app = started;
  children.push(started);
  appExit = new Promise((resolve) => {
    started.once('exit', (code) => {
      resolve(code);
    });
  });
  cdp = await Cdp.attach(debugPort, 180_000);
  await cdp.waitFor(`document.readyState === 'complete'`, 60_000, 'the page to load');
}

async function quitApp(): Promise<number | null | 'hung'> {
  await cdp.eval<unknown>(`void Pear[Pear.constructor.UI].app.quit()`).catch(() => undefined);
  const code = await Promise.race([
    appExit,
    new Promise<'hung'>((resolve) =>
      setTimeout(() => {
        resolve('hung');
      }, 45_000),
    ),
  ]);
  cdp.close();
  return code;
}

beforeAll(async () => {
  const dht = spawn(process.execPath, [join(here, 'dht-node.ts')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  children.push(dht);
  boot = await lineFrom(dht, /^BOOTSTRAP (\S+)$/m, 60_000);
  const nodes = loopbackNodes(boot);
  say(`private DHT up, ${String(nodes.length)} bootstrap node(s) on 127.0.0.1`);

  const source = join(WORK, 'source');
  run(
    process.execPath,
    [
      join(S1_DIR, 'pin-bootstrap.js'),
      source,
      String(PEAR_V2.upstream.length),
      String(PEAR_V2.upstream.fork),
    ],
    1500,
  );
  say('Pear v2.6.5 fetched as a client, at its pinned length');

  const lineProc = spawn(
    process.execPath,
    [
      join(here, 'release-line.ts'),
      join(source, 'corestores', 'platform'),
      join(WORK, 'line'),
      String(PEAR_V2.upstream.length),
      String(PEAR_V2.upstream.fork),
      boot,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  children.push(lineProc);
  const made = JSON.parse(await lineFrom(lineProc, /^LINE (\{.*\})$/m, 900_000)) as ReleaseLine & {
    version: string;
    files: number;
  };
  line = { key: made.key, fork: made.fork, length: made.length };
  expect(made.version).toBe(PEAR_V2.version);
  say(`release line made in this VM: ${String(made.files)} files, version ${made.version}`);

  run(process.execPath, [join(here, 'install-line.ts'), line.key, PD, boot], 900);
  mkdirSync(join(PD, 'bin'), { recursive: true });
  symlinkSync(join(PD, 'current', 'by-arch', 'linux-x64', 'bin', 'pear-runtime'), PEAR);
  say('platform installed from the release line, over the private DHT');

  await stage({ out: APP, testLine: line });
  say('app staged for that line');

  // The Electron UI drive is the one thing still fetched from the public DHT, as a client, by a
  // sidecar that holds nothing of ours: nothing has been touched or staged yet.
  run(PEAR, ['run', '--preflight', APP], 1200);
  run(PEAR, ['sidecar', 'shutdown'], 60);
  say('Electron UI asset fetched; sidecar stopped');

  const touched = JSON.parse(
    pear(['touch', '--json'])
      .split('\n')
      .find((l) => l.includes('"final"')) ?? '{}',
  ) as { data?: { link?: string } };
  const link = touched.data?.link;
  if (link === undefined) throw new Error('pear touch gave no link');
  appLink = link;
  const staged = pear(['stage', '--json', link, APP], 900);
  // Stage reports the link it started from first: the build it made is in the `addendum`.
  const addendum = staged
    .split('\n')
    .filter((l) => l.includes('"addendum"'))
    .map((l) => JSON.parse(l) as { data?: { verlink?: string } })
    .at(-1);
  verlink = addendum?.data?.verlink ?? '';
  if (verlink === '') throw new Error('pear stage gave no versioned link');
  say(`staged on the private DHT: pear://<fork>.<length>.<key> at ${verlink.split('.')[1] ?? ''}`);

  world = await startWorld(nodes);
  say('seeder and relay up on 127.0.0.1');

  await launchApp();
  say('the GUI opened from the versioned link');
});

afterAll(async () => {
  if (process.env['NUTFLIX_V2_PROOF_LOG'] === '1') {
    try {
      process.stdout.write(`${readFileSync(APP_LOG, 'utf8').slice(-6000)}\n`);
    } catch {
      // No log.
    }
  }
  try {
    cdp.close();
  } catch {
    // Never attached.
  }
  await world?.close();
  spawnSync(PEAR, ['--dht-bootstrap', boot, 'sidecar', 'shutdown'], { timeout: 30_000 });
  for (const c of children) {
    if (c.pid === undefined || c.exitCode !== null) continue;
    try {
      if (c === app) process.kill(-c.pid, 'SIGKILL');
      else c.kill('SIGTERM');
    } catch {
      // Already gone.
    }
  }
});

describe('a real `pear run` of a staged versioned link', () => {
  it('runs on the pinned platform, from the release line, with Chromium 130', async () => {
    const v = await cdp.eval<{
      platform: { key: string; fork: number; length: number };
      app: { fork: number; length: number };
      runtimes: { pear: string; bare: string };
      link: string;
      electron: string;
      chrome: string;
      sandboxed: boolean;
    }>(`(async () => {
      const v = await Pear.versions();
      return {
        platform: { key: String(v.platform.key), fork: v.platform.fork, length: v.platform.length },
        app: { fork: v.app.fork, length: v.app.length },
        runtimes: v.runtimes,
        link: String(Pear.config.link),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        sandboxed: process.sandboxed === true,
      };
    })()`);
    expect(v.runtimes.pear).toBe('2.6.5');
    expect(v.runtimes.bare).toBe('1.24.3');
    expect(v.platform.fork).toBe(line.fork);
    expect(v.platform.length).toBe(line.length);
    expect(v.platform.key).toBe(line.key);
    expect(v.platform.key).not.toBe(PEAR_V2.upstream.key);
    expect(v.electron).toBe(PEAR_V2.electron);
    expect(Number(v.chrome.split('.')[0])).toBe(PEAR_V2.chromiumMajor);
    expect(v.link).toBe(verlink);
    expect(`pear://${String(v.app.fork)}.${String(v.app.length)}.`).toBe(
      `${verlink.slice(0, verlink.lastIndexOf('.'))}.`,
    );
    // The accepted risk, measured rather than assumed.
    expect(v.sandboxed).toBe(false);
  });

  it('the CSP is the first element of the document', async () => {
    const r = await cdp.eval<{ first: string; csp: string; header: string | null }>(`(async () => {
      const first = document.head.firstElementChild;
      const res = await fetch('/');
      return {
        first: first.tagName + ':' + first.httpEquiv,
        csp: first.content,
        header: res.headers.get('content-security-policy'),
      };
    })()`);
    expect(r.first).toBe('META:Content-Security-Policy');
    expect(r.csp).toMatch(/script-src 'self' 'wasm-unsafe-eval'/);
    expect(r.csp).not.toMatch(/unsafe-inline|'unsafe-eval'/);
    // A script policy in the header would stop the runtime's own preload (`page-server.ts`).
    expect(r.header).toBe("frame-ancestors 'none'");
  });

  it('passes a round trip from the page to the worker, through the pipe', async () => {
    await cdp.waitFor(
      `document.getElementById('root')?.dataset.workerLink === 'up'`,
      60_000,
      "the renderer's own round trip",
    );
    const got = await cdp.eval<Record<string, Answer>>(
      rpcExpr([{ id: 1_900_000_001, m: 'status', a: {} }]),
    );
    expect(got['1900000001']?.ok).toBe(true);
    expect(got['1900000001']?.r).toHaveProperty('playSessions', 0);
  });

  it('shows the legacy label, on top, while the window is open', async () => {
    const l = await cdp.eval<{
      text: string;
      h: number;
      top: number;
      onTop: boolean;
      rootTop: number;
      rootBottom: number;
      inner: number;
    }>(`(() => {
      const el = document.getElementById(${JSON.stringify(LABEL_ID)});
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + 40, r.top + r.height / 2);
      const root = document.getElementById('root').getBoundingClientRect();
      return { text: el.textContent, h: r.height, top: r.top, onTop: el.contains(hit),
        rootTop: root.top, rootBottom: root.bottom, inner: innerHeight };
    })()`);
    // The app fills the window under the bar, and this link is versioned, so no second warning.
    expect(l.rootTop).toBe(l.h);
    expect(l.rootBottom).toBe(l.inner);
    expect(l.text).not.toContain('unversioned');
    expect(l.text).toContain(LABEL_TITLE);
    expect(l.text).toContain('no sandbox');
    expect(l.text).toContain('pear install');
    expect(l.h).toBeGreaterThan(0);
    expect(l.top).toBe(0);
    expect(l.onTop).toBe(true);
  });

  it('starts with WebRTC off, and Settings says why', async () => {
    const stored = await cdp.eval<string>(`localStorage.getItem(${JSON.stringify(SETTINGS_KEY)})`);
    const nfx = (JSON.parse(stored) as { settings: { nfx: { webrtc: boolean } } }).settings.nfx;
    expect(nfx.webrtc).toBe(false);
    await cdp.eval(`void (location.hash = '#/settings')`);
    await cdp.waitFor(
      `!!document.getElementById(${JSON.stringify(LEGACY_NOTE_ID)})`,
      30_000,
      'the WebRTC warning in Settings',
    );
    const note = await cdp.eval<string>(
      `document.getElementById(${JSON.stringify(LEGACY_NOTE_ID)}).textContent`,
    );
    expect(note).toBe(WEBRTC_LEGACY_NOTE);
    // Watch only: Settings has no seeding, publishing or account section, and says nothing of one.
    const settings = await cdp.eval<{ panel: boolean; text: string }>(`({
      panel: !!document.getElementById('nutflix-seed-publish'),
      text: document.body.textContent,
    })`);
    expect(settings.panel).toBe(false);
    expect(settings.text).not.toMatch(/Account menu|Seeding and publishing|passphrase|bunker/i);
    // What a peer could learn here if it were on: counted, never printed.
    const c = await cdp.eval<{ total: number; rawHost: number; mdns: number }>(`(async () => {
      const pc = new RTCPeerConnection();
      pc.createDataChannel('probe');
      const seen = [];
      pc.onicecandidate = (e) => { if (e.candidate) seen.push(e.candidate.candidate); };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => setTimeout(r, 2500));
      pc.close();
      const hosts = seen.filter((s) => s.includes(' typ host'));
      const mdns = hosts.filter((s) => s.includes('.local')).length;
      return { total: seen.length, rawHost: hosts.length - mdns, mdns };
    })()`);
    say(`WebRTC candidates here: ${JSON.stringify(c)}`);
    // Off is the default, not a missing feature: the pinned player library loads on Chromium 130.
    await cdp.waitFor(
      `document.getElementById('root')?.dataset.webrtcPlayer === 'available'`,
      30_000,
      'the WebRTC player library to load',
    );
  });

  it('refuses an injected <img onerror>, an inline script, eval and new Function', async () => {
    const r = await cdp.eval<{
      pwned: unknown;
      violations: string[];
      evalName: string;
      fnName: string;
      workerRan: boolean;
    }>(`new Promise((resolve) => {
      const violations = [];
      document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective));
      const box = document.createElement('div');
      box.innerHTML = '<img src="/nope.png" onerror="window.__injected = 1">';
      document.body.append(box);
      const s = document.createElement('script');
      s.textContent = 'window.__injected = 2';
      document.head.append(s);
      let evalName = 'ran';
      try { eval('window.__injected = 3'); } catch (e) { evalName = e.name; }
      let fnName = 'ran';
      try { new Function('window.__injected = 4')(); } catch (e) { fnName = e.name; }
      // This runtime gives Web Workers Node too.
      let workerRan = false;
      try {
        const url = URL.createObjectURL(new Blob(['postMessage(typeof process)'], { type: 'text/javascript' }));
        const w = new Worker(url);
        w.onmessage = () => { workerRan = true; };
      } catch { /* refused outright */ }
      setTimeout(() => { box.remove(); s.remove(); resolve({ pwned: window.__injected ?? null, violations, evalName, fnName, workerRan }); }, 1500);
    })`);
    expect(r.pwned).toBeNull();
    expect(r.evalName).toBe('EvalError');
    expect(r.fnName).toBe('EvalError');
    expect(r.violations).toContain('script-src-attr');
    expect(r.violations).toContain('script-src-elem');
    expect(r.workerRan).toBe(false);
    expect(r.violations).toContain('worker-src');
  });

  it('plays a local test video, with a stranger’s HTML shown as text', async () => {
    if (world === undefined) throw new Error('no world');
    // The viewer's settings as Settings would store them: the local relay, WebRTC still off.
    const settings = JSON.stringify({
      v: 1,
      settings: {
        relays: [],
        nfx: {
          enabled: true,
          network: NS,
          scopedRelays: [world.relayUrl],
          webrtc: false,
          meshRelays: ['ws://127.0.0.1:9'],
          stunServers: ['127.0.0.1:9'],
        },
      },
    });
    await cdp.eval(
      `localStorage.setItem(${JSON.stringify(SETTINGS_KEY)}, ${JSON.stringify(settings)})`,
    );
    // Records what the page does with WebRTC from here on. The pinned player library makes one
    // peer connection at load, with no configuration, to test for the promise API, and closes it.
    // Addresses are only gathered by a local description, so with WebRTC off there must be none.
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const Real = globalThis.RTCPeerConnection;
        const rtc = (globalThis.__rtc = { constructed: 0, withConfig: 0, local: 0, remote: 0, ice: 0, channels: 0 });
        for (const [method, key] of [['setLocalDescription', 'local'], ['setRemoteDescription', 'remote'],
          ['addIceCandidate', 'ice'], ['createDataChannel', 'channels']]) {
          const f = Real.prototype[method];
          Real.prototype[method] = function (...a) { rtc[key]++; return f.apply(this, a); };
        }
        globalThis.RTCPeerConnection = new Proxy(Real, {
          construct(t, a, n) {
            rtc.constructed++;
            if (a[0] !== undefined) rtc.withConfig++;
            return Reflect.construct(t, a, n);
          },
        });
      })();`,
    });
    await cdp.send('Page.reload');
    await cdp.waitFor(
      `document.getElementById('root')?.dataset.workerLink === 'up'`,
      60_000,
      'the worker after a reload',
    );
    await cdp.eval(`void (location.hash = ${JSON.stringify(`#/watch/${world.addr}`)})`);
    await cdp.waitFor(
      `document.querySelector('.nf-watch__title')?.textContent === ${JSON.stringify(HOSTILE_TITLE)}`,
      60_000,
      'the title, as text',
    );
    const shown = await cdp.eval<{ imgs: number; pwned: unknown; body: boolean }>(`({
      imgs: document.querySelectorAll('.nf-watch__title img, img[src="x"]').length,
      pwned: window.__pwned ?? null,
      body: document.body.textContent.includes(${JSON.stringify(HOSTILE_DESCRIPTION)}),
    })`);
    expect(shown).toEqual({ imgs: 0, pwned: null, body: true });

    await cdp.click(
      `[...document.querySelectorAll('button')].find((b) => /^Play — free$/.test((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()))`,
    );
    await cdp.waitFor(
      `(() => { const v = document.querySelector('video'); return !!v && v.currentTime > 2 && !v.paused; })()`,
      120_000,
      'the video to play past two seconds',
    );
    const v = await cdp.eval<{
      src: string;
      t: number;
      error: number | null;
      w: number;
      h: number;
    }>(`(() => {
      const v = document.querySelector('video');
      return { src: v.currentSrc, t: v.currentTime, error: v.error?.code ?? null, w: v.videoWidth, h: v.videoHeight };
    })()`);
    expect(v.src).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[0-9a-f]{32}\/[0-9a-f]{32}$/);
    expect(v.error).toBeNull();
    expect([v.w, v.h]).toEqual([320, 240]);
    await new Promise((r) => setTimeout(r, 1500));
    const t2 = await cdp.eval<number>(`document.querySelector('video').currentTime`);
    expect(t2).toBeGreaterThan(v.t);
    say(`played to ${t2.toFixed(1)} s, ${String(v.w)}x${String(v.h)}, from the worker's loopback`);
    // Watching seeds nothing: the worker listens nowhere after a play.
    const st = await cdp.eval<Record<string, Answer>>(
      rpcExpr([{ id: 1_900_000_050, m: 'status', a: {} }]),
    );
    expect(st['1900000050']?.r).toHaveProperty('listening', []);
    expect(await cdp.eval<unknown>('window.__pwned ?? null')).toBeNull();
    expect(await cdp.eval<unknown>('globalThis.__rtc')).toEqual({
      constructed: 1,
      withConfig: 0,
      local: 0,
      remote: 0,
      ice: 0,
      channels: 0,
    });
    if (process.env['NUTFLIX_V2_PROOF_SHOT'] === '1')
      process.stdout.write(`PROOF_SHOT ${await cdp.screenshot()}\n`);
  });

  it('the page cannot reach any worker method but its three: no signer, Studio or seeding', async () => {
    const calls = [
      'init',
      'nfx.seed.start',
      'nfx.seed.stop',
      'nfx.seed.list',
      'nfx.endpoint',
      'signer.status',
      'signer.local.create',
      'signer.local.unlock',
      'signer.nip46.connect',
      'signer.sign',
      'seeding.status',
      'seeding.set',
      'seeding.watch',
      'seeding.segment',
      'studio.ffmpeg',
      'studio.source',
      'studio.publish',
      'app.pickVideo',
      'app.seeding.set',
      'app.publish.sign',
    ].map((m, i) => ({ id: 1_900_000_100 + i, m, a: { v: 1, storage: '/tmp/x' } }));
    calls.push({ id: 1_900_000_200, m: 'key.export', a: { v: 1, storage: '' } });
    const got = await cdp.eval<Record<string, Answer>>(rpcExpr(calls));
    for (const c of calls) {
      expect(got[String(c.id)]?.ok, c.m).toBe(false);
      expect(got[String(c.id)]?.e?.code, c.m).toBe('invalid-argument');
    }
  });

  it('the window cannot fetch from an https host: only loopback is on its list', async () => {
    await cdp.send('Network.enable');
    const outcome = await cdp.eval<string>(
      `fetch('https://example.org/', { cache: 'no-store' }).then(() => 'loaded', (e) => e.name)`,
    );
    expect(outcome).toBe('TypeError');
    await new Promise((r) => setTimeout(r, 300));
    const blocked = cdp.events.filter(
      (e) =>
        e.method === 'Network.loadingFailed' &&
        e.params['errorText'] === 'net::ERR_BLOCKED_BY_CLIENT',
    );
    expect(blocked.length).toBeGreaterThan(0);
    await cdp.send('Network.disable');
  });

  it('a link opens only if it is https: and public', async () => {
    const opened = await cdp.eval<string[]>(`(() => {
      const opened = [];
      const real = window.open;
      window.open = (u) => { opened.push(String(u)); return null; };
      for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'http://example.org/',
        'https://user:pw@example.org/', 'https://127.0.0.1/', 'https://localhost/',
        'data:text/html,x', 'pear://abc', 'https://example.org/ok']) nutflixOpenLink(u);
      window.open = real;
      return opened;
    })()`);
    expect(opened).toEqual(['https://example.org/ok']);
  });

  it('no socket answers the worker protocol, and the page origin serves only its files', async () => {
    const tcp = ['/proc/net/tcp', '/proc/net/tcp6'].flatMap((f) =>
      readFileSync(f, 'utf8').split('\n').slice(1),
    );
    const ports = [
      ...new Set(
        tcp
          .map((l) => l.trim().split(/\s+/))
          .filter((c) => c[3] === '0A')
          .map((c) => parseInt(c[1]?.split(':')[1] ?? '0', 16)),
      ),
    ];
    expect(ports.length).toBeGreaterThan(0);
    const frame = encodeFrame({ op: 'req', id: 1, m: 'status', a: {} });
    for (const port of ports) {
      const reply = await new Promise<string>((resolve) => {
        let got = '';
        const s = net.connect({ host: '127.0.0.1', port });
        const done = (): void => {
          s.destroy();
          resolve(got);
        };
        s.on('connect', () => s.write(frame));
        s.on('data', (d) => (got += d.toString('latin1')));
        s.on('error', done);
        s.on('close', done);
        setTimeout(done, 500);
      });
      expect(reply, `port ${String(port)}`).not.toContain('"op":"res"');
    }

    const origin = new URL(await cdp.eval<string>('location.origin'));
    const get = (path: string, headers: Record<string, string>): Promise<number> =>
      new Promise((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port: origin.port, path, headers }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          })
          .on('error', reject);
      });
    const xPear = { 'X-Pear': 'Pear proof' };
    expect(await get('/', {})).toBe(403);
    expect(await get('/', { ...xPear, Host: 'evil.example' })).toBe(403);
    expect(await get('/', xPear)).toBe(200);
    expect(await get('/index.js', xPear)).toBe(404);
    expect(await get('/worker/keys.js', xPear)).toBe(404);
    expect(await get('/node_modules/pear-electron/package.json', xPear)).toBe(404);
    expect(await get('/../package.json', xPear)).toBe(404);
  });

  it('holds no signing key: the only key on disk is the seeder network identity', async () => {
    const storage = await cdp.eval<string>('Pear.config.storage');
    const worker = join(storage, 'worker');
    // `seeding.json` holds the switch main turned off; there is no `signer` directory at all.
    expect(readdirSync(worker).sort()).toEqual(['keys', 'nfx', 'seeding.json', 'tmp']);
    const seeding = JSON.parse(readFileSync(join(worker, 'seeding.json'), 'utf8')) as {
      watched?: unknown;
    };
    expect(seeding.watched).toBe(false);
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    const files = walk(storage);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(/nsec|wallet|mnemonic|seed-?phrase/i.test(f.slice(storage.length)), f).toBe(false);
      if (statSync(f).size < 8 * 1024 * 1024)
        expect(readFileSync(f).includes('nsec'), f).toBe(false);
    }
  });

  it('closing the window ends the app, and a restart keeps the viewer’s settings', async () => {
    const origin = await cdp.eval<string>('location.origin');
    const before = await cdp.eval<string>(`localStorage.getItem(${JSON.stringify(SETTINGS_KEY)})`);
    const code = await quitApp();
    expect(code).not.toBe('hung');
    say(`pear run exited with ${String(code)} after the window closed`);

    await launchApp();
    expect(await cdp.eval<string>('location.origin')).toBe(origin);
    expect(await cdp.eval<string>(`localStorage.getItem(${JSON.stringify(SETTINGS_KEY)})`)).toBe(
      before,
    );
    await cdp.waitFor(
      `document.getElementById('root')?.dataset.workerLink === 'up'`,
      60_000,
      'the worker after a restart',
    );
    expect(await quitApp()).not.toBe('hung');
  });

  it('an unversioned link gets no worker, and the window says why', async () => {
    expect(appLink).toMatch(/^pear:\/\/[a-z0-9]{52}$/);
    await launchApp(appLink);
    await cdp.waitFor(
      `document.getElementById('root')?.dataset.refused === 'unversioned'`,
      60_000,
      'the refusal',
    );
    const r = await cdp.eval<{ pipe: string; text: string; label: string }>(`({
      pipe: typeof globalThis.nutflixWorkerPipe,
      text: document.getElementById('root').textContent,
      label: document.getElementById(${JSON.stringify(LABEL_ID)}).textContent,
    })`);
    expect(r.pipe).toBe('undefined');
    expect(r.text).toBe(UNVERSIONED_REFUSAL);
    expect(r.label).toContain(LABEL_TITLE);
    expect(readFileSync(APP_LOG, 'utf8')).toContain('refusing to start the worker');
    expect(await quitApp()).not.toBe('hung');
  });

  it('a build for another release line refuses to start on this platform', async () => {
    const other = join(WORK, 'stage', 'other');
    await stage({
      out: other,
      testLine: { key: 'y'.repeat(52), fork: line.fork, length: line.length },
    });
    const r = spawnSync(
      'xvfb-run',
      ['-a', PEAR, '--dht-bootstrap', boot, 'run', '--trusted', other],
      { encoding: 'utf8', timeout: 90_000, cwd: WORK, env: PEAR_ENV },
    );
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('refusing to start');
  });
});
