/**
 * One viewer, in its own network namespace: the real worker, the real renderer bundle in headless
 * Chromium, a private HyperDHT testnet on this namespace's loopback with nutflix-pear's own seeder
 * on it, and a local relay for the manifest and the beacons. What it shares with the other viewer
 * is only what a viewer would: the signaling relay and the wire between their ICE agents.
 *
 * Its seeder holds the whole video and records every file it is asked for (`seederAsked`). The
 * worker's origin fetches a file from it only when the player requests that file over HTTP, so a
 * segment that was appended to a SourceBuffer and never asked of the seeder can have come only
 * from a peer: that is how a proof knows bytes came over WebRTC, with the player on its own
 * default scheduling.
 *
 * Driven over stdio by `webrtc.netns.ts`: JSON lines in (`status`, `stop`), `PEER <json>` out.
 * Bundled by that file (esbuild) and run as a plain node script.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { chromium } from 'playwright-core';
import createTestnet from 'hyperdht/testnet.js';
import DHT from 'hyperdht';

import type { NostrEvent } from '@sovit/core';
import { beaconTags } from '@sovit/core/nfx';
import { hyperdhtEndpoint, listenNfx, type NfxFileSource } from '@sovit/seeder';

import { Key, NS } from '../../src/__tests__/support/nfx.js';
import { SETTINGS_KEY } from '../../src/settings/store.js';
import { TestRelay } from '../helpers/relay.js';
import { startWorkerBridge } from '../helpers/worker-bridge.js';
import { serveDir } from '../static-server.js';
import { OBSERVER_SCRIPT, type Observed } from './page.js';

export interface PeerConfig {
  /** The built renderer. */
  readonly app: string;
  /** The package's `store/`: every file by sha256. */
  readonly store: string;
  readonly video: string;
  /** Segment content names in playlist order. */
  readonly segments: readonly string[];
  readonly manifest: NostrEvent;
  /** `38504:<creator>:<namespace>:<id>`. */
  readonly addr: string;
  readonly title: string;
  /** The signaling relay, as this namespace reaches it. */
  readonly relayHost: string;
  readonly relayPort: number;
  /** `ip:port` of the STUN server. */
  readonly stun: string;
}

export interface PeerStatus {
  readonly seederKey: string;
  /** Every file this viewer's own seeder was asked for, by sha256. */
  readonly seederAsked: readonly string[];
  readonly player: string | null;
  readonly src: string | null;
  readonly t: number;
  readonly paused: boolean;
  readonly error: number | null;
  readonly cspViolations: readonly string[];
  readonly pageErrors: readonly string[];
  /** What the watch screen says, and the page's last console lines: for a failure's message. */
  readonly stage: string | null;
  readonly console: readonly string[];
  readonly offLoopback: readonly string[];
  readonly observed: Observed;
}

const say = (o: unknown): void => {
  process.stdout.write(`PEER ${JSON.stringify(o)}\n`);
};

