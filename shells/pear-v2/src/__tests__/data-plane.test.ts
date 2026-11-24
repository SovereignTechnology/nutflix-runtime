import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkerRuntime } from '@nutflix-runtime/worker/runtime';
import { describe, expect, it } from 'vitest';

import { dataPlaneOnly } from '../bare/data-plane.ts';

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
    expect(dataPlaneOnly(full)).not.toHaveProperty('system');
  });

  it.each(['main.ts', 'smoke.ts'])('%s gives the worker nothing else', (file) => {
    const src = readFileSync(join(here, '..', 'bare', file), 'utf8');
    expect(src).toContain('runtime: dataPlaneOnly(bareRuntime())');
    expect(src).not.toMatch(/runtime:\s*bareRuntime\(\)/);
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
