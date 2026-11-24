/**
 * The stored sandbox choice on disk, `<userData>/sandbox-consent.json` (`sandbox-gate.ts`). Main
 * keeps ONE of these per run: the choice is read before any window, written once after "Run anyway",
 * and deleted by `--forget-sandbox-choice` or by Settings (`app.sandbox.forget`, `main-calls.ts`).
 * Deleting waits for a write still in flight, so a choice made at this start cannot come back after
 * it was forgotten. Node's `fs` only: the tests use a real temporary directory.
 */
import { readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';

import { parseConsent, type Consent } from './sandbox-gate.ts';

export class ConsentFile {
  readonly path: string;
  #writing: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  /** The stored choice, or `null`: no file, or anything but exactly the stored shape. */
  read(): Consent | null {
    try {
      return parseConsent(readFileSync(this.path, 'utf8'));
    } catch {
      return null;
    }
  }

  /** Stores the choice in the background; `onFailed` runs if it could not be stored. */
  write(c: Consent, onFailed: () => void): void {
    this.#writing = writeFile(this.path, `${JSON.stringify(c)}\n`, { mode: 0o600 }).catch(() => {
      onFailed();
    });
  }

  /** Deletes the choice once any write has settled. No file counts as forgotten; rejects otherwise. */
  async forget(): Promise<void> {
    await this.#writing;
    await rm(this.path, { force: true });
  }
}
