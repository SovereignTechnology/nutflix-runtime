/**
 * Files that reached the renderer over WebRTC, handed to the worker so that they need not be
 * fetched again to re-seed the video over HyperDHT (ADR 0001 §3). The renderer is not trusted:
 *
 *   - a file is taken only for a play session that this window holds (the gate checks the `sid`),
 *     and only if that session's VERIFIED hash list names its sha256 with exactly this size;
 *   - it arrives in order, in bounded chunks, into one buffer of the listed size: at most
 *     `MAX_ASSEMBLING` files at a time, so at most that many buffers;
 *   - the whole file's sha256 must equal the hash list's before it is kept, and `NfxStore` checks
 *     the bytes again when the video is stored.
 *
 * Kept under `<storage>/tmp/nfx-offered/` (the worker wipes `tmp/` at every start), at most
 * `MAX_OFFERED_BYTES`, and dropped once the video is stored.
 */
import type { nfx } from '@sovit/core';
import type { SeederFs } from '@sovit/seeder';

import { sha256Hex } from '../crypto.js';
import { fail } from '../errors.js';
import type { SeedingSegmentArgs, SeedingSegmentResult } from '../protocol.js';
import { MAX_OFFERED_FILE_BYTES } from '../protocol.js';

export const OFFERED_DIR = 'nfx-offered';
export const MAX_ASSEMBLING = 4;
export const MAX_OFFERED_BYTES = 2 * 1024 * 1024 * 1024;

/** What a play session knows of a file: from its verified hash list. */
export interface SessionListing {
  readonly video: string;
  /** The manifest `root` the session was opened with. */
  readonly root: string;
  /** What every file of the hash list adds up to. */
  readonly bytes: number;
  entry(sha: string): nfx.FileEntry | undefined;
}

interface Assembly {
  readonly video: string;
  readonly buf: Uint8Array;
  received: number;
}

const B64 = new Int8Array(256).fill(-1);
for (let i = 0; i < 64; i++)
  B64['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;

/** Decodes canonical base64 (the guard checked the alphabet). Bare has no `atob` or `Buffer`. */
export function fromBase64(s: string): Uint8Array {
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const a = B64[s.charCodeAt(i)] ?? -1;
    const b = B64[s.charCodeAt(i + 1)] ?? -1;
    const c = s[i + 2] === '=' ? 0 : (B64[s.charCodeAt(i + 2)] ?? -1);
    const d = s[i + 3] === '=' ? 0 : (B64[s.charCodeAt(i + 3)] ?? -1);
    if (a < 0 || b < 0 || c < 0 || d < 0) fail('invalid-argument', 'not base64');
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

export interface SegmentOffersDeps {
  readonly fs: SeederFs;
  /** `<storage>/tmp/nfx-offered`. */
  readonly dir: string;
  /** The session's verified listing, while it is open. */
  readonly listing: (sid: string) => SessionListing | null;
  /** Whether this file is already held, so it need not cross again. */
  readonly stored: (video: string) => boolean;
  /** TESTS ONLY. */
  readonly maxBytes?: number;
}

export class SegmentOffers {
  readonly #d: SegmentOffersDeps;
  readonly #assembling = new Map<string, Assembly>();
  /** video → sha256 → size, of what is on disk. */
  readonly #kept = new Map<string, Map<string, number>>();
  #bytes = 0;

  constructor(d: SegmentOffersDeps) {
    this.#d = d;
  }

  async offer(a: SeedingSegmentArgs): Promise<SeedingSegmentResult> {
    const key = `${a.sid}:${a.sha256}`;
    const listing = this.#d.listing(a.sid);
    if (listing === null) {
      this.#assembling.delete(key);
      fail('session-closed', 'that play session is not open');
    }
    const entry = listing.entry(a.sha256);
    if (entry?.size !== BigInt(a.size)) {
      this.#assembling.delete(key);
      fail('invalid-argument', 'the hash list does not name this file');
    }
    if (a.size > MAX_OFFERED_FILE_BYTES) fail('invalid-argument', 'file too large');
    if (this.#kept.get(listing.video)?.has(a.sha256) === true || this.#d.stored(listing.video))
      return { accepted: false, complete: true };

    let asm = this.#assembling.get(key);
    if (asm === undefined) {
      if (a.offset !== 0) fail('invalid-argument', 'a file is offered from its start');
      if (this.#assembling.size >= MAX_ASSEMBLING)
        fail('rate-limited', 'too many files are being handed over');
      if (this.#bytes + a.size > (this.#d.maxBytes ?? MAX_OFFERED_BYTES))
        return { accepted: false, complete: false };
      asm = { video: listing.video, buf: new Uint8Array(a.size), received: 0 };
      this.#assembling.set(key, asm);
    }
    const chunk = fromBase64(a.data);
    if (a.offset !== asm.received || chunk.length === 0 || a.offset + chunk.length > a.size) {
      this.#assembling.delete(key);
      fail('invalid-argument', 'chunks arrive in order, inside the file');
    }
    asm.buf.set(chunk, a.offset);
    asm.received += chunk.length;
    if (asm.received < a.size) return { accepted: true, complete: false };

    this.#assembling.delete(key);
    if (sha256Hex(asm.buf) !== a.sha256)
      fail('invalid-argument', 'the bytes are not the file the hash list names');
    await this.#d.fs.mkdir(this.#d.dir, { recursive: true });
    await this.#d.fs.writeFile(this.#d.fs.join(this.#d.dir, a.sha256), asm.buf);
    let files = this.#kept.get(listing.video);
    if (files === undefined) {
      files = new Map();
      this.#kept.set(listing.video, files);
    }
    files.set(a.sha256, a.size);
    this.#bytes += a.size;
    return { accepted: true, complete: true };
  }

  /** A kept file's bytes (`NfxStore` checks them against the hash list), or `null`. */
  async read(video: string, sha: string): Promise<Uint8Array | null> {
    if (this.#kept.get(video)?.has(sha) !== true) return null;
    try {
      return await this.#d.fs.readFile(this.#d.fs.join(this.#d.dir, sha));
    } catch {
      return null;
    }
  }

  /** The video is stored (or abandoned): its kept files go, unless another video lists them. */
  async drop(video: string): Promise<void> {
    const files = this.#kept.get(video);
    if (files === undefined) return;
    this.#kept.delete(video);
    for (const [sha, size] of files) {
      this.#bytes -= size;
      if ([...this.#kept.values()].some((m) => m.has(sha))) continue;
      await this.#d.fs.unlink(this.#d.fs.join(this.#d.dir, sha)).catch(() => undefined);
    }
  }

  /** The play ended: its unfinished files are dropped, so they hold no memory. */
  endSession(sid: string): void {
    for (const key of [...this.#assembling.keys()])
      if (key.startsWith(`${sid}:`)) this.#assembling.delete(key);
  }

  get assembling(): number {
    return this.#assembling.size;
  }

  get keptBytes(): number {
    return this.#bytes;
  }
}
