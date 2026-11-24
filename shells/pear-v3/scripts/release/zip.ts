/**
 * Reading a ZIP without trusting it: an artifact from CI, a macOS bundle's zip, or an `.msix`. This
 * is the one parse of a package, so what is checked is what ships. `unzip` and `ditto` are not
 * used: they resolve a duplicate name, or a symlink entry another entry writes through, by their
 * own rules.
 *
 * Refused, before anything is written: a duplicate name (also by case, for the file systems these
 * packages land on), an absolute path, a `..`, a backslash or control character, an entry inside a
 * symlink or a file, a local header that disagrees with the central directory, entries that
 * overlap, encryption, and anything over the size limits. A symlink must stay inside the tree.
 */
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

import { refuse } from './guards.ts';

export const MAX_ZIP_ENTRIES = 200_000;
export const MAX_ZIP_ENTRY_BYTES = 1024 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_NAME = 1024;
const MAX_LINK_TARGET = 4096;

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly crc: number;
  /** Where the entry's compressed bytes start. */
  readonly dataOffset: number;
  /** The POSIX mode of an entry made on Unix, else 0. */
  readonly mode: number;
}

const isSymlink = (e: ZipEntry): boolean => (e.mode & 0o170000) === 0o120000;
const isDirectory = (e: ZipEntry): boolean => e.name.endsWith('/');
const plainName = (e: ZipEntry): string => e.name.replace(/\/$/, '');

function readAt(fd: number, position: number, length: number, what: string): Buffer {
  const b = Buffer.alloc(length);
  if (readSync(fd, b, 0, length, position) !== length) return refuse(`${what}: truncated zip`);
  return b;
}

function safeNumber(v: bigint, what: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) return refuse(`${what}: a size out of range`);
  return Number(v);
}

interface Directory {
  readonly offset: number;
  readonly size: number;
  readonly count: number;
}

function findDirectory(fd: number, fileSize: number, what: string): Directory {
  if (fileSize < 22) return refuse(`${what}: not a zip`);
  const tailLength = Math.min(fileSize, 22 + 0xffff);
  const tailStart = fileSize - tailLength;
  const tail = readAt(fd, tailStart, tailLength, what);
  let at = -1;
  for (let i = tailLength - 22; i >= 0; i--)
    if (tail.readUInt32LE(i) === EOCD && i + 22 + tail.readUInt16LE(i + 20) === tailLength) {
      at = i;
      break;
    }
  if (at === -1) return refuse(`${what}: not a zip`);
  const eocdOffset = tailStart + at;
  if (tail.readUInt16LE(at + 4) !== 0 || tail.readUInt16LE(at + 6) !== 0)
    return refuse(`${what}: a multi-disk zip`);
  let count = tail.readUInt16LE(at + 10);
  let size = tail.readUInt32LE(at + 12);
  let offset = tail.readUInt32LE(at + 16);
  let end = eocdOffset;
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    if (eocdOffset < 20) return refuse(`${what}: no zip64 locator`);
    const locator = readAt(fd, eocdOffset - 20, 20, what);
    if (locator.readUInt32LE(0) !== LOCATOR64) return refuse(`${what}: no zip64 locator`);
    const at64 = safeNumber(locator.readBigUInt64LE(8), what);
    const record = readAt(fd, at64, 56, what);
    if (record.readUInt32LE(0) !== EOCD64) return refuse(`${what}: no zip64 record`);
    count = safeNumber(record.readBigUInt64LE(32), what);
    size = safeNumber(record.readBigUInt64LE(40), what);
    offset = safeNumber(record.readBigUInt64LE(48), what);
    end = at64;
  }
  if (count > MAX_ZIP_ENTRIES) return refuse(`${what}: too many entries`);
  if (offset + size !== end) return refuse(`${what}: the central directory is not where it says`);
  return { offset, size, count };
}

