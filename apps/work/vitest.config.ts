import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Minimal Svelte compile support so story tests can server-render
  // packages/ui components (rendered-contract assertions, e.g. the US-008
  // dropped-companies banner) without the full SvelteKit runtime.
  plugins: [svelte()],
  resolve: {
    // Component interaction tests mount packages/ui under happy-dom. Prefer
    // Svelte's client entry so `mount()` is available in that environment.
    conditions: ["browser"],
    alias: {
      // SvelteKit virtual modules / aliases for plain-vitest runs.
      "$env/dynamic/private": fileURLToPath(
        new URL("./src/lib/test/env-stub.ts", import.meta.url),
      ),
      "$env/dynamic/public": fileURLToPath(
        new URL("./src/lib/test/env-stub-public.ts", import.meta.url),
      ),
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
  },
  test: {
    // e2e/stories holds vitest story acceptance tests (US-007 pattern);
    // Playwright's smoke project ignores that directory.
    include: ["src/**/*.test.ts", "e2e/stories/**/*.test.ts"],
    // Workspace packages ship TypeScript source. Inline them so Vitest 4
    // compiles their NodeNext `.js` imports rather than externalizing them.
    server: {
      deps: {
        inline: [/@hq\/(auth|core|platform|ui)($|\/)/],
      },
    },
  },
});
