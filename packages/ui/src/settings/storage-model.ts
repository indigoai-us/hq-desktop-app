/**
 * Settings › Storage selection model.
 *
 * Backup history is shown as age bands, newest first (Last 7 days, …, Older).
 * Deleting is a cutoff: "delete everything older than X". So the selection is
 * always a run of bands that ends at the oldest one. Checking a band checks
 * every older band; unchecking a band unchecks every newer one. The newest
 * band is never deletable, so recent history always survives.
 */

import type {
  CloudFileEventPayload,
  StorageOffloadResult,
  StorageOffloadStatus,
  StoragePruneRequest,
  StoragePruneResult,
} from "@hq/platform";

export interface StorageBand {
  id: string;
  label: string;
  /** Snapshot count (local) or old-version count (cloud). */
  count: number;
  bytes: number;
  /** ISO end of the band (newest edge), when the CLI reports it. */
  to?: string | null;
}

/** The newest band is kept so recent history can always be restored. */
export const PROTECTED_BAND_ID = "7d";

/** Age in days at the newest edge of each band after `id`. */
const BAND_AGE_DAYS: Record<string, number> = {
  "7d": 0,
  "30d": 7,
  "90d": 30,
  "365d": 90,
  older: 365,
};

export const UPDATE_HQ_CODE = "update-hq";

export function isProtectedBand(band: StorageBand, index: number): boolean {
  return index === 0 || band.id === PROTECTED_BAND_ID;
}

/**
 * Selection is the index of the newest selected band; every band at or after
 * it is selected. `null` means nothing is selected.
 */
export type BandCutoff = number | null;

export function isBandSelected(cutoff: BandCutoff, index: number): boolean {
  return cutoff !== null && index >= cutoff;
}

/** Apply a checkbox click on band `index`. */
export function toggleBand(
  bands: readonly StorageBand[],
  cutoff: BandCutoff,
  index: number,
): BandCutoff {
  const band = bands[index];
  if (!band || isProtectedBand(band, index)) return cutoff;
  if (isBandSelected(cutoff, index)) {
    // Unchecking keeps only the older bands selected.
    return index + 1 < bands.length ? index + 1 : null;
  }
  return index;
}

export function selectedBytes(
  bands: readonly StorageBand[],
  cutoff: BandCutoff,
): number {
  if (cutoff === null) return 0;
  return bands.slice(cutoff).reduce((sum, band) => sum + band.bytes, 0);
}

export function selectedCount(
  bands: readonly StorageBand[],
  cutoff: BandCutoff,
): number {
  if (cutoff === null) return 0;
  return bands.slice(cutoff).reduce((sum, band) => sum + band.count, 0);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The YYYY-MM-DD cutoff for `hq storage prune --*-before`: everything older
 * than the newest edge of the newest selected band.
 */
export function cutoffDate(
  bands: readonly StorageBand[],
  cutoff: BandCutoff,
  now: Date = new Date(),
): string | null {
  if (cutoff === null) return null;
  const band = bands[cutoff];
  if (!band) return null;
  if (band.to) {
    const parsed = new Date(band.to);
    if (Number.isFinite(parsed.getTime())) return isoDate(parsed);
  }
  const days = BAND_AGE_DAYS[band.id];
  if (days === undefined) return null;
  return isoDate(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));
}

/**
 * One prune call for local history and one per company, so a failure in one
 * company never blocks the others.
 */
export function pruneRequests(
  local: { bands: readonly StorageBand[]; cutoff: BandCutoff },
  cloud: ReadonlyArray<{
    company: string;
    bands: readonly StorageBand[];
    cutoff: BandCutoff;
  }>,
  now: Date = new Date(),
): StoragePruneRequest[] {
  const requests: StoragePruneRequest[] = [];
  const localBefore = cutoffDate(local.bands, local.cutoff, now);
  if (localBefore) requests.push({ localBefore });
  for (const entry of cloud) {
    const cloudBefore = cutoffDate(entry.bands, entry.cutoff, now);
    if (cloudBefore) requests.push({ cloudBefore, company: entry.company });
  }
  return requests;
}

/** Plain-language copy for a failed storage call. Never raw CLI text. */
export function storageErrorCopy(message: string | null | undefined): string {
  if (message && message.includes(UPDATE_HQ_CODE)) {
    return "Update HQ to manage storage.";
  }
  return "We couldn't read your backup sizes. Try again in a moment.";
}

/**
 * Bytes a prune frees (or would free, on a dry run). Local real runs report
 * the git dir size before and after; dry runs report an estimate.
 */
export function prunedBytes(r: StoragePruneResult): number {
  let total = 0;
  const local = r.local;
  if (local && local.available !== false) {
    if (r.dry_run) {
      total += local.est_bytes ?? 0;
    } else if (local.before && local.after) {
      total += Math.max(0, local.before.git_dir_bytes - local.after.git_dir_bytes);
    }
  }
  for (const c of r.cloud ?? []) total += c.deleted_bytes ?? 0;
  return total;
}

/** Tool bookmarks a dry run says prune will clear (0 when not reported). */
export function refsToRemove(r: StoragePruneResult): number {
  return r.local?.refs_to_remove ?? 0;
}