/** Every entry of the zip at `file`, after all the structural checks. */
export function readZipIndex(file: string): ZipEntry[] {
  const fd = openSync(file, 'r');
  try {
    const fileSize = fstatSync(fd).size;
    const dir = findDirectory(fd, fileSize, file);
    const cd = readAt(fd, dir.offset, dir.size, file);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let n = 0; n < dir.count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL)
        return refuse(`${file}: a bad central directory`);
      const madeBy = cd.readUInt16LE(p + 4) >> 8;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      const external = cd.readUInt32LE(p + 38);
      let localOffset = cd.readUInt32LE(p + 42);
      const nameEnd = p + 46 + nameLength;
      const extraEnd = nameEnd + extraLength;
      if (nameLength === 0 || nameLength > MAX_NAME || extraEnd + commentLength > cd.length)
        return refuse(`${file}: a bad central directory`);
      if ((flags & 1) !== 0) return refuse(`${file}: an encrypted entry`);
      if (method !== 0 && method !== 8) return refuse(`${file}: an unknown compression method`);
      const rawName = cd.subarray(p + 46, nameEnd);
      let name: string;
      try {
        name = decoder.decode(rawName);
      } catch {
        return refuse(`${file}: an entry name that is not UTF-8`);
      }
      // Zip64: only the fields that overflowed are present, in this order.
      if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
        let x = nameEnd;
        let found = false;
        while (x + 4 <= extraEnd) {
          const id = cd.readUInt16LE(x);
          const len = cd.readUInt16LE(x + 2);
          if (x + 4 + len > extraEnd) return refuse(`${file}: a bad extra field`);
          if (id === 1) {
            found = true;
            let y = x + 4;
            const next = (): number => {
              if (y + 8 > x + 4 + len) return refuse(`${file}: a short zip64 field`);
              const v = safeNumber(cd.readBigUInt64LE(y), file);
              y += 8;
              return v;
            };
            if (size === 0xffffffff) size = next();
            if (compressedSize === 0xffffffff) compressedSize = next();
            if (localOffset === 0xffffffff) localOffset = next();
          }
          x += 4 + len;
        }
        if (!found) return refuse(`${file}: no zip64 field`);
      }
      if (size > MAX_ZIP_ENTRY_BYTES) return refuse(`${file}: ${name} is too large`);
      // The local header must name the same entry: tools disagree about which one they read.
      const local = readAt(fd, localOffset, 30, file);
      if (local.readUInt32LE(0) !== LOCAL) return refuse(`${file}: a bad local header`);
      const localNameLength = local.readUInt16LE(26);
      const localName = readAt(fd, localOffset + 30, localNameLength, file);
      if (!localName.equals(rawName))
        return refuse(`${file}: ${name} has another name in its local header`);
      const dataOffset = localOffset + 30 + localNameLength + local.readUInt16LE(28);
      if (dataOffset + compressedSize > dir.offset)
        return refuse(`${file}: ${name} runs past its data`);
      entries.push({
        name,
        method,
        compressedSize,
        size,
        crc,
        dataOffset,
        mode: madeBy === 3 ? external >>> 16 : 0,
      });
      p = extraEnd + commentLength;
    }
    if (p !== cd.length) return refuse(`${file}: a bad central directory`);
    const ordered = [...entries].sort((a, b) => a.dataOffset - b.dataOffset);
    for (let i = 1; i < ordered.length; i++) {
      const a = ordered[i - 1];
      const b = ordered[i];
      if (a !== undefined && b !== undefined && a.dataOffset + a.compressedSize > b.dataOffset)
        return refuse(`${file}: two entries overlap`);
    }
    assertSafeNames(entries, file);
    return entries;
  } finally {
    closeSync(fd);
  }
}

/** A name as a case-insensitive file system sees it. */
const fold = (name: string): string => name.normalize('NFC').toLowerCase();

