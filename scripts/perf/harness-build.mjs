/**
 * Production BUILD of the apps/sync design harness, for the local perf runner.
 *
 * WHY BUILD, AND WHY THIS ENTRY
 * -----------------------------
 * The thing worth measuring is the REAL shell: packages/ui's DesktopApp, with
 * its real CSS, real stores and real Svelte effects. apps/sync's design harness
 * (`dev-harness/index.html?view=shell&persona=indigo`) mounts exactly that
 * against mocked Tauri IPC and committed fixture data, so a run is
 * deterministic and needs no network, no Cognito and no `hq` daemon.
 *
 * apps/sync/vite.preview.config.ts already wires those mocks, but only for
 * `vite dev`. Dev-mode numbers are dominated by unbundled module fetching and
 * on-the-fly transforms — not what a user pays. So we do the same aliasing as a
 * production build (minified, chunked, one bundle).
 *
 * WHY THE JS API RATHER THAN `vite build --config`
 * ------------------------------------------------
 * `vite` and `@sveltejs/vite-plugin-svelte` are dependencies of apps/sync, not
 * of the workspace root. Pointing the CLI at a config file outside apps/sync
 * makes Vite stage a temp config in the ROOT node_modules, where `vite` does
 * not resolve. Calling the API with a require() rooted in apps/sync sidesteps
 * that entirely and keeps this file inside scripts/.
 *
 * Deliberately NOT a copy of apps/sync/vite.config.ts: the Sentry plugin and
 * the desktop-alt entry add build time and upload side effects that a local
 * diagnostic has no business triggering.
 */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const syncRoot = resolve(rootDir, "apps/sync");

export const HARNESS_OUT_DIR = resolve(rootDir, "perf-results/.harness-build");
/** Path of the built entry, relative to HARNESS_OUT_DIR. */
export const HARNESS_ENTRY = "/dev-harness/index.html";

export async function buildHarness() {
  const require = createRequire(resolve(syncRoot, "package.json"));
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);
  // vite-plugin-svelte is ESM-only and its exports map does not expose
  // "./package.json", so neither require.resolve(name) nor
  // require.resolve(name + "/package.json") works from CJS. Read the manifest
  // off disk (apps/sync/node_modules is a pnpm symlink, which readFile
  // follows) and import the ESM entry it declares.
  const pluginDir = resolve(
    syncRoot,
    "node_modules/@sveltejs/vite-plugin-svelte",
  );
  const pluginPkg = JSON.parse(
    await readFile(resolve(pluginDir, "package.json"), "utf8"),
  );
  const pluginEntry =
    pluginPkg.exports?.["."]?.import?.default ??
    pluginPkg.exports?.["."]?.import ??
    pluginPkg.module ??
    pluginPkg.main;
  const { svelte } = await import(
    pathToFileURL(resolve(pluginDir, pluginEntry)).href
  );

  const mock = (f) => resolve(syncRoot, "dev-harness/mocks", f);

  await build({
    configFile: false,
    root: syncRoot,
    plugins: [svelte()],
    // The harness reads __APP_VERSION__ the same way the real entry does.
    define: { __APP_VERSION__: JSON.stringify("perf-harness") },
    resolve: {
      alias: {
        "@tauri-apps/api/core": mock("core.ts"),
        "@tauri-apps/api/event": mock("event.ts"),
        "@tauri-apps/api/window": mock("window.ts"),
        "@tauri-apps/api/webview": mock("webview.ts"),
        "@tauri-apps/api/app": mock("app.ts"),
        "@tauri-apps/plugin-shell": mock("plugin-shell.ts"),
        "@sentry/svelte": mock("sentry.ts"),
      },
    },
    logLevel: "warn",
    build: {
      // Same target as the shipping app (WKWebView on macOS 13 = Safari 16.4+),
      // so the measured bytes are the bytes the app actually parses.
      target: "safari16",
      minify: "esbuild",
      sourcemap: false,
      emptyOutDir: true,
      outDir: HARNESS_OUT_DIR,
      rollupOptions: {
        input: resolve(syncRoot, "dev-harness/index.html"),
      },
    },
  });
}
