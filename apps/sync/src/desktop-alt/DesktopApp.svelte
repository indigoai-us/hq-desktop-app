<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { onDestroy, onMount, tick } from 'svelte';
  import { loadMeetingsCache } from '../lib/meetingsCache';
  import {
    MESSAGE_PERSON_EVENT,
    requestConversation,
    type ConversationTarget,
  } from '../lib/pendingConversation';
  import { buildPrompt } from '../lib/copy-prompts';
  import { effectiveTotalFiles as computeEffectiveTotalFiles } from '../lib/effective-total-files';
  import { sanitizeVisibleIdentifiers } from '../lib/visible-labels';
  import { safeUnlisten, subscribeWindowFocus } from '../lib/listener-registry';
  import {
    isWorkspaceSyncEnabled,
    type Workspace,
    type WorkspacesResult,
  } from '../lib/workspaces';
  import {
    applyBrandToDocument,
    cacheLogoAssets,
    readBrandCache,
    syncBrandFromWorkspaces,
    type CachedBrand,
  } from '../lib/brand';
  import HomePage from './pages/HomePage.svelte';
  import SetupIncompleteCard from './components/SetupIncompleteCard.svelte';
  import MeetingsPage from './pages/MeetingsPage.svelte';
  import LibraryOverlay from './chat/LibraryOverlay.svelte';
  import MarketplacePage from './pages/MarketplacePage.svelte';
  import MessagesShell from '../components/messaging/MessagesShell.svelte';
  import CompanyPage from './pages/CompanyPage.svelte';
  import SettingsPage from './pages/SettingsPage.svelte';
  import ModerationPanel from './panels/ModerationPanel.svelte';
  import { startMeetingsStore } from './lib/meetings-store.svelte';
  import { loadLocalProjects } from './lib/local-projects';
  import {
    fileAccessibleCompanies,
    isFilesRouteAllowed,
  } from './lib/file-tree';
  import { LatestRequestCoordinator, type LatestRequestCheck } from './lib/latest-request';
  import type { Project } from './lib/projects-model';
  import { emitDesktopTelemetry } from '../lib/desktop-telemetry';
  import {
    invalidateCompanyResources,
    setActiveCompanyResource,
    startCompanyStore,
    type CompanyResource,
  } from './lib/company-store.svelte';
  import { openAgentWorkflow } from './lib/agent-workflow';
  import {
    COMPANY_SECTIONS,
    LIBRARY_SECTIONS,
    SETTINGS_SECTIONS,
    companyHotkey,
    DEFAULT_COMPANY_TAB,
    DEFAULT_LIBRARY_TAB,
    DEFAULT_SETTINGS_TAB,
    formatRelativeTime,
    fromV4Route,
    getDesktopActiveCompany,
    getDesktopCompanies,
    getDesktopHotkeyRoute,
    getDesktopLandingRoute,
    getDesktopRouteKey,
    resolvePendingDesktopRoute,
    type CompanyTab,
    type DesktopRoute,
    type LibraryTab,
    type SettingsTab,
  } from './route';
  import {
    accountIdentityFromWorkspaces,
    sortV4CompaniesConnectedFirst,
    type V4HydrationIssue,
    V4_CHROME_LAYOUT,
  } from './v4/model';
  import {
    loadCloudPaused,
    readCloudPaused,
    setCloudPaused,
  } from './lib/cloud-connection';
  import type {
    HomeConflict,
    HomeCoreState,
    HomeDeleteRefusal,
  } from './v4/home-model';
  // US-003 / US-018: ChatSidebar is the primary conversation surface.
  import ChatSidebar from './chat/ChatSidebar.svelte';
  import NotificationsView from './chat/NotificationsView.svelte';
  import { parseNotificationsResponse } from './chat/notifications-model';
  import {
    companyLabelFor,
    conversationKindLabel,
    loadConversationCache,
    normalizeConversations,
    type ConversationRow,
    type DmContactInput,
  } from './chat/sidebar-model';
  import { requestChannelOpen } from './chat/open-target';
  import type { Channel } from '../lib/channels';
  import FilesModeSidebar from './v4/FilesModeSidebar.svelte';
  import FilePreviewPane from './components/FilePreviewPane.svelte';
  import V4TitleBar from './v4/V4TitleBar.svelte';
  import CommandPalette, {
    type CommandPaletteItem,
  } from './components/CommandPalette.svelte';
  import {
    type GoogleAccount,
    type GoogleCalendar,
    type MeetingEvent,
    type ScheduledBot,
  } from './lib/meetings-model';
  import {
    emptyWorkspaceStats,
    friendlySyncError,
    type ActivityEntry,
    type DaemonStatus,
    type SyncCompanyRef,
    type SyncProgress,
    type SyncState,
    type SyncStatus,
    type WorkspaceSyncStats,
  } from './lib/sync-model';
  import './styles/desktop-alt.css';

  const WORKSPACE_CACHE_KEY = 'hq-sync.desktop.workspaces.v1';
  const ROUTE_CACHE_KEY = 'hq-sync.desktop.route.v1';
  const LAST_COMPANY_CACHE_KEY = 'hq-sync.desktop.last-company.v1';

  // Last-visited company slug (US-007) — the desktop lands here on next open.
  function readLastCompanySlug(): string | null {
    try {
      return window.localStorage.getItem(LAST_COMPANY_CACHE_KEY);
    } catch {
      return null;
    }
  }

  // Reload survival for Files mode (US-009): persist the files route so a
  // desktop-alt window reload returns to the same company + selected file. Only
  // Files-mode routes are persisted; the backend pending-route always wins on
  // mount (read below), so this is a fallback, not a competitor.
  function readStoredFilesRoute(): DesktopRoute | null {
    try {
      const raw = window.localStorage.getItem(ROUTE_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.kind !== 'files') return null;
      const slug = typeof parsed.slug === 'string' ? parsed.slug : undefined;
      const path = typeof parsed.path === 'string' ? parsed.path : undefined;
      return { kind: 'files', slug, path };
    } catch {
      return null;
    }
  }

  function readCachedWorkspaces(): Workspace[] {
    try {
      const raw = window.localStorage.getItem(WORKSPACE_CACHE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is Workspace =>
          item &&
          typeof item.slug === 'string' &&
          typeof item.displayName === 'string' &&
          (item.kind === 'personal' || item.kind === 'company'),
      );
    } catch {
      return [];
    }
  }

  function writeCachedWorkspaces(items: Workspace[]) {
    try {
      window.localStorage.setItem(WORKSPACE_CACHE_KEY, JSON.stringify(items));
    } catch {
      // Best-effort bootstrap cache only.
    }
  }

  const cachedWorkspaces = readCachedWorkspaces();
  const cachedCompanies = getDesktopCompanies(cachedWorkspaces);

  // White-label brand (US-005) — seed from cache for offline, refresh on workspace load.
  let brand = $state<CachedBrand | null>(null);
  {
    const seed = readBrandCache();
    if (seed) {
      brand = seed;
      applyBrandToDocument(seed);
    }
  }

  // The persisted last-visited slug, frozen at startup: the auto-landing must
  // keep honoring the value from the PREVIOUS session even while this session's
  // provisional (cache-based) landing settles (US-007).
  const initialLastCompanySlug = readLastCompanySlug();
  let route = $state<DesktopRoute>(
    getDesktopLandingRoute(cachedWorkspaces, initialLastCompanySlug),
  );
  // True once the user (or a pending backend intent) navigated explicitly — the
  // landing re-resolve in loadWorkspaces() must not clobber it (US-007).
  let userNavigated = false;
  // True after the first LIVE workspace load has confirmed the landing. Later
  // background refreshes (focus, post-sync) must never move an idle user just
  // because the company list changed shape.
  let landingResolved = false;
  // Admin gate for the Moderation nav entry (UX only; the server is the sole
  // authorization boundary). DEFAULT-DENY: starts false and only flips true on an
  // explicit `desktop_alt_is_admin === true` (@getindigo.ai), so the row never
  // flashes for a non-admin and stays hidden on any check error. Reuses the same
  // signal ModerationPanel itself gates on.
  let isAdmin = $state(false);
  let workspaces = $state<Workspace[]>(cachedWorkspaces);
  let workspaceError = $state<string | null>(null);
  let workspaceManifestError = $state<string | null>(null);
  let syncStatusError = $state<string | null>(null);
  let syncState = $state<SyncState>('idle');
  let manualSyncTelemetryPending = $state(false);
  let syncProgress = $state<SyncProgress | null>(null);
  let syncFanoutTotal = $state(0);
  let syncFanoutDoneCount = $state(0);
  let syncCompanies = $state<SyncCompanyRef[]>([]);
  let syncFilesProgressed = $state(0);
  let syncTotalFiles = $state(0);
  let syncPlanTotalFiles = $state(0);
  // True once a `sync:plan` event has arrived — see effective-total-files.ts.
  let syncPlanReceived = $state(false);
  let syncFanoutFilesSkipped = $state(0);
  let syncLastSummary = $state<{
    companiesAttempted: number;
    filesDownloaded: number;
    bytesDownloaded: number;
    filesSkipped: number;
  } | null>(null);
  let syncErrorMessage = $state('');
  // Company the failing run reported (when `sync:error` carried one) — drives
  // the Home error card's "Sync failed for {company}" framing.
  let syncErrorCompany = $state<string | null>(null);
  // Epoch ms when the running sync started — Home's syncing meta line.
  let syncStartedAt = $state<number | null>(null);
  // Unresolved conflicts from the `sync:conflict` stream → Home's NEEDS YOU
  // queue (Keep mine / Take theirs / Compare). Cleared when a new run starts —
  // the runner re-emits anything still conflicted.
  let homeConflicts = $state<HomeConflict[]>([]);
  // Current runners report conflicts only as an aggregate on sync:complete.
  // Keep the deprecated per-file queue above for older backends, but never let
  // the modern event contract produce a silent conflict state.
  let syncConflictCount = $state(0);
  let syncConflictCompany = $state<string | null>(null);
  let syncDeleteRefusals = $state<HomeDeleteRefusal[]>([]);
  // Core drift snapshot (`check_core_state` + `core-state:changed`) → Home's
  // drift card (Restore / Keep edit / View diff). `driftDismissed` is the
  // session-local "Keep edit" ack; a fresh scan re-surfaces the card.
  let coreState = $state<HomeCoreState | null>(null);
  let driftDismissed = $state(false);
  let driftRestoring = $state(false);
  // Local hq-core version ("15.0.15") for Home's meta line; null = unreadable.
  let hqVersion = $state<string | null>(null);
  // V2 Cloud Off (US-001 / US-016): mirror-first for instant render; settings
  // (menubar.json — the store the Rust sync gates read) is authoritative.
  let cloudPaused = $state(readCloudPaused());
  // Resolved HQ folder from get_config, used for path labels and handoffs.
  let hqFolderPath = $state<string | null>(null);
  // `realtimeSync` preference (auto-sync cadence in Home's meta line).
  let autoSyncOn = $state<boolean | null>(null);
  let statsBySlug = $state<Record<string, WorkspaceSyncStats>>({});
  let activity = $state<ActivityEntry[]>([]);
  let status = $state<SyncStatus | null>(null);
  let daemon = $state<DaemonStatus | null>(null);
  // Flips true once the newest real-state load (workspaces + status + activity)
  // resolves, so a superseded mount request cannot keep the shell skeletonized.
  let ready = $state(false);
  // Files is a raw filesystem surface, so generic desktop hydration is not an
  // access grant. It stays fail-closed until the newest workspace request has
  // successfully hydrated authoritative cloud membership state. Cached
  // workspaces may paint chrome, but can never authorize a tree or preview.
  let filesAccessHydrated = $state(false);
  let filesAccessSettled = $state(false);
  let refreshingRealState = $state(false);
  const refreshCoordinator = new LatestRequestCoordinator();
  let commandPaletteOpen = $state(false);
  /** Conversations for ⌘K CONVERSATIONS section (cache-first, refreshed on open). */
  let paletteConversations = $state<ConversationRow[]>(
    (() => {
      const cache =
        typeof window !== 'undefined' ? loadConversationCache(window.localStorage) : null;
      if (!cache) return [];
      return normalizeConversations(
        cache.channels as Channel[],
        cache.contacts as DmContactInput[],
      );
    })(),
  );
  let navigationPending = $state(false);
  let navigationSequence = 0;
  let desktopDestroyed = false;
  // DESKTOP-001: primary sidebar can collapse; titlebar owns the toggle.
  let sidebarCollapsed = $state(false);
  let meetingEvents = $state<MeetingEvent[]>([]);
  // Local projects across every company — ONE `get_local_projects` scan (no
  // per-company vault fan-out), feeding the Home portfolio stats + table.
  let homeProjects = $state<Project[]>([]);
  let meetingCompanyNamesByUid = $state<Map<string, string>>(new Map());
  let desktopRenderAuditQueued = false;

  let companies = $state<Workspace[]>(cachedCompanies);
  let renderCompanies = $state<Workspace[]>(cachedCompanies);
  // Vault reachability from the last list_syncable_workspaces load — gates the
  // sidebar Shared/All writes and the company-page Connect action (US-009).
  let cloudReachable = $state(true);
  let renderWorkspaceCount = $state(cachedCompanies.length);
  const shellCompanies = $derived(
    renderCompanies.length > 0
      ? renderCompanies
      : companies.length > 0
        ? companies
        : getDesktopCompanies(workspaces),
  );
  const orderedCompanies = $derived(sortV4CompaniesConnectedFirst(shellCompanies));
  const watchedCompanies = $derived(
    shellCompanies.filter((workspace) => isWorkspaceSyncEnabled(workspace)),
  );
  const watchedWorkspaceCount = $derived(watchedCompanies.length);
  const accountIdentity = $derived(accountIdentityFromWorkspaces(shellCompanies));
  const routeKey = $derived(getDesktopRouteKey(route));
  const activeCompany = $derived(getDesktopActiveCompany(route, shellCompanies));
  const activeCompanySyncEnabled = $derived(isWorkspaceSyncEnabled(activeCompany));
  const libraryTab = $derived<LibraryTab>(
    route.kind === 'library' ? route.tab ?? DEFAULT_LIBRARY_TAB : DEFAULT_LIBRARY_TAB,
  );
  const companyTab = $derived<CompanyTab>(
    route.kind === 'company' ? route.tab ?? DEFAULT_COMPANY_TAB : DEFAULT_COMPANY_TAB,
  );
  const polledCompanyResource = $derived<CompanyResource | null>(
    companyTab === 'deployments' || companyTab === 'secrets'
      ? companyTab
      : companyTab === 'overview'
        ? 'summary'
        : null,
  );
  $effect(() => {
    setActiveCompanyResource(
      activeCompanySyncEnabled ? activeCompany?.slug ?? null : null,
      activeCompanySyncEnabled ? polledCompanyResource : null,
    );
  });
  // Files mode (US-009): the active company + selected file live IN THE ROUTE,
  // so they survive a reload (persisted below) and reactive updates don't
  // remount the shell (routeKey is 'files' regardless of slug/path).
  const filesCompanies = $derived(
    filesAccessHydrated ? fileAccessibleCompanies(renderCompanies) : [],
  );
  const filesRouteAllowed = $derived(
    route.kind === 'files' &&
      filesAccessHydrated &&
      isFilesRouteAllowed(
        { slug: route.slug ?? null, path: route.path ?? null },
        filesCompanies,
      ),
  );
  const filesActiveSlug = $derived<string | null>(
    filesRouteAllowed && route.kind === 'files' ? route.slug ?? null : null,
  );
  const filesSelectedPath = $derived<string | null>(
    filesRouteAllowed && route.kind === 'files' ? route.path ?? null : null,
  );
  const sessionBoundCompanySlug = $derived<string | null>(
    route.kind === 'files'
      ? filesActiveSlug
      : activeCompanySyncEnabled
        ? activeCompany?.slug ?? null
        : null,
  );
  $effect(() => {
    void invoke('set_desktop_active_company', {
      companySlug: sessionBoundCompanySlug,
    });
  });
  // A persisted or native deep link can predate the latest membership state.
  // Once hydration confirms the route targets a pending/unknown company, clear
  // its scope and selected file before any raw filesystem surface can mount.
  $effect(() => {
    if (!filesAccessSettled || route.kind !== 'files') return;
    if (
      filesAccessHydrated &&
      isFilesRouteAllowed(
        { slug: route.slug ?? null, path: route.path ?? null },
        filesCompanies,
      )
    ) {
      return;
    }
    route = { kind: 'files' };
  });
  const effectiveTotalFiles = $derived(
    computeEffectiveTotalFiles({
      planReceived: syncPlanReceived,
      syncPlanTotalFiles,
      syncTotalFiles,
    }),
  );
  const commandItems = $derived<CommandPaletteItem[]>([
    {
      id: 'command-sync-now',
      label: 'Sync now',
      detail: 'Start a full workspace sync',
      action: handleSyncAll,
    },
    {
      id: 'command-open-settings',
      label: 'Open settings',
      detail: 'Open sync settings',
      action: handleOpenSettings,
    },
    {
      id: 'command-deploy',
      label: activeCompany ? `Deploy a result for ${activeCompany.displayName}` : 'Deploy a result',
      detail: 'Open the HQ deploy workflow in Claude Code',
      action: () => runDesktopWorkflow('deploy'),
    },
    {
      id: 'command-share',
      label: 'Share a file',
      detail: 'Mint an encrypted single-use share link',
      action: () => runDesktopWorkflow('share'),
    },
    {
      id: 'command-run-worker',
      label: activeCompany ? `Run a worker for ${activeCompany.displayName}` : 'Run a worker',
      detail: 'Hand work to a specialized agent',
      action: () => runDesktopWorkflow('run-worker'),
    },
    {
      id: 'command-go-home',
      label: 'Go to Home',
      detail: 'Sync health and activity',
      action: () => navigate({ kind: 'home' }),
    },
    {
      id: 'command-go-notifications',
      label: 'Go to Notifications',
      detail: 'Notifications, mentions, shares, and activity',
      shortcut: '⌘1',
      action: () => navigate({ kind: 'notifications' }),
    },
    {
      id: 'command-go-messages',
      label: 'Go to Messages',
      detail: 'Conversations, channels, requests, and shared paths',
      action: () => navigate({ kind: 'messages' }),
    },
    {
      id: 'command-go-meetings',
      label: 'Go to Meetings',
      detail: 'Show calendar and recordings',
      shortcut: '⌘2',
      action: () => navigate({ kind: 'meetings' }),
    },
    {
      id: 'command-go-marketplace',
      label: 'Go to Marketplace',
      detail: 'Discover and install skills and workers',
      shortcut: '⌘3',
      action: () => navigate({ kind: 'marketplace' }),
    },
    {
      id: 'command-go-library',
      label: 'Go to Library',
      detail: 'Skills, workers, and installed packs',
      shortcut: '⌘4',
      action: () => openLibrary({ kind: 'library' }),
    },
    ...LIBRARY_SECTIONS.filter((section) => section.id !== DEFAULT_LIBRARY_TAB).map(
      (section) => ({
        id: `command-go-library-${section.id}`,
        label: `Go to Library ${section.label}`,
        detail: `Show ${section.label.toLowerCase()} in the library`,
        action: () => openLibrary({ kind: 'library', tab: section.id }),
      }),
    ),
    {
      id: 'command-go-files',
      label: 'Go to Files',
      detail: 'Browse a company vault and preview files',
      action: () => navigate({ kind: 'files' }),
    },
    {
      id: 'command-go-settings',
      label: 'Go to Settings',
      detail: 'Sync preferences and account',
      action: () => navigate({ kind: 'settings' }),
    },
    ...SETTINGS_SECTIONS.filter((section) => section.id !== DEFAULT_SETTINGS_TAB).map(
      (section) => ({
        id: `command-go-settings-${section.id}`,
        label: `Go to Settings ${section.label}`,
        detail: `Open ${section.label.toLowerCase()} settings`,
        action: () => navigate({ kind: 'settings', tab: section.id }),
      }),
    ),
    // Admin-only (default-deny) — Moderation has no sidebar row in the V4 IA,
    // so the palette is its navigation surface.
    ...(isAdmin
      ? [
          {
            id: 'command-go-moderation',
            label: 'Go to Moderation',
            detail: 'Review marketplace submissions',
            action: () => navigate({ kind: 'moderation' }),
          },
        ]
      : []),
    // Companies start at ⌘5 (after the four primary destinations), in sidebar
    // (connected-first) order.
    ...orderedCompanies.map((row, index) => ({
      id: `command-go-company-${row.slug}`,
      label: `Go to ${row.label}`,
      detail: 'Show company overview',
      shortcut: companyHotkey(index),
      action: () => navigate({ kind: 'company', slug: row.slug }),
    })),
    // Keep the palette useful with hundreds of companies: expose every company
    // root, but only materialize deep section commands for the active company.
    ...(activeCompany
      ? COMPANY_SECTIONS.filter((section) => section.id !== DEFAULT_COMPANY_TAB).map(
          (section) => ({
            id: `command-go-company-${activeCompany.slug}-${section.id}`,
            label: `Go to ${activeCompany.displayName} ${section.label}`,
            detail: `Show ${activeCompany.displayName} ${section.label.toLowerCase()}`,
            action: () =>
              navigate({ kind: 'company', slug: activeCompany.slug, tab: section.id }),
          }),
        )
      : []),
    // Cross-company conversations (US-013) — type-tagged + company label; the
    // palette ranks these by match then recency under a CONVERSATIONS section.
    ...paletteConversations.map((row) => {
      const kind = conversationKindLabel(row.kind);
      const company = companyLabelFor(
        row.companyUid,
        (renderCompanies ?? [])
          .filter((w) => w.kind !== 'personal' && w.cloudUid)
          .map((w) => ({
            companyUid: w.cloudUid as string,
            label: w.displayName?.trim() || w.slug,
          })),
      );
      return {
        id: `conversation-${row.id}`,
        label: row.title,
        detail: company ? `${kind} · ${company}` : kind,
        lastActivityAt: row.lastActivityAt,
        action: () => openPaletteConversation(row),
      };
    }),
  ]);

  // Plain-language error summary for the V4 title bar's error state.
  const titleBarErrorSummary = $derived(
    syncErrorMessage ? friendlySyncError(syncErrorMessage).summary : null,
  );
  const titleBarHydrationIssue = $derived<V4HydrationIssue | null>(
    workspaceError
      ? { kind: 'workspace-list', detail: workspaceError }
      : workspaceManifestError
        ? { kind: 'manifest', detail: workspaceManifestError }
        : syncStatusError
          ? { kind: 'sync-status', detail: syncStatusError }
          : null,
  );

  const lastSyncLabel = $derived(formatRelativeTime(status?.lastSyncAt ?? null));

  // Live transfer total for Home's syncing progress card.
  const syncTransferredBytes = $derived(
    Object.values(statsBySlug).reduce((sum, stats) => sum + stats.transferredBytes, 0),
  );

  // The last non-Files route, remembered so the Files-mode exit control can
  // return the user to where they were (default Home). Updated on every
  // navigation AWAY from a non-files route (US-010).
  let routeBeforeFiles = $state<DesktopRoute>({ kind: 'home' });

  // US-012: previous route for Notifications Back, plus bell unread badge.
  let routeBeforeNotifications = $state<DesktopRoute>({ kind: 'home' });
  let notificationsUnreadCount = $state(0);

  // US-017: previous route for Library overlay Back (fallback notifications/home).
  let routeBeforeLibrary = $state<DesktopRoute>({ kind: 'notifications' });

  function openNotifications(): void {
    if (route.kind !== 'notifications') {
      routeBeforeNotifications = route;
    }
    navigate({ kind: 'notifications' });
  }

  function exitNotifications(): void {
    navigate(routeBeforeNotifications ?? { kind: 'home' });
  }

  function openLibrary(next: DesktopRoute = { kind: 'library' }): void {
    navigate(next);
  }

  function exitLibrary(): void {
    const fallback =
      routeBeforeLibrary.kind === 'library'
        ? ({ kind: 'notifications' } satisfies DesktopRoute)
        : routeBeforeLibrary;
    navigate(fallback);
  }

  async function refreshNotificationsBadge(): Promise<void> {
    try {
      const raw = await invoke<unknown>('fetch_notifications', {
        limit: 1,
        cursor: null,
        unreadOnly: false,
      });
      const parsed = parseNotificationsResponse(raw);
      notificationsUnreadCount = parsed.unreadCount;
    } catch (err) {
      // Absent endpoint / auth miss: hide the badge rather than surface noise.
      console.error('desktop: fetch_notifications badge failed', err);
    }
  }

  function mapMessagesTarget(payload: {
    personUid?: string;
    email?: string;
    displayName?: string;
  }): ConversationTarget {
    return {
      personUid: payload.personUid?.trim() ?? '',
      email: payload.email?.trim() ?? '',
      displayName: payload.displayName?.trim() ?? '',
    };
  }

  function handleMessagePerson(): void {
    // Leave the stashed target intact: the Messages shell consumes it after
    // this navigation mounts the full conversation workspace.
    navigate({ kind: 'messages' });
  }

  function afterPaint(): Promise<void> {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resolve());
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  async function commitNavigation(nextRoute: DesktopRoute, sequence: number): Promise<void> {
    // First commit the pending indicator, then wait for an actual paint before
    // mounting the destination. This makes feedback visible even when the next
    // route has a large synchronous render.
    await tick();
    await afterPaint();
    if (desktopDestroyed || sequence !== navigationSequence) return;

    if (nextRoute.kind === 'files' && route.kind !== 'files') {
      routeBeforeFiles = route;
    }
    route = nextRoute;

    // Clear only after Svelte has committed the destination and the browser has
    // had a paint opportunity. A newer navigation owns the indicator if one
    // arrived while this route was mounting.
    await tick();
    await afterPaint();
    if (!desktopDestroyed && sequence === navigationSequence) {
      navigationPending = false;
    }
  }

  function navigate(nextRoute: DesktopRoute) {
    // US-017: remember where we came from so Library overlay Back works for
    // hotkeys, palette, and sidebar destinations alike.
    if (nextRoute.kind === 'library' && route.kind !== 'library') {
      routeBeforeLibrary = route;
    }
    userNavigated = true;
    const sequence = ++navigationSequence;
    navigationPending = true;
    void commitNavigation(nextRoute, sequence);
  }

  onDestroy(() => {
    desktopDestroyed = true;
    navigationSequence += 1;
  });

  /** Leave Files mode, restoring the view the user came from (default Home). */
  function exitFilesMode() {
    navigate(routeBeforeFiles ?? { kind: 'home' });
  }

  function navigateFilesCompany(slug: string | null) {
    if (!filesAccessHydrated) return;
    if (slug && !isFilesRouteAllowed({ slug }, filesCompanies)) return;
    navigate({ kind: 'files', slug: slug ?? undefined });
  }

  function navigateFilesPath(path: string) {
    if (
      !filesAccessHydrated ||
      !isFilesRouteAllowed(
        { slug: filesActiveSlug, path },
        filesCompanies,
      )
    ) {
      return;
    }
    navigate({ kind: 'files', slug: filesActiveSlug ?? undefined, path });
  }

  // Persist Files-mode routes for reload survival (US-009). Non-files routes
  // clear the stored entry so a stale files route can't strand a later reload.
  $effect(() => {
    try {
      if (route.kind === 'files') {
        window.localStorage.setItem(
          ROUTE_CACHE_KEY,
          JSON.stringify({ kind: 'files', slug: route.slug, path: route.path }),
        );
      } else {
        window.localStorage.removeItem(ROUTE_CACHE_KEY);
      }
    } catch {
      // Best-effort persistence only.
    }
  });

  // Persist the last-visited company for the US-007 landing rule. Gated on an
  // explicit navigation: the auto-landing itself must not overwrite the stored
  // slug (a cache-based fallback landing would otherwise clobber the real
  // last-visited company before the live workspace list can restore it).
  $effect(() => {
    if (route.kind === 'company' && userNavigated) {
      try {
        window.localStorage.setItem(LAST_COMPANY_CACHE_KEY, route.slug);
      } catch {
        /* best-effort */
      }
    }
  });

  function hydrateMeetingStatus() {
    const snapshot = loadMeetingsCache<MeetingEvent, ScheduledBot, GoogleAccount, GoogleCalendar>();
    meetingEvents = snapshot?.events ?? [];
    meetingCompanyNamesByUid = new Map(snapshot?.companyNamesByUid ?? []);
  }

  function resetRunState(options: { preserveTotalFiles?: boolean } = {}) {
    const previousTotalFiles = syncTotalFiles;
    syncState = 'syncing';
    syncProgress = null;
    syncFanoutTotal = 0;
    syncFanoutDoneCount = 0;
    syncCompanies = [];
    syncFanoutFilesSkipped = 0;
    syncFilesProgressed = 0;
    syncTotalFiles = options.preserveTotalFiles ? previousTotalFiles : 0;
    syncPlanTotalFiles = 0;
    syncPlanReceived = false;
    syncLastSummary = null;
    syncErrorMessage = '';
    syncErrorCompany = null;
    syncStartedAt = Date.now();
    // The runner re-emits anything still conflicted; stale cards would offer
    // actions against files the new run may have already reconciled.
    homeConflicts = [];
    syncConflictCount = 0;
    syncConflictCompany = null;
    syncDeleteRefusals = [];
    statsBySlug = {};
  }

  function updateWorkspaceStats(slug: string, update: (stats: WorkspaceSyncStats) => WorkspaceSyncStats) {
    const current = statsBySlug[slug] ?? emptyWorkspaceStats();
    statsBySlug = { ...statsBySlug, [slug]: update(current) };
  }

  function queueDesktopRenderAudit() {
    // Dev-only instrumentation: the backend `desktop_alt_dev_audit_render`
    // command no-ops unless HQ_DEV_AUDIT_DESKTOP_RENDER=1, so in a production
    // build these timers only burn `document.body.textContent` scans + IPC for
    // nothing. Gate the whole thing out of prod (import.meta.env.DEV is false
    // in the Tauri release build, true under `vite`/`tauri dev`).
    if (!import.meta.env.DEV) return;
    if (desktopRenderAuditQueued) return;
    desktopRenderAuditQueued = true;
    for (const delayMs of [250, 1_000, 3_000, 7_000]) {
      window.setTimeout(() => {
        void auditDesktopRender();
      }, delayMs);
    }
  }

  async function auditDesktopRender() {
    await tick();
    const names = Array.from(document.querySelectorAll<HTMLElement>('.v4-company-row'))
      .map((row) => row.textContent?.trim() ?? '')
      .filter(Boolean);
    const footer =
      document
        .querySelector<HTMLElement>('.v4-titlebar')
        ?.textContent?.replace(/\s+/g, ' ')
        .trim() ?? null;
    const hasMoreCompaniesText = (document.body.textContent ?? '').includes('more companies');
    const domWorkspaceCount =
      document.querySelector<HTMLElement>('.desktop-shell')?.dataset.workspaceCount ?? 'missing';
    const stateSummary = `state companies=${companies.length} workspaces=${workspaces.length} render=${renderWorkspaceCount} shell=${shellCompanies.length} watched=${watchedWorkspaceCount} dom=${domWorkspaceCount}`;
    await invoke('desktop_alt_dev_audit_render', {
      companyRowCount: names.length,
      footer,
      names: [stateSummary, ...names],
      hasMoreCompaniesText,
    }).catch(() => undefined);
  }

  async function loadWorkspaces(isLatest: LatestRequestCheck) {
    if (isLatest()) {
      filesAccessHydrated = false;
      filesAccessSettled = false;
    }
    try {
      const result = await invoke<Partial<WorkspacesResult> | null>(
        'list_syncable_workspaces',
      );
      const nextWorkspaces = Array.isArray(result?.workspaces) ? result.workspaces : [];
      if (!isLatest()) return;
      // The command deliberately returns local workspaces when cloud membership
      // hydration fails. That fallback is useful for non-sensitive chrome, but
      // it is not authoritative enough to grant raw Files access.
      filesAccessHydrated =
        Array.isArray(result?.workspaces) &&
        result?.cloudReachable === true &&
        !result?.error;
      filesAccessSettled = true;
      const nextCompanies = getDesktopCompanies(nextWorkspaces);
      workspaces = nextWorkspaces;
      cloudReachable = result?.cloudReachable === true;
      companies = nextCompanies;
      renderCompanies = nextCompanies;
      renderWorkspaceCount = nextCompanies.length;
      workspaceError =
        sanitizeVisibleIdentifiers(result?.error, { companies: nextWorkspaces }).trim() || null;
      workspaceManifestError =
        sanitizeVisibleIdentifiers(result?.manifestError, {
          companies: nextWorkspaces,
        }).trim() || null;
      writeCachedWorkspaces(nextWorkspaces);
      // The chrome (ChatSidebar / V4TitleBar) consumes renderCompanies +
      // renderWorkspaceCount reactively ($derived / $props), so the reassignments
      // above refresh it on their own. We deliberately do NOT reload the document
      // or remount the chrome on a workspace-list change: a full reload mid-paint
      // is what blanked/froze the desktop on focus/sync.
      // Launch owns cheap workspace/sidebar metadata only. Company resources
      // are loaded lazily by the selected route and shared across its consumers.
      // Brand rides membership fields on workspaces — no new poll/endpoint (US-005).
      {
        const activeSlug =
          route.kind === 'company' || route.kind === 'files' ? route.slug : undefined;
        const nextBrand = syncBrandFromWorkspaces(nextWorkspaces, {
          cloudReachable,
          preferSlug: activeSlug,
        });
        brand = nextBrand;
        applyBrandToDocument(nextBrand);
        if (nextBrand) {
          void cacheLogoAssets(nextBrand).then((withAssets) => {
            brand = withAssets;
            applyBrandToDocument(withAssets);
          });
        }
      }
      startCompanyStore();
      if (nextCompanies.length > 0) queueDesktopRenderAudit();
      // Re-resolve the default landing on the FIRST live workspace load
      // (US-007): a cold/partial cache may have landed on Home or on a
      // fallback company while the true last-visited company only exists in
      // the live list. Never clobber an explicit navigation, and never re-run
      // on later background refreshes — only this one confirmation pass may
      // move the route, and only when the resolved landing actually differs.
      if (!userNavigated && !landingResolved) {
        const landing = getDesktopLandingRoute(nextWorkspaces, initialLastCompanySlug);
        const current = route;
        const alreadyThere =
          current.kind === landing.kind &&
          (landing.kind !== 'company' ||
            (current.kind === 'company' && current.slug === landing.slug));
        if (!alreadyThere) {
          route = landing;
        }
      }
      landingResolved = true;
    } catch (err) {
      if (!isLatest()) return;
      filesAccessHydrated = false;
      filesAccessSettled = true;
      console.error('list_syncable_workspaces failed:', err);
      cloudReachable = false;
      workspaceError =
        sanitizeVisibleIdentifiers(String(err), { companies: workspaces }).trim() ||
        'Workspace status unavailable';
      // Offline: keep cached branding rather than flashing HQ defaults (US-005).
      {
        const cached = readBrandCache();
        brand = cached;
        applyBrandToDocument(cached);
      }
    }
  }

  async function loadSyncStatus(isLatest: LatestRequestCheck) {
    try {
      const nextStatus = await invoke<SyncStatus>('get_sync_status');
      if (!isLatest()) return;
      status = nextStatus;
      syncStatusError = null;
    } catch (err) {
      if (!isLatest()) return;
      console.error('get_sync_status failed:', err);
      syncStatusError =
        sanitizeVisibleIdentifiers(String(err), { companies: workspaces }).trim() ||
        'Could not read the latest sync status';
    }
  }

  async function loadDaemonStatus(isLatest: LatestRequestCheck) {
    try {
      const nextDaemon = await invoke<DaemonStatus>('daemon_status');
      if (!isLatest()) return;
      daemon = nextDaemon;
    } catch (err) {
      if (!isLatest()) return;
      console.error('daemon_status failed:', err);
    }
  }

  async function loadActivity(isLatest: LatestRequestCheck) {
    try {
      const activityResponse = await invoke<unknown>('get_activity_log');
      const nextActivity = Array.isArray(activityResponse)
        ? (activityResponse as ActivityEntry[])
        : [];
      if (!isLatest()) return;
      activity = nextActivity;
    } catch (err) {
      if (!isLatest()) return;
      console.error('get_activity_log failed:', err);
    }
  }

  async function loadHomeProjects(isLatest: LatestRequestCheck) {
    try {
      const nextProjects = await loadLocalProjects();
      if (!isLatest()) return;
      homeProjects = nextProjects;
    } catch (err) {
      if (!isLatest()) return;
      // A missing/locked HQ tree leaves the portfolio table empty rather than
      // breaking Home — the stats simply use their neutral empty states.
      console.error('get_local_projects failed:', err);
    }
  }

  async function refreshRealState() {
    await refreshCoordinator.run(
      async (isLatest) => {
        await Promise.all([
          loadWorkspaces(isLatest),
          loadSyncStatus(isLatest),
          loadDaemonStatus(isLatest),
          loadActivity(isLatest),
          loadHomeProjects(isLatest),
        ]);
      },
      (active) => {
        refreshingRealState = active;
        if (!active) ready = true;
      },
    );
  }

  async function handleRetryHydration() {
    if (refreshingRealState) return;
    await refreshRealState();
  }

  function isSyncEnabledSlug(slug: string): boolean {
    return isWorkspaceSyncEnabled(workspaces.find((workspace) => workspace.slug === slug));
  }

  function applyWorkspaceSyncEnabled(slug: string, enabled: boolean) {
    const patch = (items: Workspace[]) =>
      items.map((workspace) =>
        workspace.slug === slug ? { ...workspace, syncEnabled: enabled } : workspace,
      );
    workspaces = patch(workspaces);
    companies = patch(companies);
    renderCompanies = patch(renderCompanies);
  }

  function handleCloudToggle(paused: boolean) {
    cloudPaused = paused;
    // Write-through to menubar.json so the Rust gates (start_sync + the watch
    // daemon) see the switch, then reconcile the running watcher: pausing
    // stops it; unpausing lets auto-sync resume immediately instead of
    // waiting for the supervisor's next tick. Both are best-effort — the
    // Rust-side gates are the enforcement, not these calls.
    void setCloudPaused(paused)
      .then(async () => {
        if (paused) {
          await invoke('stop_daemon').catch(() => undefined);
        } else {
          await invoke('start_daemon').catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }

  async function handleSyncAll() {
    if (syncState === 'syncing') return;
    // Cloud Off (V2 US-001 / US-016): sync is paused on this device. The
    // titlebar switch is the way back on; a manual Sync press is a no-op.
    if (cloudPaused) {
      flashToast('Cloud is off — turn it on to sync', 'error');
      return;
    }
    resetRunState();
    manualSyncTelemetryPending = true;
    try {
      await invoke('set_tray_state', { state: 'syncing' });
      await invoke('start_sync');
    } catch (err) {
      manualSyncTelemetryPending = false;
      console.error('start_sync failed:', err);
      syncState = 'error';
      syncErrorMessage = String(err);
      await invoke('set_tray_state', { state: 'error' }).catch(() => undefined);
      void emitDesktopTelemetry({
        eventName: 'manual_sync_failed',
        properties: { errorKind: 'start_sync', errorCount: 1, surface: 'desktop-alt' },
      });
    }
  }

  // ── Home NEEDS YOU actions ─────────────────────────────────────────────────

  /** Accept a pending company invite via claim-by-email (desktop NEEDS YOU). */
  async function handleAcceptInvite(slug: string) {
    try {
      const result = await invoke<{
        ok: boolean;
        claimedSlugs: string[];
        message: string;
      }>('claim_pending_company_invite', { companySlug: slug });
      flashToast(result.message || `Joined ${slug}`, 'ok');
      await refreshRealState();
      if (result.claimedSlugs?.length) {
        await handleSyncAll();
      }
    } catch (err) {
      console.error(`claim_pending_company_invite(${slug}) failed:`, err);
      flashToast(
        err instanceof Error ? err.message : String(err) || 'Could not accept invite',
        'error',
      );
      throw err;
    }
  }

  async function handleResolveConflict(path: string, strategy: 'keep-local' | 'keep-remote') {
    const conflict = homeConflicts.find((entry) => entry.path === path);
    if (!conflict || conflict.status === 'resolving') return;
    homeConflicts = homeConflicts.map((entry) =>
      entry.path === path ? { ...entry, status: 'resolving' as const, error: undefined } : entry,
    );
    try {
      await invoke('resolve_conflict', { path, strategy });
      homeConflicts = homeConflicts.filter((entry) => entry.path !== path);
      syncConflictCount = Math.max(0, syncConflictCount - 1);
      if (syncConflictCount === 0) syncConflictCompany = null;
      if (
        homeConflicts.length === 0 &&
        syncConflictCount === 0 &&
        syncState === 'conflict'
      ) {
        syncState = 'idle';
        await invoke('set_tray_state', { state: 'idle' }).catch(() => undefined);
      }
    } catch (err) {
      homeConflicts = homeConflicts.map((entry) =>
        entry.path === path
          ? { ...entry, status: 'error' as const, error: String(err) }
          : entry,
      );
    }
  }

  async function handleCompareConflict(path: string): Promise<void> {
    try {
      await invoke('open_in_editor', { path });
    } catch (err) {
      console.error('open_in_editor failed:', err);
      throw err;
    }
  }

  async function handleResolveAggregateConflicts() {
    const prompt = buildPrompt({
      kind: 'sync-conflict',
      payload: {
        count: syncConflictCount,
        company: syncConflictCompany,
      },
    });
    const result = await openAgentWorkflow(prompt, 'conflict resolution');
    flashToast(
      result.message,
      result.outcome === 'opened' ? 'ok' : result.outcome === 'copied' ? 'neutral' : 'error',
    );
  }

  // Restore every USER-EDIT drifted core file from the scanned upstream
  // target, then re-run the state check so the card reflects post-restore
  // truth (same target-forwarding rationale as the popover's DriftDetail).
  async function handleRestoreDrift() {
    const report = coreState?.driftReport;
    if (!report || driftRestoring) return;
    driftRestoring = true;
    try {
      for (const entry of report.modified) {
        await invoke('restore_from_upstream', {
          path: entry.path,
          expectedUpstreamSha: entry.gitShaUpstream,
          targetRepo: report.targetRepo,
          targetRef: report.targetRef,
        });
      }
      coreState = await invoke<HomeCoreState | null>('check_core_state');
    } catch (err) {
      console.error('restore_from_upstream failed:', err);
      throw err;
    } finally {
      driftRestoring = false;
    }
  }

  function handleKeepDrift() {
    // Session-local ack — the next scan (`core-state:changed`) re-surfaces it.
    driftDismissed = true;
  }

  async function handleViewDrift(): Promise<void> {
    const report = coreState?.driftReport;
    if (!report) return;
    try {
      await invoke('open_drift_detail', { report });
    } catch (err) {
      console.error('open_drift_detail failed:', err);
      throw err;
    }
  }

  // One click clears the stale device session and opens the compact provider
  // picker. App.svelte resumes sync automatically after OAuth succeeds.
  async function handleSignInAgain() {
    try {
      await invoke('begin_reauth');
    } catch (err) {
      console.error('begin_reauth failed:', err);
      throw err;
    }
  }

  async function handleOpenActivityLog(): Promise<void> {
    try {
      await invoke('open_activity_log');
    } catch (err) {
      console.error('open_activity_log failed:', err);
      throw err;
    }
  }

  async function handleCancelSync() {
    if (syncState !== 'syncing') return;
    try {
      await invoke('cancel_sync');
    } catch (err) {
      console.error('cancel_sync failed:', err);
      throw err;
    }
  }

  function handleOpenSettings(tab?: SettingsTab) {
    navigate({ kind: 'settings', tab });
  }

  function handleToggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
  }

  async function refreshPaletteConversations(): Promise<void> {
    try {
      const [contactsResp, channelsResp] = await Promise.all([
        invoke<{ contacts?: DmContactInput[] }>('list_contacts').catch(() => null),
        invoke<{ channels?: Channel[] } | null>('list_channels').catch(() => null),
      ]);
      const contacts = Array.isArray(contactsResp?.contacts) ? contactsResp.contacts : [];
      const channels = Array.isArray(channelsResp?.channels) ? channelsResp.channels : [];
      if (contacts.length > 0 || channels.length > 0) {
        paletteConversations = normalizeConversations(channels, contacts);
      } else {
        const cache =
          typeof window !== 'undefined' ? loadConversationCache(window.localStorage) : null;
        if (cache) {
          paletteConversations = normalizeConversations(
            cache.channels as Channel[],
            cache.contacts as DmContactInput[],
          );
        }
      }
    } catch (err) {
      console.error('command-palette: conversation refresh failed', err);
    }
  }

  function handleOpenCommandPalette() {
    commandPaletteOpen = true;
    void refreshPaletteConversations();
  }

  function openPaletteConversation(row: ConversationRow) {
    navigate({ kind: 'messages' });
    if (row.kind === 'dm' && row.personUid) {
      requestConversation({
        personUid: row.personUid,
        email: row.email ?? '',
        displayName: row.title,
      });
      return;
    }
    if (row.channelId) {
      requestChannelOpen(row.channelId);
    }
  }

  function handleAccountMenu() {
    handleOpenSettings('general');
  }

  // ── Agent-handoff actions (the hq-* ACTIONS in the ⌘K palette) ─────────────
  // Each opens a Claude Code session cwd'd into HQ with a prepared prompt for
  // the matching hq-* skill. The desktop is a viewer; the agent does the work —
  // so these hand off rather than re-implement deploy/share/run in the app.
  // Company-scoped verbs target the company currently on screen when there is
  // one (activeCompany), otherwise stay general so the agent can ask.

  type DesktopWorkflow = 'deploy' | 'share' | 'run-worker';

  type ActionToastTone = 'ok' | 'neutral' | 'warn' | 'error';

  let actionToast = $state<{ text: string; tone: ActionToastTone } | null>(null);
  let actionToastTimer: ReturnType<typeof setTimeout> | null = null;

  function flashToast(text: string, tone: ActionToastTone) {
    actionToast = { text, tone };
    if (actionToastTimer !== null) clearTimeout(actionToastTimer);
    actionToastTimer = setTimeout(() => {
      actionToast = null;
      actionToastTimer = null;
    }, 5000);
  }

  function dismissToast() {
    if (actionToastTimer !== null) clearTimeout(actionToastTimer);
    actionToastTimer = null;
    actionToast = null;
  }

  function desktopWorkflowPrompt(kind: DesktopWorkflow): { prompt: string; label: string } {
    const slug = activeCompany?.slug ?? null;
    const forCompany = slug ? ` for ${slug}` : '';
    switch (kind) {
      case 'deploy':
        return {
          label: 'deploy workflow',
          prompt: [
            slug ? `/deploy ${slug}` : '/deploy',
            '',
            `Help me deploy or share a result${forCompany}.`,
            'Confirm the artifact or path, run the HQ deploy workflow, and return the preview/share URL when it is ready.',
          ].join('\n'),
        };
      case 'share':
        return {
          label: 'share workflow',
          prompt: [
            '/hq-share',
            '',
            'Help me securely share a file from my HQ vault.',
            'Ask which path and which recipients, then mint the encrypted single-use share link.',
          ].join('\n'),
        };
      case 'run-worker':
        return {
          label: 'worker run',
          prompt: [
            '/run',
            '',
            `Help me run a worker${forCompany}.`,
            'List the available workers and their skills, then run the one I choose.',
          ].join('\n'),
        };
    }
  }

  async function runDesktopWorkflow(kind: DesktopWorkflow) {
    const { prompt, label } = desktopWorkflowPrompt(kind);
    const result = await openAgentWorkflow(prompt, label);
    flashToast(
      result.message,
      result.outcome === 'opened' ? 'ok' : result.outcome === 'copied' ? 'neutral' : 'error',
    );
  }

  function handleKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      commandPaletteOpen = true;
      return;
    }

    if (commandPaletteOpen) return;

    const nextRoute = getDesktopHotkeyRoute(event, shellCompanies);
    if (!nextRoute) return;

    event.preventDefault();
    navigate(nextRoute);
  }

  onMount(() => {
    let mounted = true;
    let unlistenFocus: UnlistenFn | undefined;
    const unlisteners: UnlistenFn[] = [];
    const meetingStatusInterval = window.setInterval(() => {
      hydrateMeetingStatus();
    }, 30_000);

    void loadCloudPaused().then((paused) => {
      if (mounted) cloudPaused = paused;
    });

    if (renderCompanies.length > 0) queueDesktopRenderAudit();
    void refreshRealState();
    // US-012: seed the titlebar bell badge from the NOTIF store unreadCount.
    void refreshNotificationsBadge();
    // Resolve the admin gate for the Moderation nav entry (default-deny: only an
    // explicit `true` unlocks it; any error leaves it hidden). This MUST use the
    // admin gate (`desktop_alt_is_admin` → @getindigo.ai), NOT `desktop_alt_enabled`
    // (the GA gate, true for every signed-in user) — otherwise the Moderation row
    // shows for normal HQ users.
    void invoke<boolean>('desktop_alt_is_admin')
      .then((admin) => {
        if (mounted) isAdmin = admin === true;
      })
      .catch(() => {
        if (mounted) isAdmin = false;
      });
    // Home meta-line + drift-card context. All best-effort: a failure leaves
    // the corresponding line/card off rather than blocking the surface.
    void invoke<string | null>('get_hq_version')
      .then((version) => {
        if (mounted) hqVersion = version;
      })
      .catch(() => undefined);
    void invoke<{ hqFolderPath?: string | null }>('get_config')
      .then((config) => {
        if (mounted) hqFolderPath = config?.hqFolderPath ?? null;
      })
      .catch(() => undefined);
    void invoke<{ realtimeSync?: boolean | null }>('get_settings')
      .then((settings) => {
        if (mounted) autoSyncOn = settings.realtimeSync ?? null;
      })
      .catch(() => undefined);
    void invoke<HomeCoreState | null>('check_core_state')
      .then((state) => {
        if (mounted) coreState = state;
      })
      .catch(() => undefined);
    hydrateMeetingStatus();
    // Warm the Meetings singleton at app launch so its data is ready before the
    // user ever navigates to Meetings — the page then reads the warm store on
    // remount (instant) instead of running a blocking fetch each nav. Idempotent.
    startMeetingsStore();
    // A notification click can request a specific screen (e.g. Meetings) before
    // this window existed. The opener queued it; consume it once on mount so we
    // land on the right screen instead of the default Sync route. The
    // already-open case is handled live by the `desktop:navigate` listener below.
    void invoke<string | null>('desktop_alt_consume_pending_route')
      .then((pending) => {
        // Legacy aliases stay functional ('sync' → Home); unknown intents are
        // ignored so a stale queue entry can't strand the window.
        const pendingRoute = resolvePendingDesktopRoute(pending);
        if (mounted && pendingRoute) {
          navigate(pendingRoute);
          return;
        }
        // No backend pending route — restore a persisted Files-mode route so a
        // desktop-alt window reload returns to the same company + file (US-009).
        // Backend pending always takes priority (handled above).
        const stored = readStoredFilesRoute();
        if (mounted && stored) {
          navigate(stored);
        }
      })
      .catch(() => undefined);
    window.addEventListener('keydown', handleKeydown);
    window.addEventListener('focus', hydrateMeetingStatus);
    window.addEventListener('storage', hydrateMeetingStatus);
    // "Message the sharer" (and future message-person deep links): a page
    // stashed a pending conversation (lib/pendingConversation) — route to the
    // first-class desktop Messages surface, whose shell consumes the target.
    window.addEventListener(MESSAGE_PERSON_EVENT, handleMessagePerson);
    // Rust path: ShareMainPane → open_messages_window(target) emits here.
    void listen<ConversationTarget>('messages:open-conversation', (event) => {
      if (!mounted) return;
      requestConversation(mapMessagesTarget(event.payload ?? {}));
    }).then((unlisten) => {
      if (!mounted) {
        safeUnlisten(unlisten)();
        return;
      }
      unlisteners.push(safeUnlisten(unlisten));
    });
    // Cold start: target may have been stashed before listeners mounted.
    void invoke<{
      personUid?: string;
      email?: string;
      displayName?: string;
    } | null>('take_pending_messages_target')
      .then((pending) => {
        if (mounted && pending) {
          requestConversation(mapMessagesTarget(pending));
        }
      })
      .catch(() => undefined);
    const handleWorkspaceSyncEnabledChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ slug?: string; enabled?: boolean }>).detail;
      if (!detail?.slug || typeof detail.enabled !== 'boolean') return;
      applyWorkspaceSyncEnabled(detail.slug, detail.enabled);
      // Watch spawn args read workspaceSyncEnabled at start — bounce so Off
      // companies leave the fanout immediately (mirrors Instant-sync bounce).
      if (autoSyncOn) {
        void invoke('stop_daemon')
          .then(() => invoke('start_daemon'))
          .catch((err) => console.error('workspace-sync daemon bounce failed:', err));
      }
    };
    window.addEventListener(
      'hq:workspace-sync-enabled-changed',
      handleWorkspaceSyncEnabledChanged as EventListener,
    );

    void subscribeWindowFocus(getCurrentWindow(), ({ payload: focused }) => {
      if (focused) {
        refreshRealState();
        hydrateMeetingStatus();
      }
    })
      .then((unlisten) => {
        const safe = safeUnlisten(unlisten);
        if (mounted) {
          unlistenFocus = safe;
        } else {
          safe();
        }
      });

    void Promise.all([
      listen<{ totalFiles: number }>('sync:totals', (event) => {
        if (syncState !== 'syncing') {
          resetRunState();
        }
        syncTotalFiles = event.payload.totalFiles;
      }),
      listen<{
        company: string;
        filesToDownload: number;
        bytesToDownload: number;
        filesToUpload: number;
        bytesToUpload: number;
        filesToSkip: number;
        filesToConflict: number;
      }>('sync:plan', (event) => {
        const plannedFiles =
          event.payload.filesToDownload +
          event.payload.filesToUpload +
          event.payload.filesToConflict;
        const plannedBytes = event.payload.bytesToDownload + event.payload.bytesToUpload;
        // Plan is authoritative now — denominator is the transfer count even at 0.
        syncPlanReceived = true;
        syncPlanTotalFiles += plannedFiles;
        updateWorkspaceStats(event.payload.company, (stats) => ({
          ...stats,
          plannedFiles: stats.plannedFiles + plannedFiles,
          plannedBytes: stats.plannedBytes + plannedBytes,
        }));
      }),
      listen<{ companies: SyncCompanyRef[] }>('sync:fanout-plan', async (event) => {
        if (syncState !== 'syncing') {
          resetRunState({ preserveTotalFiles: true });
        }
        const companies = event.payload.companies.filter((company) => isSyncEnabledSlug(company.slug));
        syncFanoutTotal = companies.length;
        syncFanoutDoneCount = 0;
        syncCompanies = companies;
        await invoke('set_tray_state', { state: 'syncing' }).catch(() => undefined);
      }),
      listen<{ company: string; path: string; bytes: number; message?: string }>(
        'sync:progress',
        async (event) => {
          syncState = 'syncing';
          syncProgress = {
            company: event.payload.company,
            path: event.payload.path,
            bytes: event.payload.bytes,
          };
          syncFilesProgressed += 1;
          updateWorkspaceStats(event.payload.company, (stats) => ({
            ...stats,
            progressedFiles: stats.progressedFiles + 1,
            transferredBytes: stats.transferredBytes + event.payload.bytes,
            lastEventAt: Date.now(),
          }));
          await invoke('set_tray_state', { state: 'syncing' }).catch(() => undefined);
        },
      ),
      listen<{
        personUid: string;
        filesDone: number;
        filesTotal: number;
        currentFile: string | null;
      }>('sync:personal-first-push-progress', async (event) => {
        syncState = 'syncing';
        syncFilesProgressed = Math.max(syncFilesProgressed, event.payload.filesDone);
        syncTotalFiles = Math.max(syncTotalFiles, event.payload.filesTotal);
        if (event.payload.currentFile) {
          syncProgress = {
            company: 'personal',
            path: event.payload.currentFile,
            bytes: 0,
          };
        }
        updateWorkspaceStats('personal', (stats) => ({
          ...stats,
          progressedFiles: Math.max(stats.progressedFiles, event.payload.filesDone),
          plannedFiles: Math.max(stats.plannedFiles, event.payload.filesTotal),
          lastEventAt: Date.now(),
        }));
        await invoke('set_tray_state', { state: 'syncing' }).catch(() => undefined);
      }),
      listen<{ personUid: string; filesUploaded: number; filesSkipped: number }>(
        'sync:personal-first-push-complete',
        (event) => {
          syncFilesProgressed = Math.max(syncFilesProgressed, event.payload.filesUploaded);
          updateWorkspaceStats('personal', (stats) => ({
            ...stats,
            completedFiles: Math.max(stats.completedFiles, event.payload.filesUploaded),
            skippedFiles: stats.skippedFiles + event.payload.filesSkipped,
            lastEventAt: Date.now(),
          }));
        },
      ),
      listen<{
        company: string;
        filesDownloaded: number;
        bytesDownloaded: number;
        filesSkipped: number;
        conflicts: number;
        aborted: boolean;
      }>('sync:complete', async (event) => {
        invalidateCompanyResources(event.payload.company);
        if (isSyncEnabledSlug(event.payload.company)) {
          syncFanoutDoneCount += 1;
        }
        syncFanoutFilesSkipped += event.payload.filesSkipped;
        updateWorkspaceStats(event.payload.company, (stats) => ({
          ...stats,
          completedBytes: Math.max(stats.completedBytes, event.payload.bytesDownloaded),
          completedFiles: stats.completedFiles + event.payload.filesDownloaded,
          skippedFiles: stats.skippedFiles + event.payload.filesSkipped,
          conflicts: stats.conflicts + event.payload.conflicts,
          aborted: stats.aborted || event.payload.aborted,
          lastEventAt: Date.now(),
        }));
        if (event.payload.conflicts > 0) {
          const previousConflictCount = syncConflictCount;
          syncConflictCount += event.payload.conflicts;
          if (previousConflictCount === 0) {
            syncConflictCompany = event.payload.company;
          } else if (syncConflictCompany !== event.payload.company) {
            syncConflictCompany = null;
          }
        }
        if (event.payload.conflicts > 0 || event.payload.aborted) {
          syncState = 'conflict';
          await invoke('set_tray_state', { state: 'conflict' }).catch(() => undefined);
        }
      }),
      listen<{
        company: string;
        path: string;
        journalEtag: string;
        remoteEtag: string;
        reason: string;
      }>('sync:delete-refused-stale-etag', (event) => {
        const refusal: HomeDeleteRefusal = {
          company: event.payload.company,
          path: event.payload.path,
          reason: event.payload.reason,
          at: Date.now(),
        };
        // Keep the latest event for each company/path and cap the session list.
        // ETags stay protocol-internal and are never copied into visible state.
        syncDeleteRefusals = [
          ...syncDeleteRefusals.filter(
            (entry) =>
              entry.company !== refusal.company || entry.path !== refusal.path,
          ),
          refusal,
        ].slice(-8);
        flashToast(`Kept on remote: ${event.payload.path}`, 'warn');
      }),
      listen<{
        companiesAttempted: number;
        filesDownloaded: number;
        bytesDownloaded: number;
        errors: Array<{ company: string; message: string }>;
      }>('sync:all-complete', async (event) => {
        const shouldEmitManualSync = manualSyncTelemetryPending;
        manualSyncTelemetryPending = false;
        syncLastSummary = {
          companiesAttempted: event.payload.companiesAttempted,
          filesDownloaded: event.payload.filesDownloaded,
          bytesDownloaded: event.payload.bytesDownloaded,
          filesSkipped: syncFanoutFilesSkipped,
        };
        syncProgress = null;
        // Don't clobber a real attention state set mid-run. setup-needed is not
        // one: current runners emit it after personal provisioning when a new
        // account simply has zero companies, then synthesize all-complete so
        // the valid no-op run can settle back to idle.
        if (syncState !== 'conflict' && syncState !== 'error') {
          syncState = event.payload.errors.length > 0 ? 'error' : 'idle';
          await invoke('set_tray_state', { state: syncState === 'idle' ? 'idle' : 'error' }).catch(
            () => undefined,
          );
        }
        if (event.payload.errors.length > 0) {
          syncErrorMessage = event.payload.errors.map((item) => item.message).join('; ');
        }
        await refreshRealState();
        if (shouldEmitManualSync) {
          void emitDesktopTelemetry({
            eventName:
              event.payload.errors.length > 0
                ? 'manual_sync_failed'
                : 'manual_sync_completed',
            properties: {
              surface: 'desktop-alt',
              companiesAttempted: event.payload.companiesAttempted,
              filesDownloaded: event.payload.filesDownloaded,
              bytesDownloaded: event.payload.bytesDownloaded,
              filesSkipped: syncFanoutFilesSkipped,
              errorCount: event.payload.errors.length,
            },
          });
        }
      }),
      // Conflict stream → Home's NEEDS YOU queue (dedupe by path; the same
      // conflict can re-emit across fanout retries within one run).
      listen<{ path: string; localHash: string; remoteHash: string; canAutoResolve: boolean }>(
        'sync:conflict',
        (event) => {
          syncState = 'conflict';
          void invoke('set_tray_state', { state: 'conflict' }).catch(() => undefined);
          if (homeConflicts.some((entry) => entry.path === event.payload.path)) return;
          homeConflicts = [
            ...homeConflicts,
            {
              path: event.payload.path,
              canAutoResolve: event.payload.canAutoResolve,
              status: 'pending',
              at: Date.now(),
            },
          ];
        },
      ),
      // Background core-state scans (6h cadence + on-demand checks) keep the
      // drift card honest; a fresh scan clears a session-local "Keep edit" ack.
      listen<HomeCoreState | null>('core-state:changed', (event) => {
        coreState = event.payload;
        driftDismissed = false;
      }),
      listen<{ company?: string; path: string; message: string }>('sync:error', async (event) => {
        const shouldEmitManualSync = manualSyncTelemetryPending;
        manualSyncTelemetryPending = false;
        syncState = 'error';
        syncProgress = null;
        syncErrorMessage = event.payload.message;
        syncErrorCompany = event.payload.company ?? null;
        if (event.payload.company) {
          updateWorkspaceStats(event.payload.company, (stats) => ({
            ...stats,
            errorMessage: event.payload.message,
          }));
        }
        await invoke('set_tray_state', { state: 'error' }).catch(() => undefined);
        if (shouldEmitManualSync) {
          void emitDesktopTelemetry({
            eventName: 'manual_sync_failed',
            properties: { errorKind: 'sync_error', errorCount: 1, surface: 'desktop-alt' },
          });
        }
      }),
      // Current runners emit this only after the personal workspace is already
      // provisioned, when a brand-new account has no company memberships yet.
      // Keep the live run state until Rust's synthetic all-complete arrives;
      // presenting a setup error here would strand a completely valid account.
      listen('sync:setup-needed', () => {
        syncState = 'syncing';
        syncProgress = null;
      }),
      listen<{ message: string }>('sync:auth-error', async (event) => {
        syncState = 'auth-error';
        syncProgress = null;
        syncErrorMessage = event.payload.message;
        await invoke('set_tray_state', { state: 'reauth' }).catch(() => undefined);
      }),
      listen<ActivityEntry>('activity:append', (event) => {
        activity = [...activity, event.payload];
      }),
      listen<ActivityEntry[]>('activity:list', (event) => {
        activity = event.payload;
      }),
      // Live navigation request from the backend — fired when the window is
      // already open and a notification click (or other intent) wants a
      // specific screen. The fresh-window case is handled by the
      // `desktop_alt_consume_pending_route` consume above.
      listen<string>('desktop:navigate', (event) => {
        const nextRoute = resolvePendingDesktopRoute(event.payload);
        if (nextRoute) {
          navigate(nextRoute);
        }
      }),
    ]).then((offs) => {
      if (mounted) {
        unlisteners.push(...offs.map(safeUnlisten));
      } else {
        offs.forEach((off) => safeUnlisten(off)());
      }
    });

    return () => {
      mounted = false;
      safeUnlisten(unlistenFocus)();
      unlisteners.forEach((unlisten) => safeUnlisten(unlisten)());
      window.clearInterval(meetingStatusInterval);
      window.removeEventListener('keydown', handleKeydown);
      window.removeEventListener('focus', hydrateMeetingStatus);
      window.removeEventListener('storage', hydrateMeetingStatus);
      window.removeEventListener(MESSAGE_PERSON_EVENT, handleMessagePerson);
      window.removeEventListener(
        'hq:workspace-sync-enabled-changed',
        handleWorkspaceSyncEnabledChanged as EventListener,
      );
    };
  });
