/**
 * Model for the titlebar "Finishing setup" chip (install-flow-rethink US-005).
 *
 * The native background install queue reports its progress as a
 * `QueueStatus` (camelCase over the wire) both from
 * `get_install_queue_status` and on the `install-queue:progress` event. The
 * chip never blocks anything: it only names the item running now and offers a
 * Retry when an item needs attention.
 */

import type { SyncUnlistenFn } from "./sync-events.js";

export const INSTALL_QUEUE_PROGRESS_EVENT = "install-queue:progress";

export type InstallQueueState = "idle" | "running" | "attention" | "complete";

export interface InstallQueueStatus {
  state: InstallQueueState;
  /** Chip label of the item running now, if any. */
  current: string | null;
  currentId: string | null;
  /** Items done or skipped. */
  done: number;
  total: number;
  /** Ids of the items that failed and need attention. */
  failed: string[];
}

/**
 * The host seam the chip reads from. The app builds it over Tauri `invoke`
 * and `listen`; `packages/ui` stays platform-agnostic.
 */
export interface InstallQueueHost {
  getStatus(): Promise<unknown>;
  retry(): Promise<unknown>;
  listen(
    event: string,
    handler: (event: { payload?: unknown }) => void,
  ): Promise<SyncUnlistenFn>;
}

const STATES: readonly InstallQueueState[] = ["idle", "running", "attention", "complete"];

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/** Parse a wire payload. Returns null for anything that is not a status. */
export function parseInstallQueueStatus(value: unknown): InstallQueueStatus | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.state !== "string" || !STATES.includes(raw.state as InstallQueueState)) {
    return null;
  }
  return {
    state: raw.state as InstallQueueState,
    current: typeof raw.current === "string" && raw.current ? raw.current : null,
    currentId: typeof raw.currentId === "string" && raw.currentId ? raw.currentId : null,
    done: count(raw.done),
    total: count(raw.total),
    failed: Array.isArray(raw.failed)
      ? raw.failed.filter((id): id is string => typeof id === "string")
      : [],
  };
}

/** The chip shows only while the queue is working or needs attention. */
export function finishingSetupVisible(status: InstallQueueStatus | null): boolean {
  return status?.state === "running" || status?.state === "attention";
}

/** Plain-language chip text. Never includes raw error output. */
export function finishingSetupLabel(status: InstallQueueStatus): string {
  if (status.state === "attention") {
    const n = Math.max(status.failed.length, 1);
    return `Finishing setup: ${n} ${n === 1 ? "item needs" : "items need"} attention`;
  }
  const progress = status.total > 0 ? ` (${Math.min(status.done + 1, status.total)} of ${status.total})` : "";
  return status.current
    ? `Finishing setup: ${status.current}${progress}`
    : `Finishing setup${progress}`;
}

/** Build the host over the app's Tauri `invoke` and `listen`. */
export function createInstallQueueHost(
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
  listen: InstallQueueHost["listen"],
): InstallQueueHost {
  return {
    getStatus: () => invoke("get_install_queue_status"),
    retry: () => invoke("retry_install_queue"),
    listen,
  };
}
