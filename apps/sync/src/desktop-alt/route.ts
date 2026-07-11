import type { Workspace } from '../lib/workspaces';
import {
  sortV4CompaniesConnectedFirst,
  v4CompanyDotTone,
  type V4DotTone,
  type V4Route,
  type V4SecondaryFooter,
  type V4SecondaryItem,
} from './v4/model';

/**
 * V4 information architecture (docs/design/v4/SPEC.md section 4).
 *
 * Four primary destinations — Inbox, Meetings, Marketplace, Library — plus
 * Files, companies as first-class sidebar rows, and a Settings footer.
 * US-008 merged Messages + Notifications into the single Inbox surface.
 * Home / Mission Control / Moderation are palette-only routes with no sidebar
 * row; the Companies page is removed (companies are reached via their sidebar
 * rows). Company pages and the Library carry their sections in the secondary
 * sidebar rather than in-page segmented controls.
 */

/**
 * Library sub-surfaces — rows of the Library secondary sidebar. They all share
 * the `library` page + LibraryBrowser body, differing only by which tab is
 * forced. Defaults to 'skills' when a library route carries no tab.
 * Marketplace is top-level now (US-007), not a Library tab.
 */
export type LibraryTab = 'skills' | 'workers' | 'installed' | 'profile';

export const DEFAULT_LIBRARY_TAB: LibraryTab = 'skills';

/**
 * Company page sections — rows of the company secondary sidebar.
 * company-detail-desktop-ia: Accounts/Tasks/Library removed; Skills, Workers,
 * Knowledge, Team are first-class. Defaults to 'overview' when a company route
 * carries no tab. Legacy deep-links remap in resolvePendingDesktopRoute /
 * normalizeCompanyTab.
 */
export type CompanyTab =
  | 'overview'
  | 'goals'
  | 'projects'
  | 'skills'
  | 'workers'
  | 'knowledge'
  | 'team'
  | 'activity'
  | 'deployments'
  | 'secrets';

export const DEFAULT_COMPANY_TAB: CompanyTab = 'overview';

/**
 * Legacy company-tab ids that still appear in deep links / pending routes.
 * remapped so old bookmarks do not 404 the secondary sidebar.
 */
const LEGACY_COMPANY_TAB_REDIRECT: Readonly<Record<string, CompanyTab>> = {
  accounts: 'overview',
  tasks: 'projects',
  library: 'skills',
};

/** Normalize a company tab string (including legacy ids) to a live CompanyTab. */
export function normalizeCompanyTab(value: string | undefined | null): CompanyTab | undefined {
  if (!value) return undefined;
  if (isCompanyTab(value)) return value;
  return LEGACY_COMPANY_TAB_REDIRECT[value];
}

/** Settings sections — rows of the Settings secondary sidebar (US-013 fills the bodies). */
export type SettingsTab = 'sync' | 'notifications' | 'widget' | 'updates' | 'general' | 'meetings';

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'sync';

export type DesktopRoute =
  | { kind: 'home' | 'mission-control' | 'inbox' | 'meetings' | 'marketplace' | 'moderation' }
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
 * Company secondary-sidebar rows (company-detail-desktop-ia).
 * Accounts hidden; Tasks/Library removed; Skills/Workers/Knowledge/Team top-level.
 */
export const COMPANY_SECTIONS: ReadonlyArray<{ id: CompanyTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'goals', label: 'Goals' },
  { id: 'projects', label: 'Projects' },
  { id: 'skills', label: 'Skills' },
  { id: 'workers', label: 'Workers' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'team', label: 'Team' },
  { id: 'activity', label: 'Activity' },
  { id: 'deployments', label: 'Deployments' },
  { id: 'secrets', label: 'Secrets' },
];

/** The four Library secondary-sidebar rows, in SPEC display order. */
export const LIBRARY_SECTIONS: ReadonlyArray<{ id: LibraryTab; label: string }> = [
  { id: 'skills', label: 'Skills' },
  { id: 'workers', label: 'Workers' },
  { id: 'installed', label: 'Installed' },
  { id: 'profile', label: 'Profile' },
];

/** Settings secondary-sidebar rows; Meetings carries the muted gated note. */
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
  { id: 'meetings', label: 'Meetings', note: 'gated' },
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

/** First ⌘ hotkey assigned to a company row (after the four primary destinations). */
const COMPANY_HOTKEY_BASE = 5;

/**
 * ⌘1–⌘4 map to the four primary destinations (Inbox / Meetings / Marketplace /
 * Library); ⌘5–⌘9 map to the first five companies in sidebar (connected-first)
 * order (US-008 renumber, no dead slots). Home / Mission Control have no hotkey
 * (palette-only, US-007). Mirrors `companyHotkey` below for the palette labels.
 */
