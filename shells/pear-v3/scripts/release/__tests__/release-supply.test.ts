/**
 * Where a release comes from and what it may be: the zip reader, the CPU and code readers, the
 * GitHub provenance of a run, assembling five packages from one run, a signed package, and what a
 * signer checks before signing.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { APP, STAGED } from '../../../packaging/identity.ts';
import { releaseRoot } from '../../../packaging/update-root.ts';
import { encodeBakedRoot, parseTrustRoot } from '../../../src/update/root.ts';
import { deploymentPackageJson } from '../../pear-ci/deployment.ts';
import type { PearRecord } from '../../pear-ci/records.ts';
import {
  RELEASE_SCHEMA,
  artifactZip,
  assemblePackages,
  bundleDigestName,
  checkRelease,
  digestRelease,
  downloadRelease,
  inputName,
  readRelease,
  unpackAll,
  writeReleaseFile,
  type PackageRules,
  type ReleaseFile,
} from '../assemble.ts';
import {
  CS_ADHOC,
  CS_RUNTIME,
  assertShippableMacho,
  assertSignatureValid,
  elfArch,
  machoArches,
  machoCodeDigest,
  machoFormat,
  machoSignatures,
  parseEntitlementsDer,
  parseEntitlementsXml,
  peAuthenticodeDigest,
} from '../binary.ts';
import { digestOf } from '../digest.ts';
import { ReleaseRefusal } from '../guards.ts';
import { assertPackageArch, assertProductionRoot, packageFacts, readPackaged } from '../inspect.ts';
import {
  RELEASE_REPO,
  assertArtifactBytes,
  ghCommand,
  parseRunId,
  runArtifacts,
  verifyMainRun,
  type GitHubApi,
} from '../provenance.ts';
import {
  assertFetchedIsRequested,
  assertFork,
  assertRequestBinds,
  checkRequestInOneHome,
  compareDrive,
  type PearInOneHome,
} from '../signer.ts';
import {
  compareSigned,
  isBundleSignaturePath,
  isSignatureType,
  recordSigned,
  sealedFilesOf,
} from '../signing.ts';
import {
  expectedEntitlements,
  productionSigningPolicy,
  type SigningPolicy,
} from '../signing-policy.ts';
import { RELEASE_TARGETS, deploymentEntry, type ReleaseTarget } from '../targets.ts';
import { assertLinkInside, extractZip, readZipFile, readZipIndex } from '../zip.ts';
import {
  catalog,
  entitlementsDer,
  entitlementsXml,
  p7x,
  peFile,
  testCertificate,
} from './der-writer.ts';
import { zipOf, type ZipItem } from './zip-writer.ts';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'release-supply-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha = (x: string | Buffer): string => createHash('sha256').update(x).digest('hex');
const target = (name: string): ReleaseTarget => {
  const t = RELEASE_TARGETS.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no ${name}`);
  return t;
};
const zipFile = (items: readonly ZipItem[], o?: { zip64?: boolean }): string => {
  const f = join(tmp(), 'a.zip');
  writeFileSync(f, zipOf(items, o));
  return f;
};
const refused = (fn: () => unknown, re: RegExp): void => {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ReleaseRefusal);
  expect((err as Error).message).toMatch(re);
};
const refusedAsync = async (p: Promise<unknown>, re: RegExp): Promise<void> => {
  await expect(p).rejects.toBeInstanceOf(ReleaseRefusal);
  await expect(p).rejects.toThrow(re);
};
const mainFor = (upgrade: string | null): string => {
  const flag = String(upgrade !== null);
  return `x = { updates: ${flag} ? "on" : "off" };\nif (${flag}) await startUpdates();\n`;
};

// ---- the zip reader --------------------------------------------------------------------------

describe('the zip reader', () => {
  it.each([{ zip64: false }, { zip64: true }])('reads stored and deflated entries (%o)', (o) => {
    const f = zipFile(
      [
        { name: 'a/plain.txt', data: 'plain' },
        { name: 'a/packed.txt', data: 'packed '.repeat(100), deflate: true },
      ],
      o,
    );
    expect(readZipIndex(f).map((e) => e.name)).toEqual(['a/plain.txt', 'a/packed.txt']);
    expect(readZipFile(f, 'a/plain.txt').toString()).toBe('plain');
    expect(readZipFile(f, 'a/packed.txt').toString()).toBe('packed '.repeat(100));
    refused(() => readZipFile(f, 'a/none'), /holds no/);
  });

  it.each([
    ['a duplicate name', [{ name: 'a' }, { name: 'a' }], /duplicate/],
    ['a duplicate by case', [{ name: 'App.js' }, { name: 'app.js' }], /duplicate/],
    ['a duplicate by Unicode form', [{ name: 'caf\u00e9' }, { name: 'cafe\u0301' }], /duplicate/],
    [
      'a duplicate by full case folding',
      [{ name: 'Stra\u00dfe' }, { name: 'STRASSE' }],
      /duplicate/,
    ],
    ['a duplicate by final sigma', [{ name: '\u03c3' }, { name: '\u03c2' }], /duplicate/],
    ['a duplicate by the Kelvin sign', [{ name: '\u212a' }, { name: 'k' }], /duplicate/],
    [
      'an entry inside a symlink that only full folding names',
      [{ name: '\u03c2', data: 'x', mode: 0o120755 }, { name: '\u03a3/f' }],
      /inside a file or a symlink/,
    ],
    ['an absolute path', [{ name: '/etc/passwd' }], /unsafe/],
    ['a parent segment', [{ name: 'a/../../b' }], /unsafe/],
    ['a backslash', [{ name: 'a\\b' }], /unsafe/],
    ['a control character', [{ name: 'a\nb' }], /unsafe/],
    [
      'an entry inside a symlink',
      [{ name: 'l', data: 'x', mode: 0o120755 }, { name: 'l/f' }],
      /inside a file or a symlink/,
    ],
    [
      'an entry inside a symlink of another case',
      [{ name: 'Lib', data: 'x', mode: 0o120755 }, { name: 'lib/f' }],
      /inside a file or a symlink/,
    ],
    [
      'an entry inside a file',
      [{ name: 'f', data: 'x' }, { name: 'f/g' }],
      /inside a file or a symlink/,
    ],
    ['a local header with another name', [{ name: 'good', localName: 'evil' }], /local header/],
    ['encryption', [{ name: 'a', flags: 1 }], /encrypted/],
  ] as [string, ZipItem[], RegExp][])('refuses %s', (_n, items, re) => {
    refused(() => readZipIndex(zipFile(items)), re);
  });

  it('reads a zip64 whose end record puts 0xffff in the disk numbers, as MakeAppx writes it', () => {
    const z = zipOf([{ name: 'a', data: 'x' }], { zip64: true });
    const end = z.length - 22;
    z.writeUInt16LE(0xffff, end + 4);
    z.writeUInt16LE(0xffff, end + 6);
    const f = join(tmp(), 'a.zip');
    writeFileSync(f, z);
    expect(readZipFile(f, 'a').toString()).toBe('x');
  });

  it('refuses a zip on more than one disk', () => {
    const z = zipOf([{ name: 'a', data: 'x' }]);
    z.writeUInt16LE(1, z.length - 22 + 4);
    const f = join(tmp(), 'a.zip');
    writeFileSync(f, z);
    refused(() => readZipIndex(f), /multi-disk/);
  });

  it('refuses a wrong checksum when it reads', () => {
    refused(() => readZipFile(zipFile([{ name: 'a', data: 'x', badCrc: true }]), 'a'), /checksum/);
  });

  it('refuses what is not a zip', () => {
    const f = join(tmp(), 'x');
    writeFileSync(f, 'not a zip at all, and long enough to look for the end of one');
    refused(() => readZipIndex(f), /not a zip/);
  });

  it('refuses a central directory that is not where it says', () => {
    const f = join(tmp(), 'x');
    writeFileSync(f, Buffer.concat([Buffer.from('prefix'), zipOf([{ name: 'a', data: 'x' }])]));
    refused(() => readZipIndex(f), /not where it says/);
  });

  it('unpacks files, executable bits and symlinks', () => {
    const d = join(tmp(), 'out');
    const items: ZipItem[] = [
      { name: 'x.app/', mode: 0o040755 },
      { name: 'x.app/bin', data: 'exe', mode: 0o100755 },
      { name: 'x.app/doc', data: 'doc', mode: 0o100644, deflate: true },
    ];
    // Creating a symlink needs a privilege a Windows job may not hold; no package unpacks there.
    if (process.platform !== 'win32')
      items.push({ name: 'x.app/link', data: 'bin', mode: 0o120755 });
    extractZip(zipFile(items), d);
    expect(readFileSync(join(d, 'x.app', 'doc'), 'utf8')).toBe('doc');
    if (process.platform !== 'win32') {
      expect(lstatSync(join(d, 'x.app', 'bin')).mode & 0o100).toBe(0o100);
      expect(lstatSync(join(d, 'x.app', 'doc')).mode & 0o100).toBe(0);
      expect(readlinkSync(join(d, 'x.app', 'link'))).toBe('bin');
    }
  });

  it.each([
    ['an absolute target', '/etc/passwd', /absolute/],
    ['a target outside the tree', '../../outside', /outside the tree/],
  ])('refuses a symlink with %s', (_n, link, re) => {
    const d = join(tmp(), 'out');
    refused(() => {
      extractZip(zipFile([{ name: 'x/l', data: link, mode: 0o120755 }]), d);
    }, re);
  });

  it('keeps a link inside the tree', () => {
    expect(() => {
      assertLinkInside('a/b/l', '../c', 'x', new Map());
    }).not.toThrow();
    refused(() => {
      assertLinkInside('a/l', '../../c', 'x', new Map());
    }, /outside/);
  });

  it('resolves a link through the other links, as the file system does', () => {
    // `a/s -> ..` stays inside, and so does `L -> a/s/../..` read as text: on disk it climbs out.
    const climb: ZipItem[] = [
      { name: 'a/', mode: 0o040755 },
      { name: 'a/s', data: '..', mode: 0o120755 },
      { name: 'L', data: 'a/s/../..', mode: 0o120755 },
    ];
    refused(() => {
      extractZip(zipFile(climb), join(tmp(), 'out'));
    }, /L links outside the tree/);
    const loop: ZipItem[] = [
      { name: 'x', data: 'y', mode: 0o120755 },
      { name: 'y', data: 'x', mode: 0o120755 },
    ];
    refused(() => {
      extractZip(zipFile(loop), join(tmp(), 'out'));
    }, /a loop of links/);
    // A chain that stays inside is kept.
    const inside: ZipItem[] = [
      { name: 'a/', mode: 0o040755 },
      { name: 'a/f', data: 'file' },
      { name: 'b', data: 'a', mode: 0o120755 },
      { name: 'c', data: 'b/f', mode: 0o120755 },
    ];
    if (process.platform === 'win32') return;
    const d = join(tmp(), 'out');
    extractZip(zipFile(inside), d);
    expect(readFileSync(join(d, 'c'), 'utf8')).toBe('file');
    // And none is created before every link is checked.
    const d2 = join(tmp(), 'out');
    refused(() => {
      extractZip(zipFile([...inside, { name: 'z', data: 'c/../../..', mode: 0o120755 }]), d2);
    }, /outside the tree/);
    expect(existsSync(d2)).toBe(false);
  });
});

// ---- binaries --------------------------------------------------------------------------------

/** A small 64-bit Mach-O: __TEXT, __LINKEDIT, and a code signature of `sigSize` bytes, or none. */
function macho(
  o: { cpu?: number; sigSize?: number | null; code?: number; sig?: Buffer } = {},
): Buffer {
  const sigSize = o.sig !== undefined ? o.sig.length : o.sigSize === undefined ? 32 : o.sigSize;
  const segment = 72;
  const sizeofcmds = segment * 2 + (sigSize !== null ? 16 : 0);
  const textEnd = 0x200;
  const linkeditEnd = 0x240;
  const file = Buffer.alloc(linkeditEnd + (sigSize ?? 0));
  file.writeUInt32LE(0xfeedfacf, 0);
  file.writeUInt32LE(o.cpu ?? 0x0100000c, 4);
  file.writeUInt32LE(2, 12);
  file.writeUInt32LE(sigSize !== null ? 3 : 2, 16);
  file.writeUInt32LE(sizeofcmds, 20);
  const seg = (at: number, name: string, off: number, size: number): void => {
    file.writeUInt32LE(0x19, at);
    file.writeUInt32LE(segment, at + 4);
    file.write(name, at + 8, 'latin1');
    file.writeBigUInt64LE(BigInt(size), at + 32);
    file.writeBigUInt64LE(BigInt(off), at + 40);
    file.writeBigUInt64LE(BigInt(size), at + 48);
  };
  seg(32, '__TEXT', 0, textEnd);
  seg(32 + segment, '__LINKEDIT', textEnd, linkeditEnd - textEnd + (sigSize ?? 0));
  if (sigSize !== null) {
    const at = 32 + segment * 2;
    file.writeUInt32LE(0x1d, at);
    file.writeUInt32LE(16, at + 4);
    file.writeUInt32LE(linkeditEnd, at + 8);
    file.writeUInt32LE(sigSize, at + 12);
    if (o.sig === undefined) file.fill(0xab, linkeditEnd);
    else o.sig.copy(file, linkeditEnd);
  }
  file.fill(o.code ?? 0x11, 0x100, textEnd);
  file.fill(0x22, textEnd, linkeditEnd);
  return file;
}

