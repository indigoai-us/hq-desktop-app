/**
 * Pure model for the V4 titlebar Core popover (US-016).
 *
 * Derives conflict header copy, drift / update pills, pack rows, and
 * pause-gated Sync Now behaviour from plain inputs — no Svelte / Tauri.
 *
 * PL-01/PL-02 added the sync status header and the four sync trouble notices
 * the retired tray popover used to own.
 */

import type { Issue } from "./copy-prompts.js";

// ── Inputs ───────────────────────────────────────────────────────────────────

export type CorePopoverConflictStatus =
  "pending" | "resolving" | "resolved" | "error";

export interface CorePopoverConflict {
  path: string;
  status: CorePopoverConflictStatus;
  error?: string;
}

export interface CorePopoverPack {
  name: string;
  version?: string | null;
  /**
   * Optional server-provided human name (forward-compat). Absent on today's
   * `hq packs list --json` rows and on older `~/.hq/sync-packs-cache.json`
   * snapshots — the UI derives a friendly name via `packDisplayName`.
   */
  displayName?: string | null;
  /** When true, row shows a NEW badge (D-08 fixtures). */
  isNew?: boolean;
}

export interface CorePopoverCoreState {
  /** Local hq-core version (from get_hq_version / core state). */
  hqVersion?: string | null;
  /** USER-EDIT drift count (THE drift number). */
  driftCount: number;
  /** True when local trails target OR drift is present. */
  needsRestore: boolean;
  channel?: "release" | "staging" | null;
}

export interface BuildCorePopoverInput {
  conflicts?: readonly CorePopoverConflict[];
  /** Epoch-ms of the newest conflict for "· 2m ago" header suffix. */
  conflictUpdatedAtMs?: number | null;
  core?: CorePopoverCoreState | null;
  appVersion?: string | null;
  updateAvailable?: boolean;
  packs?: readonly CorePopoverPack[];
  /** True while the first pack snapshot is still in flight. */
  packsLoading?: boolean;
  cloudPaused?: boolean;
  packsExpanded?: boolean;
  /** Wall clock for ago labels (tests inject). */
  now?: number;
  /**
   * True while the popover's version read is still in flight. "Not yet
   * checked" must never render as "not detected" — the checking state gets
   * its own neutral label/pill until the read actually resolves.
   */
  coreChecking?: boolean;
  /** Reduced sync phase for the status header (PL-01). */
  syncState?: string | null;
  /** Ago label for "Last sync · …" (PL-01). */
  lastSyncLabel?: string | null;
  /** Live caption while a run is in flight (PL-01). */
  syncCaption?: string | null;
  /** Sync trouble inputs for the notice rows (PL-02). */
  notices?: BuildCoreNoticeRowsInput;
}

// ── Outputs ──────────────────────────────────────────────────────────────────

export interface CorePopoverConflictRow {
  path: string;
  fileName: string;
  companyPath: string;
  status: CorePopoverConflictStatus;
  error?: string;
  /** Primary actions disabled while resolving. */
  actionsDisabled: boolean;
}

export interface CorePopoverViewModel {
  /** Unresolved conflict rows for the rescue card (empty → hide card). */
  conflictRows: CorePopoverConflictRow[];
  /** "N conflicts need you" — empty string when no conflicts. */
  conflictHeader: string;
  conflictCount: number;
  hqVersionLabel: string;
  /** False when no local hq-core install was detected (version unreadable). */
  coreDetected: boolean;
  /** Uppercase pill: "NO DRIFT" / "N drifted" / "NOT CHECKED" (undetected). */
  driftPill: string;
  /** 'ok' | 'warn' | 'neutral' — drives pill color. */
  driftPillTone: "ok" | "warn" | "neutral";
  driftCount: number;
  /** Drift count is clickable when > 0. */
  driftOpenable: boolean;
  showRestore: boolean;
  appVersionLabel: string;
  updateAvailable: boolean;
  packs: CorePopoverPack[];
  packsExpanded: boolean;
  packsSummary: string;
  packsLoading: boolean;
  cloudPaused: boolean;
  /** Shown while Cloud is off. */
  pausedNotice: string | null;
  /** Sync Now is a no-op while paused. */
  syncNowAllowed: boolean;
  /** Status header: state word, last-sync line, live caption (PL-01). */
  syncHeader: CorePopoverSyncHeader;
  /** Sync trouble rows, in tray-popover order (PL-02). */
  notices: CoreNoticeRow[];
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function conflictFileName(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return path;
  const parts = trimmed.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? trimmed;
}

/** Parent path under HQ (filename stripped) — company / personal path. */
export function conflictCompanyPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.includes("/") && !trimmed.includes("\\")) return "HQ root";
  const normalized = trimmed.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "HQ root";
  return normalized.slice(0, idx);
}