export function getDesktopHotkeyRoute(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey'>,
  companies: Workspace[],
): DesktopRoute | null {
  if (!(event.metaKey || event.ctrlKey)) return null;

  if (event.key === '1') return { kind: 'inbox' };
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
 * the `desktop:navigate` event) to a route. Legacy aliases stay functional:
 * 'sync' deep-links — the pre-V4 home surface — land on Home.
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
    // Knowledge is the company entry into files mode (not a separate panel).
    if (second === 'knowledge') {
      return { kind: 'files', slug: first };
    }
    // Live tabs + legacy redirects (accounts→overview, tasks→projects, library→skills).
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
      return { kind: 'home' };
    case 'mission-control':
      return { kind: 'mission-control' };
    case 'inbox':
    // legacy aliases — Messages and Notifications merged into Inbox (US-008)
    case 'messages':
    case 'notifications':
      return { kind: 'inbox' };
    case 'meetings':
      return { kind: 'meetings' };
    case 'marketplace':
      return { kind: 'marketplace' };
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
  return LIBRARY_SECTIONS.some((section) => section.id === value);
}

function isSettingsTab(value: string | undefined): value is SettingsTab {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

/**
 * Narrow a V4Sidebar navigation payload (open-ended V4Route) back into the
 * app's DesktopRoute union. Unknown kinds land on Home — the exception surface.
 */
export function fromV4Route(route: V4Route): DesktopRoute {
  if (route.kind === 'company' && route.slug) {
    return { kind: 'company', slug: route.slug };
  }
  switch (route.kind) {
    case 'home':
      return { kind: 'home' };
    case 'mission-control':
      return { kind: 'mission-control' };
    case 'inbox':
    case 'messages':
    case 'notifications':
      return { kind: 'inbox' };
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
 * SPEC section 4: the secondary sidebar exists ONLY on company, Library, and
 * Settings surfaces. Home, Mission Control, Marketplace, Meetings, Inbox, and
 * Moderation have none. A company route whose slug isn't connected yet renders
 * no secondary column either (the body shows the not-synced placeholder).
 */
export function getDesktopSecondarySidebar(
  route: DesktopRoute,
  companies: Workspace[],
  options: DesktopSecondarySidebarOptions = {},
): DesktopSecondarySidebar | null {
  if (route.kind === 'company') {
    const company = getDesktopActiveCompany(route, companies);
    if (!company) return null;
    const stateMeta = formatCompanyStateMeta(company);
    return {
      surface: 'company',
      header: company.displayName,
      headerTone: v4CompanyDotTone(company),
      meta:
        [formatCompanyRole(company), stateMeta]
          .filter(Boolean)
          .join(' · ') || null,
      items: COMPANY_SECTIONS.map(({ id, label }) => ({ id, label })),
      activeId: route.tab ?? DEFAULT_COMPANY_TAB,
      footer: { label: 'Company settings', meta: 'sync rules · members · roles' },
    };
  }

  if (route.kind === 'library') {
    return {
      surface: 'library',
      header: 'Library',
      headerTone: null,
      meta: formatHqFolderMeta(options.hqFolderPath),
      items: LIBRARY_SECTIONS.map(({ id, label }) => ({ id, label })),
      activeId: route.tab ?? DEFAULT_LIBRARY_TAB,
      footer: { label: 'Publish a pack' },
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

export function formatHqFolderMeta(path: string | null | undefined): string {
  const trimmed = path?.trim();
  if (!trimmed) return 'HQ folder';
  return trimmed.replace(/^\/Users\/[^/]+/, '~');
}

function formatCompanyRole(company: Workspace): string | null {
  if (company.kind === 'personal') return 'Personal';
  const role = company.role?.trim();
  if (!role) return 'Member';
  return role.slice(0, 1).toUpperCase() + role.slice(1).toLowerCase();
}

function formatCompanyStateMeta(company: Workspace): string | null {
  if (company.kind === 'personal') {
    const lastSync = formatRelativeTime(company.lastSyncedAt);
    return lastSync ? `synced ${lastSync}` : 'local vault';
  }
  switch (company.state) {
    case 'synced': {
      const lastSync = formatRelativeTime(company.lastSyncedAt);
      return lastSync ? `synced ${lastSync}` : 'synced just now';
    }
    case 'local-only':
      return 'local only';
    case 'cloud-only':
      return 'not on this Mac';
    case 'broken':
      return 'needs reconnect';
    default:
      return null;
  }
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
