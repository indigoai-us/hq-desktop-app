/// <reference types="svelte" />
/// <reference types="vite/client" />
// apps/sync declares this at build time; the intro components' import graph
// reaches a file that reads it, so the preview declares it too.
declare const __APP_VERSION__: string;
