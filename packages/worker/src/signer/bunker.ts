/**
 * A NIP-46 bunker session, held by the worker (ADR 0001 §8). The client key of the channel is made
 * here and never leaves: whoever holds it can ask the bunker for signatures, so a renderer that
 * held it could sign outside `SIGNABLE_KINDS`. The URI's `secret` is used once, for `connect`, and
 * is not stored or logged.
 *
 * Only `bunker://<64 hex>?relay=…[&secret=…]`: no NIP-05 lookup, and relays are `wss://`, or
 * `ws://` to loopback (a local bunker, and the tests), with no credentials in them.
 */
import type { signer as coreSigner } from '@sovit/core';
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import { BunkerSigner, type BunkerPointer } from 'nostr-tools/nip46';

import { randomBytes } from '../crypto.js';
import { fail } from '../errors.js';
import { MAX_BUNKER_RELAYS } from '../protocol.js';
import type { RelayConnect } from '../runtime.js';
import { BunkerRelayPool } from './relay-pool.js';

/** How long one NIP-46 request may wait: a bunker may be asking its user. */
export const BUNKER_WAIT_MS = 60_000;

const URI = /^bunker:\/\/([0-9a-f]{64})\?([\x21-\x7e]*)$/;
const SECRET = /^[\x21-\x7e]{1,256}$/;
/**
 * A relay URL: scheme, host, optional port and path. No user-info, query or fragment. Written out
 * because Bare has no `URL` global, and because this is stricter than a URL parser.
 */
const RELAY =
  /^(wss?):\/\/([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::([1-9][0-9]{0,4}))?(\/[A-Za-z0-9._~/-]*)?$/;

function checkRelay(raw: string): string {
  const m = RELAY.exec(raw);
  if (m === null) fail('invalid-argument', 'a bunker relay must be a plain wss:// URL');
  if (m[1] === 'ws' && m[2] !== '127.0.0.1')
    fail('invalid-argument', 'a bunker relay must be wss://, or ws:// to 127.0.0.1');
  if (m[3] !== undefined && Number(m[3]) > 65535)
    fail('invalid-argument', 'a bunker relay has no such port');
  return raw;
}

function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    fail('invalid-argument', 'not a bunker URI');
  }
}

/** Throws `invalid-argument`, in this client's words: the URI may hold a secret. */
export function parseBunkerUri(uri: string): BunkerPointer {
  const m = URI.exec(uri);
  if (m === null) fail('invalid-argument', 'expected bunker://<64 hex>?relay=wss://…');
  const relays: string[] = [];
  const secrets: string[] = [];
  for (const part of (m[2] ?? '').split('&')) {
    const at = part.indexOf('=');
    const key = at < 0 ? part : part.slice(0, at);
    const value = at < 0 ? '' : decoded(part.slice(at + 1));
    if (key === 'relay') relays.push(value);
    else if (key === 'secret') secrets.push(value);
    else fail('invalid-argument', 'a bunker URI takes only relay and secret');
  }
  if (relays.length === 0 || relays.length > MAX_BUNKER_RELAYS)
    fail('invalid-argument', 'a bunker URI names 1 to 4 relays');
  const secret = secrets[0] ?? null;
  if (secrets.length > 1 || (secret !== null && !SECRET.test(secret)))
    fail('invalid-argument', 'not a bunker secret');
  return { pubkey: m[1] ?? '', relays: relays.map(checkRelay), secret };
}

export interface OpenedBunker {
  readonly bunker: coreSigner.BunkerLike;
  readonly relays: readonly string[];
}

/** Connects and learns the user's public key, or fails `no-signer`. */
export async function openBunker(
  uri: string,
  connect: RelayConnect,
  waitMs: number = BUNKER_WAIT_MS,
): Promise<OpenedBunker> {
  const bp = parseBunkerUri(uri);
  const pool = new BunkerRelayPool(connect);
  // No `onauth`: an `auth_url` challenge is refused rather than followed.
  const signer = BunkerSigner.fromBunker(randomBytes(32), bp, {
    pool: pool as unknown as AbstractSimplePool,
    timeout: waitMs,
  });
  const dispose = async (): Promise<void> => {
    await signer.close().catch(() => undefined);
    pool.destroy();
  };
  try {
    await signer.connect();
    await signer.getPublicKey();
  } catch {
    await dispose();
    fail('no-signer', 'the bunker did not accept this connection');
  }
  return {
    relays: bp.relays,
    bunker: {
      getPublicKey: () => signer.getPublicKey(),
      signEvent: (t) => signer.signEvent(t),
      nip44Encrypt: (peer, text) => signer.nip44Encrypt(peer, text),
      nip44Decrypt: (peer, text) => signer.nip44Decrypt(peer, text),
      close: dispose,
    },
  };
}
