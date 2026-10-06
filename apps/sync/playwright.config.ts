import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/browser',
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
      ? 'pnpm exec vite --config vite.preview.config.ts --host 127.0.0.1 --port 1423 --open false'
      : 'pnpm exec vite build --config vite.preview.config.ts --logLevel warn && pnpm exec vite preview --config vite.preview.config.ts --host 127.0.0.1 --port 1423 --strictPort',
    url: 'http://127.0.0.1:1423/desktop-alt.html',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
