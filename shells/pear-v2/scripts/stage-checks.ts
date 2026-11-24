/** The pure parts of `stage.ts`: what the staged page must look like. Unit-tested. */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import { policyOf } from '../../../packages/renderer/scripts/policy.ts';
import { isReleaseLine, type ReleaseLine } from '../src/shared/pins.ts';

export function sri(bytes: Uint8Array): string {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

/** `<key>:<fork>:<length>`. */
export function parseTestLine(raw: string): ReleaseLine {
  const [key, fork, length, extra] = raw.split(':');
  const line = { key, fork: Number(fork), length: Number(length) };
  if (extra !== undefined || !isReleaseLine(line))
    throw new Error('stage: --test-line takes <z32 key>:<fork>:<length>');
  return line;
}

/**
 * The legacy stylesheet and classic script, directly before the renderer's module script, so that
 * the pipe exists when the module runs and the CSP `<meta>` stays the first element.
 */
export function insertLegacyTags(
  html: string,
  hashes: { readonly js: string; readonly css: string },
): string {
  const at = /<script\s+type="module"/g;
  const hits = html.match(at)?.length ?? 0;
  if (hits !== 1) throw new Error(`stage: expected one module script, found ${String(hits)}`);
  const tags =
    `<link rel="stylesheet" href="legacy.css" integrity="${hashes.css}" />\n    ` +
    `<script src="legacy.js" integrity="${hashes.js}"></script>\n    `;
  return html.replace(/<script\s+type="module"/, `${tags}<script type="module"`);
}

/** What is wrong with a staged page; empty when nothing is. */
export function checkStagedHtml(html: string): string[] {
  const problems: string[] = [];
  let policy = '';
  try {
    policy = policyOf(html);
  } catch {
    problems.push('the CSP <meta> is not the first element of <head>');
  }
  const scriptSrc = /(?:^|;)\s*script-src\s+([^;]*)/.exec(policy)?.[1] ?? '';
  if (scriptSrc === '') problems.push('the policy has no script-src');
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", 'data:', 'blob:', '*', 'http:', 'https:'])
    if (scriptSrc.split(/\s+/).includes(bad)) problems.push(`script-src allows ${bad}`);
  if (!/(?:^|;)\s*object-src\s+'none'/.test(policy)) problems.push("object-src is not 'none'");
  if (!/(?:^|;)\s*base-uri\s+'none'/.test(policy)) problems.push("base-uri is not 'none'");
  if (!/(?:^|;)\s*frame-src\s+'none'/.test(policy)) problems.push("frame-src is not 'none'");
  const body = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? '';
    if ((m[2] ?? '').trim() !== '') problems.push('an inline script');
    if (!/\bsrc="/.test(attrs)) problems.push('a script with no src');
    if (!/\bintegrity="sha(256|384|512)-/.test(attrs)) problems.push('a script with no SRI hash');
  }
  for (const m of body.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gi))
    if (!/\bintegrity="sha(256|384|512)-/.test(m[0])) problems.push('a stylesheet with no SRI');
  if (/<style\b/i.test(body)) problems.push('an inline <style>');
  if (/\son[a-z]+\s*=/i.test(body)) problems.push('an inline event handler');
  if (/javascript:/i.test(body)) problems.push('a javascript: URL');
  return problems;
}

/** What a module of tsc's (or esbuild's) ES output imports: relative paths and package names. */
export function importsOf(source: string): { relative: string[]; packages: string[] } {
  const specs = [
    ...source.matchAll(/^\s*import\s+['"]([^'"\n]+)['"]/gm),
    ...source.matchAll(/^\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"\n]+)['"]/gm),
    ...source.matchAll(/\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g),
  ].map((m) => m[1] ?? '');
  const relative = new Set<string>();
  const packages = new Set<string>();
  for (const s of specs) {
    if (s.startsWith('./') || s.startsWith('../')) relative.add(s);
    else if (s !== '') {
      const parts = s.split('/');
      packages.add(s.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? s));
    }
  }
  return { relative: [...relative].sort(), packages: [...packages].sort() };
}

/**
 * Every module reachable from `roots` by static or dynamic import, inside one directory
 * (`read(rel)` gives a file's text, or `null`), and the packages each imports. A path that leaves
 * the directory, or a module that is not there, is an error.
 */
export function moduleClosure(
  read: (rel: string) => string | null,
  roots: readonly string[],
): { files: string[]; packages: Map<string, string[]> } {
  const files = new Set<string>();
  const packages = new Map<string, string[]>();
  const queue = [...roots];
  while (queue.length > 0) {
    const rel = posix.normalize(queue.shift() ?? '');
    if (rel.startsWith('../') || rel.startsWith('/'))
      throw new Error(`stage: ${rel} leaves the worker`);
    if (files.has(rel)) continue;
    const text = read(rel);
    if (text === null) throw new Error(`stage: the worker has no ${rel}`);
    files.add(rel);
    const { relative, packages: pkgs } = importsOf(text);
    for (const p of pkgs) packages.set(p, [...(packages.get(p) ?? []), rel]);
    for (const r of relative) queue.push(posix.join(posix.dirname(rel), r));
  }
  return { files: [...files].sort(), packages };
}

/** What a watch-only build must not load: Studio's process runner, the bunker's socket, `env`. */
export const SYSTEM_ONLY_PACKAGES: readonly string[] = ['bare-env', 'bare-subprocess', 'bare-ws'];

/** A lockfile's `packages` entries, as far as the stage reads them. */
export type LockPackages = Readonly<
  Record<
    string,
    {
      readonly version?: string;
      readonly name?: string;
      readonly optional?: boolean;
      readonly dev?: boolean;
      readonly link?: boolean;
    }
  >
>;

/**
 * What differs between a lockfile and the packages staged from it. `staged` maps each package's
 * path (`node_modules/a`, `node_modules/a/node_modules/@s/b`) to its own `package.json` name and
 * version. Every package must be the lockfile's, at its version, and every package the lockfile
 * installs must be there. `extra` names paths the stage adds itself (`@sovit/*`).
 */
export function lockMismatches(
  lock: LockPackages,
  staged: ReadonlyMap<string, { readonly name: unknown; readonly version: unknown }>,
  extra: (path: string) => boolean = () => false,
): string[] {
  const out: string[] = [];
  const nameOf = (path: string): string => path.slice(path.lastIndexOf('node_modules/') + 13);
  for (const [path, entry] of Object.entries(lock)) {
    if (!path.startsWith('node_modules/') || entry.link === true || entry.dev === true) continue;
    const got = staged.get(path);
    if (got === undefined) {
      if (entry.optional !== true) out.push(`${path}: missing`);
      continue;
    }
    const want = entry.name ?? nameOf(path);
    if (got.name !== want) out.push(`${path}: name ${String(got.name)}, lockfile ${want}`);
    if (got.version !== entry.version)
      out.push(`${path}: version ${String(got.version)}, lockfile ${String(entry.version)}`);
  }
  for (const path of staged.keys())
    if (!(path in lock) && !extra(path)) out.push(`${path}: not in the lockfile`);
  return out.sort();
}
