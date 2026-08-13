import type { Workspace } from '../lib/workspaces';
import {
  sortV4CompaniesConnectedFirst,
  type V4DotTone,
  type V4Route,
  type V4SecondaryFooter,
  type V4SecondaryItem,
} from './v4/model';

/**
 * Desktop information architecture (chat-first shell, US-003..018).
 *
 * Primary chrome is ChatSidebar (conversations + companies). Global page
 * destinations include Notifications (notification chronology), Messages,
 * Meetings, Marketplace, Library (overlay), Files, Settings, Home (palette /
 * exception surface), and Moderation (admin). Legacy workspace-shell deep
 * links remap in resolvePendingDesktopRoute. DESKTOP-001 expands the selected
 * company inline (Overview / Goals / Projects / Skills / Workers / Knowledge /
 * Team / More). Settings is a single pane — one section at a time, navigated
 * in place (US-020: no secondary column anywhere). Library is a full-screen
 * overlay. DESKTOP-010 groups Deployments / Secrets / company Settings under
 * More as one operations workspace (US-020 removed the Activity page; its
 * links remap to the company Overview digest).
 */

/**
 * Library routed sub-surfaces. The normal rows live in the Library secondary
 * sidebar; `submit` is owned by its persistent Publish footer. They all share
 * the `library` page + LibraryBrowser body, differing only by which tab is
 * forced. Defaults to 'skills' when a library route carries no tab.
 * Marketplace is top-level now (US-007), not a Library tab.
 */
export type LibraryTab = 'skills' | 'workers' | 'installed' | 'submit' | 'profile';

export const DEFAULT_LIBRARY_TAB: LibraryTab = 'skills';

/**
 * Company page sections — all route-supported company surfaces.
 * DESKTOP-001 primary sidebar shows a compact subset (see
 * COMPANY_PRIMARY_SECTIONS), including the existing Skills and Workers panels.
 * DESKTOP-010 operational tabs (deployments / secrets / settings)
 * open under More. Defaults to 'overview' when a company route carries no tab.
 * Legacy deep-links remap in resolvePendingDesktopRoute / normalizeCompanyTab.
 */
export type CompanyTab =
  | 'overview'
  | 'goals'
  | 'projects'
  | 'skills'
  | 'workers'
  | 'knowledge'
  | 'team'
  | 'deployments'
  | 'secrets'
  | 'settings';

/** Internal destinations of the company-scoped operations workspace (DESKTOP-010; US-020 removed Activity). */
export type CompanyOperationsTab = 'deployments' | 'secrets' | 'settings';

export const DEFAULT_COMPANY_TAB: CompanyTab = 'overview';
export const DEFAULT_COMPANY_OPERATIONS_TAB: CompanyOperationsTab = 'deployments';

/** Primary company children expanded under the selected company (DESKTOP-001). */
export type CompanyPrimarySectionId =
  | 'overview'
  | 'goals'
  | 'projects'
  | 'skills'
  | 'workers'
  | 'knowledge'
  | 'team'
  | 'more';

/**
 * Legacy company-tab ids that still appear in deep links / pending routes.
 * remapped so old bookmarks do not 404 the secondary sidebar.
 */
const LEGACY_COMPANY_TAB_REDIRECT: Readonly<Record<string, CompanyTab>> = {
  accounts: 'overview',
  tasks: 'projects',
  library: 'skills',
  // US-020: the Activity page is gone — its digest lives on Overview.
  activity: 'overview',
  // "more" is a primary-nav alias for the first operational section.
  more: DEFAULT_COMPANY_OPERATIONS_TAB,
};

/** Normalize a company tab string (including legacy ids) to a live CompanyTab. */
export function normalizeCompanyTab(value: string | undefined | null): CompanyTab | undefined {
  if (!value) return undefined;
  if (isCompanyTab(value)) return value;
  return LEGACY_COMPANY_TAB_REDIRECT[value];
}

/** True when the company tab is one of the operations destinations. */
export function isCompanyOperationsTab(
  tab: CompanyTab | undefined | null,
): tab is CompanyOperationsTab {
  return tab === 'deployments' || tab === 'secrets' || tab === 'settings';
}

/**
 * Map a routed company tab onto the primary sidebar child that should light.
 * All operations destinations highlight More.
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
    case 'deployments':
    case 'secrets':
    case 'settings':
      return 'more';
    default:
      return null;
  }
}

/** Resolve a primary sidebar child click to the company tab it opens. */
export function companyTabForPrimarySection(id: CompanyPrimarySectionId): CompanyTab {
  // More opens the operations workspace on its default destination (Deployments).
  return id === 'more' ? DEFAULT_COMPANY_OPERATIONS_TAB : id;
}

