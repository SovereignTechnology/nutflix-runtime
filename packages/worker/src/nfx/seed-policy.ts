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
 * Written whole through a temporary file. A file that is missing or not this shape means the
 * defaults: nothing is served.
 */
import type { SeederFs } from '@sovit/seeder';

import { MAX_NFX_STORED_VIDEOS } from '../protocol.js';
import type { SeedOrigin } from '../protocol.js';

export const SEEDING_FILE = 'seeding.json';
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const SHA = /^[0-9a-f]{64}$/;

export interface SeedRecord {
  readonly origin: 'published' | 'watched' | 'host';
  readonly root: string;
  /** The manifest's author; for `published`, `null` until the user signed it. */
  readonly author: string | null;
}

function isRecord(x: unknown): x is SeedRecord {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  const author = r['author'];
  return (
    (r['origin'] === 'published' || r['origin'] === 'watched' || r['origin'] === 'host') &&
    typeof r['root'] === 'string' &&
    SHA.test(r['root']) &&
    (author === null || (typeof author === 'string' && SHA.test(author)))
  );
}

export class SeedPolicy {
  readonly #fs: SeederFs;
  readonly #file: string;
  readonly #records = new Map<string, SeedRecord>();
  #watched = false;
  #writes: Promise<void> = Promise.resolve();

  constructor(fs: SeederFs, dir: string) {
    this.#fs = fs;
    this.#file = fs.join(dir, SEEDING_FILE);
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
    if (r === undefined) return false;
    if (r.origin === 'host') return true;
    return r.origin === 'published' ? r.author !== null : this.#watched;
  }

  setWatched(on: boolean): Promise<void> {
    this.#watched = on;
    return this.#save();
  }

  set(video: string, record: SeedRecord): Promise<void> {
    this.#records.set(video, record);
    return this.#save();
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
        await this.#fs.writeFile(tmp, text);
        await this.#fs.rename(tmp, this.#file);
      });
    return this.#writes;
  }
}
