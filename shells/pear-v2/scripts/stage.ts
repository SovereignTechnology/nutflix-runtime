/**
 * Builds the directory `pear stage` takes (`out/app/`):
 *
 *   package.json   `app/package.json`'s name, version and `pear` config
 *   index.js       `src/bare/entry.ts`, bundled, with the platform line and page list written in
 *   page/          the renderer's own build, plus `legacy.js` and `legacy.css` (with SRI)
 *   worker/        the worker package's `tsc` output, only the modules the entry reaches
 *   node_modules/  a clean `npm ci` of `app/package-lock.json` (versions that run on Bare 1.24.3),
 *                  checked package by package against it, linux-x64 prebuilds only and no `.bin`,
 *                  plus `@sovit/core` and `@sovit/seeder` from the submodule
 *
 *   node shells/pear-v2/scripts/stage.ts --test-line <key>:<fork>:<length> [--out DIR] [--with-smoke]
 *
 * `index.js`, `page/` (`app.js`, `legacy.js`) and `worker/` come from this checkout's root
 * `node_modules` and its `tsc` output, as they are on disk: the fast path for a test build (CI runs
 * `npm ci` and `npm run build` just before). **A release never takes it.** A release is staged by
 * `scripts/release.ts`, which imports only `node:*`, exports the commit into a private directory,
 * installs and builds it there from the lockfile, and runs that copy's `stage.ts`. Here, a release
 * (no `--test-line`) is refused outside such a copy, and while an owner's step is open
 * (`releaseRefusals`: no release line yet, or the Electron UI drive still Holepunch's). A test line
 * can never be Holepunch's key. Nothing here publishes anything.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, type Plugin } from 'esbuild';

import { buildRenderer } from '../../../packages/renderer/scripts/build.ts';
import { policyOf } from '../../../packages/renderer/scripts/policy.ts';
import { RUNTIME_OFFER } from '../../../packages/renderer/src/shell/offer.ts';
import { contentType } from '../src/bare/page-server.ts';
import {
  PEAR_V2,
  RELEASE_LINE,
  UI_DRIVE,
  isReleaseLine,
  type ReleaseLine,
} from '../src/shared/pins.ts';
import {
  SYSTEM_ONLY_PACKAGES,
  checkStagedHtml,
  importsOf,
  insertLegacyTags,
  lockMismatches,
  moduleClosure,
  type LockPackages,
  parseTestLine,
  releaseRefusals,
  sri,
  uiDriveMismatches,
} from './stage-checks.ts';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(PKG, '..', '..');
const APP_NAME = 'nutflix-legacy';
const HOST = 'linux-x64';

function fail(msg: string): never {
  throw new Error(`stage: ${msg}`);
}

/** A release's open owner's steps, all at once. */
function assertReleasable(): void {
  const open = releaseRefusals({ line: RELEASE_LINE, uiDrive: UI_DRIVE });
  if (open.length > 0) fail(`a release cannot be staged yet:\n  ${open.join('\n  ')}`);
}

/** Set by `release.ts` for the copy's own `stage.ts`: the copy's root. The same name is there. */
const CLEAN_COPY_ENV = 'NUTFLIX_STAGE_CLEAN_COPY';

/** This `stage.ts` runs in a copy `release.ts` made: named by it, and no git checkout. */
function inCleanCopy(): boolean {
  const named = process.env[CLEAN_COPY_ENV];
  if (named === undefined || named === '' || existsSync(join(REPO, '.git'))) return false;
  try {
    return realpathSync(named) === realpathSync(REPO);
  } catch {
    return false;
  }
}