const JIT = { 'com.apple.security.cs.allow-jit': true };
/** What an entitled binary carries while signatures are ad hoc: JIT, and library validation off. */
const AD_HOC = { ...JIT, 'com.apple.security.cs.disable-library-validation': true };

interface SigSpec {
  flags?: number;
  team?: string | null;
  entitlements?: Readonly<Record<string, boolean>> | null;
  der?: Readonly<Record<string, boolean>> | null;
  identity?: boolean;
  directories?: number;
}

/** What a code directory hashes, besides the code: the files a bundle's executable seals. */
interface Sealed {
  infoPlist?: Buffer;
  resources?: Buffer;
}

/** The fixture's code: 0x240 bytes before the signature, in pages of 256. */
const CODE_LIMIT = 0x240;
const PAGE_SHIFT = 8;
const N_CODE = Math.ceil(CODE_LIMIT / 2 ** PAGE_SHIFT);
const N_SPECIAL = 7;
const sha256 = (b: Buffer): Buffer => createHash('sha256').update(b).digest();

/**
 * A code signature as `codesign` lays it out: a superblob of code directories (slot 0, then
 * alternates), requirements (2), entitlements (5) and their DER form (7), and the CMS (0x10000).
 * Each directory hashes `code` page by page, and fills special slots 1 to 7 with the hashes of what
 * they name. With no `code`, the code hashes are zero: a draft, the right size.
 */
function sigBlob(o: SigSpec = {}, code?: Buffer, sealed: Sealed = {}): Buffer {
  const blob = (magic: number, body: Buffer): Buffer => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(magic, 0);
    h.writeUInt32BE(8 + body.length, 4);
    return Buffer.concat([h, body]);
  };
  const team = o.team === undefined ? null : o.team;
  const ents = o.entitlements === undefined ? AD_HOC : o.entitlements;
  const derEnts = o.der === undefined ? ents : o.der;
  const requirements = blob(0xfade0c01, Buffer.alloc(4));
  const xml = ents === null ? null : blob(0xfade7171, Buffer.from(entitlementsXml(ents)));
  const der = derEnts === null ? null : blob(0xfade7172, entitlementsDer(derEnts));
  const special = new Map<number, Buffer | null>([
    [1, sealed.infoPlist ?? null],
    [2, requirements],
    [3, sealed.resources ?? null],
    [5, xml],
    [7, der],
  ]);
  const directory = (): Buffer => {
    const ident = Buffer.from('nutflix\0');
    const teamBytes = team === null ? Buffer.alloc(0) : Buffer.from(`${team}\0`);
    const hashOffset = 52 + ident.length + teamBytes.length + N_SPECIAL * 32;
    // Version 0x20200: the fields up to the Team ID, the 52-byte header this lays out.
    const fixed = Buffer.alloc(52 - 8);
    fixed.writeUInt32BE(0x20200, 0);
    fixed.writeUInt32BE(o.flags ?? CS_ADHOC | CS_RUNTIME, 4);
    fixed.writeUInt32BE(hashOffset, 8);
    fixed.writeUInt32BE(52, 12);
    fixed.writeUInt32BE(N_SPECIAL, 16);
    fixed.writeUInt32BE(N_CODE, 20);
    fixed.writeUInt32BE(CODE_LIMIT, 24);
    fixed[28] = 32;
    fixed[29] = 2;
    fixed[31] = PAGE_SHIFT;
    fixed.writeUInt32BE(team === null ? 0 : 52 + ident.length, 40);
    const slots = Buffer.alloc(N_SPECIAL * 32);
    for (const [n, named] of special)
      if (named !== null) sha256(named).copy(slots, (N_SPECIAL - n) * 32);
    const pages = Buffer.alloc(N_CODE * 32);
    if (code !== undefined)
      for (let i = 0; i < N_CODE; i++)
        sha256(
          code.subarray(i * 2 ** PAGE_SHIFT, Math.min((i + 1) * 2 ** PAGE_SHIFT, CODE_LIMIT)),
        ).copy(pages, i * 32);
    return blob(0xfade0c02, Buffer.concat([fixed, ident, teamBytes, slots, pages]));
  };
  const parts: [number, Buffer][] = [];
  for (let i = 0; i < (o.directories ?? 1); i++)
    parts.push([i === 0 ? 0 : 0x1000 + i - 1, directory()]);
  parts.push([2, requirements]);
  if (xml !== null) parts.push([5, xml]);
  if (der !== null) parts.push([7, der]);
  parts.push([
    0x10000,
    blob(0xfade0b01, o.identity === true ? Buffer.alloc(40, 1) : Buffer.alloc(0)),
  ]);
  const head = Buffer.alloc(12 + parts.length * 8);
  head.writeUInt32BE(0xfade0cc0, 0);
  head.writeUInt32BE(head.length + parts.reduce((n, [, p]) => n + p.length, 0), 4);
  head.writeUInt32BE(parts.length, 8);
  let off = head.length;
  parts.forEach(([type, p], i) => {
    head.writeUInt32BE(type, 12 + i * 8);
    head.writeUInt32BE(off, 16 + i * 8);
    off += p.length;
  });
  return Buffer.concat([head, ...parts.map(([, p]) => p)]);
}

/** A Mach-O signed as `codesign` signs it: a valid signature saying what `o` says. */
function signedMacho(
  o: SigSpec & { code?: number; cpu?: number } = {},
  sealed: Sealed = {},
): Buffer {
  const file = macho({
    sig: sigBlob(o),
    ...(o.code === undefined ? {} : { code: o.code }),
    ...(o.cpu === undefined ? {} : { cpu: o.cpu }),
  });
  sigBlob(o, file.subarray(0, CODE_LIMIT), sealed).copy(file, CODE_LIMIT);
  return file;
}

/** What the runbook's ad-hoc signature of the main executable says (its bytes; not valid). */
const goodSig = (): Buffer => sigBlob();

function elfHeader(machine: number): Buffer {
  const h = Buffer.alloc(64);
  h.write('\x7fELF', 0, 'latin1');
  h[4] = 2;
  h[5] = 1;
  h.writeUInt16LE(machine, 18);
  return h;
}

