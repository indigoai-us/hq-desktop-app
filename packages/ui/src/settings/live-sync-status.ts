/**
 * Read-only view of the v1 HQ Sync journal / daemon.
 * Desktop observes the on-disk contract. Web never reads a machine journal.
 */

import type { AdapterResult, PlatformAdapter, SyncStatus } from "@hq/platform";
import type { SyncState } from "../common/sync-model.js";

export interface LiveSyncStatus {
  lastSyncAt: string | null;
  pendingFiles: number;
  conflicts: number;
  daemonRunning: boolean;
  source: string;
  hqFolderPath: string | null;
}

export const EMPTY_LIVE_SYNC: LiveSyncStatus = {
  lastSyncAt: null,
  pendingFiles: 0,
  conflicts: 0,
  daemonRunning: false,
  source: "none",
  hqFolderPath: null,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseLiveSyncStatus(raw: unknown): LiveSyncStatus {
  const rec = asRecord(raw);
  if (!rec) return { ...EMPTY_LIVE_SYNC };
  const last =
    typeof rec.lastSyncAt === "string" && rec.lastSyncAt.trim()
      ? rec.lastSyncAt.trim()
      : null;
  const pending =
    typeof rec.pendingFiles === "number" && Number.isFinite(rec.pendingFiles)
      ? Math.max(0, rec.pendingFiles)
      : 0;
  const conflicts =
    typeof rec.conflicts === "number" && Number.isFinite(rec.conflicts)
      ? Math.max(0, rec.conflicts)
      : 0;
  const daemon = rec.daemonRunning === true || rec.running === true;
  const source =
    typeof rec.source === "string" && rec.source.trim()
      ? rec.source.trim()
      : "none";
  const folder =
    typeof rec.hqFolderPath === "string" && rec.hqFolderPath.trim()
      ? rec.hqFolderPath.trim()
      : typeof rec.watchPath === "string" && rec.watchPath.trim()
        ? rec.watchPath.trim()
        : null;
  return {
    lastSyncAt: last,
    pendingFiles: pending,
    conflicts,
    daemonRunning: daemon,
    source,
    hqFolderPath: folder,
  };
}

export function syncStateFromLive(status: LiveSyncStatus): SyncState {
  if (status.conflicts > 0) return "conflict";
  return "idle";
}

export function lastSyncLabelFromLive(
  status: LiveSyncStatus,
  nowMs: number = Date.now(),
): string | null {
  if (!status.lastSyncAt) return null;
  const then = Date.parse(status.lastSyncAt);
  if (!Number.isFinite(then)) return status.lastSyncAt;
  const elapsed = Math.max(0, nowMs - then);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Desktop adapter only. Web (`canSync: false`) returns the empty observe state. */
export async function readLiveSyncStatus(
  adapter: PlatformAdapter | null | undefined,
): Promise<LiveSyncStatus> {
  if (!adapter?.isAvailable("canSync")) return { ...EMPTY_LIVE_SYNC };
  const result: AdapterResult<SyncStatus> = await adapter.sync.getSyncStatus();
  if (result.ok) return parseLiveSyncStatus(result.value);
  return { ...EMPTY_LIVE_SYNC };
}
