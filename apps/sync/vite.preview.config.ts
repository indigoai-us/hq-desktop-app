/// Browser preview harness config — renders Settings/Popover with mocked
/// Tauri APIs so design work can iterate in a normal browser. NOT used by the
/// Tauri build (that uses vite.config.ts). Run: npm run dev:preview
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import pkg from './package.json' with { type: 'json' };
import { join, normalize, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

const mock = (f: string) => resolve(__dirname, 'dev-harness/mocks', f);

/**
 * `/__hq/workspace/brief/<run_id>/<file>` serves a real brief run from the HQ
 * root (HQ_ROOT, default ~/hq) so `?view=brief&briefRun=<run_id>` renders it
 * through the app's own loader. Read-only, brief runs only; anything else 403s.
 */
type Res = { statusCode: number; setHeader(k: string, v: string): void; end(b?: string): void };
const hqBriefRuns = (req: { url?: string }, res: Res, next: () => void) => {
  const url = req.url ?? '';
  if (!url.startsWith('/__hq/')) return next();
  const rel = normalize(decodeURIComponent(url.slice('/__hq/'.length).split('?')[0]!));
  if (!rel.startsWith('workspace/brief/') || rel.includes('..')) {
    res.statusCode = 403;
    return res.end();
  }
  readFile(join(process.env.HQ_ROOT ?? join(homedir(), 'hq'), rel), 'utf8').then(
    (text) => {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(text);
    },
    () => {
      res.statusCode = 404;
      res.end();
    },
  );
};

/** `/` and `/?…` open the design harness, in dev and in `vite preview` alike. */
const harnessRoot = (req: { url?: string }, _res: unknown, next: () => void) => {
  const url = req.url ?? '/';
  if (url === '/' || url.startsWith('/?')) {
    req.url = `/dev-harness/index.html${url.slice(1)}`;
  }
  next();
};

export default defineConfig({
  plugins: [
    svelte(),
    {
      name: 'serve-design-harness',
      configureServer(server) {
        server.middlewares.use(harnessRoot);
        server.middlewares.use(hqBriefRuns);
      },
      configurePreviewServer(server) {
        server.middlewares.use(harnessRoot);
        server.middlewares.use(hqBriefRuns);
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
  },
  // The browser suite serves a built harness (see playwright.config.ts): one
  // bundle per page instead of ~860 modules compiled on request, which stalled
  // boots past the test limits when many pages open at once on a CI runner.
  build: {
    outDir: 'dist-preview',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        harness: resolve(__dirname, 'dev-harness/index.html'),
        desktopAlt: resolve(__dirname, 'desktop-alt.html'),
        switchStability: resolve(__dirname, 'switch-stability.html'),
        personalSecretsLayout: resolve(__dirname, 'personal-secrets-layout.html'),
        atlasStage: resolve(__dirname, 'atlas-stage.html'),
        boardPolish: resolve(__dirname, 'board-polish.html'),
      },
    },
  },
});
