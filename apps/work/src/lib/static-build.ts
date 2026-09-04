/**
 * Was this bundle built without a server behind it?
 *
 * Deliberately distinct from "am I running inside a native shell". The Sync
 * desktop app embeds `WorkShell` into a webview served by the *hosted* build,
 * so a runtime `window.__TAURI__` probe answers a different question and would
 * be wrong here. What the root route's loads need to know is narrower and
 * purely a build fact: `svelte.config.js` picks adapter-static when `TAURI` is
 * set, and that output publishes the SPA fallback document and no `/api`
 * routes at all.
 *
 * `vite.config.ts` puts `TAURI` in `envPrefix`, so this collapses to a literal
 * at build time and the unused branch is eliminated from each bundle.
 */
export function isStaticBuild(): boolean {
  return (
    (import.meta.env as Record<string, string | boolean | undefined>).TAURI ===
    "1"
  );
}
