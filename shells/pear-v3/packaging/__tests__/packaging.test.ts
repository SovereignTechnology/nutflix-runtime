import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FuseState, FuseV1Options } from '@electron/fuses';
import {
  runtimeClosure,
  type Lockfile,
} from '../../../../vendor/nutflix-pear/packages/app-desktop/packaging/closure.ts';
import { afterEach, describe, expect, it } from 'vitest';

import { FUSES, fuseMismatches } from '../fuses.ts';
import { APP, MIN_BARE, STAGED, TARGETS, bareBinary } from '../identity.ts';
import { layoutProblems } from '../layout.ts';
import {
  APPIMAGE_RUNTIMES,
  APPIMAGE_RUNTIME_DOWNLOAD,
  AppImageError,
  desktopEntry,
  mksquashfsArgs,
  pinnedRuntime,
} from '../maker-appimage.ts';
import { copyPackage, npmFilter, workspaceFilter } from '../copy.ts';
import { REPO_ROOT } from '../paths.ts';
import { compareVersions, eventName, parseReadyLine, readyProblems } from '../../scripts/smoke.ts';
import { parseCli } from '../../scripts/cli-options.ts';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'shell-v3-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8')) as Lockfile;

describe('names', () => {
  it('are the ones `pear build` requires: <productName>.<ext>', () => {
    expect(APP.productName).toBe('Nutflix');
    expect(`${APP.productName}.AppImage`).toBe('Nutflix.AppImage');
  });

  it('cover the five targets', () => {
    expect(TARGETS.map((t) => `${t.platform}-${t.arch}`).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]);
  });

  it("locate bare-sidecar's runtime per target", () => {
    expect(bareBinary('linux', 'x64')).toBe('node_modules/bare-sidecar/prebuilds/linux-x64/bare');
    expect(bareBinary('win32', 'x64')).toBe(
      'node_modules/bare-sidecar/prebuilds/win32-x64/bare.exe',
    );
  });

  it('parse the CLI, and refuse a platform that is not a target', () => {
    expect(parseCli(['build', '--platform', 'linux', '--arch', 'arm64']).arch).toBe('arm64');
    expect(() => parseCli(['build', '--platform', 'win32', '--arch', 'arm64'])).toThrow(
      /not a target/,
    );
    expect(() => parseCli(['nope'])).toThrow(/usage/);
    expect(() => parseCli(['build', '--platform'])).toThrow(/incomplete/);
  });
});

describe('fuses', () => {
  const all = (state: FuseState) =>
    Object.fromEntries(
      Object.keys(FUSES).map((k) => [FuseV1Options[k as keyof typeof FUSES], state]),
    );

  it('sets four, with Node as a shell, NODE_OPTIONS, --inspect and file:// privileges off', () => {
    expect(FUSES).toEqual({
      RunAsNode: false,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      GrantFileProtocolExtraPrivileges: false,
    });
  });

  it('reads a binary back: all four off is right, anything else is a mismatch', () => {
    expect(fuseMismatches(all(FuseState.DISABLE))).toEqual([]);
    expect(fuseMismatches(all(FuseState.ENABLE))).toHaveLength(4);
    expect(fuseMismatches({})).toHaveLength(4);
  });
});

