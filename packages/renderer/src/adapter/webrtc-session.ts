/**
 * A free NFX play through nfx's web player (ADR 0001 decision 4): an `element` source whose
 * `attach(el)` hands the screen's `<video>` to the library, with the worker's loopback origin as
 * its one origin and a WebRTC mesh signaled over Nostr (NFX-10 §6) beside it. After nutflix-pear's
 * `packages/app-web/src/adapter/session.ts` (the submodule's pinned commit).
 *
 * - **Remote candidates:** always `global` (nutflix-pear ADR 0023 rule 5). The type of the option
 *   allows nothing else and this file is the only one that calls `open`.
 * - **Session keys** are the library's: a fresh random key per `open()`, never the user's or the
 *   seeder's (ADR 0023 §3). This renderer holds neither.
 * - **The runtime fallback:** when the player will not start, or stops with a fatal error, the
 *   session closes it and plays the same `<video>` from the worker's progressive stream, over
 *   HyperDHT alone, from where it was. Once: it does not go back. A `play: …` error is only the
 *   browser refusing autoplay, and the element's own controls start it.
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
  /** The worker's session name for the origin (`nfx.play.open`'s `sid`). */
  readonly sid: string;
  /** `http://127.0.0.1:<port>/<token>`, already checked (`isWorkerOriginUrl`). */
  readonly originUrl: string;
  /** The renditions the worker found, listed until the player's levels arrive. */
  readonly renditions: readonly NfxRenditionInfo[];
  /** The rendition the viewer picked (`playNfx(addr, id)`), if any. */
  readonly pin?: string | undefined;
  /** Signaling relays (NFX-10 §6), at least one. */
  readonly meshRelays: readonly string[];
  /** `stun:` URLs. */
  readonly iceServers: readonly { readonly urls: readonly string[] }[];
  readonly player: NfxPlayerLib;
  readonly worker: Pick<PlayWorker, 'close'>;
  /** Opens the progressive stream, for the fallback. */
  readonly openProgressive: () => Promise<ProgressivePlay>;
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
 * fatal `error` is handled apart (the fallback).
 */
export function problemOf(e: NfxPlayerEvent): NfxPlayProblem | null {
  switch (e.type) {
    case 'rejected':
      return { kind: 'refused', message: 'Refused a file whose bytes did not match its hash.' };
    case 'origin':
      return e.ok ? null : { kind: 'origin', message: 'The worker’s origin did not serve this.' };
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

export class WebRtcNfxSession implements NfxPlaySession {
  readonly videoId: NfxAddress;
  readonly source: ElementPlaySource;
  readonly #o: WebRtcNfxSessionOptions;
  /** The worker session open now: the origin's, then the progressive stream's after a fallback. */
  #sid: string;
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

  /** The worker's session open now. */
  get sid(): string {
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
      try {
        await this.#o.worker.close(this.#sid);
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
    const options: NfxOpenOptions = {
      manifestJson: o.manifestJson,
      origins: [o.originUrl],
      ...(o.pin === undefined ? {} : { renditions: [o.pin] }),
      signaling: { kind: 'nostr', relays: [...o.meshRelays], remoteCandidates: 'global' },
      iceServers: o.iceServers.map((s) => ({ urls: [...s.urls] })),
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
    if (e.type === 'verified') this.#o.onVerified?.(e.sha256, this.#sid);
    if (e.type === 'error') {
      // The browser refusing to autoplay is not a failure of the player.
      if (!e.message.startsWith('play: ')) void this.#fallback(slot);
      return;
    }
    const p = problemOf(e);
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
    this.#levels = [];
    this.#problem({
      kind: 'stopped',
      message: 'The WebRTC player stopped: playing over HyperDHT alone.',
    });
    await this.#o.worker.close(this.#sid).catch(() => undefined);
    let opened: ProgressivePlay;
    try {
      opened = await this.#o.openProgressive();
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
  }
}
