/**
 * Atlas lazy chunk entry. Import only through `loadAtlas()` in
 * `shell/atlas-lazy.ts`; a static import from the shell would pull the map
 * into the initial bundle and fails the US-001 guard.
 */
export { default as AtlasView } from "./AtlasView.svelte";
export { default as AtlasInspector } from "./AtlasInspector.svelte";
export * from "./atlas-model.js";
export * from "./atlas-cache.js";
export * from "./atlas-layout.js";
export * from "./atlas-presence.js";
export * from "./atlas-timeline.js";
