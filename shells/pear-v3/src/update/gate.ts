/**
 * The update gate (ADR 0001 decision 2; S2's measured sequence). `pear-runtime`'s updater fetches a
 * new build into `next` and fires `updated`, with no payload; nothing in it applies by itself. This
 * is the only caller of `applyUpdate()`, and it calls it only when the NEWEST valid release notice
 * names exactly this build:
 *
 *   1. read `next`, parse `<length>.<fork>` from its basename, build `pear://<fork>.<length>.<key>`;
 *   2. hash `<next>/by-arch/<host>/app/<name>`;
 *   3. compare link, version and hash with the notice. No match, no notice, an unreachable relay,
 *      or any failure: HOLD, and say so;
 *   4. hash it again, check that `next` has not moved, and call `applyUpdate()` with NO `await`
 *      between that check and the call (it reads `this.next` synchronously);
 *   5. hash the installed app, because `applyUpdate()` returns without error when it did nothing.
 *
 * Nothing is remembered as approved: a held build re-fires `updated` at the next start and is
 * judged again. The floor (`notice.ts`) only ever makes the gate stricter.
 *
 * All of its dependencies are passed in, so that the tests can drive every refusal.
 */
import { decide, isNewer, type Candidate, type Floor } from './notice.ts';
import { linkKey, type TrustRoot } from './root.ts';
import { PLAIN_VERSION, type UpdateProof, type UpdateReason, type UpdateStatus } from './status.ts';

/** The part of `pear.updater` the gate uses. */
export interface GateUpdater {
  readonly next: string | null;
  readonly nextVersion: string | null;
  readonly app?: string | undefined;
  applyUpdate(): Promise<void>;
}

export interface GateDeps {
  readonly root: TrustRoot;
  readonly updater: GateUpdater;
  /** `<platform>-<arch>`. */
  readonly host: string;
  /** The artifact's file in the deployment. */
  readonly name: string;
  /** The artifact's name in a notice (`artifactName`). */
  readonly artifact: string;
  /**
   * How the swap is proved: `sha256` hashes `updater.app` (AppImage, bundle). `msix-deployed` is
   * Windows, where the installed package is not one file the updater can name.
   */
  readonly proof: UpdateProof;
  hash(path: string): Promise<string>;
  fetchNotices(): Promise<{ readonly events: readonly unknown[]; readonly reached: number }>;
  readFloor(): Promise<Floor | null>;
  writeFloor(floor: Floor): Promise<void>;
  /** Milliseconds since the epoch. */
  now(): number;
  status(s: UpdateStatus): void;
  readonly join: (...parts: string[]) => string;
  readonly basename: (path: string) => string;
}

const NEXT_DIR = /^([0-9]{1,15})\.([0-9]{1,15})$/;

/** `next/<length>.<fork>` as a versioned link (the two numbers are the other way round in a link). */
export function verlinkOf(next: string, key: string, basename: (p: string) => string): string {
  const m = NEXT_DIR.exec(basename(next));
  if (m === null) throw new Error('next is not <length>.<fork>');
  const [, length, fork] = m;
  return `pear://${String(Number(fork))}.${String(Number(length))}.${key}`;
}

/** The name a notice gives this platform's artifact (`Nutflix-linux-x64.AppImage`). */
export function artifactName(host: string, name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) throw new Error('an artifact name has an extension');
  return `${name.slice(0, dot)}-${host}${name.slice(dot)}`;
}

export class UpdateGate {
  readonly #d: GateDeps;
  #running = false;
  #again = false;
  #done = false;

  constructor(deps: GateDeps) {
    this.#d = deps;
  }

  /** The updater fired `updated`. Checks run one at a time; a new build during one runs next. */
  onUpdated(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return Promise.resolve();
    }
    this.#running = true;
    return this.#loop().finally(() => {
      this.#running = false;
    });
  }

  async #loop(): Promise<void> {
    for (;;) {
      this.#again = false;
      if (this.#done) return;
      try {
        await this.#check();
      } catch {
        this.#d.status({ state: 'held', reason: 'error' });
      }
      if (!this.#wantsAnother()) return;
    }
  }

  /** Set by `onUpdated` while a check runs, and by a check that saw `next` move. */
  #wantsAnother(): boolean {
    return this.#again;
  }

  async #check(): Promise<void> {
    const d = this.#d;
    const u = d.updater;
    const next = u.next;
    const version = u.nextVersion;
    if (next === null || version === null || d.root.upgrade === null) {
      d.status({ state: 'held', reason: 'error' });
      return;
    }
    const shown = PLAIN_VERSION.test(version) ? { version } : {};
    const hold = (reason: UpdateReason, refused?: number): void => {
      d.status({
        state: 'held',
        reason,
        ...shown,
        ...(refused === undefined ? {} : { refused }),
      });
    };
    d.status({ state: 'checking', ...shown });

    const verlink = verlinkOf(next, linkKey(d.root.upgrade), d.basename);
    const file = d.join(next, 'by-arch', d.host, 'app', d.name);
    const sha256 = await d.hash(file);
    const candidate: Candidate = { verlink, version, artifact: d.artifact, sha256 };

    const answers = await d.fetchNotices();
    let floor: Floor | null = null;
    try {
      floor = await d.readFloor();
    } catch {
      // An unreadable floor is no floor: it can only ever have made the gate stricter.
    }
    const decision = decide({
      events: answers.events,
      reached: answers.reached,
      root: d.root,
      nowS: Math.floor(d.now() / 1000),
      floor,
      candidate,
    });
    const newest = decision.kind === 'match' ? decision.notice : decision.newest;
    if (newest !== null && (floor === null || isNewer(newest, floor))) {
      try {
        await d.writeFloor({ createdAt: newest.createdAt, id: newest.id });
      } catch {
        // Replay protection is lost for this one notice; the decision below does not depend on it.
      }
    }
    if (decision.kind === 'hold') {
      hold(decision.reason, decision.refused);
      return;
    }

    d.status({ state: 'applying', ...shown });
    const again = await d.hash(file);
    if (again !== sha256) {
      hold('changed');
      return;
    }
    // No `await` between this check and the call: `applyUpdate()` reads `this.next` synchronously.
    if (u.next !== next || u.nextVersion !== version) {
      hold('changed');
      this.#again = true;
      return;
    }
    const applying = u.applyUpdate();
    this.#done = true;
    try {
      await applying;
    } catch {
      d.status({ state: 'failed', reason: 'error', ...shown });
      return;
    }
    if (d.proof === 'msix-deployed') {
      d.status({ state: 'applied', proof: 'msix-deployed', ...shown });
      return;
    }
    const app = u.app;
    const after = app === undefined ? null : await d.hash(app).catch((): string | null => null);
    if (after !== sha256) {
      d.status({ state: 'failed', reason: 'swap-unproved', ...shown });
      return;
    }
    d.status({ state: 'applied', proof: 'sha256', ...shown });
  }
}
