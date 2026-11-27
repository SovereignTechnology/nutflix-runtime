import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SANDBOX_FATAL, USERNS_LIMITS, USERNS_PROBE, appRunScript } from '../apprun.ts';

const FAKE_APP = `#!/bin/sh
if [ "$1" = --sandbox-preflight ]; then
  echo preflight >> "$CALLS"
  if [ -n "$PREFLIGHT_ERR" ]; then echo "$PREFLIGHT_ERR" >&2; exit 133; fi
  exit 0
fi
for a in "$@"; do printf '%s\\n' "$a"; done > "$ARGS"
`;

/** Stands in for util-linux's `unshare`: records how it was asked, and succeeds or fails. */
const FAKE_UNSHARE = `#!/bin/sh
printf '%s\\n' "$*" >> "$PROBES"
[ "$PROBE" = ok ]
`;

/** The tools AppRun itself uses, and nothing else (as on a machine with no `unshare`). */
const TOOLS = ['dirname', 'readlink', 'cat'] as const;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function which(tool: string): string {
  const r = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
  const p = r.stdout.trim();
  if (r.status !== 0 || !p.startsWith('/')) throw new Error(`no ${tool} on this machine`);
  return p;
}

/**
 * AppRun with one kernel setting (`limit`) and an `unshare` that can make the namespaces (`ok`),
 * is refused them (`refused`, a seccomp filter), or is not installed (`missing`).
 */
function run(
  limit: '0' | '1',
  args: readonly string[],
  preflightErr = '',
  probe: 'ok' | 'refused' | 'missing' = 'ok',
): { argv: string[]; preflights: number; probes: string[]; status: number | null } {
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
  const bin = join(d, 'bin');
  mkdirSync(bin);
  for (const t of TOOLS) symlinkSync(which(t), join(bin, t));
  if (probe !== 'missing') {
    writeFileSync(join(bin, 'unshare'), FAKE_UNSHARE);
    chmodSync(join(bin, 'unshare'), 0o755);
  }
  const calls = join(d, 'calls');
  const argsFile = join(d, 'args');
  const probes = join(d, 'probes');
  for (const f of [calls, argsFile, probes]) writeFileSync(f, '');
  const r = spawnSync(appRun, [...args], {
    env: {
      PATH: bin,
      CALLS: calls,
      ARGS: argsFile,
      PROBES: probes,
      PROBE: probe,
      PREFLIGHT_ERR: preflightErr,
    },
  });
  return {
    argv: readFileSync(argsFile, 'utf8').split('\n').slice(0, -1),
    preflights: readFileSync(calls, 'utf8').split('\n').length - 1,
    probes: readFileSync(probes, 'utf8').split('\n').slice(0, -1),
    status: r.status,
  };
}

const PROBE_ARGS = USERNS_PROBE.slice(1).join(' ');
const FATAL = `FATAL: The ${SANDBOX_FATAL} binary was found, but is not configured correctly.`;

// AppRun is a POSIX script that only ever runs on Linux.
describe.skipIf(process.platform === 'win32')('AppRun', () => {
  it('with no kernel limit and namespaces it can make, starts the app as given and asks nothing', () => {
    expect(run('0', ['--flag', 'a b'], `x ${SANDBOX_FATAL}`)).toEqual({
      argv: ['--flag', 'a b'],
      preflights: 0,
      probes: [PROBE_ARGS],
      status: 0,
    });
  });

  it('with a kernel limit, asks Chromium without trying the namespaces first', () => {
    expect(run('1', ['one'])).toEqual({ argv: ['one'], preflights: 1, probes: [], status: 0 });
  });

  it("with a kernel limit, adds --no-sandbox only on Chromium's own sandbox error, and keeps the arguments", () => {
    const r = run('1', ['pear://x', 'a b'], FATAL);
    expect(r).toEqual({
      argv: ['--no-sandbox', 'pear://x', 'a b'],
      preflights: 1,
      probes: [],
      status: 0,
    });
  });

  // A container with Docker's default seccomp profile: every setting reads as no limit.
  it('with no kernel limit but the namespaces refused, asks Chromium, and on its error adds --no-sandbox', () => {
    expect(run('0', ['pear://x', 'a b'], FATAL, 'refused')).toEqual({
      argv: ['--no-sandbox', 'pear://x', 'a b'],
      preflights: 1,
      probes: [PROBE_ARGS],
      status: 0,
    });
  });

  it('with the namespaces refused but a sandbox that starts, never adds --no-sandbox', () => {
    expect(run('0', ['one'], '', 'refused')).toEqual({
      argv: ['one'],
      preflights: 1,
      probes: [PROBE_ARGS],
      status: 0,
    });
  });

  it('with no unshare to try, asks Chromium', () => {
    expect(run('0', ['one'], FATAL, 'missing')).toEqual({
      argv: ['--no-sandbox', 'one'],
      preflights: 1,
      probes: [],
      status: 0,
    });
    expect(run('0', ['one'], '', 'missing').argv).toEqual(['one']);
  });

  it('does not take another failure for a sandbox failure', () => {
    expect(run('1', ['one'], 'Missing X server or $DISPLAY').argv).toEqual(['one']);
    expect(run('0', ['one'], 'Missing X server or $DISPLAY', 'refused').argv).toEqual(['one']);
  });
});

describe('the AppRun script', () => {
  it('reads the three kernel limits', () => {
    const s = appRunScript('Nutflix');
    for (const [file, value] of USERNS_LIMITS)
      expect(s).toContain(`'${file}' 2>/dev/null)" = ${value} ]`);
  });

  it('tries the namespaces the sandbox needs only when no setting reports a limit', () => {
    expect(USERNS_PROBE).toEqual([
      'unshare',
      '--user',
      '--map-root-user',
      '--pid',
      '--net',
      '--fork',
      '/bin/sh',
      '-c',
      ':',
    ]);
    expect(appRunScript('Nutflix')).toContain(
      `[ -n "$limited" ] || ${USERNS_PROBE.join(' ')} </dev/null >/dev/null 2>&1 || limited=1`,
    );
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
