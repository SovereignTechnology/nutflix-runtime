import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'renderer-e2e',
    include: ['e2e/**/*.e2e.ts'],
    environment: 'node',
    // A real worker on a hyperdht testnet, ffmpeg, and a headless Chromium playing for seconds.
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
  },
});
