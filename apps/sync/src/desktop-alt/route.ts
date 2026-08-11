import type { Workspace } from '../lib/workspaces';
import {
  companyConsoleUrl,
  companySettingsUrl,
  HQ_CONSOLE_BASE,
} from './lib/hq-console';
import {
  sortV4CompaniesConnectedFirst,
  type V4DotTone,
  type V4Route,
  type V4SecondaryFooter,
  type V4SecondaryItem,
} from './v4/model';

/**
 * V4 information architecture (docs/design/v4/SPEC.md section 4 + DESKTOP-001 +
 * US-021 console-drop removals).
 *
 * Global destinations — Inbox, Messages, Meetings, Marketplace, Library, Files
 * — plus companies as first-class sidebar rows and a Settings footer. Inbox is
 * notification chronology; Messages is the full conversation workspace. Home /
 * Moderation are palette-only. DESKTOP-001 expands the selected company inline
 * (Overview / Goals / Projects / Skills / Workers / Knowledge / Team).
 *
 * US-021: Deployments, Secrets, Activity feed, fleet Mission Control, and the
 * company Operations/Settings panel are no longer desktop surfaces. Legacy deep
 * links still resolve — either to the nearest V2 screen or to an HQ Console URL
 * opened in the system browser (see {@link resolvePendingDesktopRoute}).
 */

/**
 * Library routed sub-surfaces. The normal rows live in the Library secondary
 * sidebar; `submit` is owned by its persistent Publish footer. They all share
 * the `library` page + LibraryBrowser body, differing only by which tab is
 * forced. Defaults to 'skills' when a library route carries no tab.
 * Marketplace is folded back into the Library sub-nav (US-015) while the
 * top-level `marketplace` route stays alive as the palette destination.
 */
export type LibraryTab = 'skills' | 'workers' | 'marketplace' | 'installed' | 'submit' | 'profile';

export const DEFAULT_LIBRARY_TAB: LibraryTab = 'skills';

/**
 * Company page sections — live company surfaces only (US-021).
 * Legacy operational tabs (activity / deployments / secrets / settings) and
 * the More alias remap via {@link resolvePendingDesktopRoute} /
 * {@link normalizeCompanyTab} so bookmarks never land on a dead surface.
 */
export type CompanyTab =
  | 'overview'
  | 'goals'
  | 'projects'
  | 'skills'
  | 'workers'
  | 'knowledge'
  | 'team';

export const DEFAULT_COMPANY_TAB: CompanyTab = 'overview';

/** Primary company children expanded under the selected company (DESKTOP-001). */
export type CompanyPrimarySectionId =
  | 'overview'
  | 'goals'
  | 'projects'
  | 'skills'
  | 'workers'
  | 'knowledge'
  | 'team';

/**
 * Legacy company-tab ids that still appear in deep links / pending routes.
 * Remapped so old bookmarks do not 404. Operational tabs are NOT listed here —
 * they open the HQ web console (see {@link resolvePendingDesktopRoute}).
 */
const LEGACY_COMPANY_TAB_REDIRECT: Readonly<Record<string, CompanyTab>> = {
  accounts: 'overview',
  tasks: 'projects',
  library: 'skills',
  // "more" was the primary-nav alias for operations — land on overview.
  more: 'overview',
};

/** Normalize a company tab string (including legacy content ids) to a live CompanyTab. */
export function normalizeCompanyTab(value: string | undefined | null): CompanyTab | undefined {
  if (!value) return undefined;
  if (isCompanyTab(value)) return value;
  return LEGACY_COMPANY_TAB_REDIRECT[value];
}

/**
 * Map a routed company tab onto the primary sidebar child that should light.
 * Unknown / legacy operational tabs do not light a child (callers should remap
 * before navigating onto a live tab).
 */