/** Plain copy for the confirm dialog about bookmarks other tools left. */
export function bookmarksCopy(count: number): string {
  if (count <= 0) return "";
  return count === 1
    ? "1 old bookmark other tools left behind will also be cleared."
    : `${count.toLocaleString()} old bookmarks other tools left behind will also be cleared.`;
}

export const CLOUD_ADMIN_ONLY_COPY = "Only company owners and admins can delete cloud history.";

/**
 * False only when the person is known to be neither owner nor admin of the
 * company. Unknown role: the CLI's permission error decides.
 */
export function canDeleteCloud(roles: ReadonlyMap<string, string>, company: string): boolean {
  const role = (roles.get(company) ?? "").trim().toLowerCase();
  return !role || role === "owner" || role === "admin";
}

/** Slug → role from `identity.listWorkspaces()` membership rows. */
export function rolesFromMemberships(rows: ReadonlyArray<Record<string, unknown>>): Map<string, string> {
  const roles = new Map<string, string>();
  for (const row of rows) {
    const slug = row.companySlug ?? row.slug;
    const role = row.role;
    if (typeof slug === "string" && typeof role === "string") roles.set(slug, role);
  }
  return roles;
}

/** True when a cloud prune error is the CLI's access-denied message. */
export function isPermissionError(message: string): boolean {
  return /access denied/i.test(message);
}

// --- Big files: move to HQ cloud ---------------------------------------------

/** Files over this size are "big" (CLI default `--min-size 50MB`). */
export const BIG_FILE_MB = 50;
/** Current files untouched this long move (CLI default `--idle-days 14`). */
export const IDLE_DAYS = 14;

export const OFFLOAD_CONFIRM_COPY =
  "These files will be stored in your HQ cloud. They'll still show in your HQ folder and download when you open them.";

/** Everything Big files could move right now. */
export function offloadCandidates(o: StorageOffloadStatus | null | undefined): {
  count: number;
  bytes: number;
} {
  if (!o) return { count: 0, bytes: 0 };
  return {
    count: (o.history_candidates?.count ?? 0) + (o.current_candidates?.count ?? 0),
    bytes: (o.history_candidates?.bytes ?? 0) + (o.current_candidates?.bytes ?? 0),
  };
}

/**
 * Space an offload frees (or would free, on a dry run). Falls back to the
 * moved size when the CLI leaves `freed_bytes` at 0 on a dry run.
 */
export function offloadFreedBytes(r: StorageOffloadResult): number {
  const history = r.history ?? { uploaded: 0, bytes: 0, freed_bytes: 0 };
  const current = r.current ?? { offloaded: [], freed_bytes: 0 };
  const currentMoved = (current.offloaded ?? []).reduce((s, f) => s + (f.bytes ?? 0), 0);
  const h = history.freed_bytes || (r.dry_run ? history.bytes ?? 0 : 0);
  const c = current.freed_bytes || (r.dry_run ? currentMoved : 0);
  return h + c;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** One plain line listing what an offload covers. */
export function offloadSummary(r: StorageOffloadResult): string {
  const parts: string[] = [];
  const copies = r.history?.uploaded ?? 0;
  const files = r.current?.offloaded?.length ?? 0;
  if (copies > 0) parts.push(`${plural(copies, "old copy", "old copies")} of big files in your backup history`);
  if (files > 0) parts.push(`${plural(files, "big file", "big files")} you haven't opened in ${IDLE_DAYS} days`);
  return parts.join(" and ");
}

/** Result line for failed files; empty when none failed. */
export function offloadErrorsCopy(r: StorageOffloadResult): string {
  const n = r.errors?.length ?? 0;
  if (n === 0) return "";
  return n === 1
    ? "1 file couldn't be moved. It's still on this Mac."
    : `${n.toLocaleString()} files couldn't be moved. They're still on this Mac.`;
}

/** Plain copy for a failed `.hqcloud` open. Never raw CLI text. */
export function cloudFileErrorCopy(code: string | null | undefined): string {
  switch (code) {
    case "offline":
      return "You're offline. Connect and try again.";
    case "no-access":
      return "You don't have access to this file in HQ cloud. Ask the person who shared it.";
    case UPDATE_HQ_CODE:
      return "Update HQ to open files stored in HQ cloud.";
    case "open-failed":
      return "It downloaded, but no app on this Mac could open it.";
    default:
      return "We couldn't download it. Try again in a moment.";
  }
}

/** Toast for each step of opening a `.hqcloud` placeholder. */
export function cloudFileToast(ev: CloudFileEventPayload): {
  title: string;
  detail: string;
  tone: "ok" | "err" | "neutral";
  progress: "indeterminate" | null;
  sticky: boolean;
} {
  const name = ev.name || "your file";
  if (ev.phase === "fetching") {
    return { title: `Downloading ${name}`, detail: "Getting it from HQ cloud.", tone: "neutral", progress: "indeterminate", sticky: true };
  }
  if (ev.phase === "opened") {
    return { title: `${name} is ready`, detail: "Opened it for you. It stays on this Mac while you use it.", tone: "ok", progress: null, sticky: false };
  }
  return { title: `Couldn't open ${name}`, detail: cloudFileErrorCopy(ev.error), tone: "err", progress: null, sticky: true };
}
