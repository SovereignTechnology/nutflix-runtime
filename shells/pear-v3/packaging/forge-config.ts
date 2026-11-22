/**
 * The Electron Forge configuration, registered by `scripts/package.ts` for the staged app
 * directory (Forge's virtual-config API): the staged tree carries no config of its own. After
 * nutflix-pear's `app-desktop/packaging/forge-config.ts` (the submodule's pinned commit).
 *
 * Targets: Linux `Nutflix.AppImage` (the in-repo maker, pinned runtime + mksquashfs), macOS
 * `Nutflix.app` (Forge's package step; there is no maker), Windows `Nutflix.msix`
 * (`@electron-forge/maker-msix`). Every name is what `pear build` requires (S2).
 *
 * TEST builds: nothing is signed or notarized (no `osxSign`, `osxNotarize` or `windowsSign`, and
 * the MSIX maker's `sign` is off). macOS needs Apple signing and notarization, and Windows a real
 * certificate, before these reach other people's machines (ADR 0001 amendment, item 5).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MakerMSIX } from '@electron-forge/maker-msix';
import type { ForgeConfig, ForgeConfigMaker } from '@electron-forge/shared-types';

import { assertAppFuses, flipAppFuses, packagedBinary, type TargetPlatform } from './fuses.ts';
import { APP } from './identity.ts';
import { assertLayout } from './layout.ts';
import { MakerAppImage } from './maker-appimage.ts';
import { windowsKitVersion } from './windows-kit.ts';

/** The Linux icon: nutflix-pear's neutral placeholder (a brand icon is the maintainer's). */
export const LINUX_ICON = fileURLToPath(
  new URL(
    '../../../vendor/nutflix-pear/packages/app-desktop/packaging/icons/nutflix.png',
    import.meta.url,
  ),
);

export interface ForgeConfigOptions {
  /** Electron's own sha256 list (node_modules/electron/checksums.json): every zip is checked. */
  readonly electronChecksums: Readonly<Record<string, string>>;
  /** Where the pinned AppImage runtime file(s) are. */
  readonly appImageRuntimeDir: string;
}

/** The packaged copy's package.json: the staging-only `devDependencies` (Forge reads it) goes. */
function stripDevDependencies(buildPath: string): void {
  const file = join(buildPath, 'package.json');
  const pj = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  delete pj['devDependencies'];
  writeFileSync(file, `${JSON.stringify(pj, null, 2)}\n`);
}

export function makers(o: ForgeConfigOptions): ForgeConfigMaker[] {
  const kit = windowsKitVersion();
  return [
    new MakerAppImage({
      runtimeDir: o.appImageRuntimeDir,
      executableName: APP.productName,
      productName: APP.productName,
      comment: APP.description,
      categories: ['AudioVideo', 'Video', 'Network'],
      icon: LINUX_ICON,
    }),
    new MakerMSIX({
      // `<productName>.msix`, the name `pear build` requires (the maker's default adds the version).
      outputFileName: APP.productName,
      // A TEST build: unsigned. (The maker's default would make a throwaway certificate and sign.)
      sign: false,
      ...(kit === undefined ? {} : { windowsKitVersion: kit }),
      manifestVariables: {
        packageIdentity: 'SovereignTechnology.Nutflix',
        // Must equal the signing certificate's subject once there is one, and then never change
        // (Windows rejects an update from another publisher). A maintainer's decision.
        publisher: 'CN=Sovereign Technology (TEST)',
        publisherDisplayName: 'Sovereign Technology',
        packageDisplayName: APP.productName,
        appDisplayName: APP.productName,
        packageDescription: APP.description,
        appExecutable: `${APP.productName}.exe`,
        packageMinOSVersion: '10.0.19045.0',
        packageMaxOSVersionTested: '10.0.19045.0',
      },
    }),
  ] as ForgeConfigMaker[];
}

export function forgeConfig(o: ForgeConfigOptions): ForgeConfig {
  return {
    packagerConfig: {
      name: APP.productName,
      appBundleId: APP.appId,
      appCategoryType: 'public.app-category.video',
      appCopyright: `Copyright (C) ${APP.author}`,
      win32metadata: { CompanyName: APP.author, ProductName: APP.productName },
      // No asar: pear-runtime's run() spawns Bare from real file paths (fuses.ts).
      asar: false,
      // The staged tree IS the app: no pruning (it would walk a workspace), no ignores needed.
      prune: false,
      derefSymlinks: false,
      junk: true,
      overwrite: true,
      // Every Electron zip is checked against the sha256 list the lockfile-pinned `electron`
      // package ships (a cache hit is re-checked; nothing is fetched when the zip is cached).
      download: { checksums: { ...o.electronChecksums } },
    },
    // Every native module ships N-API or Bare prebuilds; nothing is compiled.
    rebuildConfig: { onlyModules: [] },
    makers: makers(o),
    plugins: [],
    hooks: {
      packageAfterCopy: async (_cfg, buildPath, _electron, platform, arch) => {
        stripDevDependencies(buildPath);
        // Unsigned: an arm64 macOS build gets its ad-hoc signature back (fuses flip the binary).
        await flipAppFuses(buildPath, platform, arch, false);
      },
      postPackage: async (_cfg, { platform, arch, outputPaths }) => {
        const p: TargetPlatform = platform;
        for (const out of outputPaths) {
          await assertAppFuses(packagedBinary(out, p, APP.productName));
          assertLayout(out, p, arch, APP.productName);
          if (p === 'darwin') adHocSign(join(out, `${APP.productName}.app`));
        }
      },
    },
  };
}

/**
 * An ad-hoc signature (identity `-`: no certificate, no secret) over the whole bundle. The
 * packager adds the app to a bundle Electron signed before, and the fuse flip changes its binary;
 * an Apple-silicon Mac refuses to run a bundle whose signature does not match. Not a release
 * signature: Gatekeeper still wants Apple's (README).
 */
function adHocSign(app: string): void {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', app], { stdio: 'inherit' });
}