describe('the AppImage maker', () => {
  it("pins this repository's patched runtime, not the upstream one", () => {
    const upstream = readFileSync(
      join(REPO_ROOT, 'vendor/nutflix-pear/packages/app-desktop/packaging/maker-appimage.ts'),
      'utf8',
    );
    expect(APPIMAGE_RUNTIME_DOWNLOAD).toContain(
      'SovereignTechnology/nutflix-runtime/releases/download/appimage-runtime-20251108-nutflix.1',
    );
    expect(Object.keys(APPIMAGE_RUNTIMES).sort()).toEqual(['arm64', 'x64']);
    for (const pin of Object.values(APPIMAGE_RUNTIMES)) {
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(upstream).not.toContain(pin.sha256);
      expect(upstream).toContain(pin.asset);
    }
  });

  it('refuses a runtime that is missing or does not match its pin, and returns one that does', () => {
    const dir = tmp();
    expect(() => pinnedRuntime(dir, 'x64')).toThrow(AppImageError);
    expect(() => pinnedRuntime(dir, 'riscv')).toThrow(/no pinned/);
    const bytes = Buffer.from('a runtime');
    writeFileSync(join(dir, 'runtime-x86_64'), bytes);
    expect(() => pinnedRuntime(dir, 'x64')).toThrow(/refused/);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const pins = { x64: { asset: 'runtime-x86_64', sha256: sha } };
    expect(Buffer.from(pinnedRuntime(dir, 'x64', pins))).toEqual(bytes);
  });

  it('writes a desktop entry whose Exec is the binary with %U and no switch', () => {
    const e = desktopEntry({
      productName: 'Nutflix',
      executableName: 'Nutflix',
      comment: 'c',
      categories: ['Video'],
      version: '0.1.0',
      icon: true,
    });
    expect(e).toContain('Exec=Nutflix %U\n');
    expect(e).not.toMatch(/--/);
    expect(() =>
      desktopEntry({
        productName: 'a\nb',
        executableName: 'N',
        comment: '',
        categories: [],
        version: '1',
        icon: false,
      }),
    ).toThrow(AppImageError);
  });

  it('squashes root-owned, without xattrs, with fixed times only when asked', () => {
    expect(mksquashfsArgs('a', 'b', undefined)).not.toContain('-all-time');
    expect(mksquashfsArgs('a', 'b', '1700000000')).toEqual(
      expect.arrayContaining(['-all-time', '1700000000']),
    );
    expect(mksquashfsArgs('a', 'b', undefined)).toEqual(
      expect.arrayContaining(['-root-owned', '-no-xattrs']),
    );
  });
});

describe('staging', () => {
  it('copies a package, keeping modes, and refuses a symlink', () => {
    if (process.platform === 'win32') return;
    const src = tmp();
    const dst = join(tmp(), 'out');
    mkdirSync(join(src, 'prebuilds', 'linux-x64'), { recursive: true });
    mkdirSync(join(src, 'prebuilds', 'win32-x64'), { recursive: true });
    writeFileSync(join(src, 'package.json'), '{}');
    writeFileSync(join(src, 'prebuilds', 'linux-x64', 'bare'), 'x');
    writeFileSync(join(src, 'prebuilds', 'win32-x64', 'bare.exe'), 'x');
    chmodSync(join(src, 'prebuilds', 'linux-x64', 'bare'), 0o755);
    const stats = { files: 0, bytes: 0 };
    copyPackage(src, dst, npmFilter('linux', 'x64'), stats);
    expect(existsSync(join(dst, 'prebuilds', 'linux-x64', 'bare'))).toBe(true);
    expect(existsSync(join(dst, 'prebuilds', 'win32-x64'))).toBe(false);
    expect(stats.files).toBe(2);
    symlinkSync('/etc/passwd', join(src, 'link'));
    expect(() => {
      copyPackage(src, join(tmp(), 'o2'), npmFilter('linux', 'x64'), { files: 0, bytes: 0 });
    }).toThrow(/symlink/);
  });

  it("keeps a workspace package's files and drops tests, maps and declarations", () => {
    const keep = workspaceFilter(['dist']);
    expect(keep('package.json', false)).toBe(true);
    expect(keep('README.md', false)).toBe(false);
    expect(keep('src', true)).toBe(false);
    expect(keep('dist', true)).toBe(true);
    expect(keep('dist/main.js', false)).toBe(true);
    expect(keep('dist/main.js.map', false)).toBe(false);
    expect(keep('dist/main.d.ts', false)).toBe(false);
    expect(keep('dist/__tests__/x.js', false)).toBe(false);
  });

  it('ships, for each target, what the app runs and nothing it only builds with', () => {
    for (const t of TARGETS) {
      const names = runtimeClosure(lock, {
        workspace: 'shells/pear-v3',
        exclude: [],
        platform: t.platform,
        arch: t.arch,
      }).map((e) => e.name);
      for (const need of [
        'pear-runtime',
        'bare-sidecar',
        '@nutflix-runtime/worker',
        '@sovit/core',
        '@sovit/seeder',
        'hyperdht',
        'corestore',
        'sodium-native',
        'bare-fs',
      ])
        expect(names, `${t.platform}-${t.arch} ships ${need}`).toContain(need);
      for (const never of [
        'electron',
        '@electron-forge/core',
        '@electron/fuses',
        'esbuild',
        'vitest',
        'typescript',
        '@nutflix-runtime/renderer',
        'react',
        'playwright-core',
      ])
        expect(names, `${t.platform}-${t.arch} does not ship ${never}`).not.toContain(never);
    }
  });
});

