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
  StorageHoldingRef,
  StorageLocalPruneResult,
  StorageOffloadResult,
  StorageOffloadStatus,
  StoragePruneRequest,
  StoragePruneResult,
} from "@hq/platform";
import { thisComputerNoun } from "@hq/platform";
import { formatBytes } from "../common/sync-model.js";

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
 * Short local date and time for "freed by <time>", e.g. "Oct 10, 3:26 PM".
 * `null` when the CLI sent nothing usable.
 */
export function localTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Bytes a local prune freed right away: the CLI's figure, else the git dir delta. */
function localFreedNow(l: StorageLocalPruneResult): number {
  if (typeof l.freed_bytes === "number") return l.freed_bytes;
  if (l.before && l.after) return Math.max(0, l.before.git_dir_bytes - l.after.git_dir_bytes);
  return 0;
}

/**
 * Bytes the 24 h undo backup still holds. Older CLIs send only
 * `backup_ref` with the estimate, so the rest of the estimate is pending.
 */
function localPending(l: StorageLocalPruneResult): number {
  if (typeof l.pending_reclaim_bytes === "number") return l.pending_reclaim_bytes;
  if (l.backup_ref) return Math.max(0, (l.est_bytes ?? 0) - localFreedNow(l));
  return 0;
}

/**
 * Branches, tags or saved versions that keep a local prune from freeing
 * anything, or `null` when nothing holds it. A dry run reports them with an
 * estimate of 0; a real run refuses with `refused: "nothing_to_free"`.
 */
export function pruneHolders(r: StoragePruneResult): { count: number; refs: StorageHoldingRef[] } | null {
  const l = r.local;
  if (!l || l.available === false) return null;
  const refs = l.holding_refs ?? [];
  const count = l.holding_refs_count ?? refs.length;
  const held = l.refused === "nothing_to_free" || (r.dry_run && (l.est_bytes ?? 0) === 0 && count > 0);
  return held ? { count, refs } : null;
}

/** Plain copy when old history can't be freed yet. Never suggests deleting a stash. */
export function holdersCopy(count: number): string {
  if (count <= 0) return "Nothing can be freed yet. Older branches or saved versions still use this history.";
  return count === 1
    ? "Nothing can be freed yet. 1 older branch or saved version still uses this history."
    : `Nothing can be freed yet. ${count.toLocaleString()} older branches or saved versions still use this history.`;
}

