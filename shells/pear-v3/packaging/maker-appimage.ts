/**
 * An AppImage maker for Electron Forge, in this repository. After nutflix-pear's
 * `app-desktop/packaging/maker-appimage.ts` (the submodule's pinned commit), which says why no
 * published maker is used:
 *   - `pear-electron-forge-maker-appimage` (Holepunch) writes an `AppRun` that adds `--no-sandbox`
 *     on Ubuntu 24 and later by version (S2 read it from the built file). This `AppRun`
 *     (`apprun.ts`) adds it only when Chromium itself reports that its sandbox cannot start, and
 *     main answers the switch with a warning before anything opens (`src/main/sandbox-gate.ts`);
 *   - `@reforged/maker-appimage` downloads the AppImage runtime from a MOVING release tag, unverified.
 * What an AppImage is: the type-2 runtime (a static ELF) followed by a squashfs image of an AppDir.
 * This maker builds the AppDir, squashes it with the system `mksquashfs`, and prepends the
 * runtime: a file placed by hand (CI downloads it) whose sha256 must equal the pin below, or the
 * build fails. Nothing is downloaded here.
 *
 * Differences from nutflix-pear's: the file is named `<productName>.AppImage` (the name `pear
 * build` requires, S2: it refuses Forge's `<name>-<version>-<arch>.AppImage`) and the arch is the
 * directory it sits in (`make/appimage/<arch>/`).
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { MakerBase, type MakerOptions } from '@electron-forge/maker-base';
import type { ForgePlatform } from '@electron-forge/shared-types';

import { appRunScript } from './apprun.ts';

const run = promisify(execFile);

export interface RuntimePin {
  /** File name of the release asset (and of the file expected in `runtimeDir`). */
  readonly asset: string;
  readonly sha256: string;
}

/**
 * AppImage/type2-runtime release `20251108` with `appimage-runtime/nutflix-fallback.patch`, built
 * by this repository's `appimage-runtime` workflow on `main`, with build provenance. It starts
 * the app on a machine with no usable FUSE (ADR 0001 amendment, item 3). A wrong pin fails the
 * build closed, never open.
 */
export const APPIMAGE_RUNTIME_RELEASE =
  'https://github.com/SovereignTechnology/nutflix-runtime/releases/tag/appimage-runtime-20251108-nutflix.1';
export const APPIMAGE_RUNTIME_DOWNLOAD =
  'https://github.com/SovereignTechnology/nutflix-runtime/releases/download/appimage-runtime-20251108-nutflix.1';
export const APPIMAGE_RUNTIMES: Readonly<Record<string, RuntimePin>> = {
  x64: {
    asset: 'runtime-x86_64',
    sha256: '677b21d04b9e93546c3e46c987786b380045254946aa50c296c77c0cc6b31ae7',
  },
  arm64: {
    asset: 'runtime-aarch64',
    sha256: '8abc1189793f09720c2befe9edae7a73d00aa448300a99cb052c16d91c0bb8cd',
  },
};

export interface MakerAppImageConfig {
  /** Directory holding the pinned runtime file(s) (`runtime-x86_64`, …). */
  readonly runtimeDir: string;
  /** Binary name inside the packaged app (`Nutflix`). */
  readonly executableName: string;
  readonly productName: string;
  readonly comment: string;
  readonly categories: readonly string[];
  /** A PNG icon; optional. */
  readonly icon?: string;
  /** Tests only: other pins (e.g. a fixture runtime). */
  readonly runtimes?: Readonly<Record<string, RuntimePin>>;
}

export class AppImageError extends Error {
  override readonly name = 'AppImageError' as const;
}

/** The runtime bytes for `arch`, refused unless present and equal to the pin. */
export function pinnedRuntime(
  runtimeDir: string,
  arch: string,
  pins: Readonly<Record<string, RuntimePin>> = APPIMAGE_RUNTIMES,
): Uint8Array {
  const pin = pins[arch];
  if (pin === undefined) throw new AppImageError(`no pinned AppImage runtime for ${arch}`);
  const file = join(runtimeDir, pin.asset);
  if (!existsSync(file))
    throw new AppImageError(
      `AppImage runtime missing: ${file}. Download ${pin.asset} from ${APPIMAGE_RUNTIME_DOWNLOAD}, ` +
        `check its sha256 is ${pin.sha256}, and put it there. Nothing is downloaded by the build.`,
    );
  const bytes = readFileSync(file);
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== pin.sha256)
    throw new AppImageError(
      `AppImage runtime ${file} has sha256 ${got}, pinned ${pin.sha256}: refused`,
    );
  return bytes;
}

/** The sizes the freedesktop `hicolor` theme has folders for. */
const HICOLOR_SIZES: readonly number[] = [16, 24, 32, 48, 64, 128, 256, 512];

