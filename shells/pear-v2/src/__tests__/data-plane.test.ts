import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkerRuntime } from '@nutflix-runtime/worker/runtime';
import { describe, expect, it } from 'vitest';

import { dataPlaneOnly, watchOnly } from '../bare/data-plane.ts';

const here = dirname(fileURLToPath(import.meta.url));
const shell = join(here, '..', '..');

describe('what the worker is given', () => {
  const base = {
    fs: {} as WorkerRuntime['fs'],
    rmTree: () => Promise.resolve(),
    createHttpServer: () => Promise.reject(new Error('unused')),
  };

  it('is the data plane, by name', () => {
    expect(Object.keys(dataPlaneOnly(base)).sort()).toEqual(['createHttpServer', 'fs', 'rmTree']);
  });

  it('leaves out `system`, which is what builds a signer with a key file', () => {
    const full = { ...base, system: { writePrivate: () => Promise.resolve() } };
    expect(dataPlaneOnly(full as unknown as WorkerRuntime)).not.toHaveProperty('system');
  });

  it.each(['main.ts', 'smoke.ts'])('%s gives the worker nothing else', (file) => {
    const src = readFileSync(join(here, '..', 'bare', file), 'utf8');
    expect(src).toContain('runtime: dataPlaneOnly(bareDataPlane())');
    expect(src).toContain("from '../../../../packages/worker/src/adapters/bare-data.js'");
    expect(src).not.toMatch(/bareRuntime|adapters\/bare\.js/);
  });
});

describe('seeding is off at start', () => {
  it('accepts only off, listening nowhere and holding no video', () => {
    expect(watchOnly({ watched: false, videos: [], listening: [] })).toBe(true);
  });

  it.each([
    [{ watched: true, videos: [], listening: [] }],
    [{ watched: false, videos: [], listening: [{ namespace: 'x' }] }],
    [{ watched: false, videos: [{ video: 'v' }], listening: [] }],
    [{ watched: false, listening: [] }],
    [{ watched: 'false', videos: [], listening: [] }],
    [null],
    ['off'],
  ])('refuses %j', (s) => {
    expect(watchOnly(s)).toBe(false);
  });

  it('main asks for it, and holds no sealed key', () => {
    const src = readFileSync(join(here, '..', 'bare', 'main.ts'), 'utf8');
    expect(src).toContain("gate.request('seeding.set', { watched: false })");
    expect(src).toContain('localKey: false');
    expect(src).toContain('watchOnly: true');
    expect(src).toContain("linkKind(Pear.config.link) === 'unversioned'");
  });
});

describe('shape (b) depends on nothing in shape (a)', () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return n === '__tests__' ? [] : sources(p);
      return n.endsWith('.ts') ? [p] : [];
    });

  it('imports no file of shells/pear-v3', () => {
    const files = ['src', 'scripts', 'proof'].flatMap((d) => sources(join(shell, d)));
    expect(files.length).toBeGreaterThan(10);
    const bad = files.filter((f) =>
      /from\s+['"][^'"]*pear-v3|import\(['"][^'"]*pear-v3/.test(readFileSync(f, 'utf8')),
    );
    expect(bad).toEqual([]);
  });
});
