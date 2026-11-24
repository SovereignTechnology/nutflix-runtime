/**
 * Builds the directory `pear stage` takes (`out/app/`):
 *
 *   package.json   `app/package.json`'s name, version and `pear` config
 *   index.js       `src/bare/entry.ts`, bundled, with the platform line and page list written in
 *   page/          the renderer's own build, plus `legacy.js` and `legacy.css` (with SRI)
 *   worker/        the worker package's `tsc` output
 *   node_modules/  `app/package-lock.json`'s versions (those that run on Bare 1.24.3), linux-x64
 *                  prebuilds only, plus `@sovit/core` and `@sovit/seeder` from the submodule
 *
 *   node shells/pear-v2/scripts/stage.ts --test-line <key>:<fork>:<length> [--out DIR] [--with-smoke]
 *
 * With no `--test-line` it builds for `RELEASE_LINE`, and refuses while that is `null`. A test
 * line can never be Holepunch's key. Nothing here publishes anything.
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, type Plugin } from 'esbuild';

import { buildRenderer } from '../../../packages/renderer/scripts/build.ts';
import { policyOf } from '../../../packages/renderer/scripts/policy.ts';
import { RUNTIME_OFFER } from '../../../packages/renderer/src/shell/offer.ts';
import { contentType } from '../src/bare/page-server.ts';
import { PEAR_V2, RELEASE_LINE, isReleaseLine, type ReleaseLine } from '../src/shared/pins.ts';
import { checkStagedHtml, insertLegacyTags, parseTestLine, sri } from './stage-checks.ts';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(PKG, '..', '..');
const APP_NAME = 'nutflix-legacy';
const HOST = 'linux-x64';

function fail(msg: string): never {
  throw new Error(`stage: ${msg}`);
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

function copyWorker(out: string): void {
  const src = join(REPO, 'packages', 'worker', 'dist');
  if (!existsSync(join(src, 'host.js'))) fail('the worker is not built: run `npm run build`');
  cpSync(src, join(out, 'worker'), {
    recursive: true,
    filter: (p) => !p.includes('__tests__') && !p.endsWith('.d.ts') && !p.endsWith('.map'),
  });
  rmSync(join(out, 'worker', 'tsconfig.build.tsbuildinfo'), { force: true });
  writeFileSync(join(out, 'worker', 'package.json'), '{ "type": "module" }\n');
}

function keepPrebuild(p: string): boolean {
  const m = /[\\/]prebuilds[\\/]([^\\/]+)/.exec(p);
  return m === null || m[1] === HOST;
}

function copyModules(out: string): void {
  const src = join(PKG, 'app', 'node_modules');
  if (!existsSync(join(src, 'pear-electron')))
    fail('no pinned modules: run `npm ci --ignore-scripts` in shells/pear-v2/app');
  cpSync(src, join(out, 'node_modules'), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (p) => keepPrebuild(p) && !p.endsWith('/.package-lock.json'),
  });
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
}

export interface StageResult {
  readonly out: string;
  readonly line: ReleaseLine;
  readonly pageFiles: readonly string[];
}

export async function stage(o: {
  readonly out: string;
  readonly testLine: ReleaseLine | null;
  /** Also writes `smoke.js`, CI's check on a real Bare. Test builds only. */
  readonly smoke?: boolean;
}): Promise<StageResult> {
  const line = o.testLine ?? RELEASE_LINE;
  if (line === null)
    fail('no SovTech release line of Pear v2.6.5 exists yet (RELEASE_LINE): owner step');
  if (!isReleaseLine(line)) fail('the platform line is malformed');
  if (o.smoke === true && o.testLine === null) fail('--with-smoke is for test builds only');
  if (o.testLine !== null && o.testLine.key === PEAR_V2.upstream.key)
    fail('a test line cannot be Holepunch’s key: the pin is a line nobody else can append to');
  // ADR 0001 amendment, item 1: this shape signs only through a NIP-46 bunker. The renderer offers
  // no sign-in at all today; if that changes, this build must be looked at again, not ship it.
  if ((RUNTIME_OFFER.signIn as unknown) !== false)
    fail('the renderer now offers sign-in: shape (b) allows a NIP-46 bunker only');

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

  copyWorker(o.out);
  copyModules(o.out);

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
  return { out: o.out, line, pageFiles };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rawLine = arg('--test-line');
  const out = resolve(arg('--out') ?? join(PKG, 'out', 'app'));
  stage({
    out,
    testLine: rawLine === undefined ? null : parseTestLine(rawLine),
    smoke: process.argv.includes('--with-smoke'),
  }).then(
    (r) => {
      const hash = createHash('sha256')
        .update(readFileSync(join(r.out, 'index.js')))
        .digest('hex');
      process.stdout.write(
        `staged ${relative(process.cwd(), r.out)}: ${String(r.pageFiles.length)} page files, index.js sha256 ${hash}\n`,
      );
    },
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
