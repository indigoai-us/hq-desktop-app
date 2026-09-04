/**
 * DesktopPlatformAdapter (US-011) — the composite adapter the V2 Tauri shell
 * runs on.
 *
 * The desktop app bundles the exact same packages/ui + packages/core as web.
 * The one platform seam is here: cloud-backed capability groups delegate to
 * the WebPlatformAdapter pointed at hq-pro (desktop host supplies the fetch
 * + Bearer; web keeps its own cookie BFF), while genuinely-local capability
 * groups delegate to the TauriPlatformAdapter over `invoke()`.
 *
 * Capability flags are TAURI_CAPABILITIES: on desktop the local groups are
 * really available, so screens light up their local actions (file tree, launch
 * Claude Code/Codex) instead of the web build's degraded states.
 */

import type { PlatformAdapter } from "../adapter.js";
import { TAURI_CAPABILITIES, type Capability } from "../capabilities.js";
import { WebPlatformAdapter } from "../web/index.js";
import { TauriPlatformAdapter, type InvokeFn } from "../tauri/index.js";

export interface DesktopPlatformAdapterConfig {
  /** Tauri `invoke` — local capabilities delegate here. */
  invoke: InvokeFn;
  /**
   * Base URL for cloud REST (hq-pro), e.g. "https://hqapi.hq.computer".
   * Desktop must not point this at the web app BFF (`/api/hq`).
   */
  baseUrl: string;
  /** Injectable fetch (defaults to global). */
  fetch?: typeof globalThis.fetch;
  /** Optional headers applied to every cloud request (e.g. bearer token). */
  headers?: Record<string, string>;
}

/**
 * Build the desktop composite adapter. Cloud groups → web, local groups →
 * tauri. Presented as a single PlatformAdapter so packages/ui screens are
 * written once and never branch on platform.
 */
export function createDesktopAdapter(
  config: DesktopPlatformAdapterConfig,
): PlatformAdapter {
  const web = new WebPlatformAdapter({
    baseUrl: config.baseUrl,
    fetch: config.fetch,
    headers: config.headers,
  });
  const tauri = new TauriPlatformAdapter({ invoke: config.invoke });

  return {
    kind: "desktop",
    capabilities: TAURI_CAPABILITIES,
    isAvailable: (cap: Capability): boolean => TAURI_CAPABILITIES[cap],

    // Cloud-backed groups → hq-pro REST (identical surface to web).
    identity: web.identity,
    messaging: web.messaging,
    notifications: web.notifications,
    meetings: web.meetings,
    marketplace: web.marketplace,
    company: web.company,
    agents: web.agents,
    feedback: web.feedback,
    // Same console shelf as web — person/team scoped, not the local HQ tree.
    library: web.library,

    // Genuinely-local groups → Tauri invoke().
    projects: tauri.projects,
    agency: tauri.agency,
    files: {
      ...tauri.files,
      listVaultPrefix: web.files.listVaultPrefix,
      presignVaultGet: web.files.presignVaultGet,
      presignVaultPut: web.files.presignVaultPut,
    },
    sync: tauri.sync,
    shell: tauri.shell,
    appShell: tauri.appShell,
    updates: tauri.updates,
    packages: tauri.packages,
    sessions: tauri.sessions,
    settings: tauri.settings,
    // Local cache is desktop-only; cloud GET/migrate are available on web too.
    workMesh: {
      readLocalSnapshot: tauri.workMesh.readLocalSnapshot,
      getProjectView: web.workMesh.getProjectView,
      migrateSession: web.workMesh.migrateSession,
    },
  };
}
