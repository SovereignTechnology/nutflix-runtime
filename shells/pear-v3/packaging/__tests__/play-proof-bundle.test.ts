/**
 * The packaged-playback proof is bundled into a TEST build's main only: main is bundled here the way
 * `stage.ts` bundles it, and a release or launch root's main holds none of the proof's own words,
 * while a test root's holds them all. `assertMainMatchesRoot` refuses a non-test main that does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { throwawayLaunchRoot } from '../../scripts/release/launch-subject.ts';
import * as off from '../../src/main/play-proof-off.ts';
import * as on from '../../src/main/play-proof.ts';
import { encodeBakedRoot, parseTrustRoot, type TrustRoot } from '../../src/update/root.ts';
import { PKG_DIR } from '../paths.ts';
import { mainBuildOptions } from '../stage.ts';
import { PLAY_PROOF_WORDS, assertMainMatchesRoot, releaseRoot } from '../update-root.ts';

const TEST_ROOT = parseTrustRoot({
  v: 1,
  channel: 'test',
  pubkey: 'ab'.repeat(32),
  relays: ['ws://127.0.0.1:7777'],
  upgrade: `pear://${'y'.repeat(52)}`,
  dht: ['127.0.0.1:49737'],
  delayMs: 0,
  play: {
    relays: ['ws://127.0.0.1:7778'],
    video: `38504:${'cd'.repeat(32)}:nfx:testnet:1:packaged-playback-1`,
  },
});

async function mainFor(root: TrustRoot): Promise<string> {
  const r = await build({
    ...mainBuildOptions(root),
    absWorkingDir: PKG_DIR,
    bundle: true,
    minify: false,
    write: false,
    logLevel: 'silent',
    tsconfig: join(PKG_DIR, 'tsconfig.json'),
  });
  return r.outputFiles.map((f) => f.text).join('\n');
}

describe('the playback proof in main’s bundle', () => {
  it('names words that only its own module holds', () => {
    const src = (name: string): string => readFileSync(join(PKG_DIR, 'src', 'main', name), 'utf8');
    expect(src('play-proof.ts')).toContain("'play-proof-done'");
    expect(src('play-proof.ts')).toContain('.getVideoPlaybackQuality(');
    for (const f of ['play-proof-off.ts', 'main.ts'])
      for (const w of PLAY_PROOF_WORDS) expect(src(f), `${f} holds ${w}`).not.toContain(w);
  });

  it('is replaced by a stand-in with the same two names, which does nothing', async () => {
    expect(Object.keys(off).sort()).toEqual(['OffLoopback', 'runPlayProof']);
    for (const k of ['OffLoopback', 'runPlayProof'] as const)
      expect(typeof off[k]).toBe(typeof on[k]);
    const o = new off.OffLoopback();
    o.see('wss://relay.example.org/');
    expect(o.take()).toBe(0);
    let touched = false;
    await off.runPlayProof(TEST_ROOT.play ?? { relays: [], video: '' }, {
      page: {
        run: () => {
          touched = true;
          return Promise.resolve(null);
        },
        load: () => {
          touched = true;
          return Promise.resolve();
        },
        destroyed: () => false,
      },
      playSessions: () => Promise.resolve(0),
      requests: new on.OffLoopback(),
      log: () => {
        touched = true;
      },
      now: () => 0,
      sleep: () => Promise.resolve(),
    });
    expect(touched).toBe(false);
  });

  it('is in a test build’s main, and in no release or launch build’s', async () => {
    const test = await mainFor(TEST_ROOT);
    for (const w of PLAY_PROOF_WORDS) expect(test).toContain(w);
    for (const root of [releaseRoot(), throwawayLaunchRoot()]) {
      const main = await mainFor(root);
      for (const w of PLAY_PROOF_WORDS) expect(main, `${root.channel} holds ${w}`).not.toContain(w);
      // The bundle a release check reads: the same root as the updater's, and no proof.
      expect(() => {
        assertMainMatchesRoot(main, root);
      }).not.toThrow();
    }
  }, 60_000);

  it('is refused in a main whose root is not a test root', () => {
    const r = releaseRoot();
    const main = `x = { updates: false ? "on" : "off" };\nif (false) await startUpdates();\nconst root = "${encodeBakedRoot(r)}";\nlog("play-proof-done");\n`;
    expect(() => {
      assertMainMatchesRoot(main, r);
    }).toThrow(/carries the playback proof/);
  });
});