/** Settings sections — one visible at a time in the single-pane Settings page (US-020). */
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
  | {
      kind:
        | 'home'
        | 'notifications'
        | 'messages'
        | 'meetings'
        | 'marketplace'
        | 'moderation';
    }
  | { kind: 'library'; tab?: LibraryTab }
  | { kind: 'settings'; tab?: SettingsTab }
  | { kind: 'files'; slug?: string; path?: string }
  | { kind: 'company'; slug: string; tab?: CompanyTab };

export type DesktopRouteKind = DesktopRoute['kind'];

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
 * company-detail-desktop-ia + DESKTOP-001: Skills/Workers stay visible as
 * company-scoped primary children. DESKTOP-010: deployments / secrets /
 * settings are the operations destinations under More (US-020 removed Activity).
 */
export const COMPANY_SECTIONS: ReadonlyArray<{ id: CompanyTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'goals', label: 'Goals' },
  { id: 'projects', label: 'Projects' },
  { id: 'skills', label: 'Skills' },
  { id: 'workers', label: 'Workers' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'team', label: 'Team' },
  { id: 'deployments', label: 'Deployments' },
  { id: 'secrets', label: 'Secrets' },
  { id: 'settings', label: 'Settings' },
];

/**
 * Compact internal destinations of the company operations workspace (DESKTOP-010).
 * Rendered inside CompanyOperationsPanel — not as permanent primary sidebar
 * children and not as a permanent secondary sidebar.
 */
export const COMPANY_OPERATIONS_SECTIONS: ReadonlyArray<{
  id: CompanyOperationsTab;
  label: string;
  meta: string;
}> = [
  { id: 'deployments', label: 'Deployments', meta: 'Artifacts and services' },
  { id: 'secrets', label: 'Secrets', meta: 'Metadata only' },
  { id: 'settings', label: 'Settings', meta: 'Console workflows' },
];

/**
 * Compact primary company children shown under the selected company (DESKTOP-001).
 * More opens the operations workspace (default Deployments); all operations
 * destinations remain deep-linkable and light More when active (DESKTOP-010).
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
  { id: 'more', label: 'More' },
];

/** The four Library secondary-sidebar rows, in SPEC display order. */
export const LIBRARY_SECTIONS: ReadonlyArray<{ id: LibraryTab; label: string }> = [
  { id: 'skills', label: 'Skills' },
  { id: 'workers', label: 'Workers' },
  { id: 'installed', label: 'Installed' },
  { id: 'profile', label: 'Profile' },
];

/** Settings section index — the in-page single-pane list (US-020), also the ⌘K entries. */
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
 * eight sections swap panels inside the page (keyed there), so switching
 * sections never tears down the page chrome. The library likewise keys on the
 * surface, not the tab, so tab switches don't refetch the library tree.
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
 * The company slug the native `DesktopSessionScope` read gate should be bound
 * to for the current route (via `set_desktop_active_company`).
 *
 * The rule is: bind the workspace being VIEWED. Files mode binds its (already
 * membership-validated) company filter; a company/workspace route binds that
 * workspace's slug; every other surface unbinds.
 *
 * Deliberately independent of the workspace's sync-enabled state. The original
 * PR #309 derivation left the scope UNBOUND whenever sync was paused/disabled
 * on the viewed company — which does not tighten anything (Rust-side
 * membership authorization in `require_company_file_access` is independent and
 * still fail-closed), it just made EVERY same-company local read fail with
 * `company scope not bound`, breaking knowledge/files/board surfaces for
 * local-only and sync-paused companies. Binding the viewed company is the
 * strictly narrower state: reads outside that company remain cross-company
 * blocked by the gate.
 */
export function getDesktopSessionScopeSlug(
  route: DesktopRoute,
  companies: Workspace[],
  filesActiveSlug: string | null,
): string | null {
  if (route.kind === 'files') return filesActiveSlug;
  return getDesktopActiveCompany(route, companies)?.slug ?? null;
}

/** First ⌘ hotkey assigned to a company row (after the four primary destinations). */
const COMPANY_HOTKEY_BASE = 5;

/**
 * ⌘1–⌘4 map to the four primary destinations (Notifications / Meetings /
 * Marketplace / Library); ⌘5–⌘9 map to the first five companies in sidebar
 * (connected-first) order (US-008 renumber, no dead slots; US-018 remaps the
 * former Inbox hotkey onto Notifications). Home has no hotkey (palette-only).
 * Mirrors `companyHotkey` below for the palette labels.
 */
