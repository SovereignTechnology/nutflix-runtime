/**
 * The WebRTC player, for real, on an isolated network (`topology.sh`). This file runs inside the
 * `nfx-hub` namespace, with strfry, a STUN server and nfxd; each viewer (`peer.ts`) runs in a
 * namespace of its own with a global-looking address, because the player's candidate filter
 * refuses loopback, private, link-local and mDNS candidates and is not weakened for a test.
 *
 *   1. Two viewers. A's seeder holds the whole video; B's holds the first segments only. B can get
 *      the rest from nobody but A, over WebRTC. It must play past them, and the sha256 of every
 *      byte it appended to its SourceBuffers must be a file of the package.
 *   2. nfxd at the pinned commit (`--mesh-relay`, a stock strfry) and one viewer holding the first
 *      segments only: the same, with nfxd as the peer.
 *   4. The candidate filter: the pinned library's own `filterRemoteSdp`, in this browser, on nfx's
 *      vectors (read from the pinned source, its sha256 checked) and on this app's.
 *
 * Both check the candidates that reached `setRemoteDescription`, the selected ICE pair, the policy
 * and that the page reached nothing off loopback. Session keys are read from what strfry carried.
 *
 * Needs (the `webrtc` workflow provides them): STRFRY, STRFRY_CONF, NFXD, NFX_SRC (the pinned
 * source), ffmpeg, a Chromium, and passwordless `sudo` to enter the two viewers' namespaces.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import type { NostrEvent } from '@sovit/core';

import { Key, NS, addrOf, manifest } from '../../src/__tests__/support/nfx.js';
import { makeVp9Package, type Vp9Package } from '../helpers/vp9-nfx.js';
import { serveDir } from '../static-server.js';
import { candidateAddresses } from './page.js';
import type { PeerConfig, PeerStatus } from './peer.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..', '..');
const APP = join(pkgDir, 'dist', 'app');
const PEER_BUNDLE = join(pkgDir, 'dist', 'netns', 'peer.mjs');

const HUB = '11.77.0.1';
const ADDR_A = '11.77.0.2';
const ADDR_B = '11.77.0.3';
const STUN_PORT = 3478;
/** The viewers' own seeders hold this many segments; the rest must come over WebRTC. */
const HELD = 5;
const SECONDS = 40;
/** nfx's `web/player/test-vectors/remote-sdp.json` at the pinned commit. */
const SDP_VECTORS_SHA256 = '6c2c929d990d6fd0291bff8007b2040f28a7b2276331728293fa491bf1064bb4';

const need = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
};

function report(name: string, o: unknown): void {
  console.warn(`${name} ${JSON.stringify(o)}`);
}

// ---- a STUN server (RFC 8489, Binding only) ----------------------------------------------------

async function startStun(): Promise<{ readonly answered: () => number; close(): void }> {
  const sock: UdpSocket = createSocket('udp4');
  let answered = 0;
  sock.on('message', (m, from) => {
    if (m.length < 20 || m.readUInt16BE(0) !== 0x0001 || m.readUInt32BE(4) !== 0x2112a442) return;
    const res = Buffer.alloc(32);
    res.writeUInt16BE(0x0101, 0);
    res.writeUInt16BE(12, 2);
    m.copy(res, 4, 4, 20);
    res.writeUInt16BE(0x0020, 20); // XOR-MAPPED-ADDRESS
    res.writeUInt16BE(8, 22);
    res[25] = 0x01;
    res.writeUInt16BE(from.port ^ 0x2112, 26);
    const ip = from.address.split('.').map(Number);
    const cookie = [0x21, 0x12, 0xa4, 0x42];
    for (let i = 0; i < 4; i++) res[28 + i] = (ip[i] ?? 0) ^ (cookie[i] ?? 0);
    answered += 1;
    sock.send(res, from.port, from.address);
  });
  await new Promise<void>((resolve) => {
    sock.bind(STUN_PORT, '0.0.0.0', resolve);
  });
  return {
    answered: () => answered,
    close: () => {
      sock.close();
    },
  };
}

// ---- processes -----------------------------------------------------------------------------------

interface Started {
  readonly child: ChildProcess;
  readonly text: () => string;
}