/** Plain name for a holding ref, e.g. "Branch side", "Saved version v1". */
export function holderLabel(ref: StorageHoldingRef): string {
  const name = ref.name;
  if (name === "refs/stash") return "Changes set aside for later";
  if (name.startsWith("refs/heads/")) return `Branch ${name.slice("refs/heads/".length)}`;
  if (name.startsWith("refs/tags/")) return `Saved version ${name.slice("refs/tags/".length)}`;
  return name.replace(/^refs\//, "");
}

/**
 * Bytes a prune frees (or would free, on a dry run). A real local run counts
 * what was freed at once plus what the undo backup frees later.
 */
export function prunedBytes(r: StoragePruneResult): number {
  let total = 0;
  const local = r.local;
  if (local && local.available !== false && !local.refused) {
    total += r.dry_run ? local.est_bytes ?? 0 : localFreedNow(local) + localPending(local);
  }
  for (const c of r.cloud ?? []) total += c.deleted_bytes ?? 0;
  return total;
}

/** Latest `reclaim_after` among local results (dry or real). */
export function pruneReclaimAfter(results: readonly StoragePruneResult[]): string | null {
  let latest: string | null = null;
  for (const r of results) {
    const at = r.local?.reclaim_after;
    if (at && (!latest || Date.parse(at) > Date.parse(latest))) latest = at;
  }
  return latest;
}

/**
 * Result lines for real prunes. Never a "Freed" line for a refused or failed
 * local prune; space the undo backup still holds reads "will be freed by".
 * Cloud errors are added by the caller.
 */
export function pruneOutcome(
  results: readonly StoragePruneResult[],
  device: string = thisComputerNoun(),
): { lines: string[]; errors: string[] } {
  let freedNow = 0;
  let pending = 0;
  let removed = false;
  const notes: string[] = [];
  const errors: string[] = [];
  for (const r of results) {
    const l = r.local;
    if (l) {
      const holders = pruneHolders(r);
      if (holders) notes.push(holdersCopy(holders.count));
      else if (l.available === false && /free nothing/i.test(l.reason ?? "")) notes.push(holdersCopy(0));
      else if (l.available === false) errors.push(`${device}: some backups couldn't be deleted.`);
      else {
        removed = true;
        freedNow += localFreedNow(l);
        pending += localPending(l);
      }
    }
    for (const c of r.cloud ?? []) {
      if ((c.deleted_count ?? 0) > 0 || (c.deleted_bytes ?? 0) > 0) removed = true;
      freedNow += c.deleted_bytes ?? 0;
    }
  }
  const lines: string[] = [];
  if (removed) {
    const by = localTime(pruneReclaimAfter(results));
    lines.push(
      pending > 0 && by
        ? `Old backups removed. About ${formatBytes(freedNow + pending)} will be freed by ${by}.`
        : `Old backups removed. Freed ${formatBytes(freedNow)}.`,
    );
  }
  return { lines: [...lines, ...notes], errors };
}

/**
 * The delete confirm. Local backups keep a 24 h undo; deleted cloud versions
 * are gone at once.
 */
export function pruneConfirmCopy(opts: {
  parts: readonly string[];
  bytes: number;
  notes: readonly string[];
  local: boolean;
  cloud: boolean;
  reclaimAfter?: string | null;
}): string {
  const list = opts.parts.join(" and ");
  const by = opts.local ? localTime(opts.reclaimAfter) : null;
  const frees = `This frees about ${formatBytes(opts.bytes)}${by ? ` by ${by}` : ""}.`;
  const undo: string[] = [];
  if (opts.local) undo.push("You can undo this for 24 hours. After that, these old versions are gone for good.");
  if (opts.cloud) {
    undo.push(opts.local ? "Deleted cloud versions can't be restored." : "This can't be undone. You won't be able to restore these old versions.");
  }
  return [`This deletes ${list}.`, frees, ...opts.notes, ...undo].join(" ");
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
 * Whether the person may delete a company's old cloud versions. Fails
 * closed: the CLI's `can_delete` wins when present; otherwise only a known
 * owner or admin role allows it. Unknown role means no.
 */
export function canDeleteCloud(
  roles: ReadonlyMap<string, string>,
  company: string,
  cliCanDelete?: boolean | null,
): boolean {
  if (typeof cliCanDelete === "boolean") return cliCanDelete;
  const role = (roles.get(company) ?? "").trim().toLowerCase();
  return role === "owner" || role === "admin";
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

/** What happens to old copies in backup history. */
export const OFFLOAD_CONFIRM_COPY =
  "Old copies of big files in your backup history will be stored in your HQ cloud. You can still get any of them back.";

/** What happens to current files, said only when the CLI can move them. */
export const OFFLOAD_CURRENT_COPY =
  "Big files you haven't opened in a while still show in your HQ folder and download when you open them.";

/** Plain copy when the CLI says big files can't move (`available: false`). */
export function offloadUnavailableCopy(reason: string | null | undefined): string {
  if (reason && /update hq/i.test(reason)) return "Update HQ to move big files to the cloud.";
  return "Moving big files to the cloud isn't available yet.";
}

/** True when current files are offered: only when the CLI says it can move them. */
export function currentOffloadAvailable(o: StorageOffloadStatus | null | undefined): boolean {
  return o?.available !== false && o?.current_available === true;
}

/** What "Move to cloud" will actually move right now. */
export function offloadCandidates(o: StorageOffloadStatus | null | undefined): {
  count: number;
  bytes: number;
} {
  if (!o || o.available === false) return { count: 0, bytes: 0 };
  const withCurrent = currentOffloadAvailable(o);
  return {
    count: (o.history_candidates?.count ?? 0) + (withCurrent ? o.current_candidates?.count ?? 0 : 0),
    bytes: (o.history_candidates?.bytes ?? 0) + (withCurrent ? o.current_candidates?.bytes ?? 0 : 0),
  };
}

/** History copies a dry run would move: `candidates`, else `uploaded`. */
function historyPlanned(r: StorageOffloadResult): { count: number; bytes: number } {
  const h = r.history;
  if (!h || h.available === false) return { count: 0, bytes: 0 };
  return {
    count: h.candidates ?? h.uploaded ?? 0,
    bytes: h.candidate_bytes ?? (h.bytes || h.freed_bytes || 0),
  };
}

/** Current files in a result, ignored when the CLI marks them unavailable. */
function currentMoved(r: StorageOffloadResult): { count: number; bytes: number; freed: number } {
  const c = r.current;
  if (!c || c.available === false) return { count: 0, bytes: 0, freed: 0 };
  const files = c.offloaded ?? [];
  return {
    count: files.length,
    bytes: files.reduce((s, f) => s + (f.bytes ?? 0), 0),
    freed: c.freed_bytes ?? 0,
  };
}

/**
 * Space an offload frees, or would free on a dry run. A dry run uses the
 * candidate size; a real run only what the CLI says it freed.
 */
export function offloadFreedBytes(r: StorageOffloadResult): number {
  const current = currentMoved(r);
  if (r.dry_run) return historyPlanned(r).bytes + (current.freed || current.bytes);
  const h = r.history?.available === false ? 0 : r.history?.freed_bytes ?? 0;
  return h + current.freed;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** One plain line listing what a dry run would move; empty when nothing. */
export function offloadSummary(r: StorageOffloadResult): string {
  const parts: string[] = [];
  const copies = historyPlanned(r).count;
  const files = currentMoved(r).count;
  if (copies > 0) parts.push(`${plural(copies, "old copy", "old copies")} of big files in your backup history`);
  if (files > 0) parts.push(`${plural(files, "big file", "big files")} you haven't opened in ${IDLE_DAYS} days`);
  return parts.join(" and ");
}

/** True when a dry run includes current files (so their copy applies). */
export function offloadIncludesCurrent(r: StorageOffloadResult): boolean {
  return currentMoved(r).count > 0;
}

/**
 * Why a preview can't go ahead, in plain words, or `null` when it can.
 * History copies are the only thing the CLI moves today, so an unavailable
 * history half with no current files is "not available", never "0 B".
 */
export function offloadPreviewBlocker(r: StorageOffloadResult): string | null {
  if (r.history?.available === false && currentMoved(r).count === 0) {
    return offloadUnavailableCopy(r.history.reason);
  }
  if (!offloadSummary(r)) return "Nothing to move right now.";
  return null;
}

/** Result line for failed items; empty when none failed. */
export function offloadErrorsCopy(r: StorageOffloadResult, device: string = thisComputerNoun()): string {
  const n = r.errors?.length ?? 0;
  if (n === 0) return "";
  return n === 1
    ? `1 file couldn't be moved. It's still on ${device}.`
    : `${n.toLocaleString()} files couldn't be moved. They're still on ${device}.`;
}

/** Plain result of a real offload. `ok: false` lines read as a problem. */
export function offloadOutcome(
  r: StorageOffloadResult,
  device: string = thisComputerNoun(),
): { ok: boolean; lines: string[] } {
  const freed = offloadFreedBytes(r);
  const errors = r.errors ?? [];
  if (r.history?.available === false && currentMoved(r).count === 0) {
    return { ok: false, lines: [offloadUnavailableCopy(r.history.reason)] };
  }
  if (errors.length > 0) {
    const needsUpdate = errors.some((e) => typeof e === "string" && /update hq/i.test(e));
    if (freed > 0) {
      return { ok: false, lines: [`Moved some files to HQ cloud. Freed ${formatBytes(freed)}.`, offloadErrorsCopy(r, device)] };
    }
    return {
      ok: false,
      lines: [
        `No space was freed yet. Your files are still on ${device}.`,
        needsUpdate ? "Update HQ, then try again." : "Try again in a moment.",
      ],
    };
  }
  const h = r.history?.available === false ? null : r.history;
  const current = currentMoved(r);
  const moved = (h?.uploaded ?? 0) + current.count;
  if (moved === 0 && freed === 0) return { ok: true, lines: ["Nothing needed moving."] };
  const movedBytes = (h?.bytes ?? 0) + current.bytes;
  const what =
    current.count === 0 ? plural(moved, "old copy", "old copies") : plural(moved, "file", "files");
  const head = movedBytes > 0 ? `Moved ${what} (${formatBytes(movedBytes)}) to HQ cloud.` : `Moved ${what} to HQ cloud.`;
  const by = localTime(h?.reclaim_after);
  const pending = h?.pending_reclaim_bytes ?? 0;
  if (freed > 0) {
    const lines = [`${head} Freed ${formatBytes(freed)} on ${device}.`];
    if (pending > 0 && by) lines.push(`About ${formatBytes(pending)} more will be freed by ${by}.`);
    return { ok: true, lines };
  }
  return { ok: true, lines: [by ? `${head} Space is freed by ${by}.` : `${head} The space on ${device} is freed shortly.`] };
}

/** Plain copy for a failed `.hqcloud` open. Never raw CLI text. */
export function cloudFileErrorCopy(code: string | null | undefined, device: string = thisComputerNoun()): string {
  switch (code) {
    case "offline":
      return "You're offline. Connect and try again.";
    case "no-access":
      return "You don't have access to this file in HQ cloud. Ask the person who shared it.";
    case "orphaned":
      return "A teammate deleted this file. It's no longer in your team's cloud.";
    case "not-member":
      return "You're no longer a member of this company, so this file can't be downloaded.";
    case UPDATE_HQ_CODE:
      return "Update HQ to open files stored in HQ cloud.";
    case "open-failed":
      return `It downloaded, but no app on ${device} could open it.`;
    default:
      return "We couldn't download it. Try again in a moment.";
  }
}

/** Toast key: the full placeholder path, so same-named files stay apart. */
export function cloudFileToastKey(ev: CloudFileEventPayload): string {
  return `cloud-file:${ev.path || ev.name}`;
}

/** Toast for each step of opening a `.hqcloud` placeholder. */
export function cloudFileToast(
  ev: CloudFileEventPayload,
  device: string = thisComputerNoun(),
): {
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
    return { title: `${name} is ready`, detail: `Opened it for you. It stays on ${device} while you use it.`, tone: "ok", progress: null, sticky: false };
  }
  return { title: `Couldn't open ${name}`, detail: cloudFileErrorCopy(ev.error, device), tone: "err", progress: null, sticky: true };
}
