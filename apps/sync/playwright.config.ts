import { defineConfig, devices } from '@playwright/test';
import { E2E_HQ_ROOT } from './e2e/browser/hq-root';

export default defineConfig({
  testDir: './e2e/browser',
  // Each run gets its own temp HQ folder (hq-root.ts); setup checks it, teardown deletes it.
  globalSetup: './e2e/browser/global-setup.ts',
  globalTeardown: './e2e/browser/global-teardown.ts',
  use: { baseURL: 'http://127.0.0.1:1423', viewport: { width: 1180, height: 760 } },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  // Serve a built harness rather than the dev server. The dev server compiles
  // ~860 modules on request for every fresh page, and the suites that open
  // eight pages at once stalled boots past the test limits on 2-CPU CI
  // runners. PW_DEV_SERVER=1 keeps the dev server for local iteration.
  webServer: {
    command: process.env.PW_DEV_SERVER
      ? 'pnpm exec vite --config vite.preview.config.ts --host 127.0.0.1 --port 1423 --strictPort --open false'
      : 'pnpm exec vite build --config vite.preview.config.ts --logLevel warn && pnpm exec vite preview --config vite.preview.config.ts --host 127.0.0.1 --port 1423 --strictPort',
    url: 'http://127.0.0.1:1423/desktop-alt.html',
    // Never reuse a server already on 1423: it reads some other HQ folder.
    // Playwright fails the run when the port is already serving.
    reuseExistingServer: false,
    timeout: 180_000,
    // `/__hq/` reads this folder, not ~/hq: specs write brief runs and import reports into it.
    env: { HQ_ROOT: E2E_HQ_ROOT },
  },
});