describe('the Bare runtime', () => {
  it('bare-sidecar is built against a Bare the worker runs on (>= the minimum), at the locked version', () => {
    const sidecar = lock.packages['node_modules/bare-sidecar'];
    expect(sidecar?.version).toBe('0.5.4');
    const cmake = join(REPO_ROOT, 'node_modules', 'bare-sidecar', 'CMakeLists.txt');
    if (!existsSync(cmake)) return; // an install without devDependencies on disk
    const m = /holepunchto\/bare@(\d+\.\d+\.\d+)/.exec(readFileSync(cmake, 'utf8'));
    expect(m?.[1]).toBeDefined();
    expect(compareVersions(m?.[1] ?? '0', MIN_BARE)).toBeGreaterThanOrEqual(0);
  });

  it('compares versions by number', () => {
    expect(compareVersions('1.31.0', '1.29.4')).toBe(1);
    expect(compareVersions('v1.9.0', '1.10.0')).toBe(-1);
    expect(compareVersions('1.29.4', '1.29.4')).toBe(0);
  });
});

describe('the layout check', () => {
  const build = (platform: string, arch: string, omit?: string): string => {
    const out = tmp();
    const app = join(out, 'resources', 'app');
    const put = (rel: string): void => {
      if (rel === omit) return;
      mkdirSync(join(app, rel, '..'), { recursive: true });
      writeFileSync(join(app, rel), 'x');
    };
    for (const rel of [
      STAGED.main,
      STAGED.preload,
      STAGED.rendererIndex,
      STAGED.workerEntry,
      STAGED.pearRuntime,
    ])
      put(rel);
    put(bareBinary(platform, arch));
    if (platform !== 'win32') chmodSync(join(app, bareBinary(platform, arch)), 0o755);
    return out;
  };

  it('passes a complete unpacked app', () => {
    if (process.platform === 'win32') return;
    expect(layoutProblems(build('linux', 'x64'), 'linux', 'x64', 'Nutflix')).toEqual([]);
  });

  it("names what is missing, an asar, a second platform's runtime and a symlinked entry", () => {
    if (process.platform === 'win32') return;
    expect(
      layoutProblems(build('linux', 'x64', STAGED.workerEntry), 'linux', 'x64', 'Nutflix'),
    ).toEqual([`${STAGED.workerEntry} is missing`]);
    const a = build('linux', 'x64');
    writeFileSync(join(a, 'resources', 'app.asar'), 'x');
    expect(layoutProblems(a, 'linux', 'x64', 'Nutflix')[0]).toMatch(/app\.asar/);
    const b = build('linux', 'x64');
    mkdirSync(join(b, 'resources', 'app', STAGED.bareSidecar, 'prebuilds', 'win32-x64'), {
      recursive: true,
    });
    expect(layoutProblems(b, 'linux', 'x64', 'Nutflix').join()).toMatch(/other platforms/);
    const c = build('linux', 'x64');
    rmSync(join(c, 'resources', 'app', STAGED.main));
    symlinkSync('/etc/passwd', join(c, 'resources', 'app', STAGED.main));
    expect(layoutProblems(c, 'linux', 'x64', 'Nutflix').join()).toMatch(/symlink/);
  });

  it('knows macOS keeps resources inside the bundle', () => {
    expect(layoutProblems(tmp(), 'darwin', 'arm64', 'Nutflix')).toEqual([
      'resources/app is missing',
    ]);
  });
});

