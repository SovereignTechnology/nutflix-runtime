/**
 * Asks the baked-in relays for release notices (NIP-01 over a WebSocket). A relay is not trusted:
 * what it sends is only collected here, bounded, and judged by `notice.ts`. A relay that does not
 * answer in time, closes, or sends too much simply ends with what it sent.
 */
import { NOTICE_D, NOTICE_KIND, type TrustRoot } from './root.ts';

export const RELAY_TIMEOUT_MS = 10_000;
/** One relay message; a notice is a few KiB. `bare-ws` is told the same limit. */
export const MAX_RELAY_MESSAGE_BYTES = 128 * 1024;
export const MAX_RELAY_BYTES = 1024 * 1024;
export const MAX_RELAY_EVENTS = 32;
const SUB = 'nutflix-update';

/** What the query needs of a WebSocket: messages as text. */
export interface RelaySocket {
  onMessage(cb: (text: string) => void): void;
  onEnd(cb: () => void): void;
  send(text: string): void;
  destroy(): void;
}

export type RelayConnect = (url: string) => RelaySocket;

export interface RelayAnswers {
  /** Everything the relays sent as an event, unverified. */
  readonly events: readonly unknown[];
  /** How many relays answered the subscription (an event, EOSE or CLOSED). */
  readonly reached: number;
}

interface One {
  readonly events: unknown[];
  reached: boolean;
}

function ask(url: string, root: TrustRoot, connect: RelayConnect, timeoutMs: number): Promise<One> {
  return new Promise((resolve) => {
    const out: One = { events: [], reached: false };
    let bytes = 0;
    let socket: RelaySocket | null = null;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // Already gone.
      }
      resolve(out);
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      socket = connect(url);
      socket.onEnd(finish);
      socket.onMessage((text) => {
        if (done) return;
        bytes += text.length;
        if (text.length > MAX_RELAY_MESSAGE_BYTES || bytes > MAX_RELAY_BYTES) {
          finish();
          return;
        }
        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (!Array.isArray(msg) || msg[1] !== SUB) return;
        const [type, , event] = msg as [unknown, unknown, unknown];
        if (type === 'EVENT') {
          out.reached = true;
          out.events.push(event);
          if (out.events.length >= MAX_RELAY_EVENTS) finish();
        } else if (type === 'EOSE' || type === 'CLOSED') {
          out.reached = true;
          finish();
        }
      });
      socket.send(
        JSON.stringify([
          'REQ',
          SUB,
          { kinds: [NOTICE_KIND], authors: [root.pubkey], '#d': [NOTICE_D], limit: 8 },
        ]),
      );
    } catch {
      finish();
    }
  });
}

/** Every relay of the root, at once; resolves when each has answered or timed out. */
export async function fetchNotices(
  root: TrustRoot,
  connect: RelayConnect,
  timeoutMs: number = RELAY_TIMEOUT_MS,
): Promise<RelayAnswers> {
  const all = await Promise.all(root.relays.map((u) => ask(u, root, connect, timeoutMs)));
  return {
    events: all.flatMap((a) => a.events),
    reached: all.filter((a) => a.reached).length,
  };
}
