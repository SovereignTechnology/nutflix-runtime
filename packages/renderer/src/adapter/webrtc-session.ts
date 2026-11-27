/**
 * A free NFX play through nfx's web player (ADR 0001 decision 4): an `element` source whose
 * `attach(el)` hands the screen's `<video>` to the library. After nutflix-pear's
 * `packages/app-web/src/adapter/session.ts` (the submodule's pinned commit).
 *
 * - **Origins**, tried in this order: the worker's loopback origin, when the worker has a session
 *   for this play (it has HyperDHT seeders, or holds the video), then the `https` origins of
 *   beacons (`./endpoints.ts`), which is how a video only nfxd serves plays. The library takes
 *   every file of the session from the first origin that holds an allowed rendition.
 * - **The mesh:** a WebRTC mesh signaled over Nostr (NFX-10 §6), which reaches browsers and nfxd's
 *   mesh endpoint, when WebRTC is on. With it off the library gets no `signaling`, and then makes
 *   no peer connection at all: every byte comes from the origin.
 *
 * - **Remote candidates:** always `global` (nutflix-pear ADR 0023 rule 5). The type of the option
 *   allows nothing else and this file is the only one that calls `open`.
 * - **Session keys** are the library's: a fresh random key per `open()`, never the user's or the
 *   seeder's (ADR 0023 §3). This renderer holds neither.
 * - **The runtime fallback:** when the player will not start, or stops with a fatal error, the
 *   session closes it and plays the same `<video>` from the worker's progressive stream, over
 *   HyperDHT alone, from where it was. Once: it does not go back. A play with no worker session
 *   has no such stream, and says so. A `play: …` error is only the browser refusing autoplay, and
 *   the element's own controls start it.
 * - **What it measured** (for the installed app's play proof): while the library plays, the
 *   `<video>` carries `data-nfx-from` (`worker`, `https` or `other`: the origin the session plays
 *   from), `data-nfx-http-bytes` and `data-nfx-p2p-bytes` (the mesh's segment byte counters, `-1`
 *   with the mesh off: the library counts nothing then) and `data-nfx-peers`. Numbers and fixed
 *   words only: never a URL, so never the worker's origin token.
 * - **Rendition:** the player's hls.js levels, known once its master playlist is parsed. Before
 *   that the session lists what the worker found. After a fallback it lists the one rendition the
 *   progressive stream plays; switching means opening another play, as on the fallback path.
 */
import type {
  ElementPlaySource,
  MediaElementLike,
  NfxAddress,
  NfxPlayProblem,
  NfxPlaySession,
  NfxRenditionInfo,
  Unsubscribe,
} from '@sovit/core';

import { rejectWith, RuntimeAdapterError } from '../errors.js';
import type {
  NfxLevel,
  NfxLibSession,
  NfxOpenOptions,
  NfxPlayerEvent,
  NfxPlayerLib,
} from '../player/nfx-lib.js';
import type { PlayWorker } from '../worker/pipe.js';
import type { PlayOrigin } from './endpoints.js';

/** What `rendition` reads while hls.js picks. */
export const AUTO_RENDITION = 'auto';
/** The most problems one session keeps (contracts v15), the newest. */
export const MAX_PLAY_PROBLEMS = 16;

/** What a fallback opens: the worker's progressive stream for this video. */
export interface ProgressivePlay {
  readonly sid: string;
  /** Already checked (`isWorkerMediaUrl`). */
  readonly url: string;
  readonly rendition: string;
  readonly renditions: readonly NfxRenditionInfo[];
}

export interface WebRtcNfxSessionOptions {
  readonly videoId: NfxAddress;
  /** The signed manifest event as JSON (the player verifies it again). */
  readonly manifestJson: string;
  /**
   * The worker's session name for the origin (`nfx.play.open`'s `sid`), or `null` when the worker
   * has none for this play: it has no HyperDHT seeder and does not hold the video.
   */
  readonly sid: string | null;
  /** `http://127.0.0.1:<port>/<token>`, already checked (`isWorkerOriginUrl`); `null` with no `sid`. */
  readonly originUrl: string | null;
  /** The `https` origins of beacons, already checked (`httpsOrigins`), tried after the worker's. */
  readonly origins?: readonly PlayOrigin[] | undefined;
  /** The renditions the worker found, listed until the player's levels arrive. */
  readonly renditions: readonly NfxRenditionInfo[];
  /** The rendition the viewer picked (`playNfx(addr, id)`), if any. */
  readonly pin?: string | undefined;
  /** Signaling relays (NFX-10 §6). Empty: no mesh, and no peer connection (WebRTC off). */
  readonly meshRelays: readonly string[];
  /** `stun:` URLs, for the mesh only. */
  readonly iceServers: readonly { readonly urls: readonly string[] }[];
  readonly player: NfxPlayerLib;
  readonly worker: Pick<PlayWorker, 'close'>;
  /** Opens the progressive stream, for the fallback; `null`: there is none (no worker session). */
  readonly openProgressive: (() => Promise<ProgressivePlay>) | null;
  /** Told once, when the session closes. */
  readonly onClose?: ((s: WebRtcNfxSession) => void) | undefined;
  /**
   * The player checked a file against the hash list (`verified`): the sha256 and this play's
   * worker session. Seeding uses it to know which appended bytes may be handed to the worker.
   */
  readonly onVerified?: ((sha256: string, sid: string) => void) | undefined;
}

