import { svelte } from '@sveltejs/vite-plugin-svelte';
import { configDefaults, defineConfig } from 'vitest/config';

// Idea-board E2E suite: exercises the capture-latency benchmark harness
// (scripts/idea-board-bench.mjs) end to end — parse app-log timestamps, score
// p50/p95 against the project's latency budgets, write bench-results.json, and
// exit non-zero when over budget. Later capture-path stories (US-003+) add
// live specs that drive the real app; they share this config.
export default defineConfig({
  // US-009 mounts the real board components under happy-dom, so this project
  // needs the Svelte compiler even though most specs here are plain Node.
  plugins: [svelte({ hot: false })],
  test: {
    environment: 'node',
    globals: true,
    include: ['e2e/idea-board/**/*.spec.ts'],
    exclude: [...configDefaults.exclude],
    passWithNoTests: false,
    reporters: ['default'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
