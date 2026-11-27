/**
 * The install job's packaged-playback proof, on main's side. It runs ONLY in a build whose baked root
 * is a `test` root carrying `play` (`src/update/root.ts`): a `release` or `launch` root refuses that
 * field, the package step reads main's root back and holds it to the updater's
 * (`packaging/update-root.ts`), and nothing at run time names one: no page, setting, environment
 * variable or switch reaches this module. In such a build, once the ready line is out, it does what
 * a viewer does, twice:
 *
 *   1. stores the viewer's settings as the Settings screen stores them: the root's relay as the
 *      network's relay, and WebRTC off (then on, with that relay for signaling and a STUN address
 *      nothing answers on; for a play on public relays, the real-host proof's, the renderer's
 *      default STUN), and loads the page again so that the renderer reads them;
 *   2. follows the renderer's own link route to the root's video, `#/watch/<address>`;
 *   3. presses "Play — free";
 *   4. measures the `<video>`: its media time, Chromium's own frame counts
 *      (`getVideoPlaybackQuality()`), its size and error, and what it plays from (the worker's
 *      progressive stream, or a MediaSource fed by nfx's web player).
 *
 * It runs once per installed copy (main keeps a marker in the user-data directory, made before the
 * first play), so the later launches of the same build in the install job are left alone. It prints
 * numbers and fixed words only (`play-proof` events, then `play-proof-done`) and decides nothing:
 * what passes is the install job's call, from these measurements and the seeders' own counts
 * (`scripts/pear-ci/playback.ts`). Everything it does in the page runs in main's isolated world, as
 * main's other page reads do. Electron-free: the tests drive it with fakes.
 *
 * Only a test build bundles it: any other root's main gets `play-proof-off.ts` in its place
 * (`packaging/stage.ts`), and must not hold this module's own words (`PLAY_PROOF_WORDS`).
 */
import { DEFAULT_STUN_SERVERS } from '../../../../packages/renderer/src/settings/defaults.ts';
import type { PlayProof } from '../update/root.ts';
import type { Fields } from './log.ts';
import { APP_URL } from './schemes.ts';

/** The renderer's settings key (`packages/renderer/src/settings/store.ts`; a test pins the two). */
export const SETTINGS_KEY = 'nutflix.runtime.settings.v1';
/** The one network this build speaks (`packages/renderer/src/settings/defaults.ts`). */
export const NFX_NETWORK = 'nfx:testnet:1';
/** A STUN address on loopback that nothing answers: WebRTC on, and no address leaves the machine. */
export const UNANSWERED_STUN = '127.0.0.1:9';

/**
 * A play on public relays: only a test root on the public DHT may name them (`src/update/root.ts`,
 * the real-host proof, never CI), and then every one of them is a `wss://` origin.
 */
export function isPublicPlay(play: PlayProof): boolean {
  return play.relays.every((u) => u.startsWith('wss://'));
}

/**
 * The STUN servers a play's WebRTC path uses: for a public play, the renderer's defaults, as a
 * viewer's app has them (its peers are out there); for every other play, `UNANSWERED_STUN`.
 */
export function stunFor(play: PlayProof): readonly string[] {
  return isPublicPlay(play) ? [...DEFAULT_STUN_SERVERS] : [UNANSWERED_STUN];
}
/** How long each play is watched once it plays, ms. */
export const MEASURE_MS = 6_000;
/** The button the Watch page shows for a free NFX video (`@sovit/ui`). */
export const PLAY_LABEL = 'Play — free';

export type PlayPath = 'progressive' | 'webrtc';
export const PLAY_PATHS: readonly PlayPath[] = ['progressive', 'webrtc'];

/** What the stored settings are for `path`: the shape `parseStoredSettings` reads. */
export function settingsFor(play: PlayProof, path: PlayPath): string {
  return JSON.stringify({
    v: 1,
    settings: {
      relays: [],
      nfx: {
        enabled: true,
        network: NFX_NETWORK,
        scopedRelays: [...play.relays],
        webrtc: path === 'webrtc',
        meshRelays: [...play.relays],
        stunServers: [...stunFor(play)],
      },
    },
  });
}

/** The renderer's link route to the root's video. The address was checked when the root was parsed. */
export function watchHash(play: PlayProof): string {
  return `#/watch/${play.video}`;
}

/** Follows that route in the page, as a clicked link does. */
export const watchCode = (play: PlayProof): string =>
  `(() => { location.hash = ${JSON.stringify(watchHash(play))}; return true; })()`;

/** Requests the window's session made that do not stay on this machine (`isOffLoopback`). */
export class OffLoopback {
  #n = 0;

