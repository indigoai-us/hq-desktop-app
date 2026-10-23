import { svelte } from "@sveltejs/vite-plugin-svelte";

/** Local preview for company job screenshots. Not part of the app build. */
export default {
  plugins: [svelte()],
  server: { host: "127.0.0.1", port: 4179, strictPort: true },
};
