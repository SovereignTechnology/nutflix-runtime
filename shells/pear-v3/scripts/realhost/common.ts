/**
 * The real-host proof's shared parts (`seed-side.ts`, `play-side.ts`). The proof runs on two
 * machines on two different networks, behind their own NATs, on the PUBLIC HyperDHT, and never on
 * a CI runner (`.github/workflows` must never touch the public DHT). It publishes nothing to any
 * public Nostr relay: the one relay is `RealhostRelay` on the seeding machine's loopback, and the
 * playing machine reaches it through `tunnelServer`/`tunnelClient`, a TCP pipe over HyperDHT that
 * lands on the same loopback port there, so the installed app's baked `play` relay
 * (`ws://127.0.0.1:<RELAY_PORT>`) is that relay on both machines.
 *
 * What is printed is numbers, booleans, public keys and fixed words: never an IP address. A
 * remote address is reported as facts about it (`addrFacts`).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect as netConnect, createServer as createNetServer, type Server } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

import DHT from 'hyperdht';
import { verifyEvent } from 'nostr-tools/pure';
import { WebSocketServer, type WebSocket } from 'ws';

import type { NostrEvent } from '@sovit/core';

import { isolatedEnv as isolatedEnvOf, killTree as killTreeOf } from '../pear-ci/pear.ts';
import { parseRecords as parseRecordsOf, type PearRecord } from '../pear-ci/records.ts';

/** The loopback port the relay and the tunnel share on both machines (baked into the test build). */
export const RELAY_PORT = 47123;
export const RELAY_URL = `ws://127.0.0.1:${String(RELAY_PORT)}`;
/** The HTTP path on the relay's port that tells the playing machine the proof is over. */
export const STATUS_PATH = '/realhost-status';
/** And what to install: `{ info: { link, appSha256 } }` once it is seeded, `{ info: null }` before. */
export const INFO_PATH = '/realhost-info';

const t0 = Date.now();
export const secs = (): number => Math.round((Date.now() - t0) / 1000);
export const say = (line: string): void => {
  process.stdout.write(`[${String(secs()).padStart(5)} s] ${line}\n`);
};
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- addresses, as facts --------------------------------------------------------------------------

const PRIVATE =
  /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.|::1$|f[cd]|fe80)/i;

function localAddresses(): Set<string> {
  return new Set(
    Object.values(networkInterfaces())
      .flat()
      .filter((a) => a !== undefined)
      .map((a) => a.address),
  );
}

export interface AddrFacts {
  readonly known: boolean;
  readonly isPrivate?: boolean;
  readonly isThisMachine?: boolean;
}

/** What may be said about an address in a log: never the address. */
export function addrFacts(host: string | null | undefined): AddrFacts {
  if (host === null || host === undefined || host === '') return { known: false };
  return { known: true, isPrivate: PRIVATE.test(host), isThisMachine: localAddresses().has(host) };
}

const FW = ['UNKNOWN', 'OPEN', 'CONSISTENT', 'RANDOM'];
export const firewallName = (n: unknown): string =>
  typeof n === 'number' ? (FW[n] ?? String(n)) : 'none';

/** This machine's DHT node as the public network sees it. */
export function natFacts(node: DHT): Record<string, unknown> {
  return {
    online: node.online,
    firewalled: node.firewalled,
    randomized: node.randomized,
    publicAddress: addrFacts(node.host),
  };
}

export async function publicNode(): Promise<DHT> {
  const node = new DHT();
  await Promise.race([
    node.fullyBootstrapped(),
    sleep(90_000).then(() => {
      throw new Error('no public DHT bootstrap in 90 s (no UDP egress?)');
    }),
  ]);
  return node;
}

// ---- the tunnel: one loopback TCP port, carried over HyperDHT -----------------------------------

type Duplex = NodeJS.ReadWriteStream & { destroy(err?: Error): void };

function splice(a: Duplex, b: Duplex): void {
  const end = (): void => {
    a.destroy();
    b.destroy();
  };
  a.on('error', end);
  b.on('error', end);
  a.on('close', end);
  b.on('close', end);
  a.pipe(b);
  b.pipe(a);
}

