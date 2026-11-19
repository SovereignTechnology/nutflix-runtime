import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // This repository's packages only: nutflix-pear's own suites (vendor/nutflix-pear) run in its
    // CI, at the commit the submodule pins.
    projects: ['packages/*'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/__tests__/**', '**/*.test.ts', '**/types/**'],
      // CI's `test` job runs with --coverage: a summary in the log, json-summary and lcov as the
      // job's artifact. No floors yet: they are set from the first measured run, as nutflix-pear
      // set its own.
      reporter: ['text-summary', 'json-summary', 'lcov'],
    },
  },
});
