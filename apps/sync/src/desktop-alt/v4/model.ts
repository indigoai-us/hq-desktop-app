import type { Workspace } from '../../lib/workspaces';
import type { SyncState } from '../lib/sync-model';

/**
 * V4 chrome model — pure derivations for the shared chrome components
 * (V4Sidebar / V4SecondarySidebar / V4TitleBar). The route restructure that
 * adopts these kinds app-wide lands in US-002; until then this module defines
 * the V4 information architecture the chrome renders against
 * (docs/design/v4/SPEC.md section 4 + chrome-master.png).
 */

/**
 * The primary-nav destinations, in display order. Inbox is the single combined
 * messages + notifications destination (US-008). Home, Mission Control, and the
 * Companies page are palette-only / company-row surfaces — not sidebar nav items.
 */
export type V4NavId =
  | 'inbox'
  | 'meetings'
  | 'marketplace'
  | 'library'
  | 'files';

/**
 * Route shape the V4 chrome maps to an active row. `kind` is open-ended
 * (`string & {}` keeps autocomplete on the known kinds while accepting the
 * richer kinds US-002 introduces); `slug` is set for company routes.
 */
export interface V4Route {
  kind: V4NavId | 'settings' | 'company' | (string & {});
  slug?: string;
}

export const V4_NAV_ITEMS: ReadonlyArray<{ id: V4NavId; label: string }> = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'meetings', label: 'Meetings' },
  { id: 'marketplace', label: 'Marketplace' },
  { id: 'library', label: 'Library' },
  { id: 'files', label: 'Files' },
];

/** Chrome metrics (SPEC section 4) — exported for shell composition in US-002. */
export const V4_CHROME_LAYOUT = {
  titleBarHeightPx: 40,
  primarySidebarWidthPx: 220,
  secondarySidebarWidthPx: 200,
} as const;

/** Status-dot tones — the only color in the app, almost always as 6px dots. */
export type V4DotTone = 'ok' | 'warn' | 'error' | 'idle';

export interface V4SidebarNavRow {
  id: V4NavId;
  label: string;
  active: boolean;
}

export interface V4SidebarCompanyRow {
  slug: string;
  label: string;
  tone: V4DotTone;
  active: boolean;
  /**
   * True when this row is a cloud-activated company membership (synced or
   * cloud-only). Gates the Shared/All hover control (US-009); personal and
   * local-only/broken rows stay false.
   */
  cloudActivated: boolean;
}

export interface V4SidebarModel {
  nav: V4SidebarNavRow[];
  companies: V4SidebarCompanyRow[];
  /** Settings highlights the footer, not a nav item (SPEC section 4). */
  settingsActive: boolean;
}

/**
 * Sidebar dot tone for a workspace row: green = connected/syncing fine
 * (personal is local-first and always live), red = broken, gray = paused /
 * not yet connected (SPEC: "gray dot = paused").
 */
export function v4CompanyDotTone(workspace: Workspace): V4DotTone {
  if (workspace.kind === 'personal') return 'ok';
  if (workspace.state === 'synced') return 'ok';
  if (workspace.state === 'broken') return 'error';
  return 'idle';
}

/**
 * Cloud-connected = a live vault link the user can sync against right now:
 * `synced` (local + cloud in step) or `cloud-only` (cloud membership, not yet
 * pulled). Personal is local-first and always live, so it counts as connected
 * too (it renders the same green dot). These rows sort to the TOP of the
 * COMPANIES list (US-007) so the user's active workspaces lead; idle/broken
 * rows follow. Mirrors the "green dot = connected" product framing.
 */
export function v4CompanyConnected(workspace: Workspace): boolean {
  return (
    workspace.kind === 'personal' ||
    workspace.state === 'synced' ||
    workspace.state === 'cloud-only'
  );
}

/** Cloud-activated = a company row with a live, ACCEPTED vault membership
 *  (synced or cloud-only). Personal is local-first (not a company membership),
 *  local-only/broken rows have no membership sync-config yet, and a pending
 *  cloud-only row is an unaccepted invite (its affordance is "Open invite" on
 *  the company page, never a sync-mode read/write) — no control on any of those. */
export function v4CompanyCloudActivated(workspace: Workspace): boolean {
  return (
    workspace.kind === 'company' &&
    (workspace.state === 'synced' || workspace.state === 'cloud-only') &&
    workspace.membershipStatus !== 'pending'
  );
}

/**
 * Shared dedupe + connected-first + alpha sort for the COMPANIES list (US-007).
 * Both the primary V4Sidebar (via getV4SidebarModel) and the FilesModeSidebar
 * mini company list consume this, so their ordering matches exactly. Pass
 * `activeSlug` to mark one row active; the dedupe keeps the first occurrence per
 * slug and the sort is stable so the active row and survivor are untouched.
 */