export interface TunnelStats {
  connections: number;
  /** The remote ends of the HyperDHT streams, as facts. */
  remotes: AddrFacts[];
}

/** The seeding side: each HyperDHT stream to this key becomes a TCP connection to `port`. */
export async function tunnelServer(
  node: DHT,
  port: number,
): Promise<{ key: string; stats: TunnelStats; close(): Promise<void> }> {
  const keyPair = DHT.keyPair();
  const stats: TunnelStats = { connections: 0, remotes: [] };
  const server = node.createServer((socket) => {
    stats.connections += 1;
    const raw = (socket as unknown as { rawStream?: { remoteHost?: string } }).rawStream;
    if (stats.remotes.length < 8) stats.remotes.push(addrFacts(raw?.remoteHost));
    const tcp = netConnect(port, '127.0.0.1');
    splice(socket as unknown as Duplex, tcp as unknown as Duplex);
  });
  await server.listen(keyPair);
  return {
    key: keyPair.publicKey.toString('hex'),
    keyPair,
    stats,
    close: () => server.close(),
  };
}

/**
 * Where the two machines meet without the orchestrator in between: a DHT topic made from a nonce
 * both are given (a random word, not a key). The seeding machine announces its tunnel key on it.
 */
export function topicOf(nonce: string): Buffer {
  if (!/^[0-9a-f]{32,64}$/.test(nonce)) throw new Error('the nonce is 32 to 64 hex');
  return createHash('sha256').update(`nutflix-realhost/1:${nonce}`).digest();
}