  /** The loopback guard's observer: every request the session makes, before the guard decides. */
  see(url: string): void {
    if (isOffLoopback(url)) this.#n += 1;
  }

  /** The count since the last call. */
  take(): number {
    const n = this.#n;
    this.#n = 0;
    return n;
  }
}

/** A request to anything but the app's own files, a `blob:`/`data:` URL or 127.0.0.1. */
export function isOffLoopback(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (u.protocol === 'app:' || u.protocol === 'blob:' || u.protocol === 'data:') return false;
  return u.hostname !== '127.0.0.1';
}

// ---- what runs in the page (main's isolated world) ---------------------------------------------

export const readSettingsCode = (): string =>
  `(() => { try { return localStorage.getItem(${JSON.stringify(SETTINGS_KEY)}); } catch { return null; } })()`;

export const writeSettingsCode = (value: string): string =>
  `(() => { localStorage.setItem(${JSON.stringify(SETTINGS_KEY)}, ${JSON.stringify(value)});` +
  ` return localStorage.getItem(${JSON.stringify(SETTINGS_KEY)}) === ${JSON.stringify(value)}; })()`;

/** The renderer mounted and its own round trip to the worker came back (`page-probe.ts`). */
export const MOUNTED_CODE =
  "(() => { const r = document.getElementById('root');" +
  " return r !== null && r.childElementCount > 0 && r.dataset.workerLink === 'up'; })()";

/** Leaves the Watch page: the renderer closes the play it had open. */
export const HOME_CODE = "(() => { location.hash = '#/'; return true; })()";

const findPlay =
  "[...document.querySelectorAll('button')].find((b) =>" +
  ` (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === ${JSON.stringify(PLAY_LABEL)})`;

export const HAS_PLAY_CODE = `(() => ${findPlay} !== undefined)()`;

export const CLICK_PLAY_CODE = `(() => { const b = ${findPlay}; if (b === undefined) return false; b.click(); return true; })()`;

/** One reading of the page's `<video>`, or null when there is none. */
export const SAMPLE_CODE =
  "(() => { const v = document.querySelector('video'); if (v === null) return null;" +
  " const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;" +
  " const s = typeof v.currentSrc === 'string' ? v.currentSrc : '';" +
  ' return { t: v.currentTime, paused: v.paused, ended: v.ended, readyState: v.readyState,' +
  ' error: v.error === null ? 0 : v.error.code,' +
  ' frames: q === null ? -1 : q.totalVideoFrames, dropped: q === null ? -1 : q.droppedVideoFrames,' +
  ' width: v.videoWidth, height: v.videoHeight,' +
  " source: s.startsWith('blob:') ? 'mse' : /^http:\\/\\/127\\.0\\.0\\.1:[0-9]{1,5}\\//.test(s) ? 'progressive' : s === '' ? 'none' : 'other'," +
  " visible: document.visibilityState === 'visible' }; })()";

export type Source = 'progressive' | 'mse' | 'none' | 'other';

export interface Sample {
  readonly t: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly readyState: number;
  /** `MediaError.code`, 0 for none. */
  readonly error: number;
  /** `totalVideoFrames`, -1 when the element has no quality counters. */
  readonly frames: number;
  readonly dropped: number;
  readonly width: number;
  readonly height: number;
  readonly source: Source;
  readonly visible: boolean;
}

const num = (x: unknown, min: number, max: number): number | null =>
  typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : null;

/** A reading as main will print it, or null when it is not one: the page chooses no text. */
export function parseSample(x: unknown): Sample | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const t = num(o['t'], 0, 1e7);
  const readyState = num(o['readyState'], 0, 4);
  const error = num(o['error'], 0, 4);
  const frames = num(o['frames'], -1, 1e9);
  const dropped = num(o['dropped'], -1, 1e9);
  const width = num(o['width'], 0, 1e5);
  const height = num(o['height'], 0, 1e5);
  const source = o['source'];
  if (
    t === null ||
    readyState === null ||
    error === null ||
    frames === null ||
    dropped === null ||
    width === null ||
    height === null ||
    (source !== 'progressive' && source !== 'mse' && source !== 'none' && source !== 'other')
  )
    return null;
  return {
    t,
    paused: o['paused'] === true,
    ended: o['ended'] === true,
    readyState,
    error,
    frames,
    dropped,
    width,
    height,
    source,
    visible: o['visible'] === true,
  };
}

/** Playing: data for the current frame, the clock started, not paused, no error. */
export function isPlaying(s: Sample): boolean {
  return s.readyState >= 2 && s.t > 0 && !s.paused && s.error === 0;
}

// ---- the run -----------------------------------------------------------------------------------

