/**
 * The staging step: one directory that IS the app (`resources/app/` after Forge copies it).
 * After nutflix-pear's `app-desktop/packaging/stage.ts` (the submodule's pinned commit), much
 * smaller: no host process, no prompt window, no DLEQ thread.
 *
 *   package.json          name, productName, version, `main`; `devDependencies.electron` only
 *                         so that Forge finds the Electron version (the packaged copy drops it)
 *   main/main.cjs         `src/main/main.ts`, bundled; `electron` and `pear-runtime` stay imports
 *   main/preload.cjs      `src/preload/preload.ts`, bundled; `electron` is its one import
 *   renderer/             the renderer's own build (`packages/renderer/scripts/build.ts`)
 *   node_modules/         the runtime closure of this workspace's `dependencies`, from
 *                         package-lock.json by nutflix-pear's own `runtimeClosure` (so the versions
 *                         are the lockfile's, never re-resolved), with the target's prebuilds only
 *
 * The worker is `node_modules/@nutflix-runtime/worker/dist/main.js`, the package's own `tsc`
 * output, which `bare` loads with its dependencies resolved from the node_modules above it (the
 * way the worker's own Bare test runs it). It never reads anything the renderer names.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { build } from 'esbuild';

import {
  runtimeClosure,
  type Lockfile,
} from '../../../vendor/nutflix-pear/packages/app-desktop/packaging/closure.ts';
import { buildRenderer } from '../../../packages/renderer/scripts/build.ts';
import {
  copyPackage,
  fail,
  normalizeModes,
  npmFilter,
  workspaceFilter,
  type CopyStats,
} from './copy.ts';
import { APP, STAGED, bareBinary, type Arch, type Platform } from './identity.ts';
import { PKG_DIR, REPO_ROOT } from './paths.ts';

const WORKSPACE = 'shells/pear-v3';

export interface StageOptions {
  readonly out: string;
  readonly platform: Platform;
  readonly arch: Arch;
}

export interface StageReport {
  readonly out: string;
  readonly version: string;
  readonly packages: readonly string[];
  readonly files: number;
  readonly bytes: number;
}

/** `out` is deleted and rewritten, so it must be something this step made: absent, empty, or a previous stage. */
export function assertReplaceable(out: string): void {
  if (!existsSync(out)) return;
  const st = lstatSync(out);
  if (!st.isDirectory() || st.isSymbolicLink()) fail(`${out} exists and is not a directory`);
  if (readdirSync(out).length === 0) return;
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')) as { name?: unknown }).name;
  } catch {
    name = undefined;
  }
  if (name !== APP.name || !existsSync(join(out, STAGED.main)))
    fail(`${out} is not empty and is not a previous stage: refusing to delete it`);
}

/** The npm packages a bundle imports (not relative, not `node:`). */
function externalsOf(meta: {
  outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
}): string[] {
  const names = new Set<string>();
  for (const o of Object.values(meta.outputs))
    for (const i of o.imports) {
      if (i.external !== true || i.path.startsWith('node:') || i.path.startsWith('.')) continue;
      const parts = i.path.split('/');
      names.add(i.path.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? i.path));
    }
  return [...names].sort();
}

/**
 * What main's bundle may contain: this package's sources, the worker package's host side (its
 * `dist/`: framing, the client and the protocol; its `main` is never imported) and the renderer's
 * link rule. No npm package: everything else main imports stays an import.
 */
function allowedSources(): string[] {
  return [
    join(PKG_DIR, 'src') + '/',
    join(REPO_ROOT, 'packages', 'worker', 'dist') + '/',
    join(REPO_ROOT, 'packages', 'renderer', 'src', 'links.ts'),
    join(REPO_ROOT, 'packages', 'renderer', 'src', 'net') + '/',
    join(REPO_ROOT, 'packages', 'renderer', 'scripts', 'policy.ts'),
  ].map((p) => p.replaceAll('\\', '/'));
}

