/**
 * Updater wire helpers shared by VersionPopout and SettingsPage — the pure
 * slice of the desktop `lib/notificationFeedData.ts` plus the event seam that
 * replaces the desktop `listen('update:available'|'update:cleared')` channels.
 */

export interface UpdateInfo {
  version: string;
  body?: string;
  date?: string;
}

export type PendingUpdateState =
  | { status: "unchecked" }
  | { status: "absent" }
  | { status: "pending"; update: UpdateInfo };

export type UpdateLoadState =
  "resolved" | "unchecked" | "failed" | "not-requested";

/**
 * Decode native updater hydration. The legacy UpdateInfo/null branches keep
 * browser fixtures and older sidecars compatible; current native builds return
 * the explicit tri-state so cold-start "unchecked" is never mistaken for a
 * definitive answer.
 */
export function resolvePendingUpdateState(
  value: PendingUpdateState | UpdateInfo | null,
): { state: UpdateLoadState; value: UpdateInfo | null } {
  if (value == null) return { state: "resolved", value: null };
  if ("status" in value) {
    if (value.status === "pending") {
      return { state: "resolved", value: value.update };
    }
    if (value.status === "absent") {
      return { state: "resolved", value: null };
    }
    return { state: "unchecked", value: null };
  }
  return { state: "resolved", value };
}

export interface UpdaterEventHandlers {
  onAvailable?: (info: UpdateInfo) => void;
  onCleared?: () => void;
}

/**
 * Host-provided updater event stream (desktop: Tauri `update:available` /
 * `update:cleared` events; web: typically absent). `subscribe` returns an
 * unsubscribe function; handlers must not fire after unsubscribe.
 */
export interface UpdaterBus {
  subscribe(handlers: UpdaterEventHandlers): () => void;
}
