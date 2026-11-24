import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PEAR_V2, RELEASE_LINE, UI_DRIVE } from '../../src/shared/pins.ts';
import {
  SYSTEM_ONLY_PACKAGES,
  checkStagedHtml,
  importsOf,
  insertLegacyTags,
  lockMismatches,
  moduleClosure,
  parseTestLine,
  releaseRefusals,
  sri,
  uiDriveMismatches,
  versionedLinkKey,
} from '../stage-checks.ts';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(here, '..', '..', '..', '..', 'packages', 'renderer', 'index.html'),
  'utf8',
);

const CSP = `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'`;
const HASH = 'sha384-abc';
const page = (body = '', csp = CSP): string =>
  `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}" /><title>x</title>` +
  `<script type="module" src="app.js" integrity="${HASH}"></script></head><body>${body}</body></html>`;

describe('the staged page', () => {
  it('passes when it is what the build makes', () => {
    const html = insertLegacyTags(page(), { js: HASH, css: HASH });
    expect(checkStagedHtml(html)).toEqual([]);
  });

  it('puts the classic script before the module, and leaves the CSP first', () => {
    const html = insertLegacyTags(page(), { js: 'sha384-J', css: 'sha384-C' });
    expect(html.indexOf('legacy.js')).toBeLessThan(html.indexOf('app.js'));
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('legacy.css'));
    expect(html).toContain('integrity="sha384-J"');
    expect(html).toContain('integrity="sha384-C"');
  });

  it("works on the renderer's real page", () => {
    const html = insertLegacyTags(
      source
        .replace('<link rel="stylesheet" href="ui.css" />', '')
        .replace('<link rel="stylesheet" href="shell.css" />', '')
        .replace(
          '<script type="module" src="app.js">',
          `<script type="module" src="app.js" integrity="${HASH}">`,
        ),
      { js: HASH, css: HASH },
    );
    expect(checkStagedHtml(html)).toEqual([]);
  });

  it('refuses a page with no module script, or two', () => {
    expect(() => insertLegacyTags('<html></html>', { js: HASH, css: HASH })).toThrow(/one module/);
    const two = page(`<script type="module" src="b.js" integrity="${HASH}"></script>`);
    expect(() => insertLegacyTags(two, { js: HASH, css: HASH })).toThrow(/one module/);
  });

  it.each([
    ['an inline script', '<script>x()</script>'],
    ['a script with no SRI', '<script src="x.js"></script>'],
    ['an inline handler', '<img src="a.png" onerror="x()">'],
    ['an inline style', '<style>a{}</style>'],
    ['a javascript: URL', '<a href="javascript:x()">a</a>'],
    ['a stylesheet with no SRI', '<link rel="stylesheet" href="a.css">'],
  ])('finds %s', (_n, body) => {
    expect(checkStagedHtml(page(body)).length).toBeGreaterThan(0);
  });

  it.each([
    [`script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-src 'none'`],
    [`script-src 'self' 'unsafe-eval'; object-src 'none'; base-uri 'none'; frame-src 'none'`],
    [`script-src 'self' https:; object-src 'none'; base-uri 'none'; frame-src 'none'`],
    [`script-src *; object-src 'none'; base-uri 'none'; frame-src 'none'`],
    [`script-src 'self'; base-uri 'none'; frame-src 'none'`],
    [`script-src 'self'; object-src 'none'; frame-src 'none'`],
    [`script-src 'self'; object-src 'none'; base-uri 'none'`],
    [`default-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'`],
  ])('refuses the policy %s', (csp) => {
    expect(checkStagedHtml(page('', csp)).length).toBeGreaterThan(0);
  });

  it('refuses a page whose first element is not the CSP', () => {
    const html = page().replace('<head>', '<head><meta charset="utf-8" />');
    expect(checkStagedHtml(html)).toContain('the CSP <meta> is not the first element of <head>');
  });

  it('hashes as SRI does', () => {
    expect(sri(new TextEncoder().encode('abc'))).toBe(
      'sha384-ywB1P0WjXou1oD1pmsZQBycsMqsO3tFjGotgWkP/W+2AhgcroefMI1i67KE0yCWn',
    );
  });
});

