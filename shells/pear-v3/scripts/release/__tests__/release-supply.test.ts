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
import { elfArch, machoArches, machoCodeDigest } from '../binary.ts';
import { digestOf } from '../digest.ts';
import { ReleaseRefusal } from '../guards.ts';
import { assertPackageArch, assertProductionRoot, packageFacts, readPackaged } from '../inspect.ts';
import {
  RELEASE_REPO,
  assertArtifactBytes,
  parseRunId,
  runArtifacts,
  verifyMainRun,
  type GitHubApi,
} from '../provenance.ts';
import { assertRequestBinds, compareDrive } from '../signer.ts';
import { compareSigned, recordSigned } from '../signing.ts';
import { RELEASE_TARGETS, deploymentEntry, type ReleaseTarget } from '../targets.ts';
import { assertLinkInside, extractZip, readZipFile, readZipIndex } from '../zip.ts';
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
      assertLinkInside('a/b/l', '../c', 'x');
    }).not.toThrow();
    refused(() => {
      assertLinkInside('a/l', '../../c', 'x');
    }, /outside/);
  });
});

// ---- binaries --------------------------------------------------------------------------------

/** A small 64-bit Mach-O: __TEXT, __LINKEDIT, and a code signature of `sigSize` bytes, or none. */
function macho(o: { cpu?: number; sigSize?: number | null; code?: number } = {}): Buffer {
  const sigSize = o.sigSize === undefined ? 32 : o.sigSize;
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
    file.fill(0xab, linkeditEnd);
  }
  file.fill(o.code ?? 0x11, 0x100, textEnd);
  file.fill(0x22, textEnd, linkeditEnd);
  return file;
}

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
): GitHubApi {
  return {
    get: (path) => {
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
async function artifactBytes(
  t: ReleaseTarget,
  content: string,
  over: { digest?: string } = {},
): Promise<Buffer> {
  if (t.platform !== 'darwin') return zipOf([{ name: inputName(t), data: `${t.name} ${content}` }]);
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

/** A bundle with a Mach-O, a script and (where symlinks can be made) a symlink. */
function bundle(dir: string, sigSize: number | null = 32): void {
  mkdirSync(join(dir, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(dir, 'Contents', 'Resources'), { recursive: true });
  writeFileSync(join(dir, 'Contents', 'MacOS', APP.productName), macho({ sigSize }));
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
  writeFileSync(exe, macho({ sigSize: kind === 'signed' ? 96 : 32 }));
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
    const pair = (): { unsigned: string; signed: string } => {
      const d = tmp();
      const unsigned = join(d, 'u', mac.file);
      const signed = join(d, 's', mac.file);
      bundle(unsigned, null);
      bundle(signed, 96);
      mkdirSync(join(signed, 'Contents', '_CodeSignature'));
      writeFileSync(join(signed, 'Contents', '_CodeSignature', 'CodeResources'), 'seal');
      writeFileSync(join(signed, 'Contents', 'CodeResources'), 'ticket');
      return { unsigned, signed };
    };

    it('may differ by its signatures', async () => {
      const { unsigned, signed } = pair();
      await expect(compareSigned(mac, unsigned, signed)).resolves.toBeUndefined();
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
        macho({ sigSize: 96, code: 0x12 }),
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
    const parts: ZipItem[] = [
      { name: 'AppxManifest.xml', data: 'manifest', deflate: true },
      { name: 'app/Nutflix.exe', data: 'exe'.repeat(50), deflate: true },
      { name: '[Content_Types].xml', data: 'types' },
    ];
    const signedParts = (over: ZipItem[] = []): ZipItem[] => [
      ...parts
        .filter((p) => !over.some((o) => o.name === p.name))
        .map((p) => (p.name === '[Content_Types].xml' ? { ...p, data: 'types + p7x' } : p)),
      ...over,
      { name: 'AppxSignature.p7x', data: 'signature' },
    ];
    const file = (items: ZipItem[]): string => {
      const f = join(tmp(), win.file);
      writeFileSync(f, zipOf(items));
      return f;
    };

    it('may differ by its signature part', async () => {
      await expect(compareSigned(win, file(parts), file(signedParts()))).resolves.toBeUndefined();
    });

    it('refuses an unsigned one', async () => {
      await refusedAsync(compareSigned(win, file(parts), file(parts)), /no signature/);
    });

    it('refuses a changed part', async () => {
      await refusedAsync(
        compareSigned(
          win,
          file(parts),
          file(signedParts([{ name: 'app/Nutflix.exe', data: 'evil', deflate: true }])),
        ),
        /signing changed app\/Nutflix\.exe/,
      );
    });

    it('refuses an added part', async () => {
      await refusedAsync(
        compareSigned(win, file(parts), file(signedParts([{ name: 'app/evil.dll', data: 'x' }]))),
        /signing added app\/evil\.dll/,
      );
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
    bundle(entry, 96);
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
      over: { dstKey?: string; length?: number; treeHash?: string } = {},
    ): Record<string, unknown> => ({
      dstKey: over.dstKey ?? KEY,
      result: { db: { batch: { length: over.length ?? 9, treeHash: over.treeHash ?? 'hash' } } },
    });

    it('binds to this version of the production link', () => {
      expect(assertRequestBinds(verified(), LINK, VERLINK)).toBe('hash');
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

    it('refuses an answer with no tree hash', () => {
      refused(() => assertRequestBinds(verified({ treeHash: '' }), LINK, VERLINK), /no tree hash/);
      refused(() => assertRequestBinds(undefined, LINK, VERLINK), /not the production link/);
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
