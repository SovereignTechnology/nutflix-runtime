/**
 * The renderer's build: `src/entry.ts` bundled with esbuild, the design system's stylesheets and
 * `index.html` with SRI on every script and stylesheet, written to `dist/app/`:
 *
 *   index.html    this package's index.html: its CSP <meta> is the first element of <head>, and
 *                 every script and stylesheet carries an SRI hash (nutflix-pear's `csp-sri.mjs`,
 *                 which also refuses inline script, inline style, handlers and `javascript:`)
 *   app.js        the bundle (minified, production React)
 *   ui.css        @sovit/ui's tokens, components and screens
 *   shell.css     @sovit/ui's shell layout
 *   nfx/player.js nfx's web player library, byte for byte from the tar `nfx-web.lock` pins
 *   nfx/wasm.js   its WASM verifier as base64 (`src/player/load.ts` checks its sha256)
 *
 * It fails when the bundle holds anything the renderer must not carry (nutflix-pear's deny list for
 * its own web client: Cashu, sodium, Hypercore and HyperDHT, Bare, Electron, Pear, the wallet and
 * signer code, core's main entry, a Node built-in): the worker is where those live.
 *
 * Run `tsc -b` first: the packages it bundles are built from source into their `dist/`.
 *   node scripts/build.ts [outDir]
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { processHtml } from '../../../vendor/nutflix-pear/scripts/csp-sri.mjs';
import {
  deniedInputs,
  npmPackages,
} from '../../../vendor/nutflix-pear/packages/app-web/scripts/site.ts';
import { readPinnedLibrary, wasmModuleSource } from './nfx-lib.ts';
import { policyOf } from './policy.ts';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pearUi = resolve(pkg, '../../vendor/nutflix-pear/packages/ui');
const require = createRequire(import.meta.url);

export interface BuildResult {
  readonly out: string;
  readonly packages: readonly string[];
}

export async function buildRenderer(out: string = join(pkg, 'dist', 'app')): Promise<BuildResult> {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'nfx'), { recursive: true });
  // Refused unless the tar is the one `nfx-web.lock` pins.
  const nfx = readPinnedLibrary(pkg);

  // The design system's stylesheets are plain files `@sovit/ui` flattens into its dist/.
  const css = spawnSync(process.execPath, [join(pearUi, 'scripts', 'build-css.ts')], {
    encoding: 'utf8',
  });
  if (css.status !== 0) throw new Error(`@sovit/ui build-css failed:\n${css.stderr}`);

  const r = await build({
    absWorkingDir: pkg,
    entryPoints: ['src/entry.ts'],
    outfile: join(out, 'app.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: false,
    legalComments: 'eof',
    tsconfig: join(pkg, 'tsconfig.json'),
    define: {
      'process.env.NODE_ENV': '"production"',
      __NFX_WASM_SHA256__: JSON.stringify(nfx.wasmSha256),
    },
    metafile: true,
    logLevel: 'warning',
  });
  const inputs = Object.keys(r.metafile.inputs).map((p) =>
    /^[a-z-]+:/.test(p) ? p : resolve(pkg, p),
  );
  const denied = deniedInputs(inputs);
  if (denied.length > 0) throw new Error(`the bundle may not contain:\n  ${denied.join('\n  ')}`);
  const external = Object.values(r.metafile.outputs).flatMap((o) =>
    o.imports.filter((i) => i.external).map((i) => i.path),
  );
  if (external.length > 0) {
    throw new Error(`app.js may import nothing: ${JSON.stringify(external)}`);
  }

  writeFileSync(join(out, 'nfx', 'player.js'), nfx.playerJs);
  writeFileSync(join(out, 'nfx', 'wasm.js'), wasmModuleSource(nfx.wasm));
  copyFileSync(require.resolve('@sovit/ui/ui.css'), join(out, 'ui.css'));
  copyFileSync(require.resolve('@sovit/ui/shell.css'), join(out, 'shell.css'));
  const source = readFileSync(join(pkg, 'index.html'), 'utf8');
  const policy = policyOf(source);
  writeFileSync(join(out, 'index.html'), source);
  const page = processHtml(source, {
    root: out,
    htmlDir: out,
    csp: { meta: policy, header: `${policy}; frame-ancestors 'none'` },
  });
  if (page.violations.length > 0) {
    throw new Error(`index.html breaks the CSP:\n  ${page.violations.join('\n  ')}`);
  }
  writeFileSync(join(out, 'index.html'), page.html);
  return { out, packages: npmPackages(inputs) };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
  buildRenderer(out).then(
    (r) => {
      if (!existsSync(join(r.out, 'app.js'))) throw new Error('no app.js');
      process.stderr.write(`renderer: built ${r.out}; npm: ${r.packages.join(' ')}\n`);
    },
    (e: unknown) => {
      process.stderr.write(`renderer: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