export function getDesktopHotkeyRoute(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey'>,
  companies: Workspace[],
): DesktopRoute | null {
  if (!(event.metaKey || event.ctrlKey)) return null;

  if (event.key === '1') return { kind: 'notifications' };
  if (event.key === '2') return { kind: 'meetings' };
  if (event.key === '3') return { kind: 'marketplace' };
  if (event.key === '4') return { kind: 'library' };

  const companyIndex = Number.parseInt(event.key, 10) - COMPANY_HOTKEY_BASE;
  if (companyIndex >= 0 && companyIndex <= 9 - COMPANY_HOTKEY_BASE) {
    const company = sortV4CompaniesConnectedFirst(companies)[companyIndex];
    if (company) return { kind: 'company', slug: company.slug };
  }

  return null;
}

/** ⌘ hotkey label for the company at `index` (sidebar order), or undefined past ⌘9. */
export function companyHotkey(index: number): string | undefined {
  const hotkeyNumber = COMPANY_HOTKEY_BASE + index;
  return hotkeyNumber <= 9 ? `⌘${hotkeyNumber}` : undefined;
}

/**
 * Resolve a backend navigation intent (desktop_alt_consume_pending_route /
 * the `desktop:navigate` event) to a route. Legacy aliases stay functional and
 * always land on a live route (US-018): never null for known legacy names.
 * Examples: 'sync' / 'activity' / 'core-drift' / 'drift' / 'mission-control'
 * → Home; 'inbox' → Notifications; 'library:marketplace' → Marketplace.
 */
export function resolvePendingDesktopRoute(name: string | null | undefined): DesktopRoute | null {
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
    if (!first) return { kind: 'files' };
    const rest = normalized.split(':').slice(2);
    if (rest.length === 0) return { kind: 'files', slug: first };
    return { kind: 'files', slug: first, path: rest.join('/') };
  }

  if (kind === 'company' && first) {
    // Live tabs + legacy redirects (accounts→overview, tasks→projects, library→skills).
    // `company:<slug>:knowledge` is a real company tab (inline Knowledge panel);
    // it is no longer aliased to top-level files mode.
    const tab = normalizeCompanyTab(second);
    return tab ? { kind: 'company', slug: first, tab } : { kind: 'company', slug: first };
  }

  if (kind === 'library') {
    if (first === 'marketplace') return { kind: 'marketplace' }; // legacy Library tab alias — Marketplace is top-level now (US-007)
    const tab = isLibraryTab(first) ? first : undefined;
    return tab ? { kind: 'library', tab } : { kind: 'library' };
  }

  if (kind === 'settings') {
    const tab = isSettingsTab(first) ? first : undefined;
    return tab ? { kind: 'settings', tab } : { kind: 'settings' };
  }

  switch (normalized) {
    case 'home':
    case 'sync':
    // US-004 WindowRouter: Activity digest + Core Drift card live on Home.
    // Top-level open_* wrappers land here instead of spawning windows.
    case 'activity':
    case 'core-drift':
    case 'drift':
    // US-018: mission-control deep link lands on Home.
    case 'mission-control':
      return { kind: 'home' };
    // US-018: inbox deep link lands on Notifications feed.
    case 'inbox':
    case 'notifications':
      return { kind: 'notifications' };
    case 'messages':
      return { kind: 'messages' };
    case 'meetings':
      return { kind: 'meetings' };
    case 'marketplace':
      return { kind: 'marketplace' };
    case 'moderation':
      return { kind: 'moderation' };
    case 'library':
      return { kind: 'library' };
    case 'settings':
      return { kind: 'settings' };
    default:
      return null;
  }
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
 * Narrow an open-ended V4Route payload back into the app's DesktopRoute union.
 * Unknown kinds land on Home — the exception surface. Company payloads may
 * carry a primary section / tab id (DESKTOP-001). US-018: legacy 'inbox' and
 * 'mission-control' kinds remap to live destinations.
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
    case 'mission-control':
      return { kind: 'home' };
    case 'inbox':
    case 'notifications':
      return { kind: 'notifications' };
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
 * US-020: NO surface renders a secondary sidebar anymore. Settings became a
 * single pane (section list navigates in place — see SettingsPage), Library is
 * a takeover overlay (US-017), and company navigation expands inline in the
 * primary sidebar (DESKTOP-001). This helper is retained so shell call sites
 * and specs can keep asserting the invariant: it must always return null.
 */
export function getDesktopSecondarySidebar(
  route: DesktopRoute,
  companies: Workspace[],
  options: DesktopSecondarySidebarOptions = {},
): DesktopSecondarySidebar | null {
  void route;
  void companies;
  void options;
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

/** Human relative timestamp ("just now", "5m ago") for status meta lines. */
export function formatRelativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
