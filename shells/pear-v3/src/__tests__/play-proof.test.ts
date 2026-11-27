/**
 * The packaged-playback proof's main side (`play-proof.ts`): what it stores is what the renderer
 * reads as the viewer's settings (never its public defaults), it acts only through the page's own
 * route and button, it reports measurements and fixed words, and it counts what leaves loopback.
 */
import { describe, expect, it } from 'vitest';

import {
  SETTINGS_KEY as RENDERER_KEY,
  parseStoredSettings,
} from '../../../../packages/renderer/src/settings/store.ts';
import {
  DEFAULT_STUN_SERVERS,
  NFX_NETWORK as RENDERER_NETWORK,
} from '../../../../packages/renderer/src/settings/defaults.ts';
import {
  CLICK_PLAY_CODE,
  HAS_PLAY_CODE,
  HOME_CODE,
  MOUNTED_CODE,
  NFX_NETWORK,
  OffLoopback,
  SAMPLE_CODE,
  SETTINGS_KEY,
  UNANSWERED_STUN,
  isOffLoopback,
  isPublicPlay,
  parseSample,
  readSettingsCode,
  runPlayProof,
  settingsFor,
  watchCode,
  watchHash,
  writeSettingsCode,
  type PlayProofPage,
} from '../main/play-proof.ts';
import { APP_URL } from '../main/schemes.ts';
import type { Fields } from '../main/log.ts';

const PLAY = {
  relays: ['ws://127.0.0.1:7778'],
  video: `38504:${'cd'.repeat(32)}:nfx:testnet:1:packaged-playback-1`,
};

describe('what the proof stores and opens', () => {
  it('uses the renderer’s own key and network', () => {
    expect(SETTINGS_KEY).toBe(RENDERER_KEY);
    expect(NFX_NETWORK).toBe(RENDERER_NETWORK);
  });

  it('stores settings the renderer reads as given, never as its public defaults', () => {
    const hyper = parseStoredSettings(settingsFor(PLAY, 'progressive'));
    expect(hyper.relays).toEqual([]);
    expect(hyper.nfx).toMatchObject({
      enabled: true,
      network: NFX_NETWORK,
      scopedRelays: PLAY.relays,
      webrtc: false,
    });
    const webrtc = parseStoredSettings(settingsFor(PLAY, 'webrtc'));
    expect(webrtc.nfx).toMatchObject({
      scopedRelays: PLAY.relays,
      webrtc: true,
      meshRelays: PLAY.relays,
      stunServers: [UNANSWERED_STUN],
    });
    // Nothing public in either.
    for (const s of [settingsFor(PLAY, 'progressive'), settingsFor(PLAY, 'webrtc')])
      expect(s).not.toMatch(/wss:|nutflix\.xyz|primal|ditto/);
  });

  it('uses the renderer’s default STUN only for a play on public relays (a public-DHT root)', () => {
    const live = {
      relays: ['wss://relay.example.org', 'wss://relay.example.net'],
      video: PLAY.video,
    };
    expect(isPublicPlay(live)).toBe(true);
    expect(isPublicPlay(PLAY)).toBe(false);
    const webrtc = parseStoredSettings(settingsFor(live, 'webrtc'));
    expect(webrtc.nfx).toMatchObject({
      scopedRelays: live.relays,
      webrtc: true,
      meshRelays: live.relays,
      stunServers: [...DEFAULT_STUN_SERVERS],
    });
    expect(parseStoredSettings(settingsFor(live, 'progressive')).nfx?.webrtc).toBe(false);
    // Every other play keeps the STUN address nothing answers.
    expect(parseStoredSettings(settingsFor(PLAY, 'webrtc')).nfx?.stunServers).toEqual([
      UNANSWERED_STUN,
    ]);
  });

  it('follows the renderer’s own Watch route of the root’s video', () => {
    expect(watchHash(PLAY)).toBe(`#/watch/${PLAY.video}`);
    expect(watchCode(PLAY)).toBe(
      `(() => { location.hash = "#/watch/${PLAY.video}"; return true; })()`,
    );
  });
});

describe('what leaves loopback', () => {
  it.each([
    ['wss://relay.nutflix.xyz/', true],
    ['https://example.org/x', true],
    ['http://localhost:4000/', true],
    ['http://192.168.1.2:80/', true],
    ['not a url', true],
    ['ws://127.0.0.1:7778/', false],
    ['http://127.0.0.1:4100/a/b', false],
    ['app://nutflix/index.html', false],
    ['blob:app://nutflix/1234', false],
    ['data:text/plain,x', false],
  ])('%s → %s', (url, off) => {
    expect(isOffLoopback(url)).toBe(off);
  });

  it('counts, and starts again from zero on each take', () => {
    const o = new OffLoopback();
    o.see('wss://relay.primal.net/');
    o.see('ws://127.0.0.1:1/');
    expect(o.take()).toBe(1);
    expect(o.take()).toBe(0);
  });
});

describe('a reading of the page', () => {
  const good = {
    t: 3.5,
    paused: false,
    ended: false,
    readyState: 4,
    error: 0,
    frames: 90,
    dropped: 1,
    width: 320,
    height: 240,
    source: 'progressive',
    visible: true,
  };

  it('is taken as numbers and fixed words', () => {
    expect(parseSample(good)).toEqual(good);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string time', { ...good, t: '3' }],
    ['NaN frames', { ...good, frames: Number.NaN }],
    ['a negative time', { ...good, t: -1 }],
    ['a source the page chose', { ...good, source: 'http://evil/' }],
    ['an error code out of range', { ...good, error: 9 }],
  ])('refuses %s', (_n, x) => {
    expect(parseSample(x)).toBeNull();
  });
});

