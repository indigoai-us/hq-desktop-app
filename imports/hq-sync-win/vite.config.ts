/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { sentryVitePlugin } from "@sentry/vite-plugin";
import pkg from "./package.json" with { type: "json" };

const root = fileURLToPath(new URL('.', import.meta.url));

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
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: process.env.TAURI_ENV_DEBUG ? true : "hidden",
    rollupOptions: {
      // Multi-page build: the popover (index.html) plus the gated desktop-alt
      // "Company OS" window (desktop-alt.html). The Rust `open_desktop_alt_window`
      // command loads `desktop-alt.html`, so it must be emitted as its own entry.
      input: {
        main: resolve(root, "index.html"),
        "desktop-alt": resolve(root, "desktop-alt.html"),
      },
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
  },
});
