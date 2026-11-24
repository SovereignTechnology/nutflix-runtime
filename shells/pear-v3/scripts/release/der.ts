/**
 * Just enough DER to read two things a signature carries: the entitlements of a macOS code
 * signature, and the signer's certificate in an `.msix`'s PKCS#7. Every length is bounds-checked,
 * and anything that is not the shape expected is refused.
 */
import { refuse } from './guards.ts';

export interface Tlv {
  readonly tag: number;
  /** Where the value starts and ends in the buffer. */
  readonly start: number;
  readonly end: number;
  /** Where the whole element starts (its tag). */
  readonly at: number;
}

/** The element at `at`, which must end by `limit`. */
export function readTlv(buf: Buffer, at: number, limit: number = buf.length): Tlv {
  if (at + 2 > limit) return refuse('DER: truncated');
  const tag = buf[at] ?? 0;
  if ((tag & 0x1f) === 0x1f) return refuse('DER: a multi-byte tag');
  let len = buf[at + 1] ?? 0;
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || start + n > limit) return refuse('DER: a bad length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + (buf[start + i] ?? 0);
    start += n;
  }
  const end = start + len;
  if (end > limit) return refuse('DER: an element runs past its parent');
  return { tag, start, end, at };
}

/** The elements inside a constructed element. */
export function children(buf: Buffer, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let at = parent.start;
  while (at < parent.end) {
    const t = readTlv(buf, at, parent.end);
    out.push(t);
    at = t.end;
  }
  return out;
}

export const bytesOf = (buf: Buffer, t: Tlv): Buffer => buf.subarray(t.start, t.end);
export const elementOf = (buf: Buffer, t: Tlv): Buffer => buf.subarray(t.at, t.end);
