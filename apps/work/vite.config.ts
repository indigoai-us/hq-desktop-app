import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
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