export function companyPrimarySectionForTab(
  tab: CompanyTab | undefined | null,
): CompanyPrimarySectionId | null {
  const resolved = tab ?? DEFAULT_COMPANY_TAB;
  switch (resolved) {
    case 'overview':
    case 'goals':
    case 'projects':
    case 'skills':
    case 'workers':
    case 'knowledge':
    case 'team':
      return resolved;
    default:
      return null;
  }
}

/** Resolve a primary sidebar child click to the company tab it opens. */
export function companyTabForPrimarySection(id: CompanyPrimarySectionId): CompanyTab {
  return id;
}

/** Settings sections — rows of the Settings secondary sidebar (US-013 fills the bodies). */
export type SettingsTab =
  | 'sync'
  | 'notifications'
  | 'widget'
  | 'updates'
  | 'general'
  | 'appearance'
  | 'meetings';

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'sync';

export type DesktopRoute =
  | { kind: 'home' | 'inbox' | 'messages' | 'meetings' | 'marketplace' | 'moderation' }
  | { kind: 'library'; tab?: LibraryTab }
  | { kind: 'settings'; tab?: SettingsTab }
  | { kind: 'files'; slug?: string; path?: string }
  | { kind: 'company'; slug: string; tab?: CompanyTab };

export type DesktopRouteKind = DesktopRoute['kind'];

/**
 * Result of resolving a backend / deep-link navigation intent (US-021).
 *
 * - `internal` — navigate inside the desktop window only.
 * - `console` — open `url` in the system browser AND land the window on
 *   `landOn` (nearest V2 screen) so the shell never shows a removed surface.
 */
export type PendingDesktopResolution =
  | { mode: 'internal'; route: DesktopRoute }
  | { mode: 'console'; url: string; landOn: DesktopRoute };

/** Options for legacy intents that need ambient company context (Mission Control). */
export interface ResolvePendingDesktopRouteOptions {
  /** Active company slug when known — used for mission-control → Telescope. */
  activeCompanySlug?: string | null;
}

/**
 * Default landing (US-007): the last-visited company when it still exists,
 * else the FIRST company row in sidebar order (connected-first sort), else
 * Home — the exception surface for a workspace-less install.
 */
export function getDesktopLandingRoute(
  workspaces: Workspace[],
  lastVisitedSlug?: string | null,
): DesktopRoute {
  const rows = sortV4CompaniesConnectedFirst(getDesktopCompanies(workspaces));
  if (lastVisitedSlug && rows.some((row) => row.slug === lastVisitedSlug)) {
    return { kind: 'company', slug: lastVisitedSlug };
  }
  if (rows[0]) return { kind: 'company', slug: rows[0].slug };
  return { kind: 'home' };
}

/**
 * All route-supported company sections (deep links, command palette, CompanyPage).
 * US-021: operations tabs removed — console deep links cover Deployments /
 * Secrets / Activity / Settings / Telescope.
 */
export const COMPANY_SECTIONS: ReadonlyArray<{ id: CompanyTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'goals', label: 'Goals' },
  { id: 'projects', label: 'Projects' },
  { id: 'skills', label: 'Skills' },
  { id: 'workers', label: 'Workers' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'team', label: 'Team' },
];

/**
 * Compact primary company children shown under the selected company (DESKTOP-001).
 * US-021: More / operations workspace removed.
 */
export const COMPANY_PRIMARY_SECTIONS: ReadonlyArray<{
  id: CompanyPrimarySectionId;
  label: string;
}> = [
  { id: 'overview', label: 'Overview' },
  { id: 'goals', label: 'Goals' },
  { id: 'projects', label: 'Projects' },
  { id: 'skills', label: 'Skills' },
  { id: 'workers', label: 'Workers' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'team', label: 'Team' },
];

/**
 * Library secondary-sidebar rows in SPEC display order: the four V2 tabs
 * (Skills / Workers / Installed / Profile) plus the Marketplace fold-in entry
 * (US-015) so browse / detail / install-scope / install-log are reachable from
 * the Library without leaving the surface.
 */
