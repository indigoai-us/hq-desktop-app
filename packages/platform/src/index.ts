// Full platform adapter surface (US-004).
export * from "./adapter.js";
export * from "./capabilities.js";
export * from "./library-shelf.js";
export { WebPlatformAdapter, WEB_PATHS } from "./web/index.js";
export type { WebPlatformAdapterConfig } from "./web/index.js";
export { TauriPlatformAdapter } from "./tauri/index.js";
export type { TauriPlatformAdapterConfig, InvokeFn } from "./tauri/index.js";
export { createDesktopAdapter } from "./desktop/index.js";
export type { DesktopPlatformAdapterConfig } from "./desktop/index.js";

// Legacy scaffold exports — kept working for existing consumers.
export { createMemoryAdapter } from "./legacy.js";
export type { LegacyPlatformAdapter } from "./legacy.js";
