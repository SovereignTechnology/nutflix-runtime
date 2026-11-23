/**
 * Seeding and publishing, as the renderer sees them (ADR 0001 §§3, 7, 8). The worker holds every
 * key and does every piece of work; this page asks, through the shell's gate, and is the one part
 * of the app that speaks to Nostr relays:
 *
 *   - **beacons:** every 60 s while something is served, the worker signs a kind-20464 beacon per
 *     video with the seeder key. Each is checked (`parseBeacon`) and published to the network's
 *     scoped relays and nowhere else (NFX-03 §7). None is asked for while nothing is served, so a
 *     launch with nothing to seed starts no DHT node.
 *   - **seed what you watch:** off until the user turns it on, in a native dialog. With it on, a
 *     play also asks the worker to store and seed the video.
 *   - **publish:** the worker packages the picked file and drafts the manifest, the user's signer
 *     signs it, the result is verified here, and it goes to the write relays and the scoped relays.
 */
import type { NfxVideo, NostrEvent, RelayUrl } from '@sovit/core';
import { isListable, parseBeacon, parseManifest } from '@sovit/core/nfx';
import { toWire, type PoolLike } from '@sovit/core/nostr';
import type {
  NfxHyperdhtEndpointWire,
  SeedingStatusWire,
  SignedEventWire,
  SignerStatusWire,
  StudioFfmpegWire,
  StudioProbeWire,
  StudioPublishedWire,
  StudioSourceWire,
  WorkerEvent,
} from '@nutflix-runtime/worker';

import { RuntimeAdapterError } from '../errors.js';
import type { SettingsStore } from '../settings/store.js';
import type { ControlWorker } from '../worker/pipe.js';

export const BEACON_EVERY_MS = 60_000;
/** Main's event (`rpc-gate.ts` `mainEvents`): this worker has a listener up. */
export const SERVING_EVENT = 'serving';

const KDF_TIMEOUT_MS = 120_000;
const BUNKER_TIMEOUT_MS = 180_000;
/** The native dialogs wait on a person. */
const DIALOG_TIMEOUT_MS = 3_600_000;
const WATCH_TIMEOUT_MS = 3_600_000;
/** An encode of the longest video Studio takes, on a slow machine. */
const PUBLISH_TIMEOUT_MS = 24 * 3_600_000;

export type StudioProgressEvent = Extract<WorkerEvent, { readonly e: 'studio.progress' }>;

export interface PublishInput {
  readonly source: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly sizes: readonly number[];
}

export interface PublishOutcome {
  readonly video: string;
  readonly event: SignedEventWire;
  /** The relays that accepted the manifest. */
  readonly relays: number;
}

export interface SeedPublishOptions {
  readonly worker: ControlWorker;
  readonly pool: Pick<PoolLike, 'publish'>;
  readonly settings: Pick<SettingsStore, 'get'>;
  /** Unix seconds. */
  readonly now?: () => number;
  readonly timers?: {
    readonly setInterval: (fn: () => void, ms: number) => unknown;
    readonly clearInterval: (h: unknown) => void;
  };
}

const realTimers = {
  setInterval: (fn: () => void, ms: number): unknown => setInterval(fn, ms),
  clearInterval: (h: unknown): void => {
    clearInterval(h as ReturnType<typeof setInterval>);
  },
};

export class SeedPublish {
  readonly #o: SeedPublishOptions;
  #timer: unknown = null;
  #round: Promise<number> | null = null;
  #seeding: SeedingStatusWire = { watched: false, videos: [], listening: [] };
  #stopped = false;
  /**
   * Packaged, and not signed yet (a locked key, a bunker nobody answered): publishing the same
   * thing again goes straight to the signature instead of encoding it all again.
   */
  #unsigned: { readonly key: string; readonly stored: StudioPublishedWire } | null = null;

  constructor(o: SeedPublishOptions) {
    this.#o = o;
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  /**
   * Starts announcing when told something is being served: the worker's `status` naming a
   * listener, or the shell's `serving` once the page has loaded (a status sent before this page
   * existed reached nobody). Asks the worker nothing until then, so that a launch with nothing to
   * play or seed sends it no request at all. Returns the unsubscribe.
   */
  listen(): () => void {
    return this.#o.worker.onEvent((ev) => {
      const serving =
        (ev.e === 'status' && ev.status.listening.length > 0) ||
        (ev as { readonly e: string }).e === SERVING_EVENT;
      if (serving && this.#timer === null) void this.refreshSeeding().catch(() => undefined);
    });
  }

  stop(): void {
    this.#stopped = true;
    this.#stopBeacons();
  }

  /** The switch, as last read from the worker. */
  get watching(): boolean {
    return this.#seeding.watched;
  }

  // ---- seeding -------------------------------------------------------------------------------

  async refreshSeeding(): Promise<SeedingStatusWire> {
    const s = await this.#o.worker.call('seeding.status', {});
    this.#adopt(s);
    return s;
  }