export interface PlayProofPage {
  /** Runs `code` in main's isolated world of the window; `gesture`: as the user's own input. */
  run(code: string, gesture?: boolean): Promise<unknown>;
  /**
   * Loads `url` (`APP_URL`) in the window, a new document (a URL with no fragment never navigates
   * within the old one); resolves once it has loaded.
   */
  load(url: string): Promise<void>;
  destroyed(): boolean;
}

export interface PlayProofDeps {
  readonly page: PlayProofPage;
  /** The worker's open play sessions (main's own `status`). */
  playSessions(): Promise<number>;
  readonly requests: OffLoopback;
  log(name: string, fields: Fields): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Default `MEASURE_MS`. */
  readonly measureMs?: number;
}

class Stop extends Error {
  readonly stage: string;
  constructor(stage: string) {
    super(stage);
    this.stage = stage;
  }
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Plays the root's video on each path in turn, and prints what it measured. Never throws. */
export async function runPlayProof(play: PlayProof, d: PlayProofDeps): Promise<void> {
  for (const path of PLAY_PATHS) {
    try {
      d.log('play-proof', await playOnce(play, path, d));
    } catch (e) {
      d.log('play-proof', { path, stage: e instanceof Stop ? e.stage : 'failed' });
    }
    if (d.page.destroyed()) return;
  }
  // What left loopback after the last play was measured, to the end of the run.
  d.log('play-proof-done', { paths: PLAY_PATHS.length, offLoopback: d.requests.take() });
}

async function poll<T>(
  d: PlayProofDeps,
  stage: string,
  timeoutMs: number,
  probe: () => Promise<T | null>,
): Promise<T> {
  const until = d.now() + timeoutMs;
  for (;;) {
    if (d.page.destroyed()) throw new Stop('window-gone');
    let v: T | null = null;
    try {
      v = await probe();
    } catch {
      // The page is between documents; read again.
    }
    if (v !== null) return v;
    if (d.now() > until) throw new Stop(stage);
    await d.sleep(250);
  }
}

async function playOnce(play: PlayProof, path: PlayPath, d: PlayProofDeps): Promise<Fields> {
  const started = d.now();
  // Off the Watch page first: the renderer closes an open play, and the worker must hold none.
  await d.page.run(HOME_CODE).catch(() => undefined);
  await poll(d, 'play-not-closed', 30_000, async () => ((await d.playSessions()) === 0 ? 1 : null));

  const want = settingsFor(play, path);
  if ((await d.page.run(writeSettingsCode(want))) !== true) throw new Stop('settings-not-stored');
  const before = d.requests.take();
  try {
    await d.page.load(APP_URL);
  } catch {
    throw new Stop('load-failed');
  }
  await poll(d, 'not-mounted', 60_000, async () =>
    (await d.page.run(MOUNTED_CODE)) === true ? 1 : null,
  );
  if ((await d.page.run(readSettingsCode())) !== want) throw new Stop('settings-changed');
  if ((await d.page.run(watchCode(play))) !== true) throw new Stop('no-watch-route');

  // The manifest from the relay, then a moment for both seeders' beacons (the Watch page's own
  // subscription) before the press.
  await poll(d, 'no-play-button', 90_000, async () =>
    (await d.page.run(HAS_PLAY_CODE)) === true ? 1 : null,
  );
  await d.sleep(1_500);
  if ((await d.page.run(CLICK_PLAY_CODE, true)) !== true) throw new Stop('no-play-button');
  const pressed = d.now();

  const first = await poll(d, 'not-playing', 90_000, async () => {
    const s = parseSample(await d.page.run(SAMPLE_CODE));
    return s !== null && isPlaying(s) ? s : null;
  });
  const playingAt = d.now();
  let last = first;
  const measureMs = d.measureMs ?? MEASURE_MS;
  while (d.now() - playingAt < measureMs) {
    await d.sleep(500);
    if (d.page.destroyed()) throw new Stop('window-gone');
    const s = parseSample(await d.page.run(SAMPLE_CODE).catch(() => null));
    if (s === null) continue;
    last = s;
    if (s.error !== 0 || s.ended) break;
  }
  return {
    path,
    stage: 'measured',
    source: last.source,
    t0: round(first.t),
    t1: round(last.t),
    advanced: round(last.t - first.t),
    frames0: first.frames,
    frames1: last.frames,
    dropped: last.dropped,
    width: last.width,
    height: last.height,
    error: last.error,
    paused: last.paused,
    ended: last.ended,
    visible: last.visible,
    waitMs: playingAt - pressed,
    measureMs: d.now() - playingAt,
    totalMs: d.now() - started,
    offLoopbackBefore: before,
    offLoopback: d.requests.take(),
  };
}