describe('a test line', () => {
  it('parses', () => {
    expect(parseTestLine(`${'y'.repeat(52)}:0:42`)).toEqual({
      key: 'y'.repeat(52),
      fork: 0,
      length: 42,
    });
    expect(parseTestLine(`${PEAR_V2.upstream.key}:0:3243`).key).toBe(PEAR_V2.upstream.key);
  });

  it.each([
    '',
    'abc:0:1',
    `${'y'.repeat(52)}:0`,
    `${'y'.repeat(52)}:0:0`,
    `${'y'.repeat(52)}:a:1`,
    `${'y'.repeat(52)}:0:1:2`,
  ])('refuses %j', (raw) => {
    expect(() => parseTestLine(raw)).toThrow(/--test-line/);
  });
});

describe('the staged worker', () => {
  const tree: Record<string, string> = {
    'host.js': [
      "import { a } from './a.js';",
      "export { b } from './sub/b.js';",
      "import '@sovit/core';",
      "import corestore from 'corestore';",
      '// import x from "./not-a-module.js";',
      "export const NAME = 'from x';",
    ].join('\n'),
    'a.js':
      "import {\n  x,\n  y,\n} from '@scope/pkg/deep/path';\nconst h = await import('bare-http1');",
    'sub/b.js': "import { c } from '../c.js';",
    'c.js': 'export const c = 1;',
    'adapters/bare.js': "import { spawn } from 'bare-subprocess';\nimport ws from 'bare-ws';",
    'evil.js': "import '../../outside.js';",
  };
  const read = (rel: string): string | null => tree[rel] ?? null;

  it('finds what is imported, statically and dynamically, and nothing in comments or strings', () => {
    expect(importsOf(tree['a.js'] ?? '')).toEqual({
      relative: [],
      packages: ['@scope/pkg', 'bare-http1'],
    });
    expect(importsOf(tree['host.js'] ?? '').relative).toEqual(['./a.js', './sub/b.js']);
  });

  it('copies only what the entry reaches, with the packages each imports', () => {
    const r = moduleClosure(read, ['host.js']);
    expect(r.files).toEqual(['a.js', 'c.js', 'host.js', 'sub/b.js']);
    expect([...r.packages.keys()].sort()).toEqual([
      '@scope/pkg',
      '@sovit/core',
      'bare-http1',
      'corestore',
    ]);
  });

  it('sees a reached module that needs what only `system` needs', () => {
    const r = moduleClosure(read, ['adapters/bare.js']);
    expect(SYSTEM_ONLY_PACKAGES.filter((p) => r.packages.has(p))).toEqual([
      'bare-subprocess',
      'bare-ws',
    ]);
  });

  it('refuses a path out of the worker, and a module that is not there', () => {
    expect(() => moduleClosure(read, ['evil.js'])).toThrow(/leaves the worker/);
    expect(() => moduleClosure(read, ['gone.js'])).toThrow(/has no gone\.js/);
  });
});

describe('the staged modules against the lockfile', () => {
  const lock = {
    '': { name: 'nutflix-legacy' },
    'node_modules/a': { version: '1.0.0' },
    'node_modules/@s/b': { version: '2.0.0' },
    'node_modules/a/node_modules/c': { version: '3.0.0' },
    'node_modules/opt': { version: '1.0.0', optional: true },
    'node_modules/devonly': { version: '1.0.0', dev: true },
  };
  const good = new Map<string, { name: unknown; version: unknown }>([
    ['node_modules/a', { name: 'a', version: '1.0.0' }],
    ['node_modules/@s/b', { name: '@s/b', version: '2.0.0' }],
    ['node_modules/a/node_modules/c', { name: 'c', version: '3.0.0' }],
  ]);

  it('passes what the lockfile installs', () => {
    expect(lockMismatches(lock, good)).toEqual([]);
  });

  it('finds another version, another name, a missing package and an extra one', () => {
    const bad = new Map(good);
    bad.set('node_modules/a', { name: 'a', version: '1.0.1' });
    bad.set('node_modules/@s/b', { name: '@evil/b', version: '2.0.0' });
    bad.delete('node_modules/a/node_modules/c');
    bad.set('node_modules/planted', { name: 'planted', version: '0.0.1' });
    expect(lockMismatches(lock, bad)).toEqual([
      'node_modules/@s/b: name @evil/b, lockfile @s/b',
      'node_modules/a/node_modules/c: missing',
      'node_modules/a: version 1.0.1, lockfile 1.0.0',
      'node_modules/planted: not in the lockfile',
    ]);
  });

  it('lets the stage add its own packages, and only those', () => {
    const plus = new Map(good);
    plus.set('node_modules/@sovit/core', { name: '@sovit/core', version: '0.0.0' });
    expect(lockMismatches(lock, plus, (p) => p.startsWith('node_modules/@sovit/'))).toEqual([]);
    expect(lockMismatches(lock, plus)).toEqual(['node_modules/@sovit/core: not in the lockfile']);
  });
});

