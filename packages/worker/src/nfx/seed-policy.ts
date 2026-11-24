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
 * power cut. A missing file means the defaults: nothing is served.
 *
 * A file that is there but cannot be read as valid is NEVER overwritten, because it may be the only
 * record of what the user published. It is moved aside to a uniquely named `.bad` file, the worker
 * logs that and starts, and whatever records in it were valid are kept. If it cannot be moved, no
 * save happens at all until it can.
 */
import type { SeederFs } from '@sovit/seeder';

import { randomHex } from '../crypto.js';
import { MAX_NFX_STORED_VIDEOS } from '../protocol.js';
import type { NfxSeedListResult, SeedOrigin, SeedingStatusWire } from '../protocol.js';

export const SEEDING_FILE = 'seeding.json';
/** Larger than a full store can write: 4096 records with the longest titles fit (a test holds it). */
export const MAX_SEEDING_FILE_BYTES = 4 * 1024 * 1024;
/** A stored title is for a dialog to name the video, and a stranger's manifest can supply it. */
export const MAX_STORED_TITLE_BYTES = 256;
const SHA = /^[0-9a-f]{64}$/;
/** What would cost several bytes each in JSON, or break a line in a dialog. */
const NOT_STORED = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu;

const utf8Length = (codePoint: number): number =>
  codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;

/** A title as a record keeps it: no control characters, whole characters, a bounded UTF-8 size. */
export function storedTitle(title: string): string {
  let out = '';
  let bytes = 0;
  for (const ch of title.replace(NOT_STORED, '')) {
    const n = utf8Length(ch.codePointAt(0) ?? 0);
    if (bytes + n > MAX_STORED_TITLE_BYTES) break;
    bytes += n;
    out += ch;
  }
  return out;
}

/** `{ title }` for a record, or nothing when no visible part of it can be kept. */
export function titleField(title: string): { readonly title?: string } {
  const kept = storedTitle(title);
  return kept === '' ? {} : { title: kept };
}

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
    (r['title'] === undefined || typeof r['title'] === 'string')
  );
}

/** A record as loaded: its title held to the same rule as a new one. `null`: not a record. */
function parseRecord(x: unknown): SeedRecord | null {
  if (!isRecord(x)) return null;
  if (x.title === undefined) return x;
  const { title, ...rest } = x;
  return { ...rest, ...titleField(title) };
}

/**
 * The status a window may read. No titles, roots or hash-list sizes: it is one frame, and a full
 * store has to fit in it. Main asks for the one title a dialog needs (`seeding.title`).
 */
export function seedingStatusOf(
  policy: SeedPolicy,
  list: Pick<NfxSeedListResult, 'videos' | 'listening'>,
): SeedingStatusWire {
  return {
    watched: policy.watched,
    videos: list.videos.map((v) => ({
      video: v.video,
      files: v.files,
      bytes: v.bytes,
      origin: policy.origin(v.video),
      served: policy.served(v.video),
      stopped: policy.record(v.video)?.stopped === true,
    })),
    listening: list.listening,
  };
}

export class SeedPolicy {
  readonly #fs: SeederFs;
  readonly #file: string;
  readonly #records = new Map<string, SeedRecord>();
  #watched = false;
  #writes: Promise<void> = Promise.resolve();
  readonly #o: SeedPolicyOptions;
  /** Why the file on disk must be moved aside before anything may replace it. */
  #badFile: string | null = null;

  constructor(fs: SeederFs, dir: string, o: SeedPolicyOptions = {}) {
    this.#fs = fs;
    this.#file = fs.join(dir, SEEDING_FILE);
    this.#o = o;
  }

  /** Never throws: whatever is wrong with the file, the worker starts. */
  async load(): Promise<void> {
    const problem = await this.#read();
    if (problem === null) return;
    this.#badFile = problem;
    try {
      await this.#moveAside();
    } catch {
      this.#o.warn?.(
        `seeding.json is ${problem} and could not be moved aside: nothing will replace it`,
      );
      return;
    }
    // What was valid in it goes back into a new file, so that a crash now does not lose it.
    if (this.#records.size > 0 || this.#watched)
      await this.#save().catch(() => {
        this.#o.warn?.('the records kept from a damaged seeding.json could not be saved');
      });
  }

  /** Loads what is valid. Returns what is wrong with the file, or `null` if nothing is. */
  async #read(): Promise<string | null> {
    let bytes: Uint8Array;
    try {
      const st = await this.#fs.stat(this.#file);
      if (st === null) return null;
      if (!st.isFile) return 'not a file';
      if (st.size > MAX_SEEDING_FILE_BYTES) return 'too large';
      bytes = await this.#fs.readFile(this.#file);
    } catch {
      return 'unreadable';
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return 'not valid JSON';
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'not a seeding file';
    const o = raw as Record<string, unknown>;
    const videos = o['videos'];
    const watched = o['watched'];
    if (
      o['v'] !== 1 ||
      typeof watched !== 'boolean' ||
      typeof videos !== 'object' ||
      videos === null ||
      Array.isArray(videos)
    )
      return 'not a seeding file';
    this.#watched = watched;
    const entries = Object.entries(videos);
    let dropped = Math.max(0, entries.length - MAX_NFX_STORED_VIDEOS);
    for (const [video, r] of entries.slice(0, MAX_NFX_STORED_VIDEOS)) {
      const record = parseRecord(r);
      if (record === null) dropped += 1;
      else this.#records.set(video, record);
    }
    return dropped === 0 ? null : 'holding records that cannot be used';
  }

  /** Renames the bad file to a name nothing else uses. Throws if it is still in the way. */
  async #moveAside(): Promise<void> {
    const problem = this.#badFile;
    if (problem === null) return;
    const suffix = `${String(Date.now())}-${randomHex(6)}.bad`;
    try {
      await this.#fs.rename(this.#file, `${this.#file}.${suffix}`);
    } catch (e) {
      const still = await this.#fs.stat(this.#file).catch(() => undefined);
      if (still !== null) throw e;
    }
    this.#badFile = null;
    this.#o.warn?.(`seeding.json was ${problem}: kept as ${SEEDING_FILE}.${suffix}`);
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
        // Never over a file that could not be read: it may hold the only copy of these records.
        await this.#moveAside();
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