export function sortV4CompaniesConnectedFirst(
  workspaces: Workspace[],
  activeSlug?: string | null,
): V4SidebarCompanyRow[] {
  const seenCompanySlugs = new Set<string>();

  // Dedupe by slug (first occurrence wins), capturing the connected flag so the
  // sort below can group without re-reading the source workspace.
  const deduped: Array<{ row: V4SidebarCompanyRow; connected: boolean }> = [];
  for (const workspace of workspaces) {
    if (seenCompanySlugs.has(workspace.slug)) continue;
    seenCompanySlugs.add(workspace.slug);
    deduped.push({
      connected: v4CompanyConnected(workspace),
      row: {
        slug: workspace.slug,
        label: workspace.displayName,
        tone: v4CompanyDotTone(workspace),
        active: activeSlug != null && activeSlug === workspace.slug,
        cloudActivated: v4CompanyCloudActivated(workspace),
      },
    });
  }

  // Connected-first (US-007): cloud-connected companies (synced / cloud-only,
  // plus always-live personal) lead; everything else follows. Alphabetical by
  // display name (case-insensitive) WITHIN each group. Sort is stable so the
  // active-highlight and dedupe survivor are untouched — only order changes.
  deduped.sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return a.row.label.localeCompare(b.row.label, undefined, { sensitivity: 'base' });
  });

  return deduped.map((entry) => entry.row);
}

/**
 * Derive the primary-sidebar render model from the route + the
 * `list_syncable_workspaces` result. Invariant (US-007): AT MOST one active
 * row — a nav item, a company row, or the Settings footer. Palette-only
 * surfaces (home, mission-control, moderation, unknown kinds) and company
 * routes with no matching row light no row. Company pages highlight the
 * company row, not a nav item; all local-first/cloud-visible companies render
 * directly in the sidebar.
 */
export function getV4SidebarModel(route: V4Route, workspaces: Workspace[]): V4SidebarModel {
  const settingsActive = route.kind === 'settings';

  const companies: V4SidebarCompanyRow[] = sortV4CompaniesConnectedFirst(
    workspaces,
    route.kind === 'company' ? route.slug : null,
  );

  const companyRowActive = companies.some((row) => row.active);

  // Settings footer or a company row owns the highlight — nav stays unlit.
  // Otherwise the matching primary nav item, or null (no fallback to home /
  // companies: those rows no longer exist — US-007).
  const activeNavId: V4NavId | null =
    settingsActive || companyRowActive
      ? null
      : V4_NAV_ITEMS.some((item) => item.id === route.kind)
        ? (route.kind as V4NavId)
        : null;

  return {
    nav: V4_NAV_ITEMS.map((item) => ({
      id: item.id,
      label: item.label,
      active: item.id === activeNavId,
    })),
    companies,
    settingsActive,
  };
}

/** Secondary-sidebar item (contextual menu row). */
export interface V4SecondaryItem {
  id: string;
  label: string;
  /** Optional muted trailing note, e.g. "gated" on the Meetings settings row. */
  note?: string | null;
}

/** Secondary-sidebar footer, e.g. "Company settings" + "sync rules · members · roles". */
export interface V4SecondaryFooter {
  label: string;
  meta?: string | null;
}

/** Title-bar primary action — contextual, always exactly one. */
export interface V4TitleBarAction {
  id: 'sync' | 'cancel' | 'retry';
  label: 'Sync Now' | 'Cancel' | 'Retry';
}

export interface V4TitleBarModel {
  tone: V4DotTone;
  /** The live sync status sentence, 13px text-1 ("All synced", …). */
  sentence: string;
  /** Trailing text-3 detail ("12 watched · just now"), null when empty. */
  meta: string | null;
  action: V4TitleBarAction;
}

export interface V4TitleBarInput {
  syncState: SyncState;
  /** Connected workspaces being watched (companies + personal). */
  watchedCount: number;
  /** Human relative last-sync label ("just now", "5m ago"). */
  lastSyncLabel?: string | null;
  /** Company currently transferring, while syncing. */
  syncingCompany?: string | null;
  fanoutDone?: number;
  fanoutTotal?: number;
  /** Plain-language error summary, for error states. */
  errorSummary?: string | null;
}

/**
 * Title-bar render model: 6px dot + status sentence + text-3 meta + ONE
 * contextual primary action (Sync Now / Cancel / Retry) per SPEC section 4.
 */
export function getV4TitleBarModel(input: V4TitleBarInput): V4TitleBarModel {
  const syncNow: V4TitleBarAction = { id: 'sync', label: 'Sync Now' };

  switch (input.syncState) {
    case 'syncing': {
      const parts: string[] = [];
      if (input.syncingCompany) parts.push(input.syncingCompany);
      if (input.fanoutTotal && input.fanoutTotal > 0) {
        parts.push(`${input.fanoutDone ?? 0}/${input.fanoutTotal} companies`);
      }
      return {
        tone: 'ok',
        sentence: 'Syncing…',
        meta: parts.length > 0 ? parts.join(' · ') : null,
        action: { id: 'cancel', label: 'Cancel' },
      };
    }
    case 'error':
      return {
        tone: 'error',
        sentence: 'Sync failed',
        meta: input.errorSummary ?? 'check your connection',
        action: { id: 'retry', label: 'Retry' },
      };
    case 'auth-error':
      return {
        tone: 'error',
        sentence: 'Signed out',
        meta: 'sign in to resume sync',
        action: { id: 'retry', label: 'Retry' },
      };
    case 'conflict':
      return {
        tone: 'warn',
        sentence: 'Needs your review',
        meta: 'resolve conflicts to continue',
        action: syncNow,
      };
    case 'setup-needed':
      return {
        tone: 'idle',
        sentence: 'Sync not set up',
        meta: null,
        action: syncNow,
      };
    default: {
      const watched = `${input.watchedCount} watched`;
      return {
        tone: 'ok',
        sentence: 'All synced',
        meta: input.lastSyncLabel ? `${watched} · ${input.lastSyncLabel}` : watched,
        action: syncNow,
      };
    }
  }
}
