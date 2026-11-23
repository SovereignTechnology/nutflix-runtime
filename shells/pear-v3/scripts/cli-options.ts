/** The packaging driver's command line (`package.ts`), apart from it so that the tests can read it. */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TARGETS, type Arch, type Platform } from '../packaging/identity.ts';

const PKG_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

export type Command = 'stage' | 'package' | 'make' | 'build' | 'test-build';

export interface CliOptions {
  readonly command: Command;
  readonly platform: Platform;
  readonly arch: Arch;
  readonly out: string;
  readonly appImageRuntimeDir: string;
  /** `test-build` only: the JSON trust root to bake in (`packaging/update-root.ts`). */
  readonly updateRootFile?: string;
  /** `test-build` only: the version the build says it is. */
  readonly appVersion?: string;
}

export function parseCli(argv: readonly string[]): CliOptions {
  const [command, ...rest] = argv;
  if (
    command !== 'stage' &&
    command !== 'package' &&
    command !== 'make' &&
    command !== 'build' &&
    command !== 'test-build'
  )
    throw new Error(
      'usage: package.ts <stage|package|make|build|test-build> [--platform p] [--arch a]',
    );
  const opts = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i] ?? '';
    const v = rest[i + 1];
    if (
      ![
        '--platform',
        '--arch',
        '--out',
        '--appimage-runtime-dir',
        '--update-root',
        '--app-version',
      ].includes(k) ||
      v === undefined
    )
      throw new Error(`unknown or incomplete option ${k}`);
    opts.set(k, v);
  }
  // A release build's trust root is the constant in `update-root.ts`, and no option can name
  // another. Only the command that says it is a test build reads one.
  const updateRootFile = opts.get('--update-root');
  const appVersion = opts.get('--app-version');
  if (command === 'test-build') {
    if (updateRootFile === undefined || appVersion === undefined)
      throw new Error('test-build needs --update-root <file> and --app-version <a.b.c>');
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(appVersion))
      throw new Error('--app-version must be a.b.c');
  } else if (updateRootFile !== undefined || appVersion !== undefined) {
    throw new Error('--update-root and --app-version are refused outside test-build');
  }
  const platform = opts.get('--platform') ?? process.platform;
  const arch = opts.get('--arch') ?? process.arch;
  if (!TARGETS.some((t) => t.platform === platform && t.arch === arch))
    throw new Error(
      `${platform}-${arch} is not a target (${TARGETS.map((t) => `${t.platform}-${t.arch}`).join(', ')})`,
    );
  const out = resolve(opts.get('--out') ?? join(PKG_DIR, 'out'));
  return {
    command,
    platform: platform as Platform,
    arch: arch as Arch,
    out,
    appImageRuntimeDir: resolve(
      opts.get('--appimage-runtime-dir') ?? join(out, 'appimage-runtime'),
    ),
    ...(updateRootFile === undefined ? {} : { updateRootFile: resolve(updateRootFile) }),
    ...(appVersion === undefined ? {} : { appVersion }),
  };
}
