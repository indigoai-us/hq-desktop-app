/**
 * Settings › Storage selection model.
 *
 * Backup history is shown as age bands, newest first (Last 7 days, …, Older).
 * Deleting is a cutoff: "delete everything older than X". So the selection is
 * always a run of bands that ends at the oldest one. Checking a band checks
 * every older band; unchecking a band unchecks every newer one. The newest
 * band is never deletable, so recent history always survives.
 */

import type { StoragePruneRequest, StoragePruneResult } from "@hq/platform";

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

/** True when other refs (tags, stash, tool markers) keep old local history. */
export function hasRetainedRefs(r: StoragePruneResult): boolean {
  return (r.local?.retained_refs ?? 0) > 0;
}
