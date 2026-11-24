import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PEAR_V2 } from '../../src/shared/pins.ts';
import {
  SYSTEM_ONLY_PACKAGES,
  checkStagedHtml,
  importsOf,
  insertLegacyTags,
  moduleClosure,
  parseTestLine,
  sri,
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