describe('reading a binary', () => {
  it('names the CPU of an ELF', () => {
    const f = join(tmp(), 'e');
    writeFileSync(f, elfHeader(62));
    expect(elfArch(f)).toBe('x64');
    writeFileSync(f, elfHeader(183));
    expect(elfArch(f)).toBe('arm64');
    writeFileSync(f, 'nope');
    expect(elfArch(f)).toBeNull();
  });

  it('names the CPUs of a Mach-O, thin or universal', () => {
    const f = join(tmp(), 'm');
    writeFileSync(f, macho({ cpu: 0x01000007 }));
    expect(machoArches(f)).toEqual(['x64']);
    const fat = Buffer.alloc(8 + 40);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(2, 4);
    fat.writeUInt32BE(0x01000007, 8);
    fat.writeUInt32BE(0x0100000c, 28);
    writeFileSync(f, fat);
    expect(machoArches(f)).toEqual(['x64', 'arm64']);
    writeFileSync(f, 'not one, and long enough');
    expect(machoArches(f)).toBeNull();
  });

  it('a new signature does not change the code digest', () => {
    const base = machoCodeDigest(macho());
    expect(base).not.toBeNull();
    expect(machoCodeDigest(macho({ sigSize: 96 }))).toBe(base);
    expect(machoCodeDigest(macho({ sigSize: null }))).toBe(base);
  });

  it('a changed byte of code does', () => {
    expect(machoCodeDigest(macho({ code: 0x12 }))).not.toBe(machoCodeDigest(macho()));
    expect(machoCodeDigest(macho({ cpu: 0x01000007 }))).not.toBe(machoCodeDigest(macho()));
  });

  it('a signature may not start inside what the load commands point at', () => {
    // A string table that runs to the end of __LINKEDIT, and a signature written over its tail.
    const f = macho({ sigSize: null });
    const withSymtab = (sigAt: number | null): Buffer => {
      const b = Buffer.alloc(f.length + 64);
      f.copy(b);
      const cmds = b.readUInt32LE(20);
      const at = 32 + cmds;
      b.writeUInt32LE(0x02, at);
      b.writeUInt32LE(24, at + 4);
      b.writeUInt32LE(0x200, at + 16);
      b.writeUInt32LE(0x40, at + 20);
      let n = 3;
      let size = cmds + 24;
      if (sigAt !== null) {
        b.writeUInt32LE(0x1d, at + 24);
        b.writeUInt32LE(16, at + 28);
        b.writeUInt32LE(sigAt, at + 32);
        b.writeUInt32LE(32, at + 36);
        n = 4;
        size += 16;
      }
      b.writeUInt32LE(n, 16);
      b.writeUInt32LE(size, 20);
      return b;
    };
    expect(machoCodeDigest(withSymtab(0x240))).not.toBeNull();
    expect(machoCodeDigest(withSymtab(0x238))).toBeNull();
  });

  describe('what a signature says', () => {
    const read = (sig: Buffer) => machoSignatures(macho({ sig }))?.[0]?.signature;

    it('reads the flags, the Team ID and the entitlements', () => {
      expect(read(goodSig())).toEqual({
        flags: CS_ADHOC | CS_RUNTIME,
        teamId: null,
        identity: false,
        entitlements: new Map(Object.entries(AD_HOC)),
      });
      const team = read(sigBlob({ flags: CS_RUNTIME, team: 'ABCDE12345', identity: true }));
      expect(team?.teamId).toBe('ABCDE12345');
      expect(team?.identity).toBe(true);
      expect(machoSignatures(macho({ sigSize: null }))?.[0]?.signature).toBeNull();
    });

    it('refuses copies of the entitlements that disagree, and directories that do', () => {
      refused(
        () => read(sigBlob({ der: { ...JIT, 'com.apple.security.get-task-allow': true } })),
        /disagree/,
      );
      const two = sigBlob({ directories: 2 });
      // The second directory's flags, at its own offset, without the runtime flag.
      const second = two.readUInt32BE(12 + 8 + 4);
      two.writeUInt32BE(CS_ADHOC, second + 12);
      refused(() => read(two), /two code directories disagree/);
    });

    it('refuses a second copy of the entitlements', () => {
      const one = sigBlob();
      // Parts: directory, requirements, XML, DER, CMS. Point the DER entry at the XML blob.
      const twice = Buffer.from(one);
      twice.writeUInt32BE(twice.readUInt32BE(16 + 2 * 8), 16 + 3 * 8);
      refused(() => read(twice), /holds a part twice/);
    });

    it('refuses what is not a signature, and entitlements that are not booleans', () => {
      refused(() => read(Buffer.alloc(32, 0xab)), /superblob/);
      refused(
        () =>
          parseEntitlementsXml(
            '<plist version="1.0"><dict><key>a</key><string>b</string></dict></plist>',
          ),
        /booleans/,
      );
      refused(() => parseEntitlementsDer(Buffer.from([0x30, 0])), /not one/);
    });

    it('each entitlements file is the one the policy pins, ad hoc and with a Team ID', () => {
      const file = (name: string): string =>
        readFileSync(new URL(`../../../packaging/${name}`, import.meta.url), 'utf8');
      const team: SigningPolicy = {
        label: 't',
        appleTeamId: 'ABCDE12345',
        allowAdHocMacosRelease: false,
        windowsSigner: null,
      };
      const adHoc = expectedEntitlements('Contents/MacOS/Nutflix');
      expect(parseEntitlementsXml(file('entitlements.mac.adhoc.plist'))).toEqual(adHoc);
      expect(parseEntitlementsXml(file('entitlements.mac.plist'))).toEqual(
        expectedEntitlements('Contents/MacOS/Nutflix', team),
      );
      expect(adHoc.get('com.apple.security.cs.disable-library-validation')).toBe(true);
      // With a Team ID, library validation stays on.
      expect(expectedEntitlements('Contents/MacOS/Nutflix', team).size).toBe(1);
      expect(expectedEntitlements('Contents/Resources/app/node_modules/x/y.node').size).toBe(0);
    });
  });

  describe('every kind of Mach-O', () => {
    /** A universal Mach-O with 64-bit offsets (`fat_arch_64`), of one slice. */
    const fat64 = (slice: Buffer, cpu = 0x0100000c): Buffer => {
      const out = Buffer.alloc(0x1000 + slice.length);
      out.writeUInt32BE(0xcafebabf, 0);
      out.writeUInt32BE(1, 4);
      out.writeUInt32BE(cpu, 8);
      out.writeBigUInt64BE(0x1000n, 16);
      out.writeBigUInt64BE(BigInt(slice.length), 24);
      out.writeUInt32BE(12, 32);
      slice.copy(out, 0x1000);
      return out;
    };
    const magic = (bytes: number[]): Buffer =>
      Buffer.concat([Buffer.from(bytes), Buffer.alloc(56)]);

    it('names each magic', () => {
      expect(machoFormat(macho())).toBe('thin64');
      expect(machoFormat(Buffer.from('cafebabe00000002', 'hex'))).toBe('fat');
      expect(machoFormat(fat64(macho()))).toBe('fat64');
      expect(machoFormat(magic([0xce, 0xfa, 0xed, 0xfe]))).toBe('thin32');
      expect(machoFormat(magic([0xfe, 0xed, 0xfa, 0xce]))).toBe('thin32');
      expect(machoFormat(magic([0xfe, 0xed, 0xfa, 0xcf]))).toBe('big-endian64');
      // A Java class file, which shares FAT_MAGIC's first four bytes.
      expect(machoFormat(Buffer.from('cafebabe00000034', 'hex'))).toBeNull();
      expect(machoFormat(Buffer.from('not a binary'))).toBeNull();
    });

    it('reads a fat-64 universal Mach-O like a fat one', () => {
      const f = join(tmp(), 'u');
      writeFileSync(f, fat64(macho()));
      expect(machoArches(f)).toEqual(['arm64']);
      expect(machoCodeDigest(fat64(macho()))).not.toBeNull();
      expect(machoCodeDigest(fat64(macho({ code: 0x12 })))).not.toBe(
        machoCodeDigest(fat64(macho())),
      );
      expect(() => {
        assertSignatureValid(fat64(signedMacho()), { infoPlist: null, resources: null }, 'x');
      }).not.toThrow();
      expect(() => {
        assertShippableMacho(fat64(macho()), 'x');
      }).not.toThrow();
    });

    it('refuses a 32-bit or big-endian Mach-O outright', () => {
      for (const bytes of [
        [0xce, 0xfa, 0xed, 0xfe],
        [0xfe, 0xed, 0xfa, 0xce],
      ])
        refused(() => {
          assertShippableMacho(magic(bytes), 'x');
        }, /x is a 32-bit Mach-O: macOS has not run 32-bit code since 10\.15/);
      refused(() => {
        assertShippableMacho(magic([0xfe, 0xed, 0xfa, 0xcf]), 'x');
      }, /big-endian/);
      // A universal one with a 32-bit slice.
      const slice32 = Buffer.alloc(64);
      slice32.writeUInt32LE(0xfeedface, 0);
      refused(() => {
        assertShippableMacho(fat64(slice32, 7), 'x');
      }, /a slice that is not 64-bit/);
    });
  });

  describe('whether a signature is valid', () => {
    const SEAL = Buffer.from('the resource seal');
    const none = { infoPlist: null, resources: null };
    /** The first code directory's offset in the file, and its hash offset. */
    const cd = (f: Buffer): { at: number; hashes: number } => {
      const at = CODE_LIMIT + f.readUInt32BE(CODE_LIMIT + 16);
      return { at, hashes: at + f.readUInt32BE(at + 16) };
    };

    it('takes one whose pages and special slots hash what they name', () => {
      expect(() => {
        assertSignatureValid(signedMacho(), none, 'x');
      }).not.toThrow();
      expect(() => {
        assertSignatureValid(
          signedMacho({ directories: 2 }, { resources: SEAL }),
          { infoPlist: null, resources: SEAL },
          'x',
        );
      }).not.toThrow();
    });

    it('refuses a page whose hash is not the code’s', () => {
      const f = signedMacho();
      const { hashes } = cd(f);
      f[hashes + 32] = (f[hashes + 32] ?? 0) ^ 1;
      refused(() => {
        assertSignatureValid(f, none, 'x');
      }, /x: page 1 of the code is not the one its signature hashes/);
    });

    it('refuses a special slot that is not the hash of what it names', () => {
      refused(() => {
        assertSignatureValid(
          signedMacho({}, { resources: SEAL }),
          { infoPlist: null, resources: Buffer.from('another seal') },
          'x',
        );
      }, /special slot 3 is not the hash of what it names/);
      refused(() => {
        assertSignatureValid(signedMacho({}, { infoPlist: Buffer.from('<plist/>') }), none, 'x');
      }, /special slot 1 names something that is not there/);
      const f = signedMacho();
      const { hashes } = cd(f);
      f[hashes - 5 * 32] = (f[hashes - 5 * 32] ?? 0) ^ 1;
      refused(() => {
        assertSignatureValid(f, none, 'x');
      }, /special slot 5 is not the hash of what it names/);
    });

    it('refuses entitlements their directory does not bind', () => {
      const f = signedMacho();
      const { hashes } = cd(f);
      f.fill(0, hashes - 5 * 32, hashes - 4 * 32);
      refused(() => {
        assertSignatureValid(f, none, 'x');
      }, /slot 5 of the code signature is not bound/);
    });

    it('refuses a directory that does not cover the code up to the signature', () => {
      const f = signedMacho();
      f.writeUInt32BE(CODE_LIMIT - 16, cd(f).at + 32);
      refused(() => {
        assertSignatureValid(f, none, 'x');
      }, /does not cover the code/);
    });

    it('refuses an unsigned binary', () => {
      refused(() => {
        assertSignatureValid(macho({ sigSize: null }), none, 'x');
      }, /x is not signed/);
    });
  });

  describe('a Windows binary’s Authenticode digest', () => {
    it('leaves out the checksum, and nothing else', () => {
      const base = peAuthenticodeDigest(peFile(), 'sha256');
      expect(base).toMatch(/^[0-9a-f]{64}$/);
      expect(peAuthenticodeDigest(peFile(0x90, 1234), 'sha256')).toBe(base);
      expect(peAuthenticodeDigest(peFile(0x91), 'sha256')).not.toBe(base);
      expect(peAuthenticodeDigest(peFile(), 'sha1')).toMatch(/^[0-9a-f]{40}$/);
      expect(
        peAuthenticodeDigest(Buffer.from('not a binary at all, but long enough to look'), 'sha256'),
      ).toBeNull();
    });
  });

  it('a file that is not a Mach-O has no code digest', () => {
    expect(
      machoCodeDigest(Buffer.from('plain text, long enough to read a header from it')),
    ).toBeNull();
  });

  it('refuses a package for the other CPU', () => {
    const app = join(tmp(), 'Nutflix.app');
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(app, 'Contents', 'MacOS', APP.productName), macho({ cpu: 0x01000007 }));
    expect(() => {
      assertPackageArch(app, 'x64');
    }).not.toThrow();
    refused(() => {
      assertPackageArch(app, 'arm64');
    }, /built for x64, not arm64/);
    const image = join(tmp(), 'Nutflix.AppImage');
    writeFileSync(image, elfHeader(183));
    refused(() => {
      assertPackageArch(image, 'x64');
    }, /built for arm64, not x64/);
  });
});

