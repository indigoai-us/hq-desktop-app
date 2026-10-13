/**
 * State for the `hq-desktop://pack/{slug}` confirmation sheet (US-005).
 *
 * The native side validates the slug, stashes the target and emits
 * `pack:open-install`; the shell owns this small state machine and renders
 * `PackInstallSheet.svelte` from it. Pure so the transitions are testable
 * without Tauri.
 */

/** Mirrors `hq_desktop_core::deep_link::is_valid_pack_slug`. */
export const PACK_SLUG_PATTERN = /^[a-z0-9-]{2,64}$/;

export function isValidPackSlug(value: unknown): value is string {
  return typeof value === 'string' && PACK_SLUG_PATTERN.test(value);
}

/** Op the native install streams its `packages:progress` lines under. */
export const PACK_DEEP_LINK_OP = 'pack-deep-link';

/** Event the deep-link handler emits to a mounted desktop window. */
export const PACK_OPEN_INSTALL_EVENT = 'pack:open-install';

export type PackInstallPhase =
  /** Not signed in: the sheet says so; the native stash keeps the target. */
  | 'signed-out'
  /** Signed in, Add / Cancel shown. The name may still be loading. */
  | 'confirm'
  /** `hq packages install {slug} --start-bot` is running. */
  | 'installing'
  /** Installed, but no bot DM to open (no `bot:` line or no local record). */
  | 'done'
  /** The install failed; the person can retry or close. */
  | 'failed';

export interface PackInstallSheetState {
  slug: string;
  /** Catalog display name; null until known or when the catalog is unreachable. */
  displayName: string | null;
  phase: PackInstallPhase;
  /** Recent progress lines, newest last. */
  lines: string[];
  error: string | null;
  botName: string | null;
}

/** Lines kept on screen. The log file has the rest. */
export const PACK_INSTALL_LINE_CAP = 40;

export function createPackInstallState(slug: string, signedIn: boolean): PackInstallSheetState {
  return {
    slug,
    displayName: null,
    phase: signedIn ? 'confirm' : 'signed-out',
    lines: [],
    error: null,
    botName: null,
  };
}

/** What the sheet calls the pack: the catalog name, else the slug itself. */
export function packDisplayLabel(state: Pick<PackInstallSheetState, 'slug' | 'displayName'>): string {
  const name = state.displayName?.trim();
  return name ? name : state.slug;
}

export function withDisplayName(
  state: PackInstallSheetState,
  displayName: unknown,
): PackInstallSheetState {
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  return { ...state, displayName: name ? name : null };
}

/**
 * Sign-in state changed. A signed-out sheet becomes the confirmation once the
 * person is signed in; a sheet that is already past confirmation never goes
 * back (an install in flight is not interrupted by a session recheck).
 */
export function withSignedIn(state: PackInstallSheetState, signedIn: boolean): PackInstallSheetState {
  if (signedIn && state.phase === 'signed-out') return { ...state, phase: 'confirm' };
  if (!signedIn && state.phase === 'confirm') return { ...state, phase: 'signed-out' };
  return state;
}

export function beginInstall(state: PackInstallSheetState): PackInstallSheetState {
  return { ...state, phase: 'installing', lines: [], error: null, botName: null };
}

export function appendInstallLine(state: PackInstallSheetState, line: unknown): PackInstallSheetState {
  if (typeof line !== 'string') return state;
  const text = line.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
  if (!text.trim()) return state;
  const lines = [...state.lines, text];
  return { ...state, lines: lines.slice(-PACK_INSTALL_LINE_CAP) };
}

export function finishInstall(state: PackInstallSheetState, botName: unknown): PackInstallSheetState {
  const name = typeof botName === 'string' && botName.trim() ? botName.trim() : null;
  return { ...state, phase: 'done', botName: name, error: null };
}

export function failInstall(state: PackInstallSheetState, error: unknown): PackInstallSheetState {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string' && error.trim()
        ? error.trim()
        : 'The pack could not be installed.';
  return { ...state, phase: 'failed', error: message };
}

/** A `packages:progress` payload that belongs to this sheet's install. */
export function isPackInstallProgress(
  payload: unknown,
  slug: string,
): payload is { op: string; name: string; line: string } {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as { op?: unknown; name?: unknown; line?: unknown };
  return record.op === PACK_DEEP_LINK_OP && record.name === slug && typeof record.line === 'string';
}

/** The `agentUid` of the local bot named `botName`, from a `hq bot list --json` document. */
export function localBotAgentUid(document: unknown, botName: string | null): string | null {
  if (!botName) return null;
  const rows = Array.isArray(document)
    ? document
    : document && typeof document === 'object' && Array.isArray((document as { bots?: unknown }).bots)
      ? (document as { bots: unknown[] }).bots
      : [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as { name?: unknown; agentUid?: unknown };
    if (record.name !== botName) continue;
    const uid = typeof record.agentUid === 'string' ? record.agentUid.trim() : '';
    if (uid) return uid;
  }
  return null;
}
