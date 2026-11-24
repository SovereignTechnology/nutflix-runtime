import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'shell-pear-v2',
    include: ['src/**/__tests__/**/*.test.ts', 'scripts/**/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