// ---- provenance ------------------------------------------------------------------------------

const RUN = 4242;
const COMMIT = 'ab'.repeat(20);
const WORKFLOW_ID = 77;

function goodRun(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN,
    path: '.github/workflows/ci.yml',
    workflow_id: WORKFLOW_ID,
    event: 'push',
    head_branch: 'main',
    head_sha: COMMIT,
    status: 'completed',
    conclusion: 'success',
    repository: { full_name: RELEASE_REPO },
    head_repository: { full_name: RELEASE_REPO },
    ...over,
  };
}

interface ApiArtifact {
  id: number;
  name: string;
  digest: string | null;
  expired: boolean;
  workflow_run: { id: number; head_sha: string };
}

const apiArtifact = (id: number, name: string, bytes: Buffer): ApiArtifact => ({
  id,
  name,
  digest: `sha256:${sha(bytes)}`,
  expired: false,
  workflow_run: { id: RUN, head_sha: COMMIT },
});

function fakeApi(
  run: Record<string, unknown>,
  artifacts: readonly ApiArtifact[] = [],
  bytes: ReadonlyMap<number, Buffer> = new Map(),
  history: { tags?: unknown[]; compare?: Record<string, unknown> } = {},
): GitHubApi {
  return {
    get: (path) => {
      if (path === `repos/${RELEASE_REPO}/git/matching-refs/tags/main`)
        return Promise.resolve(history.tags ?? []);
      if (path === `repos/${RELEASE_REPO}/compare/main...${COMMIT}`)
        return Promise.resolve(history.compare ?? { status: 'behind', ahead_by: 0 });
      if (path.endsWith('/actions/workflows/ci.yml'))
        return Promise.resolve({ id: WORKFLOW_ID, path: '.github/workflows/ci.yml' });
      if (path.includes('/artifacts?')) return Promise.resolve({ artifacts });
      if (path.includes('/actions/runs/')) return Promise.resolve(run);
      return Promise.reject(new Error(`unexpected ${path}`));
    },
    download: (path, file) => {
      const id = Number(/artifacts\/(\d+)\/zip/.exec(path)?.[1]);
      const b = bytes.get(id);
      if (b === undefined) return Promise.reject(new Error('no such artifact'));
      writeFileSync(file, b);
      return Promise.resolve();
    },
  };
}

describe('where a release comes from', () => {
  it('accepts a successful ci.yml run of a push to main at this commit', async () => {
    await expect(verifyMainRun(fakeApi(goodRun()), RUN, COMMIT)).resolves.toBeUndefined();
  });

  it.each([
    ['a pull request', { event: 'pull_request' }, /triggered by "pull_request"/],
    ['another branch', { head_branch: 'feature' }, /not main/],
    ['another commit', { head_sha: 'cd'.repeat(20) }, /it built/],
    ['a run still going', { status: 'in_progress', conclusion: null }, /has not completed/],
    ['a failed run', { conclusion: 'failure' }, /did not succeed/],
    ['another workflow file', { path: '.github/workflows/evil.yml' }, /its workflow is/],
    ['another workflow with that path', { workflow_id: 78 }, /not this repository/],
    ['another repository', { repository: { full_name: 'x/y' } }, /not in this repository/],
    ['a fork', { head_repository: { full_name: 'x/nutflix-runtime' } }, /from a fork/],
    ['another run', { id: 1 }, /another run/],
  ])('refuses %s', async (_n, over, re) => {
    await refusedAsync(verifyMainRun(fakeApi(goodRun(over)), RUN, COMMIT), re);
  });

  it('requires the commit to be in main’s history', async () => {
    for (const status of ['identical', 'behind'])
      await expect(
        verifyMainRun(
          fakeApi(goodRun(), [], new Map(), { compare: { status, ahead_by: 0 } }),
          RUN,
          COMMIT,
        ),
      ).resolves.toBeUndefined();
    for (const compare of [
      { status: 'ahead', ahead_by: 1 },
      { status: 'diverged', ahead_by: 2 },
      { status: 'behind', ahead_by: 1 },
    ])
      await refusedAsync(
        verifyMainRun(fakeApi(goodRun(), [], new Map(), { compare }), RUN, COMMIT),
        /is not in main's history/,
      );
  });

  it('refuses while a tag named main exists: its runs report main as their branch', async () => {
    await refusedAsync(
      verifyMainRun(
        fakeApi(goodRun(), [], new Map(), { tags: [{ ref: 'refs/tags/main' }] }),
        RUN,
        COMMIT,
      ),
      /a tag named main exists/,
    );
    await expect(
      verifyMainRun(
        fakeApi(goodRun(), [], new Map(), { tags: [{ ref: 'refs/tags/main-old' }] }),
        RUN,
        COMMIT,
      ),
    ).resolves.toBeUndefined();
  });

  it('asks github.com, whatever GH_HOST says, and gives a token to gh alone', () => {
    const base = { GH_HOST: 'evil.example', GITHUB_TOKEN: 'other', PATH: '/bin' };
    const plain = ghCommand('repos/x', undefined, base);
    expect(plain.args).toEqual(['api', '--hostname', 'github.com', '--method', 'GET', 'repos/x']);
    expect(plain.env['GH_HOST']).toBeUndefined();
    expect(plain.env['GH_TOKEN']).toBeUndefined();
    const given = ghCommand('repos/x', 'job-token', base);
    expect(given.env['GH_TOKEN']).toBe('job-token');
    expect(given.env['GITHUB_TOKEN']).toBeUndefined();
    expect(given.env['PATH']).toBe('/bin');
  });

  it('refuses when GitHub cannot be reached: there is no offline path', async () => {
    const down: GitHubApi = {
      get: () => Promise.reject(new Error('network down')),
      download: () => Promise.reject(new Error('network down')),
    };
    await refusedAsync(verifyMainRun(down, RUN, COMMIT), /could not be reached/);
    await refusedAsync(downloadRelease(down, RUN, COMMIT, tmp()), /could not be reached/);
  });

  it('takes only a run id and a full commit', async () => {
    expect(parseRunId('123')).toBe(123);
    for (const bad of [undefined, '', 'abc', '-1', '1e3', '0'])
      refused(() => parseRunId(bad), /run id/);
    await refusedAsync(verifyMainRun(fakeApi(goodRun()), RUN, 'abc123'), /40-hex/);
  });

  describe('its artifacts', () => {
    const names = ['release-a', 'release-b'];
    const a = apiArtifact(1, 'release-a', Buffer.from('aaa'));
    const b = apiArtifact(2, 'release-b', Buffer.from('bbb'));

    it('lists each with GitHub’s digest', async () => {
      const m = await runArtifacts(fakeApi(goodRun(), [a, b]), RUN, COMMIT, names);
      expect(m.get('release-a')?.sha256).toBe(sha('aaa'));
    });

    it.each([
      ['a missing one', [a], /0 artifacts named release-b/],
      ['two of one name', [a, b, { ...b, id: 3 }], /2 artifacts named release-b/],
      [
        'one of another run',
        [a, { ...b, workflow_run: { id: 9, head_sha: COMMIT } }],
        /does not belong/,
      ],
      [
        'one of another commit',
        [a, { ...b, workflow_run: { id: RUN, head_sha: 'c'.repeat(40) } }],
        /does not belong/,
      ],
      ['an expired one', [a, { ...b, expired: true }], /expired/],
      ['one with no digest', [a, { ...b, digest: null }], /no digest/],
    ] as [string, ApiArtifact[], RegExp][])('refuses %s', async (_n, list, re) => {
      await refusedAsync(runArtifacts(fakeApi(goodRun(), list), RUN, COMMIT, names), re);
    });

    it('refuses bytes that are not the artifact GitHub holds', async () => {
      const f = join(tmp(), 'x.zip');
      writeFileSync(f, 'aaa');
      const m = await runArtifacts(fakeApi(goodRun(), [a, b]), RUN, COMMIT, names);
      const listed = m.get('release-a');
      if (listed === undefined) throw new Error('no artifact');
      await expect(assertArtifactBytes(f, listed)).resolves.toBeUndefined();
      writeFileSync(f, 'bbb');
      await refusedAsync(assertArtifactBytes(f, listed), /is not release-a of this run/);
    });
  });
});

// ---- five packages from one run ----------------------------------------------------------------

/** One artifact's zip: a macOS bundle in a zip with its digest, or the package itself. */
/** An artifact zip keeps the folders it was uploaded from; the package is found wherever it is. */
async function artifactBytes(
  t: ReleaseTarget,
  content: string,
  over: { digest?: string } = {},
): Promise<Buffer> {
  if (t.platform !== 'darwin')
    return zipOf([{ name: `make/${t.arch}/${inputName(t)}`, data: `${t.name} ${content}` }]);
  const items: readonly ZipItem[] = [
    { name: `${t.file}/`, mode: 0o040755 },
    { name: `${t.file}/Contents/`, mode: 0o040755 },
    { name: `${t.file}/Contents/MacOS/`, mode: 0o040755 },
    {
      name: `${t.file}/Contents/MacOS/${APP.productName}`,
      data: `${t.name} ${content}`,
      mode: 0o100755,
    },
  ];
  const unpacked = join(tmp(), 'b');
  extractZip(zipFile(items), unpacked);
  const digest = over.digest ?? (await digestOf(join(unpacked, t.file)));
  return zipOf([
    { name: inputName(t), data: zipOf(items) },
    { name: bundleDigestName(t), data: `${digest}\n` },
  ]);
}

const rulesFor = (
  over: Partial<PackageRules> & {
    facts?: (p: string) => { version?: string; commit?: string | null };
  } = {},
): PackageRules => ({
  commit: COMMIT,
  assertRoot: () => undefined,
  assertArch: () => undefined,
  factsOf: (p) => ({
    version: '1.2.3',
    commit: COMMIT,
    root: releaseRoot(),
    ...(over.facts?.(p) ?? {}),
  }),
  ...(over.assertRoot === undefined ? {} : { assertRoot: over.assertRoot }),
});