function startProcess(cmd: string, args: readonly string[]): Started {
  const child = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  const take = (b: Buffer): void => {
    text = (text + b.toString()).slice(-200_000);
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  return { child, text: () => text };
}

async function until(what: string, f: () => boolean, log: () => string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end)
      throw new Error(`${what}: not within ${String(ms)} ms\n${log().slice(-4000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

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

/** One viewer, in its namespace, as the runner's own user. */
class Peer {
  readonly #child: ChildProcess;
  readonly #waiting: ((m: Record<string, unknown>) => void)[] = [];
  #log = '';
  seederKey = '';

  private constructor(child: ChildProcess) {
    this.#child = child;
    child.stderr?.on('data', (b: Buffer) => {
      this.#log = (this.#log + b.toString()).slice(-8000);
    });
    if (child.stdout === null) throw new Error('no stdout');
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (!line.startsWith('PEER ')) {
        this.#log = `${this.#log}${line}\n`.slice(-8000);
        return;
      }
      const m = JSON.parse(line.slice(5)) as Record<string, unknown>;
      for (const w of this.#waiting.splice(0)) w(m);
    });
    child.on('exit', (code) => {
      for (const w of this.#waiting.splice(0))
        w({ ev: 'failed', error: `exited ${String(code)}: ${this.#log}` });
    });
  }

  #next(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  static async start(ns: string, cfg: PeerConfig): Promise<Peer> {
    const uid = String(process.getuid?.() ?? 1001);
    const gid = String(process.getgid?.() ?? 1001);
    const env = ['HOME', 'PATH', 'CHROMIUM', 'PLAYWRIGHT_BROWSERS_PATH', 'FFMPEG']
      .filter((k) => process.env[k] !== undefined)
      .map((k) => `${k}=${process.env[k] ?? ''}`);
    const child = spawn(
      'sudo',
      [
        '-n',
        'ip',
        'netns',
        'exec',
        ns,
        'setpriv',
        `--reuid=${uid}`,
        `--regid=${gid}`,
        '--clear-groups',
        'env',
        '-i',
        ...env,
        process.execPath,
        PEER_BUNDLE,
        JSON.stringify(cfg),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], cwd: pkgDir },
    );
    const p = new Peer(child);
    const first = await Promise.race([
      p.#next(),
      new Promise<Record<string, unknown>>((resolve) =>
        setTimeout(() => {
          resolve({ ev: 'failed', error: `no start within 150 s: ${p.#log}` });
        }, 150_000),
      ),
    ]);
    if (first['ev'] !== 'playing') throw new Error(`peer in ${ns}: ${JSON.stringify(first)}`);
    p.seederKey = String(first['seederKey']);
    return p;
  }

  async status(): Promise<PeerStatus> {
    const next = this.#next();
    this.#child.stdin?.write(`${JSON.stringify({ cmd: 'status' })}\n`);
    const m = await next;
    if (m['ev'] !== 'status') throw new Error(`peer: ${JSON.stringify(m)}`);
    return m['status'] as PeerStatus;
  }

  async until(what: string, f: (s: PeerStatus) => boolean, ms: number): Promise<PeerStatus> {
    const end = Date.now() + ms;
    for (;;) {
      const s = await this.status();
      if (f(s)) return s;
      if (Date.now() > end) {
        const { remoteSdp: _sdp, ...rest } = s.observed;
        throw new Error(
          `${what}: not within ${String(ms)} ms: ${JSON.stringify({ ...s, observed: rest }).slice(0, 3000)}\n${this.#log}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  #running(): boolean {
    return this.#child.exitCode === null;
  }

  async stop(): Promise<void> {
    if (!this.#running()) return;
    const gone = new Promise<void>((resolve) =>
      this.#child.once('exit', () => {
        resolve();
      }),
    );
    this.#child.stdin?.write(`${JSON.stringify({ cmd: 'stop' })}\n`);
    await Promise.race([gone, new Promise((r) => setTimeout(r, 15_000))]);
    if (this.#running()) this.#child.kill('SIGTERM');
  }
}

/** Everything the relay carried of NFX-10 §6: who signed it. */
function watchSignaling(
  url: string,
): Promise<{ keys: Set<string>; kinds: Set<number>; close(): void }> {
  return new Promise((resolve, reject) => {
    const keys = new Set<string>();
    const kinds = new Set<number>();
    const ws = new WebSocket(url);
    ws.once('error', reject);
    ws.once('open', () => {
      ws.send(JSON.stringify(['REQ', 'watch', { kinds: [25050] }]));
      resolve({
        keys,
        kinds,
        close: () => {
          ws.close();
        },
      });
    });
    ws.on('message', (d: Buffer) => {
      const m = JSON.parse(d.toString()) as unknown[];
      if (m[0] !== 'EVENT') return;
      const e = m[2] as { pubkey: string; kind: number };
      keys.add(e.pubkey);
      kinds.add(e.kind);
    });
  });
}

function queryOne(url: string, filter: unknown): Promise<NostrEvent> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error(`no event from ${url}`));
    }, 15_000);
    ws.once('error', reject);
    ws.once('open', () => {
      ws.send(JSON.stringify(['REQ', 'q', filter]));
    });
    ws.on('message', (d: Buffer) => {
      const m = JSON.parse(d.toString()) as unknown[];
      if (m[0] === 'EVENT') {
        clearTimeout(t);
        ws.close();
        resolve(m[2] as NostrEvent);
      }
    });
  });
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** What every proof demands of a viewer that played `pkg` holding only its first `HELD` segments. */
function judge(
  pkg: Vp9Package,
  s: PeerStatus,
  peerAddress: string,
): { fromPeers: number; bytesFromPeers: number; pair: unknown; candidates: readonly string[] } {
  expect(s.player).toBe('available');
  expect(s.src ?? '').toMatch(/^blob:/);
  expect(s.error).toBeNull();
  expect(s.cspViolations).toEqual([]);
  expect(s.pageErrors).toEqual([]);
  expect(s.offLoopback).toEqual([]);
  expect(s.observed.pending).toBe(0);

  // What played: every appended byte string is a file of the package.
  const played = new Set(s.observed.appended.map((a) => a.sha256));
  expect(s.observed.appended.length).toBeGreaterThan(HELD);
  const strangers = [...played].filter((h) => !pkg.files.has(h));
  expect(strangers).toEqual([]);

  // Of those, the ones this viewer's own seeder never had: they can have come only from a peer.
  const onlyFromPeers = pkg.segments.slice(HELD).filter((h) => played.has(h));
  expect(onlyFromPeers.length).toBeGreaterThanOrEqual(3);
  let bytesFromPeers = 0;
  for (const h of onlyFromPeers) bytesFromPeers += pkg.files.get(h)?.byteLength ?? 0;
  expect(s.observed.dcIn).toBeGreaterThanOrEqual(bytesFromPeers);

  // The wire: a connected ICE pair to that peer's global-looking address, carrying those bytes.
  const pairs = Object.values(s.observed.pairs).filter((p) => p.remote?.address === peerAddress);
  expect(pairs.length).toBeGreaterThan(0);
  const best = pairs.reduce((x, y) => (y.bytesReceived > x.bytesReceived ? y : x));
  expect(best.state).toBe('succeeded');
  expect(best.remote?.protocol).toBe('udp');
  expect(best.bytesReceived).toBeGreaterThanOrEqual(bytesFromPeers);

  // What reached the ICE agent, after the filter: global-looking addresses only.
  const candidates = s.observed.remoteSdp.flatMap(candidateAddresses);
  expect(candidates.length).toBeGreaterThan(0);
  for (const a of candidates) expect(a).toMatch(/^11\.77\.0\.[0-9]+$/);

  return { fromPeers: onlyFromPeers.length, bytesFromPeers, pair: best, candidates };
}

describe('the WebRTC player on an isolated network', () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  const creator = new Key();
  const VIDEO_ID = `netns-${sha(Buffer.from(String(Date.now()))).slice(0, 24)}`;
  const TITLE = 'Counting over WebRTC';
  let work = '';
  let pkg: Vp9Package;
  let storeDir = '';
  let relayPort = 0;
  let relayUrl = '';
  let watch: Awaited<ReturnType<typeof watchSignaling>>;

  const config = (over: Partial<PeerConfig>): PeerConfig => ({
    app: APP,
    store: storeDir,
    video: pkg.video,
    segments: pkg.segments,
    holds: pkg.segments.length,
    manifest: manifest(creator, VIDEO_ID, {
      title: TITLE,
      root: pkg.root,
      segs: pkg.segs,
      duration: Math.round(pkg.durationSec),
      createdAt: Math.floor(Date.now() / 1000) - 3600,
    }),
    addr: addrOf(creator, VIDEO_ID),
    title: TITLE,
    relayHost: HUB,
    relayPort,
    stun: `${HUB}:${String(STUN_PORT)}`,
    ...over,
  });

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'nutflix-netns-'));
    cleanups.push(() => {
      rmSync(work, { recursive: true, force: true });
    });
    await build({
      absWorkingDir: pkgDir,
      entryPoints: ['e2e/netns/peer.ts'],
      outfile: PEER_BUNDLE,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      packages: 'external',
      tsconfig: join(pkgDir, 'tsconfig.json'),
      logLevel: 'warning',
    });

    pkg = makeVp9Package(`${NS}:${VIDEO_ID}`, SECONDS);
    expect(pkg.segments.length).toBeGreaterThan(HELD + 5);
    storeDir = join(work, 'pkg', 'store');
    mkdirSync(storeDir, { recursive: true });
    for (const [name, bytes] of pkg.files) writeFileSync(join(storeDir, name), bytes);
    writeFileSync(
      join(work, 'pkg', 'nfx.json'),
      JSON.stringify({ root: pkg.root, video: pkg.video, segs: pkg.segs }),
    );

    // The stock relay: strfry's own config, with its database, port, open-files limit and, so
    // that the viewers' namespaces reach it across the bridge, its bind address changed.
    relayPort = await freePort();
    mkdirSync(join(work, 'strfry-db'));
    const conf = readFileSync(need('STRFRY_CONF'), 'utf8')
      .replace(/^db = "\.\/strfry-db\/"$/m, `db = "${join(work, 'strfry-db')}/"`)
      .replace(/^(\s*)bind = "127\.0\.0\.1"$/m, '$1bind = "0.0.0.0"')
      .replace(/^(\s*)port = 7777$/m, `$1port = ${String(relayPort)}`)
      .replace(/^(\s*)nofiles = [0-9]+$/m, '$1nofiles = 0');
    expect(conf).toContain(`port = ${String(relayPort)}`);
    expect(conf).toContain('bind = "0.0.0.0"');
    writeFileSync(join(work, 'strfry.conf'), conf);
    const strfry = startProcess(need('STRFRY'), [`--config=${join(work, 'strfry.conf')}`, 'relay']);
    cleanups.push(() => {
      strfry.child.kill('SIGTERM');
    });
    await waitPort(relayPort, strfry.text);
    relayUrl = `ws://127.0.0.1:${String(relayPort)}`;
    watch = await watchSignaling(relayUrl);
    cleanups.push(() => {
      watch.close();
    });

    const stun = await startStun();
    cleanups.push(() => {
      report('STUN', { answered: stun.answered() });
      stun.close();
    });
  });

  afterAll(async () => {
    for (const c of cleanups.splice(0).reverse()) {
      try {
        await c();
      } catch {
        // The next one still runs.
      }
    }
  });

  const keysBefore = new Set<string>();

  it('proof 1: a viewer plays segments it can only have got from another viewer, over WebRTC', async () => {
    const a = await Peer.start('nfx-a', config({}));
    cleanups.push(() => a.stop());
    // A has fetched well past what B holds before B arrives.
    await a.until('A buffers', (s) => s.observed.appended.length >= HELD + 6, 150_000);

    const b = await Peer.start('nfx-b', config({ holds: HELD }));
    cleanups.push(() => b.stop());
    const past = (HELD + 3) * 2;
    await b.until('B plays past what it holds', (x) => x.t > past, 240_000);
    const s = await b.until('B hashed what it appended', (x) => x.observed.pending === 0, 20_000);
    const verdict = judge(pkg, s, ADDR_A);
    const sa = await a.status();
    expect(sa.observed.dcOut).toBeGreaterThanOrEqual(verdict.bytesFromPeers);
    report('PROOF1', {
      segments: pkg.segments.length,
      heldByB: HELD,
      playedTo: s.t,
      appended: s.observed.appended.length,
      segmentsOnlyFromPeer: verdict.fromPeers,
      bytesOnlyFromPeer: verdict.bytesFromPeers,
      dataChannelBytesIn: s.observed.dcIn,
      peerDataChannelBytesOut: sa.observed.dcOut,
      pair: verdict.pair,
      remoteCandidates: [...new Set(verdict.candidates)],
    });

    // ADR 0023 §3: each play signs with a random key, never the user's or the seeder's.
    expect(watch.keys.size).toBeGreaterThanOrEqual(2);
    for (const k of [creator.pubkey, a.seederKey, b.seederKey])
      expect(watch.keys.has(k)).toBe(false);
    for (const k of watch.keys) keysBefore.add(k);
    report('SESSION_KEYS', { proof1: watch.keys.size, kinds: [...watch.kinds] });
    await b.stop();
    await a.stop();
  });

  it('proof 2: a viewer plays segments it can only have got from nfxd --mesh-relay', async () => {
    const nfxd = need('NFXD');
    const keyFile = join(work, 'node.key');
    const made = spawnSync(nfxd, ['key', 'new', keyFile], { encoding: 'utf8' });
    if (made.status !== 0) throw new Error(`nfxd key new: ${made.stderr}`);
    const pubkey = made.stdout.split('\n')[0]?.trim() ?? '';
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
    const addr = `38504:${pubkey}:${pkg.video}`;
    const node = startProcess(nfxd, [
      'run',
      '--key',
      keyFile,
      '--store',
      storeDir,
      '--seed',
      addr,
      '--embed-relay',
      '127.0.0.1:0',
      '--origin',
      '127.0.0.1:0',
      '--mesh-relay',
      relayUrl,
      '--mesh-bind',
      `${HUB}:0`,
    ]);
    cleanups.push(() => {
      node.child.kill('SIGTERM');
    });
    await until(
      'nfxd starts',
      () => /embedded relay: ws:\/\/\S+/.test(node.text()),
      node.text,
      60_000,
    );
    const embedded = /embedded relay: (ws:\/\/\S+)/.exec(node.text())?.[1] ?? '';
    const session = /mesh: udp \S+, session ([0-9a-f]{64})/;
    await until('nfxd meshes', () => session.test(node.text()), node.text, 60_000);
    const nodeSession = session.exec(node.text())?.[1] ?? '';
    expect(nodeSession).not.toBe(pubkey);
    const title = 'Counting from nfxd';
    const pub = spawnSync(
      nfxd,
      [
        'publish',
        '--key',
        keyFile,
        '--relay',
        embedded,
        '--package',
        join(work, 'pkg'),
        '--title',
        title,
      ],
      { encoding: 'utf8' },
    );
    if (pub.status !== 0) throw new Error(`nfxd publish: ${pub.stderr}${pub.stdout}`);
    await until(
      'nfxd seeds in a room',
      () => node.text().includes(`${addr}: Seeding`) && /^mesh: 1 room/m.test(node.text()),
      node.text,
      60_000,
    );
    const event = await queryOne(embedded, { kinds: [38504], authors: [pubkey], limit: 1 });

    const b = await Peer.start('nfx-b', config({ holds: HELD, manifest: event, addr, title }));
    cleanups.push(() => b.stop());
    const past = (HELD + 3) * 2;
    await b.until('the viewer plays past what it holds', (x) => x.t > past, 240_000);
    const s = await b.until('it hashed what it appended', (x) => x.observed.pending === 0, 20_000);
    const verdict = judge(pkg, s, HUB);

    const lines = node
      .text()
      .split('\n')
      .filter((l) => /^mesh: \d+ room/.test(l));
    const last = lines.at(-1) ?? '';
    report('PROOF2', {
      nfxCommitBinary: process.env['NFX_COMMIT'] ?? null,
      segments: pkg.segments.length,
      heldByViewer: HELD,
      playedTo: s.t,
      appended: s.observed.appended.length,
      segmentsOnlyFromNfxd: verdict.fromPeers,
      bytesOnlyFromNfxd: verdict.bytesFromPeers,
      dataChannelBytesIn: s.observed.dcIn,
      pair: verdict.pair,
      remoteCandidates: [...new Set(verdict.candidates)],
      nfxdMeshLine: last,
    });

    // A new play, a new key; never nfxd's identity key or the viewer's seeder key.
    const fresh = [...watch.keys].filter((k) => !keysBefore.has(k) && k !== nodeSession);
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    for (const k of [pubkey, b.seederKey]) expect(watch.keys.has(k)).toBe(false);
    report('SESSION_KEYS', { proof2New: fresh.length });
    await b.stop();
    node.child.kill('SIGTERM');
  });

  it('proof 4: the pinned library’s candidate filter, in this browser, on nfx’s vectors and this app’s', async () => {
    const raw = readFileSync(join(need('NFX_SRC'), 'web/player/test-vectors/remote-sdp.json'));
    expect(sha(raw)).toBe(SDP_VECTORS_SHA256);
    const v = JSON.parse(raw.toString('utf8')) as {
      max_kept: number;
      head: string[];
      tail: string[];
      cases: {
        name: string;
        mode?: 'all' | 'global';
        in?: string[];
        out?: string[];
        in_raw?: string;
        out_raw?: string;
      }[];
    };
    const sdp = (lines: readonly string[]): string =>
      [...v.head, ...lines, ...v.tail].map((l) => `${l}\r\n`).join('');
    const cases = v.cases.map((c) => ({
      name: c.name,
      mode: c.mode ?? 'global',
      input: c.in_raw ?? sdp(c.in ?? []),
      want: c.out_raw ?? sdp(c.out ?? []),
    }));
    // This app's own: what the filter must drop on a desktop, and the addresses the two proofs
    // above rely on it keeping.
    const line = (address: string, type = 'host'): string =>
      `a=candidate:1 1 udp 2122260223 ${address} 50000 typ ${type}`;
    const drop = [
      '127.0.0.1',
      '127.8.8.8',
      '10.0.0.8',
      '172.16.4.2',
      '192.168.1.20',
      '169.254.169.254',
      '100.100.100.200',
      '0.0.0.0',
      '224.0.0.251',
      '198.18.0.1',
      '203.0.113.9',
      '::1',
      'fe80::1',
      'fd00::1',
      'ff02::1',
      '4f1c7f6a-6f4d-4e9b-9c55-3a1f0f7d2b11.local',
      'router.lan',
    ];
    const keep = [ADDR_A, ADDR_B, HUB, '8.8.8.8', '2606:4700:4700::1111'];
    for (const a of drop)
      cases.push({ name: `drops ${a}`, mode: 'global', input: sdp([line(a)]), want: sdp([]) });
    for (const a of keep) {
      const l = line(a, 'srflx');
      cases.push({ name: `keeps ${a}`, mode: 'global', input: sdp([l]), want: sdp([l]) });
    }
    const site = await serveDir(APP);
    cleanups.push(() => site.close());
    const browser = await chromium.launch({
      headless: true,
      ...(process.env['CHROMIUM'] === undefined ? {} : { executablePath: process.env['CHROMIUM'] }),
    });
    cleanups.push(() => browser.close());
    const page = await (await browser.newContext()).newPage();
    // No worker pipe here: the page stops at "no worker", with its policy in force.
    await page.goto(`${site.origin}/`);
    const result = await page.evaluate(async (list) => {
      const url = new URL('nfx/player.js', document.baseURI).href;
      const lib = (await import(/* @vite-ignore */ url)) as {
        filterRemoteSdp(sdp: string, mode: 'all' | 'global'): string;
        MAX_REMOTE_CANDIDATES: number;
      };
      const failed = list
        .filter((c) => lib.filterRemoteSdp(c.input, c.mode) !== c.want)
        .map((c) => c.name);
      return { failed, ran: list.length, max: lib.MAX_REMOTE_CANDIDATES };
    }, cases);
    expect(result.failed).toEqual([]);
    expect(result.max).toBe(v.max_kept);
    expect(result.ran).toBe(v.cases.length + drop.length + keep.length);
    report('PROOF4', {
      nfxVectors: v.cases.length,
      appDrops: drop.length,
      appKeeps: keep.length,
      failed: result.failed.length,
    });
  });
});