export const LIBRARY_SECTIONS: ReadonlyArray<{ id: LibraryTab; label: string }> = [
  { id: 'skills', label: 'Skills' },
  { id: 'workers', label: 'Workers' },
  { id: 'marketplace', label: 'Marketplace' },
  { id: 'installed', label: 'Installed' },
  { id: 'profile', label: 'Profile' },
];

/** Settings secondary-sidebar rows in the desktop section index. */
export const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsTab;
  label: string;
  note?: string;
}> = [
  { id: 'sync', label: 'Sync' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'widget', label: 'Widget' },
  { id: 'updates', label: 'Updates' },
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'meetings', label: 'Meetings' },
];

export function getDesktopCompanies(workspaces: Workspace[]): Workspace[] {
  // Desktop is local-first. If a company folder exists on this machine, it must
  // be navigable even when it is not cloud-backed yet. Cloud-only memberships
  // also stay visible so an invite/download state does not disappear. The
  // backend command is already the visibility boundary for desktop workspaces,
  // so do not second-guess it with one stale/missing metadata flag.
  const seen = new Set<string>();
  return workspaces.filter(
    (workspace) => {
      if (workspace.kind !== 'personal' && workspace.kind !== 'company') return false;
      if (seen.has(workspace.slug)) return false;
      seen.add(workspace.slug);
      return true;
    },
  );
}

/**
 * Remount key for the routed page. Company pages key on the slug only — the
 * sections swap panels inside the page (keyed there), so switching sections
 * never tears down the page chrome. The library likewise keys on the surface,
 * not the tab, so tab switches don't refetch the library tree.
 */
export function getDesktopRouteKey(route: DesktopRoute): string {
  if (route.kind === 'company') return `company:${route.slug}`;
  // Files mode keys on its kind only (NOT slug/path): the FilesModeSidebar
  // handles company/file changes reactively, so switching company or file
  // inside Files mode must not remount the whole shell.
  if (route.kind === 'files') return 'files';
  return route.kind;
}

export function isDesktopRouteActive(route: DesktopRoute, candidate: DesktopRoute): boolean {
  if (route.kind !== candidate.kind) return false;
  if (route.kind === 'company' && candidate.kind === 'company') {
    return route.slug === candidate.slug;
  }
  // Any Files-mode route is the same active destination regardless of the
  // active company / selected file it carries.
  return true;
}

export function getDesktopActiveCompany(
  route: DesktopRoute,
  companies: Workspace[],
): Workspace | null {
  if (route.kind !== 'company') return null;
  return companies.find((company) => company.slug === route.slug) ?? null;
}

/**
 * Single-active-workspace hotkeys (hq-desktop-v2 US-002):
 *   ⌘0 → Personal workspace (if present)
 *   ⌘1–⌘9 → Nth non-personal company in connected-first sidebar order
 * Primary destinations (Inbox / Meetings / Marketplace / Library) no longer
 * own number chords — they stay palette- and sidebar-reachable.
 */
export function getDesktopHotkeyRoute(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey'>,
  companies: Workspace[],
): DesktopRoute | null {
  if (!(event.metaKey || event.ctrlKey)) return null;

  const rows = sortV4CompaniesConnectedFirst(companies);

  if (event.key === '0') {
    const personal = rows.find((row) => row.isPersonal);
    return personal ? { kind: 'company', slug: personal.slug } : null;
  }

  const companyIndex = Number.parseInt(event.key, 10) - 1;
  if (companyIndex >= 0 && companyIndex <= 8) {
    const nonPersonal = rows.filter((row) => !row.isPersonal);
    const company = nonPersonal[companyIndex];
    if (company) return { kind: 'company', slug: company.slug };
  }

  return null;
}

/**
 * ⌘ hotkey label for the non-personal company at `index` (connected-first
 * order, 0-based): ⌘1–⌘9 for indexes 0–8, undefined past the ninth slot.
 * Personal uses ⌘0 separately (see getV2WorkspaceSwitcherItems).
 */