export async function stageApp(o: StageOptions): Promise<StageReport> {
  assertReplaceable(o.out);
  for (const need of [
    join(REPO_ROOT, 'packages', 'worker', 'dist', 'main.js'),
    join(REPO_ROOT, 'node_modules', 'electron', 'checksums.json'),
  ])
    if (!existsSync(need))
      fail(`${need} is missing: run \`npm ci --ignore-scripts && npm run build\` first`);
  rmSync(o.out, { recursive: true, force: true });
  mkdirSync(o.out, { recursive: true });

  // ---- the runtime closure, from the lockfile ------------------------------------------------
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8')) as Lockfile;
  const closure = runtimeClosure(lock, {
    workspace: WORKSPACE,
    exclude: [],
    platform: o.platform,
    arch: o.arch,
  });
  const stats: CopyStats = { files: 0, bytes: 0 };
  for (const e of closure) {
    const src = join(REPO_ROOT, e.source);
    const dst = join(o.out, e.target);
    if (!existsSync(join(src, 'package.json'))) fail(`${e.source} is not installed (npm ci first)`);
    if (e.workspace) {
      const pj = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')) as {
        files?: string[];
      };
      if (pj.files === undefined) fail(`${e.source}: a workspace package without \`files\``);
      for (const f of pj.files)
        if (!existsSync(join(src, f))) fail(`${e.source}/${f} is missing: run npm run build`);
      copyPackage(src, dst, workspaceFilter(pj.files), stats);
    } else {
      copyPackage(src, dst, npmFilter(o.platform, o.arch), stats);
    }
  }
  const packages = closure.map((e) => `${e.name}@${e.version}`);

  // ---- main and the preload ------------------------------------------------------------------
  mkdirSync(join(o.out, 'main'), { recursive: true });
  const allowed = allowedSources();
  const common = {
    absWorkingDir: PKG_DIR,
    bundle: true,
    minify: false,
    sourcemap: false,
    legalComments: 'eof' as const,
    metafile: true as const,
    logLevel: 'warning' as const,
    tsconfig: join(PKG_DIR, 'tsconfig.json'),
  };
  const mainBuild = await build({
    ...common,
    entryPoints: ['src/main/main.ts'],
    outfile: join(o.out, STAGED.main),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // pear-runtime is loaded at run time from node_modules (it spawns Bare from real file paths).
    external: ['electron', 'pear-runtime'],
  });
  const preloadBuild = await build({
    ...common,
    entryPoints: ['src/preload/preload.ts'],
    outfile: join(o.out, STAGED.preload),
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    // A sandboxed preload gets Electron's restricted `require` and nothing else.
    external: ['electron'],
  });
  for (const [label, meta] of [
    ['main', mainBuild.metafile],
    ['preload', preloadBuild.metafile],
  ] as const) {
    const inputs = Object.keys(meta.inputs).map((p) => resolve(PKG_DIR, p).replaceAll('\\', '/'));
    const stray = inputs.filter((p) => !allowed.some((a) => p.startsWith(a)));
    if (stray.length > 0)
      fail(`the ${label} bundle holds sources it may not:\n  ${stray.join('\n  ')}`);
  }
  const mainExternals = externalsOf(mainBuild.metafile).filter((n) => n !== 'electron');
  const preloadExternals = externalsOf(preloadBuild.metafile);
  if (preloadExternals.some((n) => n !== 'electron'))
    fail(`the preload imports more than electron: ${preloadExternals.join(', ')}`);
  for (const n of mainExternals)
    if (!existsSync(join(o.out, 'node_modules', n, 'package.json')))
      fail(`main imports ${n}, which the closure does not ship`);

  // ---- the renderer, with its own policy and SRI ----------------------------------------------
  await buildRenderer(join(o.out, 'renderer'));

  // ---- the package.json ------------------------------------------------------------------------
  const own = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
    version: string;
    devDependencies: Record<string, string>;
  };
  const electron = own.devDependencies['electron'];
  if (electron === undefined || !/^\d+\.\d+\.\d+$/.test(electron))
    fail('electron must be pinned to an exact version in shells/pear-v3/package.json');
  writeFileSync(
    join(o.out, 'package.json'),
    `${JSON.stringify(
      {
        name: APP.name,
        productName: APP.productName,
        version: own.version,
        description: APP.description,
        license: APP.license,
        author: APP.author,
        main: STAGED.main,
        // Forge reads the Electron version here; the packaged copy drops it (forge-config.ts).
        devDependencies: { electron },
      },
      null,
      2,
    )}\n`,
  );

  // ---- the shipped Bare runtime must be there for the target -----------------------------------
  if (!existsSync(join(o.out, bareBinary(o.platform, o.arch))))
    fail(`bare-sidecar has no runtime for ${o.platform}-${o.arch}`);
  if (!existsSync(join(o.out, STAGED.workerEntry))) fail('the worker entry is not staged');

  normalizeModes(o.out);
  return { out: o.out, version: own.version, packages, files: stats.files, bytes: stats.bytes };
}
