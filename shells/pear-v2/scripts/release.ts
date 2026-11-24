/**
 * Stages a release of the pinned `pear run` shell (ADR 0001 shape b) from a clean copy of the
 * commit checked out, so that nothing in this checkout's `node_modules` or `dist/` reaches it:
 *
 *   node shells/pear-v2/scripts/release.ts [--out DIR] [--work DIR]
 *   node shells/pear-v2/scripts/release.ts --test-line <key>:<fork>:<length> [--with-smoke] [--out DIR] [--work DIR]
 *
 * The second form makes a test build the same way (CI and the VM prove the path with it).
 *
 * This file's static imports are `node:*` only, so the process that makes the copy runs no
 * package code of this checkout. It:
 *   1. refuses a checkout with local changes (what is staged is a commit);
 *   2. makes the copy in a private directory: `--work`, else `<XDG cache>/nutflix-runtime/
 *      release-stage`, created 0700, owned by this user, refused if it is open to others or is a
 *      symlink, and refused if any folder above the copy holds a `node_modules` or a `package.json`,
 *      which Node, esbuild and `tsc` would search for anything the copy lacks;
 *   3. exports HEAD and the submodule's pinned commit there (`git archive`, from the local object
 *      stores);
 *   4. for a release, asks the copy's own `stage-checks.ts` and `pins.ts` (which import `node:*` and
 *      each other only) whether an owner's step is still open, before installing anything;
 *   5. runs `npm ci --ignore-scripts` of the root lockfile and `npm run build` in the copy, with
 *      `NODE_OPTIONS` and `NODE_PATH` removed from the environment;
 *   6. stages with the copy's own `stage.ts`, which refuses a release anywhere else.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Read by the copy's `stage.ts`: the copy's root. The same name is in `stage.ts`. */
export const CLEAN_COPY_ENV = 'NUTFLIX_STAGE_CLEAN_COPY';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(PKG, '..', '..');

function fail(msg: string): never {
  throw new Error(`release: ${msg}`);
}

/** Whether `p` names anything, a dangling symlink included. */
function present(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Every `node_modules` and `package.json` in `dir` or any folder above it. */
export function ancestorPlants(dir: string, exists: (p: string) => boolean = present): string[] {
  const out: string[] = [];
  for (let d = resolve(dir); ; d = dirname(d)) {
    for (const name of ['node_modules', 'package.json']) {
      const p = join(d, name);
      if (exists(p)) out.push(p);
    }
    if (dirname(d) === d) return out;
  }
}

/**
 * `dir`, made 0700 if missing, as its real path. Refused unless it is a directory (not a symlink)
 * of this user that no other user can read, write or enter.
 */
export function privateDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) fail(`${dir} is not a directory of its own`);
  if ((st.mode & 0o077) !== 0)
    fail(`${dir} is open to other users (mode ${(st.mode & 0o777).toString(8)}): make it 0700`);
  if (process.getuid !== undefined && st.uid !== process.getuid())
    fail(`${dir} belongs to another user`);
  return realpathSync(dir);
}

/** The default `--work`: under the user's cache, never a shared temporary folder. */
export function defaultWorkDir(env: NodeJS.ProcessEnv = process.env): string {
  const cache = env['XDG_CACHE_HOME'];
  return join(
    cache?.startsWith('/') === true ? cache : join(homedir(), '.cache'),
    'nutflix-runtime',
    'release-stage',
  );
}

/** The environment the copy's npm and Node run with: no injected options or module paths. */
function copyEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, npm_config_ignore_scripts: 'true', ...extra };
  delete env['NODE_OPTIONS'];
  delete env['NODE_PATH'];
  return env;
}

/** Runs `file args` in `cwd`; its stdout, or a failure naming `what` with its output's tail. */
function run(file: string, args: readonly string[], cwd: string, what: string): string {
  const r = spawnSync(file, [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: copyEnv(),
  });
  if (r.status !== 0) fail(`${what} failed:\n${(r.stderr || r.stdout || '').slice(-2000)}`);
  return r.stdout;
}

