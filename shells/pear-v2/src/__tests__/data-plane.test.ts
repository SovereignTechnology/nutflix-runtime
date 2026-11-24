import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkerRuntime } from '@nutflix-runtime/worker/runtime';
import { describe, expect, it } from 'vitest';

import { dataPlaneOnly, watchOnly, watchOnlyRefusal } from '../bare/data-plane.ts';

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

  it('says what is wrong, and for stored videos what the user can remove', () => {
    const dir = '/home/u/.config/pear/app-storage/by-dkey/x/worker';
    expect(watchOnlyRefusal({ watched: false, videos: [], listening: [] }, dir)).toBeNull();
    expect(watchOnlyRefusal({ watched: true, videos: [], listening: [] }, dir)).toMatch(
      /did not turn "seed what you watch" off/,
    );
    expect(watchOnlyRefusal({ watched: false, videos: [], listening: [{}] }, dir)).toMatch(
      /listening for peers/,
    );
    const stored = watchOnlyRefusal(
      { watched: false, videos: [{ video: 'a' }, { video: 'b' }], listening: [] },
      dir,
    );
    expect(stored).toMatch(
      /^this app's storage holds 2 stored videos, and this build is watch only/,
    );
    expect(stored).toContain(`delete the folder ${dir}/nfx`);
    expect(stored).not.toMatch(/would not turn seeding off/);
    expect(watchOnlyRefusal({ watched: false, videos: [{}], listening: [] }, dir)).toMatch(
      /holds 1 stored video,/,
    );
    expect(watchOnlyRefusal(null, dir)).toMatch(/no seeding status/);
    expect(watchOnlyRefusal({ watched: false, listening: [] }, dir)).toMatch(/no list of stored/);
  });

  it('main asks for it, and holds no sealed key', () => {
    const src = readFileSync(join(here, '..', 'bare', 'main.ts'), 'utf8');
    expect(src).toContain("gate.request('seeding.set', { watched: false })");
    expect(src).toContain("watchOnlyRefusal(await gate.request('seeding.status', {}), storage)");
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