describe('a release', () => {
  const line = { key: 'y'.repeat(52), fork: 0, length: 3243 };
  const ours = `pear://0.12.${'o'.repeat(52)}`;

  it('reads the key of a versioned link, and nothing else', () => {
    expect(versionedLinkKey(PEAR_V2.uiAsset)).toBe(
      'cktxzetiwt6un3ado5kgqedge6ya4nfazjckzq76zcapefwxakdy',
    );
    for (const bad of [
      `pear://${'o'.repeat(52)}`,
      `pear://0.12.${'o'.repeat(52)}/x`,
      `pear://0.12.${'O'.repeat(52)}`,
      `pear://0.12.${'o'.repeat(51)}`,
      `https://0.12.${'o'.repeat(52)}`,
      42,
      null,
    ])
      expect(versionedLinkKey(bad), String(bad)).toBeNull();
  });

  it('is refused today, naming both owner steps', () => {
    const open = releaseRefusals({ line: RELEASE_LINE, uiDrive: UI_DRIVE });
    expect(open).toHaveLength(2);
    expect(open[0]).toMatch(/RELEASE_LINE.*the owner creates and seeds one/);
    expect(open[1]).toMatch(/Holepunch’s .*the owner re-homes it on a SovTech key/);
  });

  it('is refused while the UI drive is Holepunch’s, even once the release line exists', () => {
    expect(UI_DRIVE).toBe(PEAR_V2.uiAsset);
    expect(releaseRefusals({ line, uiDrive: UI_DRIVE })).toEqual([
      expect.stringMatching(/^the Electron UI drive is still Holepunch’s/),
    ]);
    // Another fork or length of Holepunch's key is still Holepunch's.
    expect(
      releaseRefusals({ line, uiDrive: `pear://0.941.${versionedLinkKey(PEAR_V2.uiAsset)}` }),
    ).toHaveLength(1);
    expect(releaseRefusals({ line, uiDrive: 'pear://cktxz' })).toEqual([
      expect.stringMatching(/not a versioned pear:\/\/ link/),
    ]);
  });

  it('is allowed once both are the owner’s', () => {
    expect(releaseRefusals({ line, uiDrive: ours })).toEqual([]);
  });

  it('carries the UI drive it names, and only that one', () => {
    const pe = (link: unknown): unknown => ({ pear: { assets: { ui: { link } } } });
    const app = JSON.parse(
      readFileSync(join(here, '..', '..', 'app', 'package.json'), 'utf8'),
    ) as unknown;
    expect(uiDriveMismatches({ uiDrive: UI_DRIVE, pearElectron: pe(UI_DRIVE), app })).toEqual([]);
    expect(uiDriveMismatches({ uiDrive: ours, pearElectron: pe(UI_DRIVE), app })).toHaveLength(1);
    expect(uiDriveMismatches({ uiDrive: UI_DRIVE, pearElectron: {}, app })).toHaveLength(1);
    expect(
      uiDriveMismatches({
        uiDrive: UI_DRIVE,
        pearElectron: pe(UI_DRIVE),
        app: { pear: { assets: { ui: { link: ours } } } },
      }),
    ).toEqual(['app/package.json names assets of its own: the UI drive is UI_DRIVE']);
  });

  it('stage.ts refuses one before it builds or copies anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nf-release-'));
    try {
      const out = join(dir, 'app');
      const r = spawnSync(process.execPath, [join(here, '..', 'stage.ts'), '--out', out], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('a release cannot be staged yet');
      expect(r.stderr).toContain('RELEASE_LINE');
      expect(r.stderr).toContain('Holepunch’s');
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
