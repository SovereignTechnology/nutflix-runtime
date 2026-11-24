/**
 * Seed and publish, for real, on loopback (ADR 0001 decisions 3, 7 and 8). Nothing is faked but the
 * answers of the native dialogs and of main's prompt window, which are scripted (`bare-bridge.ts`):
 *
 *   ffmpeg     the system's, on a clip generated here
 *   worker     the BUILT worker under the REAL Bare runtime, behind the shell's real gate
 *   renderer   the built bundle in a real Chrome (it has H.264; Playwright's Chromium does not)
 *   relay      a stock strfry on 127.0.0.1
 *   DHT        a hyperdht testnet on 127.0.0.1
 *   client     nutflix-pear's own `dialNfx` (`@sovit/seeder`)
 *
 * The publisher works through the real Settings section. Then:
 *   1. nutflix-pear's `dialNfx` fetches every file of the video from that worker: byte for byte
 *      against what the worker stored, and sha256-equal to the hash list;
 *   2. the manifest and a beacon are on strfry, they verify, and a second app instance finds the
 *      video through its own play path and plays it;
 *   3. that viewer, with its switch on, re-seeds it: a stranger fetches it from the viewer alone;
 *   4. NIP-46 signing against a throwaway bunker, and the passphrase path with a wrong passphrase;
 *   5. a video that was encoded and never confirmed cannot be played, and a "no" deletes it.
 *
 * The workflow runs this in a network namespace with only a loopback interface, so a mistake here
 * cannot make a CI runner a peer of any public network.
 *
 * Needs: ffmpeg, STRFRY and STRFRY_CONF, CHROMIUM (a Chrome with H.264), a built tree.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import DHT from 'hyperdht';
import { npubEncode } from 'nostr-tools/nip19';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type { NostrEvent } from '@sovit/core';
import {
  MAX_HASH_LIST_BYTES,
  VideoAddr,
  parseBeacon,
  parseManifest,
  verifyHashList,
} from '@sovit/core/nfx';
import { dialNfx, nodeCrypto } from '@sovit/seeder';
import type { SeedingStatusWire, SignerStatusWire, WorkerStatus } from '@nutflix-runtime/worker';

import { LoopRelay, TestBunker } from '../../../worker/src/__tests__/helpers/test-bunker.ts';
import { SETTINGS_KEY } from '../../src/settings/store.js';
import { serveDir } from '../static-server.js';
import { startBareBridge, startBareScript, type BareBridge } from './bare-bridge.js';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..', '..', 'dist', 'app');
const NS = 'nfx:testnet:1';
const PASS = 'a throwaway passphrase for this run';
const TITLE = 'Published from the app';

/** This page has no WebRTC or WASM, so every play takes the HyperDHT path that is being proved. */
const REMOVE_WEBRTC_AND_WASM = `(() => {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebAssembly']) {
    Object.defineProperty(globalThis, name, { value: undefined, configurable: true, writable: true });
  }
})();`;

const need = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
};
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const report = (name: string, o: unknown): void => {
  console.warn(`PROOF ${name} ${JSON.stringify(o)}`);
};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => {
        resolve(port);
      });
    });
  });

async function waitPort(port: number, log: () => string): Promise<void> {
  const end = Date.now() + 30_000;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const c = connect(port, '127.0.0.1');
      c.once('connect', () => {
        c.destroy();
        resolve(true);
      });
      c.once('error', () => {
        resolve(false);
      });
    });
    if (open) return;
    if (Date.now() > end) throw new Error(`nothing listens on ${String(port)}\n${log()}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** A plain NIP-01 client: everything a subscription delivers, kept. */
class RelayWatch {
  readonly events: NostrEvent[] = [];
  readonly #ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on('message', (d) => {
      const msg = JSON.parse((d as Buffer).toString('utf8')) as unknown[];
      if (msg[0] === 'EVENT') this.events.push(msg[2] as NostrEvent);
    });
  }

  static async open(url: string, filter: object): Promise<RelayWatch> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve();
      });
      ws.once('error', reject);
    });
    const w = new RelayWatch(ws);
    ws.send(JSON.stringify(['REQ', 'watch', filter]));
    return w;
  }

  close(): void {
    this.#ws.terminate();
  }
}

async function until<T>(what: string, f: () => T | undefined | null, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined && v !== null) return v;
    if (Date.now() > end) throw new Error(`${what}: not within ${String(ms)} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function makeClip(path: string): void {
  const r = spawnSync(
    process.env['FFMPEG'] ?? 'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=854x480:rate=25:duration=8',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=8',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      path,
    ],
    { encoding: 'utf8' },
  );
  if (r.error !== undefined || r.status !== 0)
    throw new Error(`the clip was not made: ${r.stderr.slice(-400)}`);
}