/** A TCP forward on this namespace's loopback: the player signals only to `ws:` on loopback. */
async function forward(host: string, port: number): Promise<{ port: number; server: Server }> {
  const sockets = new Set<Socket>();
  const server = createServer((c) => {
    const up = connect(port, host);
    for (const s of [c, up]) {
      sockets.add(s);
      s.on('error', () => {
        c.destroy();
        up.destroy();
      });
      s.on('close', () => sockets.delete(s));
    }
    c.pipe(up);
    up.pipe(c);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  server.on('close', () => {
    for (const s of sockets) s.destroy();
  });
  return { port: (server.address() as AddressInfo).port, server };
}

async function main(cfg: PeerConfig): Promise<void> {
  const files = new Map<string, Uint8Array>();
  const asked = new Set<string>();
  // Files by sha256 only: nfxd keeps a working directory of its own in the same store.
  for (const name of readdirSync(cfg.store).filter((n) => /^[0-9a-f]{64}$/.test(n))) {
    files.set(name, readFileSync(join(cfg.store, name)));
  }
  const source: NfxFileSource = {
    hasVideo: (v) => v.toString() === cfg.video,
    file: (v, sha) => {
      const data = v.toString() === cfg.video ? files.get(sha) : undefined;
      if (data === undefined) return undefined;
      return {
        size: data.byteLength,
        read: (offset, length) => {
          asked.add(sha);
          return Promise.resolve(data.subarray(offset, offset + length));
        },
      };
    },
  };

  const testnet = await createTestnet(3);
  // Not firewalled, as a public seeder is: the worker tells no peer its local addresses
  // (`net/no-local-addresses.ts`), so on one host it meets only a node it can reach directly.
  const seederDht = new DHT({ bootstrap: testnet.bootstrap, firewalled: false });
  await seederDht.fullyBootstrapped();
  const keyPair = DHT.keyPair();
  const listener = await listenNfx(seederDht, { keyPair, source });
  const seederKey = new Key();
  const endpoint = hyperdhtEndpoint(keyPair, seederKey.pubkey, NS);
  const relay = await TestRelay.start({
    beaconEveryMs: 2_000,
    beacon: () => {
      const at = Math.floor(Date.now() / 1000);
      const tags = beaconTags(cfg.addr, at, 120);
      if (!tags.ok) throw new Error(tags.error.reason);
      return seederKey.sign({
        kind: 20464,
        created_at: at,
        tags: tags.value,
        content: JSON.stringify({
          v: 1,
          video: cfg.video,
          endpoints: [{ t: 'hyperdht', peer: endpoint.peer, bind: endpoint.bind }],
          chunks: 'all',
          price_hint: 0,
          free: true,
        }),
      });
    },
  });
  relay.store(cfg.manifest);
  const mesh = await forward(cfg.relayHost, cfg.relayPort);
  const bridge = await startWorkerBridge(testnet.bootstrap);
  const site = await serveDir(cfg.app);

  const browser = await chromium.launch({
    headless: true,
    ...(process.env['CHROMIUM'] === undefined ? {} : { executablePath: process.env['CHROMIUM'] }),
    args: [
      '--autoplay-policy=no-user-gesture-required',
      // What the shell sets on its webContents (ADR 0001 decision 5), here as Chromium's switch.
      '--force-webrtc-ip-handling-policy=default_public_interface_only',
    ],
  });
  const context = await browser.newContext();
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
            scopedRelays: [relay.url],
            webrtc: true,
            meshRelays: [`ws://127.0.0.1:${String(mesh.port)}`],
            stunServers: [cfg.stun],
          },
        },
      }),
    ] as const,
  );
  await context.addInitScript(OBSERVER_SCRIPT);
  const page = await context.newPage();
  const requests: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('websocket', (w) => requests.push(w.url()));
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const consoleLines: string[] = [];
  page.on('console', (m) => {
    consoleLines.push(`${m.type()}: ${m.text().slice(0, 200)}`);
    if (consoleLines.length > 30) consoleLines.shift();
  });
  const stageText = async (): Promise<string | null> =>
    page.evaluate(
      () => document.querySelector('.nf-nfxwatch__stage')?.textContent.slice(0, 400) ?? null,
    );
  await bridge.attach(page);
  await page.goto(`${site.origin}/#/watch/${cfg.addr}`);
  await page.waitForFunction(
    (t) => document.querySelector('.nf-watch__title')?.textContent === t,
    cfg.title,
    { timeout: 60_000 },
  );
  await page.waitForFunction(
    () => document.getElementById('root')?.dataset['webrtcPlayer'] !== undefined,
    undefined,
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: /^Play — free$/ }).click();
  try {
    await page.locator('video').first().waitFor({ state: 'attached', timeout: 60_000 });
  } catch (e) {
    const worker: unknown = await bridge.host.handle('status', {});
    throw new Error(
      `no <video>: ${JSON.stringify({ stage: await stageText(), worker, pageErrors, console: consoleLines })}`,
      { cause: e },
    );
  }
  say({ ev: 'playing', seederKey: seederKey.pubkey });

  const status = async (): Promise<PeerStatus> => {
    const inPage = await page.evaluate(() => {
      const g = globalThis as unknown as { __observed: Observed; __cspViolations: string[] };
      const v = document.querySelector('video');
      return {
        player: document.getElementById('root')?.dataset['webrtcPlayer'] ?? null,
        src: v?.currentSrc ?? null,
        t: v?.currentTime ?? 0,
        paused: v?.paused ?? true,
        error: v?.error?.code ?? null,
        cspViolations: g.__cspViolations,
        observed: g.__observed,
      };
    });
    return {
      ...inPage,
      seederKey: seederKey.pubkey,
      seederAsked: [...asked],
      pageErrors,
      stage: await stageText(),
      console: consoleLines,
      offLoopback: requests.filter(
        (u) =>
          !/^(http|ws):\/\/127\.0\.0\.1:/.test(u) &&
          !u.startsWith('blob:') &&
          !u.startsWith('data:'),
      ),
    };
  };

  const stop = async (): Promise<void> => {
    await browser.close().catch(() => undefined);
    await bridge.close().catch(() => undefined);
    await site.close().catch(() => undefined);
    await relay.close().catch(() => undefined);
    await listener.close().catch(() => undefined);
    await seederDht.destroy().catch(() => undefined);
    await testnet.destroy().catch(() => undefined);
    mesh.server.close();
  };

  for await (const line of createInterface({ input: process.stdin })) {
    const cmd = (JSON.parse(line) as { cmd?: string }).cmd;
    if (cmd === 'status') {
      try {
        say({ ev: 'status', status: await status() });
      } catch (e) {
        say({ ev: 'failed', error: e instanceof Error ? e.message : String(e) });
      }
    } else if (cmd === 'stop') {
      await stop();
      say({ ev: 'stopped' });
      process.exit(0);
    }
  }
  await stop();
  process.exit(0);
}

main(JSON.parse(process.argv[2] ?? 'null') as PeerConfig).catch((e: unknown) => {
  say({ ev: 'failed', error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
  process.exit(1);
});