</script>

<div
  class="desktop-shell"
  class:sidebar-collapsed={sidebarCollapsed}
  data-workspace-count={renderWorkspaceCount}
  style={`--desktop-titlebar-height: ${V4_CHROME_LAYOUT.titleBarHeightPx}px;`}
>
  <V4TitleBar
    version={__APP_VERSION__}
    {syncState}
    watchedCount={watchedWorkspaceCount}
    {lastSyncLabel}
    syncingCompany={syncProgress?.company ?? null}
    fanoutDone={syncFanoutDoneCount}
    fanoutTotal={syncFanoutTotal}
    errorSummary={titleBarErrorSummary}
    hydrationIssue={titleBarHydrationIssue}
    hydrationRefreshing={refreshingRealState}
    errorMessage={syncErrorMessage}
    errorCompany={syncErrorCompany}
    conflictCount={syncConflictCount}
    conflictCompany={syncConflictCompany}
    {hqFolderPath}
    accountInitials={accountIdentity.initials}
    {sidebarCollapsed}
    onsync={handleSyncAll}
    oncancel={handleCancelSync}
    onretry={syncState === 'auth-error' ? handleSignInAgain : handleSyncAll}
    onretryhydration={handleRetryHydration}
    onresolveconflicts={handleResolveAggregateConflicts}
    ontogglesidebar={handleToggleSidebar}
    oncommand={handleOpenCommandPalette}
    onaccount={handleAccountMenu}
    onOpenSettings={handleOpenSettings}
    onopenMeetings={() => navigate({ kind: 'meetings' })}
    onopenNotifications={openNotifications}
    unreadCount={notificationsUnreadCount}
    {cloudPaused}
    conflicts={homeConflicts}
    oncloudtoggle={handleCloudToggle}
    onresolveconflict={handleResolveConflict}
    onopenconflict={handleCompareConflict}
    onopendrift={handleViewDrift}
    onopenLibrary={() => openLibrary({ kind: 'library' })}
    onopenMarketplace={() => navigate({ kind: 'marketplace' })}
  />

  <div class="desktop-body">
    {#if !sidebarCollapsed}
      {#if route.kind === 'files'}
        <FilesModeSidebar
          companies={filesCompanies}
          activeSlug={filesActiveSlug}
          selectedPath={filesSelectedPath}
          accessReady={filesAccessHydrated}
          onselectcompany={navigateFilesCompany}
          onselectfile={navigateFilesPath}
          onexit={exitFilesMode}
        />
      {:else}
        <!-- US-003 / US-018: chat-first primary sidebar. -->
        <ChatSidebar
          companies={renderCompanies}
          accountLabel={accountIdentity.label}
          accountInitials={accountIdentity.initials}
          oncommand={handleOpenCommandPalette}
          onnavigateMessages={() => navigate({ kind: 'messages' })}
          onopenSettings={() => handleOpenSettings('general')}
        />
      {/if}
    {/if}

    <div class="desktop-content" aria-busy={navigationPending}>
      <div class="route-progress" class:active={navigationPending} aria-hidden="true">
        <span></span>
      </div>
      <!-- D-10: Library overlay sits over main content; titlebar + ChatSidebar remain. -->
      {#if route.kind === 'library'}
        <div class="library-overlay-host" data-testid="library-overlay-host">
          <LibraryOverlay
            tab={libraryTab}
            onback={exitLibrary}
            onnavigatetab={(t) => navigate({ kind: 'library', tab: t })}
          />
        </div>
      {/if}
      <main class="desktop-main" aria-label="Desktop content">
        <div class="desktop-main-scroll">
        {#key routeKey}
          {#if route.kind === 'home'}
            <div class="page">
              <SetupIncompleteCard />
              <HomePage
                {syncState}
                {ready}
                {workspaces}
                progress={syncProgress}
                companies={syncCompanies}
                {statsBySlug}
                {status}
                {daemon}
                {activity}
                {syncErrorMessage}
                {syncErrorCompany}
                {syncFilesProgressed}
                syncTotalFiles={effectiveTotalFiles}
                transferredBytes={syncTransferredBytes}
                {syncStartedAt}
                {autoSyncOn}
                {hqVersion}
                conflicts={homeConflicts}
                aggregateConflictCount={syncConflictCount}
                aggregateConflictCompany={syncConflictCompany}
                deleteRefusals={syncDeleteRefusals}
                {coreState}
                {driftDismissed}
                {driftRestoring}
                projects={homeProjects}
                {meetingEvents}
                companyNamesByUid={meetingCompanyNamesByUid}
                onopencompany={(slug) => navigate({ kind: 'company', slug })}
                onresolveconflict={handleResolveConflict}
                oncompareconflict={handleCompareConflict}
                onresolveaggregateconflicts={handleResolveAggregateConflicts}
                onacceptinvite={handleAcceptInvite}
                onrestoredrift={handleRestoreDrift}
                onkeepdrift={handleKeepDrift}
                onviewdrift={handleViewDrift}
                onsignin={handleSignInAgain}
                onretry={handleSyncAll}
                onopenlog={handleOpenActivityLog}
              />
            </div>
          {:else if route.kind === 'meetings'}
            <div class="page">
              <MeetingsPage />
            </div>
          {:else if route.kind === 'library'}
            <!-- US-017: library is a full-screen overlay host (see below). -->
          {:else if route.kind === 'marketplace'}
            <div class="page">
              <MarketplacePage />
            </div>
          {:else if route.kind === 'settings'}
            <div class="page">
              <SettingsPage
                activeTab={route.kind === 'settings' ? route.tab ?? null : null}
                onnavigate={(tab) => navigate(tab ? { kind: 'settings', tab } : { kind: 'settings' })}
              />
            </div>
          {:else if route.kind === 'notifications'}
            <div class="page">
              <NotificationsView
                onback={exitNotifications}
                onunreadchange={(n) => (notificationsUnreadCount = n)}
              />
            </div>
          {:else if route.kind === 'messages'}
            <MessagesShell embedded={true} />
          {:else if route.kind === 'moderation'}
            <!-- Admin-only. Rendered only when the admin gate is satisfied
                 (default-deny); ModerationPanel ALSO re-checks + locks itself, and
                 the server is the real authorization boundary. A non-admin who
                 somehow reaches this route falls through to the placeholder. -->
            {#if isAdmin}
              <div class="page">
                <ModerationPanel />
              </div>
            {:else}
              <section class="page" aria-labelledby="desktop-page-title">
                <div class="page-header">
                  <h1 id="desktop-page-title">Moderation</h1>
                </div>
                <div class="placeholder-panel">
                  <p>Moderation is restricted to reviewers.</p>
                </div>
              </section>
            {/if}
          {:else if route.kind === 'files'}
            <div class="files-main">
              {#if !filesAccessHydrated}
                <div class="files-empty" role="status">
                  <strong>{filesAccessSettled ? 'Files unavailable' : 'Loading files…'}</strong>
                  <span>
                    {filesAccessSettled
                      ? 'Reconnect HQ to verify workspace access before opening the file tree.'
                      : 'Confirming workspace access before opening the HQ tree.'}
                  </span>
                </div>
              {:else if filesSelectedPath}
                <FilePreviewPane path={filesSelectedPath} />
              {:else}
                <div class="files-empty">
                  <strong>Select a file to preview it</strong>
                  <span>Browse the HQ files in the sidebar — or filter to a company.</span>
                </div>
              {/if}
            </div>
          {:else if activeCompany}
            <div class="page">
              <CompanyPage
                company={activeCompany}
                tab={companyTab}
                {cloudReachable}
                onopenprojects={() =>
                  navigate({ kind: 'company', slug: activeCompany.slug, tab: 'projects' })
                }
                onopengoals={() =>
                  navigate({ kind: 'company', slug: activeCompany.slug, tab: 'goals' })
                }
                onopeninbox={() => navigate({ kind: 'notifications' })}
                onopenoperations={(destination) =>
                  navigate({ kind: 'company', slug: activeCompany.slug, tab: destination })
                }
                onworkspaceschanged={() => void refreshRealState()}
              />
            </div>
          {:else}
            <section class="page" aria-labelledby="desktop-page-title">
              <div class="page-header">
                <h1 id="desktop-page-title">Company</h1>
              </div>
              <div class="placeholder-panel">
                <p>This company isn’t synced yet. Run a sync to load its board.</p>
                {#if workspaceError}
                  <span class="workspace-error">{workspaceError}</span>
                {/if}
              </div>
            </section>
          {/if}
        {/key}
        </div>
      </main>
    </div>
  </div>

  {#if commandPaletteOpen}
    <CommandPalette commands={commandItems} onclose={() => (commandPaletteOpen = false)} />
  {/if}

  {#if actionToast}
    <div class={`action-toast ${actionToast.tone}`} role="status">
      <span class="toast-dot" aria-hidden="true"></span>
      <span class="toast-text">{actionToast.text}</span>
      <button class="toast-dismiss" type="button" aria-label="Dismiss" onclick={dismissToast}>×</button>
    </div>
  {/if}
</div>

<style>
  /* Keep the shell itself clear: the main canvas and each glass chrome region
     paint exactly one material layer. */
  .desktop-shell {
    position: relative;
    background: transparent;
  }

  /* D-10: Library is an overlay over the main content only — titlebar + sidebar
     stay visible behind/above. Host is positioned inside .desktop-content. */
  .library-overlay-host {
    position: absolute;
    inset: 0;
    z-index: 40;
    min-height: 0;
  }

  .desktop-content {
    position: relative;
  }

  .route-progress {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    z-index: 20;
    height: 2px;
    overflow: hidden;
    pointer-events: none;
    opacity: 0;
  }

  .route-progress span {
    display: block;
    width: 42%;
    height: 100%;
    background: color-mix(in srgb, var(--v4-text-1) 74%, transparent);
    box-shadow: 0 0 10px color-mix(in srgb, var(--v4-text-1) 28%, transparent);
    transform: translateX(-120%);
  }

  .route-progress.active {
    opacity: 1;
  }

  .route-progress.active span {
    animation: route-progress 620ms cubic-bezier(0.2, 0.72, 0.2, 1) infinite;
  }

  /* Files mode main area: full-height host so the preview pane fills it and
     scrolls internally (no floating card around it — the prior overlap bug). */
  .files-main {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
  }

  .files-empty {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 0;
    padding: 40px 16px;
    text-align: center;
  }

  .files-empty strong {
    color: var(--v4-text-1);
    font-size: var(--text-base);
    font-weight: 600;
  }

  .files-empty span {
    color: var(--v4-text-3);
    font-size: var(--text-base);
    line-height: 1.4;
  }

  /* Transient confirmation for desktop actions. A copied prompt is a neutral,
     usable fallback; amber is reserved for real safety warnings. */
  .action-toast {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 60;
    display: flex;
    align-items: center;
    gap: 9px;
    max-width: min(420px, calc(100vw - 32px));
    padding: 9px 10px 9px 12px;
    border: 1px solid var(--v4-hairline);
    border-radius: 8px;
    background: var(--v4-popover);
    backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    -webkit-backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    box-shadow: var(--v4-shadow-popover), inset 0 1px 0 var(--v4-glass-highlight);
  }

  .toast-dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--v4-idle);
  }

  @media (prefers-reduced-transparency: reduce) {
    .action-toast {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      box-shadow: var(--v4-shadow-popover);
    }
  }

  .action-toast.ok .toast-dot {
    background: var(--v4-ok);
  }

  .action-toast.warn .toast-dot {
    background: var(--v4-warn);
  }

  .action-toast.error .toast-dot {
    background: var(--v4-error);
  }

  .toast-text {
    min-width: 0;
    color: var(--v4-text-1);
    font-size: var(--text-base);
    line-height: 17px;
  }

  .toast-dismiss {
    flex: 0 0 auto;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--v4-text-3);
    font-size: var(--type-section, 14px);
    line-height: 1;
    cursor: pointer;
  }

  .toast-dismiss:hover {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  @media (prefers-reduced-motion: no-preference) {
    .action-toast {
      animation: action-toast-in 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
  }

  @keyframes action-toast-in {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }

  @keyframes route-progress {
    to {
      transform: translateX(340%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .route-progress.active span {
      width: 100%;
      animation: none;
      transform: none;
    }
  }
</style>
