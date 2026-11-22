/**
 * Test support: a small read-only Nostr relay on loopback (NIP-01 over `ws`, and NIP-11 on the
 * same port, with CORS as a relay serves it). It holds the manifests it was given, and answers a
 * subscription for beacons the way a relay answers for ephemeral events (NIP-01: not stored, only
 * sent to live subscriptions): a fresh, really signed beacon on the REQ and again every
 * `beaconEveryMs`, as a seeder republishes. It refuses every publish.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer, type WebSocket } from 'ws';

import type { NostrEvent } from '@sovit/core';

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
    const has = ev.tags.some((t) => t[0] === name && want.includes(t[1] ?? ''));
    if (!has) return false;
  }
  return true;
}

export interface TestRelayOptions {
  /** A fresh beacon for each subscription that asks for beacons; absent: none. */
  readonly beacon?: (() => NostrEvent) | undefined;
  readonly beaconEveryMs?: number;
}

export class TestRelay {
  readonly #http: Server;
  readonly #wss: WebSocketServer;
  readonly #stored: NostrEvent[] = [];
  readonly #subs = new Set<{
    ws: WebSocket;
    id: string;
    filters: Filter[];
    timer: NodeJS.Timeout | null;
  }>();
  readonly #o: TestRelayOptions;
  /** Every REQ, for a test to look at: the filters as received. */
  readonly reqs: Filter[][] = [];
  /** Every NIP-11 document request. */
  nip11Requests = 0;
  url = '';

  private constructor(o: TestRelayOptions) {
    this.#o = o;
    this.#http = createServer((req, res) => {
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, headers).end();
        return;
      }
      if ((req.headers.accept ?? '').includes('application/nostr+json')) {
        this.nip11Requests += 1;
        res
          .writeHead(200, { ...headers, 'content-type': 'application/nostr+json' })
          .end(JSON.stringify({ name: 'nutflix e2e relay', supported_nips: [1, 11] }));
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

  static async start(o: TestRelayOptions = {}): Promise<TestRelay> {
    const r = new TestRelay(o);
    await new Promise<void>((resolve) => {
      r.#http.listen(0, '127.0.0.1', resolve);
    });
    r.url = `ws://127.0.0.1:${String((r.#http.address() as AddressInfo).port)}`;
    return r;
  }

  store(...events: NostrEvent[]): void {
    this.#stored.push(...events);
  }

  #drop(s: { timer: NodeJS.Timeout | null }): void {
    if (s.timer !== null) clearInterval(s.timer);
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
      const sub = { ws, id: a, filters, timer: null as NodeJS.Timeout | null };
      this.#subs.add(sub);
      const beacon = this.#o.beacon;
      if (beacon !== undefined) {
        const push = (): void => {
          const ev = beacon();
          if (sub.filters.some((f) => matches(f, ev))) this.#send(ws, ['EVENT', a, ev]);
        };
        push();
        sub.timer = setInterval(push, this.#o.beaconEveryMs ?? 3_000);
      }
    } else if (type === 'CLOSE' && typeof a === 'string') {
      for (const s of [...this.#subs]) if (s.ws === ws && s.id === a) this.#drop(s);
    } else if (type === 'EVENT') {
      const id = (a as { id?: unknown } | null)?.id;
      this.#send(ws, ['OK', typeof id === 'string' ? id : '', false, 'blocked: read-only']);
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
