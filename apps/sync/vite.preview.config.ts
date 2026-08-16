/// Browser preview harness config — renders Settings/Popover with mocked
/// Tauri APIs so design work can iterate in a normal browser. NOT used by the
/// Tauri build (that uses vite.config.ts). Run: npm run dev:preview
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import pkg from './package.json' with { type: 'json' };
import { resolve } from 'node:path';

const mock = (f: string) => resolve(__dirname, 'dev-harness/mocks', f);

export default defineConfig({
  plugins: [
    svelte(),
    {
      name: 'serve-design-harness',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const url = req.url ?? '/';
          if (url === '/' || url.startsWith('/?')) {
            req.url = `/dev-harness/index.html${url.slice(1)}`;
          }
          next();
        });
      },
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '@tauri-apps/api/core': mock('core.ts'),
      '@tauri-apps/api/event': mock('event.ts'),
      '@tauri-apps/api/window': mock('window.ts'),
      '@tauri-apps/api/webview': mock('webview.ts'),
      '@tauri-apps/api/app': mock('app.ts'),
      '@tauri-apps/plugin-shell': mock('plugin-shell.ts'),
      '@sentry/svelte': mock('sentry.ts'),
    },
  },
  server: {
    port: 1422,
    strictPort: true,
    open: '/dev-harness/index.html?view=onboarding&step=4',
  },
});
