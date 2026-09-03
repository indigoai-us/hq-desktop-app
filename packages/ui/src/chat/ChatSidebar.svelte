<script lang="ts">
  /**
   * Chat-first unified conversation sidebar (US-003).
   *
   * Cache-first list of project channels + DMs + group DMs, day-grouped with
   * pin / scope / sort / show filters. Routes selection into the Messages shell.
   *
   * US-009 (channel fabric): channel rows come from the server-shaped
   * directory feed (`fetch_channel_directory` → GET /v1/notify/channels?cursor)
   * through the ported channel-directory reconciler — channel-message wakes
   * patch that one row from the event specifics (no directory refetch). A
   * persisted cursor survives restarts. Cursor catch-up on MQTT connect/focus
   * heals gaps; the 3-minute safety poll runs only while MQTT is down.
   */
  import { onMount, untrack } from "svelte";
  import {
    COMPOSER_DRAFT_CHANGED_EVENT,
    listDraftRowIds,
  } from "./messaging/composer-drafts";
  import {
    clearChannelUnread,
    type Channel,
    humanizeChannelName,
    removeChannel,
    upsertChannel,
    applyChannelMessageWake,
    shouldBumpChannelUnread,
  } from "./channels";
  import {
    isSetupChannel,
    SETUP_ROW_ID,
    withSetupChannel,
    withSetupPin,
  } from "./setup-channel";
  import { requestConversation } from "./pending-conversation";
  import { companiesForChannelCreate } from "./channel-create-scope.js";
  import type { Workspace } from "./workspaces";
  import { type DmRequest, addRequest, removeRequest } from "./dm-requests";
  import { requestChannelOpen, requestDmRequestsOpen } from "./open-target";
  import type { ChatSidebarApi, ChatWakeBus } from "./chat-api";
  import {
    shouldArmDirectorySafety,
    shouldBumpDmUnread,
    type InboxDmActivity,
  } from "./live-catchup";
  import {
    adminCompanyUids,
    browseOnlyCompanyProjectChannels,
  } from "./channel-admin";
  import { isSelf, selfIsAdmin, type SelfIdentity } from "../identity/self.js";
  import { createTenantStorage } from "../identity/tenant-storage.js";
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import {
    createChannelDirectoryReconciler,
    localDirectoryCursorStorage,
    type ChannelDirectoryRow,
  } from "./channel-directory-reconciler";
  import {
    applyDirectoryFeed,
    applyDirectoryRows,
    applyPairUnreads,
    incrementPairUnread,
    applySidebarFilters,
    clearDmDot,
    clearPairUnread,
    conversationKindLabel,
    distinctDmPeople,
    duplicateHumanDmTitles,
    formatSearchHitTime,
    groupByDay,
    groupByType,
    historySearchScopeLabel,
    initialsFor,
    buildScopeOptions,
    loadConversationCache,
    loadDmDots,
    loadPins,
    loadRecentDms,
    loadSetupPinDismissed,
    loadShowFilter,
    mergeContactActivity,
    mergeContactsWithInbox,
    normalizeChannel,
    normalizeConversations,
    rememberRecentDm,
    resolveSearchHitRow,
    rowAvatar,
    saveConversationCache,
    saveDmDots,
    savePins,
    saveRecentDms,
    saveSetupPinDismissed,
    saveShowFilter,
    scopeFromHotkey,
    scopePillLabel,
    startOfLocalDay,
    searchCompanyUidFromScope,
    searchHistory,
    historyDayGroups,
    searchHitSnippet,
    takeRailConversations,
    pickAutoOpenConversation,
    pickSettledBootConversation,
    railRowScopeLabel,
    togglePin,
    type CompanyScope,
    type ConversationRow,
    type DmContactInput,
    type MessageSearchHit,
    type ShowFilter,
    type SortMode,
  } from "./sidebar-model";
  import {
    filterSwitcher,
    switcherInitials,
    switcherRowsFromConversations,
    type SwitcherRow,
  } from "./sidebar-modal-fixtures";
  import CreateModal from "./CreateModal.svelte";
  import { focusOnMount, menuPortal, portal } from "./portal.js";
  import {
    FILTER_POPOVER_MAX_PX,
    FILTER_POPOVER_RAIL_OVERHANG_PX,
  } from "./popover-placement.js";
  import "./tokens.css";
  import "./chat-tokens.css";
  import Caret from "../common/Caret.svelte";
  import {
    BootTimeoutError,
    DEFAULT_SIDEBAR_BOOT_TIMEOUT_MS,
    raceTimeout,
  } from "./boot-timeout.js";
  import { shouldReportShellReady } from "./shell-ready.js";
  import {
    parseSettingsPrefs,
    readSettingsPrefs,
    SETTINGS_PREFS_KEY,
  } from "../settings/settings-prefs.js";

  interface Props {
    /** Platform backend seam (web: REST via the platform adapter). */
    api: ChatSidebarApi;
    /** Wake events (web: bridged from the MeshClient). */
    wakes?: ChatWakeBus | null;
    companies?: Workspace[] | null;
    /** Verified signed-in principal — tags the matching person row "you". */
    self?: SelfIdentity | null;
    /** Explicit admin/owner override; else derived from membership roles. */
    isAdmin?: boolean | null;
    accountLabel?: string | null;
    accountInitials?: string | null;
    /** Currently selected conversation id (`ch:…` / `dm:…`). */
    selectedId?: string | null;
    /** External company scope (cloud uid). Daybook: picking a company filters the daybook. */
    scopeUid?: string | null;
    /** Native auth partition for every renderer-side cache/cursor. */
    tenantAccountId?: string | null;
    /** Company partition paired with `tenantAccountId`. */
    tenantCompanyId?: string | null;
    /**
     * Host-owned directory (local mesh overlay). Painted before the async
     * reconciler so a cleared localStorage + empty first fetch cannot wipe
     * the rail.
     */
    seedDirectory?: ChannelDirectoryRow[] | null;
    /** personUid → presigned avatar URL from loaded channel rosters. */
    avatarByUid?: Record<string, string> | null;
    /** Bump to refetch contacts (after an agent profile save). */
    rosterWakeSeq?: number;
    /** Contact-roster avatar URLs, including agents once hq-pro sends them. */
    onavatarmap?: (map: Record<string, string>) => void;
    oncommand?: () => void;
    onnavigateMessages?: () => void;
    onopenSettings?: () => void;
    /** `automatic` distinguishes the initial rail selection from a user click. */
    onselect?: (row: ConversationRow, options?: { automatic?: boolean }) => void;
    /** Synchronously clears/rekeys the parent when a company tenant changes. */
    oncompanyscopechange?: (companyUid: string | null) => void;
    /** Host-owned sign-out (desktop emitted `tray:sign-out`). */
    onsignout?: () => Promise<void> | void;
    /** Emits the full normalized conversation list whenever it changes. */
    onrows?: (rows: ConversationRow[]) => void;
    /**
     * Bound for first-paint directory/contacts/DM-request reads. A hung or
     * 404'd optional fetch must not keep the conversation pane on a skeleton.
     * Tests pass a short value; production uses the default.
     */
    bootTimeoutMs?: number;
    /**
     * First successful paint of the conversation rail or its empty state.
     * Not called while loading, and not called on an error-only rail.
     */
    onShellReady?: () => void;
  }

  let {
    api,
    wakes = null,
    companies = null,
    self = null,
    isAdmin = null,
    accountLabel = null,
    accountInitials = null,
    selectedId = null,
    scopeUid = null,
    tenantAccountId = null,
    tenantCompanyId = null,
    seedDirectory = null,
    avatarByUid = null,
    rosterWakeSeq = 0,
    onavatarmap,
    oncommand,
    onnavigateMessages,
    onopenSettings,
    onselect,
    oncompanyscopechange,
    onsignout,
    onrows,
    bootTimeoutMs = DEFAULT_SIDEBAR_BOOT_TIMEOUT_MS,
    onShellReady,
  }: Props = $props();

  interface PairUnreadEntry {
    withPersonUid: string;
    lastReadAt?: string | null;
    unreadCount: number;
  }
  interface PairUnreadsPayload {
    pairUnreads?: PairUnreadEntry[];
    delta?: boolean;
    activity?: InboxDmActivity[];
  }

  const storage = createTenantStorage(
    typeof window !== "undefined" ? window.localStorage : null,
    { accountId: tenantAccountId, companyId: tenantCompanyId ?? "all" },
  );

  function readShowScopeLabels(): boolean {
    try {
      const scoped = storage.getItem(SETTINGS_PREFS_KEY);
      if (scoped != null) {
        return parseSettingsPrefs(JSON.parse(scoped) as unknown)
          .showSidebarScopeLabels;
      }
    } catch {
      /* tenant partition missing or junk */
    }
    return readSettingsPrefs().showSidebarScopeLabels;
  }

  let showScopeLabels = $state(readShowScopeLabels());

  let channels = $state<Channel[]>(
    loadConversationCache(storage)?.channels ?? [],
  );

  // Paint overlay rows before first paint. untrack(channels) so a later
  // optimistic unread bump does not re-run and clobber itself.
  $effect.pre(() => {
    const seed = seedDirectory;
    if (!seed || seed.length === 0) return;
    const prev = untrack(() => channels);
    if (
      prev.length === seed.length &&
      prev[0]?.channelId === seed[0]?.channelId &&
      prev.at(-1)?.channelId === seed.at(-1)?.channelId &&
      prev[0]?.lastActivityAt === seed[0]?.lastActivityAt &&
      prev.at(-1)?.lastActivityAt === seed.at(-1)?.lastActivityAt
    ) {
      return;
    }
    channels = applyDirectoryRows(seed, prev);
  });
  let contacts = $state<DmContactInput[]>(
    loadConversationCache(storage)?.contacts ?? [],
  );
  let pins = $state<string[]>(loadPins(storage));
  /** User unpinned #setup — sticky until they pin it again. */
  let setupPinDismissed = $state<boolean>(loadSetupPinDismissed(storage));
  /** Rows with an unsent composer draft (Slack-style pencil marker). */
  let draftIds = $state<string[]>(listDraftRowIds(storage));
  const draftIdSet = $derived(new Set(draftIds));
  function refreshDraftIds(): void {
    draftIds = listDraftRowIds(storage);
  }
  let dmDots = $state<string[]>(loadDmDots(storage));
  let recentDms = $state<string[]>(loadRecentDms(storage));
  /** personUid → unreadCount from inbox `pairUnreads` (absent-safe). */
  let pairUnreads = $state<Map<string, number>>(new Map());
  /** Pending incoming connection requests (same source as MessagesShell). */
  let pendingRequests = $state<DmRequest[]>([]);

  let scope = $state<CompanyScope>("all");
  // DesktopApp re-keys this sidebar when its company tenant changes. Apply the
  // host-owned scope before rendering so a company-partitioned cache cannot
  // briefly be treated as the all-company rail.
  $effect.pre(() => {
    scope = scopeUid ?? "all";
  });
  let sortMode = $state<SortMode>("recent");
  let showFilter = $state<ShowFilter>(loadShowFilter(storage));
  let personFilter = $state<string | null>(null);
  // People aren't company-scoped — switching company scope clears a stale
  // person filter so it can't silently empty the newly scoped list.
  $effect(() => {
    void scope;
    personFilter = null;
  });

  function setShowFilter(next: ShowFilter): void {
    const prev = showFilter;
    sidebarLog("filter-change", {
      from: prev,
      to: next,
      rail: railRows.length,
      filtered: filteredRows.length,
      browse: browseRows.length,
    });
    showFilter = next;
    saveShowFilter(next, storage);
    filterOpen = false;
    if (next !== "company-projects" && prev === "company-projects") {
      companyProjectChannels = [];
    }
  }

  function sidebarLog(
    event: string,
    extra: Record<string, unknown> = {},
  ): void {
    console.info("[hq-sidebar]", { t: Date.now(), event, ...extra });
  }

  let lastWeekExpanded = $state(false);
  let historyOpen = $state(false);
  let historyQuery = $state("");
  /** Server message-content hits for non-empty history query (US-013). */
  let messageSearchHits = $state<MessageSearchHit[]>([]);
  let messageSearchLoading = $state(false);
  let messageSearchError = $state<string | null>(null);
  let messageSearchSeq = 0;
  /**
   * The unified create modal (search-first: DM ↔ channel is inferred from what
   * the user types). Replaces the old "+" dropdown and BOTH the new-message and
   * new-channel modals.
   */
  let createOpen = $state(false);
  let plusBtnEl = $state<HTMLButtonElement | null>(null);
  /** "Search or jump to…" channel switcher overlay (?view=v2). */
  let searchOpen = $state(false);
  let searchQuery = $state("");
  let filterOpen = $state(false);
  let scopeMenuOpen = $state(false);
  let footerMenuOpen = $state(false);
  /**
   * Debounced mirrors of the free-text query inputs. The result-computing
   * `$derived`s read these, not the raw bound values, so the O(n) client
   * filters (`filterSwitcher`/`searchHistory` over the full roster) run at most
   * once per idle window instead of on every keystroke. The inputs stay bound
   * to the raw values, so typing/cursor/IME are unaffected.
   */
  let searchQueryDebounced = $state("");
  let historyQueryDebounced = $state("");
  /** Right-click conversation context menu (anchored at the cursor). */
  let contextMenu = $state<{
    row: ConversationRow;
    x: number;
    y: number;
  } | null>(null);
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  /** First directory/contacts attempt has settled or timed out. */
  let bootAttempted = $state(false);
  let firstRefreshSettled = false;
  let reportedShellReady = false;
  let scopeMenuEl: HTMLDivElement | null = $state(null);
  let filterWrapEl: HTMLDivElement | null = $state(null);
  let footerEl: HTMLDivElement | null = $state(null);

  // Mirror of selectedId — do not seed $state from a prop (state_referenced_locally).
  let activeId = $state<string | null>(null);
  $effect(() => {
    activeId = selectedId;
  });

  // Debounce the search/history queries (~110ms). Collapses fast keystroke
  // bursts into a single roster scan. One effect: any keystroke reschedules;
  // the other is an idempotent no-op when unchanged. (The create modal owns its
  // own 110ms debounce.)
  $effect(() => {
    const s = searchQuery;
    const h = historyQuery;
    const timer = setTimeout(() => {
      searchQueryDebounced = s;
      historyQueryDebounced = h;
    }, 110);
    return () => clearTimeout(timer);
  });

  const scopeCompanies = $derived(
    (companies ?? [])
      .filter((w) => w.kind !== "personal" && w.cloudUid)
      .map((w) => ({
        companyUid: w.cloudUid as string,
        label: w.displayName?.trim() || w.slug,
      })),
  );

  /**
   * Create targets. `scopeCompanies` above is the BROWSE list and keeps
   * companies the user can only look at; creating in one of those is rejected
   * by the server, so the create modal gets the narrower list.
   */
  const createScopeCompanies = $derived(
    companiesForChannelCreate(companies, accountLabel),
  );

  const contactsWithUnreads = $derived(applyPairUnreads(contacts, pairUnreads));

  // Synthetic #setup support channel (deduped against a real server `setup`
  // channel) — pinned by default; once unpinned it lists under TODAY (bottom)
  // instead of sinking into LAST WEEK with zero activity.
  const channelsWithSetup = $derived(
    withSetupChannel(
      channels,
      setupPinDismissed ? { activityAt: startOfLocalDay(Date.now()) } : {},
    ),
  );
  const pinsWithSetup = $derived(
    withSetupPin(pins, { dismissed: setupPinDismissed }),
  );

  /**
   * Single pin toggle for both the context menu and the hover pin button.
   * #setup is pinned by default (not stored in `pins`), so toggling it flips
   * the persisted dismissed flag instead of the pin list.
   */
  function toggleRowPin(rowId: string): void {
    if (rowId === SETUP_ROW_ID) {
      const nowPinned = pinsWithSetup.includes(SETUP_ROW_ID);
      setupPinDismissed = nowPinned;
      saveSetupPinDismissed(storage, nowPinned);
      if (nowPinned) {
        pins = pins.filter((id) => id !== SETUP_ROW_ID);
      } else if (!pins.includes(SETUP_ROW_ID)) {
        pins = [SETUP_ROW_ID, ...pins];
      }
      savePins(pins, storage);
      return;
    }
    pins = togglePin(pins, rowId);
    savePins(pins, storage);
  }

  const allRows = $derived(
    normalizeConversations(channelsWithSetup, contactsWithUnreads, {
      pinnedIds: pinsWithSetup,
      dmDots,
      recentDms,
    }),
  );

  let lastEmittedRows: ConversationRow[] | null = null;
  $effect(() => {
    const rows = allRows;
    const emit = onrows;
    if (!emit) return;
    if (rows === lastEmittedRows) return;
    lastEmittedRows = rows;
    emit(rows);
  });

  // Full people directory (contacts WITHOUT a conversation included) — used
  // only by the new-message typeahead, never rendered as sidebar rows (G3).
  const directoryRows = $derived(
    normalizeConversations(channelsWithSetup, contactsWithUnreads, {
      pinnedIds: pinsWithSetup,
      dmDots,
      includeContactsWithoutConversation: true,
    }),
  );

  // US-021: owner/admin-only "All company projects" view. `companyProjectChannels`
  // is the owner-scoped fetch; browse rows are the ones the caller is NOT in.
  const ownerCompanyUids = $derived(adminCompanyUids(companies ?? []));
  // ACL gate for the owner-only "All company projects" affordance. Routed
  // through the shared self-admin helper so an explicit host probe can override
  // and unknown ⇒ hidden. Default (no override) matches the membership roles.
  const canSeeCompanyProjects = $derived(selfIsAdmin(companies, isAdmin));
  let companyProjectChannels = $state<Channel[]>([]);
  const browseRows = $derived(
    browseOnlyCompanyProjectChannels(channels, companyProjectChannels).map(
      (c) => ({
        ...normalizeChannel(c, { pinnedIds: pins }),
        browseOnly: true,
      }),
    ),
  );

  const pendingRequestCount = $derived(pendingRequests.length);

  const filteredRows = $derived(
    applySidebarFilters(
      showFilter === "company-projects" ? [...allRows, ...browseRows] : allRows,
      {
        scope,
        show: showFilter,
        sort: sortMode,
        personUid: personFilter,
      },
    ),
  );

  const companyScoped = $derived(scope !== "all" && scope !== "personal");
  const railRows = $derived(
    sortMode === "type" || companyScoped
      ? filteredRows
      : takeRailConversations(filteredRows, {
          selectedId: activeId,
          recentPersonUids: recentDms,
        }),
  );

  /** US-016: open the newest rail row when the shell has no selection. */
  let autoOpenRequestedId = $state<string | null>(null);
  const hasNonSetupRows = $derived(
    allRows.some((row) => !isSetupChannel(row.channelId)),
  );
  $effect(() => {
    if (selectedId) {
      autoOpenRequestedId = null;
      return;
    }
    if (autoOpenRequestedId) return;
    // Real conversations auto-open immediately. #setup exists from first
    // paint, so it must not win the empty-selection race against deep links
    // and rows that hydrate a beat later — but once the first fetch has
    // settled (or timed out) with nothing else, open #setup so the pane is
    // never an infinite skeleton.
    const live = pickAutoOpenConversation(
      filteredRows.filter((row) => !isSetupChannel(row.channelId)),
      selectedId,
    );
    if (live) {
      autoOpenRequestedId = live.id;
      void openRow(live, undefined, true);
      return;
    }
    if (!bootAttempted || loading) return;
    const fallback = pickSettledBootConversation(filteredRows, selectedId);
    if (!fallback) return;
    autoOpenRequestedId = fallback.id;
    sidebarLog("auto-open-fallback", {
      id: fallback.id,
      reason: "no-other-conversations",
    });
    void openRow(fallback, undefined, true);
  });
  const grouped = $derived(
    sortMode === "type" ? groupByType(railRows) : groupByDay(railRows),
  );
  const historyHiddenCount = $derived(
    Math.max(0, filteredRows.length - railRows.length),
  );
  const people = $derived(distinctDmPeople(allRows));
  const duplicateHumanTitles = $derived(duplicateHumanDmTitles(allRows));
  const liveSwitcherRows = $derived(
    switcherRowsFromConversations([...directoryRows, ...browseRows], (uid) => {
      if (!uid) return "";
      return (
        scopeCompanies.find((company) => company.companyUid === uid)?.label ??
        ""
      );
    }),
  );
  const switcherResults = $derived(
    filterSwitcher(liveSwitcherRows, searchQueryDebounced).slice(0, 200),
  );
  const historyRows = $derived(
    searchHistory(filteredRows, historyQueryDebounced),
  );
  const historyGroups = $derived(historyDayGroups(historyRows));
  const historyScopeLabel = $derived(
    historySearchScopeLabel(scope, scopeCompanies),
  );
  const historyCompanyUid = $derived(searchCompanyUidFromScope(scope));
  const historyHasQuery = $derived(historyQuery.trim().length > 0);
  const scopeLabel = $derived(scopePillLabel(scope, scopeCompanies));
  const scopeOptions = $derived(buildScopeOptions(scopeCompanies));
  const displayName = $derived(accountLabel?.trim() || "Account");
  /** Footer shows the first name only (D-17). */
  const firstName = $derived(displayName.split(/\s+/)[0] || displayName);
  const initials = $derived(
    (accountInitials?.trim() || initialsFor(displayName))
      .slice(0, 2)
      .toUpperCase(),
  );

  /**
   * Right-click on a conversation opens a context menu at the cursor (previously
   * right-click toggled the pin outright, with no menu). The menu offers
   * Pin/Unpin; the click that opens it never selects the row.
   */
  function openContextMenu(row: ConversationRow, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const menuW = 200;
    const menuH = 120;
    contextMenu = {
      row,
      x: Math.max(0, Math.min(event.clientX, window.innerWidth - menuW)),
      y: Math.max(0, Math.min(event.clientY, window.innerHeight - menuH)),
    };
  }

  function closeContextMenu(): void {
    contextMenu = null;
  }

  function togglePinFromMenu(): void {
    if (!contextMenu) return;
    toggleRowPin(contextMenu.row.id);
    contextMenu = null;
  }

  /** Mutually exclusive overlays: opening one closes the others (D-03). */
  function closeAllOverlays(): void {
    filterOpen = false;
    scopeMenuOpen = false;
    footerMenuOpen = false;
    createOpen = false;
    searchOpen = false;
  }

  function openScopeMenu(): void {
    const next = !scopeMenuOpen;
    closeAllOverlays();
    scopeMenuOpen = next;
  }

  function openFilterMenu(): void {
    const next = !filterOpen;
    closeAllOverlays();
    filterOpen = next;
  }

  function openCreate(): void {
    closeAllOverlays();
    createOpen = true;
  }

  /** Close the create modal; optionally open the channel it just created. */
  function closeCreate(
    openChannelId?: string,
    hint?: { title: string; companyUid: string | null },
  ): void {
    createOpen = false;
    plusBtnEl?.focus();
    if (!openChannelId) return;
    // A just-created channel is opened before the directory feed lists it, so
    // the shell would stub a row titled with the raw id. Hand it the name so
    // the header is right on first paint, not only after the user clicks away
    // and back. Prefer the modal's own hint: our `channels` copy can be
    // overwritten by a directory refresh between create and close.
    const known = channels.find((c) => c.channelId === openChannelId);
    const title = hint?.title?.trim() || (known ? known.name : "");
    requestChannelOpen(openChannelId, {
      title: title ? humanizeChannelName(title) : null,
      companyUid: hint?.companyUid ?? known?.companyUid ?? null,
    });
  }

  /** Optimistic rail insert for a just-created channel: paint now, reconcile,
   *  re-assert if the directory snapshot lagged (idempotent when it did not). */
  async function onChannelCreated(channel: Channel): Promise<void> {
    channels = upsertChannel(channels, channel);
    await refreshLists();
    if (!channels.some((c) => c.channelId === channel.channelId)) {
      channels = upsertChannel(channels, channel);
    }
  }

  function openSearch(): void {
    closeAllOverlays();
    searchOpen = true;
    searchQuery = "";
  }

  /**
   * Jump to a switcher/compose row. Rows that map onto a real fixture
   * conversation open it; extras are inert display stubs.
   */
  function jumpToSwitcherRow(row: SwitcherRow): void {
    const match = [...directoryRows, ...browseRows].find(
      (r) =>
        r.channelId === row.id ||
        r.personUid === row.id ||
        r.id === `ch:${row.id}` ||
        r.id === `dm:${row.id}`,
    );
    if (match) void openRow(match);
  }

  function selectSwitcherRow(row: SwitcherRow): void {
    searchOpen = false;
    searchQuery = "";
    jumpToSwitcherRow(row);
  }

  function openFooterMenu(): void {
    const next = !footerMenuOpen;
    closeAllOverlays();
    footerMenuOpen = next;
  }

  function selectScope(next: CompanyScope): void {
    scope = next;
    scopeMenuOpen = false;
    oncompanyscopechange?.(
      next === "all" || next === "personal" ? null : next,
    );
  }

  function scopeShortcutLabel(optionId: string, companyIndex: number): string {
    if (optionId === "all") return "⌘0";
    if (optionId === "personal") return "⌘P";
    if (companyIndex >= 0 && companyIndex < 5) return `⌘${companyIndex + 1}`;
    return "";
  }

  function scopeAvatarLabel(option: { id: string; label: string }): string {
    if (option.id === "all") return "AL";
    if (option.id === "personal") return "PE";
    return initialsFor(option.label);
  }

  // Avatar hue from stable hash of label (monochrome-friendly tint via CSS vars).
  function scopeAvatarTone(label: string): number {
    let h = 0;
    for (let i = 0; i < label.length; i++)
      h = (h * 31 + label.charCodeAt(i)) | 0;
    return Math.abs(h) % 6;
  }

  $effect(() => {
    if (searchOpen || historyOpen || createOpen) return;
    document
      .querySelectorAll(
        "[data-testid='chat-search-overlay'], [data-testid='chat-create-modal']",
      )
      .forEach((node) => node.remove());
  });

  $effect(() => {
    if (
      !scopeMenuOpen &&
      !filterOpen &&
      !footerMenuOpen &&
      !searchOpen &&
      !contextMenu
    )
      return;

    function onMouseDown(event: MouseEvent) {
      if (!(event.target instanceof Node)) return;
      // Any outside mousedown dismisses the cursor context menu. Clicks inside
      // it call stopPropagation, so they never reach this handler.
      if (contextMenu) contextMenu = null;
      if (scopeMenuOpen) {
        const menu = document.querySelector('[data-testid="chat-scope-menu"]');
        const inside =
          (scopeMenuEl?.contains(event.target) ?? false) ||
          (menu?.contains(event.target) ?? false);
        if (!inside) scopeMenuOpen = false;
      }
      if (filterOpen) {
        const menu = document.querySelector('[data-testid="chat-filter-popover"]');
        const inside =
          (filterWrapEl?.contains(event.target) ?? false) ||
          (menu?.contains(event.target) ?? false);
        if (!inside) filterOpen = false;
      }
      if (footerMenuOpen) {
        const menu = document.querySelector('[data-testid="chat-user-menu"]');
        const insideFooter = footerEl?.contains(event.target) ?? false;
        const insideMenu = menu?.contains(event.target) ?? false;
        if (!insideFooter && !insideMenu) footerMenuOpen = false;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (contextMenu) {
        contextMenu = null;
        event.preventDefault();
        return;
      }
      if (searchOpen) {
        searchOpen = false;
        event.preventDefault();
        return;
      }
      // No `createOpen` branch on purpose — CreateModal owns its own Escape
      // (and backdrop) dismissal; two handlers would double-fire.
      if (scopeMenuOpen || filterOpen || footerMenuOpen) {
        scopeMenuOpen = false;
        filterOpen = false;
        footerMenuOpen = false;
        event.preventDefault();
      }
    }

    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  });

  $effect(() => {
    if (!historyOpen) return;
    const q = historyQuery.trim();
    if (!q) {
      messageSearchHits = [];
      messageSearchError = null;
      messageSearchLoading = false;
      return;
    }
    const companyUid = historyCompanyUid;
    const seq = ++messageSearchSeq;
    messageSearchLoading = true;
    messageSearchError = null;
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const resp = await api.searchMessages({
            q,
            companyUid: companyUid ?? undefined,
            limit: 50,
          });
          if (seq !== messageSearchSeq) return;
          messageSearchHits = Array.isArray(resp?.results) ? resp.results : [];
        } catch (err) {
          if (seq !== messageSearchSeq) return;
          messageSearchHits = [];
          messageSearchError =
            typeof err === "string" ? err : "Could not search recent messages";
          console.error("chat-sidebar: search_messages failed", err);
        } finally {
          if (seq === messageSearchSeq) messageSearchLoading = false;
        }
      })();
    }, 220);
    return () => clearTimeout(handle);
  });

  // US-021: debounced owner-scoped fetch while the company-projects view is on.
  let companyProjectsSeq = 0;
  $effect(() => {
    const wantAllCompanies =
      showFilter === "company-projects" || searchOpen || createOpen;
    const scoped = scope !== "all" && scope !== "personal" ? [scope] : [];
    const uids = wantAllCompanies
      ? ownerCompanyUids.length > 0
        ? ownerCompanyUids
        : scopeCompanies.map((c) => c.companyUid)
      : scoped;
    if (uids.length === 0) return;
    const seq = ++companyProjectsSeq;
    const started = performance.now();
    sidebarLog("company-projects-fetch-start", {
      uids: uids.length,
      wantAllCompanies,
    });
    const timer = setTimeout(async () => {
      const collected: Channel[] = [];
      for (const uid of uids) {
        try {
          const resp = await api.listChannels({
            companyUid: uid,
            includeCompanyProjects: true,
          });
          for (const c of resp?.channels ?? []) collected.push(c);
        } catch (err) {
          // Absent-safe: old servers / non-owner races degrade to member-only.
          console.warn("chat-sidebar: company project listing failed", err);
        }
      }
      if (seq === companyProjectsSeq) {
        companyProjectChannels = collected;
        sidebarLog("company-projects-fetch-done", {
          count: collected.length,
          ms: Math.round(performance.now() - started),
        });
      }
    }, 250);
    return () => clearTimeout(timer);
  });

  // US-009 (channel fabric): the sidebar's channel rows come from the
  // server-shaped directory feed via the ported reconciler — wake → cursor
  // delta, persisted cursor, epoch-safe, periodic safety refetch. Replaces the
  // old list_channels refetch loop AND the scan_local_projects-driven channel
  // provisioning (the server directory is the source of truth).
  const directoryReconciler = createChannelDirectoryReconciler({
    fetchFeed: async (cursor) =>
      raceTimeout(
        api.fetchChannelDirectory(cursor ?? null),
        bootTimeoutMs,
        "channel-directory",
      ),
    storage: localDirectoryCursorStorage(storage),
    onApply: (rows) => {
      channels = applyDirectoryFeed(rows, channels, seedDirectory);
      loadError = null;
      saveConversationCache(
        { channels, contacts, cachedAt: Date.now() },
        storage,
      );
    },
    onError: (err) => {
      // Surface the failure when the rail has no real conversations — the
      // synthetic #setup row is always injected, so "nothing to show" is
      // channels+contacts empty, not allRows empty.
      if (channels.length === 0 && contacts.length === 0) {
        loadError = "Couldn’t load conversations.";
      }
      sidebarLog("boot-error", {
        source: "channel-directory",
        timeout: err instanceof BootTimeoutError,
        message: err.message,
      });
      console.error("chat-sidebar: channel directory reconcile failed", err);
    },
  });

  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRefresh(): void {
    if (refreshTimer != null) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refreshLists();
    }, 400);
  }

  // Debounced wake → cursor-delta reconcile (channel wakes can burst; the
  // reconciler additionally coalesces overlapping runs).
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleDirectoryReconcile(): void {
    if (reconcileTimer != null) return;
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      void directoryReconciler.reconcile("wake").catch(() => {});
    }, 400);
  }

  async function refreshLists(): Promise<void> {
    const firstPaint = channels.length === 0 && contacts.length === 0;
    if (firstPaint) loading = true;
    loadError = null;
    // Channels reconcile through the directory feed; contacts + requests keep
    // their existing reads. All three settle (or time out) before the loading
    // gate clears so first paint cannot wait forever.
    const directory = directoryReconciler.reconcile("manual").catch(() => {}); // onError already surfaced it
    try {
      const [contactsResp, requestsResp] = await Promise.all([
        raceTimeout(api.listContacts(), bootTimeoutMs, "list_contacts").catch(
          (err) => {
            sidebarLog("boot-error", {
              source: "list_contacts",
              timeout: err instanceof BootTimeoutError,
              message: err instanceof Error ? err.message : String(err),
            });
            console.error("chat-sidebar: list_contacts failed", err);
            if (channels.length === 0 && contacts.length === 0) {
              loadError = "Couldn’t load conversations.";
            }
            return { contacts: contacts };
          },
        ),
        raceTimeout(
          api.listDmRequests(),
          bootTimeoutMs,
          "list_dm_requests",
        ).catch((err) => {
          console.error("chat-sidebar: list_dm_requests failed", err);
          return { requests: pendingRequests };
        }),
      ]);
      const nextContacts = Array.isArray(contactsResp?.contacts)
        ? contactsResp.contacts
        : [];
      // An empty/malformed roster must not wipe contacts already painted
      // from the machine cache (or a prior good fetch).
      if (nextContacts.length > 0 || contacts.length === 0) {
        contacts = mergeContactActivity(contacts, nextContacts);
      }
      pendingRequests = Array.isArray(requestsResp?.requests)
        ? requestsResp.requests
        : [];
      saveConversationCache(
        { channels, contacts, cachedAt: Date.now() },
        storage,
      );
    } catch (err) {
      loadError = "Couldn’t load conversations.";
      sidebarLog("boot-error", {
        source: "refresh",
        message: err instanceof Error ? err.message : String(err),
      });
      console.error("chat-sidebar: refresh failed", err);
    } finally {
      await directory;
      bootAttempted = true;
      loading = false;
      firstRefreshSettled = true;
      maybeReportShellReady();
    }
  }

  function maybeReportShellReady(): void {
    if (reportedShellReady) return;
    if (
      !shouldReportShellReady({
        loading,
        loadError,
        firstRefreshSettled,
        conversationCount: channels.length + contacts.length,
      })
    ) {
      return;
    }
    reportedShellReady = true;
    onShellReady?.();
  }

  $effect(() => {
    const map: Record<string, string> = {};
    for (const contact of contacts) {
      const uid = contact.personUid?.trim();
      const url = contact.avatarUrl?.trim();
      if (uid && url) map[uid] = url;
    }
    untrack(() => onavatarmap?.(map));
  });

  $effect(() => {
    const seq = rosterWakeSeq;
    if (seq <= 0) return;
    untrack(() => {
      void refreshLists();
    });
  });

  /** Peers already asked about — one thread read per bare uid, ever. */
  const dmNameLookupsTried = new Set<string>();

  /**
   * The DM peer index (dm-threads) carries bare uids. When such a peer is not
   * in the contacts roster its row would be titled by uid; read the newest
   * page of that thread once and take the counterpart's name/email from it.
   */
  async function resolveUnnamedDmPeers(): Promise<void> {
    const fetchThread = api.fetchDmThread;
    if (typeof fetchThread !== "function") return;
    const pending = contacts.filter(
      (contact) =>
        !contact.displayName?.trim() &&
        !contact.email?.trim() &&
        !dmNameLookupsTried.has(contact.personUid),
    );
    for (const contact of pending) {
      const uid = contact.personUid;
      dmNameLookupsTried.add(uid);
      try {
        const page = await fetchThread.call(api, {
          withPersonUid: uid,
          limit: 10,
        });
        const messages = Array.isArray(page?.messages) ? page.messages : [];
        const theirs = messages.find(
          (message) => (message.fromPersonUid ?? "").trim() === uid,
        );
        const displayName = theirs?.fromDisplayName?.trim() ?? "";
        const email = theirs?.fromEmail?.trim() ?? "";
        if (!displayName && !email) continue;
        contacts = contacts.map((entry) =>
          entry.personUid === uid
            ? {
                ...entry,
                displayName: entry.displayName || displayName || null,
                email: entry.email || email || null,
              }
            : entry,
        );
      } catch {
        /* best effort — the row still lists, titled by email or uid */
      }
    }
  }

  function mergePairUnreadsPayload(
    payload: PairUnreadsPayload | null | undefined,
  ): void {
    const activity = payload?.activity;
    if (Array.isArray(activity) && activity.length > 0) {
      contacts = mergeContactsWithInbox(
        contacts,
        activity.map((entry) => ({
          fromPersonUid: entry.personUid,
          createdAt: entry.lastMessageAt,
          fromDisplayName: entry.displayName,
        })),
      );
      void resolveUnnamedDmPeers();
    }
    const entries = payload?.pairUnreads;
    if (!Array.isArray(entries)) return;
    // Empty array on account switch clears the map; page rollups merge in.
    if (entries.length === 0) {
      pairUnreads = new Map();
      return;
    }
    const next = new Map(pairUnreads);
    const delta = payload?.delta === true;
    for (const entry of entries) {
      const uid = entry?.withPersonUid?.trim();
      if (!uid) continue;
      const count =
        typeof entry.unreadCount === "number" &&
        Number.isFinite(entry.unreadCount)
          ? Math.floor(entry.unreadCount)
          : 0;
      next.set(uid, Math.max(0, delta ? (next.get(uid) ?? 0) + count : count));
    }
    pairUnreads = next;
  }

  onMount(() => {
    // Cache already painted; one cursor delta in the background. Safety
    // polling stays off until we know MQTT is down.
    maybeReportShellReady();
    void refreshLists();
    directoryReconciler.setSafetyPolling(true);

    const unlisteners: Array<() => void> = [];
    const track = (unlisten: () => void) => {
      unlisteners.push(unlisten);
    };

    // Channel-message wakes patch one cached row from the event specifics.
    // Directory reconcile stays on shape changes / unread rollups / the
    // bounded safety poll — not on every new message.
    if (wakes) {
      track(
        wakes.on("channel:new-message", (payload) => {
          const { channelId } = payload;
          const stamp =
            typeof payload.createdAt === "string" && payload.createdAt
              ? payload.createdAt
              : undefined;
          // Stamp activity FIRST so own sends and the open channel still move
          // under TODAY. The unread gate used to be the only caller, which
          // left the row in an older day fold.
          if (stamp) {
            channels = applyChannelMessageWake(channels, {
              channelId,
              createdAt: stamp,
            });
          }
          const bump = shouldBumpChannelUnread({
            selectedId: selectedId ?? activeId,
            channelId,
            fromPersonUid: payload.fromPersonUid,
            selfUid: self?.uid,
          });
          const absoluteUnread = payload.absoluteUnread === true;
          if (!bump && !absoluteUnread) return;
          channels = applyChannelMessageWake(channels, {
            channelId,
            unread: absoluteUnread ? payload.unread : bump ? undefined : payload.unread,
            unreadDelta: absoluteUnread ? 0 : bump ? 1 : 0,
          });
        }),
      );

      track(
        wakes.on("reply:new", (wake) => {
          if (wake.scope !== "channel" || !wake.channelId) return;
          if (
            !shouldBumpChannelUnread({
              selectedId: selectedId ?? activeId,
              channelId: wake.channelId,
              selfUid: self?.uid,
            })
          ) {
            return;
          }
          channels = applyChannelMessageWake(channels, {
            channelId: wake.channelId,
            unreadDelta: 1,
          });
        }),
      );

      track(
        wakes.on("dm:new-message", (payload) => {
          const fromPersonUid = (payload.fromPersonUid ?? "").trim();
          const stamp = payload.createdAt;
          if (
            fromPersonUid &&
            fromPersonUid !== self?.uid &&
            typeof stamp === "string" &&
            stamp
          ) {
            contacts = mergeContactsWithInbox(contacts, [
              { fromPersonUid, createdAt: stamp },
            ]);
          }
          if (
            !shouldBumpDmUnread({
              selectedId: selectedId ?? activeId,
              fromPersonUid: payload.fromPersonUid,
              selfUid: self?.uid,
            })
          ) {
            return;
          }
          if (payload.absoluteUnread !== true) {
            pairUnreads = incrementPairUnread(pairUnreads, payload.fromPersonUid);
          }
        }),
      );

      track(
        wakes.on("reply:new", (wake) => {
          if (wake.scope !== "dm" || !wake.withPersonUid) return;
          if (
            !shouldBumpDmUnread({
              selectedId: selectedId ?? activeId,
              fromPersonUid: wake.withPersonUid,
              selfUid: self?.uid,
            })
          ) {
            return;
          }
          pairUnreads = incrementPairUnread(pairUnreads, wake.withPersonUid);
        }),
      );

      track(
        wakes.on("channel:updated", (payload) => {
          channels = upsertChannel(channels, payload);
          scheduleDirectoryReconcile();
        }),
      );

      // A deleted channel leaves the rail at once (the deleting client emits
      // this optimistically; the server's directory-feed change follows). The
      // shell owns selection — if this was the open row, it clears it itself.
      track(
        wakes.on("channel:removed", ({ channelId }) => {
          channels = removeChannel(channels, channelId);
          directoryReconciler.forget(channelId);
          scheduleDirectoryReconcile();
        }),
      );

      track(
        wakes.on("channel:unread-changed", () => {
          scheduleDirectoryReconcile();
        }),
      );

      track(
        wakes.on("mesh:connection", ({ state }) => {
          directoryReconciler.setSafetyPolling(shouldArmDirectorySafety(state));
        }),
      );

      track(
        wakes.on("mesh:catchup", () => {
          void directoryReconciler.reconcile("catchup").catch(() => {});
        }),
      );

      // Per-pair DM unreads from the SINGLE inbox poll (hq-pro US-010).
      track(
        wakes.on("dm:pair-unreads", (payload) => {
          mergePairUnreadsPayload(payload);
        }),
      );

      track(
        wakes.on("dm:request-new", (payload) => {
          pendingRequests = addRequest(pendingRequests, payload);
        }),
      );

      track(
        wakes.on("dm:request-update", (payload) => {
          pendingRequests = removeRequest(pendingRequests, payload.pairKey);
          // Accept may promote a new contact — refresh so the conversation appears.
          scheduleRefresh();
        }),
      );
    }

    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      // Don't steal when typing in inputs.
      const t = event.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      const next = scopeFromHotkey(event.key, scopeCompanies);
      if (next == null) return;
      event.preventDefault();
      event.stopPropagation();
      selectScope(next);
    }

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener(COMPOSER_DRAFT_CHANGED_EVENT, refreshDraftIds);

    return () => {
      window.removeEventListener(COMPOSER_DRAFT_CHANGED_EVENT, refreshDraftIds);
      for (const u of unlisteners) u();
      directoryReconciler.stop();
      if (refreshTimer != null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      if (reconcileTimer != null) {
        clearTimeout(reconcileTimer);
        reconcileTimer = null;
      }
      window.removeEventListener("keydown", onKeyDown, true);
    };
  });

  function handlePin(row: ConversationRow) {
    toggleRowPin(row.id);
  }

  async function openRow(
    row: ConversationRow,
    focus?: { messageId?: string | null; createdAt?: string | null },
    automatic = false,
  ) {
    const started = performance.now();
    sidebarLog("open-row", {
      id: row.id,
      kind: row.kind,
      browseOnly: row.browseOnly === true,
      membership: row.membership ?? null,
      filter: showFilter,
    });
    activeId = row.id;
    onselect?.(row, { automatic });
    if (!automatic) onnavigateMessages?.();

    // G4: stash the open target SYNCHRONOUSLY, before any awaited IPC. The
    // previous ordering awaited mark-read first, so the mounting MessagesShell
    // could consume an empty stash and the first click appeared to do nothing
    // (a second click was needed once the shell was already mounted).
    if (row.kind === "dm" && row.personUid) {
      requestConversation({
        personUid: row.personUid,
        email: row.email ?? "",
        displayName: row.title,
        automatic,
      });
      recentDms = rememberRecentDm(recentDms, row.personUid);
      saveRecentDms(recentDms, storage);
      // Optimistic clear (local dot + numeric pair unread), then server mark-read.
      dmDots = clearDmDot(dmDots, row.personUid);
      saveDmDots(dmDots, storage);
      pairUnreads = clearPairUnread(pairUnreads, row.personUid);
      contacts = contacts.map((contact) =>
        contact.personUid === row.personUid
          ? {
              ...contact,
              unreadCount: 0,
              lastMessageAt:
                contact.lastMessageAt ||
                contact.lastActivityAt ||
                new Date().toISOString(),
              lastActivityAt:
                contact.lastActivityAt ||
                contact.lastMessageAt ||
                new Date().toISOString(),
            }
          : contact,
      );
      try {
        await api.markDmThreadRead(row.personUid);
      } catch (err) {
        // Non-fatal — optimistic clear already applied; next poll reconciles.
        console.error("chat-sidebar: mark_dm_thread_read failed", err);
      }
      sidebarLog("open-row-done", {
        id: row.id,
        kind: "dm",
        ms: Math.round(performance.now() - started),
      });
      return;
    }

    if (row.channelId) {
      requestChannelOpen(row.channelId, {
        messageId: focus?.messageId,
        createdAt: focus?.createdAt,
        automatic,
      });
      channels = clearChannelUnread(channels, row.channelId);
      try {
        await api.markChannelRead(row.channelId);
      } catch (err) {
        console.error("chat-sidebar: mark_channel_read failed", err);
      }
    }
    sidebarLog("open-row-done", {
      id: row.id,
      kind: row.kind,
      ms: Math.round(performance.now() - started),
    });
  }

  function openConnectionRequests() {
    onnavigateMessages?.();
    requestDmRequestsOpen();
  }

  function openHistory() {
    historyOpen = true;
    historyQuery = "";
    messageSearchHits = [];
    messageSearchError = null;
    messageSearchLoading = false;
  }

  function closeHistory() {
    historyOpen = false;
    historyQuery = "";
    messageSearchHits = [];
    messageSearchError = null;
  }

  function openSearchHit(hit: MessageSearchHit) {
    const row = resolveSearchHitRow(hit, allRows);
    void openRow(row, {
      messageId: hit.messageId,
      createdAt: hit.createdAt,
    });
  }

  let signOutConfirmOpen = $state(false);
  let signOutError = $state<string | null>(null);
  let signingOut = $state(false);

  function signOut() {
    footerMenuOpen = false;
    signOutError = null;
    signOutConfirmOpen = true;
  }

  async function confirmSignOut(): Promise<void> {
    if (signingOut) return;
    signOutError = null;
    if (!onsignout) {
      signOutError = "Sign out is unavailable in this host.";
      return;
    }
    signingOut = true;
    try {
      await onsignout();
      signOutConfirmOpen = false;
    } catch (error) {
      signOutError = `Couldn’t sign out: ${String(error)}`;
    } finally {
      signingOut = false;
    }
  }

  function openSettings() {
    footerMenuOpen = false;
    onopenSettings?.();
  }
