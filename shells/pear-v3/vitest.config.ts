import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'shell-pear-v3',
    include: ['src/**/__tests__/**/*.test.ts', 'packaging/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
