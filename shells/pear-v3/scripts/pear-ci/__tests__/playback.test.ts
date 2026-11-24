/**
 * The install job's own instruments for the packaged-playback proof (`playback.ts`): the clip is
 * checked as a watcher would check it, a play passes only on measured numbers, and the sha256 check
 * is proved only when every file the liar served wrong was fetched again from the honest seeder.
 */
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Role } from '@sovit/core/nfx';

import {
  SeederLog,
  flipped,
  loadClip,
  loopbackNodes,
  playProblems,
  seederProblems,
} from '../playback.ts';
import { writeTestClip } from './clip-fixture.ts';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const writeClip = (tamper?: (files: Map<string, Uint8Array>) => void): string => {
  const d = writeTestClip(tamper);
  dirs.push(d);
  return d;
};

describe('the clip', () => {
  it('is read and checked against its own hash list', () => {
    const c = loadClip(writeClip());
    expect(c.files.size).toBe(7);
    expect([...c.roles.values()].filter((r) => r === 'segment')).toHaveLength(3);
    expect(c.roles.get(c.root)).toBeUndefined();
  });

  it('is refused when a file is not its sha256', () => {
    const dir = writeClip();
    const c = loadClip(dir);
    const seg = [...c.roles].find(([, r]) => r === 'segment')?.[0] ?? '';
    writeFileSync(join(dir, seg), utf8('something else'));
    expect(() => loadClip(dir)).toThrow(/not its own sha256/);
  });

  it('is refused when it holds a file its hash list does not name', () => {
    expect(() =>
      loadClip(
        writeClip((files) => {
          const extra = utf8('extra');
          files.set(sha(extra), extra);
        }),
      ),
    ).toThrow(/does not name/);
  });
});

describe('the private DHT the world joins', () => {
  it('takes loopback nodes only', () => {
    expect(loopbackNodes('127.0.0.1:49737,127.0.0.1:49738')).toEqual([
      { host: '127.0.0.1', port: 49737 },
      { host: '127.0.0.1', port: 49738 },
    ]);
    expect(() => loopbackNodes('88.99.3.86:49737')).toThrow(/127\.0\.0\.1/);
    expect(() => loopbackNodes('127.0.0.1:49737,node1.hyperdht.org:49737')).toThrow();
  });

  it('flips every byte of what the liar serves', () => {
    const b = utf8('abc');
    const f = flipped(b);
    expect(f.length).toBe(3);
    expect(sha(f)).not.toBe(sha(b));
    expect([...f].every((x, i) => (x ^ (b[i] ?? 0)) === 0xff)).toBe(true);
  });
});

const measured = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  path: 'progressive',
  stage: 'measured',
  source: 'progressive',
  t0: 0.2,
  t1: 6.2,
  advanced: 6,
  frames0: 5,
  frames1: 155,
  dropped: 0,
  width: 320,
  height: 240,
  error: 0,
  offLoopback: 0,
  offLoopbackBefore: 0,
  ...over,
});
const SIZE = { width: 320, height: 240 };

describe('what a play must show', () => {
  it('passes on the measurements of a real play', () => {
    expect(playProblems(measured(), 'progressive', SIZE)).toEqual([]);
    expect(playProblems(measured({ source: 'mse' }), 'webrtc', SIZE)).toEqual([]);
  });

  it('lets only the first play follow a page that had the renderer’s defaults', () => {
    expect(playProblems(measured({ offLoopbackBefore: 3 }), 'progressive', SIZE)).toEqual([]);
    expect(
      playProblems(measured({ source: 'mse', offLoopbackBefore: 3 }), 'webrtc', SIZE).join(),
    ).toMatch(/3 requests left loopback before the play/);
  });

  it.each([
    ['no report', undefined, /no report/],
    ['a stop', measured({ stage: 'no-play-button' }), /no-play-button/],
    ['the wrong source', measured({ source: 'mse' }), /plays from "mse"/],
    ['a clock that barely moved', measured({ advanced: 1.5 }), /advanced 1\.5/],
    ['few frames while measured', measured({ frames0: 100, frames1: 150 }), /50 frames counted/],
    ['most frames dropped', measured({ dropped: 100 }), /55 frames decoded/],
    ['another size', measured({ width: 640 }), /640x240/],
    ['a media error', measured({ error: 3 }), /media error 3/],
    ['a request off loopback', measured({ offLoopback: 2 }), /2 requests left loopback/],
    ['a number that is text', measured({ advanced: '6' }), /advanced 6 s/],
  ])('fails on %s', (_n, m, re) => {
    expect(playProblems(m, 'progressive', SIZE).join('; ')).toMatch(re);
  });
});

describe('what the seeders must have seen', () => {
  const roles = new Map<string, Role>([
    ['i', 'init'],
    ['s0', 'segment'],
    ['s1', 'segment'],
    ['p', 'playlist'],
  ]);
  const log = (served: [string, number, boolean][], dialed = true, sent = 10): SeederLog => {
    const l = new SeederLog();
    if (dialed) l.dialers.add('ab'.repeat(32));
    for (const [s, seq, bad] of served) l.served.push({ sha: s, seq, bad, size: 10, sent });
    return l;
  };

  it('passes when every bad file was fetched again from the honest seeder', () => {
    const liar = log([
      ['p', 1, false],
      ['i', 2, true],
      ['s0', 3, true],
    ]);
    const honest = log([
      ['i', 4, false],
      ['s0', 5, false],
      ['s1', 6, false],
    ]);
    expect(seederProblems(honest, liar, roles)).toEqual([]);
  });

  it('fails when the liar was never asked: nothing proved the check', () => {
    const honest = log([
      ['i', 1, false],
      ['s0', 2, false],
      ['s1', 3, false],
    ]);
    expect(seederProblems(honest, log([]), roles).join()).toMatch(/nothing proved/);
  });

  it('fails when the liar’s bad file was cut short: nothing was checked', () => {
    const liar = log([['i', 1, true]], true, 4);
    const honest = log([
      ['i', 2, false],
      ['s0', 3, false],
      ['s1', 4, false],
    ]);
    expect(seederProblems(honest, liar, roles).join()).toMatch(/no bad file whole/);
  });

  it('fails when a bad file was never fetched again (the app kept it)', () => {
    const liar = log([['s1', 3, true]]);
    const honest = log([
      ['i', 1, false],
      ['s0', 2, false],
      ['s1', 2, false],
    ]);
    expect(seederProblems(honest, liar, roles).join()).toMatch(/never sent again whole/);
  });

  it('fails when the honest seeder was never dialed or served too little', () => {
    expect(seederProblems(log([], false), log([['i', 1, true]]), roles).join(' | ')).toMatch(
      /never dialed.*never sent the init whole.*0 segments whole/,
    );
  });
});