/** Keeps `keyPair` announced on `topic` (records expire), until `stop`. */
export function announceLoop(node: DHT, topic: Buffer, keyPair: { publicKey: Buffer; secretKey: Buffer }): () => void {
  let stopped = false;
  const once = async (): Promise<void> => {
    try {
      const q = node.announce(topic, keyPair);
      await q.finished();
      say('announced the tunnel on the meeting topic');
    } catch (e) {
      say(`announce: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  void (async () => {
    while (!stopped) {
      await once();
      for (let i = 0; i < 60 && !stopped; i++) await sleep(5000);
    }
  })();
  return () => {
    stopped = true;
  };
}

/** The tunnel keys announced on `topic` (the newest lookups first), possibly none. */
export async function lookupTunnel(node: DHT, topic: Buffer): Promise<string[]> {
  const found = new Set<string>();
  const q = node.lookup(topic);
  for await (const reply of q as AsyncIterable<{ peers: { publicKey: Buffer }[] }>)
    for (const p of reply.peers) found.add(p.publicKey.toString('hex'));
  return [...found];
}

/** The playing side: 127.0.0.1:`port` here, each connection a HyperDHT stream to `key`. */
export async function tunnelClient(
  node: DHT,
  key: string,
  port: number,
): Promise<{ stats: TunnelStats; close(): Promise<void> }> {
  const stats: TunnelStats = { connections: 0, remotes: [] };
  const remote = Buffer.from(key, 'hex');
  const server: Server = createNetServer((tcp) => {
    stats.connections += 1;
    const socket = node.connect(remote);
    socket.once('open', () => {
      const raw = (socket as unknown as { rawStream?: { remoteHost?: string } }).rawStream;
      if (stats.remotes.length < 8) stats.remotes.push(addrFacts(raw?.remoteHost));
    });
    splice(tcp as unknown as Duplex, socket as unknown as Duplex);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    stats,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => {
          r();
        });
      }),
  };
}

// ---- the relay -------------------------------------------------------------------------------------

interface Filter {
  readonly ids?: readonly string[];
  readonly authors?: readonly string[];
  readonly kinds?: readonly number[];
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
  readonly [k: `#${string}`]: readonly string[] | undefined;
}

function matches(f: Filter, ev: NostrEvent): boolean {
  if (f.ids !== undefined && !f.ids.includes(ev.id)) return false;
  if (f.authors !== undefined && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds !== undefined && !f.kinds.includes(ev.kind)) return false;
  if (f.since !== undefined && ev.created_at < f.since) return false;
  if (f.until !== undefined && ev.created_at > f.until) return false;
  for (const [k, want] of Object.entries(f)) {
    if (!k.startsWith('#') || !Array.isArray(want)) continue;
    const name = k.slice(1);
    if (!ev.tags.some((t) => t[0] === name && want.includes(t[1] ?? ''))) return false;
  }
  return true;
}

/** Kinds a client may publish here: a seeder's beacon (NFX-03), nothing else. */
const ACCEPTED_KINDS = new Set([20464]);

/**
 * After the renderer e2e's `TestRelay` (`packages/renderer/e2e/helpers/relay.ts`): it holds the
 * manifest, and answers a beacon subscription with fresh beacons from `beacons()` on the REQ and
 * every `beaconEveryMs`. Unlike it, it takes a published beacon (kind 20464, signature checked):
 * that is how the installed app's own seeding is seen (the reverse test). On the same port, GET
 * `STATUS_PATH` answers `{ done }`.
 */
export class RealhostRelay {
  readonly #http: HttpServer;
  readonly #wss: WebSocketServer;
  readonly #stored: NostrEvent[] = [];
  readonly #subs = new Set<{ ws: WebSocket; id: string; filters: Filter[]; timer: NodeJS.Timeout }>();
  /** Beacons clients published, in order. */
  readonly published: NostrEvent[] = [];
  readonly reqs: Filter[][] = [];
  done = false;
  /** What the playing machine needs once the link is seeded: GET `INFO_PATH`. */
  info: Record<string, string> | null = null;
  beacons: () => readonly NostrEvent[] = () => [];

  private constructor(readonly beaconEveryMs: number) {
    this.#http = createHttpServer((req, res) => {
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, headers).end();
        return;
      }
      if (req.url === STATUS_PATH || req.url === INFO_PATH) {
        res
          .writeHead(200, { ...headers, 'content-type': 'application/json' })
          .end(JSON.stringify(req.url === STATUS_PATH ? { done: this.done } : { info: this.info }));
        return;
      }
      if ((req.headers.accept ?? '').includes('application/nostr+json')) {
        res
          .writeHead(200, { ...headers, 'content-type': 'application/nostr+json' })
          .end(JSON.stringify({ name: 'nutflix real-host relay', supported_nips: [1, 11] }));
        return;
      }
      res.writeHead(404, headers).end('not a page');
    });
    this.#wss = new WebSocketServer({ server: this.#http });
    this.#wss.on('connection', (ws) => {
      ws.on('message', (data, isBinary) => {
        if (!isBinary) this.#onMessage(ws, (data as Buffer).toString('utf8'));
      });
      ws.on('close', () => {
        for (const s of [...this.#subs]) if (s.ws === ws) this.#drop(s);
      });
    });
  }

  static async start(port: number, beaconEveryMs = 2_000): Promise<RealhostRelay> {
    const r = new RealhostRelay(beaconEveryMs);
    await new Promise<void>((resolve, reject) => {
      r.#http.once('error', reject);
      r.#http.listen(port, '127.0.0.1', resolve);
    });
    return r;
  }

  store(...events: NostrEvent[]): void {
    this.#stored.push(...events);
  }

  #drop(s: { timer: NodeJS.Timeout }): void {
    clearInterval(s.timer);
    this.#subs.delete(s as never);
  }

  #send(ws: WebSocket, msg: unknown[]): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  #onMessage(ws: WebSocket, text: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    const [type, a, ...rest] = msg as unknown[];
    if (type === 'REQ' && typeof a === 'string') {
      const filters = rest as Filter[];
      this.reqs.push(filters);
      for (const f of filters) {
        const hits = this.#stored
          .filter((e) => matches(f, e))
          .sort((x, y) => y.created_at - x.created_at);
        for (const ev of hits.slice(0, f.limit ?? 500)) this.#send(ws, ['EVENT', a, ev]);
      }
      this.#send(ws, ['EOSE', a]);
      const push = (): void => {
        for (const ev of this.beacons())
          if (filters.some((f) => matches(f, ev))) this.#send(ws, ['EVENT', a, ev]);
      };
      push();
      this.#subs.add({ ws, id: a, filters, timer: setInterval(push, this.beaconEveryMs) });
    } else if (type === 'CLOSE' && typeof a === 'string') {
      for (const s of [...this.#subs]) if (s.ws === ws && s.id === a) this.#drop(s);
    } else if (type === 'EVENT') {
      const ev = a as NostrEvent | null;
      const id = typeof ev?.id === 'string' ? ev.id : '';
      const ok =
        ev !== null &&
        typeof ev === 'object' &&
        ACCEPTED_KINDS.has(ev.kind) &&
        verifyEvent(ev as Parameters<typeof verifyEvent>[0]);
      if (ok) this.published.push(ev);
      this.#send(ws, ['OK', id, ok, ok ? '' : 'blocked: beacons only']);
    }
  }

  async close(): Promise<void> {
    for (const s of [...this.#subs]) this.#drop(s);
    for (const c of this.#wss.clients) c.terminate();
    await new Promise<void>((resolve) => {
      this.#wss.close(() => {
        this.#http.close(() => {
          resolve();
        });
        this.#http.closeAllConnections();
      });
    });
  }
}

