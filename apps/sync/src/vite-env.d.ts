/// <reference types="vite/client" />
/// <reference types="svelte" />

interface ImportMetaEnv {
  readonly VITE_INSTALLER_STEP_URL?: string;
  readonly VITE_SENTRY_DSN?: string;
}
