/**
 * The renderer, end to end (ADR 0001 decision 4, the hyper-only fallback): the built bundle in
 * headless Chromium, behind the policy in its own `<meta>`, playing a real video that a real
 * worker fetches over HyperDHT.
 *
 *   seeder     nutflix-pear's own `listenNfx` (`@sovit/seeder`) on a loopback hyperdht testnet,
 *              serving a VP9 NFX package ffmpeg made, under a key whose beacons are really signed
 *   relay      a local Nostr relay: the manifest, and a fresh beacon on every subscription
 *   worker     the real worker (`WorkerHost` behind `WorkerRpc`), `init`ed on the same testnet
 *   renderer   `dist/app` over loopback http; its `WorkerPipe` is a Playwright bridge
 *
 * It checks that the video plays (`currentTime` advances), that it plays from the worker's
 * loopback stream, that leaving the page closes the worker's session, that the page reached
 * nothing off loopback, and that the policy was never violated.
 *
 * Needs: ffmpeg with libvpx-vp9 (`FFMPEG`), a Chromium (Playwright's, or `CHROMIUM`), and, as
 * root or where the sandbox cannot start, `NUTFLIX_E2E_NO_SANDBOX=1`. `npm run test:e2e` builds
 * the bundle first.
 */
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import DHT from 'hyperdht';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { beaconTags } from '@sovit/core/nfx';
import { hyperdhtEndpoint, listenNfx, type NfxFileSource } from '@sovit/seeder';

import { Key, NS, addrOf, manifest } from '../src/__tests__/support/nfx.js';
import { SETTINGS_KEY } from '../src/settings/store.js';
import { makeVp9Package, type Vp9Package } from './helpers/vp9-nfx.js';
import { TestRelay } from './helpers/relay.js';
import { startWorkerBridge, type WorkerBridge } from './helpers/worker-bridge.js';
import { serveDir } from './static-server.js';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..', 'dist', 'app');

const seederKey = new Key();
const creator = new Key();
const TITLE = 'Counting in VP9';
const VIDEO_ID = `e2e-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 24)}`;

function memorySource(files: ReadonlyMap<string, Uint8Array>, video: string): NfxFileSource {
  return {
    hasVideo: (v) => v.toString() === video,
    file: (v, sha) => {
      const data = v.toString() === video ? files.get(sha) : undefined;
      if (data === undefined) return undefined;
      return {
        size: data.byteLength,
        read: (offset, length) => Promise.resolve(data.subarray(offset, offset + length)),
      };
    },
  };
}

/** What the page's own code would try: the policy has no 'unsafe-eval', so it must throw. */
const EVAL_PROBE =
  "try { new Function('return 1')(); globalThis.__evalProbe = 'ran'; } catch (e) { globalThis.__evalProbe = e.name; }";

const cleanups: (() => Promise<void>)[] = [];

interface World {
  readonly page: Page;
  readonly site: { readonly origin: string };
  readonly relay: TestRelay;
  readonly bridge: WorkerBridge;
  readonly requests: string[];
  readonly pageErrors: string[];
}

/** Everything the test needs, each resource registered for cleanup as soon as it exists. */
async function start(): Promise<World> {
  const pkg: Vp9Package = makeVp9Package(`${NS}:${VIDEO_ID}`);
  const testnet: Testnet = await createTestnet(3);
  cleanups.push(() => testnet.destroy());

  // The seeder: nutflix-pear's own NFX-12 listener, on its own node of the testnet.
  const seederDht = new DHT({ bootstrap: testnet.bootstrap });
  cleanups.push(() => seederDht.destroy());
  await seederDht.fullyBootstrapped();
  const keyPair = DHT.keyPair();
  const listener = await listenNfx(seederDht, {
    keyPair,
    source: memorySource(pkg.files, pkg.video),
  });
  cleanups.push(() => listener.close());
  const endpoint = hyperdhtEndpoint(keyPair, seederKey.pubkey, NS);

  // The relay: the manifest, and a fresh signed beacon naming the seeder's endpoint.
  const addr = addrOf(creator, VIDEO_ID);
  const relay = await TestRelay.start({
    beaconEveryMs: 2_000,
    beacon: () => {
      const at = Math.floor(Date.now() / 1000);
      const tags = beaconTags(addr, at, 120);
      if (!tags.ok) throw new Error(tags.error.reason);
      return seederKey.sign({
        kind: 20464,
        created_at: at,
        tags: tags.value,
        content: JSON.stringify({
          v: 1,
          video: pkg.video,
          endpoints: [{ t: 'hyperdht', peer: endpoint.peer, bind: endpoint.bind }],
          chunks: 'all',
          price_hint: 0,
          free: true,
        }),
      });
    },
  });
  cleanups.push(() => relay.close());
  relay.store(
    manifest(creator, VIDEO_ID, {
      title: TITLE,
      root: pkg.root,
      segs: pkg.segs,
      duration: Math.round(pkg.durationSec),
      createdAt: Math.floor(Date.now() / 1000) - 3600,
    }),
  );

  const bridge = await startWorkerBridge(testnet.bootstrap);
  cleanups.push(() => bridge.close());
  const site = await serveDir(APP, { '/e2e-eval-probe.js': EVAL_PROBE });
  cleanups.push(() => site.close());

  const browser: Browser = await chromium.launch({
    headless: true,
    ...(process.env['CHROMIUM'] === undefined ? {} : { executablePath: process.env['CHROMIUM'] }),
    args: [
      '--autoplay-policy=no-user-gesture-required',
      ...(process.env['NUTFLIX_E2E_NO_SANDBOX'] === '1' ? ['--no-sandbox'] : []),
    ],
  });
  cleanups.push(() => browser.close());
  const context: BrowserContext = await browser.newContext();
  cleanups.push(() => context.close());
  // The viewer's settings, as the Settings screen would have stored them: this relay alone.
  await context.addInitScript(
    ([key, value]) => {
      if (globalThis.localStorage.getItem(key) === null)
        globalThis.localStorage.setItem(key, value);
    },
    [
      SETTINGS_KEY,
      JSON.stringify({
        v: 1,
        settings: { relays: [], nfx: { enabled: true, network: NS, scopedRelays: [relay.url] } },
      }),
    ] as const,
  );
  const page = await context.newPage();
  const requests: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await bridge.attach(page);
  return { page, site, relay, bridge, requests, pageErrors };
}