export function conflictHeaderLabel(
  count: number,
  agoLabel?: string | null,
): string {
  const n = Math.max(0, Math.floor(count));
  if (n <= 0) return "";
  const base = n === 1 ? "1 conflict needs you" : `${n} conflicts need you`;
  const ago = (agoLabel ?? "").trim();
  return ago ? `${base} · ${ago}` : base;
}

/** Relative ago label for conflict header (e.g. "2m ago"). */
export function conflictAgoLabel(
  updatedAtMs?: number | null,
  now: number = Date.now(),
): string {
  if (
    updatedAtMs == null ||
    !Number.isFinite(updatedAtMs) ||
    updatedAtMs <= 0
  ) {
    return "just now";
  }
  const delta = Math.max(0, now - updatedAtMs);
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function driftPillLabel(
  count: number,
  coreDetected: boolean = true,
  checking: boolean = false,
): string {
  // A check still in flight is neither healthy nor undetected.
  if (checking && !coreDetected) return "CHECKING";
  // G6: "HQ core not detected" must never pair with a green NO DRIFT — an
  // undetected core was never checked, so the pill reads neutral instead.
  if (!coreDetected) return "NOT CHECKED";
  const n = Math.max(0, Math.floor(count));
  return n > 0 ? `${n} drifted` : "NO DRIFT";
}

export function driftPillTone(
  count: number,
  coreDetected: boolean = true,
): "ok" | "warn" | "neutral" {
  if (!coreDetected) return "neutral";
  return Math.max(0, Math.floor(count)) > 0 ? "warn" : "ok";
}

/**
 * Titlebar Core pill dot tone (G7): amber whenever a conflict / attention item
 * is pending; green only when healthy.
 */
export function corePillDotTone(input: {
  conflictCount?: number;
  syncState?: string | null;
  driftCount?: number;
  cloudPaused?: boolean;
  /** PL-01: manifest / cloud trouble also lights the pill. */
  manifestError?: string | null;
  cloudReachable?: boolean;
}): "ok" | "warn" | "active" {
  if ((input.conflictCount ?? 0) > 0) return "warn";
  const s = (input.syncState ?? "").toLowerCase();
  if (s === "conflict" || s === "error" || s === "auth-error") return "warn";
  if ((input.driftCount ?? 0) > 0) return "warn";
  if (input.cloudPaused) return "warn";
  if ((input.manifestError ?? "").trim()) return "warn";
  if (input.cloudReachable === false) return "warn";
  // A healthy run in flight is not trouble — it gets its own quiet tone so the
  // pill reads as "something is happening", never as "something is wrong".
  if (s === "syncing") return "active";
  return "ok";
}

export function coreNeedsRestore(
  versionBehind: boolean,
  driftCount: number,
): boolean {
  return Boolean(versionBehind) || Math.max(0, Math.floor(driftCount)) > 0;
}

export function hqVersionLabel(
  version: string | null | undefined,
  checking: boolean = false,
): string {
  if (version && version.trim()) return `HQ core v${version.trim()}`;
  // Only claim "not detected" after a check actually resolved without a
  // version; while the read is in flight the row stays neutral.
  return checking ? "Checking HQ core\u2026" : "HQ core not detected";
}

/** Keep the independently detected CLI version out of Core health UI. */
export function detectedCoreVersion(versions: {
  core?: unknown;
  cli?: unknown;
}): string | null {
  return typeof versions.core === "string" && versions.core.trim()
    ? versions.core
    : null;
}

export function appVersionLabel(version: string | null | undefined): string {
  if (version && version.trim()) return `Desktop app v${version.trim()}`;
  return "Desktop app";
}

export function packsSummaryLabel(
  count: number,
  loading: boolean = false,
): string {
  const n = Math.max(0, Math.floor(count));
  if (loading && n === 0) return "Loading…";
  if (n === 0) return "No packs installed";
  return n === 1 ? "1 pack installed" : `${n} packs installed`;
}

interface PackagesViewWire {
  packs?: {
    installed?: unknown;
  };
}

function installedPackRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const packs = (raw as PackagesViewWire).packs;
  if (!packs || typeof packs !== "object") return [];
  const installed = (packs as { installed?: unknown }).installed;
  return Array.isArray(installed) ? installed : [];
}

/**
 * Parse the installed-pack list from either adapter wire shape:
 * a flat array, or `{ packs: { installed: [...] } }`.
 */
