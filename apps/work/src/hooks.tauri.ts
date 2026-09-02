/**
 * Static Tauri builds deliberately do not run the hosted-web session gate.
 * `svelte.config.js` selects this hook entry only when TAURI is set; the
 * adapter-static output contains the SPA fallback rather than server routes.
 */
export {};