// ---- Pear, on the public DHT -------------------------------------------------------------------

export { fetchPear, isolatedEnv, killTree, platformDir } from '../pear-ci/pear.ts';
export { parseRecords, lastRecord, field, succeeded, failureMessage } from '../pear-ci/records.ts';

export interface PearRun {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly out: string;
  readonly records: PearRecord[];
  readonly ms: number;
}

/**
 * The pinned Pear CLI with NO bootstrap of its own: HyperDHT's public one (`pear-ci/pear.ts`'s
 * `Pear` refuses anything but a loopback bootstrap, and is the CI's). Output goes to a log file.
 */
export class PublicPear {
  #seq = 0;
  constructor(
    readonly bin: string,
    readonly home: string,
    readonly logDir: string,
  ) {
    mkdirSync(home, { recursive: true });
    mkdirSync(logDir, { recursive: true });
  }

  get env(): NodeJS.ProcessEnv {
    return isolatedEnvOf(this.home);
  }

  #open(name: string): { logFile: string; fd: number } {
    this.#seq += 1;
    const logFile = join(this.logDir, `${String(this.#seq).padStart(2, '0')}-${name}.log`);
    return { logFile, fd: openSync(logFile, 'a') };
  }

  async run(name: string, args: readonly string[], timeoutS: number): Promise<PearRun> {
    const { logFile, fd } = this.#open(name);
    const started = Date.now();
    const child = spawn(this.bin, [...args], { env: this.env, stdio: ['ignore', fd, fd] });
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', resolve);
      child.once('error', (e) => {
        appendFileSync(logFile, `spawn error: ${e.message}\n`);
        resolve(null);
      });
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTreeOf(child.pid);
    }, timeoutS * 1000);
    const code = await exited;
    clearTimeout(timer);
    closeSync(fd);
    const out = readFileSync(logFile, 'utf8');
    return { code, timedOut, out, records: parseRecordsOf(out), ms: Date.now() - started };
  }

  /** Left running (`pear seed`). */
  start(name: string, args: readonly string[]): { read(): string; exited(): boolean; stop(): Promise<void> } {
    const { logFile, fd } = this.#open(name);
    const child = spawn(this.bin, [...args], { env: this.env, stdio: ['ignore', fd, fd] });
    let done = false;
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        done = true;
        closeSync(fd);
        resolve();
      });
      child.once('error', () => {
        done = true;
        resolve();
      });
    });
    return {
      read: () => readFileSync(logFile, 'utf8'),
      exited: () => done,
      stop: async () => {
        if (done) return;
        killTreeOf(child.pid);
        await Promise.race([exited, sleep(10_000)]);
        if (!done) {
          killTreeOf(child.pid, true);
          await Promise.race([exited, sleep(5_000)]);
        }
      },
    };
  }
}

/** The tail of a text, `n` non-empty lines. */
export function tail(text: string, n: number): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l !== '')
    .slice(-n)
    .join('\n');
}
