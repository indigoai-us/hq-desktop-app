import { sveltekit } from "@sveltejs/kit/vite";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const webTauriCoreFallback = fileURLToPath(
  new URL("./src/lib/tauri-web-fallback.ts", import.meta.url),
);

// mqtt's Node entry imports Node builtins by bare name (`https`, `net`, …).
// Vite's SSR bundler then looks for an npm package with that name and fails
// with `Failed to resolve entry for package "https"`. Mark them external only
// for the SSR build so the client bundle still uses mqtt's browser entry.
const NODE_BUILTINS = ["https", "http", "net", "tls", "fs", "url", "stream", "zlib", "crypto"];

function externalizeNodeBuiltins(): Plugin {
  return {
    name: "externalize-node-builtins",
    apply: "build",
    enforce: "pre",
    resolveId(id, _importer, options) {
      if (!options?.ssr || !NODE_BUILTINS.includes(id)) return null;
      return { id: `node:${id}`, external: true };
    },
  };
}

export default defineConfig({
  plugins: [sveltekit(), externalizeNodeBuiltins()],
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