/** Every file under `dir`, relative, with `/`. */
function filesUnder(dir: string, at = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, at))) {
    const rel = at === '' ? name : `${at}/${name}`;
    const st = lstatSync(join(dir, rel));
    if (st.isSymbolicLink()) fail(`a symlink in the page: ${rel}`);
    if (st.isDirectory()) out.push(...filesUnder(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}

/** `out` is deleted and rewritten, so it must be absent, empty, or a previous stage. */
function assertReplaceable(out: string): void {
  if (!existsSync(out)) return;
  if (!statSync(out).isDirectory()) fail(`${out} is not a directory`);
  if (readdirSync(out).length === 0) return;
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')) as { name?: unknown }).name;
  } catch {
    name = undefined;
  }
  if (name !== APP_NAME) fail(`${out} is not empty and is not a previous stage`);
}

/** The worker stays files of its own, and its imports point at them. */
const workerExternal: Plugin = {
  name: 'worker-external',
  setup(b) {
    b.onResolve({ filter: /^@nutflix-runtime\/worker(\/.*)?$/ }, (a) => ({
      path: `./worker${a.path.slice('@nutflix-runtime/worker'.length) || '/index'}.js`,
      external: true,
    }));
    b.onResolve({ filter: /packages\/worker\/src\// }, (a) => ({
      path: `./worker/${(a.path.split('packages/worker/src/')[1] ?? '').replace(/\.(ts|js)$/, '')}.js`,
      external: true,
    }));
  },
};

/**
 * The worker's `tsc` output, but only the modules the staged entry points reach: a module that
 * imports what only `system` needs (Studio, the bunker) must not be among them, and every package
 * they import must be in the staged `node_modules`.
 */
function copyWorker(out: string, entries: readonly string[]): string[] {
  const src = join(REPO, 'packages', 'worker', 'dist');
  if (!existsSync(join(src, 'host.js'))) fail('the worker is not built: run `npm run build`');
  const roots = entries.flatMap((e) =>
    importsOf(readFileSync(join(out, e), 'utf8'))
      .relative.filter((r) => r.startsWith('./worker/'))
      .map((r) => r.slice('./worker/'.length)),
  );
  const { files, packages } = moduleClosure((rel) => {
    const p = join(src, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }, roots);
  for (const blocked of SYSTEM_ONLY_PACKAGES) {
    const by = packages.get(blocked);
    if (by !== undefined) fail(`the staged worker imports ${blocked} (${by.join(', ')})`);
  }
  for (const f of files) {
    mkdirSync(dirname(join(out, 'worker', f)), { recursive: true });
    cpSync(join(src, f), join(out, 'worker', f));
  }
  writeFileSync(join(out, 'worker', 'package.json'), '{ "type": "module" }\n');
  return [...packages.keys()];
}

/** Every package the staged code imports must be in its `node_modules`. */
function assertInstalled(out: string, names: Iterable<string>): void {
  for (const n of names)
    if (!existsSync(join(out, 'node_modules', n, 'package.json')))
      fail(`the staged code imports ${n}, which app/package-lock.json does not install`);
}

function keepPrebuild(p: string): boolean {
  const m = /[\\/]prebuilds[\\/]([^\\/]+)/.exec(p);
  return m === null || m[1] === HOST;
}

/**
 * The app's pinned modules, from a clean install of its own lockfile in a new directory, so that
 * nothing already on disk is shipped: `npm ci` checks every package's integrity against it.
 */
function cleanInstall(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nutflix-v2-modules-'));
  for (const f of ['package.json', 'package-lock.json']) cpSync(join(PKG, 'app', f), join(dir, f));
  const r = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  });
  if (r.status !== 0) fail(`npm ci of app/package-lock.json failed:\n${r.stderr.slice(-2000)}`);
  return dir;
}

/** Every package under `root/node_modules`, by its path there, with its own name and version. */
function stagedPackages(root: string): Map<string, { name: unknown; version: unknown }> {
  const found = new Map<string, { name: unknown; version: unknown }>();
  const walk = (dir: string): void => {
    const nm = join(root, dir, 'node_modules');
    if (!existsSync(nm)) return;
    for (const name of readdirSync(nm)) {
      if (name.startsWith('.')) continue;
      const scoped = name.startsWith('@');
      for (const sub of scoped ? readdirSync(join(nm, name)) : ['']) {
        const rel = `${dir === '' ? '' : `${dir}/`}node_modules/${scoped ? `${name}/${sub}` : name}`;
        const pj = join(root, rel, 'package.json');
        if (!existsSync(pj)) continue;
        const j = JSON.parse(readFileSync(pj, 'utf8')) as { name?: unknown; version?: unknown };
        found.set(rel, { name: j.name, version: j.version });
        walk(rel);
      }
    }
  };
  walk('');
  return found;
}

