/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { sentryVitePlugin } from "@sentry/vite-plugin";
import pkg from "./package.json" with { type: "json" };
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    svelte(),
    sentryVitePlugin({
      org: process.env.SENTRY_ORG ?? "indigo-d0",
      project: process.env.SENTRY_PROJECT ?? "hq-sync-web",
      authToken: process.env.SENTRY_AUTH_TOKEN,
      release: { name: `hq-sync-web@${pkg.version}` },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    fs: {
      allow: [
        rootDir,
        resolve(rootDir, '../../../../hq-work-mono/hq-work-sync-handoff'),
      ],
    },
  },
  optimizeDeps: {
    exclude: ['@hq/ui', '@hq/platform', '@hq/core', '@hq/work'],
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: process.env.TAURI_ENV_DEBUG ? true : "hidden",
    rollupOptions: {
      input: {
        main: resolve(rootDir, "index.html"),
        desktopAlt: resolve(rootDir, "desktop-alt.html"),
      },
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: [
      "src/**/*.test.ts",
      "__tests__/stories/**/*.test.ts",
      // Recall SDK bridge sidecar (Node ESM). node_modules stays excluded by
      // vitest's default exclude, so this only matches our own bridge tests.
      "sidecar/recall-sdk-bridge/**/*.test.mjs",
    ],
    // Linked hq-work-mono packages ship TypeScript source, not JS. Vitest 4
    // will not strip types under node_modules unless we inline them.
    server: {
      deps: {
        inline: [/@hq\/(ui|platform|core|work)($|\/)/],
      },
    },
  },
});
