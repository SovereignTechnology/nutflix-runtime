/** The packaging driver's command line (`package.ts`), apart from it so that the tests can read it. */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TARGETS, type Arch, type Platform } from '../packaging/identity.ts';

const PKG_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

export type Command = 'stage' | 'package' | 'make' | 'build';

export interface CliOptions {
  readonly command: Command;
  readonly platform: Platform;
  readonly arch: Arch;
  readonly out: string;
  readonly appImageRuntimeDir: string;
}

export function parseCli(argv: readonly string[]): CliOptions {
  const [command, ...rest] = argv;
  if (command !== 'stage' && command !== 'package' && command !== 'make' && command !== 'build')
    throw new Error('usage: package.ts <stage|package|make|build> [--platform p] [--arch a]');
  const opts = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i] ?? '';
    const v = rest[i + 1];
    if (!['--platform', '--arch', '--out', '--appimage-runtime-dir'].includes(k) || v === undefined)
      throw new Error(`unknown or incomplete option ${k}`);
    opts.set(k, v);
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
  };
}
