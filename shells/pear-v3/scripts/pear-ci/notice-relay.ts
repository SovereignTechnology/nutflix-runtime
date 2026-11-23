/**
 * The install job's Nostr relay: on 127.0.0.1, in this process, holding only what the job puts in
 * it. It is deliberately a BAD relay: it answers every subscription with everything it holds and
 * ignores the filter, so a notice from the wrong key reaches the app and the app has to refuse it.
 */
import type { AddressInfo } from 'node:net';

import { WebSocketServer, type WebSocket } from 'ws';

export class NoticeRelay {
  readonly #wss: WebSocketServer;
  #events: readonly object[] = [];
  /** How many subscriptions it answered. */
  reqs = 0;
  readonly url: string;

  private constructor(wss: WebSocketServer, url: string) {
    this.#wss = wss;
    this.url = url;
    wss.on('connection', (ws: WebSocket) => {
      ws.on('error', () => undefined);
      ws.on('message', (data: Buffer) => {
        let msg: unknown;
        try {
          msg = JSON.parse(data.toString('utf8'));
        } catch {
          return;
        }
        if (!Array.isArray(msg) || msg[0] !== 'REQ' || typeof msg[1] !== 'string') return;
        const sub = msg[1];
        this.reqs++;
        for (const e of this.#events) ws.send(JSON.stringify(['EVENT', sub, e]));
        ws.send(JSON.stringify(['EOSE', sub]));
      });
    });
  }

  static start(): Promise<NoticeRelay> {
    return new Promise((resolvePromise, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
      wss.once('error', reject);
      wss.once('listening', () => {
        const { port } = wss.address() as AddressInfo;
        resolvePromise(new NoticeRelay(wss, `ws://127.0.0.1:${String(port)}`));
      });
    });
  }

  /** What every later subscription is answered with. */
  hold(events: readonly object[]): void {
    this.#events = events;
  }

  stop(): Promise<void> {
    for (const c of this.#wss.clients) c.terminate();
    return new Promise((r) => {
      this.#wss.close(() => {
        r();
      });
    });
  }
}
