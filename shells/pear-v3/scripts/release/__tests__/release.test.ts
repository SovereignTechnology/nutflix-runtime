/**
 * The release tool: what it refuses, the exact commands it would run, the digest it names (the
 * update gate's own), the notice it drafts (read by the app's own parser), and what CI launches on
 * the day the source gets a real upgrade link.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it } from 'vitest';

import { APP, STAGED } from '../../../packaging/identity.ts';
import {
  RELEASE_PUBKEY,
  assertLaunchRoot,
  assertMainMatchesRoot,
  assertNoUpgradeLink,
  assertReleaseRoot,
  releaseRoot,
  testRootFromText,
  throwawayRootFromText,
} from '../../../packaging/update-root.ts';
import { UpdateGate, artifactName } from '../../../src/update/gate.ts';
import { artifactDigest, type HashFs, type HashStat } from '../../../src/update/hash.ts';
import { readNotice } from '../../../src/update/notice.ts';
import {
  NOTICE_D,
  NOTICE_KIND,
  encodeBakedRoot,
  parseTrustRoot,
  type TrustRoot,
} from '../../../src/update/root.ts';
import type { UpdateStatus } from '../../../src/update/status.ts';
import { PEAR_PINS, PEAR_VERSION } from '../../pear-ci/pins.ts';
import {
  RELEASE_SCHEMA,
  digestTargets,
  inputName,
  readDigests,
  readRelease,
  writeReleaseFile,
  type Digest,
} from '../assemble.ts';
import {
  assertReleasable,
  assertSignable,
  noTeamIdRefusal,
  noWindowsSignerRefusal,
  unnamedWindowsRefusal,
  unsignedMacRefusal,
  unsignedWindowsRefusal,
} from '../release-gate.ts';
import { productionSigningPolicy, type SigningPolicy } from '../signing-policy.ts';
import {
  appleCheck,
  appleCheckRefusal,
  appleCheckWarning,
  committedVersion,
  parseOptions,
  runCli,
  signInstruction,
  type Io,
} from '../cli.ts';
import {
  PEER_UPDATE_TIMEOUT_MS,
  planBuild,
  planCommit,
  planProvision,
  planRequest,
  planSeed,
  planStage,
  planVerify,
  renderCommand,
} from '../commands.ts';
import { artifactBytes, digestOf, nodeSha256 } from '../digest.ts';
import { noticeDraft, releaseNoticeDraft, sumsText } from '../draft.ts';
import {
  ReleaseRefusal,
  assertLink,
  assertVerlink,
  confirmLink,
  linkKeyOf,
  onCi,
  refuseOnCi,
} from '../guards.ts';
import { appImageOffset, assertProductionRoot, packageFacts, readPackaged } from '../inspect.ts';
import {
  launchSubject,
  parseSubjectArgs,
  prepareLaunchOut,
  throwawayLaunchRoot,
} from '../launch-subject.ts';
import { RELEASE_TARGETS, deploymentEntry } from '../targets.ts';

/**
 * A test policy only: a Team ID and a Windows certificate pinned, so a release whose macOS and
 * Windows packages are signed may ship. The certificate is no real one.
 */
const SIGNERS_PINNED: SigningPolicy = {
  label: 'test',
  appleTeamId: 'ABCDE12345',
  allowAdHocMacosRelease: false,
  windowsSigner: { sha256: 'AB'.repeat(32), subject: 'CN=Test Signer', issuer: 'CN=Test CA' },
};
/** A test policy only: no Team ID, and ad hoc chosen, as `ALLOW_AD_HOC_MACOS_RELEASE = true` would. */
const AD_HOC_CHOSEN: SigningPolicy = {
  ...SIGNERS_PINNED,
  appleTeamId: null,
  allowAdHocMacosRelease: true,
};
/** A test policy only: a Team ID pinned, and no Windows certificate (as production has today). */
const NO_WINDOWS_SIGNER: SigningPolicy = { ...SIGNERS_PINNED, windowsSigner: null };

/**
 * A release.json for `dir`, its macOS and Windows rows signed by the owner unless `unsigned` says
 * otherwise.
 */
function releaseFile(dir: string, o: { unsigned?: readonly string[] } = {}): void {
  writeReleaseFile(dir, {
    schema: RELEASE_SCHEMA,
    version: '0.2.0',
    commit: 'ab'.repeat(20),
    run: 1,
    targets: RELEASE_TARGETS.map((t) => ({
      target: t.name,
      app: join(dir, 'apps', t.name, t.file),
      ci: { digest: '0'.repeat(64), bytes: 1 },
      ...(t.platform !== 'linux' && !(o.unsigned ?? []).includes(t.name)
        ? { signed: { app: join(dir, 'signed', t.name, t.file), digest: '1'.repeat(64), bytes: 1 } }
        : {}),
    })),
  });
}

const KEY_A = 'y'.repeat(52);
const KEY_B = 'b'.repeat(52);
const LINK_A = `pear://${KEY_A}`;
const LINK_B = `pear://${KEY_B}`;
const VERLINK_A = `pear://0.12.${KEY_A}`;
const REQUEST = 'yb'.repeat(40);
const RESPONSE = 'nd'.repeat(40);

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'release-tool-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---- what stands in for the outside world ------------------------------------------------------

interface FakeIo extends Io {
  readonly printed: string[];
  readonly ran: (readonly string[])[];
  readonly asked: string[];
  fetched: number;
  built: (readonly string[])[];
}

const finalLine = (data: object): string =>
  `${JSON.stringify({ cmd: 'multisig', tag: 'final', data: { success: true, ...data } })}\n`;

function fakeIo(
  over: Partial<Io> & {
    typed?: string;
    derived?: string;
    code?: number;
    linkCode?: number;
    production?: string | null;
  } = {},
): FakeIo {
  const printed: string[] = [];
  const ran: (readonly string[])[] = [];
  const asked: string[] = [];
  const io: FakeIo = {
    env: {},
    ask: (prompt) => {
      asked.push(prompt);
      return Promise.resolve(over.typed ?? '');
    },
    api: {
      get: () => Promise.reject(new Error('no API here')),
      download: () => Promise.reject(new Error('no API here')),
    },
    productionLink: () => (over.production === undefined ? LINK_B : over.production),
    print: (l) => printed.push(l),
    pearPath: () => '/pinned/pear',
    ensurePear: () => {
      io.fetched++;
      return Promise.resolve('/pinned/pear');
    },
    runPublic: (_bin, args) => {
      ran.push(args);
      if (args[0] === 'multisig' && args[1] === 'link')
        return Promise.resolve({
          code: over.linkCode ?? 0,
          out: over.linkCode === undefined ? finalLine({ link: over.derived ?? LINK_B }) : '',
        });
      if (args[0] === 'multisig' && args[1] === 'commit')
        return Promise.resolve({
          code: over.code ?? 0,
          out: finalLine({
            dstKey: KEY_B,
            result: {
              db: { destCore: { key: KEY_B, length: 7 } },
              blobs: { destCore: { length: 5 } },
            },
          }),
        });
      return Promise.resolve({ code: over.code ?? 0, out: '' });
    },
    runIsolated: (bin, _home, args) => io.runPublic(bin, args),
    codesignVerify: () => null,
    signingPolicy: productionSigningPolicy,
    runBuild: (_bin, _out, args) => {
      io.built.push(args);
      return Promise.resolve();
    },
    nowS: () => 1_800_000_000,
    printed,
    ran,
    asked,
    fetched: 0,
    built: [],
    ...over,
  };
  return io;
}

const refused = async (p: Promise<unknown>, re: RegExp): Promise<void> => {
  await expect(p).rejects.toBeInstanceOf(ReleaseRefusal);
  await expect(p).rejects.toThrow(re);
};

// ---- guards --------------------------------------------------------------------------------------

