/**
 * Everything the install job downloads or pins, in one place.
 *
 * The Pear CLI comes from the platform's GitHub release (an HTTPS download of a zip), not from the
 * DHT. `npx pear` is the other way to get it, and that one fetches the platform drive over the
 * PUBLIC HyperDHT, which a CI runner must not join (the install job's whole premise: README, "What
 * CI proves"). The zips below are the release assets of `holepunchto/pear` tag `v3.7.0`; each
 * holds the one `pear` binary, and the sha256 is checked before anything is executed. The
 * linux-x64 binary has the byte length (99,679,496) of the one `npx pear@3.0.0` installed in S2.
 */
import type { Platform } from '../../packaging/identity.ts';

export const PEAR_VERSION = '3.7.0';
export const PEAR_TAG = `v${PEAR_VERSION}`;

/** The five targets (`TARGETS` in `identity.ts`, spelled `<platform>-<arch>`). */
export type TargetName = 'darwin-arm64' | 'darwin-x64' | 'linux-arm64' | 'linux-x64' | 'win32-x64';

export interface PearPin {
  /** The release asset's name. */
  readonly asset: string;
  /** sha256 of the zip (GitHub's own digest for the asset agrees; checked when this was written). */
  readonly sha256: string;
  /** Bytes of the zip. */
  readonly size: number;
  /** The one file inside the zip. */
  readonly binary: string;
}

export const PEAR_PINS: Readonly<Record<TargetName, PearPin>> = {
  'darwin-arm64': {
    asset: 'pear-darwin-arm64.zip',
    sha256: '7d3b3767c221a857101afc49ed9548e9058ef65ea750fba9a4a5793f6c14f03d',
    size: 24_262_994,
    binary: 'pear',
  },
  'darwin-x64': {
    asset: 'pear-darwin-x64.zip',
    sha256: '8441c6c6c381016d6a6d8ae38931c4160df37ecf5040c06efb2986313bfcfda9',
    size: 26_343_733,
    binary: 'pear',
  },
  'linux-arm64': {
    asset: 'pear-linux-arm64.zip',
    sha256: 'c37470538652baf25541daec84bfa3601bdd165cdbb08ade6ed9e7a626557bd9',
    size: 27_115_655,
    binary: 'pear',
  },
  'linux-x64': {
    asset: 'pear-linux-x64.zip',
    sha256: '14d41c16edf14b05cf08e19c744393917f1b102add9d00df3836eda0ac230079',
    size: 27_250_662,
    binary: 'pear',
  },
  'win32-x64': {
    asset: 'pear-win32-x64.zip',
    sha256: 'e318c22fab2e80e7473ca87b57b32c853cbda1ec493acf79755f316b36435360',
    size: 23_308_141,
    binary: 'pear.exe',
  },
};

export function pearDownloadUrl(pin: PearPin): string {
  return `https://github.com/holepunchto/pear/releases/download/${PEAR_TAG}/${pin.asset}`;
}

/**
 * HyperDHT's default bootstrap nodes (`lib/constants.js`, the same three in 6.34.1, which Pear
 * 3.7.0 bundles, and in 6.36.0, which the worker pins). A process that does not name its own
 * bootstrap uses these: they are "the public bootstrap". A test guards the list against the
 * installed `hyperdht`.
 */
export const PUBLIC_BOOTSTRAP_IPS: readonly string[] = [
  '88.99.3.86',
  '142.93.90.113',
  '138.68.147.8',
];

/**
 * RFC 5737 TEST-NET-3: documentation addresses that no network routes. The tripwire watches it
 * too, and the job sends one datagram to it first: a tripwire that counts that datagram counts.
 */
export const CANARY_IP = '203.0.113.7';

/** The addresses the tripwire drops and counts: the public bootstrap, then the canary. */
export const TRIPWIRE_IPS: readonly string[] = [...PUBLIC_BOOTSTRAP_IPS, CANARY_IP];

/** The one product the deployment holds, by target: `by-arch/<target>/app/<this>`. */
export function appFileName(platform: Platform, productName: string): string {
  switch (platform) {
    case 'linux':
      return `${productName}.AppImage`;
    case 'darwin':
      return `${productName}.app`;
    case 'win32':
      return `${productName}.msix`;
  }
}
