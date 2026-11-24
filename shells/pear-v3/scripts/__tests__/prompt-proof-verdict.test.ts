/**
 * A failed proof can never pass. The case that got through once: the proof hung, its timeout fired,
 * and the shutdown resolved the await it was stuck on, so it went on to print its success line and
 * exit 0.
 */
import { describe, expect, it } from 'vitest';

import {
  EXPECTED_PROOF_LINE,
  FAILED_MARK,
  NOTE_MARK,
  PROOF_FIELDS,
  PROOF_MARK,
  ProofVerdict,
  proofLogProblems,
  runProof,
  withDeadline,
  type ProofTimers,
  type VerdictIo,
} from '../prompt-proof-verdict.ts';

function world(): {
  io: VerdictIo;
  lines: string[];
  exits: number[];
  timers: ProofTimers;
  fire: () => void;
} {
  const lines: string[] = [];
  const exits: number[] = [];
  const pending = new Map<number, () => void>();
  let next = 0;
  return {
    lines,
    exits,
    io: {
      line: (t) => {
        lines.push(t);
      },
      exit: (c) => {
        exits.push(c);
      },
    },
    timers: {
      set: (fn) => {
        next += 1;
        pending.set(next, fn);
        return next;
      },
      clear: (h) => {
        pending.delete(h as number);
      },
    },
    fire: () => {
      for (const [k, fn] of [...pending]) {
        pending.delete(k);
        fn();
      }
    },
  };
}