async function writeFive(override: Partial<Record<string, Buffer>> = {}): Promise<string> {
  const d = tmp();
  for (const t of RELEASE_TARGETS)
    writeFileSync(
      artifactZip(d, 'release', t),
      override[t.name] ?? (await artifactBytes(t, 'bytes')),
    );
  return d;
}

/** The deployment `pear build` would make, as copies of what `release.json` records. */
function deployFrom(out: string, release: ReleaseFile): void {
  for (const t of RELEASE_TARGETS) {
    const row = release.targets.find((x) => x.target === t.name);
    const entry = join(out, 'deployment', ...deploymentEntry(t).split('/'));
    mkdirSync(dirname(entry), { recursive: true });
    cpSync(row?.app ?? '', entry, { recursive: true, verbatimSymlinks: true });
  }
}

describe('five packages from one run', () => {
  it('unpacks and records each, and what is read is what is on disk', async () => {
    const d = await writeFive();
    const { version, packages } = await unpackAll(d, 'release', join(tmp(), 'u'), rulesFor());
    expect(version).toBe('1.2.3');
    expect(packages).toHaveLength(5);
    for (const p of packages) expect(await digestOf(p.app)).toBe(p.digest);
  });

  it('refuses a missing artifact, and says which', async () => {
    const d = await writeFive();
    rmSync(artifactZip(d, 'release', target('win32-x64')));
    await refusedAsync(
      unpackAll(d, 'release', join(tmp(), 'u'), rulesFor()),
      /missing: release-win32-x64/,
    );
  });

  it('refuses a package from another commit', async () => {
    const d = await writeFive();
    await refusedAsync(
      unpackAll(
        d,
        'release',
        join(tmp(), 'u'),
        rulesFor({ facts: (p) => (p.endsWith('.msix') ? { commit: 'cd'.repeat(20) } : {}) }),
      ),
      /was built from/,
    );
  });

  it('refuses a package with no commit in it', async () => {
    const d = await writeFive();
    await refusedAsync(
      unpackAll(d, 'release', join(tmp(), 'u'), rulesFor({ facts: () => ({ commit: null }) })),
      /was built from null/,
    );
  });

  it('refuses a mix of versions', async () => {
    const d = await writeFive();
    await refusedAsync(
      unpackAll(
        d,
        'release',
        join(tmp(), 'u'),
        rulesFor({ facts: (p) => (p.endsWith('.msix') ? { version: '1.2.4' } : {}) }),
      ),
      /not one version/,
    );
  });

  it('checks the root on the unpacked package', async () => {
    const d = await writeFive();
    const seen: string[] = [];
    await refusedAsync(
      unpackAll(
        d,
        'release',
        join(tmp(), 'u'),
        rulesFor({
          assertRoot: (p) => {
            seen.push(p);
            expect(existsSync(p)).toBe(true);
            throw new ReleaseRefusal('wrong root');
          },
        }),
      ),
      /wrong root/,
    );
    expect(seen[0]).toMatch(/Nutflix\.(AppImage|app|msix)$/);
  });

  it('refuses an artifact that holds two packages', async () => {
    const t = target('linux-x64');
    const two = zipOf([
      { name: `a/${inputName(t)}`, data: 'one' },
      { name: `b/${inputName(t)}`, data: 'two' },
    ]);
    const d = await writeFive({ [t.name]: two });
    await refusedAsync(
      unpackAll(d, 'release', join(tmp(), 'u'), rulesFor()),
      /holds 2 files named Nutflix\.AppImage, not one/,
    );
  });

  it('refuses a bundle that is not the tree the Mac runner zipped', async () => {
    const t = target('darwin-arm64');
    const d = await writeFive({
      [t.name]: await artifactBytes(t, 'bytes', { digest: '0'.repeat(64) }),
    });
    await refusedAsync(
      unpackAll(d, 'release', join(tmp(), 'u'), rulesFor()),
      /the Mac runner packed/,
    );
  });

  it('refuses a bundle zip with a duplicate entry', async () => {
    const t = target('darwin-arm64');
    const exe = `${t.file}/Contents/MacOS/${APP.productName}`;
    const dup = zipOf([
      {
        name: inputName(t),
        data: zipOf([
          { name: exe, data: 'a' },
          { name: exe, data: 'b' },
        ]),
      },
      { name: bundleDigestName(t), data: `${'0'.repeat(64)}\n` },
    ]);
    const d = await writeFive({ [t.name]: dup });
    await refusedAsync(unpackAll(d, 'release', join(tmp(), 'u'), rulesFor()), /duplicate/);
  });

  it('checks a whole release against GitHub, then the packages', async () => {
    const d = await writeFive();
    const bytes = new Map<number, Buffer>();
    const list = RELEASE_TARGETS.map((t, i) => {
      const b = readFileSync(artifactZip(d, 'release', t));
      bytes.set(i + 1, b);
      return apiArtifact(i + 1, `release-${t.name}`, b);
    });
    const r = await checkRelease(fakeApi(goodRun(), list, bytes), RUN, COMMIT, d, rulesFor());
    expect(r.packages).toHaveLength(5);

    // A package from another run in this folder: GitHub's digest for this run is not its digest.
    writeFileSync(
      artifactZip(d, 'release', target('linux-x64')),
      await artifactBytes(target('linux-x64'), 'other run'),
    );
    await refusedAsync(
      checkRelease(fakeApi(goodRun(), list, bytes), RUN, COMMIT, d, rulesFor()),
      /is not release-linux-x64 of this run/,
    );
  });

  it('a pull request’s run gets no further than GitHub', async () => {
    const d = await writeFive();
    await refusedAsync(
      checkRelease(fakeApi(goodRun({ event: 'pull_request' })), RUN, COMMIT, d, rulesFor()),
      /triggered by "pull_request"/,
    );
  });

  describe('assembled', () => {
    it('digest compares with the record, not with files that can change later', async () => {
      const d = await writeFive();
      const out = join(tmp(), 'rel');
      const release = await assemblePackages(d, 'release', out, RUN, rulesFor());
      expect(release.commit).toBe(COMMIT);
      deployFrom(out, release);
      expect((await digestRelease(out)).commit).toBe(COMMIT);

      // The package is changed after it was checked, and the deployment with it.
      const linux = release.targets.find((x) => x.target === 'linux-x64');
      writeFileSync(linux?.app ?? '', 'changed after the check');
      const entry = join(out, 'deployment', ...deploymentEntry(target('linux-x64')).split('/'));
      writeFileSync(entry, 'changed after the check');
      await refusedAsync(digestRelease(out), /not the package/);
    });

    it('a notice-file that is not the deployment’s entry is refused', async () => {
      const d = await writeFive();
      const out = join(tmp(), 'rel');
      const release = await assemblePackages(d, 'release', out, RUN, rulesFor());
      deployFrom(out, release);
      writeFileSync(join(out, 'notice-files', target('linux-x64').noticeName), 'something else');
      await refusedAsync(digestRelease(out), /notice-files/);
    });

    it('will not assemble over an earlier release', async () => {
      const d = await writeFive();
      const out = join(tmp(), 'rel');
      await assemblePackages(d, 'release', out, RUN, rulesFor());
      await refusedAsync(assemblePackages(d, 'release', out, RUN, rulesFor()), /already holds/);
    });
  });
});

// ---- signing -----------------------------------------------------------------------------------

/**
 * A bundle with a Mach-O, a script and (where symlinks can be made) a symlink. `sig` is the main
 * executable's signature: a real one, a placeholder of that many bytes, or none.
 */
