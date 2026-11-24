/**
 * What a release or launch build's main bundles in place of `play-proof.ts` (`packaging/stage.ts`
 * swaps the import for any root but a `test` one): the same two names, and nothing that can open,
 * press or measure anything. Main reaches them only from a root's `play`, which those roots refuse;
 * `assertMainMatchesRoot` refuses such a build whose main holds the proof's own words anyway.
 */
import type { PlayProof } from '../update/root.ts';
import type { PlayProofDeps } from './play-proof.ts';

/** Counts nothing. */
export class OffLoopback {
  see(_url: string): void {
    // Nothing is counted in a build that plays nothing by itself.
  }

  take(): number {
    return 0;
  }
}

/** Does nothing. */
export function runPlayProof(_play: PlayProof, _d: PlayProofDeps): Promise<void> {
  return Promise.resolve();
}
