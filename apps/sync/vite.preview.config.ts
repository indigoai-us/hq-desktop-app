/// Browser preview harness config — renders Settings/Popover with mocked
/// Tauri APIs so design work can iterate in a normal browser. NOT used by the
/// Tauri build (that uses vite.config.ts). Run: npm run dev:preview
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import pkg from './package.json' with { type: 'json' };
import { join, normalize, resolve, sep } from 'node:path';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';

const mock = (f: string) => resolve(__dirname, 'dev-harness/mocks', f);

/**
 * The sort key of an import folder, as `import_folder_key` in
 * src-tauri/src/commands/import_report.rs reads it: the stamp's UTC time
 * (compact `YYYYMMDDTHHMMSSZ` or dashed `YYYY-MM-DDTHH-MM-SS`), then the `-N`
 * suffix as a number (1 when absent). Null for any other name or a stamp that
 * is not a real time.
 */
const importFolderKey = (name: string): [number, number] | null => {
  const m = /^(?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z|(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2}))(?:-(\d+))?$/.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = (m[1] ? m.slice(1, 7) : m.slice(7, 13)).map(Number) as [number, number, number, number, number, number];
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s) return null;
  const n = m[13] === undefined ? 1 : Number(m[13]);
  return n > 0xffffffff ? null : [t, n];
};
const REPORT_KEYS = ['scan_id', 'counts', 'discovery', 'sessions', 'tools', 'projects', 'source', 'written_at'];
/**
 * The newest import report under `root`, mirroring `latest_import_report_in`
 * (the `latest_import_report` command): newest folder first, a report that is
 * not a file, over 256 KB, or not a JSON object is passed over, and only the
 * contract's keys are kept. Null when none qualifies.
 */
const latestImportReport = async (root: string): Promise<Record<string, unknown> | null> => {
  const imports = join(root, 'workspace', 'imports');
  const entries = await readdir(imports, { withFileTypes: true }).catch(() => []);
  const folders = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, key: importFolderKey(e.name) }))
    .filter((f): f is { name: string; key: [number, number] } => f.key !== null)
    .sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1]);
  for (const { name } of folders) {
    const path = join(imports, name, 'report.json');
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size > 256 * 1024) continue;
    let report: unknown;
    try {
      report = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      continue;
    }
    if (!report || typeof report !== 'object' || Array.isArray(report)) continue;
    const r = report as Record<string, unknown>;
    return Object.fromEntries(REPORT_KEYS.filter((k) => k in r).map((k) => [k, r[k]]));
  }
  return null;
};

/**
 * `/__hq/workspace/brief/<run_id>/<file>` serves a real brief run from the HQ
 * root (HQ_ROOT, default ~/hq) so `?view=brief&briefRun=<run_id>` renders it
 * through the app's own loader, and `/__hq/import-report/latest` answers the
 * newest import report. Read-only, those two only; anything else 403s.
 */
type Res = { statusCode: number; setHeader(k: string, v: string): void; end(b?: string): void };
/** Only a browser on this machine may read brief runs: the Host header must be a loopback name. */
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const hqBriefRuns = (req: { url?: string; headers: { host?: string } }, res: Res, next: () => void) => {
  const url = req.url ?? '';
  if (!url.startsWith('/__hq/')) return next();
  // This runs ahead of Vite's own host check, so it gates the Host header
  // itself: a DNS-rebinding page cannot read brief runs through it.
  if (!LOOPBACK_HOST.test(req.headers.host ?? '')) {
    res.statusCode = 403;
    return res.end();
  }
  const rel = normalize(decodeURIComponent(url.slice('/__hq/'.length).split('?')[0]!));
  const root = process.env.HQ_ROOT ?? join(homedir(), 'hq');
  // `/__hq/import-report/latest` answers what the app's `latest_import_report` command would.
  if (rel === 'import-report/latest') {
    void latestImportReport(root).then((report) => {
      if (!report) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(report));
    });
    return;
  }
  if (!rel.startsWith('workspace/brief/') || rel.includes('..')) {
    res.statusCode = 403;
    return res.end();
  }
  void (async () => {
    try {
      // A symlink inside a run folder must not lead outside the brief runs.
      const runs = await realpath(join(root, 'workspace', 'brief'));
      const file = await realpath(join(root, rel));
      if (!file.startsWith(runs + sep)) {
        res.statusCode = 403;
        return res.end();
      }
      const text = await readFile(file, 'utf8');
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(text);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  })();
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
        // Must run before Vite's internals (its SPA fallback would answer the
        // page for /__hq/ otherwise), so it carries its own loopback Host gate.
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