interface Fetched {
  readonly files: number;
  readonly bytes: number;
  readonly store: number;
  readonly list: Uint8Array;
}

/**
 * Every file of the video from the listener `peer`, with nutflix-pear's own client: the hash list
 * against `root`, then each file against its entry, and against `storage`'s copy when given.
 */
async function fetchEverything(
  bootstrap: Testnet['bootstrap'],
  peer: string,
  video: string,
  root: string,
  segs: bigint,
  storage: string | null,
): Promise<Fetched> {
  const dht = new DHT({ bootstrap });
  try {
    await dht.fullyBootstrapped();
    const dialed = await dialNfx(dht, Buffer.from(peer, 'hex'), {
      keyPair: DHT.keyPair(),
      crypto: nodeCrypto,
      timeoutMs: 30_000,
    });
    if (!dialed.ok) throw new Error(`dial failed: ${dialed.reason}`);
    try {
      const addr = VideoAddr.parse(video);
      if (!addr.ok) throw new Error('bad address');
      const files = dialed.connection.files(addr.value);
      if (files === undefined) throw new Error('no files channel');
      const get = async (sha: string, size: number, exact: boolean): Promise<Uint8Array> => {
        const chunks: Uint8Array[] = [];
        const r = await files.fetch({
          sha,
          size,
          exact,
          sink: { write: (c) => void chunks.push(c) },
        });
        if (!r.ok) throw new Error(`no file ${sha.slice(0, 8)}: ${JSON.stringify(r)}`);
        return Buffer.concat(chunks);
      };
      const list = await get(root, MAX_HASH_LIST_BYTES, false);
      expect(sha256(list)).toBe(root);
      const verified = verifyHashList(list, root, addr.value, segs);
      if (!verified.ok) throw new Error(verified.error.reason);
      let bytes = 0;
      let store = 0;
      for (const f of verified.value.files) {
        const size = Number(f.size);
        const got = await get(f.sha256, size, true);
        expect(got.byteLength).toBe(size);
        expect(sha256(got)).toBe(f.sha256);
        bytes += size;
        if (storage !== null) {
          const onDisk = join(storage, 'nfx', 'files', f.sha256.slice(0, 2), f.sha256);
          expect(Buffer.compare(readFileSync(onDisk), got)).toBe(0);
          store += 1;
        }
      }
      return { files: verified.value.files.length, bytes, store, list };
    } finally {
      dialed.connection.destroy('test over');
    }
  } finally {
    await dht.destroy();
  }
}

const cleanups: (() => Promise<void> | void)[] = [];

interface World {
  readonly testnet: Testnet;
  readonly relayUrl: string;
  readonly site: { readonly origin: string };
  readonly browser: Browser;
  readonly clip: string;
  readonly beacons: RelayWatch;
  readonly publisher: BareBridge;
  readonly page: Page;
  readonly pageErrors: string[];
  readonly requests: string[];
}

async function openApp(
  browser: Browser,
  relayUrl: string,
  bridge: BareBridge,
  origin: string,
  hash: string,
): Promise<{ page: Page; errors: string[]; requests: string[] }> {
  const context: BrowserContext = await browser.newContext();
  cleanups.push(() => context.close());
  await context.addInitScript(
    ([key, value]) => {
      if (globalThis.localStorage.getItem(key) === null)
        globalThis.localStorage.setItem(key, value);
    },
    [
      SETTINGS_KEY,
      JSON.stringify({
        v: 1,
        settings: {
          relays: [],
          nfx: {
            enabled: true,
            network: NS,
            scopedRelays: [relayUrl],
            webrtc: true,
            meshRelays: ['ws://127.0.0.1:9'],
            stunServers: ['127.0.0.1:9'],
          },
        },
      }),
    ] as const,
  );
  await context.addInitScript(REMOVE_WEBRTC_AND_WASM);
  const page = await context.newPage();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  page.on('websocket', (ws) => requests.push(ws.url()));
  await bridge.attach(page);
  await page.goto(`${origin}/${hash}`);
  return { page, errors, requests };
}

