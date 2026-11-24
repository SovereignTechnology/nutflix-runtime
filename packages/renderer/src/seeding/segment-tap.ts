/**
 * Handing the worker the files this page's WebRTC player received, so that they can be re-seeded
 * over HyperDHT without being fetched again (ADR 0001 §3).
 *
 * The pinned nfx player library has no call that gives its bytes back. What it does do is verify
 * each file against the hash list (the `verified` event names the sha256) and append exactly those
 * bytes to a `SourceBuffer`: an init segment or a whole fMP4 segment. So this wraps `appendBuffer`:
 * while seeding is on and a play is open, what is appended is hashed, and only a buffer whose
 * sha256 the player just verified is handed over.
 *
 * Nothing here is trusted by the worker: it checks each file against the session's hash list again
 * (`seeding.segment`). And nothing here affects playback: the original `appendBuffer` runs first
 * and unchanged, and every failure below it is dropped.
 */
import { MAX_OFFERED_CHUNK_BYTES, MAX_OFFERED_FILE_BYTES } from '@nutflix-runtime/worker';

import type { ControlWorker } from '../worker/pipe.js';

/** Files being hashed or sent at once; more are not handed over (a fetch will get them). */
export const MAX_TAP_PENDING = 4;
/** Verified hashes remembered per play: the most a viewer's buffer holds, generously. */
export const MAX_TAP_WANTED = 4096;
/** Decoded bytes per `seeding.segment`: inside the worker's chunk cap. */
export const TAP_CHUNK_BYTES = Math.min(384 * 1024, MAX_OFFERED_CHUNK_BYTES);

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const hex = (b: ArrayBuffer): string =>
  Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

export interface SegmentTapOptions {
  readonly worker: Pick<ControlWorker, 'call'>;
  /** The switch, as last read from the worker. */
  readonly enabled: () => boolean;
  /** Default: `crypto.subtle`. */
  readonly sha256?: (bytes: Uint8Array) => Promise<string>;
}

interface BufferProto {
  appendBuffer(this: unknown, data: BufferSource): void;
}

export class SegmentTap {
  readonly #o: SegmentTapOptions;
  /** sha256 → the play session whose player verified it. */
  readonly #wanted = new Map<string, string>();
  readonly #sent = new Set<string>();
  #pending = 0;
  #restore: (() => void) | null = null;

  constructor(o: SegmentTapOptions) {
    this.#o = o;
  }

  /** Wraps `proto.appendBuffer` (`SourceBuffer.prototype`), once. */
  install(proto: BufferProto | undefined): void {
    if (proto === undefined || this.#restore !== null) return;
    // Called below with the receiver it was called on.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = proto.appendBuffer;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const tap = this;
    proto.appendBuffer = function (this: unknown, data: BufferSource): void {
      original.call(this, data);
      tap.appended(data);
    };
    this.#restore = () => {
      proto.appendBuffer = original;
    };
  }

  uninstall(): void {
    this.#restore?.();
    this.#restore = null;
    this.#wanted.clear();
  }

  /** The player verified `sha256` for the play `sid`. */
  verified(sha256: string, sid: string): void {
    if (!this.#o.enabled() || this.#sent.has(sha256)) return;
    if (this.#wanted.size >= MAX_TAP_WANTED) {
      const oldest = this.#wanted.keys().next();
      if (oldest.done !== true) this.#wanted.delete(oldest.value);
    }
    this.#wanted.set(sha256, sid);
  }

  /** The play ended: nothing more is handed over for it. */
  ended(sid: string): void {
    for (const [sha, s] of this.#wanted) if (s === sid) this.#wanted.delete(sha);
  }

  /** Called with what was appended. Never throws. */
  appended(data: BufferSource): void {
    try {
      if (!this.#o.enabled() || this.#wanted.size === 0 || this.#pending >= MAX_TAP_PENDING) return;
      const view =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (view.byteLength === 0 || view.byteLength > MAX_OFFERED_FILE_BYTES) return;
      this.#pending += 1;
      // A copy: the player owns its buffer and may reuse it.
      void this.#handOver(view.slice()).finally(() => {
        this.#pending -= 1;
      });
    } catch {
      // Playback is what matters here.
    }
  }

  async #handOver(bytes: Uint8Array): Promise<void> {
    try {
      const sha256 = await (this.#o.sha256 ?? digest)(bytes);
      const sid = this.#wanted.get(sha256);
      if (sid === undefined) return;
      this.#wanted.delete(sha256);
      this.#sent.add(sha256);
      for (let offset = 0; offset < bytes.length; offset += TAP_CHUNK_BYTES) {
        const r = await this.#o.worker.call('seeding.segment', {
          sid,
          sha256,
          size: bytes.length,
          offset,
          data: toBase64(bytes.subarray(offset, offset + TAP_CHUNK_BYTES)),
        });
        if (!r.accepted) return;
      }
    } catch {
      // A refused or lost file is simply fetched when the video is stored.
    }
  }
}

async function digest(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer));
}
