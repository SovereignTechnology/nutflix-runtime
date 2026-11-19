import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'worker',
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
