import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'renderer',
    // The end-to-end run (e2e/) needs a browser, ffmpeg and a built bundle: `npm run test:e2e`.
    // Files that need no DOM say so with `// @vitest-environment node`.
    include: ['src/**/__tests__/**/*.test.ts', 'src/**/__tests__/**/*.test.tsx'],
    environment: 'jsdom',
  },
});
