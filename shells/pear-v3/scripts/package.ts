/**
 * The packaging driver: stages the app (`packaging/stage.ts`), registers the Forge config for the
 * staged directory and runs Electron Forge. Everything lands under `shells/pear-v3/out/`
 * (gitignored). After nutflix-pear's `app-desktop/packaging/cli.ts` (the submodule's pinned
 * commit). Needs `npm ci --ignore-scripts && npm run build` first (the worker's and the
 * workspace packages' `dist/`).
 *
 *   node scripts/package.ts stage   [--platform p] [--arch a] [--out dir]
 *   node scripts/package.ts package [--platform p] [--arch a] [--out dir]
 *   node scripts/package.ts make    [--platform p] [--arch a] [--out dir] [--appimage-runtime-dir dir]
 *   node scripts/package.ts build   (`package` on macOS, `make` elsewhere: the artifact `pear build` takes)
 *   node scripts/package.ts test-build --update-root <json> --app-version <a.b.c> [...]
 *                                   the same, with a THROWAWAY trust root on loopback (CI's update
 *                                   proof). Every other command bakes in the production root and
 *                                   takes no option that could change it (`packaging/update-root.ts`)
 *
 * After `package`/`make`, the fuses of every packaged binary were read back and match
 * `packaging/fuses.ts`, and the layout matches `packaging/layout.ts` (a mismatch fails the run).
 * The last lines printed are `ARTIFACT <kind> <path>`, one per artifact, and the same list is
 * written to `out/artifacts-<platform>-<arch>.json` (the unpacked app directory, and
 * `appimage`, `app` or `msix`).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { api, utils } from '@electron-forge/core';
import type { ForgeArch, ForgePlatform } from '@electron-forge/shared-types';

import { forgeConfig } from '../packaging/forge-config.ts';
import { APP } from '../packaging/identity.ts';
import { pinnedRuntime } from '../packaging/maker-appimage.ts';
import { writeAppxManifest } from '../packaging/msix-manifest.ts';
import { PKG_DIR, REPO_ROOT } from '../packaging/paths.ts';
import { stageApp } from '../packaging/stage.ts';
import { assertStagedRoot, releaseRoot, throwawayRootFromText } from '../packaging/update-root.ts';
import { parseCli, type CliOptions } from './cli-options.ts';

export interface Artifact {
  readonly kind: 'app-dir' | 'appimage' | 'app' | 'msix';
  readonly path: string;
}

export async function run(o: CliOptions): Promise<Artifact[]> {
  const buildLike = o.command === 'build' || o.command === 'test-build';
  const make = o.command === 'make' || (buildLike && o.platform !== 'darwin');
  const updateRoot =
    o.command === 'test-build'
      ? throwawayRootFromText(readFileSync(o.updateRootFile ?? '', 'utf8'))
      : releaseRoot();
  // Fail before minutes of packaging when the AppImage maker would refuse anyway.
  if (make && o.platform === 'linux') pinnedRuntime(o.appImageRuntimeDir, o.arch);
  const stageDir = join(o.out, `stage-${o.platform}-${o.arch}`);
  const sha = process.env['GITHUB_SHA'];
  const ciCommit = sha !== undefined && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  const staged = await stageApp({
    out: stageDir,
    platform: o.platform,
    arch: o.arch,
    updateRoot,
    ...(o.appVersion === undefined ? {} : { version: o.appVersion }),
    ...(ciCommit === undefined ? {} : { commit: ciCommit }),
  });
  // What the bundle holds, read back: a release must carry the production root and nothing else.
  assertStagedRoot(stageDir, updateRoot, o.command === 'test-build' ? 'test' : 'release');
  process.stdout.write(
    `staged: ${String(staged.packages.length)} packages, ${String(staged.files)} files, ${(staged.bytes / 1e6).toFixed(1)} MB\n`,
  );
  if (o.command === 'stage') return [];
  const checksums = JSON.parse(
    readFileSync(join(REPO_ROOT, 'node_modules', 'electron', 'checksums.json'), 'utf8'),
  ) as Record<string, string>;
  utils.registerForgeConfigForDirectory(
    stageDir,
    forgeConfig({
      electronChecksums: checksums,
      appImageRuntimeDir: o.appImageRuntimeDir,
      ...(o.platform === 'win32'
        ? {
            msixManifest: writeAppxManifest(
              join(o.out, `AppxManifest-${o.arch}.xml`),
              staged.version,
              o.arch === 'arm64' ? 'arm64' : 'x64',
              updateRoot.upgrade !== null,
            ),
          }
        : {}),
    }),
  );
  const common = {
    dir: stageDir,
    interactive: false,
    platform: o.platform as ForgePlatform,
    arch: o.arch as ForgeArch,
    outDir: o.out,
  };
  const artifacts: Artifact[] = [];
  // Forge names the packaged directory `<name>-<platform>-<arch>`; on macOS the app is inside it.
  const packagedDir = join(o.out, `${APP.productName}-${o.platform}-${o.arch}`);
  try {
    if (make) {
      const made = await api.make(common);
      artifacts.push({ kind: 'app-dir', path: packagedDir });
      for (const f of made.flatMap((m) => m.artifacts)) {
        const kind = f.endsWith('.AppImage')
          ? 'appimage'
          : f.endsWith('.msix')
            ? 'msix'
            : undefined;
        if (kind === undefined) throw new Error(`an artifact of no known kind: ${f}`);
        // The name `pear build` requires: `<productName>.<ext>`.
        if (!f.endsWith(`${APP.productName}.${kind === 'appimage' ? 'AppImage' : 'msix'}`))
          throw new Error(`the artifact is not named <productName>.<ext>: ${f}`);
        artifacts.push({ kind, path: f });
      }
    } else {
      await api.package(common);
      if (o.platform === 'darwin')
        artifacts.push({ kind: 'app', path: join(packagedDir, `${APP.productName}.app`) });
      else artifacts.push({ kind: 'app-dir', path: packagedDir });
    }
  } finally {
    utils.unregisterForgeConfigForDirectory(stageDir);
  }
  for (const a of artifacts)
    if (!existsSync(a.path)) throw new Error(`the artifact ${a.path} does not exist`);
  writeFileSync(
    join(o.out, `artifacts-${o.platform}-${o.arch}.json`),
    `${JSON.stringify({ platform: o.platform, arch: o.arch, artifacts }, null, 2)}\n`,
  );
  return artifacts;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(PKG_DIR, 'scripts', 'package.ts')
) {
  // Whatever the caller's umask, created files are 0644 and directories 0755.
  process.umask(0o022);
  let o: CliOptions;
  try {
    o = parseCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`package: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  run(o).then(
    (artifacts) => {
      for (const a of artifacts) process.stdout.write(`ARTIFACT ${a.kind} ${a.path}\n`);
    },
    (err: unknown) => {
      process.stderr.write(
        `package: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
      process.exit(1);
    },
  );
}
