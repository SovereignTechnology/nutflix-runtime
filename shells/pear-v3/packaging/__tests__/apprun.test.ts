import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SANDBOX_FATAL, USERNS_LIMITS, appRunScript } from '../apprun.ts';

const FAKE_APP = `#!/bin/sh
if [ "$1" = --sandbox-preflight ]; then
  echo preflight >> "$CALLS"
  if [ -n "$PREFLIGHT_ERR" ]; then echo "$PREFLIGHT_ERR" >&2; exit 133; fi
  exit 0
fi
for a in "$@"; do printf '%s\\n' "$a"; done > "$ARGS"
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(
  limit: '0' | '1',
  args: readonly string[],
  preflightErr = '',
): { argv: string[]; preflights: number; status: number | null } {
  const d = mkdtempSync(join(tmpdir(), 'apprun-test-'));
  dirs.push(d);
  const lib = join(d, 'usr', 'lib', 'Nutflix');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'Nutflix'), FAKE_APP);
  chmodSync(join(lib, 'Nutflix'), 0o755);
  const limitFile = join(d, 'limit');
  writeFileSync(limitFile, `${limit}\n`);
  const appRun = join(d, 'AppRun');
  writeFileSync(appRun, appRunScript('Nutflix', [[limitFile, '1']]));
  chmodSync(appRun, 0o755);
  const calls = join(d, 'calls');
  const argsFile = join(d, 'args');
  writeFileSync(calls, '');
  writeFileSync(argsFile, '');
  const r = spawnSync(appRun, [...args], {
    env: { PATH: process.env['PATH'], CALLS: calls, ARGS: argsFile, PREFLIGHT_ERR: preflightErr },
  });
  return {
    argv: readFileSync(argsFile, 'utf8').split('\n').slice(0, -1),
    preflights: readFileSync(calls, 'utf8').split('\n').length - 1,
    status: r.status,
  };
}

// AppRun is a POSIX script that only ever runs on Linux.
describe.skipIf(process.platform === 'win32')('AppRun', () => {
  it('with no kernel limit, starts the app as given and asks nothing', () => {
    expect(run('0', ['--flag', 'a b'], `x ${SANDBOX_FATAL}`)).toEqual({
      argv: ['--flag', 'a b'],
      preflights: 0,
      status: 0,
    });
  });

  it('with a limit but a working sandbox, never adds --no-sandbox', () => {
    expect(run('1', ['one'])).toEqual({ argv: ['one'], preflights: 1, status: 0 });
  });

  it("adds --no-sandbox only on Chromium's own sandbox error, and keeps the arguments", () => {
    const r = run('1', ['pear://x', 'a b'], `FATAL: The ${SANDBOX_FATAL} binary was found`);
    expect(r).toEqual({ argv: ['--no-sandbox', 'pear://x', 'a b'], preflights: 1, status: 0 });
  });

  it('does not take another failure for a sandbox failure', () => {
    expect(run('1', ['one'], 'Missing X server or $DISPLAY').argv).toEqual(['one']);
  });
});

describe('the AppRun script', () => {
  it('reads the three kernel limits', () => {
    const s = appRunScript('Nutflix');
    for (const [file, value] of USERNS_LIMITS)
      expect(s).toContain(`'${file}' 2>/dev/null)" = ${value} ]`);
  });

  it('adds the switch in one place, behind the sandbox error', () => {
    const s = appRunScript('Nutflix');
    expect(s.match(/exec "\$app" --no-sandbox/g)).toHaveLength(1);
    expect(s).toContain(`*'${SANDBOX_FATAL}'*) exec "$app" --no-sandbox "$@" ;;`);
  });

  it.each(['a b', '$(id)', "x'y", '../up', ''])('refuses the name %j', (name) => {
    expect(() => appRunScript(name)).toThrow(/plain executable/);
  });

  it.each([
    ["/tmp/x';id;'", '1'],
    ['/tmp/x', '1; id'],
  ])('refuses the limit %j', (file, value) => {
    expect(() => appRunScript('Nutflix', [[file, value]])).toThrow(/plain limit/);
  });
});
