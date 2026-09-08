import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['e2e/meet/hq-meet-desktop-integration-US-012.test.ts'],
    passWithNoTests: false, fileParallelism: false, testTimeout: 10_000 },
});
