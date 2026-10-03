/**
 * Telemetry lazy chunk entry. Import only through `loadTelemetry()` in
 * `shell/telemetry-lazy.ts`. A static import from the shell would pull this
 * module into the initial bundle.
 */
export { default as TelemetryView } from "./TelemetryView.svelte";
export * from "./telemetry-model.js";
export * from "./telemetry-cache.js";
export * from "./telemetry-me.js";
export { TELEMETRY_SMOKE, TELEMETRY_SCOPES, SMOKE_LIST_COST_LABEL } from "./telemetry-smoke.js";
export { createLocalSessionsReader } from "./telemetry-local-sessions.js";
