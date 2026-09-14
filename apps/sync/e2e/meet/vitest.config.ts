import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['e2e/meet/*.test.ts'],
    passWithNoTests: false, fileParallelism: false, testTimeout: 10_000 },
});
