/**
 * Test support (not a suite): a throwaway NIP-46 bunker and a tiny relay, both on 127.0.0.1.
 *
 *   - `LoopRelay`: NIP-01 over `ws`, for ephemeral traffic only: each EVENT goes to the live
 *     subscriptions it matches. Nothing is stored.
 *   - `TestBunker`: a remote signer that dials a relay as a client (so it also works against a real
 *     strfry), answers `connect`, `get_public_key` and `sign_event`, and records what it was asked
 *     to sign. `evil` makes it answer with a different event, as a compromised bunker would.
 *
 * Keys are made here, per run; nothing is committed and no socket leaves loopback.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import * as nip44 from 'nostr-tools/nip44';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import WebSocket, { WebSocketServer } from 'ws';

interface Filter {
  readonly kinds?: readonly number[];
  readonly authors?: readonly string[];
  readonly '#p'?: readonly string[];
}

interface WireEvent {
  readonly id: string;
  readonly pubkey: string;
  readonly kind: number;
  readonly created_at: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: string;
}

function matches(f: Filter, e: WireEvent): boolean {
  if (f.kinds !== undefined && !f.kinds.includes(e.kind)) return false;
  if (f.authors !== undefined && !f.authors.includes(e.pubkey)) return false;
  const p = f['#p'];
  if (p !== undefined && !e.tags.some((t) => t[0] === 'p' && p.includes(t[1] ?? ''))) return false;
  return true;
}

export class LoopRelay {
  readonly #http: Server;
  readonly #wss: WebSocketServer;
  readonly #subs = new Map<WebSocket, Map<string, Filter[]>>();
  url = '';

  private constructor() {
    this.#http = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    this.#wss = new WebSocketServer({ server: this.#http });
    this.#wss.on('connection', (ws) => {
      this.#subs.set(ws, new Map());
      ws.on('close', () => this.#subs.delete(ws));
      ws.on('message', (d, isBinary) => {
        if (!isBinary) this.#onMessage(ws, (d as Buffer).toString('utf8'));
      });
    });
  }

  static async start(): Promise<LoopRelay> {
    const r = new LoopRelay();
    await new Promise<void>((resolve) => {
      r.#http.listen(0, '127.0.0.1', resolve);
    });
    r.url = `ws://127.0.0.1:${String((r.#http.address() as AddressInfo).port)}`;
    return r;
  }

  #onMessage(ws: WebSocket, text: string): void {
    const msg = JSON.parse(text) as unknown[];
    const [type, a, ...rest] = msg;
    if (type === 'REQ' && typeof a === 'string') {
      this.#subs.get(ws)?.set(a, rest as Filter[]);
      ws.send(JSON.stringify(['EOSE', a]));
    } else if (type === 'CLOSE' && typeof a === 'string') {
      this.#subs.get(ws)?.delete(a);
    } else if (type === 'EVENT') {
      const ev = a as WireEvent;
      ws.send(JSON.stringify(['OK', ev.id, true, '']));
      for (const [peer, subs] of this.#subs)
        for (const [id, filters] of subs)
          if (filters.some((f) => matches(f, ev))) peer.send(JSON.stringify(['EVENT', id, ev]));
    }
  }

  async close(): Promise<void> {
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

export interface TestBunkerOptions {
  /** Answer `sign_event` with a different event than the one asked for. */
  readonly evil?: boolean;
  /** Refuse `connect` unless it carries this. */
  readonly secret?: string;
}

export class TestBunker {
  readonly #userSk = generateSecretKey();
  readonly #sk = generateSecretKey();
  readonly pubkey = getPublicKey(this.#sk);
  readonly userPubkey = getPublicKey(this.#userSk);
  /** The kinds it was asked to sign, in order. */
  readonly signedKinds: number[] = [];
  readonly #o: TestBunkerOptions;
  readonly #relay: string;
  #ws: WebSocket | null = null;

  private constructor(relay: string, o: TestBunkerOptions) {
    this.#relay = relay;
    this.#o = o;
  }

  /** Connected and subscribed. */
  static async start(relay: string, o: TestBunkerOptions = {}): Promise<TestBunker> {
    const b = new TestBunker(relay, o);
    const ws = new WebSocket(relay);
    b.#ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve();
      });
      ws.once('error', reject);
    });
    const ready = new Promise<void>((resolve) => {
      ws.on('message', (d) => {
        const msg = JSON.parse((d as Buffer).toString('utf8')) as unknown[];
        if (msg[0] === 'EOSE') resolve();
        if (msg[0] === 'EVENT') b.#onRequest(msg[2] as WireEvent);
      });
    });
    ws.send(JSON.stringify(['REQ', 'bunker', { kinds: [24133], '#p': [b.pubkey], limit: 0 }]));
    await ready;
    return b;
  }

  get uri(): string {
    const secret = this.#o.secret === undefined ? '' : `&secret=${this.#o.secret}`;
    return `bunker://${this.pubkey}?relay=${encodeURIComponent(this.#relay)}${secret}`;
  }

  #answer(to: string, conv: Uint8Array, body: object): void {
    const reply = finalizeEvent(
      {
        kind: 24133,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', to]],
        content: nip44.encrypt(JSON.stringify(body), conv),
      },
      this.#sk,
    );
    this.#ws?.send(JSON.stringify(['EVENT', reply]));
  }

  #onRequest(ev: WireEvent): void {
    const conv = nip44.getConversationKey(this.#sk, ev.pubkey);
    let req: { id: string; method: string; params: string[] };
    try {
      req = JSON.parse(nip44.decrypt(ev.content, conv)) as typeof req;
    } catch {
      return;
    }
    const { id, method, params } = req;
    if (method === 'connect') {
      if (this.#o.secret !== undefined && params[1] !== this.#o.secret) {
        this.#answer(ev.pubkey, conv, { id, error: 'wrong secret' });
        return;
      }
      this.#answer(ev.pubkey, conv, { id, result: 'ack' });
    } else if (method === 'get_public_key') {
      this.#answer(ev.pubkey, conv, { id, result: this.userPubkey });
    } else if (method === 'sign_event') {
      const t = JSON.parse(params[0] ?? '{}') as {
        kind: number;
        created_at: number;
        tags: string[][];
        content: string;
      };
      this.signedKinds.push(t.kind);
      const signed = finalizeEvent(
        this.#o.evil === true ? { ...t, content: `${t.content} (changed by the bunker)` } : t,
        this.#userSk,
      );
      this.#answer(ev.pubkey, conv, { id, result: JSON.stringify(signed) });
    } else {
      this.#answer(ev.pubkey, conv, { id, error: 'not supported' });
    }
  }

  close(): void {
    this.#ws?.terminate();
    this.#ws = null;
  }
}