export function parseInstalledPacks(raw: unknown): CorePopoverPack[] {
  const packs: CorePopoverPack[] = [];
  for (const row of installedPackRows(raw)) {
    if (!row || typeof row !== "object") continue;
    const rec = row as {
      name?: unknown;
      version?: unknown;
      displayName?: unknown;
      title?: unknown;
    };
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name) continue;
    const version = typeof rec.version === "string" ? rec.version : null;
    const hosted =
      typeof rec.displayName === "string"
        ? rec.displayName
        : typeof rec.title === "string"
          ? rec.title
          : undefined;
    if (hosted !== undefined) {
      packs.push({ name, version, displayName: hosted });
    } else {
      packs.push({ name, version });
    }
  }
  return packs;
}

export const CLOUD_PAUSED_NOTICE =
  "Cloud is off — sync is paused on this device. Turn Cloud on to resume.";

export function isSyncNowAllowed(cloudPaused: boolean): boolean {
  return !cloudPaused;
}

// ── View model ───────────────────────────────────────────────────────────────

/**
 * Build the Core popover view-model from plain inputs.
 *
 * Conflicts with status `resolved` are filtered out so the card clears as
 * rows resolve. Pending/resolving/error rows stay visible.
 */
export function buildCorePopoverViewModel(
  input: BuildCorePopoverInput = {},
): CorePopoverViewModel {
  const rawConflicts = input.conflicts ?? [];
  const active = rawConflicts.filter((c) => c.status !== "resolved");
  const conflictRows: CorePopoverConflictRow[] = active.map((c) => ({
    path: c.path,
    fileName: conflictFileName(c.path),
    companyPath: conflictCompanyPath(c.path),
    status: c.status,
    error: c.error,
    actionsDisabled: c.status === "resolving",
  }));
  const conflictCount = conflictRows.length;
  const ago =
    input.conflictUpdatedAtMs != null && conflictCount > 0
      ? conflictAgoLabel(input.conflictUpdatedAtMs, input.now ?? Date.now())
      : null;

  const core = input.core ?? null;
  const driftCount = Math.max(0, Math.floor(core?.driftCount ?? 0));
  const coreDetected = Boolean(core?.hqVersion && core.hqVersion.trim());
  // Checking is only meaningful until a version is known.
  const coreChecking = Boolean(input.coreChecking) && !coreDetected;
  const packs = [...(input.packs ?? [])];
  const packsLoading = Boolean(input.packsLoading) && packs.length === 0;
  const cloudPaused = Boolean(input.cloudPaused);

  return {
    conflictRows,
    conflictHeader: conflictHeaderLabel(conflictCount, ago),
    conflictCount,
    hqVersionLabel: hqVersionLabel(core?.hqVersion, coreChecking),
    coreDetected,
    driftPill: driftPillLabel(driftCount, coreDetected, coreChecking),
    driftPillTone: driftPillTone(driftCount, coreDetected),
    driftCount,
    driftOpenable: driftCount > 0,
    showRestore: Boolean(core?.needsRestore),
    appVersionLabel: appVersionLabel(input.appVersion),
    updateAvailable: Boolean(input.updateAvailable),
    packs,
    packsExpanded: Boolean(input.packsExpanded),
    packsSummary: packsSummaryLabel(packs.length, packsLoading),
    packsLoading,
    cloudPaused,
    pausedNotice: cloudPaused ? CLOUD_PAUSED_NOTICE : null,
    syncNowAllowed: isSyncNowAllowed(cloudPaused),
    syncHeader: buildCoreSyncHeader({
      syncState: input.syncState,
      lastSyncLabel: input.lastSyncLabel,
      syncCaption: input.syncCaption,
      // The journal count (from `notices`) is authoritative when the caller
      // supplies one: a conflict recorded on disk is real even when this
      // session's event stream has not replayed it.
      conflictCount: Math.max(
        conflictCount,
        input.notices?.conflictCount ?? 0,
      ),
    }),
    notices: buildCoreNoticeRows({
      syncState: input.syncState,
      conflictCount,
      ...(input.notices ?? {}),
    }),
  };
}

// ── Visual-QA fixtures (D-08) ────────────────────────────────────────────────

export const CORE_POPOVER_FIXTURE_CONFLICTS: CorePopoverConflict[] = [
  {
    path: "companies/indigo/knowledge/pricing-notes.md",
    status: "pending",
  },
];

