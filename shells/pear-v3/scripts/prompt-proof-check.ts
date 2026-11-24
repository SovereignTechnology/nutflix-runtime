/**
 * Reads the prompt proof's log, as the workflow's verdict: no failure line, and exactly the one
 * expected `PROOF prompt-modal` line, with every field true. The exit status of the proof is not
 * enough on its own.
 *
 *   node shells/pear-v3/scripts/prompt-proof-check.ts <log file>
 */
import { readFileSync } from 'node:fs';

import { EXPECTED_PROOF_LINE, proofLogProblems } from './prompt-proof-verdict.ts';

const file = process.argv[2];
if (file === undefined) {
  console.error('usage: prompt-proof-check.ts <log file>');
  process.exit(2);
}
const problems = proofLogProblems(readFileSync(file, 'utf8'));
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
process.stdout.write(`${EXPECTED_PROOF_LINE}\n`);