/** A square PNG's side in pixels, from its header: the theme folder is named after it. */
export function pngIconSize(bytes: Uint8Array): number {
  const b = Buffer.from(bytes);
  if (
    b.length < 24 ||
    b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    b.subarray(12, 16).toString('latin1') !== 'IHDR'
  )
    throw new AppImageError('the icon is not a PNG');
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (width !== height || !HICOLOR_SIZES.includes(width))
    throw new AppImageError(
      `the icon is ${String(width)}x${String(height)}: it must be square, one of ${HICOLOR_SIZES.join(', ')}`,
    );
  return width;
}

/** The AppDir's desktop entry. `Exec` is the binary itself: no wrapper, no extra switches. */
export function desktopEntry(c: {
  productName: string;
  executableName: string;
  comment: string;
  categories: readonly string[];
  version: string;
  icon: boolean;
}): string {
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${c.productName}`,
    `Comment=${c.comment}`,
    `Exec=${c.executableName} %U`,
    ...(c.icon ? [`Icon=${c.executableName}`] : []),
    'Terminal=false',
    `Categories=${c.categories.map((x) => `${x};`).join('')}`,
    `X-AppImage-Version=${c.version}`,
  ];
  for (const l of lines)
    if (/[\r\n]/.test(l)) throw new AppImageError('desktop entry values must be single lines');
  return `${lines.join('\n')}\n`;
}

/** `mksquashfs` argv: root-owned, no xattrs, fixed timestamps when SOURCE_DATE_EPOCH is set. */
export function mksquashfsArgs(src: string, dst: string, epoch: string | undefined): string[] {
  const args = [
    src,
    dst,
    '-root-owned',
    '-noappend',
    '-no-xattrs',
    '-comp',
    'gzip',
    '-quiet',
    '-no-progress',
  ];
  if (epoch !== undefined && /^\d+$/.test(epoch))
    args.push('-mkfs-time', epoch, '-all-time', epoch);
  return args;
}

export class MakerAppImage extends MakerBase<MakerAppImageConfig> {
  name = 'appimage';
  defaultPlatforms: ForgePlatform[] = ['linux'];
  override requiredExternalBinaries = ['mksquashfs'];

  override isSupportedOnCurrentPlatform(): boolean {
    return process.platform === 'linux';
  }

  override async make({ dir, makeDir, targetArch, packageJSON }: MakerOptions): Promise<string[]> {
    const c = this.config;
    const v = (packageJSON as { version?: unknown }).version;
    const version = typeof v === 'string' ? v : '0.0.0';
    const runtime = pinnedRuntime(c.runtimeDir, targetArch, c.runtimes);
    const work = join(makeDir, 'appimage', targetArch);
    const appDir = join(work, 'AppDir');
    const image = join(work, 'image.squashfs');
    const outFile = join(work, `${c.productName}.AppImage`);
    rmSync(work, { recursive: true, force: true });
    const lib = join(appDir, 'usr', 'lib', c.executableName);
    mkdirSync(lib, { recursive: true });
    // Modes are kept (the Electron binary, chrome-sandbox, the unpacked `bare`).
    cpSync(dir, lib, { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(appDir, 'AppRun'), appRunScript(c.executableName));
    chmodSync(join(appDir, 'AppRun'), 0o755);
    writeFileSync(
      join(appDir, `${c.executableName}.desktop`),
      desktopEntry({ ...c, version, icon: c.icon !== undefined }),
    );
    if (c.icon !== undefined) {
      copyFileSync(c.icon, join(appDir, `${c.executableName}.png`));
      symlinkSync(`${c.executableName}.png`, join(appDir, '.DirIcon'));
      // `pear install` copies this tree into the user's icon theme; the launcher finds it there.
      const side = String(pngIconSize(readFileSync(c.icon)));
      const themed = join(appDir, 'usr', 'share', 'icons', 'hicolor', `${side}x${side}`, 'apps');
      mkdirSync(themed, { recursive: true });
      copyFileSync(c.icon, join(themed, `${c.executableName}.png`));
    }
    // The times go as flags only: mksquashfs >= 4.6 also reads SOURCE_DATE_EPOCH and refuses it
    // together with -mkfs-time/-all-time; older ones ignore it. Same image either way.
    const { SOURCE_DATE_EPOCH: epoch, ...env } = process.env;
    await run('mksquashfs', mksquashfsArgs(appDir, image, epoch), { env });
    writeFileSync(outFile, Buffer.concat([runtime, readFileSync(image)]));
    chmodSync(outFile, 0o755);
    rmSync(appDir, { recursive: true, force: true });
    rmSync(image, { force: true });
    return [outFile];
  }
}
