/**
 * Read-only view of the v1 HQ Sync journal / daemon.
 * Desktop observes the on-disk contract. Web never reads a machine journal.
 */

import {
  approvedPlanUpgradeUrl,
  type AdapterResult,
  type PlatformAdapter,
  type SyncStatus,
} from "@hq/platform";
import type { SyncState } from "../common/sync-model.js";

/**
 * A company whose new files are not uploading because it is over a plan
 * limit (hard-stop-readiness US-019). Written by the native sync journal.
 */
export interface UploadsPausedCompany {
  company: string;
  /** Approved hq-pro upgrade link, or null when none came with the notice. */
  upgradeUrl: string | null;
}

export interface LiveSyncStatus {
  lastSyncAt: string | null;
  pendingFiles: number;
  conflicts: number;
  daemonRunning: boolean;
  source: string;
  hqFolderPath: string | null;
  /** Companies whose uploads are paused by a plan limit. Absent = none. */
  uploadsPaused?: UploadsPausedCompany[];
}

export const EMPTY_LIVE_SYNC: LiveSyncStatus = {
  lastSyncAt: null,
  pendingFiles: 0,
  conflicts: 0,
  daemonRunning: false,
  source: "none",
  hqFolderPath: null,
  uploadsPaused: [],
};

/** Parse the journal's `uploadsPaused` list; drops malformed rows. */
export function parseUploadsPaused(raw: unknown): UploadsPausedCompany[] {
  if (!Array.isArray(raw)) return [];
  const rows: UploadsPausedCompany[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const rec = asRecord(entry);
    const company =
      rec && typeof rec.company === "string" ? rec.company.trim() : "";
    if (!company || seen.has(company)) continue;
    seen.add(company);
    rows.push({ company, upgradeUrl: approvedPlanUpgradeUrl(rec?.upgradeUrl) });
  }
  return rows;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseLiveSyncStatus(raw: unknown): LiveSyncStatus {
  const rec = asRecord(raw);
  if (!rec) return { ...EMPTY_LIVE_SYNC, uploadsPaused: [] };
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
    uploadsPaused: parseUploadsPaused(rec.uploadsPaused),
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
  if (!adapter?.isAvailable("canSync")) {
    return { ...EMPTY_LIVE_SYNC, uploadsPaused: [] };
  }
  const result: AdapterResult<SyncStatus> = await adapter.sync.getSyncStatus();
  if (result.ok) return parseLiveSyncStatus(result.value);
  return { ...EMPTY_LIVE_SYNC, uploadsPaused: [] };
}
