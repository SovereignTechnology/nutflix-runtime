import { defineProject } from 'vitest/config';

/** The real `pear run` proof (`proof/pear-run.proof.ts`). Runs only in a throwaway VM. */
export default defineProject({
  test: {
    name: 'shell-pear-v2-proof',
    include: ['proof/**/*.proof.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 2_400_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
