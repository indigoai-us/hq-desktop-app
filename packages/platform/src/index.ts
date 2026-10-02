// Full platform adapter surface (US-004).
export * from "./adapter.js";
export * from "./capabilities.js";
export * from "./host-platform.js";
export * from "./host-computer-noun.js";
export * from "./library-shelf.js";
// Plan-limit refusal parsing + upgrade-link allowlist (hard-stop-readiness).
export * from "./plan-limit.js";
export {
  CLAUDE_PROVIDER_FLAG,
  DESKTOP_LIMIT_STATUS_PUSH_FLAG,
  FIRST_FOLDER_SYNC_STEP_FLAG,
  HUMAN_ONLY_CONVERSATIONS_FLAG,
  HUMAN_ONLY_CONVERSATIONS_DESKTOP_DEFAULT,
  INVITE_TEAMMATE_STEP_FLAG,
  PERSONAL_WORKSPACE_BOARD_FLAG,
  SETUP_STAGE_TIMEOUT_FIX_FLAG,
  SETUP_DIRECTORY_PARENT_FALLBACK_FLAG,
} from "./flags.js";
export {
  compareHumanRecency,
  filterHumanMessages,
  humanRecencyKey,
  humanRecencyState,
  isUndatedNoHumanRow,
  isHumanMessage,
  orderChannelsForViewer,
} from "./humanMessage.js";
export type {
  HumanClassifiable,
  HumanRecencyChannel,
  HumanRecencyState,
} from "./humanMessage.js";

// Shared 429 / Retry-After policy and the jittered background pollers (R2).
export {
  MIN_POLL_INTERVAL_MS,
  POLL_JITTER_RATIO,
  RETRYABLE_STATUSES,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  RETRY_MAX_ATTEMPTS,
  createThrottleSignal,
  fullJitterBackoffMs,
  globalThrottleSignal,
  isRetryableStatus,
  jitterIntervalMs,
  nextPollDelayMs,
  parseRetryAfterMs,
  retryThrottled,
  setJitterRandomForTests,
  startJitteredPoll,
} from "./request-policy.js";
export type {
  AttemptClassification,
  JitteredPollOptions,
  RequestPolicyOptions,
  ThrottleSignal,
} from "./request-policy.js";

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