export function companyHotkey(index: number): string | undefined {
  return index >= 0 && index <= 8 ? `⌘${index + 1}` : undefined;
}

/**
 * Destination for the switcher "+ Add a workspace" action (US-002):
 * pending invite → that company page (claim_pending_company_invite),
 * else local-only/broken company → that company page (connect_workspace_to_cloud),
 * else Settings → Sync tab.
 */
export function getAddWorkspaceRoute(workspaces: Workspace[]): DesktopRoute {
  const pendingInvite = workspaces.find(
    (workspace) =>
      workspace.kind === 'company' && workspace.membershipStatus === 'pending',
  );
  if (pendingInvite) return { kind: 'company', slug: pendingInvite.slug };

  const needsConnect = workspaces.find(
    (workspace) =>
      workspace.kind === 'company' &&
      (workspace.state === 'local-only' || workspace.state === 'broken'),
  );
  if (needsConnect) return { kind: 'company', slug: needsConnect.slug };

  return { kind: 'settings', tab: 'sync' };
}

/**
 * Company overview is the nearest V2 screen when a legacy company ops link
 * opens the console (or when `more` is requested).
 */
function companyOverview(slug: string): DesktopRoute {
  return { kind: 'company', slug, tab: 'overview' };
}

/**
 * Resolve a backend navigation intent (desktop_alt_consume_pending_route /
 * the `desktop:navigate` event) to either an internal route or a console URL
 * plus a land-on route (US-021).
 *
 * Legacy aliases stay functional:
 * - 'sync' → Home
 * - company ops tabs → HQ Console + company overview
 * - mission-control → Telescope console (when a company slug is known) else Home
 */
export function resolvePendingDesktopRoute(
  name: string | null | undefined,
  options: ResolvePendingDesktopRouteOptions = {},
): PendingDesktopResolution | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\//g, ':');

  const [kind, first, second] = normalized.split(':');

  // Files mode: `files`, `files:<slug>`, `files:<slug>:<path…>`. File paths
  // contain '/', so we must NOT collapse the path into the slug. Split only the
  // first two ':' segments off (kind + slug) and keep the REMAINDER as the path
  // (re-join everything after the second ':' — the normaliser turned the path's
  // own slashes into colons, so restore them).
  if (kind === 'files') {
    if (!first) return { mode: 'internal', route: { kind: 'files' } };
    const rest = normalized.split(':').slice(2);
    if (rest.length === 0) return { mode: 'internal', route: { kind: 'files', slug: first } };
    return {
      mode: 'internal',
      route: { kind: 'files', slug: first, path: rest.join('/') },
    };
  }

  if (kind === 'company' && first) {
    // US-021: dropped operations surfaces → console deep links + overview.
    // Deployments uses the global console path (matches consoleDeepLinks).
    if (second === 'deployments') {
      return {
        mode: 'console',
        url: `${HQ_CONSOLE_BASE}/deployments`,
        landOn: companyOverview(first),
      };
    }
    if (second === 'secrets') {
      return {
        mode: 'console',
        url: `${companyConsoleUrl(first)}/secrets`,
        landOn: companyOverview(first),
      };
    }
    if (second === 'activity') {
      return {
        mode: 'console',
        url: `${companyConsoleUrl(first)}/activity`,
        landOn: companyOverview(first),
      };
    }
    if (second === 'settings') {
      return {
        mode: 'console',
        url: companySettingsUrl(first),
        landOn: companyOverview(first),
      };
    }

    // Live tabs + content legacy redirects (accounts→overview, tasks→projects,
    // library→skills, more→overview).
    const tab = normalizeCompanyTab(second);
    return tab
      ? { mode: 'internal', route: { kind: 'company', slug: first, tab } }
      : { mode: 'internal', route: { kind: 'company', slug: first } };
  }

  if (kind === 'library') {
    // `library:marketplace` is a live Library tab again (US-015 fold-in).
    const tab = isLibraryTab(first) ? first : undefined;
    return tab
      ? { mode: 'internal', route: { kind: 'library', tab } }
      : { mode: 'internal', route: { kind: 'library' } };
  }

  if (kind === 'settings') {
    const tab = isSettingsTab(first) ? first : undefined;
    return tab
      ? { mode: 'internal', route: { kind: 'settings', tab } }
      : { mode: 'internal', route: { kind: 'settings' } };
  }

  switch (normalized) {
    case 'home':
    case 'sync':
    // US-004 WindowRouter: Activity digest + Core Drift card live on Home.
    // Top-level open_* wrappers land here instead of spawning windows.
    case 'activity':
    case 'core-drift':
    case 'drift':
      return { mode: 'internal', route: { kind: 'home' } };
    case 'mission-control': {
      // US-021: fleet Mission Control → console Telescope when a company is
      // known; otherwise land on Home (nearest V2 screen).
      const slug = options.activeCompanySlug?.trim();
      if (slug) {
        return {
          mode: 'console',
          url: `${companyConsoleUrl(slug)}/telescope`,
          landOn: companyOverview(slug),
        };
      }
      return { mode: 'internal', route: { kind: 'home' } };
    }
    case 'inbox':
      return { mode: 'internal', route: { kind: 'inbox' } };
    case 'messages':
      return { mode: 'internal', route: { kind: 'messages' } };
    // Notifications remain the chronological Inbox feed.
    case 'notifications':
      return { mode: 'internal', route: { kind: 'inbox' } };
    case 'meetings':
      return { mode: 'internal', route: { kind: 'meetings' } };
    case 'marketplace':
      return { mode: 'internal', route: { kind: 'marketplace' } };
    case 'moderation':
      return { mode: 'internal', route: { kind: 'moderation' } };
    case 'library':
      return { mode: 'internal', route: { kind: 'library' } };
    case 'settings':
      return { mode: 'internal', route: { kind: 'settings' } };
    default:
      return null;
  }
}

