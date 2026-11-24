/**
 * How the prompt window's proof reaches a verdict, kept apart from Electron so that it can be tested
 * on its own. An earlier version timed out, and the shutdown that followed resolved the very await
 * it was stuck on: the script then printed its success line and exited 0. So here:
 *
 *   - the first failure is final. After it there is no `PROOF` line and no exit 0, whatever resolves;
 *   - the `PROOF` line is not written by hand. It is printed only when every field in `PROOF_FIELDS`
 *     was checked and true, and it is one exact string;
 *   - the workflow reads the log and requires that string (`proofLogProblems`), rather than trusting
 *     the exit status alone.
 */

export const FAILED_MARK = 'PROMPT-PROOF-FAILED';
export const NOTE_MARK = 'PROMPT-PROOF-NOTE';
export const PROOF_MARK = 'PROOF prompt-modal';

/** Everything the proof must have seen. A field that was never checked fails it. */
export const PROOF_FIELDS = [
  'accountMenuPresent',
  'menuBarVisible',
  'syntheticKeyIgnored',
  'realKeyReachedMain',
  'pageDidNotSeeKey',
  'menuItemOpensPrompt',
  'promptWasVisible',
  'rendererSandboxed',
  'modal',
  'showsPromptUrl',
  'pageWorldClean',
  'policyRefusesAll',
  'otherWindowDropped',
  'enterOnCancelIgnored',
  'differentFieldsBlocked',
  'valueReachedMain',
  'refusalKeptOpen',
  'fieldCleared',
  'acceptedCloses',
  'cancelIsCancel',
  'closeIsCancel',
  'nothingElseReachedMain',
  'closeDuringSubmitWaited',
  'closeDuringSubmitReported',
  'neverShownIsCancel',
  'deathBeforePaintWasOpen',
  'deathBeforePaintNamedPath',
  'deathBeforePaintIsCancel',
  'deathBeforePaintNoValue',
  'deathBeforePaintWindowDestroyed',
  'lockReleasedAfterDeath',
  'rendererDeathIsCancel',
  'fullscreenFromRealClick',
  'escLeavesFullscreen',
  'menuBarBackAfterEsc',
] as const;

export type ProofField = (typeof PROOF_FIELDS)[number];

/** The one line that means the proof passed. */
export const EXPECTED_PROOF_LINE = `${PROOF_MARK} ${JSON.stringify(
  Object.fromEntries(PROOF_FIELDS.map((f) => [f, true])),
)}`;

export interface VerdictIo {
  /** One line of the log, written before this returns. */
  line(text: string): void;
  /** Ends the process. Must not return control to a failed proof for long. */
  exit(code: number): void;
}

export interface ProofTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: ProofTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => {
    clearTimeout(h as ReturnType<typeof setTimeout>);
  },
};

/** Thrown out of a step whose proof is already over. */
class ProofStopped extends Error {
  override readonly name = 'ProofStopped';
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').slice(0, 400);

export class ProofVerdict {
  readonly #io: VerdictIo;
  readonly #held = new Set<ProofField>();
  #state: 'running' | 'failed' | 'passed' = 'running';

  constructor(io: VerdictIo) {
    this.#io = io;
  }

  get state(): 'running' | 'failed' | 'passed' {
    return this.#state;
  }

  /** Records a check. A false one fails the proof. Past the verdict, it stops the step. */
  check(field: ProofField, ok: boolean, what: string = field): void {
    if (this.#state !== 'running') throw new ProofStopped('the proof is already over');
    if (!ok) {
      this.fail(`${field}: ${what}`);
      throw new ProofStopped(what);
    }
    this.#held.add(field);
  }

  /** Evidence for the log. It never counts toward the verdict. */
  note(name: string, fields: Readonly<Record<string, unknown>>): void {
    this.#io.line(`${NOTE_MARK} ${name} ${JSON.stringify(fields)}`);
  }

  /** The first failure is the verdict. */
  fail(reason: string): void {
    if (this.#state !== 'running') return;
    this.#state = 'failed';
    this.#io.line(`${FAILED_MARK} ${oneLine(reason)}`);
    this.#io.exit(1);
  }

  /** Passes only if nothing failed and every field was checked. */
  finish(): void {
    if (this.#state !== 'running') return;
    const missing = PROOF_FIELDS.filter((f) => !this.#held.has(f));
    if (missing.length > 0) {
      this.fail(`never checked: ${missing.join(', ')}`);
      return;
    }
    this.#state = 'passed';
    this.#io.line(EXPECTED_PROOF_LINE);
    this.#io.exit(0);
  }
}

/** `p`, or a rejection after `ms`: no await in the proof waits on something unbounded. */
export function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  what: string,
  timers: ProofTimers = realTimers,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = timers.set(() => {
      reject(new Error(`timed out after ${String(ms)} ms: ${what}`));
    }, ms);
    p.then(
      (v) => {
        timers.clear(t);
        resolve(v);
      },
      (e: unknown) => {
        timers.clear(t);
        reject(e instanceof Error ? e : new Error(what));
      },
    );
  });
}

/** Runs the proof under one overall deadline. Only a step that ends in time can pass. */
export async function runProof(
  v: ProofVerdict,
  step: (v: ProofVerdict) => Promise<void>,
  timeoutMs: number,
  timers: ProofTimers = realTimers,
): Promise<void> {
  const overall = timers.set(() => {
    v.fail(`timed out after ${String(timeoutMs)} ms`);
  }, timeoutMs);
  try {
    await step(v);
    v.finish();
  } catch (e) {
    v.fail(e instanceof Error ? e.message : 'the proof threw');
  } finally {
    timers.clear(overall);
  }
}

const COLOURS = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** What is wrong with a proof's log. Empty only for exactly one exact line and no failure. */
export function proofLogProblems(log: string): string[] {
  const lines = log.split(/\r?\n/).map((l) => l.replace(COLOURS, ''));
  const problems = lines
    .filter((l) => l.includes(FAILED_MARK))
    .map((l) => `the proof failed: ${l.slice(0, 300)}`);
  const proofs = lines.filter((l) => l.startsWith(PROOF_MARK));
  if (proofs.length !== 1)
    problems.push(`expected one "${PROOF_MARK}" line, found ${String(proofs.length)}`);
  else if (proofs[0] !== EXPECTED_PROOF_LINE)
    problems.push(`the "${PROOF_MARK}" line is not the exact expected line`);
  return problems;
}
