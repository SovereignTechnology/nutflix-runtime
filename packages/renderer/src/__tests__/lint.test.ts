// @vitest-environment node
/**
 * ADR 0001 amendment, item 1: "`innerHTML` and `dangerouslySetInnerHTML` are refused by lint".
 * This runs the very block of the repository's `eslint.config.js` that applies to this package
 * over code that breaks each rule, and over code that does not; then scans this package's own
 * source for the names, as a second line.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const pkg = join(here, '..', '..');

interface Block {
  readonly name?: string;
  readonly rules?: Record<string, unknown>;
  readonly files?: readonly unknown[];
}
const config = (await import(pathToFileURL(join(root, 'eslint.config.js')).href)) as {
  default: readonly Block[];
};
const block = config.default.find((c) => c.name === 'renderer/no-remote-html');

function lint(code: string, file = 'packages/renderer/src/x.tsx'): string[] {
  const linter = new Linter({ cwd: root, configType: 'flat' });
  const messages = linter.verify(
    code,
    [
      {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
      },
      block as never,
    ],
    { filename: file },
  );
  return messages.map((m) => `${m.ruleId ?? 'parse'}: ${m.message}`);
}

describe('the lint block for packages/renderer', () => {
  it('exists, and covers .ts and .tsx under the package', () => {
    expect(block).toBeDefined();
    expect(block?.files).toEqual(['packages/renderer/**/*.{ts,tsx}']);
  });

  it.each([
    ['innerHTML', 'el.innerHTML = remote.title;'],
    ['innerHTML, computed', "el['innerHTML'] = remote.title;"],
    ['innerHTML read', 'const h = el.innerHTML;'],
    ['outerHTML', 'el.outerHTML = remote.title;'],
    ['an innerHTML property', 'Object.assign(el, { innerHTML: remote.title });'],
    ['an innerHTML property, quoted', "const o = { 'innerHTML': remote.title };"],
    [
      'dangerouslySetInnerHTML',
      'const x = <div dangerouslySetInnerHTML={{ __html: remote.title }} />;',
    ],
    ['srcDoc', 'const x = <iframe srcDoc={remote.title} />;'],
    ['insertAdjacentHTML', "el.insertAdjacentHTML('beforeend', remote.title);"],
    ['createContextualFragment', 'range.createContextualFragment(remote.title);'],
    ['DOMParser', "new DOMParser().parseFromString(remote.title, 'text/html');"],
    ['document.write', 'document.write(remote.title);'],
    ['window.open', 'window.open(remote.url);'],
    ['globalThis.open', 'globalThis.open(remote.url);'],
    ['a bare open', 'open(remote.url);'],
    ['location.href', 'location.href = remote.url;'],
    ['window.location.href', 'window.location.href = remote.url;'],
    ['window.location', 'window.location = remote.url;'],
    ['an anchor’s href', 'a.href = remote.url;'],
    ['location.assign', 'window.location.assign(remote.url);'],
    ['location.replace', 'location.replace(remote.url);'],
    ['eval', 'eval(remote.code);'],
    ['new Function', 'new Function(remote.code);'],
  ])('refuses %s', (_name, code) => {
    expect(lint(code), code).not.toEqual([]);
  });

  it('refuses them in a test, a script and a .ts file of the package as well', () => {
    for (const f of [
      'packages/renderer/src/__tests__/x.test.ts',
      'packages/renderer/scripts/x.ts',
      'packages/renderer/e2e/x.e2e.ts',
      'packages/renderer/src/x.ts',
    ]) {
      expect(lint('el.innerHTML = x;', f), f).not.toEqual([]);
    }
  });

  it('allows what the renderer does: text, the history, a hash read, a worker’s own words', () => {
    expect(
      lint(`
        el.textContent = remote.title;
        const t = document.createTextNode(remote.title);
        win.history.replaceState(null, '', win.location.pathname + '#/x');
        const h = win.location.hash;
        const o = { title: remote.title, html: 'is a name, not a sink' };
        const x = <p>{remote.title}</p>;
      `),
    ).toEqual([]);
  });
});

describe('the package’s own source', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      if (n === 'node_modules' || n === 'dist') return [];
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|html)$/.test(n) ? [p] : [];
    });
  }

  it('never names an HTML sink outside the tests that look for one', () => {
    const sinks =
      /innerHTML|outerHTML|dangerouslySetInnerHTML|insertAdjacentHTML|document\.write|srcdoc/i;
    const own = files(pkg).filter(
      (f) =>
        !/__tests__[\\/]lint\.test\.ts$/.test(f) && !/__tests__[\\/]ui-text\.test\.tsx$/.test(f),
    );
    expect(own.length).toBeGreaterThan(10);
    const found = own.filter((f) => sinks.test(readFileSync(f, 'utf8')));
    expect(found).toEqual([]);
  });
});