</script>

<aside
  class="chat-sidebar chat-shell"
  aria-label="Conversations"
  data-testid="chat-sidebar"
>
  <header class="chat-header">
    <div class="chat-scope-wrap" bind:this={scopeMenuEl}>
      <button
        type="button"
        class="chat-scope-pill"
        data-testid="chat-scope-pill"
        aria-label={`Company scope: ${scopeLabel}. Open menu.`}
        aria-expanded={scopeMenuOpen}
        aria-haspopup="menu"
        title="Company scope (⌘0 All, ⌘1–5 companies, ⌘P Personal)"
        onclick={openScopeMenu}
      >
        {#if scope === "all"}
          <span class="chat-scope-tile all" aria-hidden="true">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <rect
                x="1.75"
                y="8.25"
                width="5.5"
                height="5.5"
                rx="1"
                stroke="currentColor"
                stroke-width="1.3"
              />
              <rect
                x="8.75"
                y="8.25"
                width="5.5"
                height="5.5"
                rx="1"
                stroke="currentColor"
                stroke-width="1.3"
              />
              <rect
                x="5.25"
                y="2.25"
                width="5.5"
                height="5.5"
                rx="1"
                stroke="currentColor"
                stroke-width="1.3"
              />
            </svg>
          </span>
        {:else}
          <span class="chat-scope-tile" aria-hidden="true"
            >{initialsFor(scopeLabel)}</span
          >
        {/if}
        {scopeLabel}
        <Caret tone="var(--t3)" />
      </button>
      {#if scopeMenuOpen}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="chat-popover chat-scope-menu"
          data-testid="chat-scope-menu"
          role="menu"
          tabindex="-1"
          aria-label="Company scope"
          use:menuPortal={{ anchor: scopeMenuEl, placement: "bottom-start" }}
          onmousedown={(e) => e.stopPropagation()}
        >
          {#each scopeOptions as option, i (option.id)}
            {@const companyIndex =
              option.id === "all" || option.id === "personal"
                ? -1
                : scopeCompanies.findIndex((c) => c.companyUid === option.id)}
            <button
              type="button"
              class="chat-popover-row chat-scope-row"
              class:active={scope === option.id}
              role="menuitemradio"
              aria-checked={scope === option.id}
              data-testid="chat-scope-option"
              data-scope={option.id}
              onclick={() => selectScope(option.id)}
            >
              <span
                class={`chat-scope-avatar tone-${scopeAvatarTone(option.label)}`}
                aria-hidden="true"
              >
                {scopeAvatarLabel(option)}
              </span>
              <span class="chat-scope-row-label">
                {option.id === "all" ? "All companies" : option.label}
              </span>
              {#if scopeShortcutLabel(option.id, companyIndex)}
                <span class="chat-scope-shortcut">
                  {scopeShortcutLabel(option.id, companyIndex)}
                </span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="chat-header-actions">
      <button
        type="button"
        class="chat-icon-btn"
        bind:this={plusBtnEl}
        data-testid="chat-new-message"
        aria-label="New message or channel"
        title="New message or channel"
        aria-haspopup="dialog"
        aria-expanded={createOpen}
        onclick={openCreate}
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 3v10M3 8h10"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <button
        type="button"
        class="chat-icon-btn"
        data-testid="chat-search"
        aria-label="Search or jump to a conversation"
        title="Search or jump to…"
        onclick={openSearch}
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle
            cx="7"
            cy="7"
            r="4.5"
            stroke="currentColor"
            stroke-width="1.25"
          />
          <path
            d="m10.5 10.5 3 3"
            stroke="currentColor"
            stroke-width="1.25"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <div class="chat-filter-wrap" bind:this={filterWrapEl}>
        <button
          type="button"
          class="chat-icon-btn"
          class:on={showFilter !== "mine" || personFilter != null}
          data-testid="chat-filter"
          aria-label="Filter conversations"
          aria-expanded={filterOpen}
          title="Filter"
          onclick={openFilterMenu}
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2.5 4h11M4.5 8h7M6.5 12h3"
              stroke="currentColor"
              stroke-width="1.25"
              stroke-linecap="round"
            />
          </svg>
        </button>
        {#if filterOpen}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="chat-popover chat-filter-menu"
            data-testid="chat-filter-popover"
            role="dialog"
            tabindex="-1"
            aria-label="Conversation filters"
            use:menuPortal={{
              anchor: filterWrapEl,
              placement: "bottom-end",
              maxWidth: FILTER_POPOVER_MAX_PX,
              railOverhang: FILTER_POPOVER_RAIL_OVERHANG_PX,
            }}
            onmousedown={(e) => e.stopPropagation()}
          >
            <div class="chat-filter-caption">Sort by</div>
            <div class="chat-sort-toggle" role="group" aria-label="Sort by">
              <button
                type="button"
                class="chat-sort-pill"
                class:active={sortMode === "recent"}
                aria-pressed={sortMode === "recent"}
                onclick={() => (sortMode = "recent")}
              >
                <span class="chat-sort-ic" aria-hidden="true">🕐</span>
                Recent
              </button>
              <button
                type="button"
                class="chat-sort-pill"
                class:active={sortMode === "type"}
                aria-pressed={sortMode === "type"}
                onclick={() => (sortMode = "type")}
              >
                <span class="chat-sort-ic" aria-hidden="true">≣</span>
                Type
              </button>
            </div>

            <div class="chat-filter-caption pad-top">Show</div>
            <button
              type="button"
              class="chat-filter-row"
              class:active={showFilter === "mine"}
              data-testid="chat-filter-mine"
              onclick={() => setShowFilter("mine")}
            >
              <span class="chat-filter-lead" aria-hidden="true">⌂</span>
              <span class="chat-filter-text">My projects</span>
              {#if showFilter === "mine"}
                <span class="chat-filter-check" aria-hidden="true">✓</span>
              {/if}
            </button>
            <button
              type="button"
              class="chat-filter-row"
              class:active={showFilter === "all"}
              onclick={() => {
                personFilter = null;
                setShowFilter("all");
              }}
            >
              <span class="chat-filter-lead" aria-hidden="true">≣</span>
              <span class="chat-filter-text">All</span>
              {#if showFilter === "all"}
                <span class="chat-filter-check" aria-hidden="true">✓</span>
              {/if}
            </button>
            <button
              type="button"
              class="chat-filter-row"
              class:active={showFilter === "projects"}
              onclick={() => {
                personFilter = null;
                setShowFilter("projects");
              }}
            >
              <span class="chat-filter-lead" aria-hidden="true">#</span>
              <span class="chat-filter-text">Project channels</span>
              {#if showFilter === "projects"}
                <span class="chat-filter-check" aria-hidden="true">✓</span>
              {/if}
            </button>
            <button
              type="button"
              class="chat-filter-row"
              class:active={showFilter === "dms"}
              onclick={() => {
                personFilter = null;
                setShowFilter("dms");
              }}
            >
              <span class="chat-filter-lead" aria-hidden="true">💬</span>
              <span class="chat-filter-text">DMs &amp; groups</span>
              {#if showFilter === "dms"}
                <span class="chat-filter-check" aria-hidden="true">✓</span>
              {/if}
            </button>
            {#if canSeeCompanyProjects}
              <!-- Owner/admin-only: browse every project channel in a company
                     the caller administers. Gated on the shared self-admin
                     helper (hidden when role is unknown / not admin). -->
              <button
                type="button"
                class="chat-filter-row"
                class:active={showFilter === "company-projects"}
                data-testid="chat-filter-company-projects"
                onclick={() => {
                  personFilter = null;
                  setShowFilter("company-projects");
                }}
              >
                <span class="chat-filter-lead" aria-hidden="true">⌾</span>
                <span class="chat-filter-text">Company projects</span>
                {#if showFilter === "company-projects"}
                  <span class="chat-filter-check" aria-hidden="true">✓</span>
                {/if}
              </button>
            {/if}

            {#if people.length > 0}
              <div class="chat-filter-caption pad-top">People</div>
              <div class="chat-people-list">
                {#each people as person (person.personUid)}
                  {@const isYou =
                    isSelf(person.personUid, self) ||
                    /\(you\)/i.test(person.label)}
                  {@const personName = person.label
                    .replace(/\s*\(you\)\s*/i, "")
                    .trim()}
                  <button
                    type="button"
                    class="chat-person-row"
                    class:active={personFilter === person.personUid}
                    aria-pressed={personFilter === person.personUid}
                    onclick={() => {
                      const selecting = personFilter !== person.personUid;
                      personFilter = selecting ? person.personUid : null;
                      // A person's rows are DMs/groups — clear any Show filter
                      // that would strip them (else the combo yields []).
                      if (selecting) showFilter = "all";
                      filterOpen = false;
                    }}
                  >
                    <span class="chat-person-avatar" aria-hidden="true"
                      >{initialsFor(personName)}</span
                    >
                    <span class="chat-person-name">{personName}</span>
                    {#if isYou}
                      <span class="chat-person-tag">you</span>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </header>

  <div class="chat-scroll" data-testid="chat-conversation-list">
    {#if pendingRequestCount > 0}
      <button
        type="button"
        class="chat-row chat-requests-row"
        data-testid="chat-connection-requests"
        aria-label={`Connection requests, ${pendingRequestCount} pending`}
        onclick={openConnectionRequests}
      >
        <span class="chat-glyph requests" aria-hidden="true">·</span>
        <span class="chat-row-title">Connection requests</span>
        <span
          class="chat-unread-badge"
          data-testid="chat-requests-count"
          aria-hidden="true"
        >
          {pendingRequestCount > 99 ? "99+" : pendingRequestCount}
        </span>
      </button>
    {/if}

    {#if grouped.pinned.length > 0}
      <div class="chat-section-label" id="chat-pinned-label">
        <span class="chat-pin-ic" aria-hidden="true">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path
              d="M10.2 2.4 13.6 5.8a.8.8 0 0 1-.15 1.26l-2.2 1.27-.7 3.15a.6.6 0 0 1-.98.32L7.2 9.43 4.3 12.32a.55.55 0 0 1-.78-.78L6.4 8.66 4.05 6.3a.6.6 0 0 1 .32-.98l3.15-.7 1.27-2.2A.8.8 0 0 1 10.2 2.4Z"
            />
          </svg>
        </span>
        PINNED
      </div>
      <div class="chat-list" role="list" aria-labelledby="chat-pinned-label">
        {#each grouped.pinned as row (row.id)}
          {@render conversationRow(row)}
        {/each}
      </div>
    {/if}

    {#each grouped.sections as section (section.key)}
      {@const [sectionName, sectionDate] = section.label.split(" · ")}
      <div
        class="chat-section-label chat-day-head"
        id={`chat-sec-${section.key}`}
      >
        <span>{sectionName}</span>
        {#if sectionDate}<span class="chat-day-date" data-testid="chat-day-date"
            >{sectionDate}</span
          >{/if}
      </div>
      <div
        class="chat-list"
        role="list"
        aria-labelledby={`chat-sec-${section.key}`}
      >
        {#each section.rows as row (row.id)}
          {@render conversationRow(row)}
        {/each}
      </div>
    {/each}

    {#if grouped.lastWeek.length > 0}
      <button
        type="button"
        class="chat-collapse-row"
        data-testid="chat-last-week"
        aria-expanded={lastWeekExpanded}
        onclick={() => (lastWeekExpanded = !lastWeekExpanded)}
      >
        <span class="chat-collapse-left">
          <span
            class="chat-collapse-chevron"
            class:open={lastWeekExpanded}
            aria-hidden="true">›</span
          >
          <span class="chat-section-label inline">Last week</span>
        </span>
        {#if !lastWeekExpanded}
          <span class="chat-collapse-meta" data-testid="chat-last-week-count"
            >{grouped.lastWeek.length}</span
          >
        {/if}
      </button>
      {#if lastWeekExpanded}
        <div class="chat-list" role="list" aria-label="Last week">
          {#each grouped.lastWeek as row (row.id)}
            {@render conversationRow(row)}
          {/each}
        </div>
      {/if}
    {/if}

    <button
      type="button"
      class="chat-history-affordance"
      data-testid="chat-show-history"
      onclick={openHistory}
    >
      Show all history{historyHiddenCount > 0
        ? ` (${historyHiddenCount})`
        : ""}…
    </button>

    {#if loadError && !hasNonSetupRows}
      <div class="chat-empty" role="alert" data-testid="chat-load-error">
        {loadError}
      </div>
    {/if}
    {#if loading && allRows.length === 0}
      <div class="chat-empty" role="status">Loading…</div>
    {:else if filteredRows.length === 0}
      <div class="chat-empty">No conversations</div>
    {/if}
  </div>

  <div class="chat-footer" bind:this={footerEl}>
    <button
      type="button"
      class="chat-user-card"
      data-testid="chat-user-card"
      aria-haspopup="menu"
      aria-expanded={footerMenuOpen}
      onclick={openFooterMenu}
    >
      <span class="chat-avatar" aria-hidden="true">{initials}</span>
      <span class="chat-user-copy">
        <span class="chat-user-name">{firstName}</span>
        <span class="chat-user-status">
          <span class="chat-status-dot" aria-hidden="true"></span>
          Signed in
        </span>
      </span>
      <span class="chat-chevron" aria-hidden="true">›</span>
    </button>
    {#if footerMenuOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="chat-popover footer"
        role="menu"
        tabindex="-1"
        data-testid="chat-user-menu"
        use:menuPortal={{ anchor: footerEl, placement: "top-stretch" }}
        onmousedown={(e) => e.stopPropagation()}
      >
        {#if onopenSettings}
          <button
            type="button"
            class="chat-popover-row"
            role="menuitem"
            onclick={openSettings}
          >
            Settings
          </button>
        {/if}
        <button
          type="button"
          class="chat-popover-row"
          role="menuitem"
          data-testid="chat-sign-out"
          onpointerdown={(e) => e.stopPropagation()}
          onmousedown={(e) => e.stopPropagation()}
          onclick={() => void signOut()}
        >
          Sign out
        </button>
      </div>
    {/if}
  </div>

  {#if contextMenu}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="chat-context-menu"
      data-testid="chat-context-menu"
      role="menu"
      tabindex="-1"
      aria-label="Conversation actions"
      use:portal
      style="left:{contextMenu.x}px; top:{contextMenu.y}px;"
      onmousedown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        class="chat-popover-row"
        role="menuitem"
        data-testid="chat-context-pin"
        onclick={togglePinFromMenu}
      >
        {pinsWithSetup.includes(contextMenu.row.id)
          ? "Unpin conversation"
          : "Pin conversation"}
      </button>
    </div>
  {/if}

  {#if historyOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="chat-overlay top"
      data-testid="chat-history-view"
      use:portal
      onclick={(e) => {
        if (e.target === e.currentTarget) closeHistory();
      }}
      onkeydown={(e) => {
        if (e.key === "Escape") closeHistory();
      }}
    >
      <div
        class="chat-switcher"
        role="dialog"
        aria-label="Conversation history"
        tabindex="-1"
      >
        <div class="chat-switcher-search">
          <span class="chat-switcher-search-ic" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none">
              <circle
                cx="7"
                cy="7"
                r="4.5"
                stroke="currentColor"
                stroke-width="1.25"
              />
              <path
                d="m10.5 10.5 3 3"
                stroke="currentColor"
                stroke-width="1.25"
                stroke-linecap="round"
              />
            </svg>
          </span>
          <input
            class="chat-switcher-input"
            type="text"
            use:focusOnMount
            placeholder="Search history…"
            bind:value={historyQuery}
            aria-label="Search conversation history"
            data-testid="chat-history-search"
          />
          <span class="chat-history-scope" data-testid="chat-history-scope">
            {historyScopeLabel}
          </span>
        </div>
        <p class="chat-history-helper" data-testid="chat-history-helper">
          Searches recent messages (about the last 1,000)
        </p>
        <div
          class="chat-switcher-list chat-history-list"
          role="list"
          data-testid="chat-history-results"
        >
          {#if historyHasQuery}
            {#if messageSearchLoading && messageSearchHits.length === 0}
              <div class="chat-empty" role="status">Searching…</div>
            {:else if messageSearchError}
              <div class="chat-empty" role="alert">{messageSearchError}</div>
            {:else if messageSearchHits.length === 0}
              <div class="chat-empty">No matching messages</div>
            {:else}
              {#each messageSearchHits as hit (hit.messageId + (hit.createdAt ?? ""))}
                {@const row = resolveSearchHitRow(hit, allRows)}
                <div role="listitem" class="chat-li">
                  <button
                    type="button"
                    class="chat-row chat-search-hit"
                    data-testid="chat-search-hit"
                    onclick={() => openSearchHit(hit)}
                  >
                    {#if row.kind === "channel"}
                      <span class="chat-glyph" aria-hidden="true">#</span>
                    {:else if row.kind === "group"}
                      <span class="chat-avatar group" aria-hidden="true">
                        {row.memberCount ?? row.members?.length ?? 0}
                      </span>
                    {:else}
                      {@const avatar = rowAvatar(row, avatarByUid)}
                      <span
                        class="chat-avatar"
                        aria-hidden="true"
                        data-avatar={avatar.kind}
                      >
                        {#if avatar.src}
                          <img src={avatar.src} alt="" />
                        {:else}
                          {avatar.initials}
                        {/if}
                      </span>
                    {/if}
                    <span class="chat-search-hit-copy">
                      <span class="chat-search-hit-title">
                        {#if draftIdSet.has(row.id)}
                          {@render draftMark()}
                        {/if}
                        <span class="chat-row-title">{row.title}</span>
                      </span>
                      <span class="chat-search-snippet"
                        >{searchHitSnippet(hit)}</span
                      >
                    </span>
                    <span class="chat-search-meta">
                      <span class="chat-type-tag"
                        >{conversationKindLabel(row.kind)}</span
                      >
                      <span class="chat-search-time"
                        >{formatSearchHitTime(hit.createdAt)}</span
                      >
                    </span>
                  </button>
                </div>
              {/each}
            {/if}
          {:else}
            {#each historyGroups as group (group.label)}
              <div
                class="chat-history-day"
                data-testid="chat-history-day"
                aria-hidden="true"
              >
                {group.label}
              </div>
              {#each group.rows as row (row.id)}
                <button
                  type="button"
                  class="chat-switcher-row"
                  role="listitem"
                  class:unread={!!row.unreadCount || row.unreadDot}
                  onclick={() => void openRow(row)}
                >
                  {#if row.kind === "channel"}
                    <span class="chat-switcher-hash" aria-hidden="true">#</span>
                  {:else if row.kind === "group"}
                    <span class="chat-switcher-avatar" aria-hidden="true">
                      {row.memberCount ?? row.members?.length ?? 0}
                    </span>
                  {:else}
                    {@const avatar = rowAvatar(row, avatarByUid)}
                    <span
                      class="chat-switcher-avatar"
                      aria-hidden="true"
                      data-avatar={avatar.kind}
                    >
                      {#if avatar.src}
                        <img src={avatar.src} alt="" />
                      {:else}
                        {avatar.initials}
                      {/if}
                    </span>
                  {/if}
                  <span class="chat-switcher-name">{row.title}</span>
                </button>
              {/each}
            {:else}
              <div class="chat-empty">No conversations</div>
            {/each}
          {/if}
        </div>
      </div>
    </div>
  {/if}
  {#if searchOpen}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="chat-overlay top"
      data-testid="chat-search-overlay"
      use:portal
      onclick={(e) => {
        if (e.target === e.currentTarget) searchOpen = false;
      }}
      onkeydown={(e) => {
        if (e.key === "Escape") searchOpen = false;
      }}
    >
      <div
        class="chat-switcher"
        role="dialog"
        aria-label="Search or jump to a conversation"
        tabindex="-1"
      >
        <div class="chat-switcher-search">
          <span class="chat-switcher-search-ic" aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none">
              <circle
                cx="7"
                cy="7"
                r="4.5"
                stroke="currentColor"
                stroke-width="1.25"
              />
              <path
                d="m10.5 10.5 3 3"
                stroke="currentColor"
                stroke-width="1.25"
                stroke-linecap="round"
              />
            </svg>
          </span>
          <input
            class="chat-switcher-input"
            type="text"
            use:focusOnMount
            placeholder="Search or jump to…"
            bind:value={searchQuery}
            aria-label="Search or jump to a conversation"
          />
        </div>
        <div class="chat-switcher-list" role="list">
          {#each switcherResults as row (row.id)}
            <button
              type="button"
              class="chat-switcher-row"
              role="listitem"
              onclick={() => selectSwitcherRow(row)}
            >
              {#if row.kind === "channel"}
                <span class="chat-switcher-hash" aria-hidden="true">#</span>
              {:else}
                <span class="chat-switcher-avatar" aria-hidden="true"
                  >{switcherInitials(row.name)}</span
                >
              {/if}
              <span class="chat-switcher-name">{row.name}</span>
              <span class="chat-switcher-company">{row.company}</span>
            </button>
          {:else}
            <div class="chat-empty">
              {searchQuery.trim() ? "No matches" : "No conversations"}
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  {#if createOpen}
    <CreateModal
      {api}
      rows={[...directoryRows, ...browseRows]}
      {contacts}
      {scopeCompanies}
      createCompanies={createScopeCompanies}
      activeScope={scope}
      {self}
      onclose={closeCreate}
      onpick={(row) => {
        createOpen = false;
        plusBtnEl?.focus();
        void openRow(row);
      }}
      oncreated={onChannelCreated}
    />
  {/if}
</aside>

<ConfirmDialog
  open={signOutConfirmOpen}
  title={signOutError ? "Couldn’t sign out" : "Sign out"}
  message={signOutError ?? "Sign out of HQ Work on this machine?"}
  confirmLabel="Sign out"
  danger
  oncancel={() => {
    signOutConfirmOpen = false;
    signOutError = null;
  }}
  onconfirm={() => void confirmSignOut()}
/>

<!-- Slack-style pencil shown before a row title when it has an unsent draft.
     Shared by the rail row and the search-hit row; colour comes from
     `.chat-row-draft` (`var(--t3)`). -->
{#snippet draftMark()}
  <span
    class="chat-row-draft"
    data-testid="chat-row-draft"
    role="img"
    aria-label="Draft"
    title="Draft"
  >
    <svg viewBox="0 0 256 256" width="12" height="12" aria-hidden="true">
      <path
        d="M227.31 73.37 182.63 28.68a16 16 0 0 0-22.63 0L36.69 152A15.86 15.86 0 0 0 32 163.31V208a16 16 0 0 0 16 16h44.69a15.86 15.86 0 0 0 11.31-4.69L227.31 96a16 16 0 0 0 0-22.63ZM92.69 208H48v-44.69l88-88L180.69 120ZM192 108.68 147.31 64l24-24L216 84.68Z"
        fill="currentColor"
      />
    </svg>
  </span>
{/snippet}

{#snippet conversationRow(row: ConversationRow)}
  {@const scopeLabel = railRowScopeLabel(row, {
    scope,
    companies: scopeCompanies,
    enabled: showScopeLabels,
    duplicateHumanTitles,
  })}
  {@const hasBadge =
    (row.unreadCount != null && row.unreadCount > 0) || row.unreadDot}
  <div role="listitem" class="chat-li">
    <button
      type="button"
      class="chat-row"
      class:unread={!!row.unreadCount || row.unreadDot}
      class:active={activeId === row.id}
      class:has-badge={hasBadge}
      data-kind={row.kind}
      data-conversation-id={row.id}
      title={scopeLabel?.text}
      onclick={() => void openRow(row)}
      oncontextmenu={(e) => openContextMenu(row, e)}
    >
      {#if row.kind === "channel"}
        <span class="chat-glyph" aria-hidden="true">#</span>
      {:else if row.kind === "group"}
        <span
          class="chat-avatar group"
          aria-hidden="true"
          data-testid="chat-group-avatar"
        >
          {row.memberCount ?? row.members?.length ?? 0}
        </span>
      {:else}
        {@const avatar = rowAvatar(row, avatarByUid)}
        <span
          class="chat-avatar"
          aria-hidden="true"
          data-testid="chat-dm-avatar"
          data-avatar={avatar.kind}
        >
          {#if avatar.src}
            <img src={avatar.src} alt="" />
          {:else}
            {avatar.initials}
          {/if}
        </span>
      {/if}
      {#if draftIdSet.has(row.id)}
        {@render draftMark()}
      {/if}
      <span class="chat-row-copy">
        <span class="chat-row-title">{row.title}</span>
        {#if scopeLabel}
          <span
            class="chat-row-scope"
            data-testid="chat-row-scope"
            data-kind={scopeLabel.kind}
            title={scopeLabel.text}>{scopeLabel.text}</span
          >
        {/if}
      </span>
      {#if scopeLabel}
        <span
          class="chat-row-reveal"
          data-testid="chat-row-reveal"
          aria-hidden="true">{scopeLabel.text}</span
        >
      {/if}
      {#if row.unreadCount != null && row.unreadCount > 0}
        <span
          class="chat-unread-badge"
          data-testid="chat-unread-badge"
          aria-label={`${row.unreadCount} unread`}
        >
          {row.unreadCount > 99 ? "99+" : row.unreadCount}
        </span>
      {:else if row.unreadDot}
        <span
          class="chat-unread-dot"
          data-testid="chat-unread-dot"
          aria-label="Unread"
        ></span>
      {/if}
    </button>
    <button
      type="button"
      class="chat-pin-btn"
      class:pinned={row.pinned}
      aria-label={row.pinned ? `Unpin ${row.title}` : `Pin ${row.title}`}
      aria-pressed={row.pinned}
      data-testid="chat-pin"
      onclick={() => handlePin(row)}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M6.2 1.8h3.6l.4 4.2 2.2 1.4v1.4H8.6v5.4h-1.2V8.8H3.6V7.4l2.2-1.4.4-4.2Z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </div>
{/snippet}

<style>
  .chat-sidebar {
    position: relative;
    /* height:100% must include the padding below, or the sidebar renders ~22px
       taller than .desktop-body and its overflow:hidden clips the account
       footer. There is no global border-box reset, so set it here. */
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    flex: 0 0 260px;
    align-self: stretch;
    width: 260px;
    min-height: 0;
    height: auto;
    overflow: hidden;
    border-right: 1px solid var(--line);
    background: var(--side-bg);
    backdrop-filter: var(--v4-glass-filter);
    -webkit-backdrop-filter: var(--v4-glass-filter);
    box-shadow: inset 1px 0 0 var(--v4-glass-highlight);
    font-family: var(--font-ui);
    color: var(--t1);
    /* border-box is load-bearing: without it, height + padding overflow the
       parent by ~22px and clip the identity footer on web and desktop. */
    box-sizing: border-box;
    padding: 12px 14px max(12px, env(safe-area-inset-bottom, 0px));
  }

  .chat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    flex: 0 0 auto;
    height: 28px;
    padding: 0;
    margin-bottom: 10px;
  }

  .chat-header-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .chat-scope-wrap {
    position: relative;
    min-width: 0;
  }

  .chat-scope-tile {
    display: grid;
    place-items: center;
    flex: 0 0 24px;
    width: 24px;
    height: 24px;
    border-radius: 7px;
    background: var(--btn-bg);
    color: var(--t2);
    font: 700 9px var(--font-ui);
    letter-spacing: 0.18px;
  }

  .chat-scope-tile.all {
    color: var(--t2);
  }

  .chat-pin-ic {
    display: inline-grid;
    place-items: center;
    color: var(--t2);
  }

  .chat-pin-btn {
    flex: 0 0 22px;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    margin-right: 2px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--t3);
    opacity: 0;
    cursor: pointer;
  }

  .chat-li:hover .chat-pin-btn,
  .chat-pin-btn.pinned,
  .chat-pin-btn:focus-visible {
    opacity: 1;
  }

  .chat-pin-btn:hover,
  .chat-pin-btn.pinned {
    color: var(--t1);
    background: var(--hover);
  }

  .chat-scope-pill {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    max-width: 140px;
    height: 26px;
    padding: 0;
    overflow: hidden;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
    transition: opacity 0.12s;
  }

  .chat-scope-pill:hover,
  .chat-scope-pill[aria-expanded="true"] {
    background: transparent;
    opacity: 0.65;
  }


  /* S3: 252px panel, 32px single-line rows (tile + label + chord inline),
     no wrap and no resting scrollbar artifact — token contract §6 scopePanel. */
  .chat-scope-menu {
    left: 0;
    right: auto;
    width: 252px;
    min-width: 252px;
    max-height: min(60vh, 420px);
    overflow-y: auto;
    scrollbar-width: none;
  }

  .chat-scope-menu::-webkit-scrollbar {
    display: none;
  }

  /* Double-class beats the later `.chat-popover-row { display: block }`. */
  .chat-popover-row.chat-scope-row {
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 9px;
    box-sizing: border-box;
    height: 32px;
    padding: 6px 8px;
    white-space: nowrap;
  }

  .chat-scope-avatar {
    display: grid;
    place-items: center;
    flex: 0 0 24px;
    width: 24px;
    height: 24px;
    border-radius: 7px;
    background: var(--btn-bg);
    color: var(--t2);
    font: 700 9px var(--font-ui);
    letter-spacing: 0.02em;
  }

  .chat-scope-avatar.tone-0 {
    background: var(--line2);
  }
  .chat-scope-avatar.tone-1 {
    background: var(--line2);
  }
  .chat-scope-avatar.tone-2 {
    background: var(--line2);
  }
  .chat-scope-avatar.tone-3 {
    background: var(--line2);
  }
  .chat-scope-avatar.tone-4 {
    background: var(--line2);
  }
  .chat-scope-avatar.tone-5 {
    background: var(--line2);
  }

  .chat-scope-row-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-scope-shortcut {
    flex: 0 0 auto;
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 400;
  }

  .chat-icon-btn {
    appearance: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
    transition:
      color 0.12s,
      background 0.12s;
  }

  .chat-icon-btn.on,
  .chat-icon-btn:hover,
  .chat-icon-btn[aria-expanded="true"] {
    border-color: transparent;
    background: var(--hover);
    color: var(--t1);
  }

  .chat-icon-btn svg {
    width: 14px;
    height: 14px;
  }

  .chat-filter-wrap {
    position: relative;
  }

  .chat-scroll {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    margin-right: -8px;
    padding: 0 8px 12px 0;
    scrollbar-color: var(--line) transparent;
    scrollbar-width: thin;
  }

  .chat-scroll::-webkit-scrollbar {
    width: 4px;
  }
  .chat-scroll::-webkit-scrollbar-track {
    background: transparent;
    margin: 10px 0;
  }
  .chat-scroll::-webkit-scrollbar-thumb {
    background: var(--line);
    border-radius: 999px;
  }
  .chat-scroll::-webkit-scrollbar-thumb:hover {
    background: var(--line2);
  }

  .chat-section-label {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
    margin: 0;
    padding: 12px 8px 4px;
    color: var(--t2);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .chat-section-label.inline {
    margin: 0;
    padding: 0;
  }

  /* Day-group header: name left, date right-aligned (D-13). */
  .chat-day-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  .chat-day-date {
    color: var(--t3);
    font-family: var(--font-mono, inherit);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }

  /* Real box so the pin control can sit beside the row (not nested in it). */
  .chat-li {
    position: relative;
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .chat-collapse-left {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .chat-collapse-chevron {
    color: var(--t3);
    font-size: 13px;
    line-height: 1;
    transition: transform 120ms ease;
  }

  .chat-collapse-chevron.open {
    transform: rotate(90deg);
  }

  .chat-section-label.pad-top {
    margin-top: 0;
    padding-top: 12px;
  }

  .chat-list {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .chat-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
    min-height: 0;
    padding: 6px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 13px;
    font-weight: 400;
    line-height: 1.2;
    text-align: left;
    cursor: pointer;
  }

  .chat-requests-row {
    color: var(--t3);
    font-size: 12px;
    font-weight: 500;
  }

  .chat-row:hover {
    background: var(--hover);
    color: var(--t1);
  }

  .chat-row.active {
    background: var(--sel);
    box-shadow: none;
    color: var(--t1);
  }

  .chat-row.unread .chat-row-title {
    color: var(--t1);
    font-weight: 500;
  }

  .chat-row-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-row-copy {
    display: flex;
    align-items: baseline;
    gap: 6px;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
  }

  .chat-row-copy .chat-row-title {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-row-scope {
    flex: 0 1000 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--t3);
    font-size: 12px;
    font-weight: 400;
  }

  .chat-row-reveal {
    display: none;
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    max-width: 46%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 1px 7px;
    border-radius: 4px;
    background: var(--elevated);
    box-shadow: -10px 0 8px 0 var(--elevated);
    color: var(--t3);
    font-size: 12px;
    font-weight: 400;
    line-height: 1.3;
    pointer-events: none;
    z-index: 1;
  }

  .chat-li:hover .chat-row:not(.has-badge) .chat-row-reveal,
  .chat-li:focus-within .chat-row:not(.has-badge) .chat-row-reveal,
  .chat-row:focus-visible:not(.has-badge) .chat-row-reveal {
    display: inline-block;
  }

  .chat-li:hover .chat-row:not(.has-badge) .chat-row-scope,
  .chat-li:focus-within .chat-row:not(.has-badge) .chat-row-scope,
  .chat-row:focus-visible:not(.has-badge) .chat-row-scope {
    visibility: hidden;
  }

  .chat-row-draft {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    color: var(--t3);
    line-height: 0;
  }

  .chat-glyph {
    flex: 0 0 16px;
    width: 16px;
    color: var(--t3);
    font-size: 16px;
    font-weight: 400;
    text-align: center;
  }

  .chat-avatar {
    display: grid;
    place-items: center;
    flex: 0 0 16px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--line2);
    color: var(--t2);
    font: 600 9px var(--font-ui);
    letter-spacing: 0.02em;
  }

  .chat-avatar.group {
    border-radius: 50%;
    font-variant-numeric: tabular-nums;
  }

  .chat-avatar img,
  .chat-switcher-avatar img {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    object-fit: cover;
    display: block;
  }

  .chat-unread-badge {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    min-width: 16px;
    height: 16px;
    margin-left: auto;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--ice-ink);
    color: var(--badge-fg);
    font-size: 10px;
    font-weight: 500;
    line-height: 1;
  }

  .chat-unread-dot {
    flex: 0 0 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 16px;
    height: 16px;
    margin-left: auto;
    border-radius: 50%;
    background: transparent;
  }

  .chat-unread-dot::after {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ice-ink);
  }

  .chat-collapse-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    margin-top: 8px;
    padding: 12px 8px 4px;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--t2);
    font: inherit;
    cursor: pointer;
  }

  .chat-collapse-row:hover {
    background: transparent;
    color: var(--t1);
  }

  .chat-collapse-meta {
    color: var(--t3);
    font-size: 10px;
    font-weight: 400;
  }

  .chat-history-affordance {
    width: 100%;
    margin-top: 8px;
    padding: 6px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
  }

  .chat-history-affordance:hover {
    color: var(--t2);
    background: var(--hover);
  }

  .chat-empty {
    padding: 16px 8px;
    color: var(--t3);
    font-size: 13px;
    font-weight: 400;
  }

  .chat-footer {
    position: relative;
    flex: 0 0 auto;
    border-top: 1px solid var(--line);
    margin-top: 8px;
    padding: 0;
  }

  .chat-user-card {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px;
    margin-top: 6px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s;
  }

  .chat-user-card:hover {
    background: var(--hover);
  }

  .chat-user-card:hover .chat-user-name {
    color: var(--t1);
  }

  .chat-user-card:hover .chat-chevron {
    color: var(--t2);
  }

  .chat-user-card .chat-avatar {
    flex: 0 0 22px;
    width: 22px;
    height: 22px;
    background: var(--line2);
    color: var(--t1);
    font: 600 10px var(--font-ui);
  }

  .chat-user-copy {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .chat-user-name {
    overflow: hidden;
    font-size: 12px;
    font-weight: 500;
    color: var(--t2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-user-status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--ok-ink);
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .chat-status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ok);
  }

  .chat-chevron {
    color: var(--t3);
    font-size: 10px;
    font-weight: 400;
    transform: rotate(90deg);
  }

  .chat-popover {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    /* Portaled to .desktop-shell via use:menuPortal and re-positioned fixed;
       sit above the sidebar/content chrome once escaped. */
    z-index: 60;
    display: flex;
    flex-direction: column;
    min-width: 160px;
    max-height: 280px;
    overflow-y: auto;
    padding: 6px;
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    background: var(--panel-bg);
    box-shadow: var(--panel-shadow);
    backdrop-filter: blur(40px) saturate(1.5);
    -webkit-backdrop-filter: blur(40px) saturate(1.5);
  }

  :global(:root[data-force-theme="dark"]) .chat-popover,
  :global(.dark) .chat-popover {
    background: var(--panel-bg);
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-force-theme="light"])) .chat-popover {
      background: var(--panel-bg);
    }
  }

  .chat-popover.footer {
    top: auto;
    bottom: calc(100% + 4px);
    left: 8px;
    right: 8px;
  }

  /* Cursor-anchored right-click menu (portaled to .desktop-shell). */
  .chat-context-menu {
    position: fixed;
    z-index: 70;
    display: flex;
    flex-direction: column;
    min-width: 180px;
    padding: 6px;
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    background: var(--panel-bg);
    box-shadow: var(--panel-shadow);
    backdrop-filter: blur(40px) saturate(1.5);
    -webkit-backdrop-filter: blur(40px) saturate(1.5);
  }

  .chat-popover-row {
    display: block;
    width: 100%;
    padding: 6px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 12px;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
  }

  .chat-popover-row:hover,
  .chat-popover-row.active {
    background: var(--hover);
    color: var(--t1);
  }

  .chat-popover-row.active {
    font-weight: 500;
  }

  .chat-history {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    padding: 12px 6px;
  }

  /* The history results own their scroll region — without this the (up to
     ~1000-row) list overflows the fixed-height glass sidebar (overflow:hidden)
     and renders clipped and un-scrollable. */
  .chat-history-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }

  .chat-history-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 4px 8px;
  }

  .chat-history-scope {
    margin-left: auto;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 11px);
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .chat-history-day {
    margin: 10px 0 2px;
    padding: 0 10px;
    color: var(--t3);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .chat-history-day:first-child {
    margin-top: 2px;
  }

  .chat-history-helper {
    /* Align with the switcher rows: 6px list inset + 10px row padding. */
    margin: 0 6px 8px;
    padding: 0 10px;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 11px);
    font-weight: 400;
    line-height: 1.35;
  }

  .chat-search-hit {
    align-items: flex-start;
    min-height: 44px;
    padding-top: 6px;
    padding-bottom: 6px;
  }

  .chat-search-hit-copy {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .chat-search-hit-title {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .chat-search-snippet {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 12px);
    font-weight: 400;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-search-meta {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
    max-width: 88px;
  }

  .chat-type-tag {
    color: var(--v4-text-3);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .chat-search-time {
    color: var(--v4-text-3);
    font-size: 10px;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .chat-search-input {
    box-sizing: border-box;
    width: calc(100% - 8px);
    margin: 0 4px 8px;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-field);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-secondary, 13px);
    font-weight: 400;
  }

  .chat-search-input:focus {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -2px;
  }

  .chat-text-btn {
    padding: 4px 6px;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-secondary, 13px);
    font-weight: 500;
    cursor: pointer;
  }

  .chat-text-btn:hover {
    color: var(--v4-text-1);
  }

  /* ===== Filter popover (?view=v2) ===== */
  .chat-filter-menu {
    box-sizing: border-box;
    gap: 2px;
    min-width: 0;
    max-width: min(360px, calc(100vw - 16px));
    padding: 6px;
    overflow-x: hidden;
    z-index: 80;
  }

  .chat-filter-caption {
    margin: 0;
    padding: 2px 6px 4px;
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .chat-filter-caption.pad-top {
    padding-top: 8px;
  }

  .chat-sort-toggle {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
  }

  .chat-sort-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill, 980px);
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: var(--type-metadata, 13px);
    font-weight: 500;
    cursor: pointer;
    transition:
      background 0.12s,
      color 0.12s,
      border-color 0.12s;
  }

  .chat-sort-pill:hover {
    background: var(--hover);
    color: var(--t1);
  }

  .chat-sort-pill.active {
    border-color: transparent;
    background: var(--v4-control-bg);
    color: var(--t1);
  }

  .chat-sort-ic {
    font-size: 11px;
    line-height: 1;
  }

  .chat-filter-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 6px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: var(--type-metadata, 13px);
    font-weight: 400;
    text-align: left;
    cursor: pointer;
  }

  .chat-filter-row:hover,
  .chat-filter-row.active {
    background: var(--hover);
  }

  .chat-filter-lead {
    display: inline-grid;
    place-items: center;
    width: 18px;
    color: var(--t2);
    font-size: 12px;
    line-height: 1;
  }

  .chat-filter-text {
    flex: 1 1 auto;
    min-width: 0;
  }

  .chat-filter-check {
    color: var(--t2);
    font-size: 12px;
    line-height: 1;
  }

  .chat-people-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .chat-person-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 6px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: var(--type-metadata, 13px);
    font-weight: 400;
    text-align: left;
    cursor: pointer;
  }

  .chat-person-row:hover,
  .chat-person-row.active {
    background: var(--hover);
  }

  .chat-person-avatar {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--v4-control-bg);
    color: var(--t2);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .chat-person-name {
    flex: 1 1 auto;
  }

  .chat-person-tag {
    padding: 1px 6px;
    border-radius: var(--v4-radius-pill, 980px);
    background: var(--v4-control-bg);
    color: var(--t3);
    font-size: 10px;
    font-weight: 500;
  }

  /* ===== Top-anchored overlays: search switcher + history (?view=v2) ===== */
  .chat-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    justify-content: center;
    padding: 12px;
    /* Dim, never wash: text-1 is near-white in dark mode, so a text-1 scrim
       BRIGHTENED the app behind modals. A black scrim is the convention in
       both themes. */
    background: rgba(0, 0, 0, 0.45);
  }

  .chat-overlay.top {
    align-items: flex-start;
    padding-top: 88px;
  }

  .chat-switcher {
    display: flex;
    flex-direction: column;
    width: min(560px, 100%);
    max-height: min(60vh, 460px);
    overflow: hidden;
    border: 1px solid var(--v4-hairline);
    border-radius: 14px;
    background: var(--v4-surface-solid, #fff);
    box-shadow: var(--v4-shadow-window, var(--panel-shadow));
  }

  .chat-switcher-search {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--v4-hairline);
  }

  .chat-switcher-search-ic {
    display: grid;
    place-items: center;
    color: var(--t3);
  }

  .chat-switcher-search-ic svg {
    width: 15px;
    height: 15px;
  }

  .chat-switcher-input {
    flex: 1 1 auto;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 15px;
    font-weight: 400;
  }

  .chat-switcher-input:focus {
    outline: none;
  }

  .chat-switcher-input::placeholder {
    color: var(--t3);
  }

  .chat-switcher-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
    overflow-y: auto;
    padding: 6px;
  }

  .chat-switcher-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 13px;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
  }

  .chat-switcher-row:hover {
    background: var(--hover);
  }

  .chat-switcher-hash {
    display: inline-grid;
    place-items: center;
    width: 20px;
    color: var(--t3);
    font-size: 14px;
  }

  .chat-switcher-avatar {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--v4-control-bg);
    color: var(--t2);
    font-size: 8px;
    font-weight: 600;
  }

  .chat-switcher-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-switcher-company {
    flex: 0 0 auto;
    color: var(--t3);
    font-size: 12px;
    font-weight: 400;
  }

  :global(:root[data-force-theme="dark"]) .chat-switcher,
  :global(.dark) .chat-switcher {
    background: var(--v4-surface-solid, #303030);
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-force-theme="light"])) .chat-switcher {
      background: var(--v4-surface-solid, #303030);
    }
  }
</style>
