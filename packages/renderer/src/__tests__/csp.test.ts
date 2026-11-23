// @vitest-environment node
/**
 * The page's policy (ADR 0001 amendment, item 1): a strict CSP as the first element of `<head>`,
 * no inline script and no `eval`, `connect-src` and `media-src` no wider than the renderer needs.
 * Each addition for the WebRTC player is pinned here with its reason:
 *
 *   script-src  'wasm-unsafe-eval'  compiles nfx's WASM verifier; `eval` stays refused
 *   media-src   blob:               hls.js plays through a MediaSource, which is a `blob:` URL
 *   connect-src blob:               the library's `init` fetches the sha256-checked WASM bytes
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { policyOf } from '../../scripts/policy.ts';

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html'),
  'utf8',
);

function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const d of policy.split(';')) {
    const [name, ...values] = d.trim().split(/\s+/);
    if (name !== undefined && name !== '') out.set(name, values);
  }
  return out;
}

describe('index.html', () => {
  const policy = policyOf(html);
  const d = directives(policy);

  it('has the policy as the first element of <head>, before even the charset', () => {
    const head = html.slice(html.search(/<head\b[^>]*>/i));
    const firstTag = /<head\b[^>]*>\s*<(\w+)/i.exec(head)?.[1];
    expect(firstTag).toBe('meta');
    expect(head.search(/Content-Security-Policy/i)).toBeLessThan(head.search(/charset/i));
    expect(html.match(/Content-Security-Policy/gi)).toHaveLength(1);
  });

  it('allows no inline script and no eval, anywhere', () => {
    // `'wasm-unsafe-eval'` is the one exception, and is not `'unsafe-eval'`.
    expect(policy.replaceAll("'wasm-unsafe-eval'", '')).not.toMatch(
      /unsafe-inline|unsafe-eval|unsafe-hashes|strict-dynamic/,
    );
    expect(d.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(d.get('style-src')).toEqual(["'self'"]);
    expect(html).not.toMatch(/<script\b(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=|javascript:|\sstyle\s*=/i);
  });

  it('denies everything it does not name', () => {
    expect(d.get('default-src')).toEqual(["'none'"]);
    for (const none of [
      'worker-src',
      'manifest-src',
      'child-src',
      'frame-src',
      'object-src',
      'base-uri',
      'form-action',
    ]) {
      expect(d.get(none), none).toEqual(["'none'"]);
    }
  });

  it('plays media from the worker’s loopback server, or hls.js’s own MediaSource', () => {
    expect(d.get('media-src')).toEqual(['http://127.0.0.1:*', 'blob:']);
  });

  it('reaches relays (wss), the viewer’s NIP-11 and signed-image hosts (https), and loopback, nothing else', () => {
    expect(d.get('connect-src')).toEqual([
      "'self'",
      'wss:',
      'ws://127.0.0.1:*',
      'http://127.0.0.1:*',
      'https:',
      'blob:',
    ]);
    // No bare `*`, no plain `http:` or `ws:`, no `data:` to connect to.
    for (const v of d.get('connect-src') ?? []) expect(v).not.toMatch(/^(\*|http:|ws:|data:)$/);
  });

  it('shows images only from its own files and from blob: URLs of verified bytes', () => {
    expect(d.get('img-src')).toEqual(["'self'", 'blob:']);
    expect(d.get('font-src')).toEqual(["'self'"]);
  });

  it('refuses a document whose first <head> element is not the policy', () => {
    expect(() => policyOf('<html><head><meta charset="utf-8" /></head></html>')).toThrow(
      /first element/,
    );
    expect(() => policyOf('<html><head></head></html>')).toThrow(/first element/);
  });

  it('preloads the pinned library’s two modules, so that SRI covers them', () => {
    expect(
      [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]),
    ).toEqual(['nfx/wasm.js', 'nfx/player.js']);
  });

  it('loads its script as a module and its two stylesheets from itself', () => {
    expect(html).toContain('<script type="module" src="app.js"></script>');
    expect([...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'ui.css',
      'shell.css',
    ]);
  });
});
