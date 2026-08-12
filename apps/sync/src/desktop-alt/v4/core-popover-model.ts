/**
 * Pure model for the V4 titlebar Core popover (US-016).
 *
 * Derives conflict header copy, drift / update pills, pack rows, and
 * pause-gated Sync Now behaviour from plain inputs — no Svelte / Tauri.
 */

// ── Inputs ───────────────────────────────────────────────────────────────────

export type CorePopoverConflictStatus = 'pending' | 'resolving' | 'resolved' | 'error';

export interface CorePopoverConflict {
  path: string;
  status: CorePopoverConflictStatus;
  error?: string;
}

export interface CorePopoverPack {
  name: string;
  version?: string | null;
}

export interface CorePopoverCoreState {
  /** Local hq-core version (from get_hq_version / core state). */
  hqVersion?: string | null;
  /** USER-EDIT drift count (THE drift number). */
  driftCount: number;
  /** True when local trails target OR drift is present. */
  needsRestore: boolean;
  channel?: 'release' | 'staging' | null;
}

export interface BuildCorePopoverInput {
  conflicts?: readonly CorePopoverConflict[];
  core?: CorePopoverCoreState | null;
  appVersion?: string | null;
  updateAvailable?: boolean;
  packs?: readonly CorePopoverPack[];
  cloudPaused?: boolean;
  packsExpanded?: boolean;
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
  /** Uppercase pill: "NO DRIFT" or "N drifted". */
  driftPill: string;
  driftCount: number;
  /** Drift count is clickable when > 0. */
  driftOpenable: boolean;
  showRestore: boolean;
  appVersionLabel: string;
  updateAvailable: boolean;
  packs: CorePopoverPack[];
  packsExpanded: boolean;
  packsSummary: string;
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
  if (!trimmed.includes('/') && !trimmed.includes('\\')) return 'HQ root';
  const normalized = trimmed.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return 'HQ root';
  return normalized.slice(0, idx);
}

export function conflictHeaderLabel(count: number): string {
  const n = Math.max(0, Math.floor(count));
  if (n <= 0) return '';
  return n === 1 ? '1 conflict needs you' : `${n} conflicts need you`;
}

export function driftPillLabel(count: number): string {
  const n = Math.max(0, Math.floor(count));
  return n > 0 ? `${n} drifted` : 'NO DRIFT';
}

export function coreNeedsRestore(versionBehind: boolean, driftCount: number): boolean {
  return Boolean(versionBehind) || Math.max(0, Math.floor(driftCount)) > 0;
}

export function hqVersionLabel(version: string | null | undefined): string {
  if (version && version.trim()) return `HQ core v${version.trim()}`;
  return 'HQ core not detected';
}

export function appVersionLabel(version: string | null | undefined): string {
  if (version && version.trim()) return `Desktop app v${version.trim()}`;
  return 'Desktop app';
}

export function packsSummaryLabel(count: number): string {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return 'No packs installed';
  return n === 1 ? '1 pack installed' : `${n} packs installed`;
}

export const CLOUD_PAUSED_NOTICE =
  'Cloud is off — sync is paused on this device. Turn Cloud on to resume.';

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
export function buildCorePopoverViewModel(input: BuildCorePopoverInput = {}): CorePopoverViewModel {
  const rawConflicts = input.conflicts ?? [];
  const active = rawConflicts.filter((c) => c.status !== 'resolved');
  const conflictRows: CorePopoverConflictRow[] = active.map((c) => ({
    path: c.path,
    fileName: conflictFileName(c.path),
    companyPath: conflictCompanyPath(c.path),
    status: c.status,
    error: c.error,
    actionsDisabled: c.status === 'resolving',
  }));
  const conflictCount = conflictRows.length;

  const core = input.core ?? null;
  const driftCount = Math.max(0, Math.floor(core?.driftCount ?? 0));
  const packs = [...(input.packs ?? [])];
  const cloudPaused = Boolean(input.cloudPaused);

  return {
    conflictRows,
    conflictHeader: conflictHeaderLabel(conflictCount),
    conflictCount,
    hqVersionLabel: hqVersionLabel(core?.hqVersion),
    driftPill: driftPillLabel(driftCount),
    driftCount,
    driftOpenable: driftCount > 0,
    showRestore: Boolean(core?.needsRestore),
    appVersionLabel: appVersionLabel(input.appVersion),
    updateAvailable: Boolean(input.updateAvailable),
    packs,
    packsExpanded: Boolean(input.packsExpanded),
    packsSummary: packsSummaryLabel(packs.length),
    cloudPaused,
    pausedNotice: cloudPaused ? CLOUD_PAUSED_NOTICE : null,
    syncNowAllowed: isSyncNowAllowed(cloudPaused),
  };
}