/** The name rules: see the header. */
export function assertSafeNames(entries: readonly ZipEntry[], what: string): void {
  let total = 0;
  const seen = new Set<string>();
  const kinds = new Map<string, ZipEntry>();
  for (const e of entries) {
    total += e.size;
    if (total > MAX_ZIP_TOTAL_BYTES) refuse(`${what}: too large unpacked`);
    const name = plainName(e);
    // eslint-disable-next-line no-control-regex -- exactly what is being refused
    if (name === '' || name.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(name))
      refuse(`${what}: an unsafe entry name ${JSON.stringify(e.name)}`);
    if (name.split('/').some((s) => s === '' || s === '.' || s === '..'))
      refuse(`${what}: an unsafe entry name ${JSON.stringify(e.name)}`);
    const folded = fold(name);
    if (seen.has(folded)) refuse(`${what}: a duplicate entry ${JSON.stringify(name)}`);
    seen.add(folded);
    kinds.set(folded, e);
  }
  // By folded name: on a case-insensitive file system `a/x` would land inside a symlink `A`.
  for (const e of entries) {
    const parts = fold(plainName(e)).split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = kinds.get(parts.slice(0, i).join('/'));
      if (parent !== undefined && !isDirectory(parent))
        refuse(`${what}: ${e.name} is inside a file or a symlink`);
    }
  }
}

function entryBytes(fd: number, e: ZipEntry, what: string): Buffer {
  const raw =
    e.compressedSize === 0 ? Buffer.alloc(0) : readAt(fd, e.dataOffset, e.compressedSize, what);
  let bytes: Buffer;
  try {
    bytes = e.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) });
  } catch {
    return refuse(`${what}: ${e.name} does not inflate to its size`);
  }
  if (bytes.length !== e.size || crc32(bytes) !== e.crc)
    return refuse(`${what}: ${e.name} does not match its checksum`);
  return bytes;
}

/** The bytes of the entry called exactly `name`. */
export function readZipFile(file: string, name: string): Buffer {
  const entries = readZipIndex(file);
  const e = entries.find((x) => x.name === name);
  if (e === undefined) return refuse(`${file} holds no ${name}`);
  const fd = openSync(file, 'r');
  try {
    return entryBytes(fd, e, file);
  } finally {
    closeSync(fd);
  }
}

/** Calls `visit` with each file entry's bytes, one at a time. */
export function forEachZipFile(
  file: string,
  visit: (entry: ZipEntry, bytes: Buffer) => void,
): void {
  const entries = readZipIndex(file);
  const fd = openSync(file, 'r');
  try {
    for (const e of entries) if (!isDirectory(e)) visit(e, entryBytes(fd, e, file));
  } finally {
    closeSync(fd);
  }
}

/** A symlink's target stays inside the tree it sits in. */
export function assertLinkInside(name: string, target: string, what: string): void {
  // eslint-disable-next-line no-control-regex -- exactly what is being refused
  if (target === '' || target.length > MAX_LINK_TARGET || /[\\\x00-\x1f\x7f]/.test(target))
    refuse(`${what}: ${name} has an unsafe link target`);
  if (target.startsWith('/')) refuse(`${what}: ${name} links to an absolute path`);
  const resolved = posix.normalize(posix.join(posix.dirname(name), target));
  if (resolved === '..' || resolved.startsWith('../'))
    refuse(`${what}: ${name} links outside the tree`);
}

/** Unpacks into `dir`, which must be new. Executable bits and symlinks are kept. */
export function extractZip(file: string, dir: string): void {
  const entries = readZipIndex(file);
  mkdirSync(dir);
  const fd = openSync(file, 'r');
  try {
    for (const e of entries) {
      const p = join(dir, ...plainName(e).split('/'));
      if (isDirectory(e)) {
        mkdirSync(p, { recursive: true });
        continue;
      }
      mkdirSync(dirname(p), { recursive: true });
      const bytes = entryBytes(fd, e, file);
      if (isSymlink(e)) {
        const target = bytes.toString('utf8');
        assertLinkInside(plainName(e), target, file);
        symlinkSync(target, p);
      } else {
        writeFileSync(p, bytes, { flag: 'wx', mode: (e.mode & 0o100) !== 0 ? 0o755 : 0o644 });
      }
    }
  } finally {
    closeSync(fd);
  }
}