export const CORE_POPOVER_FIXTURE_PACKS: CorePopoverPack[] = [
  { name: "engineering", version: "1.4.0" },
  { name: "impeccable", version: "0.9.2", isNew: true },
  { name: "gstack", version: "2.1.0" },
  { name: "pocock-skills", version: "0.3.1" },
];

/** Designed healthy core row for the D-08 popover ("HQ core vX · NO DRIFT"). */
export const CORE_POPOVER_FIXTURE_CORE: CorePopoverCoreState = {
  hqVersion: "0.10.43",
  driftCount: 0,
  needsRestore: false,
  channel: "release",
};

/** Fixture input: conflicts + update available + 4 packs (one NEW) + paused. */
export function corePopoverFixtureInput(
  overrides: Partial<BuildCorePopoverInput> = {},
): BuildCorePopoverInput {
  return {
    conflicts: CORE_POPOVER_FIXTURE_CONFLICTS,
    conflictUpdatedAtMs: Date.now() - 3 * 60_000,
    updateAvailable: true,
    packs: CORE_POPOVER_FIXTURE_PACKS,
    cloudPaused: true,
    packsExpanded: true,
    appVersion: "0.10.41",
    core: { ...CORE_POPOVER_FIXTURE_CORE },
    ...overrides,
  };
}

// ── Sync status header (PL-01) ───────────────────────────────────────────────

/**
 * Sync phases the Core popover header speaks about.
 *
 * Deliberately a superset union of `SyncState` (common/sync-model) and
 * `SyncPhase` (home/sync-status) so the popover can be fed by either reducer
 * without the caller mapping first. Unknown strings fall back to the healthy
 * word, matching the old tray popover's `else` branch.
 */
export type CoreSyncPhase =
  | "idle"
  | "syncing"
  | "conflict"
  | "error"
  | "auth-error"
  | "setup-needed";

/** Header tone. `active` is the in-flight blue; `warn` is the amber already
 *  used by the drift pill and conflict card. No new colours. */
export type CoreSyncTone = "ok" | "warn" | "active";

/**
 * State word. Copy is verbatim from the retired tray popover's `statusTitle`
 * (deleted in PL-07), carried over so the relocated surface never changed what
 * a sync is called mid-flight.
 */
export function syncStateWord(phase: string | null | undefined): string {
  switch ((phase ?? "").toLowerCase()) {
    case "syncing":
      return "Syncing";
    case "auth-error":
      return "Sign in required";
    case "conflict":
      return "Sync paused";
    case "error":
      return "Needs attention";
    default:
      return "All synced";
  }
}

export function syncStateTone(phase: string | null | undefined): CoreSyncTone {
  switch ((phase ?? "").toLowerCase()) {
    case "syncing":
      return "active";
    case "auth-error":
    case "conflict":
    case "error":
      return "warn";
    default:
      return "ok";
  }
}

/**
 * "Last sync · 3m ago" / "Last sync · never".
 *
 * The ago label itself is `lastSyncLabelFromLive` in the shell — this only
 * frames it, so there is one place that decides the word "never".
 */
export function lastSyncLine(label: string | null | undefined): string {
  const trimmed = (label ?? "").trim();
  return `Last sync · ${trimmed || "never"}`;
}

export interface CorePopoverSyncHeader {
  /** "All synced" / "Syncing" / "Sync paused" / … */
  stateWord: string;
  tone: CoreSyncTone;
  /** Always present: "Last sync · …". */
  lastSyncLine: string;
  /** Live per-run caption, only while syncing. Null otherwise. */
  caption: string | null;
  syncing: boolean;
}

export interface BuildCoreSyncHeaderInput {
  /** Reduced phase — `syncStateFromLive`, or the richer event-stream phase. */
  syncState?: string | null;
  /** Ago label from `lastSyncLabelFromLive`. Null → "never". */
  lastSyncLabel?: string | null;
  /** Live caption while syncing (`syncStatusLabel(...).detail` in the shell). */
  syncCaption?: string | null;
  /** Unresolved conflicts. > 0 forces "Sync paused" on an otherwise idle read:
   *  a journal that reports conflicts is not "All synced", whatever the
   *  event-stream phase says. A run in flight still wins — it is more recent. */
  conflictCount?: number;
}

export function buildCoreSyncHeader(
  input: BuildCoreSyncHeaderInput = {},
): CorePopoverSyncHeader {
  const raw = (input.syncState ?? "idle").toLowerCase();
  const conflicts = Math.max(0, Math.floor(input.conflictCount ?? 0));
  const phase =
    raw === "syncing" || raw === "auth-error" || raw === "error"
      ? raw
      : conflicts > 0
        ? "conflict"
        : raw;
  const syncing = phase === "syncing";
  const caption = (input.syncCaption ?? "").trim();
  return {
    stateWord: syncStateWord(phase),
    tone: syncStateTone(phase),
    lastSyncLine: lastSyncLine(input.lastSyncLabel),
    caption: syncing && caption ? caption : null,
    syncing,
  };
}