function bundle(dir: string, sig: SigSpec | number | null = 32, sealed: Sealed = {}): void {
  mkdirSync(join(dir, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(dir, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(
    join(dir, 'Contents', 'MacOS', APP.productName),
    sig === null || typeof sig === 'number' ? macho({ sigSize: sig }) : signedMacho(sig, sealed),
  );
  chmodSync(join(dir, 'Contents', 'MacOS', APP.productName), 0o755);
  writeFileSync(join(dir, 'Contents', 'Resources', 'main.js'), 'script');
  chmodSync(join(dir, 'Contents', 'Resources', 'main.js'), 0o644);
  if (process.platform !== 'win32') symlinkSync('MacOS/Nutflix', join(dir, 'Contents', 'current'));
}

/** A bundle `packageFacts` can read. `kind` changes its signature, not its code. */
function readableApp(path: string, kind: 'unsigned' | 'signed'): void {
  const res = join(path, 'Contents', 'Resources', 'app');
  mkdirSync(join(res, 'main'), { recursive: true });
  mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true });
  const exe = join(path, 'Contents', 'MacOS', APP.productName);
  writeFileSync(exe, kind === 'signed' ? signedMacho() : macho({ sigSize: 32 }));
  chmodSync(exe, 0o755);
  const root = releaseRoot();
  writeFileSync(join(res, 'package.json'), JSON.stringify({ version: '1.2.3', commit: COMMIT }));
  writeFileSync(join(res, ...STAGED.updateWorker.split('/')), `x="${encodeBakedRoot(root)}";`);
  writeFileSync(join(res, ...STAGED.main.split('/')), mainFor(root.upgrade));
  for (const f of [STAGED.updateWorker, STAGED.main, 'package.json'])
    chmodSync(join(res, ...f.split('/')), 0o644);
}

describe('a signed package', () => {
  const mac = target('darwin-arm64');
  const win = target('win32-x64');

  describe('a macOS bundle', () => {
    const SEAL = Buffer.from('seal');
    const pair = (sig: SigSpec = {}): { unsigned: string; signed: string } => {
      const d = tmp();
      const unsigned = join(d, 'u', mac.file);
      const signed = join(d, 's', mac.file);
      bundle(unsigned, null);
      bundle(signed, sig, { resources: SEAL });
      mkdirSync(join(signed, 'Contents', '_CodeSignature'));
      writeFileSync(join(signed, 'Contents', '_CodeSignature', 'CodeResources'), SEAL);
      writeFileSync(join(signed, 'Contents', 'CodeResources'), 'ticket');
      return { unsigned, signed };
    };

    it('may differ by its signatures', async () => {
      const { unsigned, signed } = pair();
      await expect(compareSigned(mac, unsigned, signed)).resolves.toBeUndefined();
    });

    describe('what its signature may say (signing-policy.ts)', () => {
      const team: SigningPolicy = {
        label: 'test',
        appleTeamId: 'ABCDE12345',
        allowAdHocMacosRelease: false,
        windowsSigner: null,
      };

      it('a policy that pins something malformed is refused, not trusted', async () => {
        const { unsigned, signed } = pair();
        for (const bad of [
          { label: 'x', appleTeamId: '', allowAdHocMacosRelease: false, windowsSigner: null },
          { label: 'x', appleTeamId: 'short', allowAdHocMacosRelease: false, windowsSigner: null },
          {
            label: 'x',
            appleTeamId: null,
            allowAdHocMacosRelease: false,
            windowsSigner: { sha256: '', subject: 'CN=a', issuer: 'CN=a' },
          },
          {
            label: 'x',
            appleTeamId: null,
            allowAdHocMacosRelease: false,
            windowsSigner: { sha256: 'AB'.repeat(32), subject: ' ', issuer: 'CN=a' },
          },
        ])
          await refusedAsync(compareSigned(mac, unsigned, signed, bad), /pinned .* is not/);
      });

      it('production takes an ad-hoc signature with the hardened runtime and the pinned entitlements', async () => {
        expect(productionSigningPolicy().appleTeamId).toBeNull();
        const { unsigned, signed } = pair();
        await expect(
          compareSigned(mac, unsigned, signed, productionSigningPolicy()),
        ).resolves.toBeUndefined();
      });

      it('refuses a bundle re-signed with an entitlement added', async () => {
        const { unsigned, signed } = pair({
          entitlements: { ...AD_HOC, 'com.apple.security.get-task-allow': true },
        });
        await refusedAsync(
          compareSigned(mac, unsigned, signed),
          /Contents\/MacOS\/Nutflix has the entitlements .*get-task-allow=true, not com\.apple\.security\.cs\.allow-jit=true, com\.apple\.security\.cs\.disable-library-validation=true$/,
        );
      });

      it('refuses one with its entitlements taken away', async () => {
        const { unsigned, signed } = pair({ entitlements: null });
        await refusedAsync(compareSigned(mac, unsigned, signed), /has the entitlements none/);
      });

      it('refuses one with the hardened runtime removed', async () => {
        const { unsigned, signed } = pair({ flags: CS_ADHOC });
        await refusedAsync(
          compareSigned(mac, unsigned, signed),
          /Contents\/MacOS\/Nutflix is not signed with the hardened runtime/,
        );
      });

      it('refuses any identity while no Team ID is pinned', async () => {
        const { unsigned, signed } = pair({
          flags: CS_RUNTIME,
          team: 'OTHER12345',
          identity: true,
        });
        await refusedAsync(
          compareSigned(mac, unsigned, signed),
          /signed by OTHER12345: with no Apple Team ID pinned, only an ad-hoc signature/,
        );
      });

      it('with a Team ID pinned, takes that team and refuses another, or ad hoc', async () => {
        const ours = pair({
          flags: CS_RUNTIME,
          team: 'ABCDE12345',
          identity: true,
          entitlements: JIT,
        });
        await expect(compareSigned(mac, ours.unsigned, ours.signed, team)).resolves.toBeUndefined();
        const other = pair({ flags: CS_RUNTIME, team: 'OTHER12345', identity: true });
        await refusedAsync(
          compareSigned(mac, other.unsigned, other.signed, team),
          /signed by OTHER12345, not Team ID ABCDE12345/,
        );
        const adHoc = pair();
        await refusedAsync(
          compareSigned(mac, adHoc.unsigned, adHoc.signed, team),
          /signed by no team, not Team ID ABCDE12345/,
        );
      });

      it('refuses a binary re-signed with the signature stripped', async () => {
        const { unsigned, signed } = pair();
        writeFileSync(join(signed, 'Contents', 'MacOS', APP.productName), macho({ sigSize: null }));
        writeFileSync(join(unsigned, 'Contents', 'MacOS', APP.productName), macho({ sigSize: 32 }));
        await refusedAsync(compareSigned(mac, unsigned, signed), /is not signed/);
      });
    });

    it('refuses a resource seal its signature does not hash, and a signature that is not valid', async () => {
      const { unsigned, signed } = pair();
      writeFileSync(join(signed, 'Contents', '_CodeSignature', 'CodeResources'), 'another seal');
      await refusedAsync(
        compareSigned(mac, unsigned, signed),
        /Contents\/MacOS\/Nutflix: special slot 3 is not the hash of what it names/,
      );
      const bad = pair();
      const exe = join(bad.signed, 'Contents', 'MacOS', APP.productName);
      const f = readFileSync(exe);
      const at = CODE_LIMIT + f.readUInt32BE(CODE_LIMIT + 16);
      const hashes = at + f.readUInt32BE(at + 16);
      f[hashes] = (f[hashes] ?? 0) ^ 1;
      writeFileSync(exe, f);
      await refusedAsync(
        compareSigned(mac, bad.unsigned, bad.signed),
        /Contents\/MacOS\/Nutflix: page 0 of the code is not the one its signature hashes/,
      );
    });

    it('refuses a 32-bit Mach-O left as CI built it', async () => {
      const { unsigned, signed } = pair();
      const old = Buffer.concat([Buffer.from([0xce, 0xfa, 0xed, 0xfe]), Buffer.alloc(60)]);
      for (const d of [unsigned, signed])
        writeFileSync(join(d, 'Contents', 'Resources', 'old.dylib'), old);
      await refusedAsync(
        compareSigned(mac, unsigned, signed),
        /Contents\/Resources\/old\.dylib is a 32-bit Mach-O/,
      );
    });

    it('holds a Mach-O left as CI built it to the policy too', async () => {
      const { unsigned, signed } = pair();
      // The same addon in both: CI's linker signature, no hardened runtime, on an executable.
      for (const d of [unsigned, signed]) {
        mkdirSync(join(d, 'Contents', 'Resources', 'addon'), { recursive: true });
        writeFileSync(
          join(d, 'Contents', 'Resources', 'addon', 'tool'),
          signedMacho({ flags: CS_ADHOC, entitlements: null }),
        );
      }
      await refusedAsync(
        compareSigned(mac, unsigned, signed),
        /Contents\/Resources\/addon\/tool is not signed with the hardened runtime/,
      );
    });

    it('knows which files a bundle’s own executable seals', () => {
      expect(sealedFilesOf('Contents/MacOS/Nutflix')).toEqual({
        infoPlist: 'Contents/Info.plist',
        resources: 'Contents/_CodeSignature/CodeResources',
      });
      expect(
        sealedFilesOf('Contents/Frameworks/Nutflix Helper.app/Contents/MacOS/Nutflix Helper')
          ?.infoPlist,
      ).toBe('Contents/Frameworks/Nutflix Helper.app/Contents/Info.plist');
      expect(
        sealedFilesOf('Contents/Frameworks/Squirrel.framework/Versions/A/Squirrel')?.resources,
      ).toBe('Contents/Frameworks/Squirrel.framework/Versions/A/_CodeSignature/CodeResources');
      for (const tool of [
        'Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt',
        'Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate',
        'Contents/Resources/app/node_modules/bare-sidecar/prebuilds/darwin-arm64/bare',
      ])
        expect(sealedFilesOf(tool)).toBeNull();
    });

    it('exempts only a bundle’s or a framework’s own _CodeSignature', async () => {
      for (const p of [
        'Contents/_CodeSignature/CodeResources',
        'Contents/Frameworks/Nutflix Helper.app/Contents/_CodeSignature/CodeResources',
        'Contents/Frameworks/Electron Framework.framework/Versions/A/_CodeSignature/CodeResources',
        'Contents/CodeResources',
      ])
        expect(isBundleSignaturePath(p)).toBe(true);
      for (const p of [
        'Contents/Resources/_CodeSignature/evil.js',
        'Contents/Resources/app/_CodeSignature/CodeResources',
        'Contents/_CodeSignature/a/b',
        'Contents/Frameworks/Nutflix Helper.app/Contents/CodeResources',
        'Contents/Frameworks/X.framework/_CodeSignature/CodeResources',
      ])
        expect(isBundleSignaturePath(p)).toBe(false);
      const { unsigned, signed } = pair();
      mkdirSync(join(signed, 'Contents', 'Resources', '_CodeSignature'));
      writeFileSync(join(signed, 'Contents', 'Resources', '_CodeSignature', 'evil.js'), 'x');
      await refusedAsync(
        compareSigned(mac, unsigned, signed),
        /signing added Contents\/Resources\/_CodeSignature\/evil\.js/,
      );
    });

    it('refuses a changed script', async () => {
      const { unsigned, signed } = pair();
      writeFileSync(join(signed, 'Contents', 'Resources', 'main.js'), 'changed');
      await refusedAsync(
        compareSigned(mac, unsigned, signed),
        /more than the signature of Contents\/Resources\/main\.js/,
      );
    });

    it('refuses changed code in a Mach-O', async () => {
      const { unsigned, signed } = pair();
      writeFileSync(
        join(signed, 'Contents', 'MacOS', APP.productName),
        signedMacho({ code: 0x12 }),
      );
      await refusedAsync(compareSigned(mac, unsigned, signed), /more than the signature/);
    });

    it('refuses an added file', async () => {
      const { unsigned, signed } = pair();
      writeFileSync(join(signed, 'Contents', 'Resources', 'extra.js'), 'added');
      await refusedAsync(compareSigned(mac, unsigned, signed), /signing added/);
    });

    it('refuses a removed file', async () => {
      const { unsigned, signed } = pair();
      rmSync(join(signed, 'Contents', 'Resources', 'main.js'));
      await refusedAsync(compareSigned(mac, unsigned, signed), /signing removed/);
    });
  });

  describe('an msix', () => {
    const TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
    const types = (...extra: string[]): string =>
      `<?xml version="1.0" encoding="UTF-8"?>\r\n<Types xmlns="${TYPES_NS}"><Default Extension="xml" ContentType="application/vnd.ms-appx.manifest+xml"/><Default Extension="exe" ContentType="application/x-msdownload"/>${extra.join('')}</Types>`;
    const SIGNATURE_TYPE =
      '<Override PartName="/AppxSignature.p7x" ContentType="application/vnd.ms-appx.signature"/>';
    const CATALOG_TYPE =
      '<Override PartName="/AppxMetadata/CodeIntegrity.cat" ContentType="application/vnd.ms-pkiseccat"/>';
    const exe = peFile(0x90);
    const parts: ZipItem[] = [
      { name: 'AppxManifest.xml', data: 'manifest', deflate: true },
      { name: 'app/Nutflix.exe', data: exe, deflate: true },
      { name: '[Content_Types].xml', data: types() },
    ];
    const cert = testCertificate('CN=Test Publisher');
    const otherCert = testCertificate('CN=Test Publisher', 0x43);
    const pinned: SigningPolicy = {
      label: 'test',
      appleTeamId: null,
      allowAdHocMacosRelease: false,
      windowsSigner: {
        sha256: cert.x509.fingerprint256,
        subject: cert.x509.subject,
        issuer: cert.x509.issuer,
      },
    };
    const signedParts = (
      o: { over?: ZipItem[]; types?: string; by?: typeof cert; catalog?: Buffer } = {},
    ): ZipItem[] => [
      ...parts
        .filter((p) => !(o.over ?? []).some((x) => x.name === p.name))
        .map((p) =>
          p.name === '[Content_Types].xml'
            ? {
                ...p,
                data:
                  o.types ??
                  types(SIGNATURE_TYPE, ...(o.catalog === undefined ? [] : [CATALOG_TYPE])),
              }
            : p,
        ),
      ...(o.over ?? []),
      ...(o.catalog === undefined
        ? []
        : [{ name: 'AppxMetadata/CodeIntegrity.cat', data: o.catalog }]),
      { name: 'AppxSignature.p7x', data: p7x(o.by ?? cert) },
    ];
    const file = (items: ZipItem[]): string => {
      const f = join(tmp(), win.file);
      writeFileSync(f, zipOf(items));
      return f;
    };
    const digestOfExe = (algorithm: 'sha1' | 'sha256') => ({
      algorithm,
      digest: peAuthenticodeDigest(exe, algorithm) ?? '',
    });

    it('may differ by its signature part, signed by the pinned certificate', async () => {
      await expect(
        compareSigned(win, file(parts), file(signedParts()), pinned),
      ).resolves.toBeUndefined();
    });

    it('is refused while no certificate is pinned: production today', async () => {
      expect(productionSigningPolicy().windowsSigner).toBeNull();
      await refusedAsync(
        compareSigned(win, file(parts), file(signedParts())),
        /no Windows signing certificate is pinned \(production\)/,
      );
    });

    it('refuses another certificate than the one pinned', async () => {
      await refusedAsync(
        compareSigned(win, file(parts), file(signedParts({ by: otherCert })), pinned),
        /not the pinned certificate/,
      );
    });

    it('refuses an unsigned one', async () => {
      await refusedAsync(compareSigned(win, file(parts), file(parts), pinned), /no signature/);
    });

    it('refuses a changed part', async () => {
      await refusedAsync(
        compareSigned(
          win,
          file(parts),
          file(signedParts({ over: [{ name: 'app/Nutflix.exe', data: 'evil', deflate: true }] })),
          pinned,
        ),
        /signing changed app\/Nutflix\.exe/,
      );
    });

    it('refuses an added part', async () => {
      await refusedAsync(
        compareSigned(
          win,
          file(parts),
          file(signedParts({ over: [{ name: 'app/evil.dll', data: 'x' }] })),
          pinned,
        ),
        /signing added app\/evil\.dll/,
      );
    });

    describe('its content types', () => {
      it('may add the signature’s entry, in either form, and nothing else', async () => {
        expect(isSignatureType(SIGNATURE_TYPE)).toBe(true);
        expect(
          isSignatureType(
            '<Default ContentType="application/vnd.ms-appx.signature" Extension="P7X" />',
          ),
        ).toBe(true);
        expect(isSignatureType(CATALOG_TYPE)).toBe(false);
        expect(isSignatureType(CATALOG_TYPE, true)).toBe(true);
        expect(
          isSignatureType(
            '<Default Extension="dll" ContentType="application/vnd.ms-appx.signature"/>',
          ),
        ).toBe(false);
        await refusedAsync(
          compareSigned(
            win,
            file(parts),
            file(
              signedParts({
                types: types(SIGNATURE_TYPE, '<Default Extension="js" ContentType="text/plain"/>'),
              }),
            ),
            pinned,
          ),
          /signing added <Default Extension="js"/,
        );
      });

      it('refuses any other change', async () => {
        for (const changed of [
          types(SIGNATURE_TYPE).replace('application/x-msdownload', 'text/plain'),
          types(SIGNATURE_TYPE).replace(
            '<Default Extension="xml"',
            '<!-- x --><Default Extension="xml"',
          ),
          types(SIGNATURE_TYPE).replace(TYPES_NS, 'urn:other'),
        ])
          await refusedAsync(
            compareSigned(win, file(parts), file(signedParts({ types: changed })), pinned),
            /signing changed \[Content_Types\]\.xml/,
          );
      });
    });

    describe('a code-integrity catalog signing adds', () => {
      it('may name the package’s binaries, by either digest, as v2 or v1', async () => {
        for (const v1 of [false, true]) {
          const cat = catalog([digestOfExe('sha256'), digestOfExe('sha1')], cert, { v1 });
          await expect(
            compareSigned(win, file(parts), file(signedParts({ catalog: cat })), pinned),
          ).resolves.toBeUndefined();
        }
      });

      it('refuses a member whose identifier and indirect data disagree', async () => {
        const other = peAuthenticodeDigest(peFile(0x91), 'sha256') ?? '';
        const cat = catalog([{ ...digestOfExe('sha256'), inside: other }], cert);
        await refusedAsync(
          compareSigned(win, file(parts), file(signedParts({ catalog: cat })), pinned),
          /names two different digests/,
        );
        // In v1 the indirect data is the digest: one the package does not hold is refused.
        const v1 = catalog([{ ...digestOfExe('sha256'), inside: other }], cert, { v1: true });
        await refusedAsync(
          compareSigned(win, file(parts), file(signedParts({ catalog: v1 })), pinned),
          /which is no binary in the package/,
        );
      });

      it('refuses one that names a binary the package does not hold', async () => {
        const foreign = {
          algorithm: 'sha256' as const,
          digest: peAuthenticodeDigest(peFile(0x91), 'sha256') ?? '',
        };
        const cat = catalog([digestOfExe('sha256'), foreign], cert);
        await refusedAsync(
          compareSigned(win, file(parts), file(signedParts({ catalog: cat })), pinned),
          /CodeIntegrity\.cat names sha256 .*, which is no binary in the package/,
        );
      });

      it('refuses one signed by another certificate, and one too large', async () => {
        const other = catalog([digestOfExe('sha256')], otherCert);
        await refusedAsync(
          compareSigned(win, file(parts), file(signedParts({ catalog: other })), pinned),
          /CodeIntegrity\.cat is signed by .*not the pinned certificate/,
        );
        await refusedAsync(
          compareSigned(
            win,
            file(parts),
            file(signedParts({ catalog: Buffer.alloc(1024 * 1024 + 1) })),
            pinned,
          ),
          /larger than any catalog/,
        );
      });

      it('refuses a catalog the unsigned package had, removed or changed', async () => {
        const cat = catalog([digestOfExe('sha256')], cert);
        const withCat = [...parts, { name: 'AppxMetadata/CodeIntegrity.cat', data: cat }];
        await refusedAsync(
          compareSigned(win, file(withCat), file(signedParts()), pinned),
          /signing removed AppxMetadata\/CodeIntegrity\.cat/,
        );
      });
    });
  });

  it('an AppImage is not signed', async () => {
    await refusedAsync(compareSigned(target('linux-x64'), 'a', 'b'), /not signed/);
  });

  describe('recording it', () => {
    const folder = async (): Promise<{
      out: string;
      app: string;
      digest: string;
      signed: string;
    }> => {
      const out = tmp();
      const app = join(out, 'apps', mac.name, mac.file);
      readableApp(app, 'unsigned');
      const digest = await digestOf(app);
      const release: ReleaseFile = {
        schema: RELEASE_SCHEMA,
        version: '1.2.3',
        commit: COMMIT,
        run: RUN,
        targets: RELEASE_TARGETS.map((t) => ({
          target: t.name,
          app: t.name === mac.name ? app : join(out, 'x', t.file),
          ci: { digest: t.name === mac.name ? digest : '0'.repeat(64), bytes: 1 },
        })),
      };
      mkdirSync(join(out, 'notice-files'));
      writeReleaseFile(out, release);
      const signed = join(tmp(), mac.file);
      readableApp(signed, 'signed');
      return { out, app, digest, signed };
    };

    it('keeps CI’s digest and records the signed one', async () => {
      const { out, digest, signed } = await folder();
      const r = await recordSigned(out, mac.name, signed);
      expect(r.before).toBe(digest);
      expect(r.after).toBe(await digestOf(signed));
      expect(r.after).not.toBe(digest);
      const row = readRelease(out).targets.find((x) => x.target === mac.name);
      expect(row?.ci.digest).toBe(digest);
      expect(row?.signed?.digest).toBe(r.after);
      expect(await digestOf(join(out, 'notice-files', mac.noticeName))).toBe(r.after);
      await refusedAsync(recordSigned(out, mac.name, signed), /already has a signed package/);
    });

    it('refuses when CI’s package is no longer what was checked', async () => {
      const { out, app, signed } = await folder();
      writeFileSync(join(app, 'Contents', 'Resources', 'app', 'package.json'), '{}');
      await refusedAsync(recordSigned(out, mac.name, signed), /no longer the package CI built/);
    });

    it('refuses a signed tree whose root was changed', async () => {
      const { out, signed } = await folder();
      const other = parseTrustRoot({
        v: 1,
        channel: 'launch',
        pubkey: 'ab'.repeat(32),
        relays: ['ws://127.0.0.1:49737'],
        upgrade: null,
        dht: null,
        delayMs: null,
      });
      const worker = join(
        signed,
        'Contents',
        'Resources',
        'app',
        ...STAGED.updateWorker.split('/'),
      );
      writeFileSync(worker, `x="${encodeBakedRoot(other)}";`);
      await refusedAsync(recordSigned(out, mac.name, signed), /more than the signature/);
    });

    it('takes only the package’s own name', async () => {
      const { out, signed } = await folder();
      await refusedAsync(recordSigned(out, 'linux-x64', signed), /must be named Nutflix\.AppImage/);
      const renamed = join(tmp(), 'Other.app');
      mkdirSync(renamed);
      await refusedAsync(recordSigned(out, mac.name, renamed), /must be named Nutflix\.app/);
    });
  });
});

// ---- what a signer checks --------------------------------------------------------------------

describe('what a signer checks', () => {
  const linux = target('linux-x64');
  const mac = target('darwin-arm64');
  const KEY = 'y'.repeat(52);
  const LINK = `pear://${KEY}`;
  const VERLINK = `pear://0.9.${'n'.repeat(52)}`;

  const drive = (entries: Record<string, string>, version = '1.2.3'): string => {
    const d = join(tmp(), 'drive');
    mkdirSync(d);
    writeFileSync(join(d, 'package.json'), deploymentPackageJson({ version }));
    for (const [path, data] of Object.entries(entries)) {
      const p = join(d, ...path.split('/'));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, data);
    }
    return d;
  };
  const ciEntry = (
    t: ReleaseTarget,
    data: string,
  ): { target: ReleaseTarget; app: string; digest: string } => {
    const app = join(tmp(), t.file);
    writeFileSync(app, data);
    return { target: t, app, digest: sha(data) };
  };

  it('accepts a drive holding exactly what CI built', async () => {
    const d = drive({ [deploymentEntry(linux)]: 'good' });
    const rows = await compareDrive(d, '1.2.3', [ciEntry(linux, 'good')]);
    expect(rows).toEqual([{ target: linux.name, digest: sha('good'), how: 'exact' }]);
  });

  it('refuses a swapped entry', async () => {
    const d = drive({ [deploymentEntry(linux)]: 'swapped' });
    await refusedAsync(compareDrive(d, '1.2.3', [ciEntry(linux, 'good')]), /is not what CI built/);
  });

  it('refuses a missing entry', async () => {
    const d = drive({});
    await refusedAsync(compareDrive(d, '1.2.3', [ciEntry(linux, 'good')]), /has no by-arch/);
  });

  it('refuses a file CI did not build', async () => {
    const d = drive({ [deploymentEntry(linux)]: 'good', 'by-arch/linux-x64/app/extra': 'x' });
    await refusedAsync(
      compareDrive(d, '1.2.3', [ciEntry(linux, 'good')]),
      /which CI did not build/,
    );
  });

  it('refuses another version’s manifest', async () => {
    const d = drive({ [deploymentEntry(linux)]: 'good' }, '9.9.9');
    await refusedAsync(compareDrive(d, '1.2.3', [ciEntry(linux, 'good')]), /package\.json is not/);
  });

  it('naming a target as signed excuses its signature and nothing else', async () => {
    const d = tmp();
    const app = join(d, 'ci', mac.file);
    bundle(app, 32);
    const digest = await digestOf(app);
    const root = join(d, 'drive');
    mkdirSync(root);
    writeFileSync(join(root, 'package.json'), deploymentPackageJson({ version: '1.2.3' }));
    const entry = join(root, ...deploymentEntry(mac).split('/'));
    bundle(entry, {});
    const ci = [{ target: mac, app, digest }];
    await refusedAsync(compareDrive(root, '1.2.3', ci), /is not what CI built/);
    const rows = await compareDrive(root, '1.2.3', ci, new Set([mac.name]));
    expect(rows[0]?.how).toBe('signed');
    writeFileSync(join(entry, 'Contents', 'Resources', 'main.js'), 'evil');
    await refusedAsync(
      compareDrive(root, '1.2.3', ci, new Set([mac.name])),
      /more than the signature/,
    );
  });

  describe('the request', () => {
    const verified = (
      over: { dstKey?: string; length?: number; treeHash?: string; blobs?: unknown } = {},
    ): Record<string, unknown> => ({
      dstKey: over.dstKey ?? KEY,
      result: {
        db: { batch: { length: over.length ?? 9, treeHash: over.treeHash ?? 'dbhash' } },
        blobs: {
          batch: 'blobs' in over ? over.blobs : { length: 30, treeHash: 'blobshash' },
        },
      },
    });
    const wants = {
      db: { length: 9, treeHash: 'dbhash' },
      blobs: { length: 30, treeHash: 'blobshash' },
    };
    const diffed = (
      db: { length: number; hash: string } = { length: 9, hash: 'dbhash' },
      blobs: { length: number; hash: string } = { length: 30, hash: 'blobshash' },
    ): Record<string, unknown> => ({
      source: { core: { id: 'x', ...db }, blobs: { id: 'y', ...blobs } },
    });

    it('binds to this version of the production link, by both cores', () => {
      expect(assertRequestBinds(verified(), LINK, VERLINK)).toEqual(wants);
    });

    it('refuses a request onto another link', () => {
      refused(
        () => assertRequestBinds(verified({ dstKey: 'b'.repeat(52) }), LINK, VERLINK),
        /not the production link/,
      );
    });

    it('refuses a request for another version than the one checked', () => {
      refused(
        () => assertRequestBinds(verified({ length: 11 }), LINK, VERLINK),
        /releases length 11/,
      );
    });

    it('refuses an answer with no tree hash, or no blobs', () => {
      refused(() => assertRequestBinds(verified({ treeHash: '' }), LINK, VERLINK), /no tree hash/);
      refused(() => assertRequestBinds(verified({ blobs: undefined }), LINK, VERLINK), /no blobs/);
      refused(() => assertRequestBinds(undefined, LINK, VERLINK), /not the production link/);
    });

    it('the version fetched must have the cores the request writes: db and blobs', () => {
      expect(() => {
        assertFetchedIsRequested(diffed(), wants);
      }).not.toThrow();
      refused(() => {
        assertFetchedIsRequested(diffed({ length: 9, hash: 'otherdb' }), wants);
      }, /the db core fetched is not the one the request writes/);
      // The same db, other blobs: a db entry names a blob, it does not hash it.
      refused(() => {
        assertFetchedIsRequested(diffed(undefined, { length: 30, hash: 'otherblobs' }), wants);
      }, /the blobs core fetched is not the one the request writes: its file bytes may differ/);
      refused(() => {
        assertFetchedIsRequested({ source: { core: { length: 9, hash: 'dbhash' } } }, wants);
      }, /no blobs core/);
    });

    it('the drive must be at the verlink’s fork, blobs too', () => {
      expect(() => {
        assertFork({ fork: 0, blobs: { fork: 0 } }, VERLINK);
      }).not.toThrow();
      refused(() => {
        assertFork({ fork: 1, blobs: { fork: 1 } }, VERLINK);
      }, /at fork 1/);
      refused(() => {
        assertFork({ fork: 0, blobs: { fork: 2 } }, VERLINK);
      }, /blobs 2/);
    });

    describe('in one Pear home, in order', () => {
      const line = (tag: string, data: Record<string, unknown>): PearRecord => ({ tag, data });
      const script = (o: {
        derived?: string;
        fork?: number;
        laterFork?: number;
        later?: Record<string, unknown>;
        fetched?: Record<string, unknown>;
      }): { pear: PearInOneHome; calls: string[] } => {
        const calls: string[] = [];
        let verifies = 0;
        let infos = 0;
        const pear: PearInOneHome = (args) => {
          calls.push(
            args.slice(0, args[0] === 'multisig' || args[0] === 'provision' ? 2 : 1).join(' '),
          );
          if (args[0] === 'multisig' && args[1] === 'link')
            return Promise.resolve([line('final', { link: o.derived ?? LINK })]);
          if (args[0] === 'info') {
            const fork = infos++ === 0 ? (o.fork ?? 0) : (o.laterFork ?? o.fork ?? 0);
            return Promise.resolve([line('info', { fork, blobs: { fork } })]);
          }
          if (args[0] === 'multisig' && args[1] === 'verify')
            return Promise.resolve([
              line('final', verifies++ === 0 ? verified() : (o.later ?? verified())),
            ]);
          if (args[0] === 'provision')
            return Promise.resolve([line('diffed', o.fetched ?? diffed())]);
          return Promise.resolve([]);
        };
        return { pear, calls };
      };
      const check = (pear: PearInOneHome) =>
        checkRequestInOneHome(pear, {
          config: '/c/pear.json',
          verlink: VERLINK,
          request: 'yb'.repeat(40),
          production: LINK,
          dumpDir: '/w/drive',
        });

      it('asks every question of the same home, and the version is the request’s', async () => {
        const { pear, calls } = script({});
        await expect(check(pear)).resolves.toEqual({ requested: wants, cores: diffed() });
        expect(calls).toEqual([
          'multisig link',
          'info',
          'multisig verify',
          'dump',
          'provision --dry-run',
          'multisig verify',
          'info',
        ]);
      });

      it('stops at a config that derives another link', async () => {
        const { pear, calls } = script({ derived: `pear://${'q'.repeat(52)}` });
        await refusedAsync(check(pear), /derives/);
        expect(calls).toEqual(['multisig link']);
      });

      it('refuses blobs fetched that are not the request’s', async () => {
        const { pear, calls } = script({
          fetched: diffed(undefined, { length: 30, hash: 'otherblobs' }),
        });
        await refusedAsync(check(pear), /blobs core fetched/);
        expect(calls.at(-1)).toBe('provision --dry-run');
      });

      it('refuses a request or a fork that changed during the check', async () => {
        await refusedAsync(
          check(script({ later: verified({ treeHash: 'moved' }) }).pear),
          /changed during the check/,
        );
        await refusedAsync(check(script({ laterFork: 1 }).pear), /at fork 1/);
      });
    });
  });
});