describe("the smoke test's reading of the app", () => {
  const line =
    'NUTFLIX_SHELL_READY {"shell":"pear-v3","version":"0.1.0","window":"loaded","renderer":"mounted","worker":"status-ok","sandbox":"on","pipe":"round-trip","rendererSandbox":"enforced"}';

  it('accepts the ready line and nothing weaker', () => {
    const f = parseReadyLine(line);
    expect(f).not.toBeNull();
    expect(readyProblems(f ?? {})).toEqual([]);
    for (const k of ['window', 'renderer', 'worker', 'pipe', 'rendererSandbox'])
      expect(readyProblems({ ...f, [k]: 'no' }).join()).toContain(k);
    expect(readyProblems({ ...f, sandbox: 'off' }).join()).toContain('sandbox');
    expect(readyProblems({ ...f, sandbox: 'off', rendererSandbox: 'absent' }, 'off')).toEqual([]);
    expect(readyProblems({ ...f, rendererSandbox: 'unknown' }).join()).toContain('rendererSandbox');
  });

  it('does not take another line for it', () => {
    expect(parseReadyLine('NUTFLIX_SHELL window {}')).toBeNull();
    expect(parseReadyLine('NUTFLIX_SHELL_READY nope')).toBeNull();
    expect(parseReadyLine('NUTFLIX_SHELL_READY [1]')).toBeNull();
    expect(parseReadyLine(` ${line}`)).toBeNull();
  });

  it('reads an event name', () => {
    expect(eventName('NUTFLIX_SHELL worker-exit {"code":1}')).toBe('worker-exit');
    expect(eventName('NUTFLIX_SHELL_READY {}')).toBeNull();
    expect(eventName('something else')).toBeNull();
  });

  it('is where the app prints it: one place in main.ts, under all three conditions', () => {
    const main = readFileSync(
      fileURLToPath(new URL('../../src/main/main.ts', import.meta.url)),
      'utf8',
    );
    expect(main.match(/readyLine\(/g)).toHaveLength(1);
    expect(main).toMatch(
      /state\.printed \|\| !state\.window \|\| probe === null \|\| !state\.worker/,
    );
  });
});

describe('updates are off in this slice', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name);
      if (e.isDirectory()) return e.name === '__tests__' ? [] : sources(p);
      return e.name.endsWith('.ts') ? [p] : [];
    });
  // Comments may say what is not done; code may not do it.
  const code = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('no source of the shell, the staging step or the driver can start an updater or apply an update', () => {
    const pkg = join(REPO_ROOT, 'shells', 'pear-v3');
    const files = [
      ...sources(join(pkg, 'src')),
      ...sources(join(pkg, 'packaging')),
      ...sources(join(pkg, 'scripts')),
    ];
    expect(files.length).toBeGreaterThan(10);
    for (const f of files)
      expect(code(readFileSync(f, 'utf8')), f).not.toMatch(
        /applyUpdate|PearRuntimeUpdater|pear-runtime-updater|new\s+PearRuntime\b|\.updater\b|\bupgrade\b/,
      );
  });

  it('the staged package.json carries no upgrade link, so a PearRuntime could not be pointed anywhere', () => {
    const own = JSON.parse(
      readFileSync(join(REPO_ROOT, 'shells', 'pear-v3', 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(own['upgrade']).toBeUndefined();
  });
});
