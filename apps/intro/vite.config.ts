import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

// The intro components live in apps/sync so the shipped app and this preview
// render the exact same film. Vite needs explicit permission to serve files
// from outside this app's root.
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1424,
    strictPort: true,
    fs: { allow: [rootDir, resolve(rootDir, '../sync')] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: 'safari13', minify: !process.env.TAURI_DEBUG, sourcemap: !!process.env.TAURI_DEBUG },
});
