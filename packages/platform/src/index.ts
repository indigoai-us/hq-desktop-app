// Full platform adapter surface (US-004).
export * from "./adapter.js";
export * from "./capabilities.js";
export * from "./host-platform.js";
export * from "./library-shelf.js";

// Native calling (US-014): contract mirror, evidence preflight, calls group.
export * from "./calls/contract.js";
export * from "./calls/evidence.js";
export {
  CALLS_PATHS,
  CALLS_PREFLIGHT_REQUIRED,
  CALLS_UNSUPPORTED_HOST,
  createCallsApi,
  createUnsupportedCallsApi,
} from "./calls/api.js";
export type { CallsTransport } from "./calls/api.js";
export {
  canonical,
  contentDigest,
  keyId,
  sha256,
  signedBytes,
  toBase64Url,
  verifyChunkBytes,
  verifyEnvelope,
} from "./calls/crypto.js";
export { WebPlatformAdapter, WEB_PATHS } from "./web/index.js";
export type { WebPlatformAdapterConfig } from "./web/index.js";
export { TauriPlatformAdapter } from "./tauri/index.js";
export type { TauriPlatformAdapterConfig, InvokeFn } from "./tauri/index.js";
export { createSyncPlatformAdapter } from "./tauri/sync-adapter.js";
export type {
  SyncInvokeFn,
  SyncPlatformAdapterConfig,
} from "./tauri/sync-adapter.js";
export {
  SettingsMutationQueue,
  updateSettings,
} from "./tauri/settings-mutations.js";
export type {
  SettingsInvoker,
  SettingsPatch,
  SettingsPrefs,
} from "./tauri/settings-mutations.js";
export { createDesktopAdapter } from "./desktop/index.js";
export type { DesktopPlatformAdapterConfig } from "./desktop/index.js";

// Legacy scaffold exports — kept working for existing consumers.
export { createMemoryAdapter } from "./legacy.js";
export type { LegacyPlatformAdapter } from "./legacy.js";