describe('the guards', () => {
  it('counts CI and GITHUB_ACTIONS as set, even when empty', () => {
    expect(onCi({})).toBe(false);
    for (const env of [{ CI: 'true' }, { CI: '' }, { GITHUB_ACTIONS: 'true' }, { CI: 'false' }])
      expect(onCi(env)).toBe(true);
    expect(() => {
      refuseOnCi({ GITHUB_ACTIONS: 'true' }, 'seed');
    }).toThrow(/public DHT/);
  });

  it('tells a link from a versioned link, and refuses anything else', () => {
    expect(assertLink(LINK_A, 'x')).toBe(LINK_A);
    expect(assertVerlink(VERLINK_A, 'x')).toBe(VERLINK_A);
    for (const bad of [VERLINK_A, 'pear://short', `http://${KEY_A}`, `${LINK_A} `, undefined])
      expect(() => assertLink(bad, 'x')).toThrow(ReleaseRefusal);
    for (const bad of [LINK_A, `pear://0.x.${KEY_A}`, undefined])
      expect(() => assertVerlink(bad, 'x')).toThrow(ReleaseRefusal);
    expect(linkKeyOf(LINK_A)).toBe(KEY_A);
    expect(linkKeyOf(VERLINK_A)).toBe(KEY_A);
  });

  it('accepts only the exact link typed back', async () => {
    await expect(confirmLink(LINK_A, () => Promise.resolve(`  ${LINK_A}\n`))).resolves.toBe(
      undefined,
    );
    for (const typed of ['', 'yes', LINK_B, VERLINK_A])
      await refused(
        confirmLink(LINK_A, () => Promise.resolve(typed)),
        /not the link/,
      );
  });
});

// ---- the commands --------------------------------------------------------------------------------

describe('the exact commands', () => {
  it('builds with the flags pear build declares, for every target', () => {
    const appFlags = RELEASE_TARGETS.flatMap((t) => [`--${t.name}-app`, `/a/${t.name}`]);
    const p = planBuild({ packageJson: '/o/package.json', target: '/o/deployment', appFlags });
    expect(p.args.slice(0, 6)).toEqual([
      'build',
      '--package',
      '/o/package.json',
      '--target',
      '/o/deployment',
      '--json',
    ]);
    for (const t of RELEASE_TARGETS) expect(p.args).toContain(`--${t.name}-app`);
    expect(p).toMatchObject({ confirm: null, publicDht: false });
  });

  it('names the link each step acts on, which is what must be typed back', () => {
    expect(planStage({ link: LINK_A, deployment: '/d' })).toMatchObject({
      args: ['stage', '--json', LINK_A, '/d'],
      confirm: LINK_A,
      publicDht: true,
    });
    expect(
      planProvision({
        source: `pear://0.9.${'n'.repeat(52)}`,
        target: LINK_B,
        production: `pear://0.0.${KEY_A}`,
      }),
    ).toMatchObject({
      args: ['provision', '--json', `pear://0.9.${'n'.repeat(52)}`, LINK_B, `pear://0.0.${KEY_A}`],
      confirm: LINK_B,
    });
    expect(planRequest({ config: '/p.json', verlink: VERLINK_A })).toMatchObject({
      args: [
        'multisig',
        'request',
        '--config',
        '/p.json',
        '--peer-update-timeout',
        PEER_UPDATE_TIMEOUT_MS,
        '--json',
        VERLINK_A,
      ],
      confirm: LINK_A,
    });
    const quorum = { config: '/p.json', source: LINK_A, request: REQUEST, responses: [RESPONSE] };
    expect(planVerify(quorum).args.slice(0, 2)).toEqual(['multisig', 'verify']);
    expect(planVerify(quorum).confirm).toBe(LINK_A);
    const commit = planCommit({ ...quorum, production: LINK_B });
    expect(commit.args.slice(-3)).toEqual([LINK_A, REQUEST, RESPONSE]);
    expect(commit.confirm).toBe(LINK_B);
    expect(planSeed({ link: LINK_A })).toMatchObject({
      args: ['seed', '--no-tty', '--json', LINK_A],
      confirm: LINK_A,
    });
  });

  it('refuses a malformed link, request or response before building a command', () => {
    expect(() => planStage({ link: VERLINK_A, deployment: '/d' })).toThrow(ReleaseRefusal);
    expect(() => planProvision({ source: LINK_A, target: LINK_B, production: VERLINK_A })).toThrow(
      ReleaseRefusal,
    );
    const q = { config: '/p', source: LINK_A, request: REQUEST, responses: [RESPONSE] };
    expect(() => planVerify({ ...q, responses: [] })).toThrow(/at least one/);
    expect(() => planVerify({ ...q, request: 'not z32!' })).toThrow(ReleaseRefusal);
    expect(() => planVerify({ ...q, responses: ['--force-dangerous'] })).toThrow(ReleaseRefusal);
  });

  it('refuses a link in the wrong role', () => {
    expect(() =>
      planProvision({ source: VERLINK_A, target: LINK_B, production: `pear://0.3.${KEY_B}` }),
    ).toThrow(/production link/);
    expect(() =>
      planProvision({ source: VERLINK_A, target: LINK_A, production: `pear://0.3.${KEY_B}` }),
    ).toThrow(/is the source/);
    expect(() =>
      planCommit({
        config: '/p',
        source: LINK_A,
        production: LINK_A,
        request: REQUEST,
        responses: [RESPONSE],
      }),
    ).toThrow(/pre-production/);
  });

  it('prints a command that pastes as the same arguments', () => {
    expect(renderCommand('/p/pear', ['stage', 'a b', "it's"])).toBe(
      `/p/pear stage 'a b' 'it'\\''s'`,
    );
  });

  it('is pinned to the Pear version of the install job', () => {
    expect(PEAR_VERSION).toBe('3.7.0');
    expect(Object.keys(PEAR_PINS).sort()).toEqual(RELEASE_TARGETS.map((t) => t.name).sort());
  });
});

// ---- the command line ----------------------------------------------------------------------------

