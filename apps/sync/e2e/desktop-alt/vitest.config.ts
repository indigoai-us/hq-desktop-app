import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Live mode boots a real Tauri binary through tauri-driver -> msedgedriver.
// On a GitHub Windows runner the app alone takes ~5s to reach first paint, so
// vitest's 5s default kills WebDriver session creation mid-flight (and leaves a
// half-started app that poisons the following tests). The scripted
// source-contract suite keeps the tight default so genuine hangs still surface
// fast — only the opt-in live path gets the larger budget.
const LIVE = /^(1|true|yes)$/i.test(process.env.HQ_SYNC_DESKTOP_ALT_LIVE ?? '');

export default defineConfig({
  // The real component-mount E2E (mission-control.test.ts) imports
  // `*.svelte` files and renders them, so the desktop-alt suite needs the
  // Svelte compiler in its pipeline. The source-contract specs don't import
  // components, so this is a no-op for them. `hot: false` keeps the compiler in
  // a test-friendly (no HMR) mode under vitest.
  plugins: [svelte({ hot: false })],
  // Resolve Svelte's *client* build (not the server/SSR build) so `mount()` is
  // available — without the `browser` condition vitest picks svelte's
  // index-server export and component mounting throws. Pairs with the
  // per-spec happy-dom environment.
  resolve: {
    conditions: ['browser'],
  },
  test: {
    // Per-spec `// @vitest-environment` pragmas override this default — the
    // source-contract specs stay in node, while the real component-mount E2E
    // (mission-control.test.ts) opts into happy-dom to render the page.
    environment: 'node',
    globals: true,
    include: ['e2e/desktop-alt/**/*.spec.ts', 'e2e/desktop-alt/**/*.test.ts'],
    passWithNoTests: false,
    reporters: ['default'],
    testTimeout: LIVE ? 120_000 : 5_000,
    hookTimeout: LIVE ? 120_000 : 10_000,
    // One app instance at a time: the driver serves a single WebDriver session,
    // and two live specs racing for port 4444 cannot both win.
    fileParallelism: !LIVE,
  },
});
