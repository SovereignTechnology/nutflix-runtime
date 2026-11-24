/**
 * What a native binary says about itself: which CPU it is for (so that a package in the wrong
 * target's slot is refused), and, for a Mach-O, a digest of its code that a code signature does not
 * change, so that a signed bundle can be compared with the unsigned build it came from.
 */
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';

import type { Arch } from '../../packaging/identity.ts';
import { bytesOf, children, readTlv } from './der.ts';
import { refuse } from './guards.ts';

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const CPU_X64 = 0x01000007;
const CPU_ARM64 = 0x0100000c;
const LC_SEGMENT_64 = 0x19;
const LC_CODE_SIGNATURE = 0x1d;
const HEADER_64 = 32;

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

/** Whether `file` starts like a 64-bit Mach-O, thin or universal (read from its first bytes). */
export function isMachoFile(file: string): boolean {
  const h = head(file, 8);
  if (h.length < 8) return false;
  if (h.readUInt32LE(0) === MH_MAGIC_64) return true;
  // A Java class file starts with the same four bytes, and then a version far above 8.
  return h.readUInt32BE(0) === FAT_MAGIC && h.readUInt32BE(4) > 0 && h.readUInt32BE(4) <= 8;
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

const LC_SYMTAB = 0x02;
const LC_DYSYMTAB = 0x0b;
const LC_DYLD_INFO = 0x22;
const LC_DYLD_INFO_ONLY = 0x80000022;
/** Load commands shaped as `linkedit_data_command`: data in __LINKEDIT at (dataoff, datasize). */
const LINKEDIT_DATA = new Set([
  0x1e, // LC_SEGMENT_SPLIT_INFO
  0x26, // LC_FUNCTION_STARTS
  0x29, // LC_DATA_IN_CODE
  0x2b, // LC_DYLIB_CODE_SIGN_DRS
  0x2e, // LC_LINKER_OPTIMIZATION_HINT
  0x80000033, // LC_DYLD_EXPORTS_TRIE
  0x80000034, // LC_DYLD_CHAINED_FIXUPS
  0x36, // LC_ATOM_INFO
]);
const LC_TWOLEVEL_HINTS = 0x16;
const LC_NOTE = 0x31;

interface Layout {
  readonly ncmds: number;
  readonly sizeofcmds: number;
  readonly signature: { at: number; size: number; dataoff: number; datasize: number } | null;
  readonly linkedit: number;
  /** Where the last byte any load command points at, other than the signature, ends. */
  readonly dataEnd: number;
  readonly fileType: number;
}

function layout(s: Buffer): Layout | null {
  const ncmds = s.readUInt32LE(16);
  const sizeofcmds = s.readUInt32LE(20);
  if (HEADER_64 + sizeofcmds > s.length) return null;
  let at = HEADER_64;
  let signature: Layout['signature'] = null;
  let linkedit = -1;
  let dataEnd = HEADER_64 + sizeofcmds;
  const reach = (off: number, size: number): void => {
    if (size > 0) dataEnd = Math.max(dataEnd, off + size);
  };
  for (let i = 0; i < ncmds; i++) {
    if (at + 8 > HEADER_64 + sizeofcmds) return null;
    const cmd = s.readUInt32LE(at);
    const size = s.readUInt32LE(at + 4);
    if (size < 8 || at + size > HEADER_64 + sizeofcmds) return null;
    const u = (o: number): number => (o + 4 <= size ? s.readUInt32LE(at + o) : 0);
    if (cmd === LC_CODE_SIGNATURE) {
      if (signature !== null || size !== 16) return null;
      signature = { at, size, dataoff: u(8), datasize: u(12) };
    } else if (cmd === LC_SEGMENT_64) {
      const name = s.toString('latin1', at + 8, at + 24).replace(/\0+$/, '');
      if (name === '__LINKEDIT') linkedit = at;
      else reach(Number(s.readBigUInt64LE(at + 40)), Number(s.readBigUInt64LE(at + 48)));
    } else if (cmd === LC_SYMTAB) {
      reach(u(8), u(12) * 16);
      reach(u(16), u(20));
    } else if (cmd === LC_DYSYMTAB) {
      reach(u(32), u(36) * 8);
      reach(u(40), u(44) * 56);
      reach(u(48), u(52) * 4);
      reach(u(56), u(60) * 4);
      reach(u(64), u(68) * 8);
      reach(u(72), u(76) * 8);
    } else if (cmd === LC_DYLD_INFO || cmd === LC_DYLD_INFO_ONLY) {
      for (let o = 8; o < 48; o += 8) reach(u(o), u(o + 4));
    } else if (LINKEDIT_DATA.has(cmd)) {
      reach(u(8), u(12));
    } else if (cmd === LC_TWOLEVEL_HINTS) {
      reach(u(8), u(12) * 4);
    } else if (cmd === LC_NOTE && size >= 40) {
      reach(Number(s.readBigUInt64LE(at + 24)), Number(s.readBigUInt64LE(at + 32)));
    }
    at += size;
  }
  if (signature !== null && signature.dataoff + signature.datasize > s.length) return null;
  return { ncmds, sizeofcmds, signature, linkedit, dataEnd, fileType: s.readUInt32LE(12) };
}

/**
 * One slice with its signature, and everything `codesign` updates for it, taken out. The signature
 * must start at or after the end of everything else the load commands point at, so it cannot have
 * overwritten any of it. The zero padding `codesign` puts before it is dropped, down to that end and
 * never into it.
 */
function withoutSignature(s: Buffer): Buffer | null {
  const l = layout(s);
  if (l === null) return null;
  const end = l.signature === null ? s.length : l.signature.dataoff;
  if (l.dataEnd > end) return null;
  let length = end;
  while (length > l.dataEnd && s[length - 1] === 0) length--;
  const out = Buffer.from(s.subarray(0, length));
  // __LINKEDIT grows with the signature: its vmsize and filesize are all `codesign` changes there.
  if (l.linkedit !== -1) {
    out.fill(0, l.linkedit + 32, l.linkedit + 40);
    out.fill(0, l.linkedit + 48, l.linkedit + 56);
  }
  if (l.signature !== null) {
    const commandsEnd = HEADER_64 + l.sizeofcmds;
    out.copy(out, l.signature.at, l.signature.at + l.signature.size, commandsEnd);
    out.fill(0, commandsEnd - l.signature.size, commandsEnd);
    out.writeUInt32LE(l.ncmds - 1, 16);
    out.writeUInt32LE(l.sizeofcmds - l.signature.size, 20);
  }
  return out;
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

// ---- what a signature says ----------------------------------------------------------------------

/** Mach-O `filetype` of a main executable. */
export const MH_EXECUTE = 2;
/** CodeDirectory flags. */
export const CS_ADHOC = 0x2;
export const CS_RUNTIME = 0x10000;

const SUPERBLOB = 0xfade0cc0;
const CODEDIRECTORY = 0xfade0c02;
const ENTITLEMENTS_XML = 0xfade7171;
const ENTITLEMENTS_DER = 0xfade7172;
const CMS_WRAPPER = 0xfade0b01;

export type Entitlements = ReadonlyMap<string, boolean>;

export interface CodeSignature {
  readonly flags: number;
  readonly teamId: string | null;
  /** A CMS signature with content: signed by an identity, not ad-hoc. */
  readonly identity: boolean;
  /** What the signature grants. Refused if the XML and DER copies disagree. */
  readonly entitlements: Entitlements;
}

export interface SliceSignature {
  readonly cpu: number;
  readonly fileType: number;
  /** `null`: the slice is not signed. */
  readonly signature: CodeSignature | null;
}

const PLIST =
  /^\s*(?:<\?xml[^>]*\?>)?\s*(?:<!DOCTYPE[^>]*>)?\s*<plist version="1\.0">\s*(?:<dict\/>|<dict>([\s\S]*?)<\/dict>)\s*<\/plist>\s*$/;
const PLIST_ENTRY = /\s*<key>([^<]{1,200})<\/key>\s*<(true|false)\/>\s*/y;

/** An entitlements plist of booleans; anything else is refused. */
export function parseEntitlementsXml(text: string): Entitlements {
  const m = PLIST.exec(text);
  if (m === null) return refuse('the entitlements are not a plist of booleans');
  const body = m[1] ?? '';
  const out = new Map<string, boolean>();
  PLIST_ENTRY.lastIndex = 0;
  while (PLIST_ENTRY.lastIndex < body.length) {
    const at = PLIST_ENTRY.lastIndex;
    const e = PLIST_ENTRY.exec(body);
    if (e === null) {
      if (body.slice(at).trim() === '') break;
      return refuse('the entitlements hold something other than booleans');
    }
    if (out.has(e[1] ?? '')) return refuse('an entitlement is named twice');
    out.set(e[1] ?? '', e[2] === 'true');
  }
  return out;
}

/** The DER form `codesign` also writes: [APPLICATION 16] { 1, [16] { {key, BOOLEAN}... } }. */
export function parseEntitlementsDer(buf: Buffer): Entitlements {
  const top = readTlv(buf, 0);
  if (top.tag !== 0x70 || top.end !== buf.length) return refuse('the DER entitlements are not one');
  const [version, dict, ...rest] = children(buf, top);
  if (version?.tag !== 0x02 || dict?.tag !== 0xb0 || rest.length > 0)
    return refuse('the DER entitlements are not one');
  const out = new Map<string, boolean>();
  for (const pair of children(buf, dict)) {
    const [k, v, ...more] = pair.tag === 0x30 ? children(buf, pair) : [];
    if (k?.tag !== 0x0c || v?.tag !== 0x01 || more.length > 0 || v.end - v.start !== 1)
      return refuse('the DER entitlements hold something other than booleans');
    const key = bytesOf(buf, k).toString('utf8');
    if (out.has(key)) return refuse('an entitlement is named twice');
    out.set(key, (buf[v.start] ?? 0) !== 0);
  }
  return out;
}

const sameEntitlements = (a: Entitlements, b: Entitlements): boolean =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

function readSignature(s: Buffer, l: Layout): CodeSignature | null {
  if (l.signature === null) return null;
  const base = l.signature.dataoff;
  const end = base + l.signature.datasize;
  const be = (o: number): number => {
    if (o + 4 > end) return refuse('a code signature runs past its end');
    return s.readUInt32BE(o);
  };
  if (be(base) !== SUPERBLOB) return refuse('a code signature without its superblob');
  const count = be(base + 8);
  if (count > 64) return refuse('a code signature with too many parts');
  let directories = 0;
  let flags = -1;
  let teamId: string | null = null;
  let identity = false;
  let xml: Entitlements | null = null;
  let der: Entitlements | null = null;
  const seen = new Set<number>();
  for (let i = 0; i < count; i++) {
    const offset = base + be(base + 12 + i * 8 + 4);
    const magic = be(offset);
    const length = be(offset + 4);
    if (length < 8 || offset + length > end)
      return refuse('a code signature part runs past its end');
    const body = s.subarray(offset + 8, offset + length);
    if (magic === CODEDIRECTORY) {
      const version = be(offset + 8);
      const f = be(offset + 12);
      let team: string | null = null;
      if (version >= 0x20200) {
        const teamOffset = be(offset + 48);
        if (teamOffset !== 0) {
          const from = offset + teamOffset;
          const zero = s.indexOf(0, from);
          if (zero === -1 || zero > offset + length) return refuse('a Team ID runs past its part');
          team = s.toString('latin1', from, zero);
        }
      }
      // Every code directory (SHA-1 and SHA-256 alike) must say the same.
      if (directories > 0 && (f !== flags || team !== teamId))
        return refuse('two code directories disagree');
      directories++;
      flags = f;
      teamId = team;
    } else if (magic === ENTITLEMENTS_XML || magic === ENTITLEMENTS_DER || magic === CMS_WRAPPER) {
      // One of each: a second copy could be the one the system reads.
      if (seen.has(magic)) return refuse('a code signature holds a part twice');
      seen.add(magic);
      if (magic === ENTITLEMENTS_XML) xml = parseEntitlementsXml(body.toString('utf8'));
      else if (magic === ENTITLEMENTS_DER) der = parseEntitlementsDer(Buffer.from(body));
      else identity = length > 8;
    }
  }
  if (directories === 0) return refuse('a code signature without a code directory');
  if (xml !== null && der !== null && !sameEntitlements(xml, der))
    return refuse('the two copies of the entitlements disagree');
  return { flags, teamId, identity, entitlements: xml ?? der ?? new Map() };
}

/** What each slice's signature says, or `null` if `file` is not a Mach-O this can read. */
export function machoSignatures(file: Buffer): SliceSignature[] | null {
  const all = slices(file);
  if (all === null) return null;
  const out: SliceSignature[] = [];
  for (const s of all) {
    const l = layout(s.bytes);
    if (l === null) return null;
    out.push({ cpu: s.cpu, fileType: l.fileType, signature: readSignature(s.bytes, l) });
  }
  return out;
}

// ---- whether a signature is valid ---------------------------------------------------------------

/** What a bundle's main executable seals besides its code: the bundle's Info.plist and resource seal. */
export interface SealedFiles {
  readonly infoPlist: Buffer | null;
  readonly resources: Buffer | null;
}

/** Superblob slot types (`cs_blobs.h`). */
const SLOT_CODEDIRECTORY = 0;
const SLOT_INFO = 1;
const SLOT_REQUIREMENTS = 2;
const SLOT_RESOURCES = 3;
const SLOT_APPLICATION = 4;
const SLOT_ENTITLEMENTS = 5;
const SLOT_REP_SPECIFIC = 6;
const SLOT_DER_ENTITLEMENTS = 7;
/** Launch and library constraints: blobs in the superblob, hashed like the entitlements. */
const SLOT_LAST_BLOB = 11;
const SLOT_ALTERNATE_DIRECTORIES = 0x1000;
const SLOT_SIGNATURE = 0x10000;
const REQUIREMENTS = 0xfade0c01;
/** A launch or library constraint (slots 8 to 11). */
const CONSTRAINT = 0xfade8181;

const HASH_TYPES: Readonly<Record<number, { algorithm: string; size: number }>> = {
  1: { algorithm: 'sha1', size: 20 },
  2: { algorithm: 'sha256', size: 32 },
  3: { algorithm: 'sha256', size: 20 }, // SHA-256, truncated
  4: { algorithm: 'sha384', size: 48 },
};

const digestOf = (algorithm: string, size: number, bytes: Buffer): Buffer =>
  createHash(algorithm).update(bytes).digest().subarray(0, size);

/**
 * A slice's own Info.plist, linked into `__TEXT,__info_plist`: what `codesign` binds in special slot
 * 1 for a binary that is not a bundle's main executable. `null` if it has none.
 */
function embeddedInfoPlist(s: Buffer): Buffer | null {
  const ncmds = s.readUInt32LE(16);
  let at = HEADER_64;
  for (let i = 0; i < ncmds && at + 8 <= s.length; i++) {
    const cmd = s.readUInt32LE(at);
    const size = s.readUInt32LE(at + 4);
    if (size < 8) return null;
    if (
      cmd === LC_SEGMENT_64 &&
      s.toString('latin1', at + 8, at + 24).replace(/\0+$/, '') === '__TEXT'
    ) {
      const nsects = s.readUInt32LE(at + 64);
      for (let j = 0; j < nsects; j++) {
        const sec = at + 72 + j * 80;
        if (sec + 80 > at + size) return null;
        if (s.toString('latin1', sec, sec + 16).replace(/\0+$/, '') !== '__info_plist') continue;
        const length = Number(s.readBigUInt64LE(sec + 40));
        const offset = s.readUInt32LE(sec + 48);
        if (offset + length > s.length) return null;
        return s.subarray(offset, offset + length);
      }
    }
    at += size;
  }
  return null;
}

/**
 * Throws unless every code directory of every slice is valid: the hash of each page of code is the
 * one it records, and each special slot it fills holds the hash of what that slot names (the
 * bundle's Info.plist, or else the binary's own embedded one, and its resource seal, the
 * requirements, the entitlements in both forms, and any launch constraints). A slot that names nothing must be empty. This is what the kernel checks when
 * the code runs; it does not verify a CMS signature (an identity's chain to Apple).
 */
export function assertSignatureValid(file: Buffer, sealed: SealedFiles, what: string): void {
  const all = slices(file);
  if (all === null) return refuse(`${what} is not a Mach-O this tool can read`);
  for (const slice of all) {
    const s = slice.bytes;
    const l = layout(s);
    if (l === null) return refuse(`${what} is not a Mach-O this tool can read`);
    if (l.signature === null) return refuse(`${what} is not signed`);
    const base = l.signature.dataoff;
    const end = base + l.signature.datasize;
    const be = (o: number): number => {
      if (o + 4 > end) return refuse(`${what}: a code signature runs past its end`);
      return s.readUInt32BE(o);
    };
    if (be(base) !== SUPERBLOB) return refuse(`${what}: a code signature without its superblob`);
    const count = be(base + 8);
    if (count > 64) return refuse(`${what}: a code signature with too many parts`);
    const blobs = new Map<number, Buffer>();
    const directories: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      const type = be(base + 12 + i * 8);
      const offset = base + be(base + 12 + i * 8 + 4);
      const length = be(offset + 4);
      if (length < 8 || offset + length > end)
        return refuse(`${what}: a code signature part runs past its end`);
      const blob = s.subarray(offset, offset + length);
      if (blobs.has(type)) return refuse(`${what}: a code signature names one slot twice`);
      blobs.set(type, blob);
      if (
        type === SLOT_CODEDIRECTORY ||
        (type >= SLOT_ALTERNATE_DIRECTORIES && type < SLOT_ALTERNATE_DIRECTORIES + 5)
      ) {
        if (blob.readUInt32BE(0) !== CODEDIRECTORY)
          return refuse(`${what}: a code directory slot holds something else`);
        directories.push(blob);
      }
    }
    if (directories.length === 0)
      return refuse(`${what}: a code signature without a code directory`);
    const expectMagic: Readonly<Record<number, number>> = {
      [SLOT_REQUIREMENTS]: REQUIREMENTS,
      [SLOT_ENTITLEMENTS]: ENTITLEMENTS_XML,
      [SLOT_DER_ENTITLEMENTS]: ENTITLEMENTS_DER,
      [SLOT_SIGNATURE]: CMS_WRAPPER,
      8: CONSTRAINT,
      9: CONSTRAINT,
      10: CONSTRAINT,
      11: CONSTRAINT,
    };
    for (const [type, magic] of Object.entries(expectMagic)) {
      const blob = blobs.get(Number(type));
      if (blob === undefined) continue;
      if (blob.readUInt32BE(0) !== magic)
        return refuse(`${what}: slot ${type} of the code signature holds something else`);
    }
    for (const cd of directories) {
      if (cd.length < 44) return refuse(`${what}: a code directory too short to be one`);
      const version = cd.readUInt32BE(8);
      const hashOffset = cd.readUInt32BE(16);
      const nSpecial = cd.readUInt32BE(24);
      const nCode = cd.readUInt32BE(28);
      const codeLimit = cd.readUInt32BE(32);
      const hashSize = cd[36] ?? 0;
      const type = HASH_TYPES[cd[37] ?? 0];
      const pageShift = cd[39] ?? 0;
      if (type?.size !== hashSize) return refuse(`${what}: a code directory with an unknown hash`);
      if (version >= 0x20100 && cd.length >= 48 && cd.readUInt32BE(44) !== 0)
        return refuse(
          `${what}: a code directory with scatter lists, which this tool does not read`,
        );
      if (version >= 0x20300 && cd.length >= 64 && cd.readBigUInt64BE(56) !== 0n)
        return refuse(`${what}: a code directory over 4 GiB, which this tool does not read`);
      if (nSpecial > SLOT_LAST_BLOB || hashOffset < 44 + nSpecial * hashSize)
        return refuse(`${what}: a code directory with special slots this tool does not know`);
      if (hashOffset + nCode * hashSize > cd.length)
        return refuse(`${what}: a code directory's hashes run past its end`);
      // The code is everything before the signature, page by page.
      if (codeLimit !== base)
        return refuse(`${what}: a code directory that does not cover the code`);
      const page = pageShift === 0 ? codeLimit : 2 ** pageShift;
      if (nCode !== Math.ceil(codeLimit / page))
        return refuse(`${what}: a code directory with the wrong number of pages`);
      for (let i = 0; i < nCode; i++) {
        const got = digestOf(
          type.algorithm,
          hashSize,
          s.subarray(i * page, Math.min((i + 1) * page, codeLimit)),
        );
        const want = cd.subarray(hashOffset + i * hashSize, hashOffset + (i + 1) * hashSize);
        if (!got.equals(want))
          return refuse(
            `${what}: page ${String(i)} of the code is not the one its signature hashes`,
          );
      }
      // Special slots, numbered down from the code hashes.
      for (let slot = 1; slot <= SLOT_LAST_BLOB; slot++) {
        const want =
          slot <= nSpecial
            ? cd.subarray(hashOffset - slot * hashSize, hashOffset - (slot - 1) * hashSize)
            : null;
        const filled = want?.some((b) => b !== 0) === true;
        const named =
          slot === SLOT_INFO
            ? (sealed.infoPlist ?? embeddedInfoPlist(s))
            : slot === SLOT_RESOURCES
              ? sealed.resources
              : slot === SLOT_APPLICATION || slot === SLOT_REP_SPECIFIC
                ? null
                : (blobs.get(slot) ?? null);
        if (!filled) {
          // A blob in the signature that its directory does not bind would be read unchecked.
          if (named !== null && slot !== SLOT_INFO && slot !== SLOT_RESOURCES)
            return refuse(`${what}: slot ${String(slot)} of the code signature is not bound`);
          continue;
        }
        if (named === null)
          return refuse(`${what}: special slot ${String(slot)} names something that is not there`);
        if (!digestOf(type.algorithm, hashSize, named).equals(want))
          return refuse(`${what}: special slot ${String(slot)} is not the hash of what it names`);
      }
    }
  }
}

// ---- a Windows binary's Authenticode digest -----------------------------------------------------

/**
 * The Authenticode digest of a PE file, as a code-integrity catalog names it: the headers less the
 * checksum and the certificate-table entry, then each section's raw data in file order, then any
 * data after the last section other than the certificate table. `null` if `file` is not a PE.
 */
export function peAuthenticodeDigest(file: Buffer, algorithm: 'sha1' | 'sha256'): string | null {
  if (file.length < 0x40 || file.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = file.readUInt32LE(0x3c);
  if (pe + 24 > file.length || file.readUInt32LE(pe) !== 0x00004550) return null;
  const sections = file.readUInt16LE(pe + 6);
  const optSize = file.readUInt16LE(pe + 20);
  const opt = pe + 24;
  if (opt + optSize > file.length || optSize < 2) return null;
  const magic = file.readUInt16LE(opt);
  const dirs = magic === 0x20b ? opt + 112 : magic === 0x10b ? opt + 96 : -1;
  if (dirs === -1 || opt + 64 > file.length) return null;
  const rvaCount = file.readUInt32LE(dirs - 4);
  const checksum = opt + 64;
  const certEntry = dirs + 4 * 8;
  if (rvaCount < 5 || certEntry + 8 > opt + optSize) return null;
  const sizeOfHeaders = file.readUInt32LE(opt + 60);
  const certAt = file.readUInt32LE(certEntry);
  const certSize = file.readUInt32LE(certEntry + 4);
  if (sizeOfHeaders > file.length || sizeOfHeaders < certEntry + 8) return null;
  if (certSize !== 0 && (certAt < sizeOfHeaders || certAt + certSize !== file.length)) return null;
  const end = certSize === 0 ? file.length : certAt;
  const h = createHash(algorithm);
  h.update(file.subarray(0, checksum));
  h.update(file.subarray(checksum + 4, certEntry));
  h.update(file.subarray(certEntry + 8, sizeOfHeaders));
  const table = opt + optSize;
  if (table + sections * 40 > file.length) return null;
  const raw: { at: number; size: number }[] = [];
  for (let i = 0; i < sections; i++) {
    const s = table + i * 40;
    const size = file.readUInt32LE(s + 16);
    const at = file.readUInt32LE(s + 20);
    if (size === 0) continue;
    if (at + size > end) return null;
    raw.push({ at, size });
  }
  raw.sort((x, y) => x.at - y.at);
  let hashed = sizeOfHeaders;
  for (const r of raw) {
    h.update(file.subarray(r.at, r.at + r.size));
    hashed = Math.max(hashed, r.at + r.size);
  }
  if (end > hashed) h.update(file.subarray(hashed, end));
  return h.digest('hex');
}
