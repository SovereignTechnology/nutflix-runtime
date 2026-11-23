import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { policyOf } from '../../../../packages/renderer/scripts/policy.ts';
import { APP_FILES, createAppProtocolHandler, resolveAppPath } from '../main/app-protocol.ts';
import { CspError, assertStrict, headerPolicy, parsePolicy } from '../main/csp.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const INDEX = readFileSync(join(HERE, '../../../../packages/renderer/index.html'), 'utf8');

describe("the header policy is the renderer's own", () => {
  it("is the <meta> policy of the renderer's index.html plus frame-ancestors, nothing else", () => {
    expect(headerPolicy(INDEX)).toBe(`${policyOf(INDEX)}; frame-ancestors 'none'`);
  });

  it("keeps what the renderer relies on: its own scripts, the worker's loopback media", () => {
    const d = parsePolicy(headerPolicy(INDEX));
    expect(d.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(d.get('media-src')).toEqual(['http://127.0.0.1:*', 'blob:']);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
    expect(d.get('default-src')).toEqual(["'none'"]);
  });

  it.each([
    [
      "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'",
      "script-src 'self' 'wasm-unsafe-eval'",
    ],
    ["script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'", "script-src 'self' 'wasm-unsafe-eval'"],
    ["script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'"],
    ["script-src 'self' 'wasm-unsafe-eval' https:", "script-src 'self' 'wasm-unsafe-eval'"],
    ['style-src *', "style-src 'self'"],
    ["frame-src 'self'", "frame-src 'none'"],
    ["object-src 'self'", "object-src 'none'"],
  ])('refuses a looser policy (%s)', (loose, strict) => {
    expect(() => {
      assertStrict(policyOf(INDEX).replace(strict, loose));
    }).toThrow(CspError);
  });

  it('refuses a missing directive, a repeated one, and a frame-ancestors in the <meta>', () => {
    expect(() => {
      assertStrict(policyOf(INDEX).replace("object-src 'none'; ", ''));
    }).toThrow(CspError);
    expect(() => {
      parsePolicy("default-src 'none'; default-src *");
    }).toThrow(CspError);
    expect(() => {
      assertStrict(`${policyOf(INDEX)}; frame-ancestors 'none'`);
    }).toThrow(CspError);
  });
});

describe('resolveAppPath', () => {
  it.each([
    ['app://nutflix/', 'index.html'],
    ['app://nutflix/index.html', 'index.html'],
    ['app://nutflix/app.js', 'app.js'],
    ['app://nutflix/ui.css?x=1#y', 'ui.css'],
    // The URL parser resolves a plain dot segment before the handler sees it: still inside the bundle.
    ['app://nutflix/a/../index.html', 'index.html'],
  ])('%s -> %s', (url, rel) => {
    expect(resolveAppPath(url)).toBe(rel);
  });

  it.each([
    'app://other/index.html',
    'app://user@nutflix/index.html',
    'https://nutflix/index.html',
    'file:///etc/passwd',
    'app://nutflix/../etc/passwd',
    'app://nutflix/%2e%2e/index.html',
    'app://nutflix/%2E%2E%2findex.html',
    'app://nutflix/a%2fb.js',
    'app://nutflix/a%5cb.js',
    'app://nutflix/index.html%00.png',
    'app://nutflix/.hidden.js',
    'app://nutflix//index.html',
    'app://nutflix/a\\b.js',
    'app://nutflix/readme.txt',
    'app://nutflix/app.js.map',
    'app://nutflix/%',
  ])('refuses %s', (url) => {
    expect(resolveAppPath(url)).toBeNull();
  });
});

describe('the app: handler', () => {
  // Paths as this platform writes them: the handler joins with `path.join`.
  const R = resolve('/r');
  const OUT = resolve('/outside');
  const files = new Map<string, string>([
    [join(R, 'index.html'), '<html></html>'],
    [join(R, 'app.js'), 'x'],
    [join(R, 'ui.css'), 'x'],
    [join(R, 'shell.css'), 'x'],
    [join(R, 'nfx', 'player.js'), 'x'],
    [join(R, 'nfx', 'wasm.js'), 'x'],
    [join(R, 'secret.js'), 'nope'],
    [join(OUT, 'app.js'), 'planted'],
  ]);
  const links = new Map<string, string>([[join(R, 'app.js'), join(OUT, 'app.js')]]);
  const mk = (linked = false) =>
    createAppProtocolHandler({
      root: R,
      csp: "default-src 'none'",
      readFile: (p) => {
        const t = files.get(p);
        return t === undefined
          ? Promise.reject(new Error('ENOENT'))
          : Promise.resolve(Buffer.from(t));
      },
      realpath: (p) => {
        const to = linked ? links.get(p) : undefined;
        return files.has(to ?? p) || p === R
          ? Promise.resolve(to ?? p)
          : Promise.reject(new Error('ENOENT'));
      },
    });
  const get = (h: ReturnType<typeof mk>, url: string, method = 'GET'): Promise<Response> =>
    h(new Request(url, { method }));

  it('serves each bundle file with the policy and no-sniff headers', async () => {
    const h = mk();
    for (const f of APP_FILES) {
      const r = await get(h, `app://nutflix/${f}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-security-policy')).toBe("default-src 'none'");
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    }
    expect((await get(h, 'app://nutflix/')).headers.get('content-type')).toContain('text/html');
  });

  it('serves nothing but the bundle: not another file in the directory, not another method', async () => {
    const h = mk();
    expect((await get(h, 'app://nutflix/secret.js')).status).toBe(404);
    expect((await get(h, 'app://nutflix/../outside/app.js')).status).toBe(404);
    expect((await get(h, 'app://nutflix/index.html', 'POST')).status).toBe(405);
    expect((await get(h, 'app://nutflix/index.html', 'HEAD')).status).toBe(200);
  });

  it('refuses a file that is a symlink out of the directory', async () => {
    const r = await get(mk(true), 'app://nutflix/app.js');
    expect(r.status).toBe(404);
  });
});