// ── Sync trouble notices (PL-02) ─────────────────────────────────────────────

export type CoreNoticeKind =
  | "conflict"
  | "sync-failed"
  | "manifest-error"
  | "cloud-unreachable";

export interface CoreNoticeRow {
  kind: CoreNoticeKind;
  /** Glyph tone — `alert` for blocking trouble, `warn` for degraded. */
  tone: "alert" | "warn";
  title: string;
  body: string;
  /** Raw error for the row `title=` tooltip. Already sanitized by the caller. */
  detail: string | null;
  /** Copy-prompt button label. */
  copyLabel: string;
  /** Open-in-Claude-Code label; null → the row is copy-only. */
  openLabel: string | null;
  /** Prompt descriptor handed to CopyPromptButton / OpenIssueInClaudeCode. */
  issue: Issue;
}

export interface BuildCoreNoticeRowsInput {
  syncState?: string | null;
  conflictCount?: number;
  conflictCompany?: string | null;
  /** Message behind an `error` phase. Empty → no sync-failed row (matches
   *  the tray popover, which required `errorMessage` to render it). */
  errorMessage?: string | null;
  errorCompany?: string | null;
  /** Non-null → companies/manifest.yaml could not be read. */
  manifestError?: string | null;
  /** False → the cloud listing fell back to local folders. */
  cloudReachable?: boolean;
  /** Cloud error, ALREADY passed through `sanitizeVisibleIdentifiers`. */
  cloudError?: string | null;
}

export function conflictNoticeBody(count: number): string {
  const n = Math.max(0, Math.floor(count));
  if (n <= 0) {
    return "A file changed in two places. Resolve in Claude Code, then Sync again.";
  }
  return `${n} file${n === 1 ? "" : "s"} changed in two places. Resolve in Claude Code, then Sync again.`;
}

/**
 * The four trouble rows, in the same order the tray popover rendered them.
 *
 * Each row owns its copy AND its prompt payload, so a row can never show one
 * problem and hand Claude Code another.
 */
export function buildCoreNoticeRows(
  input: BuildCoreNoticeRowsInput = {},
): CoreNoticeRow[] {
  const rows: CoreNoticeRow[] = [];
  const phase = (input.syncState ?? "").toLowerCase();
  const conflictCount = Math.max(0, Math.floor(input.conflictCount ?? 0));
  const conflictCompany = input.conflictCompany ?? "";
  const errorMessage = (input.errorMessage ?? "").trim();

  if (phase === "conflict" || conflictCount > 0) {
    rows.push({
      kind: "conflict",
      tone: "alert",
      title: "Sync paused",
      body: conflictNoticeBody(conflictCount),
      detail: null,
      copyLabel: "Copy prompt",
      openLabel: "Resolve",
      issue: {
        kind: "sync-conflict",
        payload: { count: conflictCount, company: conflictCompany },
      },
    });
  }

  if (phase === "error" && errorMessage) {
    rows.push({
      kind: "sync-failed",
      tone: "alert",
      title: "Finish sync in Claude Code",
      body: "Sync started but needs a hand to complete.",
      detail: errorMessage,
      copyLabel: "Copy prompt",
      openLabel: "Finish in Claude Code",
      issue: {
        kind: "sync-failed",
        payload: { message: errorMessage, company: input.errorCompany ?? "" },
      },
    });
  }

  const manifestError = (input.manifestError ?? "").trim();
  if (manifestError) {
    rows.push({
      kind: "manifest-error",
      tone: "alert",
      title: "Couldn’t read companies list",
      body: "companies/manifest.yaml could not be read.",
      detail: manifestError,
      copyLabel: "Copy fix prompt",
      openLabel: null,
      issue: { kind: "manifest-error", payload: { error: manifestError } },
    });
  }

  if (input.cloudReachable === false) {
    const cloudError = (input.cloudError ?? "").trim();
    rows.push({
      kind: "cloud-unreachable",
      tone: "warn",
      title: "Cloud unreachable",
      body: "Showing local folders.",
      detail: cloudError || null,
      copyLabel: "Copy diagnose prompt",
      openLabel: null,
      issue: { kind: "cloud-unreachable", payload: { error: cloudError } },
    });
  }

  return rows;
}