interface Attachment {
  readonly ac: AbortController;
  readonly el: HTMLVideoElement;
  session: NfxLibSession | null;
}

/**
 * A problem to show for an event, or `null`. In this client's own words (`errors.ts`): the
 * library's messages can carry a peer's text and the origin's session token, so none is shown. A
 * fatal `error` is handled apart (the fallback). `workerOrigin`: the worker's origin of this play,
 * if it has one, to tell its failures from those of an origin a seeder named.
 */
export function problemOf(
  e: NfxPlayerEvent,
  workerOrigin: string | null = null,
): NfxPlayProblem | null {
  switch (e.type) {
    case 'rejected':
      return { kind: 'refused', message: 'Refused a file whose bytes did not match its hash.' };
    case 'origin':
      if (e.ok) return null;
      return {
        kind: 'origin',
        message:
          e.origin === workerOrigin
            ? 'The worker’s origin did not serve this.'
            : 'An HTTPS origin a seeder named did not serve this.',
      };
    case 'log': {
      const m = /^mesh: rejected (http|p2p) bytes for /.exec(e.message);
      return m === null
        ? null
        : {
            kind: 'refused',
            message: `Refused a segment from ${m[1] === 'p2p' ? 'a peer' : 'the origin'}: its bytes did not match its hash.`,
          };
    }
    case 'error':
    case 'verified':
    case 'levels':
    case 'playing':
      return null;
  }
}

function asVideoElement(el: MediaElementLike): HTMLVideoElement {
  if (typeof HTMLVideoElement === 'undefined' || !(el instanceof HTMLVideoElement)) {
    throw new RuntimeAdapterError('invalid-argument', 'an NFX video plays into a <video> element');
  }
  return el;
}

/** The `<video>` dataset keys `report` writes (`data-nfx-from`, …). */
export const MEASURED_KEYS = ['nfxFrom', 'nfxHttpBytes', 'nfxP2pBytes', 'nfxPeers'] as const;

const count = (n: unknown): string =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? String(n) : '-1';

/**
 * Writes what the library's `stats()` says onto the element, as numbers and fixed words. Never
 * throws: a measurement's failure is not the play's.
 */
export function report(
  el: HTMLVideoElement,
  session: NfxLibSession,
  workerOrigin: string | null,
  origins: readonly PlayOrigin[],
): void {
  try {
    const st = session.stats?.();
    if (st === undefined) return;
    el.dataset['nfxFrom'] =
      st.origin === workerOrigin
        ? 'worker'
        : origins.some((o) => o.url === st.origin)
          ? 'https'
          : 'other';
    el.dataset['nfxHttpBytes'] = count(st.mesh?.bytes.http);
    el.dataset['nfxP2pBytes'] = count(st.mesh?.bytes.p2p);
    el.dataset['nfxPeers'] = count(st.mesh?.peers);
  } catch {
    // The measurement is a side job.
  }
}

/** Takes the measurement off the element: it plays from something else now, or nothing. */
export function unreport(el: HTMLVideoElement): void {
  for (const k of MEASURED_KEYS) Reflect.deleteProperty(el.dataset, k);
}

export class WebRtcNfxSession implements NfxPlaySession {
  readonly videoId: NfxAddress;
  readonly source: ElementPlaySource;
  readonly #o: WebRtcNfxSessionOptions;
  /**
   * The worker session open now: the origin's, then the progressive stream's after a fallback;
   * `null` while the worker has none for this play.
   */
  #sid: string | null;
  #levels: readonly NfxLevel[] = [];
  #picked: string | null;
  #pinned = false;
  #attached: Attachment | null = null;
  #closed: Promise<void> | null = null;
  #problems: NfxPlayProblem[] = [];
  #fellBack = false;
  #progressive: ProgressivePlay | null = null;
  readonly #listeners = new Set<() => void>();