describe('a package read from its bytes', () => {
  const COMMIT_2 = 'cd'.repeat(20);
  const write = (path: string, commit?: string): void => {
    const res = join(path, 'Contents', 'Resources', 'app');
    mkdirSync(join(res, 'main'), { recursive: true });
    writeFileSync(
      join(res, 'package.json'),
      JSON.stringify({ version: '1.2.3', ...(commit === undefined ? {} : { commit }) }),
    );
    const root = releaseRoot();
    writeFileSync(join(res, ...STAGED.updateWorker.split('/')), `x="${encodeBakedRoot(root)}";`);
    writeFileSync(join(res, ...STAGED.main.split('/')), mainFor(root.upgrade));
  };

  it('says which commit CI built it from', () => {
    const p = join(tmp(), 'Nutflix.app');
    write(p, COMMIT_2);
    expect(packageFacts(p).commit).toBe(COMMIT_2);
    expect(() => {
      assertProductionRoot(p, packageFacts(p));
    }).not.toThrow();
  });

  it('has no commit if it was not built by CI, or the field is not one', () => {
    const p = join(tmp(), 'Nutflix.app');
    write(p);
    expect(packageFacts(p).commit).toBeNull();
    const q = join(tmp(), 'Nutflix.app');
    write(q, 'main');
    expect(packageFacts(q).commit).toBeNull();
  });

  it('refuses a main whose switch disagrees with its root', () => {
    const p = join(tmp(), 'Nutflix.app');
    write(p, COMMIT_2);
    const wrong = releaseRoot().upgrade === null ? 'pear://x' : null;
    writeFileSync(
      join(p, 'Contents', 'Resources', 'app', ...STAGED.main.split('/')),
      mainFor(wrong),
    );
    refused(() => packageFacts(p), /updates switch/);
  });

  it('reads an msix through the zip reader, and refuses one with a duplicate', () => {
    const root = releaseRoot();
    const parts: ZipItem[] = [
      {
        name: 'app/resources/app/package.json',
        data: JSON.stringify({ version: '1.2.3', commit: COMMIT_2 }),
        deflate: true,
      },
      {
        name: `app/resources/app/${STAGED.updateWorker}`,
        data: `x="${encodeBakedRoot(root)}";`,
        deflate: true,
      },
      { name: `app/resources/app/${STAGED.main}`, data: mainFor(root.upgrade) },
    ];
    const f = join(tmp(), 'Nutflix.msix');
    writeFileSync(f, zipOf(parts));
    expect(packageFacts(f)).toMatchObject({ version: '1.2.3', commit: COMMIT_2 });
    expect(readPackaged(f, 'package.json')).toContain('1.2.3');
    const g = join(tmp(), 'Nutflix.msix');
    writeFileSync(g, zipOf([...parts, parts[1]!]));
    refused(() => packageFacts(g), /duplicate/);
  });
});
