/**
 * What the `shell` job launches. A build with a real upgrade link starts an updater on the public
 * DHT, so it is NEVER launched on a runner (`pear-ci/no-updater.ts` refuses it). So:
 *
 *   - The source has no link (today): the release build itself is launched, as a user would run it.
 *   - The source has a link (the day the owner sets one): the release build is only verified from
 *     its bytes (`cli.ts verify-root`), and the job launches a second build of the same source with
 *     a throwaway root and no link. `no-updater.ts` still runs, unchanged, on whatever is launched.
 *
 *   node scripts/release/launch-subject.ts --platform p --arch a --out <dir> [--rehearse]
 *
 * It prints one line for `$GITHUB_ENV`: `LAUNCH_OUT=<dir>`. `--rehearse` takes the second path with
 * no link in the source, which is how CI proves that path before the day comes. It can only make a
 * build with a throwaway root.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

import { PKG_DIR } from '../../packaging/paths.ts';
import { assertLaunchRoot, releaseRoot } from '../../packaging/update-root.ts';
import { parseTrustRoot, type TrustRoot } from '../../src/update/root.ts';

/** A root no one holds the key of: the secret is made here, used for nothing, and dropped. */
export function throwawayLaunchRoot(): TrustRoot {
  const root = parseTrustRoot({
    v: 1,
    channel: 'launch',
    pubkey: getPublicKey(generateSecretKey()),
    relays: ['ws://127.0.0.1:49737'],
    upgrade: null,
    dht: null,
    delayMs: null,
  });
  assertLaunchRoot(root);
  return root;
}

export type LaunchSubject = 'release-build' | 'throwaway-build';

/** A release build with a link is never the thing launched. */
export function launchSubject(release: TrustRoot, rehearse: boolean): LaunchSubject {
  return release.upgrade === null && !rehearse ? 'release-build' : 'throwaway-build';
}

export interface SubjectOptions {
  readonly platform: string;
  readonly arch: string;
  readonly out: string;
  readonly rehearse: boolean;
}

/** Makes the throwaway build when one is needed; returns the directory the job launches from. */
export function prepareLaunchOut(
  o: SubjectOptions,
  release: TrustRoot,
  build: (args: readonly string[]) => void,
): string {
  if (launchSubject(release, o.rehearse) === 'release-build') return o.out;
  // As given: the job uses it in step commands and artifact paths, with `/` on every OS.
  const launchOut = `${o.out}/launch`;
  const out = resolve(launchOut);
  mkdirSync(out, { recursive: true });
  const rootFile = join(out, 'launch-root.json');
  writeFileSync(rootFile, `${JSON.stringify(throwawayLaunchRoot())}\n`);
  const { version } = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
    version: string;
  };
  build([
    join(PKG_DIR, 'scripts', 'package.ts'),
    'test-build',
    '--platform',
    o.platform,
    '--arch',
    o.arch,
    '--out',
    out,
    '--update-root',
    rootFile,
    '--app-version',
    version,
    '--appimage-runtime-dir',
    resolve(o.out, 'appimage-runtime'),
  ]);
  return launchOut;
}

export function parseSubjectArgs(argv: readonly string[]): SubjectOptions {
  const opts = new Map<string, string>();
  let rehearse = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--rehearse') rehearse = true;
    else if (['--platform', '--arch', '--out'].includes(a) && argv[i + 1] !== undefined) {
      opts.set(a, argv[i + 1] ?? '');
      i++;
    } else throw new Error(`unknown or incomplete option ${a}`);
  }
  const need = (k: string): string => {
    const v = opts.get(k);
    if (v === undefined) throw new Error(`${k} is required`);
    return v;
  };
  return {
    platform: need('--platform'),
    arch: need('--arch'),
    out: need('--out'),
    rehearse,
  };
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(PKG_DIR, 'scripts', 'release', 'launch-subject.ts')
) {
  const o = parseSubjectArgs(process.argv.slice(2));
  const dir = prepareLaunchOut(o, releaseRoot(), (args) => {
    // stdout is the job's environment file: the build's output goes to stderr.
    const r = spawnSync(process.execPath, [...args], {
      cwd: PKG_DIR,
      stdio: ['ignore', process.stderr, 'inherit'],
    });
    if (r.status !== 0) throw new Error(`the throwaway build failed: exit ${String(r.status)}`);
  });
  process.stdout.write(`LAUNCH_OUT=${dir}\n`);
}
