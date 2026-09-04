import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    // Compile .svelte files so component-mount tests (e.g.
    // src/marketplace/ProfilePanel.test.ts) can `mount()` under happy-dom.
    svelte({ compilerOptions: { css: "injected" } }),
  ],
  resolve: {
    // Vitest runs in a node-ish environment; force Svelte's client runtime so
    // `mount()` works under happy-dom instead of the server entry.
    conditions: ["browser"],
  },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-setup.ts"],
  },
});
