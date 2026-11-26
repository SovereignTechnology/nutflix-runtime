/**
 * Test-only: nfx's web player library as `../../player/nfx-lib.ts` describes it, recording every
 * `open` and answering with a session a test drives (its events, its `stats()`), or failing.
 */
import type {
  NfxLibSession,
  NfxOpenOptions,
  NfxPlayerEvent,
  NfxPlayerLib,
  NfxStats,
} from '../../player/nfx-lib.js';

export interface FakeLibSession extends NfxLibSession {
  destroyed: number;
  /** What `stats()` answers; `null`: a session with no `stats` (an older fake). */
  snapshot: NfxStats | null;
}

export class FakeLib implements NfxPlayerLib {
  readonly opened: { el: HTMLVideoElement; options: NfxOpenOptions }[] = [];
  readonly sessions: FakeLibSession[] = [];
  readonly setLevels: number[] = [];
  /** `open` rejects. */
  fails = false;
  /** What the next session's `stats()` answers. */
  stats: NfxStats | null = null;

  init = (): Promise<void> => Promise.resolve();

  open(el: HTMLVideoElement, options: NfxOpenOptions): Promise<NfxLibSession> {
    this.opened.push({ el, options });
    if (this.fails) return Promise.reject(new Error('secret: no origin served a hash list'));
    const setLevels = this.setLevels;
    const s: FakeLibSession = {
      destroyed: 0,
      snapshot: this.stats,
      levels: [],
      setLevel(i: number): void {
        setLevels.push(i);
      },
      destroy() {
        this.destroyed += 1;
      },
    };
    if (this.stats !== null) {
      s.stats = (): NfxStats => {
        if (s.snapshot === null) throw new Error('no stats');
        return s.snapshot;
      };
    }
    this.sessions.push(s);
    return Promise.resolve(s);
  }

  /** The last session's `onEvent`. */
  emit(e: NfxPlayerEvent): void {
    this.opened.at(-1)?.options.onEvent?.(e);
  }
}
