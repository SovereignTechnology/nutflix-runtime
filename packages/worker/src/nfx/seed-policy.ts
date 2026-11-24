/**
 * What this node may serve, and why (`<storage>/seeding.json`). Seeding tells strangers this
 * machine's IP address, so it happens only for a reason the user gave:
 *
 *   - **the switch** (`watched`), off by default: seed what I watch. Turning it on takes a native
 *     confirmation in main (the page cannot turn it on), and turning it off stops serving at once.
 *   - **`published`:** the user confirmed publishing the video, and signed it.
 *   - **`host`:** `nfx.seed.start` from the host, which is not reachable from a window.
 *
 * NO RECORD MEANS NOT SERVED. A video that is stored for no reason this file gives (a crash between
 * the store and this file, a file that was lost or damaged) stays private until the user acts.
 *
 * Written whole through a temporary file, and synced to disk where the runtime can: the start-up
 * purge of unsigned drafts trusts this file, so a published video must not read as a draft after a
 * power cut. A file that is missing or not this shape means the defaults: nothing is served.
 */
import type { SeederFs } from '@sovit/seeder';

import { MAX_NFX_STORED_VIDEOS, MAX_TITLE } from '../protocol.js';
import type { SeedOrigin } from '../protocol.js';

export const SEEDING_FILE = 'seeding.json';
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const SHA = /^[0-9a-f]{64}$/;

export interface SeedRecord {
  readonly origin: 'published' | 'watched' | 'host';
  readonly root: string;
  /** The manifest's author; for `published`, `null` until the user signed it. */
  readonly author: string | null;
  /** The user stopped serving it. The bytes stay until they delete it. */
  readonly stopped?: true;
  /** Its title, so that a native dialog can say which video it means. */
  readonly title?: string;
}

export interface SeedPolicyOptions {
  /** Atomic, and on disk when it resolves. `false`: in place, but the directory was not synced. */
  readonly durable?: (path: string, data: Uint8Array) => Promise<boolean>;
  readonly warn?: (text: string) => void;
}

function isRecord(x: unknown): x is SeedRecord {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  const author = r['author'];
  return (
    (r['origin'] === 'published' || r['origin'] === 'watched' || r['origin'] === 'host') &&
    typeof r['root'] === 'string' &&
    SHA.test(r['root']) &&
    (author === null || (typeof author === 'string' && SHA.test(author))) &&
    (r['stopped'] === undefined || r['stopped'] === true) &&
    (r['title'] === undefined || (typeof r['title'] === 'string' && r['title'].length <= MAX_TITLE))
  );
}

export class SeedPolicy {
  readonly #fs: SeederFs;
  readonly #file: string;
  readonly #records = new Map<string, SeedRecord>();
  #watched = false;
  #writes: Promise<void> = Promise.resolve();
  readonly #o: SeedPolicyOptions;

  constructor(fs: SeederFs, dir: string, o: SeedPolicyOptions = {}) {
    this.#fs = fs;
    this.#file = fs.join(dir, SEEDING_FILE);
    this.#o = o;
  }

  async load(): Promise<void> {
    try {
      const st = await this.#fs.stat(this.#file);
      if (st?.isFile !== true || st.size > MAX_FILE_BYTES) return;
      const raw: unknown = JSON.parse(
        new TextDecoder().decode(await this.#fs.readFile(this.#file)),
      );
      if (typeof raw !== 'object' || raw === null) return;
      const o = raw as Record<string, unknown>;
      if (o['v'] !== 1 || typeof o['videos'] !== 'object' || o['videos'] === null) return;
      this.#watched = o['watched'] === true;
      for (const [video, r] of Object.entries(o['videos']).slice(0, MAX_NFX_STORED_VIDEOS))
        if (isRecord(r)) this.#records.set(video, r);
    } catch {
      // Unreadable: the defaults.
    }
  }

  get watched(): boolean {
    return this.#watched;
  }

  record(video: string): SeedRecord | undefined {
    return this.#records.get(video);
  }

  origin(video: string): SeedOrigin {
    return this.#records.get(video)?.origin ?? 'unknown';
  }

  /** Whether peers may fetch `video` from this node now. */
  served(video: string): boolean {
    const r = this.#records.get(video);
    if (r === undefined || r.stopped === true) return false;
    if (r.origin === 'host') return true;
    return r.origin === 'published' ? r.author !== null : this.#watched;
  }

  /**
   * Whether `video` is private: stored as a draft nobody has signed, or with no record of what it
   * is. A private video is neither served to peers nor readable through a play.
   */
  isPrivate(video: string): boolean {
    const r = this.#records.get(video);
    return r === undefined || (r.origin === 'published' && r.author === null);
  }

  /** The records of unsigned drafts. */
  drafts(): string[] {
    return [...this.#records]
      .filter(([, r]) => r.origin === 'published' && r.author === null)
      .map(([video]) => video);
  }

  /** Stop or resume serving. Returns whether a record changed. */
  async setStopped(video: string, stopped: boolean): Promise<boolean> {
    const r = this.#records.get(video);
    if (r === undefined || (r.stopped === true) === stopped) return false;
    const { stopped: _was, ...rest } = r;
    await this.set(video, stopped ? { ...rest, stopped: true } : rest);
    return true;
  }

  setWatched(on: boolean): Promise<void> {
    this.#watched = on;
    return this.#save();
  }

  set(video: string, record: SeedRecord): Promise<void> {
    this.#records.set(video, record);
    return this.#save();
  }

  /** `set`, on disk when it resolves. If the write fails, the record stays what it was. */
  async setDurable(video: string, record: SeedRecord): Promise<void> {
    const before = this.#records.get(video);
    this.#records.set(video, record);
    try {
      await this.#save();
    } catch (e) {
      if (before === undefined) this.#records.delete(video);
      else this.#records.set(video, before);
      throw e;
    }
  }

  remove(video: string): Promise<void> {
    return this.#records.delete(video) ? this.#save() : Promise.resolve();
  }

  /** Waits for the writes so far. */
  flush(): Promise<void> {
    return this.#writes;
  }

  #save(): Promise<void> {
    const text = JSON.stringify({
      v: 1,
      watched: this.#watched,
      videos: Object.fromEntries(this.#records),
    });
    const tmp = `${this.#file}.tmp`;
    this.#writes = this.#writes
      .catch(() => undefined)
      .then(async () => {
        const durable = this.#o.durable;
        if (durable === undefined) {
          await this.#fs.writeFile(tmp, text);
          await this.#fs.rename(tmp, this.#file);
        } else if (!(await durable(this.#file, new TextEncoder().encode(text)))) {
          this.#o.warn?.('seeding.json is in place, but its directory could not be synced');
        }
      });
    return this.#writes;
  }
}
