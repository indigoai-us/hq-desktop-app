import { sveltekit } from "@sveltejs/kit/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const webTauriCoreFallback = fileURLToPath(
  new URL("./src/lib/tauri-web-fallback.ts", import.meta.url),
);

export default defineConfig({
  plugins: [sveltekit()],
  resolve: {
    // The Work web build never selects the desktop adapter. Keep the literal
    // dynamic imports in the Tauri bridge modules for the TAURI build, while
    // ensuring this target does not emit @tauri-apps/api as a lazy browser
    // chunk.
    alias: process.env.TAURI
      ? undefined
      : {
          "@tauri-apps/api/core": webTauriCoreFallback,
          "@tauri-apps/api/event": webTauriCoreFallback,
        },
  },
  optimizeDeps: {
    // phosphor-svelte resolves its icons through the `svelte` export
    // condition. Prebundling picks the wrong one and the components arrive as
    // undefined, so the shell renders a blank page rather than an error worth
    // reading. Excluding it hands resolution back to the Svelte plugin.
    exclude: ["phosphor-svelte"],
  },
  // TAURI is intentionally public to the client bundle: the shell selects
  // the injected TauriPlatformAdapter when this static build is launched.
  envPrefix: ["VITE_", "TAURI"],
  ssr: {
    // @hq/* workspace packages ship TS source with NodeNext `.js`-extension
    // relative imports. Bundle them through Vite (dev SSR + prod server build)
    // so TS + `.js`→`.ts` resolution is handled instead of Node externalizing
    // them and failing to resolve the extensions.
    noExternal: [/^@hq\//],
  },
});
