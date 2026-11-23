/**
 * The two calls `nostr-tools`' `BunkerSigner` makes of a pool (`subscribe`, `publish`), over the
 * worker's own relay sockets. Bare has no WebSocket global, and a NIP-46 session belongs in the
 * worker: its client key can ask the user's bunker for signatures, so the renderer must not hold
 * it. A relay is not trusted: every event is verified before `onevent`, and the bunker's answers
 * are NIP-44 encrypted to the client key on top of that.
 */
import type { Event } from 'nostr-tools/core';
import { verifyEvent } from 'nostr-tools/pure';

import type { RelayConnect, RelaySocket } from '../runtime.js';

/** One relay message; NIP-46 answers carry one small signed event. */
export const MAX_RELAY_MESSAGE_CHARS = 256 * 1024;
/** How long one publish waits for the relay's `OK`. */
export const PUBLISH_WAIT_MS = 10_000;

interface Handlers {
  readonly onevent: (event: Event) => void;
  readonly onclose?: (reasons: string[]) => void;
}

interface Sub {
  readonly id: string;
  readonly handlers: Handlers;
  /** The relays it is open on. */
  readonly relays: Set<Conn>;
  closed: boolean;
}

interface Waiting {
  readonly resolve: (why: string) => void;
  readonly reject: (e: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface Conn {
  readonly url: string;
  readonly socket: RelaySocket;
  readonly subs: Map<string, Sub>;
  readonly waiting: Map<string, Waiting>;
  ended: boolean;
}

export class BunkerRelayPool {
  readonly #connect: RelayConnect;
  readonly #conns = new Map<string, Conn>();
  #nextSub = 1;
  #destroyed = false;

  constructor(connect: RelayConnect) {
    this.#connect = connect;
  }

  subscribe(relays: readonly string[], filter: unknown, handlers: Handlers): { close(): void } {
    const sub: Sub = {
      id: `nip46-${String(this.#nextSub++)}`,
      handlers,
      relays: new Set(),
      closed: false,
    };
    for (const url of relays) {
      const conn = this.#conn(url);
      if (conn === null) continue;
      conn.subs.set(sub.id, sub);
      sub.relays.add(conn);
      this.#send(conn, JSON.stringify(['REQ', sub.id, filter]));
    }
    return {
      close: () => {
        if (sub.closed) return;
        sub.closed = true;
        for (const conn of sub.relays) {
          conn.subs.delete(sub.id);
          if (!conn.ended) this.#send(conn, JSON.stringify(['CLOSE', sub.id]));
        }
        sub.relays.clear();
      },
    };
  }

  publish(relays: readonly string[], event: Event): Promise<string>[] {
    return relays.map((url) => {
      const conn = this.#conn(url);
      if (conn === null) return Promise.reject(new Error('the relay is not reachable'));
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          conn.waiting.delete(event.id);
          reject(new Error('the relay did not answer'));
        }, PUBLISH_WAIT_MS);
        conn.waiting.set(event.id, { resolve, reject, timer });
        this.#send(conn, JSON.stringify(['EVENT', event]));
      });
    });
  }

  /** Every socket, every subscription and every wait. */
  destroy(): void {
    this.#destroyed = true;
    for (const conn of [...this.#conns.values()]) {
      this.#end(conn);
      try {
        conn.socket.destroy();
      } catch {
        // Already gone.
      }
    }
  }

  #conn(url: string): Conn | null {
    if (this.#destroyed) return null;
    const held = this.#conns.get(url);
    if (held !== undefined) return held;
    let socket: RelaySocket;
    try {
      socket = this.#connect(url);
    } catch {
      return null;
    }
    const conn: Conn = { url, socket, subs: new Map(), waiting: new Map(), ended: false };
    this.#conns.set(url, conn);
    socket.onEnd(() => {
      this.#end(conn);
    });
    socket.onMessage((text) => {
      this.#onMessage(conn, text);
    });
    return conn;
  }

  #send(conn: Conn, text: string): void {
    if (conn.ended) return;
    try {
      conn.socket.send(text);
    } catch {
      this.#end(conn);
    }
  }

  #end(conn: Conn): void {
    if (conn.ended) return;
    conn.ended = true;
    if (this.#conns.get(conn.url) === conn) this.#conns.delete(conn.url);
    for (const w of conn.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('the relay closed'));
    }
    conn.waiting.clear();
    for (const sub of [...conn.subs.values()]) {
      conn.subs.delete(sub.id);
      sub.relays.delete(conn);
      if (sub.relays.size === 0 && !sub.closed) {
        sub.closed = true;
        sub.handlers.onclose?.(['closed']);
      }
    }
  }

  #onMessage(conn: Conn, text: string): void {
    if (text.length > MAX_RELAY_MESSAGE_CHARS) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    const [type, a, b, c] = msg as unknown[];
    if (type === 'EVENT' && typeof a === 'string') {
      const sub = conn.subs.get(a);
      if (sub === undefined || typeof b !== 'object' || b === null) return;
      let verified: boolean;
      try {
        verified = verifyEvent(b as Event);
      } catch {
        return;
      }
      if (verified) sub.handlers.onevent(b as Event);
    } else if (type === 'OK' && typeof a === 'string') {
      const w = conn.waiting.get(a);
      if (w === undefined) return;
      conn.waiting.delete(a);
      clearTimeout(w.timer);
      if (b === true) w.resolve(typeof c === 'string' ? c : '');
      else w.reject(new Error('the relay refused the event'));
    } else if (type === 'CLOSED' && typeof a === 'string') {
      const sub = conn.subs.get(a);
      if (sub === undefined) return;
      conn.subs.delete(a);
      sub.relays.delete(conn);
      if (sub.relays.size === 0 && !sub.closed) {
        sub.closed = true;
        sub.handlers.onclose?.(['closed']);
      }
    }
  }
}