const allTrue = (v: ProofVerdict): void => {
  for (const f of PROOF_FIELDS) v.check(f, true);
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const noPass = (w: { lines: string[]; exits: number[] }): void => {
  expect(w.lines.filter((l) => l.startsWith('PROOF'))).toEqual([]);
  expect(w.exits).not.toContain(0);
  expect(w.exits).toEqual([1]);
};

describe('a failed proof can never pass', () => {
  it('a step that times out, then resolves late, prints no PROOF and never exits 0', async () => {
    const w = world();
    const v = new ProofVerdict(w.io);
    let lateResolve: (x: boolean) => void = () => undefined;
    const stuck = new Promise<boolean>((r) => {
      lateResolve = r;
    });
    const running = runProof(
      v,
      async (x) => {
        // What the shutdown did: this await resolves after the timeout, with the "right" answer.
        const answer = await stuck;
        for (const f of PROOF_FIELDS) x.check(f, !answer);
      },
      90_000,
      w.timers,
    );
    await flush();
    w.fire();
    expect(v.state).toBe('failed');
    expect(w.lines.filter((l) => l.startsWith(FAILED_MARK))).toHaveLength(1);
    lateResolve(false);
    await running;
    noPass(w);
    expect(proofLogProblems(w.lines.join('\n')).length).toBeGreaterThan(0);
  });

  it('a step that swallows everything and returns after the timeout still cannot pass', async () => {
    const w = world();
    const v = new ProofVerdict(w.io);
    let late: () => void = () => undefined;
    const stuck = new Promise<void>((r) => {
      late = r;
    });
    const running = runProof(
      v,
      async (x) => {
        await stuck;
        try {
          allTrue(x);
        } catch {
          // A careless step.
        }
      },
      1000,
      w.timers,
    );
    await flush();
    w.fire();
    late();
    await running;
    noPass(w);
  });

  it('a later finish or failure changes nothing', () => {
    const w = world();
    const v = new ProofVerdict(w.io);
    allTrue(v);
    v.fail('the first failure');
    v.finish();
    v.fail('a second failure');
    noPass(w);
    expect(w.lines).toHaveLength(1);
  });

  it('a false check fails at once, and the step cannot go on to pass', async () => {
    const w = world();
    const v = new ProofVerdict(w.io);
    await runProof(
      v,
      (x) => {
        x.check('modal', false, 'the window is not modal');
        allTrue(x);
        return Promise.resolve();
      },
      1000,
      w.timers,
    );
    noPass(w);
    expect(w.lines[0]).toContain('the window is not modal');
  });

  it('a step that throws fails', async () => {
    const w = world();
    await runProof(
      new ProofVerdict(w.io),
      () => Promise.reject(new Error('it broke')),
      1000,
      w.timers,
    );
    noPass(w);
    expect(w.lines[0]).toBe(`${FAILED_MARK} it broke`);
  });

  it('a field that was never checked fails', async () => {
    const w = world();
    await runProof(
      new ProofVerdict(w.io),
      (x) => {
        for (const f of PROOF_FIELDS) if (f !== 'rendererDeathIsCancel') x.check(f, true);
        return Promise.resolve();
      },
      1000,
      w.timers,
    );
    noPass(w);
    expect(w.lines[0]).toContain('never checked: rendererDeathIsCancel');
  });

  it('only a whole, clean run prints the exact line and exits 0, once', async () => {
    const w = world();
    const v = new ProofVerdict(w.io);
    await runProof(
      v,
      (x) => {
        allTrue(x);
        x.note('evidence', { reason: 'killed' });
        return Promise.resolve();
      },
      1000,
      w.timers,
    );
    expect(v.state).toBe('passed');
    expect(w.exits).toEqual([0]);
    expect(w.lines).toEqual([`${NOTE_MARK} evidence {"reason":"killed"}`, EXPECTED_PROOF_LINE]);
    w.fire();
    expect(w.exits).toEqual([0]);
  });

  it('a note counts for nothing', () => {
    const w = world();
    const v = new ProofVerdict(w.io);
    v.note('evidence', { rendererDeathIsCancel: true });
    v.finish();
    noPass(w);
  });
});

describe('withDeadline', () => {
  it('rejects at its deadline, and a late answer changes nothing', async () => {
    const w = world();
    let late: (x: string) => void = () => undefined;
    const bounded = withDeadline(
      new Promise<string>((r) => {
        late = r;
      }),
      5000,
      'the renderer',
      w.timers,
    );
    w.fire();
    late('too late');
    await expect(bounded).rejects.toThrow('timed out after 5000 ms: the renderer');
  });

  it('answers in time, and leaves no timer running', async () => {
    const w = world();
    await expect(withDeadline(Promise.resolve(7), 5000, 'x', w.timers)).resolves.toBe(7);
    await expect(
      withDeadline(Promise.reject(new Error('no')), 5000, 'x', w.timers),
    ).rejects.toThrow('no');
    let fired = false;
    w.timers.set(() => {
      fired = true;
    }, 1);
    w.fire();
    expect(fired).toBe(true);
  });
});

describe('what the workflow accepts from the log', () => {
  const noise = '[5845:1124/012416.510666:ERROR:dbus/bus.cc:406] Failed to connect to the bus';

  it('the exact line, among other output', () => {
    expect(proofLogProblems(`${noise}\n${EXPECTED_PROOF_LINE}\n${noise}\n`)).toEqual([]);
  });

  it('with colours and carriage returns taken off', () => {
    const esc = String.fromCharCode(27);
    expect(proofLogProblems(`${esc}[32m${EXPECTED_PROOF_LINE}${esc}[0m\r\n`)).toEqual([]);
  });

  it('refuses the log that got through once: a failure, then a proof line', () => {
    const log = `${FAILED_MARK} timed out\n${EXPECTED_PROOF_LINE}\n`;
    expect(proofLogProblems(log).join()).toContain('the proof failed');
  });

  it.each([
    ['no line', noise],
    ['two lines', `${EXPECTED_PROOF_LINE}\n${EXPECTED_PROOF_LINE}`],
    ['a false field', EXPECTED_PROOF_LINE.replace('"modal":true', '"modal":false')],
    ['a missing field', EXPECTED_PROOF_LINE.replace('"modal":true,', '')],
    ['an extra field', EXPECTED_PROOF_LINE.replace('{', '{"extra":true,')],
    ['a line of another shape', `${PROOF_MARK} {"driven":"by a script"}`],
  ])('refuses %s', (_name, log) => {
    expect(proofLogProblems(log).length).toBeGreaterThan(0);
  });

  it('every field of the expected line is true', () => {
    const fields = JSON.parse(EXPECTED_PROOF_LINE.slice(PROOF_MARK.length + 1)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(fields)).toEqual([...PROOF_FIELDS]);
    expect(Object.values(fields).every((x) => x === true)).toBe(true);
  });
});