describe('a step on a real link', () => {
  const stageArgv = (out: string, ...more: string[]): string[] => [
    'stage',
    '--link',
    LINK_A,
    '--out',
    out,
    ...more,
  ];
  const withDeployment = (): string => {
    const out = tmp();
    mkdirSync(join(out, 'deployment'));
    return out;
  };

  it('is a dry run by default: it prints the command and runs nothing', async () => {
    const out = withDeployment();
    const io = fakeIo();
    expect(await runCli(stageArgv(out), io)).toBe(0);
    expect(io.ran).toEqual([]);
    expect(io.fetched).toBe(0);
    expect(io.asked).toEqual([]);
    const text = io.printed.join('\n');
    expect(text).toMatch(/DRY RUN/);
    expect(text).toContain(
      renderCommand('/pinned/pear', ['stage', '--json', LINK_A, join(out, 'deployment')]),
    );
  });

  it('runs on --execute only after the link is typed back', async () => {
    const out = withDeployment();
    const io = fakeIo({ typed: LINK_A });
    expect(await runCli(stageArgv(out, '--execute'), io)).toBe(0);
    expect(io.asked).toHaveLength(1);
    expect(io.asked[0]).toContain(LINK_A);
    expect(io.ran).toEqual([['stage', '--json', LINK_A, join(out, 'deployment')]]);
  });

  it('runs nothing when the wrong link is typed', async () => {
    const out = withDeployment();
    const io = fakeIo({ typed: LINK_B });
    await refused(runCli(stageArgv(out, '--execute'), io), /not the link/);
    expect(io.ran).toEqual([]);
    expect(io.fetched).toBe(0);
  });

  it.each([{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }, { CI: '' }])(
    'refuses --execute on CI (%o) before it asks anything',
    async (env) => {
      const out = withDeployment();
      const io = fakeIo({ env, typed: LINK_A });
      await refused(runCli(stageArgv(out, '--execute'), io), /public DHT/);
      expect(io.asked).toEqual([]);
      expect(io.ran).toEqual([]);
    },
  );

  it.each([
    [
      'provision',
      [
        'provision',
        '--source',
        `pear://0.9.${'n'.repeat(52)}`,
        '--target',
        LINK_B,
        '--production',
        VERLINK_A,
        '--out',
        '/release',
      ],
    ],
    ['seed', ['seed', '--link', LINK_A]],
  ])('%s is gated the same way', async (_n, argv) => {
    const dry = fakeIo();
    expect(await runCli(argv, dry)).toBe(0);
    expect(dry.ran).toEqual([]);
    const ci = fakeIo({ env: { CI: 'true' }, typed: LINK_A });
    await refused(runCli([...argv, '--execute'], ci), /public DHT/);
    expect(ci.ran).toEqual([]);
  });

  it('provision records what it supersedes, for notice-draft', async () => {
    const out = tmp();
    const argv = [
      'provision',
      '--source',
      `pear://0.9.${'n'.repeat(52)}`,
      '--target',
      LINK_A,
      '--production',
      `pear://0.3.${KEY_B}`,
      '--out',
      out,
      '--execute',
    ];
    await refused(runCli(argv, fakeIo({ typed: LINK_A })), /holds no release/);
    writeFileSync(join(out, 'release.json'), '{}');
    expect(await runCli(argv, fakeIo({ typed: LINK_A }))).toBe(0);
    expect(JSON.parse(readFileSync(join(out, 'provisioned.json'), 'utf8'))).toEqual({
      supersedes: `pear://0.3.${KEY_B}`,
    });
    writeFileSync(join(out, 'committed.json'), '{}');
    await refused(runCli(argv, fakeIo({ typed: LINK_A })), /committed already/);
  });

  it('provision refuses a production verlink of another link', async () => {
    const argv = [
      'provision',
      '--source',
      `pear://0.9.${'n'.repeat(52)}`,
      '--target',
      LINK_A,
      '--production',
      `pear://0.3.${'d'.repeat(52)}`,
      '--out',
      tmp(),
      '--execute',
    ];
    const io = fakeIo({ typed: LINK_A });
    await refused(runCli(argv, io), /not a version of this source's production link/);
    expect(io.asked).toEqual([]);
  });

  it('stage refuses the production link itself', async () => {
    const out = withDeployment();
    await refused(
      runCli(['stage', '--link', LINK_B, '--out', out], fakeIo()),
      /production changes only by a multisig/,
    );
  });

  it('nothing runs from a source with no production link', async () => {
    const out = withDeployment();
    const io = fakeIo({ typed: LINK_A, production: null });
    await refused(runCli(stageArgv(out, '--execute'), io), /no production link/);
    expect(io.asked).toEqual([]);
    expect(io.ran).toEqual([]);
    // A dry run still shows the command.
    expect(await runCli(stageArgv(out), fakeIo({ production: null }))).toBe(0);
  });

  describe('multisig', () => {
    const config = (): string => {
      const f = join(tmp(), 'pear.json');
      writeFileSync(f, '{}');
      return f;
    };
    /** A release folder that `provision` recorded. */
    const provisioned = (o: { unsigned?: readonly string[] } = {}): string => {
      const out = tmp();
      writeFileSync(
        join(out, 'provisioned.json'),
        JSON.stringify({ supersedes: `pear://0.3.${KEY_B}` }),
      );
      releaseFile(out, o);
      return out;
    };
    const commitArgv = (c: string, out = provisioned()): string[] => [
      'multisig',
      'commit',
      '--config',
      c,
      '--source',
      LINK_A,
      '--production',
      LINK_B,
      '--out',
      out,
      '--request',
      REQUEST,
      '--response',
      RESPONSE,
      '--response',
      RESPONSE,
    ];

    it('takes every response, in order', () => {
      expect(parseOptions(['--response', 'a', '--response', 'b']).responses).toEqual(['a', 'b']);
    });

    it('a commit is a dry run by default', async () => {
      const io = fakeIo();
      expect(await runCli(commitArgv(config()), io)).toBe(0);
      expect(io.ran).toEqual([]);
      expect(io.printed.join('\n')).toContain(`type this link back: ${LINK_B}`);
    });

    it('commits only when the config derives the link typed, and records the verlink', async () => {
      const io = fakeIo({ typed: LINK_B, derived: LINK_B, signingPolicy: () => SIGNERS_PINNED });
      const out = provisioned();
      expect(await runCli([...commitArgv(config(), out), '--execute'], io)).toBe(0);
      expect(io.ran.map((a) => a.slice(0, 2))).toEqual([
        ['multisig', 'link'],
        ['multisig', 'commit'],
      ]);
      expect(io.printed.join('\n')).toContain(`production verlink: pear://0.7.${KEY_B}`);
      expect(JSON.parse(readFileSync(join(out, 'committed.json'), 'utf8'))).toMatchObject({
        production: LINK_B,
        verlink: `pear://0.7.${KEY_B}`,
      });
      // One commit per release folder.
      const again = fakeIo({ typed: LINK_B, derived: LINK_B, signingPolicy: () => SIGNERS_PINNED });
      await refused(
        runCli([...commitArgv(config(), out), '--execute'], again),
        /committed already/,
      );
      expect(again.ran).toEqual([]);
    });

    describe('macOS: signed by the owner, and only with a Team ID unless ad hoc was chosen', () => {
      it('refuses while no Team ID is pinned, before asking anything', async () => {
        const io = fakeIo({ typed: LINK_B, derived: LINK_B });
        await refused(
          runCli([...commitArgv(config()), '--execute'], io),
          /^macOS is not released ad hoc: no Apple Team ID is pinned\..* Nothing was committed\.$/,
        );
        expect(io.asked).toEqual([]);
        expect(io.ran).toEqual([]);
      });

      it.each([
        ['a Team ID pinned', SIGNERS_PINNED],
        ['ad hoc chosen in a reviewed change (a test policy here)', AD_HOC_CHOSEN],
      ])('refuses a macOS package as CI built it, even with %s', async (_n, policy) => {
        const io = fakeIo({ typed: LINK_B, derived: LINK_B, signingPolicy: () => policy });
        await refused(
          runCli(
            [...commitArgv(config(), provisioned({ unsigned: ['darwin-x64'] })), '--execute'],
            io,
          ),
          /^darwin-x64 has no signed package in .*release\.json: CI's own macOS build has no hardened runtime, and it never ships\..* Nothing was committed\.$/,
        );
        expect(io.ran).toEqual([]);
      });

      it('commits with ad hoc chosen and every macOS package signed', async () => {
        const io = fakeIo({ typed: LINK_B, derived: LINK_B, signingPolicy: () => AD_HOC_CHOSEN });
        expect(await runCli([...commitArgv(config()), '--execute'], io)).toBe(0);
      });

      it('production says no today: no Team ID, and ad hoc not chosen', () => {
        expect(productionSigningPolicy()).toMatchObject({
          appleTeamId: null,
          allowAdHocMacosRelease: false,
        });
        const dir = tmp();
        releaseFile(dir);
        expect(() => {
          assertReleasable(readRelease(dir), 'r', productionSigningPolicy(), 'x');
        }).toThrow(noTeamIdRefusal('x'));
        expect(() => {
          assertReleasable(readRelease(dir), 'r', SIGNERS_PINNED, 'x');
        }).not.toThrow();
        releaseFile(dir, { unsigned: ['darwin-arm64'] });
        expect(() => {
          assertReleasable(readRelease(dir), 'r', SIGNERS_PINNED, 'x');
        }).toThrow(unsignedMacRefusal('darwin-arm64', 'r', 'x'));
      });
    });

    describe('Windows: signed by the owner, and only with a certificate pinned', () => {
      it('refuses while no certificate is pinned, before asking anything', async () => {
        const io = fakeIo({
          typed: LINK_B,
          derived: LINK_B,
          signingPolicy: () => NO_WINDOWS_SIGNER,
        });
        const p = runCli([...commitArgv(config()), '--execute'], io);
        await refused(p, /^Windows is not released unsigned: .* Nothing was committed\.$/);
        await expect(p).rejects.toThrow(noWindowsSignerRefusal('Nothing was committed.'));
        expect(io.asked).toEqual([]);
        expect(io.ran).toEqual([]);
      });

      it('has no ad-hoc way out: ad hoc chosen for macOS still needs a Windows certificate', async () => {
        const io = fakeIo({
          typed: LINK_B,
          derived: LINK_B,
          signingPolicy: () => ({ ...AD_HOC_CHOSEN, windowsSigner: null }),
        });
        await refused(
          runCli([...commitArgv(config()), '--execute'], io),
          /^Windows is not released unsigned: /,
        );
        expect(io.ran).toEqual([]);
      });

      it.each([
        ['a Team ID and a certificate pinned', SIGNERS_PINNED],
        ['ad hoc chosen for macOS and a certificate pinned', AD_HOC_CHOSEN],
      ])('refuses the .msix as CI built it, even with %s', async (_n, policy) => {
        const io = fakeIo({ typed: LINK_B, derived: LINK_B, signingPolicy: () => policy });
        const out = provisioned({ unsigned: ['win32-x64'] });
        const p = runCli([...commitArgv(config(), out), '--execute'], io);
        await refused(
          p,
          /^win32-x64 has no signed package in .*release\.json: CI's own \.msix is unsigned, and it does not install for users\..* Nothing was committed\.$/,
        );
        await expect(p).rejects.toThrow(
          unsignedWindowsRefusal('win32-x64', join(out, 'release.json'), 'Nothing was committed.'),
        );
        expect(io.ran).toEqual([]);
        expect(existsSync(join(out, 'committed.json'))).toBe(false);
      });

      it('commits with a certificate pinned and every macOS and Windows package signed', async () => {
        const io = fakeIo({ typed: LINK_B, derived: LINK_B, signingPolicy: () => SIGNERS_PINNED });
        const out = provisioned();
        expect(await runCli([...commitArgv(config(), out), '--execute'], io)).toBe(0);
        expect(io.ran.map((a) => a.slice(0, 2))).toEqual([
          ['multisig', 'link'],
          ['multisig', 'commit'],
        ]);
        expect(existsSync(join(out, 'committed.json'))).toBe(true);
      });

      it('production says no today: no certificate pinned', () => {
        expect(productionSigningPolicy().windowsSigner).toBeNull();
        const dir = tmp();
        releaseFile(dir);
        // macOS is refused first today; with it out of the way, Windows still is.
        expect(() => {
          assertReleasable(readRelease(dir), 'r', NO_WINDOWS_SIGNER, 'x');
        }).toThrow(noWindowsSignerRefusal('x'));
        expect(() => {
          assertReleasable(readRelease(dir), 'r', SIGNERS_PINNED, 'x');
        }).not.toThrow();
        releaseFile(dir, { unsigned: ['win32-x64'] });
        expect(() => {
          assertReleasable(readRelease(dir), 'r', SIGNERS_PINNED, 'x');
        }).toThrow(unsignedWindowsRefusal('win32-x64', 'r', 'x'));
      });

      it('a signed entry that names no package is not one: CI’s own would ship', () => {
        const dir = tmp();
        releaseFile(dir);
        const good = readRelease(dir);
        for (const target of ['darwin-arm64', 'win32-x64'])
          for (const signed of [null, {}, { app: '', digest: '1'.repeat(64) }, { app: 'x' }]) {
            const release = {
              ...good,
              targets: good.targets.map((r) =>
                r.target === target ? ({ ...r, signed } as unknown as typeof r) : r,
              ),
            };
            expect(() => {
              assertReleasable(release, 'r', SIGNERS_PINNED, 'x');
            }).toThrow(
              target === 'win32-x64'
                ? unsignedWindowsRefusal(target, 'r', 'x')
                : unsignedMacRefusal(target, 'r', 'x'),
            );
          }
      });

      it('has a Windows target to hold to it', () => {
        expect(RELEASE_TARGETS.filter((t) => t.platform === 'win32').map((t) => t.name)).toEqual([
          'win32-x64',
        ]);
      });
    });

    it('commits nothing for a release folder provision did not record', async () => {
      const io = fakeIo({ typed: LINK_B, derived: LINK_B });
      await refused(
        runCli([...commitArgv(config(), tmp()), '--execute'], io),
        /provisioned\.json is missing/,
      );
      expect(io.ran).toEqual([]);
    });

    it('refuses when the signers’ config derives another link, and commits nothing', async () => {
      const io = fakeIo({ typed: LINK_B, derived: LINK_A, signingPolicy: () => SIGNERS_PINNED });
      await refused(runCli([...commitArgv(config()), '--execute'], io), /derives/);
      expect(io.ran.map((a) => a[1])).toEqual(['link']);
    });

    it('asks Pear for the link only after the link is typed back', async () => {
      const io = fakeIo({ typed: LINK_A, derived: LINK_B, signingPolicy: () => SIGNERS_PINNED });
      await refused(runCli([...commitArgv(config()), '--execute'], io), /not the link/);
      expect(io.ran).toEqual([]);
      expect(io.fetched).toBe(0);
    });

    it('refuses when `pear multisig link` fails, whatever it printed', async () => {
      const io = fakeIo({ typed: LINK_B, linkCode: 3, signingPolicy: () => SIGNERS_PINNED });
      await refused(runCli([...commitArgv(config()), '--execute'], io), /exited 3/);
      expect(io.ran.map((a) => a[1])).toEqual(['link']);
    });

    it('refuses a --production that is not this source’s production link', async () => {
      const io = fakeIo({ typed: LINK_A, production: LINK_A });
      await refused(
        runCli([...commitArgv(config()), '--execute'], io),
        /this source's production link/,
      );
      expect(io.asked).toEqual([]);
      expect(io.ran).toEqual([]);
    });

    it('refuses on CI before it even asks Pear for the link', async () => {
      const io = fakeIo({ env: { GITHUB_ACTIONS: 'true' }, typed: LINK_B });
      await refused(runCli([...commitArgv(config()), '--execute'], io), /public DHT/);
      expect(io.fetched).toBe(0);
    });

    it('has no signing command, and takes no key', async () => {
      await refused(
        runCli(['multisig', 'sign', '--config', config()], fakeIo()),
        /request, verify/,
      );
      for (const flag of ['--secret', '--private-key', '--password', '--key'])
        expect(() => parseOptions([flag, 'x'])).toThrow(ReleaseRefusal);
    });
  });

  it('refuses an unknown command and an unknown option', async () => {
    await refused(runCli(['publish'], fakeIo()), /usage/);
    await refused(runCli(['seed', '--link', LINK_A, '--force', 'x'], fakeIo()), /unknown/);
  });
});

// ---- the digest ----------------------------------------------------------------------------------

/** The app's own gate, deciding on a build whose files are on this disk. */
async function gateDecides(
  next: string,
  host: string,
  name: string,
  notice: object,
  root: TrustRoot,
): Promise<UpdateStatus[]> {
  const seen: UpdateStatus[] = [];
  const app = join(next, 'by-arch', host, 'app', name);
  const gate = new UpdateGate({
    root,
    updater: {
      next,
      nextVersion: '0.2.0',
      app,
      applyUpdate: () => Promise.resolve(),
    },
    host,
    name,
    artifact: artifactName(host, name),
    proof: 'sha256',
    hash: digestOf,
    fetchNotices: () => Promise.resolve({ events: [notice], reached: 1 }),
    readFloor: () => Promise.resolve(null),
    writeFloor: () => Promise.resolve(),
    now: () => 1_800_000_000_000,
    status: (s) => seen.push(s),
    join: (...p) => join(...p),
    basename: (p) => basename(p),
  });
  await gate.onUpdated();
  return seen;
}

function writeTree(dir: string): void {
  mkdirSync(join(dir, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(dir, 'Contents', 'Info.plist'), 'plist');
  writeFileSync(join(dir, 'Contents', 'MacOS', 'Nutflix'), 'exe');
  chmodSync(join(dir, 'Contents', 'MacOS', 'Nutflix'), 0o755);
  chmodSync(join(dir, 'Contents', 'Info.plist'), 0o644);
  if (process.platform !== 'win32') symlinkSync('MacOS/Nutflix', join(dir, 'Contents', 'link'));
}

type TreeEntry =
  | { path: string; kind: 'file'; exec: boolean; text: string }
  | { path: string; kind: 'link'; target: string };

const MEMORY_ROOT = '/bundle';

/** A bundle in memory: a file's mode and a symlink mean the same on every OS the tests run on. */
function memoryFs(entries: readonly TreeEntry[]): HashFs {
  const at = (p: string): string => p.slice(MEMORY_ROOT.length + 1);
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const stat = (kind: 'file' | 'dir' | 'link', mode: number): HashStat => ({
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'link',
    mode,
  });
  return {
    lstat: (p) => {
      const e = byPath.get(at(p));
      if (e === undefined) return Promise.resolve(stat('dir', 0o755));
      return Promise.resolve(
        e.kind === 'link' ? stat('link', 0o777) : stat('file', e.exec ? 0o755 : 0o644),
      );
    },
    readdir: (p) => {
      const prefix = p === MEMORY_ROOT ? '' : `${at(p)}/`;
      const names = entries
        .filter((e) => e.path.startsWith(prefix))
        .map((e) => e.path.slice(prefix.length).split('/')[0] ?? '');
      return Promise.resolve([...new Set(names)]);
    },
    readlink: (p) => {
      const e = byPath.get(at(p));
      return e?.kind === 'link'
        ? Promise.resolve(e.target)
        : Promise.reject(new Error('not a link'));
    },
    read: (p) => {
      const e = byPath.get(at(p));
      if (e?.kind !== 'file') throw new Error('not a file');
      const bytes = Buffer.from(e.text);
      return (async function* (): AsyncGenerator<Uint8Array> {
        await Promise.resolve();
        yield bytes;
      })();
    },
    join: (a, b) => `${a}/${b}`,
  };
}

describe('the digest', () => {
  const sk = generateSecretKey();
  const root = parseTrustRoot({
    v: 1,
    channel: 'test',
    pubkey: getPublicKey(sk),
    relays: ['ws://127.0.0.1:7777'],
    upgrade: LINK_A,
    dht: ['127.0.0.1:49737'],
    delayMs: 0,
  });

  it.each(RELEASE_TARGETS.filter((t) => t.name !== 'darwin-x64' && t.name !== 'linux-arm64'))(
    'is what the update gate computes for $file',
    async (t) => {
      const next = join(tmp(), '12.0');
      const app = join(next, ...deploymentEntry(t).split('/'));
      mkdirSync(dirname(app), { recursive: true });
      if (t.file.endsWith('.app')) writeTree(app);
      else writeFileSync(app, `the bytes of ${t.file}`);
      const sha256 = await digestOf(app);
      const draft = noticeDraft({
        version: '0.2.0',
        verlink: VERLINK_A,
        createdAt: 1_800_000_000,
        artifacts: [{ name: t.noticeName, sha256, bytes: await artifactBytes(app) }],
        expectedLink: LINK_A,
      });
      const signed = finalizeEvent(
        {
          kind: draft.kind,
          created_at: draft.created_at,
          tags: draft.tags.map((x) => [...x]),
          content: draft.content,
        },
        sk,
      );
      const seen = await gateDecides(next, t.name, t.file, signed, root);
      expect(seen[seen.length - 1]).toMatchObject({ state: 'applied', proof: 'sha256' });

      // One bit off and the same gate holds it.
      const wrong = sha256.replace(/^./, (c) => (c === '0' ? '1' : '0'));
      const bad = noticeDraft({
        version: '0.2.0',
        verlink: VERLINK_A,
        createdAt: 1_800_000_001,
        artifacts: [{ name: t.noticeName, sha256: wrong, bytes: 1 }],
        expectedLink: LINK_A,
      });
      const held = await gateDecides(
        next,
        t.name,
        t.file,
        finalizeEvent(
          {
            kind: bad.kind,
            created_at: bad.created_at,
            tags: bad.tags.map((x) => [...x]),
            content: bad.content,
          },
          sk,
        ),
        root,
      );
      expect(held[held.length - 1]).toMatchObject({ state: 'held', reason: 'hash-mismatch' });
    },
  );

  it('hashes a file as the sha256 of its bytes', async () => {
    const f = join(tmp(), 'Nutflix.AppImage');
    writeFileSync(f, 'abc');
    expect(await digestOf(f)).toBe(createHash('sha256').update('abc').digest('hex'));
    expect(await artifactBytes(f)).toBe(3);
  });

  it('hashes a bundle as the sorted JSON lines of hash.ts', async () => {
    const sha = (x: string): string => createHash('sha256').update(x).digest('hex');
    const fs = memoryFs([
      { path: 'Contents/MacOS/Nutflix', kind: 'file', exec: true, text: 'exe' },
      { path: 'Contents/Info.plist', kind: 'file', exec: false, text: 'plist' },
      { path: 'Contents/link', kind: 'link', target: 'MacOS/Nutflix' },
    ]);
    const lines = [
      ['Contents/Info.plist', 'file', false, sha('plist')],
      ['Contents/MacOS/Nutflix', 'file', true, sha('exe')],
      ['Contents/link', 'link', false, 'MacOS/Nutflix'],
    ]
      .map((l) => `${JSON.stringify(l)}\n`)
      .join('');
    expect(await artifactDigest(fs, nodeSha256, MEMORY_ROOT)).toBe(sha(lines));
  });

  it('counts a bundle’s regular files as its size', async () => {
    const dir = join(tmp(), 'Nutflix.app');
    writeTree(dir);
    expect(await artifactBytes(dir)).toBe('plist'.length + 'exe'.length);
  });

  it('compares the deployment with the package it was made from', async () => {
    const [t] = RELEASE_TARGETS;
    if (t === undefined) throw new Error('no target');
    const d = tmp();
    const entry = join(d, 'deployment', ...deploymentEntry(t).split('/'));
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, 'same');
    const recorded = await digestOf(entry);
    const ok = await digestTargets(join(d, 'deployment'), () => recorded, [t]);
    expect(ok[0]).toMatchObject({ name: t.noticeName, bytes: 4 });
    writeFileSync(entry, 'other');
    await refused(
      digestTargets(join(d, 'deployment'), () => recorded, [t]),
      /not the package/,
    );
    await refused(
      digestTargets(join(d, 'nothing'), () => recorded, [t]),
      /has no/,
    );
  });
});

// ---- the notice draft ----------------------------------------------------------------------------

interface Vector {
  input: {
    version: string;
    verlink: string;
    commit: string;
    createdAt: number;
    artifacts: Digest[];
  };
  unsigned: {
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
    sig: string;
  };
  signed: {
    id: string;
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
    sig: string;
  };
  bundle: {
    name: string;
    sha256: string;
    bytes: number;
    entries: TreeEntry[];
  };
}

const VECTOR = JSON.parse(
  readFileSync(new URL('fixtures/nutflix-runtime-notice.vector.json', import.meta.url), 'utf8'),
) as Vector;

const FIVE: Digest[] = RELEASE_TARGETS.map((t, i) => ({
  name: t.noticeName,
  sha256: String(i).repeat(64),
  bytes: 1000 + i,
}));

describe('the notice draft', () => {
  const base = {
    version: '0.2.0',
    verlink: VERLINK_A,
    createdAt: 1_800_000_000,
    artifacts: FIVE,
    expectedLink: LINK_A,
  };

  it('is unsigned, for the release key, in the shape the app reads', () => {
    const d = releaseNoticeDraft(base);
    expect(d).toMatchObject({ id: '', sig: '', pubkey: RELEASE_PUBKEY, kind: NOTICE_KIND });
    expect(d.tags[0]).toEqual(['d', NOTICE_D]);
    expect(d.tags.filter((t) => t[0] === 'artifact')).toHaveLength(5);
    expect(d.content).toBe(sumsText(FIVE));
  });

  it('parses with the app’s own notice.ts once a throwaway key has signed it', () => {
    const sk = generateSecretKey();
    const root = parseTrustRoot({
      v: 1,
      channel: 'test',
      pubkey: getPublicKey(sk),
      relays: ['ws://127.0.0.1:7777'],
      upgrade: LINK_A,
      dht: ['127.0.0.1:49737'],
      delayMs: 0,
    });
    const d = releaseNoticeDraft({ ...base, commit: 'ab'.repeat(20) });
    const signed = finalizeEvent(
      {
        kind: d.kind,
        created_at: d.created_at,
        tags: d.tags.map((t) => [...t]),
        content: d.content,
      },
      sk,
    );
    const r = readNotice(signed, root, 1_800_000_000);
    expect(r.refused).toBeUndefined();
    expect(r.notice?.version).toBe('0.2.0');
    expect(r.notice?.verlink).toBe(VERLINK_A);
    expect(r.notice?.artifacts.size).toBe(5);
    for (const a of FIVE)
      expect(r.notice?.artifacts.get(a.name)).toEqual({ sha256: a.sha256, bytes: a.bytes });
  });

  it('sorts bytewise and adds up the sizes', () => {
    const d = noticeDraft({ ...base, artifacts: [...FIVE].reverse() });
    const names = d.tags.filter((t) => t[0] === 'artifact').map((t) => t[1]);
    expect(names).toEqual([...names].sort());
    expect(d.tags.find((t) => t[0] === 'size')?.[1]).toBe(
      String(FIVE.reduce((n, a) => n + a.bytes, 0)),
    );
    expect(d.tags.find((t) => t[0] === 'x')?.[1]).toBe(
      createHash('sha256').update(d.content).digest('hex'),
    );
  });

  it.each([
    ['a bad version', { version: '1.2' }],
    ['a prerelease', { version: '1.2.3-rc.1' }],
    ['an unversioned link', { verlink: LINK_A }],
    ['a version of another link', { verlink: `pear://0.12.${KEY_B}` }],
    ['an empty version', { verlink: `pear://0.0.${KEY_A}` }],
    ['an expected link that is not a link', { expectedLink: 'pear://nope' }],
    ['a short commit', { commit: 'abc123' }],
    ['no time', { createdAt: 0 }],
    ['no artifacts', { artifacts: [] }],
    [
      'a name no target has',
      { artifacts: [{ name: 'evil.exe', sha256: 'a'.repeat(64), bytes: 1 }] },
    ],
    ['a name twice', { artifacts: [FIVE[0], FIVE[0]] as Digest[] }],
    ['a digest that is not one', { artifacts: [{ ...FIVE[0]!, sha256: 'xyz' }] }],
  ])('refuses %s', (_n, over) => {
    expect(() => noticeDraft({ ...base, ...over })).toThrow(ReleaseRefusal);
  });

  it('a release names all five', () => {
    expect(() => releaseNoticeDraft({ ...base, artifacts: FIVE.slice(0, 4) })).toThrow(/five/);
  });

  describe('the notice-draft command', () => {
    const COMMIT = 'ab'.repeat(20);
    /** A release folder after `digest`, `provision` and `multisig commit`. */
    const withDigests = (
      o: { committed?: string; supersedes?: string; production?: string } = {},
    ): string => {
      const out = tmp();
      writeFileSync(
        join(out, 'digests.json'),
        JSON.stringify({
          schema: 'nutflix-runtime-digests/2',
          version: '0.2.0',
          commit: COMMIT,
          artifacts: FIVE,
        }),
      );
      writeFileSync(
        join(out, 'provisioned.json'),
        JSON.stringify({ supersedes: o.supersedes ?? `pear://0.5.${KEY_A}` }),
      );
      writeFileSync(
        join(out, 'committed.json'),
        JSON.stringify({ production: o.production ?? LINK_A, verlink: o.committed ?? VERLINK_A }),
      );
      releaseFile(out);
      return out;
    };
    const argv = (out: string): string[] => ['notice-draft', '--out', out];
    const withLinkA = (): FakeIo =>
      fakeIo({ production: LINK_A, signingPolicy: () => SIGNERS_PINNED });

    it('drafts nothing while no Team ID is pinned, or for a macOS package as CI built it', async () => {
      const out = withDigests();
      await refused(
        runCli(argv(out), fakeIo({ production: LINK_A })),
        /^macOS is not released ad hoc: .* No notice was drafted\.$/,
      );
      releaseFile(out, { unsigned: ['darwin-arm64'] });
      await refused(
        runCli(argv(out), withLinkA()),
        /^darwin-arm64 has no signed package in .* No notice was drafted\.$/,
      );
      expect(existsSync(join(out, 'release-event.unsigned.json'))).toBe(false);
    });

    it('drafts nothing while no Windows certificate is pinned, or for the .msix as CI built it', async () => {
      const out = withDigests();
      await refused(
        runCli(argv(out), fakeIo({ production: LINK_A, signingPolicy: () => NO_WINDOWS_SIGNER })),
        /^Windows is not released unsigned: .* No notice was drafted\.$/,
      );
      releaseFile(out, { unsigned: ['win32-x64'] });
      await refused(
        runCli(argv(out), withLinkA()),
        /^win32-x64 has no signed package in .* No notice was drafted\.$/,
      );
      expect(existsSync(join(out, 'release-event.unsigned.json'))).toBe(false);
    });

    it('writes it once, unsigned, with the commit the packages carry', async () => {
      const out = withDigests();
      expect(await runCli([...argv(out), '--created-at', '1800000000'], withLinkA())).toBe(0);
      const ev = JSON.parse(readFileSync(join(out, 'release-event.unsigned.json'), 'utf8')) as {
        id: string;
        sig: string;
        created_at: number;
        tags: string[][];
      };
      expect(ev).toMatchObject({ id: '', sig: '', created_at: 1_800_000_000 });
      expect(ev.tags.find((t) => t[0] === 'commit')).toEqual(['commit', COMMIT]);
      await refused(runCli(argv(out), withLinkA()), /exists/);
    });

    it('takes no commit from the command line', async () => {
      await refused(
        runCli([...argv(withDigests()), '--commit', 'cd'.repeat(20)], withLinkA()),
        /the commit is the one the packages carry/,
      );
    });

    it('refuses while the source has no production link', async () => {
      const out = withDigests();
      await refused(runCli(argv(out), fakeIo({ production: null })), /no production link/);
      expect(existsSync(join(out, 'release-event.unsigned.json'))).toBe(false);
    });

    it('names the version multisig commit recorded, and takes none from the command line', async () => {
      const out = withDigests();
      await refused(
        runCli([...argv(out), '--verlink', VERLINK_A], withLinkA()),
        /the version is the one `multisig commit` recorded/,
      );
      expect(await runCli(argv(out), withLinkA())).toBe(0);
      const ev = JSON.parse(readFileSync(join(out, 'release-event.unsigned.json'), 'utf8')) as {
        tags: string[][];
      };
      expect(ev.tags.find((t) => t[0] === 'verlink')).toEqual(['verlink', VERLINK_A]);
    });

    it.each([
      ['a version of another link', { committed: `pear://0.12.${KEY_B}` }, /for another link/],
      ['a commit recorded for another link', { production: LINK_B }, /for another link/],
      ['the version it supersedes', { supersedes: VERLINK_A }, /is not newer than/],
      ['an older version', { supersedes: `pear://0.13.${KEY_A}` }, /is not newer than/],
      ['a supersedes of another link', { supersedes: `pear://0.5.${KEY_B}` }, /another link/],
    ])('refuses %s', async (_n, o, re) => {
      const out = withDigests(o);
      await refused(runCli(argv(out), withLinkA()), re);
      expect(existsSync(join(out, 'release-event.unsigned.json'))).toBe(false);
    });

    it('refuses a release that was not provisioned and committed with --out', async () => {
      for (const missing of ['provisioned.json', 'committed.json']) {
        const out = withDigests();
        rmSync(join(out, missing));
        await refused(runCli(argv(out), withLinkA()), new RegExp(`${missing} is missing`));
      }
      expect(() => committedVersion(tmp(), LINK_A)).toThrow(ReleaseRefusal);
    });

    it('a signer refuses, before fetching anything, a release that may not ship', async () => {
      const argv = (signedTargets: readonly string[], execute = true): string[] => [
        'verify-request',
        '--run',
        '1',
        '--commit',
        'ab'.repeat(20),
        '--config',
        '/c/pear.json',
        '--verlink',
        VERLINK_A,
        '--request',
        REQUEST,
        '--work',
        tmp(),
        ...signedTargets.flatMap((t) => ['--signed-target', t]),
        ...(execute ? ['--execute'] : []),
      ];
      const both = ['darwin-arm64', 'darwin-x64'];
      const all = [...both, 'win32-x64'];
      await refused(
        runCli(argv(all), fakeIo()),
        /^macOS is not released ad hoc: no Apple Team ID is pinned\..* Do not sign\.$/,
      );
      const io = fakeIo({ signingPolicy: () => SIGNERS_PINNED });
      await refused(
        runCli(argv(['darwin-arm64', 'win32-x64']), io),
        /^darwin-x64 is not named with --signed-target: .* Do not sign\.$/,
      );
      // Windows: a certificate pinned, and the .msix named as signed. No ad-hoc way out.
      const noCert = fakeIo({ signingPolicy: () => NO_WINDOWS_SIGNER });
      const p = runCli(argv(all), noCert);
      await refused(p, /^Windows is not released unsigned: .* Do not sign\.$/);
      await expect(p).rejects.toThrow(noWindowsSignerRefusal('Do not sign.'));
      await refused(
        runCli(
          argv(all),
          fakeIo({ signingPolicy: () => ({ ...AD_HOC_CHOSEN, windowsSigner: null }) }),
        ),
        /^Windows is not released unsigned: /,
      );
      const unnamed = runCli(argv(both), io);
      await refused(unnamed, /^win32-x64 is not named with --signed-target: .* Do not sign\.$/);
      await expect(unnamed).rejects.toThrow(unnamedWindowsRefusal('win32-x64', 'Do not sign.'));
      // Even a dry run says no: the rule comes before anything else.
      await refused(runCli(argv(both, false), io), /^win32-x64 is not named/);
      for (const f of [io, noCert]) {
        expect(f.asked).toEqual([]);
        expect(f.ran).toEqual([]);
        expect(f.fetched).toBe(0);
      }
      // Every macOS and Windows target named, with both pinned: the gate lets it through.
      const dry = fakeIo({ signingPolicy: () => SIGNERS_PINNED });
      expect(await runCli(argv(all, false), dry)).toBe(0);
      expect(dry.printed[0]).toMatch(/^DRY RUN \(verify-request\)/);
      expect(() => {
        assertSignable(new Set(all), SIGNERS_PINNED, 'x');
      }).not.toThrow();
      expect(() => {
        assertSignable(new Set(all), productionSigningPolicy(), 'x');
      }).toThrow(noTeamIdRefusal('x'));
    });

    it('with a Team ID pinned, a signer off a Mac stops, unless they say another signer checked on a Mac', () => {
      const unchecked = ['darwin-arm64', 'darwin-x64'];
      expect(() => appleCheck({ teamPinned: true, unchecked, withoutAppleCheck: false })).toThrow(
        appleCheckRefusal(unchecked),
      );
      expect(appleCheck({ teamPinned: true, unchecked, withoutAppleCheck: true })).toBe(
        appleCheckWarning(unchecked),
      );
      // Checked on a Mac, or no Team ID (no CMS to check): nothing changes.
      expect(appleCheck({ teamPinned: true, unchecked: [], withoutAppleCheck: false })).toBeNull();
      expect(appleCheck({ teamPinned: false, unchecked, withoutAppleCheck: false })).toBeNull();
      expect(parseOptions(['--without-apple-check']).withoutAppleCheck).toBe(true);
      expect(parseOptions([]).withoutAppleCheck).toBe(false);
    });

    it('tells a signer the exact request to sign, with its hash', () => {
      const lines = signInstruction(REQUEST);
      expect(lines[0]).toContain(createHash('sha256').update(REQUEST).digest('hex').slice(0, 16));
      expect(lines[1]).toBe(`  pear multisig sign ${REQUEST} <your key name>`);
    });

    it('refuses a date ahead of the clock: it would raise every install’s replay floor', async () => {
      const out = withDigests();
      await refused(runCli([...argv(out), '--created-at', '1800000061'], withLinkA()), /future/);
      expect(existsSync(join(out, 'release-event.unsigned.json'))).toBe(false);
      expect(await runCli([...argv(out), '--created-at', '1800000060'], withLinkA())).toBe(0);
    });
  });

  describe('the vector shared with nutflix-pear', () => {
    it('is the pinned file: nutflix-pear pins the same sha256, so neither copy moves alone', () => {
      const bytes = readFileSync(
        new URL('fixtures/nutflix-runtime-notice.vector.json', import.meta.url),
      );
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        'd6299ca3209cdd0032e1609df95e0adf42c9cd923ce3e5fc7465d34595456850',
      );
    });

    it('is what this tool drafts, byte for byte', () => {
      const d = releaseNoticeDraft({
        ...VECTOR.input,
        expectedLink: `pear://${linkKeyOf(VECTOR.input.verlink)}`,
      });
      expect(JSON.stringify(d)).toBe(JSON.stringify(VECTOR.unsigned));
    });

    it('parses with the app’s notice.ts, signed', () => {
      const root = parseTrustRoot({
        v: 1,
        channel: 'test',
        pubkey: VECTOR.signed.pubkey,
        relays: ['ws://127.0.0.1:7777'],
        upgrade: `pear://${linkKeyOf(VECTOR.input.verlink)}`,
        dht: ['127.0.0.1:49737'],
        delayMs: 0,
      });
      const r = readNotice({ ...VECTOR.signed }, root, VECTOR.input.createdAt);
      expect(r.refused).toBeUndefined();
      expect(r.notice?.verlink).toBe(VECTOR.input.verlink);
      expect(r.notice?.artifacts.size).toBe(5);
      expect(r.notice?.artifacts.get(VECTOR.bundle.name)).toEqual({
        sha256: VECTOR.bundle.sha256,
        bytes: VECTOR.bundle.bytes,
      });
    });

    it('its bundle hashes to the digest it names, with hash.ts', async () => {
      const fs = memoryFs(VECTOR.bundle.entries);
      expect(await artifactDigest(fs, nodeSha256, MEMORY_ROOT)).toBe(VECTOR.bundle.sha256);
      const bytes = VECTOR.bundle.entries.reduce(
        (n, e) => n + (e.kind === 'file' ? Buffer.byteLength(e.text) : 0),
        0,
      );
      expect(bytes).toBe(VECTOR.bundle.bytes);
    });
  });
});

