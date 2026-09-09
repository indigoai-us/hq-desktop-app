import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/browser',
  use: { baseURL: 'http://127.0.0.1:1423', viewport: { width: 1180, height: 760 } },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'pnpm exec vite --config vite.preview.config.ts --host 127.0.0.1 --port 1423 --open false',
    url: 'http://127.0.0.1:1423/desktop-alt.html',
    reuseExistingServer: !process.env.CI,
  },
});