function copyModules(out: string): void {
  const dir = cleanInstall();
  try {
    cpSync(join(dir, 'node_modules'), join(out, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
      // No `.bin` (nothing here runs a package binary), no other platform's prebuilds.
      filter: (p) =>
        keepPrebuild(p) && !p.endsWith('/.package-lock.json') && !/[\\/]\.bin(?:[\\/]|$)/.test(p),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const n of ['core', 'seeder']) {
    const from = join(REPO, 'vendor', 'nutflix-pear', 'packages', n);
    if (!existsSync(join(from, 'dist'))) fail(`@sovit/${n} is not built: run \`npm run build\``);
    const to = join(out, 'node_modules', '@sovit', n);
    mkdirSync(to, { recursive: true });
    cpSync(join(from, 'package.json'), join(to, 'package.json'));
    cpSync(join(from, 'dist'), join(to, 'dist'), {
      recursive: true,
      filter: (p) => !p.includes('__tests__') && !p.endsWith('.map'),
    });
  }
  const lock = (
    JSON.parse(readFileSync(join(PKG, 'app', 'package-lock.json'), 'utf8')) as {
      packages: LockPackages;
    }
  ).packages;
  const wrong = lockMismatches(lock, stagedPackages(out), (p) =>
    p.startsWith('node_modules/@sovit/'),
  );
  if (wrong.length > 0)
    fail(`the staged modules are not app/package-lock.json's:\n  ${wrong.join('\n  ')}`);
}

/** One sha256 over the staged tree: each file's path, executable bit and sha256, sorted. */
export function treeHash(root: string): string {
  const lines: string[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = lstatSync(join(root, r));
      if (st.isSymbolicLink()) fail(`a symlink in the stage: ${r}`);
      if (st.isDirectory()) walk(r);
      else
        lines.push(
          `${r}\t${(st.mode & 0o111) !== 0 ? 'x' : '-'}\t${createHash('sha256')
            .update(readFileSync(join(root, r)))
            .digest('hex')}`,
        );
    }
  };
  walk('');
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export interface StageResult {
  readonly out: string;
  readonly line: ReleaseLine;
  readonly pageFiles: readonly string[];
  /** `treeHash` of the staged directory. */
  readonly tree: string;
}

export async function stage(o: {
  readonly out: string;
  readonly testLine: ReleaseLine | null;
  /** Also writes `smoke.js`, CI's check on a real Bare. Test builds only. */
  readonly smoke?: boolean;
}): Promise<StageResult> {
  if (o.testLine === null) {
    assertReleasable();
    if (!inCleanCopy())
      fail('a release is staged only from a clean copy: run scripts/release.ts');
  }
  const line = o.testLine ?? RELEASE_LINE;
  if (line === null) fail('no release line');
  if (!isReleaseLine(line)) fail('the platform line is malformed');
  if (o.smoke === true && o.testLine === null) fail('--with-smoke is for test builds only');
  if (o.testLine !== null && o.testLine.key === PEAR_V2.upstream.key)
    fail('a test line cannot be Holepunch’s key: the pin is a line nobody else can append to');
  // ADR 0001 amendment, item 1: shape (b) is watch only, and offers no sign-in of any kind. If the
  // renderer's offer ever has one, this build must be looked at again, not shipped.
  if ((RUNTIME_OFFER.signIn as unknown) !== false)
    fail('the renderer now offers sign-in: shape (b) is watch only and offers none');

  assertReplaceable(o.out);
  rmSync(o.out, { recursive: true, force: true });
  mkdirSync(o.out, { recursive: true });
  const page = join(o.out, 'page');
  await buildRenderer(page);

  const script = await build({
    absWorkingDir: PKG,
    entryPoints: ['src/page/legacy.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome130',
    minify: true,
    legalComments: 'none',
    tsconfig: join(PKG, 'tsconfig.json'),
    logLevel: 'warning',
  });
  const js = script.outputFiles[0]?.contents;
  if (js === undefined) fail('legacy.js was not built');
  const css = readFileSync(join(PKG, 'src', 'page', 'legacy.css'));
  writeFileSync(join(page, 'legacy.js'), js);
  writeFileSync(join(page, 'legacy.css'), css);
  const html = insertLegacyTags(readFileSync(join(page, 'index.html'), 'utf8'), {
    js: sri(js),
    css: sri(css),
  });
  writeFileSync(join(page, 'index.html'), html);
  policyOf(html);
  const problems = checkStagedHtml(html);
  if (problems.length > 0) fail(`the page breaks its policy:\n  ${problems.join('\n  ')}`);

  const pageFiles = filesUnder(page);
  for (const f of pageFiles) if (contentType(f) === null) fail(`no content type for ${f}`);

  await build({
    absWorkingDir: PKG,
    entryPoints: ['src/bare/entry.ts'],
    outfile: join(o.out, 'index.js'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    legalComments: 'none',
    tsconfig: join(PKG, 'tsconfig.json'),
    external: ['bare-http1', 'hypercore-id-encoding', 'pear-electron'],
    plugins: [workerExternal],
    define: {
      __PLATFORM_LINE__: JSON.stringify(line),
      __PAGE_FILES__: JSON.stringify(pageFiles),
    },
    logLevel: 'warning',
  });
  const main = readFileSync(join(o.out, 'index.js'), 'utf8');
  const first = /^\s*import\s+(?:[^'"]*from\s+)?["']([^"']+)["']/m.exec(main)?.[1];
  if (first !== './worker/bare-globals.js')
    fail(`the first import of index.js must be the worker's globals, not ${String(first)}`);

  if (o.smoke === true)
    await build({
      absWorkingDir: PKG,
      entryPoints: ['src/bare/smoke.ts'],
      outfile: join(o.out, 'smoke.js'),
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      legalComments: 'none',
      tsconfig: join(PKG, 'tsconfig.json'),
      plugins: [workerExternal],
      logLevel: 'warning',
    });

  const entries = ['index.js', ...(o.smoke === true ? ['smoke.js'] : [])];
  const workerPackages = copyWorker(o.out, entries);
  copyModules(o.out);
  const ui = uiDriveMismatches({
    uiDrive: UI_DRIVE,
    pearElectron: JSON.parse(
      readFileSync(join(o.out, 'node_modules', 'pear-electron', 'package.json'), 'utf8'),
    ),
    app: JSON.parse(readFileSync(join(PKG, 'app', 'package.json'), 'utf8')),
  });
  if (ui.length > 0) fail(`the Electron UI drive is not the pinned one:\n  ${ui.join('\n  ')}`);
  assertInstalled(o.out, [
    ...workerPackages,
    ...entries.flatMap((e) => importsOf(readFileSync(join(o.out, e), 'utf8')).packages),
  ]);

  const manifest = JSON.parse(readFileSync(join(PKG, 'app', 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  const { name, version, description, license, type, main: entry, pear } = manifest;
  writeFileSync(
    join(o.out, 'package.json'),
    `${JSON.stringify({ name, version, description, license, type, main: entry, pear }, null, 2)}\n`,
  );
  cpSync(join(REPO, 'LICENSE'), join(o.out, 'LICENSE'));
  return { out: o.out, line, pageFiles, tree: treeHash(o.out) };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rawLine = arg('--test-line');
  const out = resolve(arg('--out') ?? join(PKG, 'out', 'app'));
  const smoke = process.argv.includes('--with-smoke');
  const done = (e: unknown): void => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  };
  try {
    stage({ out, testLine: rawLine === undefined ? null : parseTestLine(rawLine), smoke }).then(
      (r) => {
        process.stdout.write(
          `staged ${relative(process.cwd(), r.out)}: ${String(r.pageFiles.length)} page files, tree sha256 ${r.tree}\n`,
        );
      },
      done,
    );
  } catch (e) {
    done(e);
  }
}