// ---- the five packages ---------------------------------------------------------------------------

/** One `.app` bundle holding `root` and `version`, as a stand-in for any target's package. */
function fakeBundle(path: string, version: string, root: TrustRoot): void {
  const app = join(path, 'Contents', 'Resources', 'app');
  mkdirSync(join(app, 'main'), { recursive: true });
  mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(path, 'Contents', 'MacOS', APP.productName), 'exe');
  writeFileSync(join(app, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(app, ...STAGED.updateWorker.split('/')), `x="${encodeBakedRoot(root)}";`);
  const flag = String(root.upgrade !== null);
  writeFileSync(
    join(app, ...STAGED.main.split('/')),
    `x = { updates: ${flag} ? "on" : "off" };\nif (${flag}) await startUpdates();\nconst root = "${encodeBakedRoot(root)}";\n`,
  );
}

describe('reading a package without running it', () => {
  it('reads the version and the baked root of a bundle', () => {
    const p = join(tmp(), 'Nutflix.app');
    fakeBundle(p, '1.2.3', releaseRoot());
    expect(readPackaged(p, 'package.json')).toContain('1.2.3');
    const facts = packageFacts(p);
    expect(facts.version).toBe('1.2.3');
    expect(() => {
      assertProductionRoot(p, facts);
    }).not.toThrow();
  });

  it('refuses a throwaway root as a production build', () => {
    const p = join(tmp(), 'Nutflix.app');
    fakeBundle(p, '1.2.3', throwawayLaunchRoot());
    expect(() => {
      assertProductionRoot(p, packageFacts(p));
    }).toThrow(ReleaseRefusal);
  });

  it('refuses a package with a version that is not a.b.c', () => {
    const p = join(tmp(), 'Nutflix.app');
    fakeBundle(p, 'latest', releaseRoot());
    expect(() => packageFacts(p)).toThrow(ReleaseRefusal);
  });

  it('refuses what it does not know', () => {
    expect(() => readPackaged('/x/thing.deb', 'package.json')).toThrow(ReleaseRefusal);
  });

  it('finds the squashfs of an AppImage after the ELF section headers', () => {
    const f = join(tmp(), 'Nutflix.AppImage');
    const head = Buffer.alloc(0x100);
    head.write('\x7fELF', 0, 'latin1');
    head[4] = 2;
    head[5] = 1;
    head.writeBigUInt64LE(0xc0n, 0x28);
    head.writeUInt16LE(0x10, 0x3a);
    head.writeUInt16LE(4, 0x3c);
    head.write('hsqs', 0x100 - 0x0, 'latin1');
    writeFileSync(f, Buffer.concat([head, Buffer.from('hsqs'), Buffer.alloc(32)]));
    expect(appImageOffset(f)).toBe(0x100);
  });

  it('refuses a file that is not an AppImage', () => {
    const f = join(tmp(), 'Nutflix.AppImage');
    writeFileSync(f, Buffer.alloc(128));
    expect(() => appImageOffset(f)).toThrow(ReleaseRefusal);
    const short = join(tmp(), 'Nutflix.AppImage');
    writeFileSync(short, 'x');
    expect(() => appImageOffset(short)).toThrow(ReleaseRefusal);
  });
});