async function start(): Promise<World> {
  const work = mkdtempSync(join(tmpdir(), 'nutflix-publish-world-'));
  cleanups.push(() => {
    rmSync(work, { recursive: true, force: true });
  });
  const clip = join(work, 'a clip to publish.mp4');
  makeClip(clip);

  const testnet = await createTestnet(3);
  cleanups.push(() => testnet.destroy());

  const relayPort = await freePort();
  mkdirSync(join(work, 'strfry-db'));
  const conf = readFileSync(need('STRFRY_CONF'), 'utf8')
    .replace(/^db = "\.\/strfry-db\/"$/m, `db = "${join(work, 'strfry-db')}/"`)
    .replace(/^(\s*)port = 7777$/m, `$1port = ${String(relayPort)}`)
    .replace(/^(\s*)nofiles = [0-9]+$/m, '$1nofiles = 0');
  expect(conf).toContain(`port = ${String(relayPort)}`);
  expect(conf).toContain('bind = "127.0.0.1"');
  writeFileSync(join(work, 'strfry.conf'), conf);
  const strfry: ChildProcess = spawn(
    need('STRFRY'),
    [`--config=${join(work, 'strfry.conf')}`, 'relay'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let strfryLog = '';
  const take = (b: Buffer): void => {
    strfryLog = (strfryLog + b.toString()).slice(-8000);
  };
  strfry.stdout?.on('data', take);
  strfry.stderr?.on('data', take);
  cleanups.push(() => {
    strfry.kill('SIGTERM');
  });
  await waitPort(relayPort, () => strfryLog);
  const relayUrl = `ws://127.0.0.1:${String(relayPort)}`;

  const beacons = await RelayWatch.open(relayUrl, { kinds: [20464] });
  cleanups.push(() => {
    beacons.close();
  });

  const site = await serveDir(APP);
  cleanups.push(() => site.close());
  const browser = await chromium.launch({
    headless: true,
    executablePath: need('CHROMIUM'),
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  cleanups.push(() => browser.close());

  const publisher = await startBareBridge(testnet.bootstrap);
  cleanups.push(() => publisher.close());
  publisher.dialogs.file = clip;
  const { page, errors, requests } = await openApp(
    browser,
    relayUrl,
    publisher,
    site.origin,
    '#/settings',
  );
  return {
    testnet,
    relayUrl,
    site,
    browser,
    clip,
    beacons,
    publisher,
    page,
    pageErrors: errors,
    requests,
  };
}

describe('seed and publish, on loopback', () => {
  let world: World | undefined;
  const w = (): World => {
    if (world === undefined) throw new Error('the world did not start');
    return world;
  };
  let video = '';
  let root = '';
  let segs = 0n;
  let author = '';
  let manifestEvent: NostrEvent | undefined;

  beforeAll(async () => {
    world = await start();
  }, 240_000);

  afterAll(async () => {
    for (const c of cleanups.splice(0).reverse()) await Promise.resolve(c()).catch(() => undefined);
  }, 60_000);

  it('a launch with nothing to play or seed starts no DHT node, and the switch is off', async () => {
    const { page, publisher } = w();
    await page.locator('#nutflix-seed-publish').waitFor({ state: 'attached', timeout: 60_000 });
    await page
      .locator('#nutflix-ffmpeg[data-found="true"]')
      .waitFor({ state: 'attached', timeout: 30_000 });
    expect(await page.locator('#nutflix-seed-switch').isChecked()).toBe(false);
    expect(await page.locator('#nutflix-seed-disclosure').textContent()).toContain(
      'shares your IP address with viewers',
    );
    const s = (await publisher.request('status', {})) as WorkerStatus;
    expect(s.dht).toBe('idle');
    expect(s.listening).toEqual([]);
    report('idle-launch', { dht: s.dht, listeners: s.listening.length });
  });

  it('the passphrase path: sealed 0600, a wrong passphrase refused, the right one opens', async () => {
    const { page, publisher } = w();
    const status = page.locator('#nutflix-signer-status');
    // The page has no field and no button for it, only a pointer to the Account menu. What the
    // menu does in main runs for real here; the menu click and the typing are scripted.
    expect(await page.locator('#nutflix-seed-publish input[type="password"]').count()).toBe(0);
    for (const id of ['create', 'unlock', 'connect', 'lock'])
      expect(await page.locator(`#nutflix-signer-${id}`).count()).toBe(0);
    expect(await page.locator('#nutflix-signer-note').textContent()).toContain('Account menu');
    publisher.dialogs.secrets.push(PASS);
    expect((await publisher.account('create')).problem).toBeNull();
    await page
      .locator('#nutflix-signer-status[data-kind="local"][data-locked="false"]')
      .waitFor({ state: 'attached', timeout: 60_000 });
    author = (await status.getAttribute('data-pubkey')) ?? '';
    expect(author).toMatch(/^[0-9a-f]{64}$/);
    expect(publisher.dialogs.secrets).toEqual([]);

    const keyFile = join(publisher.storage, 'signer', 'user.key');
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(keyFile)).mode & 0o777).toBe(0o700);
    const sealed = readFileSync(keyFile, 'utf8');
    expect(sealed).not.toContain(PASS);
    expect(Object.keys(JSON.parse(sealed) as object).sort()).toEqual(
      ['aead', 'ct', 'kdf', 'kind', 'pubkey', 'v', 'walletKey'].sort(),
    );

    expect((await publisher.account('lock')).problem).toBeNull();
    await page
      .locator('#nutflix-signer-status[data-locked="true"]')
      .waitFor({ state: 'attached', timeout: 20_000 });
    // One prompt: the wrong passphrase is refused in it, still locked, and the right one opens.
    let lockedAtRefusal = false;
    publisher.dialogs.afterRefusal = async () => {
      lockedAtRefusal = ((await publisher.request('signer.status', {})) as SignerStatusWire).locked;
    };
    publisher.dialogs.secrets.push('this is not the passphrase', PASS);
    expect((await publisher.account('unlock')).problem).toBeNull();
    publisher.dialogs.afterRefusal = null;
    expect(publisher.dialogs.problems[0]).toContain('does not open this key');
    expect(lockedAtRefusal).toBe(true);
    expect(await page.content()).not.toContain('this is not the passphrase');
    await page
      .locator('#nutflix-signer-status[data-locked="false"]')
      .waitFor({ state: 'attached', timeout: 60_000 });
    report('passphrase', { mode: '0600', wrongRefused: true, reopened: true });
  }, 240_000);

  it('publishes a real clip through Settings, in two sizes, with the system ffmpeg', async () => {
    const { page, publisher } = w();
    await page.locator('#nutflix-pick').click();
    await page
      .locator('#nutflix-picked[data-ready="true"]')
      .waitFor({ state: 'attached', timeout: 60_000 });
    expect(publisher.dialogs.asked).toBe(1);
    const picked = (await page.locator('#nutflix-picked').textContent()) ?? '';
    expect(picked).toContain('a clip to publish.mp4');
    expect(picked).toContain('854x480');
    // The page was never told where the file is.
    expect(
      await page.evaluate(() => new XMLSerializer().serializeToString(document)),
    ).not.toContain(dirname(w().clip));
    const boxes = page.locator('#nutflix-sizes input');
    expect(await boxes.count()).toBe(2);
    for (let i = 0; i < 2; i++) await boxes.nth(i).check();
    await page.locator('#nutflix-title').fill(TITLE);
    await page.locator('#nutflix-description').fill('Made on a runner, for this proof.');
    await page.locator('#nutflix-tags').fill('proof loopback');
    await page.locator('#nutflix-publish').click();
    const done = page.locator('#nutflix-publish-status[data-state="done"]');
    try {
      await done.waitFor({ state: 'attached', timeout: 420_000 });
    } catch (e) {
      const said = await page.locator('#nutflix-publish-status').textContent();
      throw new Error(`publish did not finish: ${said ?? ''}\n${publisher.stderr()}`, {
        cause: e,
      });
    }
    // Main asked first, with the worker's own account of the file and of what would be signed.
    expect(publisher.dialogs.publishes).toHaveLength(1);
    const shown = publisher.dialogs.publishes[0];
    expect(shown).toMatchObject({
      title: TITLE,
      signer: author,
      npub: npubEncode(author),
      tags: ['proof', 'loopback'],
      description: 'Made on a runner, for this proof.',
      file: { name: 'a clip to publish.mp4', bytes: statSync(w().clip).size },
    });
    expect(shown?.file.durationSec).toBeGreaterThan(7);
    expect(shown?.file.durationSec).toBeLessThan(9);
    video = (await page.locator('#nutflix-publish-status').getAttribute('data-video')) ?? '';
    expect(video.startsWith(`${NS}:nutflix-`)).toBe(true);
    const st = (await publisher.request('seeding.status', {})) as SeedingStatusWire;
    expect(st.watched).toBe(false);
    expect(st.videos).toHaveLength(1);
    expect(st.videos[0]).toMatchObject({ video, origin: 'published', served: true });
    expect(st.listening).toHaveLength(1);
    root = st.videos[0]?.root ?? '';
    report('published', {
      video,
      files: st.videos[0]?.files,
      bytes: st.videos[0]?.bytes,
      listeners: st.listening.length,
    });
    // Nothing of the job is left behind in the worker's temporary directory.
    expect(existsSync(join(publisher.storage, 'tmp'))).toBe(true);
    const left = spawnSync('find', [join(publisher.storage, 'tmp'), '-name', 'studio-*'], {
      encoding: 'utf8',
    }).stdout.trim();
    expect(left).toBe('');
  }, 480_000);

  it('the manifest and a beacon reached strfry, and both verify', async () => {
    const { relayUrl, beacons } = w();
    const manifests = await RelayWatch.open(relayUrl, { kinds: [38504], authors: [author] });
    cleanups.push(() => {
      manifests.close();
    });
    const m = await until('the manifest on strfry', () => manifests.events[0], 20_000);
    manifestEvent = m;
    const parsed = parseManifest(m);
    if (!parsed.ok) throw new Error(parsed.error.reason);
    expect(parsed.value.author).toBe(author);
    expect(parsed.value.addr.toString()).toBe(video);
    expect(parsed.value.title).toBe(TITLE);
    expect(parsed.value.root).toBe(root);
    expect(parsed.value.license.mode).toBe('open');
    expect(parsed.value.priceHint).toBeUndefined();
    expect([...parsed.value.hashtags]).toEqual(['proof', 'loopback']);
    segs = parsed.value.segs;

    const b = await until(
      'a beacon on strfry',
      () => beacons.events.find((e) => e.tags.some((t) => t[0] === 'a' && t[1]?.endsWith(video))),
      30_000,
    );
    const beacon = parseBeacon(b, Math.floor(Date.now() / 1000));
    if (!beacon.ok) throw new Error(beacon.error.reason);
    expect(beacon.value.creator).toBe(author);
    expect(beacon.value.content.free).toBe(true);
    expect(beacon.value.content.priceHint).toBe(0n);
    expect(beacon.value.seeder).not.toBe(author);
    report('relay', {
      manifestVerified: true,
      beaconVerified: true,
      seederIsNotCreator: true,
      segs: Number(segs),
    });
  });

  it('nutflix-pear’s dialNfx fetches the published video, byte for byte', async () => {
    const { beacons, publisher, testnet } = w();
    const b = beacons.events.find((e) => e.tags.some((t) => t[0] === 'a' && t[1]?.endsWith(video)));
    const parsed = parseBeacon(b, Math.floor(Date.now() / 1000));
    if (!parsed.ok) throw new Error(parsed.error.reason);
    const ep = parsed.value.content.endpoints.find((e) => e.t === 'hyperdht');
    if (ep?.t !== 'hyperdht') throw new Error('no hyperdht endpoint');
    const r = await fetchEverything(
      testnet.bootstrap,
      ep.peer,
      video,
      root,
      segs,
      publisher.storage,
    );
    expect(r.files).toBe(Number(segs));
    expect(r.store).toBe(r.files);
    expect(r.bytes).toBeGreaterThan(0);
    report('dialNfx', { files: r.files, bytes: r.bytes, comparedWithStore: r.store });
  }, 120_000);

  it('a second app instance finds it, plays it, and with the switch on re-seeds it', async () => {
    const { browser, relayUrl, site, testnet, beacons } = w();
    const viewer = await startBareBridge(testnet.bootstrap);
    cleanups.push(() => viewer.close());
    viewer.dialogs.confirmSeeding = true;
    const address = `38504:${author}:${video}`;
    const { page, errors, requests } = await openApp(
      browser,
      relayUrl,
      viewer,
      site.origin,
      '#/settings',
    );
    await page.locator('#nutflix-seed-publish').waitFor({ state: 'attached', timeout: 60_000 });
    await page.locator('#nutflix-seed-switch').click();
    await expect
      .poll(() => page.locator('#nutflix-seed-switch').isChecked(), { timeout: 15_000 })
      .toBe(true);
    expect(viewer.dialogs.asked).toBe(1);

    await page.evaluate((a) => {
      globalThis.history.replaceState(null, '', `#/watch/${a}`);
      globalThis.dispatchEvent(new HashChangeEvent('hashchange'));
    }, address);
    await page.waitForFunction(
      (t) => document.querySelector('.nf-watch__title')?.textContent === t,
      TITLE,
      { timeout: 60_000 },
    );
    await page.getByRole('button', { name: /^Play — free$/ }).click();
    const el = page.locator('video').first();
    await el.waitFor({ state: 'attached', timeout: 90_000 });
    expect(await el.getAttribute('src')).toMatch(
      /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[0-9a-f]{32}\/[0-9a-f]{32}$/,
    );
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v !== null && v.currentTime > 2 && !v.paused;
      },
      undefined,
      { timeout: 120_000, polling: 250 },
    );
    const played = await el.evaluate((v) => {
      const m = v as HTMLVideoElement;
      return { t: m.currentTime, w: m.videoWidth, h: m.videoHeight, err: m.error?.code ?? null };
    });
    expect(played.err).toBeNull();
    expect([played.w, played.h]).toEqual([854, 480]);
    report('played', played);

    // With the switch on, the play also stored the video: the viewer now seeds it.
    await expect
      .poll(
        async () => {
          const s = (await viewer.request('seeding.status', {})) as SeedingStatusWire;
          return s.videos.filter((v) => v.video === video && v.origin === 'watched' && v.served)
            .length;
        },
        { timeout: 120_000, interval: 500 },
      )
      .toBe(1);
    const events = (
      (await viewer.request('seeding.beacons', {})) as { events: readonly NostrEvent[] }
    ).events;
    expect(events).toHaveLength(1);
    const parsed = parseBeacon(events[0], Math.floor(Date.now() / 1000));
    if (!parsed.ok) throw new Error(parsed.error.reason);
    const ep = parsed.value.content.endpoints.find((e) => e.t === 'hyperdht');
    if (ep?.t !== 'hyperdht') throw new Error('no hyperdht endpoint');
    const fetched = await fetchEverything(
      testnet.bootstrap,
      ep.peer,
      video,
      root,
      segs,
      viewer.storage,
    );
    expect(fetched.files).toBe(Number(segs));
    expect(fetched.store).toBe(fetched.files);
    report('re-seeded', {
      files: fetched.files,
      bytes: fetched.bytes,
      seeder: parsed.value.seeder.slice(0, 8),
    });
    // The viewer's beacons went to the relay as well, from its own page.
    await until(
      'the viewer’s beacon on strfry',
      () => beacons.events.find((e) => e.pubkey === parsed.value.seeder),
      75_000,
    );
    expect(errors).toEqual([]);
    const off = requests.filter(
      (u) =>
        !/^(http|ws):\/\/127\.0\.0\.1:/.test(u) && !u.startsWith('blob:') && !u.startsWith('data:'),
    );
    expect(off).toEqual([]);
  }, 480_000);

  it('NIP-46: a throwaway bunker signs a manifest for the real worker', async () => {
    const { relayUrl, testnet, clip } = w();
    const bunker = await TestBunker.start(relayUrl, { secret: 'one-time' });
    cleanups.push(() => {
      bunker.close();
    });
    const b = await startBareBridge(testnet.bootstrap);
    cleanups.push(() => b.close());
    const st = (await b.request(
      'signer.nip46.connect',
      { uri: bunker.uri },
      60_000,
    )) as SignerStatusWire;
    expect(st).toMatchObject({ kind: 'nip46', pubkey: bunker.userPubkey, locked: false });
    expect(JSON.stringify(st)).not.toContain('one-time');
    const source = (await b.request('studio.source', { path: clip })) as { source: string };
    const pub = (await b.request(
      'studio.publish',
      { source: source.source, title: 'Via a bunker', description: '', tags: [], sizes: [360] },
      420_000,
    )) as { video: string };
    expect(Object.keys(pub).sort()).toEqual(['bytes', 'files', 'video']);
    const check = (await b.request('signer.check', { video: pub.video }, 10_000)) as {
      event: { kind: number; created_at: number; tags: string[][]; content: string };
      signer: string;
      npub: string;
    };
    expect(check.signer).toBe(bunker.userPubkey);
    expect(check.npub).toBe(npubEncode(bunker.userPubkey));
    const draft = check.event;
    const signer = check.signer;
    const refusedSign = (event: unknown, key = signer): Promise<unknown> =>
      expect(b.request('signer.sign', { event, signer: key }, 10_000)).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    // Only the worker's own draft is signed: a page cannot change a word of it.
    await refusedSign({ ...draft, content: 'changed by a page' });
    await refusedSign({
      ...draft,
      tags: draft.tags.map((t) => (t[0] === 'root' ? ['root', 'cc'.repeat(32)] : t)),
    });
    // And only by the key the user was shown.
    await refusedSign(draft, 'ef'.repeat(32));
    expect(bunker.signedKinds).toEqual([]);
    const signed = (await b.request('signer.sign', { event: draft, signer }, 60_000)) as NostrEvent;
    const parsed = parseManifest(signed);
    if (!parsed.ok) throw new Error(parsed.error.reason);
    expect(parsed.value.author).toBe(bunker.userPubkey);
    expect(parsed.value.addr.toString()).toBe(pub.video);
    expect(parsed.value.root).toBe(draft.tags.find((t) => t[0] === 'root')?.[1]);
    expect(bunker.signedKinds).toEqual([38504]);
    // The record says "signed" on disk by the time the signed event is handed back.
    const onDisk = JSON.parse(readFileSync(join(b.storage, 'seeding.json'), 'utf8')) as {
      videos: Record<string, { author: string | null; title?: string }>;
    };
    expect(onDisk.videos[pub.video]).toMatchObject({
      author: bunker.userPubkey,
      title: 'Via a bunker',
    });
    await refusedSign({ ...draft, kind: 1 });
    // And it is signed once.
    await refusedSign(draft);
    expect(bunker.signedKinds).toEqual([38504]);
    report('nip46', {
      signer: 'bunker',
      kinds: bunker.signedKinds,
      manifestVerified: true,
      nonAllowListedKindRefused: true,
      otherKeyRefused: true,
    });

    // The real worker's relay socket says who it is, so a local service that checks origins can
    // refuse it.
    const loop = await LoopRelay.start();
    cleanups.push(() => loop.close());
    const originBunker = await TestBunker.start(loop.url, { secret: 'one-time-too' });
    cleanups.push(() => {
      originBunker.close();
    });
    const c = await startBareBridge(testnet.bootstrap);
    cleanups.push(() => c.close());
    await c.request('signer.nip46.connect', { uri: originBunker.uri }, 60_000);
    expect(loop.origins).toContain('app://nutflix');
    report('relay-origin', { origin: 'app://nutflix' });

    // A real encode that nobody confirmed: it cannot be played, and declining deletes it.
    const before = ((await b.request('status', {})) as WorkerStatus).storedVideos;
    const again = (await b.request('studio.source', { path: clip })) as { source: string };
    const unconfirmed = (await b.request(
      'studio.publish',
      { source: again.source, title: 'Never confirmed', description: '', tags: [], sizes: [360] },
      420_000,
    )) as { video: string };
    const held = (await b.request('signer.check', { video: unconfirmed.video }, 10_000)) as {
      event: { tags: string[][] };
    };
    const tag = (n: string): string => held.event.tags.find((t) => t[0] === n)?.[1] ?? '';
    await expect(
      b.request(
        'nfx.play.open',
        {
          sid: 'ab'.repeat(16),
          video: unconfirmed.video,
          root: tag('root'),
          segs: Number(tag('segs')),
          peers: [],
          progressive: false,
        },
        10_000,
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
    const listed = (await b.request('seeding.status', {})) as SeedingStatusWire;
    const row = listed.videos.find((v) => v.video === unconfirmed.video);
    expect(row).toMatchObject({ served: false });
    expect(row).not.toHaveProperty('root');
    expect(row).not.toHaveProperty('segs');
    expect(await b.request('studio.discard', { video: unconfirmed.video })).toEqual({
      removed: true,
    });
    expect(((await b.request('status', {})) as WorkerStatus).storedVideos).toBe(before);
    report('unconfirmed-draft', { playRefused: true, hashListHidden: true, declineDeleted: true });
  }, 600_000);

  it('real Bare reads the free space and writes through to disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nutflix-bare-disk-'));
    cleanups.push(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    const dist = (f: string): string =>
      pathToFileURL(join(here, '..', '..', '..', 'worker', 'dist', f)).href;
    const entry = join(dir, 'probe.mjs');
    writeFileSync(
      entry,
      `import ${JSON.stringify(dist('bare-globals.js'))};
import { bareRuntime } from ${JSON.stringify(dist('adapters/bare.js'))};
const dir = ${JSON.stringify(dir)};
const { system } = bareRuntime();
const bytes = (o) => new TextEncoder().encode(JSON.stringify(o));
void (async () => {
  const free = await system.freeBytes(dir);
  const first = await system.writeDurable(dir + '/out.json', bytes({ step: 1 }));
  const second = await system.writeDurable(dir + '/out.json', bytes({ step: 2 }));
  await system.writeDurable(dir + '/done.json', bytes({ free, first, second }));
})();
`,
    );
    const script = startBareScript(entry);
    cleanups.push(() => {
      script.stop();
    });
    const doneFile = join(dir, 'done.json');
    try {
      await until('the Bare script', () => (existsSync(doneFile) ? true : null), 30_000);
    } catch (e) {
      throw new Error(`the Bare script did not finish: ${script.stderr()}`, { cause: e });
    }
    const done = JSON.parse(readFileSync(doneFile, 'utf8')) as {
      free: number;
      first: boolean;
      second: boolean;
    };
    expect([done.first, done.second]).toEqual([true, true]);
    expect(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'))).toEqual({ step: 2 });
    expect(statSync(join(dir, 'out.json')).mode & 0o777).toBe(0o600);
    const fromNode = statfsSync(dir);
    const expected = fromNode.bavail * fromNode.bsize;
    expect(done.free).toBeGreaterThan(0);
    expect(Math.abs(done.free - expected) / expected).toBeLessThan(0.05);
    report('bare-disk', { freeSpaceRead: true, replacedDurably: true, directorySynced: true });
  }, 60_000);

  it('the publisher’s page reached nothing off loopback and broke nothing', () => {
    const { pageErrors, requests } = w();
    expect(pageErrors).toEqual([]);
    const off = requests.filter(
      (u) =>
        !/^(http|ws):\/\/127\.0\.0\.1:/.test(u) && !u.startsWith('blob:') && !u.startsWith('data:'),
    );
    expect(off).toEqual([]);
    expect(manifestEvent).toBeDefined();
  });
});