/** The page as the proof sees it: a clock it moves by sleeping, and a video that plays when pressed. */
function fakePage(o: { button?: boolean } = {}): {
  page: PlayProofPage;
  clock: { t: number };
  loads: string[];
  gestures: boolean[];
  stored: () => string | null;
  sessions: () => number;
} {
  const clock = { t: 0 };
  let stored: string | null = null;
  let playingSince: number | null = null;
  let sessions = 0;
  const loads: string[] = [];
  const gestures: boolean[] = [];
  let hash = '#/';
  const writes = new Map<string, string>(
    (['progressive', 'webrtc'] as const).map((p): [string, string] => [
      writeSettingsCode(settingsFor(PLAY, p)),
      settingsFor(PLAY, p),
    ]),
  );
  const page: PlayProofPage = {
    run: (code, gesture) => {
      if (code === HOME_CODE) {
        hash = '#/';
        sessions = 0;
        playingSince = null;
        return Promise.resolve(true);
      }
      if (code === watchCode(PLAY)) {
        hash = watchHash(PLAY);
        return Promise.resolve(true);
      }
      const w = writes.get(code);
      if (w !== undefined) {
        stored = w;
        return Promise.resolve(true);
      }
      if (code === readSettingsCode()) return Promise.resolve(stored);
      if (code === MOUNTED_CODE) return Promise.resolve(true);
      if (code === HAS_PLAY_CODE)
        return Promise.resolve(o.button !== false && hash === watchHash(PLAY));
      if (code === CLICK_PLAY_CODE) {
        gestures.push(gesture === true);
        if (o.button === false) return Promise.resolve(false);
        playingSince = clock.t + 800;
        sessions = 1;
        return Promise.resolve(true);
      }
      if (code === SAMPLE_CODE) {
        if (playingSince === null || clock.t < playingSince) return Promise.resolve(null);
        const t = (clock.t - playingSince) / 1000 + 0.04;
        return Promise.resolve({
          t,
          paused: false,
          ended: false,
          readyState: 4,
          error: 0,
          frames: Math.floor(t * 25),
          dropped: 0,
          width: 320,
          height: 240,
          source: stored?.includes('"webrtc":true') === true ? 'mse' : 'progressive',
          visible: true,
        });
      }
      return Promise.reject(new Error(`unexpected code ${code.slice(0, 40)}`));
    },
    load: (url) => {
      loads.push(url);
      hash = '';
      sessions = 0;
      playingSince = null;
      return Promise.resolve();
    },
    destroyed: () => false,
  };
  return { page, clock, loads, gestures, stored: () => stored, sessions: () => sessions };
}

describe('the run', () => {
  const run = async (
    o: { button?: boolean } = {},
  ): Promise<{
    logs: [string, Fields][];
    f: ReturnType<typeof fakePage>;
    requests: OffLoopback;
  }> => {
    const f = fakePage(o);
    const logs: [string, Fields][] = [];
    const requests = new OffLoopback();
    // The first page, with the renderer's defaults, asked for a public relay.
    requests.see('wss://relay.primal.net/');
    await runPlayProof(PLAY, {
      page: f.page,
      playSessions: () => Promise.resolve(f.sessions()),
      requests,
      log: (name, fields) => logs.push([name, fields]),
      now: () => f.clock.t,
      sleep: (ms) => {
        f.clock.t += ms;
        return Promise.resolve();
      },
    });
    return { logs, f, requests };
  };

  it('plays both paths through the page’s own route and button, and reports what it measured', async () => {
    const { logs, f } = await run();
    expect(logs.map(([n]) => n)).toEqual(['play-proof', 'play-proof', 'play-proof-done']);
    const [hyper, webrtc] = logs.map(([, x]) => x);
    expect(hyper).toMatchObject({
      path: 'progressive',
      stage: 'measured',
      source: 'progressive',
      width: 320,
      height: 240,
      error: 0,
      offLoopbackBefore: 1,
      offLoopback: 0,
    });
    expect(webrtc).toMatchObject({
      path: 'webrtc',
      stage: 'measured',
      source: 'mse',
      offLoopbackBefore: 0,
    });
    for (const m of [hyper, webrtc]) {
      expect(Number(m?.['advanced'])).toBeGreaterThanOrEqual(5.9);
      expect(Number(m?.['frames1']) - Number(m?.['frames0'])).toBeGreaterThanOrEqual(140);
      expect(Number(m?.['measureMs'])).toBeGreaterThanOrEqual(6_000);
      // Numbers and fixed words only.
      for (const v of Object.values(m ?? {}))
        expect(['number', 'boolean', 'string'].includes(typeof v)).toBe(true);
    }
    expect(f.loads).toEqual([APP_URL, APP_URL]);
    expect(f.gestures).toEqual([true, true]);
    expect(f.stored()).toBe(settingsFor(PLAY, 'webrtc'));
  });

  it('says where it stopped when there is nothing to press, and still ends', async () => {
    const { logs } = await run({ button: false });
    expect(logs).toEqual([
      ['play-proof', { path: 'progressive', stage: 'no-play-button' }],
      ['play-proof', { path: 'webrtc', stage: 'no-play-button' }],
      ['play-proof-done', { paths: 2, offLoopback: 0 }],
    ]);
  });
});
