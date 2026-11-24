/**
 * What the packaged app is called, and where its pieces live. One place, so the Forge config, the
 * makers, the staging step, the layout check and the smoke test agree. After nutflix-pear's
 * `app-desktop/packaging/identity.ts` (the submodule's pinned commit), for this app.
 */

export const APP = {
  /** The staged package.json's `name`: also the user-data directory's name (`main.ts`). */
  name: 'nutflix-runtime',
  /**
   * Human-facing name AND the file name `pear build` requires of each artifact:
   * `<productName>.AppImage`, `<productName>.app`, `<productName>.msix` (S2). It is also the
   * executable's name (`Nutflix`, `Nutflix.exe`, `Nutflix.app/Contents/MacOS/Nutflix`).
   */
  productName: 'Nutflix',
  /** macOS bundle id (a bundle id is a maintainer's choice; this one is not nutflix-pear's). */
  appId: 'xyz.sovit.nutflix.runtime',
  description: 'A Pear-native Nutflix: free NFX videos over HyperDHT',
  author: 'Sovereign Technology',
  license: 'AGPL-3.0-or-later',
} as const;

/**
 * The Windows package's identity (`forge-config.ts` gives it to the MSIX maker, `msix-manifest.ts`
 * writes it). `publisher` must equal the signing certificate's subject, and then never change:
 * Windows refuses an update signed by another publisher.
 */
export const MSIX = {
  identity: 'SovereignTechnology.Nutflix',
  publisher: 'CN=Sovereign Technology (TEST)',
  publisherDisplayName: 'Sovereign Technology',
  minOsVersion: '10.0.19045.0',
  /**
   * The execution alias the manifest declares: the packaged app can be started by this name from a
   * terminal (`%LOCALAPPDATA%\\Microsoft\\WindowsApps\\Nutflix.exe`), with the caller's standard
   * handles, so that its `NUTFLIX_SHELL` lines reach whoever started it. Without an alias a
   * packaged desktop app has no output a script can read.
   */
  alias: `${APP.productName}.exe`,
} as const;

export const TARGETS = [
  { platform: 'linux', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'win32', arch: 'x64' },
] as const;

export type Platform = (typeof TARGETS)[number]['platform'];
export type Arch = (typeof TARGETS)[number]['arch'];

/** Relative to the staged app directory (`resources/app/`). */
export const STAGED = {
  main: 'main/main.cjs',
  preload: 'main/preload.cjs',
  /** The prompt window's preload and its one page (`src/prompt/`). */
  promptPreload: 'main/prompt-preload.cjs',
  promptHtml: 'main/prompt.html',
  /** The updater process (`src/update/update-worker.ts`), with this build's trust root in it. */
  updateWorker: 'main/update-worker.cjs',
  rendererIndex: 'renderer/index.html',
  workerEntry: 'node_modules/@nutflix-runtime/worker/dist/main.js',
  pearRuntime: 'node_modules/pear-runtime/package.json',
  bareSidecar: 'node_modules/bare-sidecar',
} as const;

/** The worker needs Bare 1.29.4 or later in dev (its tests), and bare-fs needs 1.28 or later. */
export const MIN_BARE = '1.29.4';

/** The `bare` binary inside `bare-sidecar` for a target (relative to the staged app directory). */
export function bareBinary(platform: string, arch: string): string {
  return `${STAGED.bareSidecar}/prebuilds/${platform}-${arch}/${platform === 'win32' ? 'bare.exe' : 'bare'}`;
}