/** `git archive` of `commit` in `repo`, unpacked into `to`. From the local object store only. */
function unpack(repo: string, commit: string, to: string): void {
  mkdirSync(to, { recursive: true });
  run(
    'bash',
    [
      '-c',
      'set -euo pipefail; git -C "$1" archive --format=tar "$2" | tar -x -C "$3"',
      'unpack',
      repo,
      commit,
      to,
    ],
    REPO,
    `exporting ${commit}`,
  );
}

interface ReleaseChecks {
  releaseRefusals(o: { line: unknown; uiDrive: string }): string[];
}
interface ReleasePins {
  RELEASE_LINE: unknown;
  UI_DRIVE: string;
}

async function main(argv: readonly string[]): Promise<void> {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv[i + 1];
  };
  const testLine = arg('--test-line');
  const smoke = argv.includes('--with-smoke');
  if (smoke && testLine === undefined) fail('--with-smoke is for test builds only');
  const out = resolve(arg('--out') ?? join(PKG, 'out', 'app'));

  const git = (a: readonly string[], what: string): string =>
    run('git', ['-C', REPO, ...a], REPO, what).trim();
  const changed = git(
    ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=untracked'],
    'git status',
  );
  if (changed !== '')
    fail(`this checkout has local changes, and what is staged is a commit:\n${changed}`);
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}'], 'git rev-parse HEAD');
  const pinned = git(['rev-parse', '--verify', 'HEAD:vendor/nutflix-pear'], 'the submodule pin');
  const sub = join(REPO, 'vendor', 'nutflix-pear');
  run('git', ['-C', sub, 'cat-file', '-e', `${pinned}^{commit}`], REPO, 'the submodule (init it)');

  const work = privateDir(resolve(arg('--work') ?? defaultWorkDir()));
  const plants = ancestorPlants(work);
  if (plants.length > 0)
    fail(
      `a folder above the copy holds what Node, esbuild or tsc would load from it:\n  ${plants.join('\n  ')}\nremove it, or pass --work with a private folder that has none above it`,
    );
  const copy = mkdtempSync(join(work, 'copy-'));
  try {
    unpack(REPO, head, copy);
    unpack(sub, pinned, join(copy, 'vendor', 'nutflix-pear'));
    if (testLine === undefined) {
      // The copy's own checks, before anything is installed. They import `node:*` and each other.
      const scripts = join(copy, 'shells', 'pear-v2');
      const checks = (await import(
        pathToFileURL(join(scripts, 'scripts', 'stage-checks.ts')).href
      )) as ReleaseChecks;
      const pins = (await import(
        pathToFileURL(join(scripts, 'src', 'shared', 'pins.ts')).href
      )) as ReleasePins;
      const open = checks.releaseRefusals({ line: pins.RELEASE_LINE, uiDrive: pins.UI_DRIVE });
      if (open.length > 0) fail(`a release cannot be staged yet:\n  ${open.join('\n  ')}`);
    }
    run(
      'npm',
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      copy,
      'npm ci (root lockfile)',
    );
    run('npm', ['run', 'build'], copy, 'npm run build');
    const r = spawnSync(
      process.execPath,
      [
        join(copy, 'shells', 'pear-v2', 'scripts', 'stage.ts'),
        '--out',
        out,
        ...(testLine === undefined ? [] : ['--test-line', testLine]),
        ...(smoke ? ['--with-smoke'] : []),
      ],
      { cwd: copy, stdio: 'inherit', env: copyEnv({ [CLEAN_COPY_ENV]: copy }) },
    );
    if (r.status !== 0) fail('the clean copy did not stage');
    process.stdout.write(`from a clean copy of ${head} (nutflix-pear ${pinned})\n`);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