  constructor(o: WebRtcNfxSessionOptions) {
    this.#o = o;
    this.videoId = o.videoId;
    this.#sid = o.sid;
    this.#picked = o.pin ?? null;
    this.source = {
      kind: 'element',
      attach: (el: MediaElementLike): Unsubscribe => this.#attach(el),
    };
  }

  /** The worker's session open now, or `null` when it has none for this play. */
  get sid(): string | null {
    return this.#sid;
  }

  /** Whether the play fell back to the progressive stream. */
  get fellBack(): boolean {
    return this.#fellBack;
  }

  get rendition(): string {
    return this.#progressive?.rendition ?? this.#picked ?? AUTO_RENDITION;
  }

  get renditions(): readonly NfxRenditionInfo[] {
    const p = this.#progressive;
    if (p !== null) return p.renditions.filter((r) => r.id === p.rendition);
    if (this.#levels.length === 0) return this.#o.renditions;
    const out: NfxRenditionInfo[] = [];
    for (const l of this.#levels) {
      if (out.some((r) => r.id === l.id)) continue;
      out.push({
        id: l.id,
        bandwidth: l.bitrate,
        ...(l.width > 0 && l.height > 0
          ? { resolution: `${String(l.width)}x${String(l.height)}` }
          : {}),
      });
    }
    return out;
  }

  get problems(): readonly NfxPlayProblem[] {
    return [...this.#problems];
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  onChange(cb: () => void): Unsubscribe {
    if (this.#closed !== null) return () => undefined;
    const once = (): void => {
      cb();
    };
    this.#listeners.add(once);
    return () => {
      this.#listeners.delete(once);
    };
  }

  setRendition(id: string): Promise<void> {
    if (this.#closed !== null) return rejectWith('session-closed', 'the play has ended');
    const session = this.#attached?.session ?? null;
    const level = typeof id === 'string' ? this.#levels.find((l) => l.id === id) : undefined;
    if (this.#fellBack || level === undefined || session === null) {
      return rejectWith('invalid-argument', 'no such rendition');
    }
    try {
      session.setLevel(level.index);
    } catch {
      return rejectWith('invalid-argument', 'no such rendition');
    }
    this.#picked = level.id;
    this.#changed();
    return Promise.resolve();
  }

  /** Idempotent. A worker that is gone has closed the play already: that is not an error. */
  close(): Promise<void> {
    this.#closed ??= (async (): Promise<void> => {
      this.#listeners.clear();
      this.#detach();
      this.#o.onClose?.(this);
      const sid = this.#sid;
      if (sid === null) return;
      try {
        await this.#o.worker.close(sid);
      } catch {
        // `nfx.play.close` is idempotent, and a down worker holds no session.
      }
    })();
    return this.#closed;
  }

  #changed(): void {
    for (const cb of [...this.#listeners]) {
      try {
        cb();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  #problem(p: NfxPlayProblem): void {
    this.#problems.push(p);
    if (this.#problems.length > MAX_PLAY_PROBLEMS) {
      this.#problems.splice(0, this.#problems.length - MAX_PLAY_PROBLEMS);
    }
    this.#changed();
  }

  #attach(raw: MediaElementLike): Unsubscribe {
    if (this.#closed !== null) return () => undefined;
    const el = asVideoElement(raw);
    this.#detach();
    const slot: Attachment = { ac: new AbortController(), el, session: null };
    this.#attached = slot;
    if (this.#progressive !== null) this.#playProgressive(el, this.#progressive, 0);
    else void this.#open(slot);
    return () => {
      if (this.#attached === slot) this.#detach();
    };
  }

  async #open(slot: Attachment): Promise<void> {
    const live = (): boolean => this.#attached === slot && !slot.ac.signal.aborted;
    const o = this.#o;
    const beaconOrigins = o.origins ?? [];
    const origins: NfxOpenOptions['origins'] = o.originUrl === null ? [] : [o.originUrl];
    for (const b of beaconOrigins)
      origins.push(
        b.renditions === undefined ? { url: b.url } : { url: b.url, renditions: [...b.renditions] },
      );
    // No relay, no mesh: the library then builds plain hls.js and opens no peer connection.
    const mesh: Pick<NfxOpenOptions, 'signaling' | 'iceServers'> =
      o.meshRelays.length === 0
        ? {}
        : {
            signaling: { kind: 'nostr', relays: [...o.meshRelays], remoteCandidates: 'global' },
            iceServers: o.iceServers.map((s) => ({ urls: [...s.urls] })),
          };
    const options: NfxOpenOptions = {
      manifestJson: o.manifestJson,
      origins,
      ...(o.pin === undefined ? {} : { renditions: [o.pin] }),
      ...mesh,
      onEvent: (e) => {
        if (live()) this.#hear(e, slot);
      },
      signal: slot.ac.signal,
    };
    try {
      const session = await o.player.open(slot.el, options);
      if (!live()) {
        session.destroy();
        return;
      }
      slot.session = session;
      const measure = (): void => {
        if (live()) report(slot.el, session, o.originUrl, beaconOrigins);
      };
      measure();
      slot.el.addEventListener('timeupdate', measure, { signal: slot.ac.signal });
      if (session.levels.length > 0) {
        this.#levels = [...session.levels];
        this.#pinLevel();
        this.#changed();
      }
    } catch {
      if (live()) void this.#fallback(slot);
    }
  }

  #hear(e: NfxPlayerEvent, slot: Attachment): void {
    if (e.type === 'levels') {
      this.#levels = [...e.levels];
      this.#pinLevel();
      this.#changed();
      return;
    }
    const sid = this.#sid;
    if (e.type === 'verified' && sid !== null) this.#o.onVerified?.(e.sha256, sid);
    if (e.type === 'error') {
      // The browser refusing to autoplay is not a failure of the player.
      if (!e.message.startsWith('play: ')) void this.#fallback(slot);
      return;
    }
    const p = problemOf(e, this.#o.originUrl);
    if (p !== null) this.#problem(p);
  }

  #pinLevel(): void {
    const want = this.#o.pin;
    const session = this.#attached?.session ?? null;
    if (want === undefined || this.#pinned || session === null || this.#levels.length === 0) {
      return;
    }
    this.#pinned = true;
    const level = this.#levels.find((l) => l.id === want);
    if (level === undefined) {
      this.#picked = null;
      return;
    }
    try {
      session.setLevel(level.index);
    } catch {
      this.#picked = null;
    }
  }

  /** Once: the player is closed, the origin's worker session too, and the stream takes over. */
  async #fallback(slot: Attachment): Promise<void> {
    if (this.#fellBack || this.#closed !== null) return;
    this.#fellBack = true;
    const at = Number.isFinite(slot.el.currentTime) ? slot.el.currentTime : 0;
    slot.ac.abort();
    slot.session?.destroy();
    slot.session = null;
    unreport(slot.el);
    this.#levels = [];
    const openProgressive = this.#o.openProgressive;
    if (openProgressive === null) {
      this.#problem({
        kind: 'stopped',
        message:
          'The web player stopped, and no HyperDHT seeder serves this video to play instead.',
      });
      return;
    }
    this.#problem({
      kind: 'stopped',
      message: `The ${this.#o.meshRelays.length === 0 ? 'web' : 'WebRTC'} player stopped: playing over HyperDHT alone.`,
    });
    const was = this.#sid;
    if (was !== null) await this.#o.worker.close(was).catch(() => undefined);
    let opened: ProgressivePlay;
    try {
      opened = await openProgressive();
    } catch {
      this.#problem({ kind: 'stopped', message: 'The HyperDHT stream did not open either.' });
      return;
    }
    this.#sid = opened.sid;
    if (this.closed) {
      // Closed while it opened: `close` may have named the old session.
      await this.#o.worker.close(opened.sid).catch(() => undefined);
      return;
    }
    this.#progressive = opened;
    this.#picked = null;
    if (this.#attached === slot) this.#playProgressive(slot.el, opened, at);
    this.#changed();
  }

  #playProgressive(el: HTMLVideoElement, p: ProgressivePlay, at: number): void {
    el.src = p.url;
    if (at > 0) {
      el.addEventListener(
        'loadedmetadata',
        () => {
          el.currentTime = at;
        },
        { once: true },
      );
    }
    // A refused autoplay is not an error: the element's controls start it.
    void Promise.resolve()
      .then(() => el.play())
      .catch(() => undefined);
  }

  #detach(): void {
    const slot = this.#attached;
    if (slot === null) return;
    this.#attached = null;
    slot.ac.abort();
    slot.session?.destroy();
    slot.session = null;
    unreport(slot.el);
  }
}
