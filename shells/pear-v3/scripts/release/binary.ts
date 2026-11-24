/**
 * What a native binary says about itself: which CPU it is for (so that a package in the wrong
 * target's slot is refused), and, for a Mach-O, a digest of its code that a code signature does not
 * change, so that a signed bundle can be compared with the unsigned build it came from.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';

import type { Arch } from '../../packaging/identity.ts';

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const CPU_X64 = 0x01000007;
const CPU_ARM64 = 0x0100000c;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
const HEADER_64 = 32;
/** `codesign` aligns the signature to 16 bytes, padding with zeros. */
const SIGNATURE_ALIGN = 16;

const cpuName = (cpu: number): Arch | null =>
  cpu === CPU_X64 ? 'x64' : cpu === CPU_ARM64 ? 'arm64' : null;

function head(file: string, n: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(n);
    const got = readSync(fd, b, 0, n, 0);
    return b.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** The CPU of a 64-bit little-endian ELF (an AppImage's runtime), or `null`. */
export function elfArch(file: string): Arch | null {
  const h = head(file, 20);
  if (h.length < 20 || h.toString('latin1', 0, 4) !== '\x7fELF' || h[4] !== 2 || h[5] !== 1)
    return null;
  const machine = h.readUInt16LE(18);
  return machine === 62 ? 'x64' : machine === 183 ? 'arm64' : null;
}

interface Slice {
  readonly cpu: number;
  readonly bytes: Buffer;
}

/** A Mach-O's 64-bit slices, or `null` if this is not one this tool can read. */
function slices(file: Buffer): Slice[] | null {
  if (file.length < HEADER_64) return null;
  if (file.readUInt32LE(0) === MH_MAGIC_64) return [{ cpu: file.readUInt32LE(4), bytes: file }];
  if (file.readUInt32BE(0) !== FAT_MAGIC) return null;
  const count = file.readUInt32BE(4);
  // A Java class file starts with the same four bytes, and then a version far above this.
  if (count === 0 || count > 8 || file.length < 8 + count * 20) return null;
  const out: Slice[] = [];
  for (let i = 0; i < count; i++) {
    const at = 8 + i * 20;
    const offset = file.readUInt32BE(at + 8);
    const size = file.readUInt32BE(at + 12);
    if (offset + size > file.length) return null;
    const bytes = file.subarray(offset, offset + size);
    if (bytes.length < HEADER_64 || bytes.readUInt32LE(0) !== MH_MAGIC_64) return null;
    out.push({ cpu: file.readUInt32BE(at), bytes });
  }
  return out;
}

/** The CPUs of a Mach-O, or `null` if it is not one. */
export function machoArches(file: string): Arch[] | null {
  const h = head(file, 8 + 8 * 20);
  if (h.length < 8) return null;
  const known = (cpus: readonly number[]): Arch[] =>
    cpus.map(cpuName).filter((a): a is Arch => a !== null);
  if (h.readUInt32LE(0) === MH_MAGIC_64) return known([h.readUInt32LE(4)]);
  if (h.readUInt32BE(0) !== FAT_MAGIC) return null;
  const count = h.readUInt32BE(4);
  if (count === 0 || count > 8 || h.length < 8 + count * 20) return null;
  return known(Array.from({ length: count }, (_, i) => h.readUInt32BE(8 + i * 20)));
}

/** One slice with its signature, and everything `codesign` updates for it, taken out. */
function withoutSignature(s: Buffer): Buffer | null {
  const ncmds = s.readUInt32LE(16);
  const sizeofcmds = s.readUInt32LE(20);
  if (HEADER_64 + sizeofcmds > s.length) return null;
  let at = HEADER_64;
  let signature: { at: number; size: number; dataoff: number; datasize: number } | null = null;
  let linkedit = -1;
  for (let i = 0; i < ncmds; i++) {
    if (at + 8 > HEADER_64 + sizeofcmds) return null;
    const cmd = s.readUInt32LE(at);
    const size = s.readUInt32LE(at + 4);
    if (size < 8 || at + size > HEADER_64 + sizeofcmds) return null;
    if (cmd === LC_CODE_SIGNATURE) {
      if (signature !== null || size !== 16) return null;
      signature = { at, size, dataoff: s.readUInt32LE(at + 8), datasize: s.readUInt32LE(at + 12) };
    } else if (cmd === LC_SEGMENT_64) {
      if (s.toString('latin1', at + 8, at + 24).replace(/\0+$/, '') === '__LINKEDIT') linkedit = at;
    }
    at += size;
  }
  if (signature !== null && signature.dataoff + signature.datasize > s.length) return null;
  const end = signature === null ? s.length : signature.dataoff;
  if (end < HEADER_64 + sizeofcmds) return null;
  const out = Buffer.from(s.subarray(0, end));
  // __LINKEDIT grows with the signature: its vmsize and filesize are all `codesign` changes there.
  if (linkedit !== -1) {
    out.fill(0, linkedit + 32, linkedit + 40);
    out.fill(0, linkedit + 48, linkedit + 56);
  }
  if (signature !== null) {
    const commandsEnd = HEADER_64 + sizeofcmds;
    out.copy(out, signature.at, signature.at + signature.size, commandsEnd);
    out.fill(0, commandsEnd - signature.size, commandsEnd);
    out.writeUInt32LE(ncmds - 1, 16);
    out.writeUInt32LE(sizeofcmds - signature.size, 20);
  }
  let length = out.length;
  const floor = Math.max(HEADER_64 + sizeofcmds, length - (SIGNATURE_ALIGN - 1));
  while (length > floor && out[length - 1] === 0) length--;
  return out.subarray(0, length);
}

/**
 * A digest of a Mach-O's code and data that re-signing it does not change, or `null` if `file` is
 * not a Mach-O this can read (it is then compared byte for byte).
 */
export function machoCodeDigest(file: Buffer): string | null {
  const all = slices(file);
  if (all === null) return null;
  const h = createHash('sha256');
  for (const s of all) {
    const code = withoutSignature(s.bytes);
    if (code === null) return null;
    h.update(`${String(s.cpu)}:${String(code.length)}:`);
    h.update(code);
  }
  return h.digest('hex');
}
