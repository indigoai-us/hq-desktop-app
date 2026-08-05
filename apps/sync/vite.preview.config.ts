/// Browser preview harness config — renders Settings/Popover with mocked
/// Tauri APIs so design work can iterate in a normal browser. NOT used by the
/// Tauri build (that uses vite.config.ts). Run: npm run dev:preview
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import pkg from './package.json' with { type: 'json' };
import { resolve } from 'node:path';

const mock = (f: string) => resolve(__dirname, 'dev-harness/mocks', f);

export default defineConfig({
  plugins: [svelte()],
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
  optimizeDeps: {
    // phosphor-svelte ships .svelte sources; prebundling compiles them against
    // a mismatched runtime shape. Compile them as project source instead.
    exclude: ['phosphor-svelte'],
  },
  server: {
    port: 1422,
    strictPort: true,
  },
  // Static build of the harness for shareable design previews:
  // vite build --config vite.preview.config.ts
  build: {
    outDir: 'dist-preview',
    rollupOptions: {
      input: resolve(__dirname, 'dev-harness/index.html'),
    },
  },
});