describe('check and assemble', () => {
  it('names the CI artifact of each target', () => {
    expect(RELEASE_TARGETS.map(inputName).sort()).toEqual([
      'Nutflix-darwin-arm64.app.zip',
      'Nutflix-darwin-x64.app.zip',
      'Nutflix.AppImage',
      'Nutflix.AppImage',
      'Nutflix.msix',
    ]);
  });

  it('reads back only a whole release', () => {
    const out = tmp();
    expect(() => readRelease(out)).toThrow(/missing/);
    writeFileSync(
      join(out, 'release.json'),
      JSON.stringify({
        schema: 'nutflix-runtime-release/2',
        version: '1.0.0',
        commit: 'ab'.repeat(20),
        run: 1,
        targets: [{ target: 'linux-x64', app: '/a', ci: { digest: 'a'.repeat(64), bytes: 1 } }],
      }),
    );
    expect(() => readRelease(out)).toThrow(/five targets/);
    writeFileSync(
      join(out, 'digests.json'),
      JSON.stringify({
        schema: 'nutflix-runtime-digests/2',
        version: '1.0.0',
        commit: 'ab'.repeat(20),
        artifacts: [],
      }),
    );
    expect(() => readDigests(out)).toThrow(/five targets/);
  });
});

// ---- the day the source gets a real link ----------------------------------------------------------

