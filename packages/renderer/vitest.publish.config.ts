import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'renderer-publish',
    // Needs ffmpeg, strfry, a Chrome with H.264 and a built tree: the `seed-publish` workflow.
    include: ['e2e/publish/**/*.publish.ts'],
    environment: 'node',
    testTimeout: 480_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
