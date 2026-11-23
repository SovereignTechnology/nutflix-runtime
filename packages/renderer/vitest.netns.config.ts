import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'renderer-netns',
    // Needs the isolated network of e2e/netns/topology.sh, strfry and nfxd: the `webrtc` workflow.
    include: ['e2e/netns/**/*.netns.ts'],
    environment: 'node',
    testTimeout: 420_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
