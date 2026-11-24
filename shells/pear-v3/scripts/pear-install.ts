/**
 * The install job's entry point (`pear-ci/run.ts` says what it does):
 *
 *   node scripts/pear-install.ts --target linux-x64 --artifacts <dir> --clip <dir> --work <dir>
 *
 * `--artifacts` holds the `shell-<target>` directories that `actions/download-artifact` made;
 * `--clip` the packaged-playback proof's video (`pear-ci/playback-clip.ts`); `--work` is a scratch
 * directory. Exit 0 only if every step of every phase held.
 */
import { resolve } from 'node:path';

import { TARGETS } from '../packaging/identity.ts';
import { run } from './pear-ci/run.ts';
import type { TargetName } from './pear-ci/pins.ts';

function arg(argv: readonly string[], name: string): string {
  const i = argv.indexOf(name);
  const v = i === -1 ? undefined : argv[i + 1];
  if (v === undefined) throw new Error(`${name} is required`);
  return v;
}

const argv = process.argv.slice(2);
const target = arg(argv, '--target');
if (!TARGETS.some((t) => `${t.platform}-${t.arch}` === target))
  throw new Error(`${target} is not a target`);

run({
  target: target as TargetName,
  artifacts: resolve(arg(argv, '--artifacts')),
  clip: resolve(arg(argv, '--clip')),
  work: resolve(arg(argv, '--work')),
}).then(
  (code) => {
    process.exit(code);
  },
  (e: unknown) => {
    process.stderr.write(
      `pear-install: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
    );
    process.exit(1);
  },
);