describe('what CI launches', () => {
  const withLink = parseTrustRoot({ ...releaseRoot(), upgrade: LINK_A });
  const bundle = (r: TrustRoot): string => `var root = "${encodeBakedRoot(r)}";`;

  // Not `releaseRoot()`: `update-root.test.ts` is the one test that trips when the link is set.
  const noLink = parseTrustRoot({ ...releaseRoot(), upgrade: null });

  it('with no link in the source: the release build itself', () => {
    expect(launchSubject(noLink, false)).toBe('release-build');
  });

  it('with a link in the source: never the release build', () => {
    expect(launchSubject(withLink, false)).toBe('throwaway-build');
    expect(launchSubject(noLink, true)).toBe('throwaway-build');
  });

  it('the guard still refuses a build with a link, production or test', () => {
    expect(() => {
      assertNoUpgradeLink(bundle(withLink));
    }).toThrow(/public DHT/);
    expect(() => {
      assertNoUpgradeLink(
        bundle(
          parseTrustRoot({
            v: 1,
            channel: 'test',
            pubkey: 'ab'.repeat(32),
            relays: ['ws://127.0.0.1:7777'],
            upgrade: LINK_A,
            dht: ['127.0.0.1:49737'],
            delayMs: 0,
          }),
        ),
      );
    }).toThrow(/public DHT/);
  });

  it('the build launched instead passes the same guard: a throwaway key, and no link', () => {
    const r = throwawayLaunchRoot();
    expect(r).toMatchObject({ channel: 'launch', upgrade: null, dht: null, delayMs: null });
    expect(r.pubkey).not.toBe(RELEASE_PUBKEY);
    expect(r.relays.every((u) => u.startsWith('ws://127.0.0.1:'))).toBe(true);
    expect(() => {
      assertNoUpgradeLink(bundle(r));
    }).not.toThrow();
    expect(throwawayLaunchRoot().pubkey).not.toBe(r.pubkey);
  });

  it('never passes for a production build', () => {
    expect(() => {
      assertReleaseRoot(throwawayLaunchRoot());
    }).toThrow();
  });

  it.each([
    ['a link', { upgrade: LINK_A }],
    ['a DHT', { dht: ['127.0.0.1:49737'] }],
    ['a delay', { delayMs: 0 }],
    ['a public relay', { relays: ['wss://relay.example.org'] }],
  ])('a launch root refuses %s', (_n, over) => {
    expect(() => parseTrustRoot({ ...throwawayLaunchRoot(), ...over })).toThrow();
  });

  it('a launch root refuses the production key', () => {
    const r = parseTrustRoot({ ...throwawayLaunchRoot(), pubkey: RELEASE_PUBKEY });
    expect(() => {
      assertLaunchRoot(r);
    }).toThrow(/production key/);
    expect(() => throwawayRootFromText(JSON.stringify(r))).toThrow(/production key/);
  });

  it('a test root is still refused without a link', () => {
    const noLink = {
      v: 1,
      channel: 'test',
      pubkey: 'ab'.repeat(32),
      relays: ['ws://127.0.0.1:7777'],
      upgrade: null,
      dht: ['127.0.0.1:49737'],
      delayMs: 0,
    };
    expect(() => testRootFromText(JSON.stringify(noLink))).toThrow();
    expect(() => throwawayRootFromText(JSON.stringify(noLink))).toThrow();
  });

  it('builds nothing when the release build may be launched', () => {
    const out = tmp();
    const builds: (readonly string[])[] = [];
    const dir = prepareLaunchOut(
      { platform: 'linux', arch: 'x64', out, rehearse: false },
      noLink,
      (a) => builds.push(a),
    );
    expect(dir).toBe(out);
    expect(builds).toEqual([]);
  });

  it('otherwise makes a test build with a throwaway root, in a directory of its own', () => {
    const out = tmp();
    const builds: (readonly string[])[] = [];
    const dir = prepareLaunchOut(
      { platform: 'linux', arch: 'x64', out, rehearse: false },
      withLink,
      (a) => builds.push(a),
    );
    expect(dir).toBe(`${out}/launch`);
    const args = builds[0] ?? [];
    expect(args).toContain('test-build');
    const rootFile = args[args.indexOf('--update-root') + 1] ?? '';
    const baked = throwawayRootFromText(readFileSync(rootFile, 'utf8'));
    expect(baked.channel).toBe('launch');
    expect(baked.upgrade).toBeNull();
    expect(args[args.indexOf('--appimage-runtime-dir') + 1]).toBe(join(out, 'appimage-runtime'));
    expect(existsSync(rootFile)).toBe(true);
  });

  it('takes only its own options', () => {
    const o = parseSubjectArgs([
      '--platform',
      'linux',
      '--arch',
      'x64',
      '--out',
      '/o',
      '--rehearse',
    ]);
    expect(o).toMatchObject({ platform: 'linux', arch: 'x64', out: '/o', rehearse: true });
    expect(() => parseSubjectArgs(['--platform', 'linux'])).toThrow(/required/);
    expect(() => parseSubjectArgs(['--update-root', 'x'])).toThrow(/unknown/);
  });

  describe('verify-root', () => {
    /** Main's bundle: its updates switch, and the root it holds. */
    const mainWith = (flag: boolean, root: TrustRoot): string =>
      `x = { updates: ${String(flag)} ? "on" : "off" };\nif (${String(flag)}) await startUpdates();\nconst root = "${encodeBakedRoot(root)}";\n`;
    const appWith = (worker: string, main: string): string => {
      const app = tmp();
      mkdirSync(join(app, 'main'));
      writeFileSync(join(app, ...STAGED.updateWorker.split('/')), worker);
      writeFileSync(join(app, ...STAGED.main.split('/')), main);
      return app;
    };

    it('accepts the production root with main’s switch agreeing', async () => {
      const flag = releaseRoot().upgrade !== null;
      const io = fakeIo();
      const app = appWith(bundle(releaseRoot()), mainWith(flag, releaseRoot()));
      expect(await runCli(['verify-root', '--app', app], io)).toBe(0);
      expect(io.printed.join('\n')).toContain(RELEASE_PUBKEY);
    });

    it('refuses any other root', async () => {
      for (const other of [withLink, throwawayLaunchRoot()]) {
        const app = appWith(bundle(other), mainWith(other.upgrade !== null, other));
        await expect(runCli(['verify-root', '--app', app], fakeIo())).rejects.toThrow(
          /release build/,
        );
      }
    });

    it('refuses a main whose switch disagrees with the root', () => {
      expect(() => {
        assertMainMatchesRoot(mainWith(true, noLink), noLink);
      }).toThrow(/not false/);
      expect(() => {
        assertMainMatchesRoot(mainWith(false, withLink), withLink);
      }).toThrow(/not true/);
      expect(() => {
        assertMainMatchesRoot(
          `x = { updates: false ? "on" : "off" };\nif (true) await startUpdates();\nconst root = "${encodeBakedRoot(noLink)}";\n`,
          noLink,
        );
      }).toThrow(/not false/);
    });

    it('refuses a main that does not show its switch', () => {
      expect(() => {
        assertMainMatchesRoot(`const root = "${encodeBakedRoot(noLink)}";`, noLink);
      }).toThrow(/does not show/);
    });

    it('refuses a main that holds no root, two, or another one than the updater', () => {
      const flag = noLink.upgrade !== null;
      const sw = `x = { updates: ${String(flag)} ? "on" : "off" };\nif (${String(flag)}) await startUpdates();\n`;
      expect(() => {
        assertMainMatchesRoot(sw, noLink);
      }).toThrow(/does not hold one update root/);
      expect(() => {
        assertMainMatchesRoot(mainWith(flag, noLink) + mainWith(true, withLink), noLink);
      }).toThrow(/does not hold one update root/);
      expect(() => {
        assertMainMatchesRoot(mainWith(true, withLink), noLink);
      }).toThrow(/another root than the updater/);
    });
  });
});