/**
 * Pure helper: console URL for a legacy intent, or null when the intent is
 * internal-only / unknown. Mirrors {@link resolvePendingDesktopRoute} without
 * constructing the land-on route — handy for unit tests and callers that only
 * need the browser target.
 */
export function consoleUrlForLegacyRoute(
  name: string | null | undefined,
  options: ResolvePendingDesktopRouteOptions = {},
): string | null {
  const resolved = resolvePendingDesktopRoute(name, options);
  return resolved?.mode === 'console' ? resolved.url : null;
}

/** Desktop route to navigate to after resolving a pending intent. */
export function landOnRouteForResolution(
  resolution: PendingDesktopResolution | null,
): DesktopRoute | null {
  if (!resolution) return null;
  return resolution.mode === 'internal' ? resolution.route : resolution.landOn;
}

function isCompanyTab(value: string | undefined): value is CompanyTab {
  return COMPANY_SECTIONS.some((section) => section.id === value);
}

function isLibraryTab(value: string | undefined): value is LibraryTab {
  // Submit is a routed sub-screen owned by the persistent "Publish a pack"
  // footer, not a duplicate row in the Library section list.
  return value === 'submit' || LIBRARY_SECTIONS.some((section) => section.id === value);
}

function isSettingsTab(value: string | undefined): value is SettingsTab {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

/**
 * Narrow a V4Sidebar navigation payload (open-ended V4Route) back into the
 * app's DesktopRoute union. Unknown kinds land on Home — the exception surface.
 * Company payloads may carry a primary section / tab id (DESKTOP-001).
 *
 * US-021: `mission-control` lands on Home (console open is handled by the
 * palette / pending-route path, not by in-shell V4 nav).
 */
export function fromV4Route(route: V4Route): DesktopRoute {
  if (route.kind === 'company' && route.slug) {
    const tab = normalizeCompanyTab(route.tab);
    return tab
      ? { kind: 'company', slug: route.slug, tab }
      : { kind: 'company', slug: route.slug };
  }
  switch (route.kind) {
    case 'home':
      return { kind: 'home' };
    case 'mission-control':
      // Fleet surface dropped — nearest V2 screen is Home.
      return { kind: 'home' };
    case 'inbox':
    case 'notifications':
      return { kind: 'inbox' };
    case 'messages':
      return { kind: 'messages' };
    case 'meetings':
      return { kind: 'meetings' };
    case 'marketplace':
      return { kind: 'marketplace' };
    case 'library':
      return { kind: 'library' };
    case 'files':
      // The Files nav row emits { kind: 'files' } with no slug — the shell
      // fills in the default connected company before navigating.
      return { kind: 'files' };
    case 'settings':
      return { kind: 'settings' };
    default:
      return { kind: 'home' };
  }
}

/** Secondary (contextual) sidebar render model — null on surfaces without one. */
export interface DesktopSecondarySidebar {
  surface: 'company' | 'library' | 'settings';
  header: string;
  headerTone: V4DotTone | null;
  meta: string | null;
  items: V4SecondaryItem[];
  activeId: string;
  footer: V4SecondaryFooter | null;
}

export interface DesktopSecondarySidebarOptions {
  /** App version for the Settings header meta line. */
  version?: string | null;
  /** Resolved HQ folder root for Library metadata, e.g. `~/Documents/HQ`. */
  hqFolderPath?: string | null;
}

/**
 * SPEC section 4 + DESKTOP-001: the secondary sidebar exists ONLY on Library
 * and Settings. Company navigation expands inline in the primary sidebar, so
 * company routes never render a permanent secondary column. Home, Marketplace,
 * Meetings, Inbox, Messages, Files, and Moderation have none.
 */
export function getDesktopSecondarySidebar(
  route: DesktopRoute,
  companies: Workspace[],
  options: DesktopSecondarySidebarOptions = {},
): DesktopSecondarySidebar | null {
  // DESKTOP-001: company children live under the selected company row — no
  // permanent company secondary sidebar. Keep `companies` in the signature so
  // call sites and library/settings meta helpers stay stable.
  void companies;

  if (route.kind === 'library') {
    return {
      surface: 'library',
      header: 'Library',
      headerTone: null,
      meta: formatHqFolderMeta(options.hqFolderPath),
      items: LIBRARY_SECTIONS.map(({ id, label }) => ({ id, label })),
      activeId: route.tab ?? DEFAULT_LIBRARY_TAB,
      footer: { label: 'Publish a pack', active: route.tab === 'submit' },
    };
  }

  if (route.kind === 'settings') {
    return {
      surface: 'settings',
      header: 'Settings',
      headerTone: null,
      meta: options.version ? `HQ v${options.version}` : null,
      items: SETTINGS_SECTIONS.map(({ id, label, note }) => ({ id, label, note: note ?? null })),
      activeId: route.tab ?? DEFAULT_SETTINGS_TAB,
      // The "Sign out" footer ships with the V4 Settings surface (US-013).
      footer: null,
    };
  }

  return null;
}

export function normalizeNativePath(path: string): string {
  const trimmed = path.trim();
  const windowsUncPrefix = '\\\\?\\UNC\\';
  const windowsVerbatimPrefix = '\\\\?\\';
  if (trimmed.toUpperCase().startsWith(windowsUncPrefix.toUpperCase())) {
    return '\\\\' + trimmed.slice(windowsUncPrefix.length);
  }
  if (trimmed.startsWith(windowsVerbatimPrefix)) {
    return trimmed.slice(windowsVerbatimPrefix.length);
  }
  return trimmed;
}

export function formatHqFolderMeta(path: string | null | undefined): string {
  const trimmed = path ? normalizeNativePath(path) : '';
  if (!trimmed) return 'HQ folder';
  return trimmed.replace(/^\/Users\/[^/]+/, '~');
}

/** Re-export — implementation lives in v4/model.ts (US-002 switcher model). */
export { formatRelativeTime } from './v4/model';
