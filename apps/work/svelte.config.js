import adapterStatic from "@sveltejs/adapter-static";
import createVercelAdapter from "@sveltejs/adapter-vercel";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// Pin the generated serverless runtime rather than inspecting the local Node
// major. This keeps headless CI builds reproducible when its runner is newer
// than Vercel's currently supported Node versions.
const adapterVercel = () => createVercelAdapter({ runtime: "nodejs22.x" });

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // One source tree, two current shipping targets. Tauri receives a
    // client-side fallback document; Vercel receives serverless functions
    // for Cognito and the S3 byte hops.
    adapter: process.env.TAURI ? adapterStatic({ fallback: "index.html" }) : adapterVercel(),
    // The static target never invokes the authenticated server hook. Its
    // emitted build is a pure SPA and the runtime takes the Tauri adapter
    // path. Web builds retain the Cognito/session hook and route handlers.
    files: {
      hooks: {
        server: process.env.TAURI ? "src/hooks.tauri" : "src/hooks.server",
      },
    },
  },
};

export default config;