describe('the renderer plays a free NFX video over HyperDHT alone', () => {
  let world: World | undefined;
  const w = (): World => {
    if (world === undefined) throw new Error('the world did not start');
    return world;
  };

  beforeAll(async () => {
    world = await start();
  });

  afterAll(async () => {
    for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
  });

  it('lists the video, plays it from the worker’s loopback stream, and closes the play on leaving', async () => {
    const { page, site, bridge } = w();
    const addr = addrOf(creator, VIDEO_ID);
    await page.goto(`${site.origin}/#/watch/${addr}`);
    await page.waitForFunction(
      (t) => document.querySelector('.nf-watch__title')?.textContent === t,
      TITLE,
      { timeout: 30_000 },
    );
    // Nothing is asked of the worker until Play.
    expect((await bridge.host.handle('status', {})).playSessions).toBe(0);

    await page.getByRole('button', { name: /^Play — free$/ }).click();
    const video = page.locator('video').first();
    await video.waitFor({ state: 'attached', timeout: 60_000 });

    // The source is the worker's own progressive URL on loopback.
    const src = await video.getAttribute('src');
    expect(src).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/[0-9a-f]{32}\/[0-9a-f]{32}$/);
    expect((await bridge.host.handle('status', {})).playSessions).toBe(1);

    // It plays: the clock advances past two seconds, with no media error.
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v !== null && v.currentTime > 2 && !v.paused;
      },
      undefined,
      { timeout: 90_000, polling: 250 },
    );
    const state = await video.evaluate((v) => {
      const el = v as HTMLVideoElement;
      return {
        t: el.currentTime,
        readyState: el.readyState,
        error: el.error?.code ?? null,
        w: el.videoWidth,
        h: el.videoHeight,
      };
    });
    expect(state.error).toBeNull();
    expect(state.readyState).toBeGreaterThanOrEqual(2);
    expect([state.w, state.h]).toEqual([320, 240]);
    await page.waitForTimeout(1_500);
    const t2 = await video.evaluate((v) => (v as HTMLVideoElement).currentTime);
    expect(t2).toBeGreaterThan(state.t);

    // Leaving the page closes the worker's play.
    await page.getByRole('button', { name: 'Home' }).first().click();
    await expect
      .poll(async () => (await bridge.host.handle('status', {})).playSessions, { timeout: 20_000 })
      .toBe(0);
  });

  it('the page reached nothing off loopback, and its policy was never violated', async () => {
    const { page, site, relay, requests, pageErrors } = w();
    const off = requests.filter(
      (u) =>
        !/^(http|ws):\/\/127\.0\.0\.1:/.test(u) && !u.startsWith('blob:') && !u.startsWith('data:'),
    );
    expect(off).toEqual([]);
    expect(new URL(requests[0] ?? 'http://x').origin).toBe(site.origin);
    const violations = await page.evaluate(
      () => (globalThis as unknown as { __cspViolations: string[] }).__cspViolations,
    );
    expect(violations).toEqual([]);
    expect(pageErrors).toEqual([]);
    // The relay saw the page ask for the video's beacons (NFX-04: a live subscription).
    expect(relay.reqs.some((fs) => fs.some((f) => f.kinds?.includes(20464) === true))).toBe(true);
  });

  it('the policy holds in the page: an inline script and an eval do not run', async () => {
    const { page } = w();
    // A same-origin script is allowed (script-src 'self'), so it can try what the page's own code
    // could: `new Function`. (A function Playwright evaluates over CDP would bypass the eval check.)
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.src = '/e2e-eval-probe.js';
      document.head.append(s);
    });
    await page.waitForFunction(
      () => (globalThis as unknown as { __evalProbe?: string }).__evalProbe !== undefined,
      undefined,
      { timeout: 10_000 },
    );
    // An inline script is refused whoever adds it.
    await page.evaluate(async () => {
      const s = document.createElement('script');
      s.textContent = 'globalThis.__inlineRan = true';
      document.head.append(s);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const r = await page.evaluate(() => {
      const g = globalThis as unknown as { __evalProbe?: string; __inlineRan?: boolean };
      return [g.__evalProbe, String(g.__inlineRan === true)];
    });
    expect(r).toEqual(['EvalError', 'false']);
  });
});
