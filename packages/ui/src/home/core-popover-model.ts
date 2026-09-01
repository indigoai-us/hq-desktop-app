/**
 * Pure model for the V4 titlebar Core popover (US-016).
 *
 * Derives conflict header copy, drift / update pills, pack rows, and
 * pause-gated Sync Now behaviour from plain inputs — no Svelte / Tauri.
 */

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
}): "ok" | "warn" {
  if ((input.conflictCount ?? 0) > 0) return "warn";
  const s = (input.syncState ?? "").toLowerCase();
  if (s === "conflict" || s === "error" || s === "auth-error") return "warn";
  if ((input.driftCount ?? 0) > 0) return "warn";
  if (input.cloudPaused) return "warn";
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
    const rec = row as { name?: unknown; version?: unknown };
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name) continue;
    const version = typeof rec.version === "string" ? rec.version : null;
    packs.push({ name, version });
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