  /** On: the shell asks the user in a native dialog first. The answer is in what comes back. */
  async setSeeding(on: boolean): Promise<SeedingStatusWire> {
    const s = await this.#o.worker.call(
      'app.seeding.set',
      { on },
      { timeoutMs: DIALOG_TIMEOUT_MS },
    );
    this.#adopt(s);
    return s;
  }

  async stopSeeding(video: string): Promise<void> {
    await this.#o.worker.call('seeding.stop', { video });
    await this.refreshSeeding();
  }

  /** A play started. With the switch on, the worker stores and seeds the video. */
  onPlay(play: {
    readonly video: NfxVideo;
    readonly peers: readonly NfxHyperdhtEndpointWire[];
  }): void {
    if (!this.#seeding.watched) return;
    const manifest = toWire(play.video.event) as unknown as SignedEventWire;
    void this.#o.worker
      .call('seeding.watch', { manifest, peers: [...play.peers] }, { timeoutMs: WATCH_TIMEOUT_MS })
      .then(() => this.refreshSeeding())
      .catch(() => undefined);
  }

  #adopt(s: SeedingStatusWire): void {
    this.#seeding = s;
    if (this.#stopped) return;
    if (s.videos.some((v) => v.served)) {
      if (this.#timer === null) {
        this.#timer = (this.#o.timers ?? realTimers).setInterval(() => {
          void this.publishBeacons();
        }, BEACON_EVERY_MS);
      }
      void this.publishBeacons();
    } else {
      this.#stopBeacons();
    }
  }

  #stopBeacons(): void {
    if (this.#timer === null) return;
    (this.#o.timers ?? realTimers).clearInterval(this.#timer);
    this.#timer = null;
  }

  #scopedRelays(): readonly RelayUrl[] {
    return this.#o.settings.get().nfx?.scopedRelays ?? [];
  }

  /** One beacon round. Rounds never overlap; never throws. Resolves to how many went out. */
  publishBeacons(): Promise<number> {
    this.#round ??= this.#beaconRound()
      .catch(() => 0)
      .finally(() => {
        this.#round = null;
      });
    return this.#round;
  }

  async #beaconRound(): Promise<number> {
    const relays = this.#scopedRelays();
    if (relays.length === 0) return 0;
    const { events } = await this.#o.worker.call('seeding.beacons', {});
    const now = (this.#o.now ?? (() => Math.floor(Date.now() / 1000)))();
    let sent = 0;
    for (const ev of events) {
      if (!parseBeacon(ev, now).ok) continue;
      const results = await this.#o.pool.publish(relays, ev as unknown as NostrEvent);
      if (results.some((r) => r.ok)) sent += 1;
    }
    return sent;
  }

  // ---- the signer ----------------------------------------------------------------------------

  signerStatus(): Promise<SignerStatusWire> {
    return this.#o.worker.call('signer.status', {});
  }

  createKey(passphrase: string): Promise<SignerStatusWire> {
    return this.#o.worker.call(
      'signer.local.create',
      { passphrase },
      { timeoutMs: KDF_TIMEOUT_MS },
    );
  }

  unlock(passphrase: string): Promise<SignerStatusWire> {
    return this.#o.worker.call(
      'signer.local.unlock',
      { passphrase },
      { timeoutMs: KDF_TIMEOUT_MS },
    );
  }

  connectBunker(uri: string): Promise<SignerStatusWire> {
    return this.#o.worker.call('signer.nip46.connect', { uri }, { timeoutMs: BUNKER_TIMEOUT_MS });
  }

  lock(): Promise<SignerStatusWire> {
    return this.#o.worker.call('signer.lock', {});
  }

  // ---- Studio --------------------------------------------------------------------------------

  ffmpeg(): Promise<StudioFfmpegWire> {
    return this.#o.worker.call('studio.ffmpeg', {});
  }

  /** The native file dialog, in main. `null`: the user cancelled. */
  pickVideo(): Promise<StudioSourceWire | null> {
    return this.#o.worker.call('app.pickVideo', {}, { timeoutMs: DIALOG_TIMEOUT_MS });
  }

  probe(source: string): Promise<StudioProbeWire> {
    return this.#o.worker.call('studio.probe', { source });
  }

  /** A video is packaged and waits for a signature. */
  get awaitingSignature(): boolean {
    return this.#unsigned !== null;
  }

  async cancelPublish(): Promise<void> {
    await this.#o.worker.call('studio.cancel', {});
  }

  /**
   * Encode, package and store; have the manifest signed; verify it; publish it. Publishing a video
   * seeds it: the worker starts serving it once it holds the signature.
   */
  async publish(
    input: PublishInput,
    onProgress: (p: StudioProgressEvent) => void,
  ): Promise<PublishOutcome> {
    const key = JSON.stringify([
      input.source,
      input.title,
      input.description,
      input.tags,
      input.sizes,
    ]);
    let stored: StudioPublishedWire;
    if (this.#unsigned?.key === key) {
      stored = this.#unsigned.stored;
    } else {
      const off = this.#o.worker.onEvent((ev) => {
        if (ev.e === 'studio.progress') onProgress(ev);
      });
      try {
        stored = await this.#o.worker.call(
          'studio.publish',
          {
            source: input.source,
            title: input.title,
            description: input.description,
            tags: [...input.tags],
            sizes: [...input.sizes],
          },
          { timeoutMs: PUBLISH_TIMEOUT_MS },
        );
      } finally {
        off();
      }
      this.#unsigned = { key, stored };
    }
    const event = await this.#o.worker.call(
      'signer.sign',
      { event: stored.draft },
      { timeoutMs: BUNKER_TIMEOUT_MS },
    );
    // The worker signs a draft once: from here on it cannot be asked again.
    this.#unsigned = null;
    const parsed = parseManifest(event);
    if (
      !parsed.ok ||
      !isListable(parsed.value) ||
      parsed.value.addr.toString() !== stored.video ||
      parsed.value.root !== stored.root
    )
      throw new RuntimeAdapterError('internal', 'the signed manifest did not verify');
    const settings = this.#o.settings.get();
    const relays = [
      ...new Set([
        ...settings.relays.filter((r) => r.write).map((r) => r.url),
        ...(settings.nfx?.scopedRelays ?? []),
      ]),
    ];
    const results = await this.#o.pool.publish(relays, event as unknown as NostrEvent);
    await this.refreshSeeding();
    return { video: stored.video, event, relays: results.filter((r) => r.ok).length };
  }
}
