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
  import type { EntryPointResult } from "./lifecycle-entry-points.js";
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
    monogramFor,
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
    loadIncludeNonMemberChannels,
    saveIncludeNonMemberChannels,
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
    DEFAULT_SHOW_FILTER,
    type ShowFilter,
    type SortMode,
    type ScopeCompany,
  } from "./sidebar-model";
  import type { RowExtrasResolver } from "./row-extras.js";
  import {
    filterSwitcher,
    switcherInitials,
    switcherRowsFromConversations,
    type SwitcherRow,
  } from "./sidebar-modal-fixtures";
  import CreateModal from "./CreateModal.svelte";
  import CompanyIcon from "../company/CompanyIcon.svelte";
  import { focusOnMount, menuPortal, portal } from "./portal.js";
  import {
    FILTER_POPOVER_MAX_PX,
    FILTER_POPOVER_RAIL_OVERHANG_PX,
  } from "./popover-placement.js";
  import "./tokens.css";
  import "./chat-tokens.css";
  import Caret from "../common/Caret.svelte";
  import CaretUpDown from "phosphor-svelte/lib/CaretUpDown";
  import CaretRight from "phosphor-svelte/lib/CaretRight";
  import Chat from "phosphor-svelte/lib/Chat";
  import ChatCircle from "phosphor-svelte/lib/ChatCircle";
  import Check from "phosphor-svelte/lib/Check";
  import Clock from "phosphor-svelte/lib/Clock";
  import FunnelSimple from "phosphor-svelte/lib/FunnelSimple";
  import GearSix from "phosphor-svelte/lib/GearSix";
  import X from "phosphor-svelte/lib/X";
  import Buildings from "phosphor-svelte/lib/Buildings";
  import Hash from "phosphor-svelte/lib/Hash";
  import Robot from "phosphor-svelte/lib/Robot";
  import MagnifyingGlass from "phosphor-svelte/lib/MagnifyingGlass";
  import PencilSimple from "phosphor-svelte/lib/PencilSimple";
  import Plus from "phosphor-svelte/lib/Plus";
  import PushPin from "phosphor-svelte/lib/PushPin";
  import SignOut from "phosphor-svelte/lib/SignOut";
  import Stack from "phosphor-svelte/lib/Stack";
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
    /**
     * Lifecycle entry points. The host runs the card action and navigates to
     * the posted card; the sidebar only offers the rows ("+" modal and the
     * company switcher) and shows a failure reason inline. Hosts without the
     * card seams leave these unset and the rows are hidden.
     */
    oncreatecompany?: (() => Promise<EntryPointResult>) | null;
    oncreateagent?: ((companyUid: string) => Promise<EntryPointResult>) | null;
    /** Emits the full normalized conversation list whenever it changes. */
    onrows?: (rows: ConversationRow[]) => void;
    /**
     * Bound for first-paint directory/contacts/DM-request reads. A hung or
     * 404'd optional fetch must not keep the conversation pane on a skeleton.
     * Tests pass a short value; production uses the default.
     */
    bootTimeoutMs?: number;
    /**
     * Phone-width shells keep this mounted while it is closed — it is what
     * loads the roster and falls back to #setup — and move it off screen
     * instead of unmounting it.
     */
    offscreen?: boolean;
    /**
     * First successful paint of the conversation rail or its empty state.
     * Not called while loading, and not called on an error-only rail.
     */
    onShellReady?: () => void;
    /**
     * Host-owned presence for project channels (US-015). True when someone
     * in that project is online via the presence store — never from timestamps.
     */
    projectHasPresence?: (row: ConversationRow) => boolean;
    /** Host decoration per row: badge, hover card, context-menu actions.
     *  Session metadata may still be loading — never hide the rail for it. */
    rowExtrasLoading?: boolean;
    rowExtrasError?: boolean;
    rowExtras?: RowExtrasResolver | null;
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
    oncreatecompany = null,
    oncreateagent = null,
    onrows,
    bootTimeoutMs = DEFAULT_SIDEBAR_BOOT_TIMEOUT_MS,
    offscreen = false,
    onShellReady,
    projectHasPresence = () => false,
    rowExtrasLoading = false,
    rowExtrasError = false,
    rowExtras = null,
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
  let newEntryBusy = $state<"company" | "agent" | null>(null);
  let newEntryError = $state<string | null>(null);
  let showFilter = $state<ShowFilter>(loadShowFilter(storage));
  /** Admin-only: browse project channels in this company you have not joined. */
  let includeNonMembers = $state(loadIncludeNonMemberChannels(storage));
  /** People filter is a SET: the concept lets you stack several at once. */
  let personFilters = $state<string[]>([]);

  function togglePersonFilter(uid: string): void {
    personFilters = personFilters.includes(uid)
      ? personFilters.filter((id) => id !== uid)
      : [...personFilters, uid];
  }

  /** Any filter differing from the panel's defaults — drives Reset. */
  const filtersDirty = $derived(
    showFilter !== DEFAULT_SHOW_FILTER ||
      personFilters.length > 0 ||
      includeNonMembers ||
      sortMode !== "recent",
  );

  function resetFilters(): void {
    personFilters = [];
    sortMode = "recent";
    if (includeNonMembers) setIncludeNonMembers(false);
    setShowFilter(DEFAULT_SHOW_FILTER);
  }
  // People aren't company-scoped — switching company scope clears a stale
  // person filter so it can't silently empty the newly scoped list.
  $effect(() => {
    void scope;
    personFilters = [];
  });

  function setShowFilter(next: ShowFilter): void {
    sidebarLog("filter-change", {
      from: showFilter,
      to: next,
      rail: railRows.length,
      filtered: filteredRows.length,
      browse: browseRows.length,
    });
    showFilter = next;
    saveShowFilter(next, storage);
    filterOpen = false;
  }

  /**
   * The admin-only switch. Turning it off drops the fetched browse-only rows
   * as well as hiding them, so the rail is not holding channels it will not
   * show.
   */
  function setIncludeNonMembers(next: boolean): void {
    sidebarLog("filter-include-non-members", {
      to: next,
      browse: browseRows.length,
    });
    includeNonMembers = next;
    saveIncludeNonMemberChannels(next, storage);
    if (!next) companyProjectChannels = [];
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
  /** Which face of CreateModal the New menu asked for. */
  let createStep = $state<"find" | "create">("find");
  let newMenuOpen = $state(false);
  let plusBtnEl = $state<HTMLButtonElement | null>(null);
  let newWrapEl = $state<HTMLElement | null>(null);
  /** "Search or jump to…" channel switcher overlay (?view=v2). */
  let searchOpen = $state(false);
  let searchButton = $state<HTMLButtonElement | null>(null);
  let activeSearchIndex = $state(0);
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
  let historyQueryDebounced = $state("");
  /** Right-click conversation context menu (anchored at the cursor). */
  let contextMenu = $state<{
    row: ConversationRow;
    x: number;
    y: number;
  } | null>(null);
  /** The row whose host hover card is showing, anchored to the row's box. */
  let hoverCard = $state<{ row: ConversationRow; x: number; y: number } | null>(null);
  let hoverHideTimer: ReturnType<typeof setTimeout> | null = null;
  const HOVER_HIDE_DELAY_MS = 180;
  /** Explicit expansion choices for host-owned child rows. Missing means the
   * host's default still applies, so fresh project channels can open eagerly. */
  let childRowsOpen = $state<Record<string, boolean>>({});

  function childrenAreOpen(rowId: string, defaultOpen: boolean): boolean {
    return childRowsOpen[rowId] ?? defaultOpen;
  }

  function observeChildGroup(_node: HTMLElement, callback: ((visible: boolean) => void) | undefined) {
    callback?.(true);
    return {
      update(next: typeof callback) { callback = next; callback?.(true); },
      destroy() { callback?.(false); },
    };
  }

  function toggleChildren(rowId: string, defaultOpen: boolean): void {
    childRowsOpen = {
      ...childRowsOpen,
      [rowId]: !childrenAreOpen(rowId, defaultOpen),
    };
  }

  function showHoverCard(row: ConversationRow, anchor: HTMLElement): void {
    if (!rowExtras?.(row)?.hoverCard) return;
    if (hoverHideTimer) clearTimeout(hoverHideTimer);
    hoverHideTimer = null;
    const box = anchor.getBoundingClientRect();
    hoverCard = { row, x: box.right + 6, y: box.top };
  }

  /** Delayed so the pointer can cross the gap into the card itself. */
  function scheduleHoverCardHide(): void {
    if (hoverHideTimer) clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(() => {
      hoverCard = null;
      hoverHideTimer = null;
    }, HOVER_HIDE_DELAY_MS);
  }

  function keepHoverCard(): void {
    if (hoverHideTimer) clearTimeout(hoverHideTimer);
    hoverHideTimer = null;
  }
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  /** First directory/contacts attempt has settled or timed out. */
  let bootAttempted = $state(false);
  let firstRefreshSettled = $state(
    (loadConversationCache(storage)?.channels?.length ?? 0) > 0 ||
      (loadConversationCache(storage)?.contacts?.length ?? 0) > 0 ||
      (seedDirectory?.length ?? 0) > 0,
  );
  let reportedShellReady = false;
  let scopeMenuEl: HTMLDivElement | null = $state(null);
  let filterWrapEl: HTMLDivElement | null = $state(null);
  let footerEl: HTMLDivElement | null = $state(null);

  // Mirror of selectedId — do not seed $state from a prop (state_referenced_locally).
  let activeId = $state<string | null>(null);
  $effect(() => {
    activeId = selectedId;
  });

  // History searches are debounced; conversation completion stays synchronous
  // so Enter can never open a result from the previous query.
  $effect(() => {
    const h = historyQuery;
    const timer = setTimeout(() => {
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
        // Every-plan company icon (NOT gated on brandingEnabled).
        iconUrl: w.iconUrl ?? null,
      })),
  );

  /** companyUid → presigned icon, for rows that only carry a uid. */
  const companyIcons = $derived(
    new Map(
      scopeCompanies
        .filter((c) => Boolean(c.iconUrl))
        .map((c) => [c.companyUid, c.iconUrl as string]),
    ),
  );

  /**
   * The icon for a rail row: the server's per-row icon first, then the
   * company roster. Company-scoped channels ONLY — a project or personal
   * channel keeps the generic `#`, which is still the right mark for it.
   */
  function rowCompanyIcon(row: ConversationRow): string | null {
    if (row.kind !== "channel") return null;
    if ((row.channelScope ?? "").trim() !== "company") return null;
    return row.iconUrl ?? companyIcons.get(row.companyUid ?? "") ?? null;
  }

  /** True when a rail row should show a company mark instead of `#`. */
  function isCompanyScopedRow(row: ConversationRow): boolean {
    return (
      row.kind === "channel" && (row.channelScope ?? "").trim() === "company"
    );
  }

  /**
   * The rail shows a row's own name.
   *
   * NOT the company name for company-scoped rows: a company can hold several
   * of them (the fixture set alone has #gtm-standup and #finance, both scope
   * "company", both Indigo), and titling each with its company turns them into
   * a run of identical rows. The channel HEADER does name the company, because
   * there only one row is selected at a time.
   */
  function railRowTitle(row: ConversationRow): string {
    return row.title;
  }

  /**
   * Create targets. `scopeCompanies` above is the BROWSE list and keeps
   * companies the user can only look at; creating in one of those is rejected
   * by the server, so the create modal gets the narrower list.
   */
  const createScopeCompanies = $derived(
    companiesForChannelCreate(companies, accountLabel),
  );

  /**
   * Companies an agent can be added to: the workspace list, plus any company
   * the directory already shows a company channel for. A company created a
   * moment ago has its channel before the workspace list refreshes, and the
   * "New agent" row must not lag behind it.
   */
  const agentCompanies = $derived.by<ScopeCompany[]>(() => {
    const out = new Map<string, ScopeCompany>();
    const knownLabels = new Set<string>();
    for (const company of scopeCompanies) {
      out.set(company.companyUid, company);
      knownLabels.add(company.label.trim().toLowerCase());
    }
    for (const workspace of companies ?? []) {
      knownLabels.add(workspace.slug.trim().toLowerCase());
    }
    for (const channel of channels) {
      const uid = channel.companyUid?.trim() ?? "";
      // Only server-named company channels qualify: a channel name is not a
      // company name, and older directories key by slug rather than uid.
      const label = channel.companyName?.trim() ?? "";
      if (!uid || !label || out.has(uid) || channel.scope !== "company") {
        continue;
      }
      if (
        knownLabels.has(uid.toLowerCase()) ||
        knownLabels.has(label.toLowerCase())
      ) {
        continue;
      }
      out.set(uid, { companyUid: uid, label });
    }
    return [...out.values()];
  });

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
      includeNonMembers ? [...allRows, ...browseRows] : allRows,
      {
        scope,
        show: showFilter,
        includeNonMembers,
        sort: sortMode,
        personUid: personFilters,
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
    filterSwitcher(liveSwitcherRows, searchQuery).slice(0, 200),
  );
  $effect(() => {
    switcherResults;
    activeSearchIndex = 0;
  });

  function closeSearch(): void {
    searchOpen = false;
    searchButton?.focus();
  }

  function searchKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSearch();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!switcherResults.length) return;
      activeSearchIndex = (activeSearchIndex + (event.key === "ArrowDown" ? 1 : -1) + switcherResults.length) % switcherResults.length;
      document.getElementById(`conversation-search-${activeSearchIndex}`)?.scrollIntoView?.({ block: "nearest" });
    } else if (event.key === "Enter" && switcherResults[activeSearchIndex]) {
      event.preventDefault();
      selectSwitcherRow(switcherResults[activeSearchIndex]);
    }
  }
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
  const scopeTones = $derived(
    scopeAvatarTones(
      scopeOptions.filter((o) => o.id !== "all").map((o) => o.label),
    ),
  );
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
    newMenuOpen = false;
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

  function openCreate(step: "find" | "create" = "find"): void {
    closeAllOverlays();
    createStep = step;
    createOpen = true;
  }

  /**
   * The plus is a menu, not a shortcut into the finder. "New message" and
   * "New project" are two faces of CreateModal; company and agent run the
   * host's lifecycle entry points directly, the same ones the finder exposed.
   */
  function openNewMenu(): void {
    const next = !newMenuOpen;
    closeAllOverlays();
    newEntryError = null;
    newMenuOpen = next;
  }

  function newFromMenu(step: "find" | "create"): void {
    newMenuOpen = false;
    openCreate(step);
  }

  async function runNewEntry(
    kind: "company" | "agent",
    run: () => Promise<EntryPointResult>,
  ): Promise<void> {
    if (newEntryBusy) return;
    newEntryBusy = kind;
    newEntryError = null;
    try {
      const result = await run();
      if (result.ok) {
        newMenuOpen = false;
        return;
      }
      newEntryError = result.reason;
    } catch (err) {
      newEntryError = err instanceof Error ? err.message : String(err);
    } finally {
      newEntryBusy = null;
    }
  }

  function newCompanyFromMenu(): void {
    if (!oncreatecompany) return;
    void runNewEntry("company", oncreatecompany);
  }

  /** One company: straight there. Several: the active scope, else the first. */
  function newAgentFromMenu(): void {
    if (!oncreateagent) return;
    const target =
      agentCompanies.find((c) => c.companyUid === scope) ?? agentCompanies[0];
    if (!target) return;
    void runNewEntry("agent", () => oncreateagent!(target.companyUid));
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
    closeSearch();
    searchQuery = "";
    jumpToSwitcherRow(row);
  }

  function openFooterMenu(): void {
    const next = !footerMenuOpen;
    closeAllOverlays();
    footerMenuOpen = next;
  }

  /** Failure reason from a switcher-triggered New company, shown inline. */
  let scopeEntryError = $state<string | null>(null);
  let scopeEntryBusy = $state(false);

  async function newCompanyFromSwitcher(): Promise<void> {
    if (!oncreatecompany || scopeEntryBusy) return;
    scopeEntryBusy = true;
    scopeEntryError = null;
    try {
      const result = await oncreatecompany();
      if (result.ok) {
        scopeMenuOpen = false;
        return;
      }
      scopeEntryError = result.reason;
    } catch (err) {
      scopeEntryError = err instanceof Error ? err.message : String(err);
    } finally {
      scopeEntryBusy = false;
    }
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

  /** Presigned icon for a scope-menu option, or null (all/personal/no icon). */
  function scopeOptionIcon(optionId: string): string | null {
    if (optionId === "all" || optionId === "personal") return null;
    return companyIcons.get(optionId) ?? null;
  }

  function scopeAvatarLabel(option: { id: string; label: string }): string {
    // "all" never reaches here — it renders the Stack glyph, not initials.
    if (option.id === "personal") return "PE";
    return initialsFor(option.label);
  }

  // Avatar hue from stable hash of label (monochrome-friendly tint via CSS vars).
  const SCOPE_TONE_COUNT = 6;

  function scopeToneSeed(label: string): number {
    let h = 0;
    for (let i = 0; i < label.length; i++)
      h = (h * 31 + label.charCodeAt(i)) | 0;
    return Math.abs(h) % SCOPE_TONE_COUNT;
  }

  /**
   * Company marks, resolved across the whole list rather than one at a time.
   *
   * Hashing each name independently is stable but not distinct: with two
   * companies the odds of a collision are one in six, and "Indigo" and
   * "Personal" happened to be a collision — both rendered the same green, so
   * the colour told you nothing. Seeding from the hash and then probing to the
   * next free tone keeps a company's colour stable while guaranteeing that no
   * two visible companies share one, up to the six the palette holds.
   *
   * "All companies" is a scope, not a tenant, and stays neutral.
   */
  function scopeAvatarTones(labels: string[]): Map<string, number> {
    const taken = new Set<number>();
    const tones = new Map<string, number>();
    for (const label of labels) {
      if (tones.has(label)) continue;
      const seed = scopeToneSeed(label);
      let tone = seed;
      for (let step = 0; step < SCOPE_TONE_COUNT; step++) {
        const candidate = (seed + step) % SCOPE_TONE_COUNT;
        if (!taken.has(candidate)) {
          tone = candidate;
          break;
        }
      }
      taken.add(tone);
      tones.set(label, tone);
    }
    return tones;
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
      !newMenuOpen &&
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
      if (newMenuOpen) {
        const menu = document.querySelector('[data-testid="chat-new-menu"]');
        const inside =
          (newWrapEl?.contains(event.target) ?? false) ||
          (menu?.contains(event.target) ?? false);
        if (!inside) newMenuOpen = false;
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
      if (scopeMenuOpen || filterOpen || footerMenuOpen || newMenuOpen) {
        scopeMenuOpen = false;
        filterOpen = false;
        footerMenuOpen = false;
        newMenuOpen = false;
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

  // US-021: debounced owner-scoped fetch while "Include channels I'm not in" is on.
  let companyProjectsSeq = 0;
  $effect(() => {
    const wantAllCompanies = includeNonMembers || searchOpen || createOpen;
    const scoped = scope !== "all" && scope !== "personal" ? [scope] : [];
    const uids = wantAllCompanies
      ? ownerCompanyUids.length > 0
        ? ownerCompanyUids
        : scopeCompanies.map((c) => c.companyUid)
      : scoped;
    if (uids.length === 0) return;
    const seq = ++companyProjectsSeq;
    const started = performance.now();
    sidebarLog("browse-channels-fetch-start", {
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
        sidebarLog("browse-channels-fetch-done", {
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
    // their existing reads. Paint cache/seed immediately — do not wait for
    // the directory (or session extras) before showing rows.
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
      bootAttempted = true;
      loading = false;
      firstRefreshSettled = true;
      maybeReportShellReady();
      void directory.finally(() => maybeReportShellReady());
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
    // Reconcile cached rows before revealing the complete list. Safety
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

      track(wakes.on("conversation:read", ({ id }) => {
        const row = allRows.find((row) => row.id === id);
        if (row?.kind === "dm" && row.personUid) {
          dmDots = clearDmDot(dmDots, row.personUid);
          saveDmDots(dmDots, storage);
          pairUnreads = clearPairUnread(pairUnreads, row.personUid);
          contacts = contacts.map((contact) => contact.personUid === row.personUid
            ? { ...contact, unreadCount: 0 } : contact);
        } else if (row?.channelId) {
          channels = clearChannelUnread(channels, row.channelId);
        }
      }));

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
  class:offscreen
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
            <Stack size={11} aria-hidden="true" />
          </span>
        {:else}
          <span
            class={`chat-scope-tile tone-${scopeTones.get(scopeLabel) ?? 0}`}
            aria-hidden="true">{initialsFor(scopeLabel)}</span
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
          use:menuPortal={{ anchor: scopeMenuEl, placement: "bottom-stretch" }}
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
              {#if scopeOptionIcon(option.id)}
                <!-- Real company favicon in place of the initials tile. -->
                <CompanyIcon iconUrl={scopeOptionIcon(option.id)} size={20} />
              {:else if option.id === "all"}
                <!-- Same Stack glyph the trigger tile carries: "All" is a
                     scope, not a tenant, so it never gets initials. -->
                <span class="chat-scope-avatar all" aria-hidden="true">
                  <Stack size={11} weight="bold" aria-hidden="true" />
                </span>
              {:else}
                <span
                  class={`chat-scope-avatar tone-${scopeTones.get(option.label) ?? 0}`}
                  aria-hidden="true"
                >
                  {scopeAvatarLabel(option)}
                </span>
              {/if}
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
          {#if oncreatecompany}
            <div class="chat-scope-sep" role="separator"></div>
            <button
              type="button"
              class="chat-popover-row chat-scope-row chat-scope-new"
              role="menuitem"
              data-testid="chat-scope-new-company"
              aria-busy={scopeEntryBusy ? "true" : undefined}
              disabled={scopeEntryBusy}
              onclick={() => void newCompanyFromSwitcher()}
            >
              <span class="chat-scope-avatar chat-scope-plus" aria-hidden="true">
                <Plus size={14} aria-hidden="true" />
              </span>
              <span class="chat-scope-row-label">New company</span>
            </button>
            {#if scopeEntryError}
              <p
                class="chat-scope-error"
                role="alert"
                data-testid="chat-scope-new-company-error"
              >
                {scopeEntryError}
              </p>
            {/if}
          {/if}
        </div>
      {/if}
    </div>

    <div class="chat-header-actions">
      <div class="chat-new-wrap" bind:this={newWrapEl}>
        <button
          type="button"
          class="chat-icon-btn"
          bind:this={plusBtnEl}
          data-testid="chat-new-message"
          aria-label="New"
          title="New"
          aria-haspopup="menu"
          aria-expanded={newMenuOpen}
          onclick={openNewMenu}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
        {#if newMenuOpen}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="chat-popover chat-new-menu"
            data-testid="chat-new-menu"
            role="menu"
            tabindex="-1"
            aria-label="Create"
            use:menuPortal={{ anchor: newWrapEl, placement: "bottom-start" }}
            onmousedown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              class="chat-popover-row"
              role="menuitem"
              data-testid="chat-new-message-item"
              onclick={() => newFromMenu("find")}
            >
              <span class="chat-popover-ic" aria-hidden="true">
                <ChatCircle size={14} />
              </span>
              New message
            </button>
            <button
              type="button"
              class="chat-popover-row"
              role="menuitem"
              data-testid="chat-new-project-item"
              onclick={() => newFromMenu("create")}
            >
              <span class="chat-popover-ic" aria-hidden="true">
                <Hash size={14} />
              </span>
              New project
            </button>
            <!-- Creating a company or an agent is not a message, so these do
                 not belong inside the composer. They live here, beside the
                 other two things the plus makes. -->
            {#if oncreatecompany}
              <button
                type="button"
                class="chat-popover-row"
                role="menuitem"
                data-testid="chat-new-company-item"
                aria-busy={newEntryBusy === "company" ? "true" : undefined}
                disabled={newEntryBusy != null}
                onclick={newCompanyFromMenu}
              >
                <span class="chat-popover-ic" aria-hidden="true">
                  <Buildings size={14} />
                </span>
                New company
              </button>
            {/if}
            {#if oncreateagent && agentCompanies.length > 0}
              <button
                type="button"
                class="chat-popover-row"
                role="menuitem"
                data-testid="chat-new-agent-item"
                aria-busy={newEntryBusy === "agent" ? "true" : undefined}
                disabled={newEntryBusy != null}
                onclick={newAgentFromMenu}
              >
                <span class="chat-popover-ic" aria-hidden="true">
                  <Robot size={14} />
                </span>
                New agent
              </button>
            {/if}
            {#if newEntryError}
              <p class="chat-scope-error" role="alert" data-testid="chat-new-error">
                {newEntryError}
              </p>
            {/if}
          </div>
        {/if}
      </div>
      <button
        type="button"
        class="chat-icon-btn"
        data-testid="chat-search"
        aria-label="Search or jump to a conversation"
        title="Search or jump to…"
        onclick={openSearch}
        bind:this={searchButton}
      >
        <MagnifyingGlass size={16} aria-hidden="true" />
      </button>
      <div class="chat-filter-wrap" bind:this={filterWrapEl}>
        <button
          type="button"
          class="chat-icon-btn"
          class:on={filtersDirty}
          data-testid="chat-filter"
          aria-label="Filter conversations"
          aria-expanded={filterOpen}
          title="Filter"
          onclick={openFilterMenu}
        >
          <FunnelSimple size={16} aria-hidden="true" />
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
            <!-- The panel itself does not scroll: an inner scroller keeps the
                 bar off the rounded edge and inside the padding, the way every
                 other scroll region in the concept is built. -->
            <div class="chat-filter-scroll">
            <div class="chat-filter-caption chat-filter-caption-row">
              <span>Sort by</span>
              {#if filtersDirty}
                <button
                  type="button"
                  class="chat-filter-reset"
                  data-testid="chat-filter-reset"
                  onclick={resetFilters}
                >
                  Reset
                </button>
              {/if}
            </div>
            <div class="chat-sort-toggle" role="group" aria-label="Sort by">
              <button
                type="button"
                class="chat-sort-pill"
                class:active={sortMode === "recent"}
                aria-pressed={sortMode === "recent"}
                onclick={() => (sortMode = "recent")}
              >
                <Clock size={12} aria-hidden="true" />
                Recent
              </button>
              <button
                type="button"
                class="chat-sort-pill"
                class:active={sortMode === "type"}
                aria-pressed={sortMode === "type"}
                onclick={() => (sortMode = "type")}
              >
                <Stack size={12} aria-hidden="true" />
                Type
              </button>
            </div>

            <div class="chat-filter-caption pad-top">Show</div>
            <button
              type="button"
              class="chat-filter-row"
              class:active={showFilter === "all"}
              data-testid="chat-filter-all"
              onclick={() => {
                // People rows are DMs/groups, so person + a Show view compose
                // to an empty list. Picking a view drops the person selection.
                personFilters = [];
                setShowFilter("all");
              }}
            >
              <span class="chat-filter-lead" aria-hidden="true"><Stack size={14} /></span>
              <span class="chat-filter-text">All</span>
              {#if showFilter === "all"}
                <span class="chat-filter-check" aria-hidden="true"><Check size={12} weight="bold" /></span>
              {/if}
            </button>
            <button
              type="button"
              class="chat-filter-row"
              class:active={showFilter === "projects"}
              onclick={() => {
                // People rows are DMs/groups, so person + a Show view compose
                // to an empty list. Picking a view drops the person selection.
                personFilters = [];
                setShowFilter("projects");
              }}
            >
              <span class="chat-filter-lead" aria-hidden="true"><Hash size={14} /></span>
              <span class="chat-filter-text">Project channels</span>
              {#if showFilter === "projects"}
                <span class="chat-filter-check" aria-hidden="true"><Check size={12} weight="bold" /></span>
              {/if}
            </button>
            <button
              type="button"
              class="chat-filter-row"
              class:active={showFilter === "dms"}
              onclick={() => {
                // People rows are DMs/groups, so person + a Show view compose
                // to an empty list. Picking a view drops the person selection.
                personFilters = [];
                setShowFilter("dms");
              }}
            >
              <span class="chat-filter-lead" aria-hidden="true"><ChatCircle size={14} /></span>
              <span class="chat-filter-text">DMs &amp; groups</span>
              {#if showFilter === "dms"}
                <span class="chat-filter-check" aria-hidden="true"><Check size={12} weight="bold" /></span>
              {/if}
            </button>
            {#if canSeeCompanyProjects}
              <div class="chat-filter-divider" aria-hidden="true"></div>
              <!-- Owner/admin-only: browse every project channel in a company
                     the caller administers. This is a modifier on whichever
                     Show row is selected, not a fifth mutually-exclusive view —
                     the old "Company projects" row conflated the two. Gated on
                     the shared self-admin helper (hidden when role is unknown
                     / not admin). -->
              <button
                type="button"
                class="chat-filter-row"
                role="menuitemcheckbox"
                aria-checked={includeNonMembers}
                data-testid="chat-filter-include-non-members"
                onclick={() => setIncludeNonMembers(!includeNonMembers)}
              >
                <span
                  class="chat-filter-box"
                  class:on={includeNonMembers}
                  aria-hidden="true"
                >
                  {#if includeNonMembers}
                    <Check size={10} weight="bold" />
                  {/if}
                </span>
                <span class="chat-filter-text">Include channels I'm not in</span>
              </button>
            {/if}

            {#if people.length > 0}
              <div class="chat-filter-caption pad-top chat-filter-caption-row">
                <span>People</span>
                {#if personFilters.length > 0}
                  <button
                    type="button"
                    class="chat-filter-reset"
                    data-testid="chat-filter-clear-people"
                    onclick={() => (personFilters = [])}
                  >
                    Clear
                  </button>
                {/if}
              </div>
              <div class="chat-people-list">
                {#each people as person (person.personUid)}
                  {@const isYou =
                    isSelf(person.personUid, self) ||
                    /\(you\)/i.test(person.label)}
                  {@const personName = person.label
                    .replace(/\s*\(you\)\s*/i, "")
                    .trim()}
                  {@const selected = personFilters.includes(person.personUid)}
                  <button
                    type="button"
                    class="chat-person-row"
                    class:active={selected}
                    role="menuitemcheckbox"
                    aria-checked={selected}
                    data-testid="chat-filter-person"
                    onclick={() => {
                      const selecting = !selected;
                      togglePersonFilter(person.personUid);
                      // A person's rows are DMs/groups — clear any Show filter
                      // that would strip them (else the combo yields []).
                      if (selecting) showFilter = "all";
                      // Menu stays open: picking people is a multi-select.
                    }}
                  >
                    <span class="chat-person-avatar" aria-hidden="true"
                      >{monogramFor(personName)}</span
                    >
                    <span class="chat-person-name">{personName}</span>
                    {#if isYou}
                      <span class="chat-person-tag">you</span>
                    {/if}
                    {#if selected}
                      <span class="chat-filter-check" aria-hidden="true"
                        ><Check size={12} weight="bold" /></span
                      >
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </header>

  <div class="chat-scroll" data-testid="chat-conversation-list" aria-busy={allRows.length === 0 && (!firstRefreshSettled || loading)}>
    {#if allRows.length === 0 && (!firstRefreshSettled || loading)}
      <div class="sidebar-skeleton" role="status" aria-label="Loading conversations" data-testid="sidebar-loading">
        <span class="sr-only">Loading conversations…</span>
        {#each Array(10) as _, index}
          <div class="skeleton-row" aria-hidden="true"><span class="skeleton-icon"></span><span class="skeleton-line" style:width={`${45 + (index % 3) * 15}%`}></span></div>
        {/each}
      </div>
    {:else}
    {#if rowExtrasError}<div role="status" class="chat-empty">Some project sessions couldn’t load. Retrying…</div>{/if}
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
          <PushPin size={10} weight="fill" aria-hidden="true" />
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
      </span>
      <!-- Up-down caret: this opens a menu that can appear above or below the
           row, and it is a switcher, not a disclosure. -->
      <span class="chat-user-caret" data-testid="caret" aria-hidden="true">
        <CaretUpDown size={12} />
      </span>
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
            <span class="chat-popover-ic" aria-hidden="true">
              <GearSix size={14} />
            </span>
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
          <span class="chat-popover-ic" aria-hidden="true">
            <SignOut size={14} />
          </span>
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
      {#each rowExtras?.(contextMenu.row)?.actions ?? [] as action (action.id)}
        <button
          type="button"
          class="chat-popover-row"
          role="menuitem"
          data-testid={`chat-context-action-${action.id}`}
          onclick={() => {
            contextMenu = null;
            action.onselect();
          }}
        >
          {action.label}
        </button>
      {/each}
    </div>
  {/if}

  {#if hoverCard}
    {@const HoverCard = rowExtras?.(hoverCard.row)?.hoverCard}
    {#if HoverCard}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="chat-row-hover-card"
        data-testid="chat-row-hover-card"
        data-conversation-id={hoverCard.row.id}
        use:portal
        style="left:{hoverCard.x}px; top:{hoverCard.y}px;"
        onmouseenter={keepHoverCard}
        onmouseleave={scheduleHoverCardHide}
      >
        <HoverCard row={hoverCard.row} />
      </div>
    {/if}
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
            <MagnifyingGlass size={16} aria-hidden="true" />
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
                      <span class="chat-glyph" data-glyph="hash" aria-hidden="true"><Hash size={13} /></span>
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
                        <span class="chat-row-title">{railRowTitle(row)}</span>
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
            <MagnifyingGlass size={16} aria-hidden="true" />
          </span>
          <input
            class="chat-switcher-input"
            type="text"
            use:focusOnMount
            placeholder="Search or jump to…"
            bind:value={searchQuery}
            aria-label="Search or jump to a conversation"
            role="combobox"
            aria-expanded="true"
            aria-controls="conversation-search-results"
            aria-autocomplete="list"
            aria-activedescendant={switcherResults.length ? `conversation-search-${activeSearchIndex}` : undefined}
            onkeydown={searchKeydown}
          />
          <!-- `.sd-close`, as on every dismissable surface in the concept. -->
          <button
            type="button"
            class="chat-switcher-close"
            data-testid="chat-search-close"
            aria-label="Close search"
            title="Close"
            onclick={() => (searchOpen = false)}
          >
            <X size={13} weight="bold" aria-hidden="true" />
          </button>
        </div>
        <div class="chat-switcher-list" id="conversation-search-results" role="listbox" aria-label="Conversations">
          {#each switcherResults as row, index (row.id)}
            <button
              type="button"
              class="chat-switcher-row"
              role="option"
              id={`conversation-search-${index}`}
              aria-selected={index === activeSearchIndex}
              class:active={index === activeSearchIndex}
              tabindex="-1"
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
      initialStep={createStep}
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
    <PencilSimple size={12} aria-hidden="true" />
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
  {@const showProjectPresence =
    row.kind === "channel" &&
    ((row.channelScope ?? "").trim() === "project" ||
      Boolean((row.projectId ?? "").trim())) &&
    projectHasPresence(row)}
  {@const extras = rowExtras?.(row) ?? null}
  {@const hasChildren = Boolean(extras?.children?.length)}
  {@const childrenOpen = childrenAreOpen(row.id, extras?.childrenExpandedByDefault === true)}
  {@const isActive =
    activeId === row.id && !extras?.children?.some((child) => child.selected)}
  <div class="chat-row-group" data-testid="chat-row-group">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      role="listitem"
      class="chat-li"
      class:active={isActive}
      class:has-badge={hasBadge}
      onmouseenter={(e) => showHoverCard(row, e.currentTarget)}
      onmouseleave={scheduleHoverCardHide}
    >
      {#if hasChildren}
        <button
          type="button"
          class="chat-row-children-toggle"
          class:open={childrenOpen}
          data-testid="chat-row-children-toggle"
          aria-label={`${childrenOpen ? 'Collapse' : 'Expand'} ${extras?.childrenLabel ?? row.title}`}
          aria-expanded={childrenOpen}
          onclick={() => toggleChildren(row.id, extras?.childrenExpandedByDefault === true)}
        >
          <CaretRight size={10} weight="bold" aria-hidden="true" />
        </button>
      {/if}
      <button
        type="button"
        class="chat-row"
        class:unread={!!row.unreadCount || row.unreadDot}
        class:active={isActive}
        class:has-badge={hasBadge}
        data-kind={row.kind}
        data-conversation-id={row.id}
        title={scopeLabel?.text}
        onclick={() => void openRow(row)}
        oncontextmenu={(e) => openContextMenu(row, e)}
      >
        {#if row.kind === "channel"}
          <span class="chat-glyph-wrap" aria-hidden="true">
            {#if !hasChildren && isCompanyScopedRow(row)}
              <CompanyIcon iconUrl={rowCompanyIcon(row)} size={16} />
            {:else if !hasChildren}
              <span class="chat-glyph" data-glyph="hash" aria-hidden="true"><Hash size={13} /></span>
            {/if}
            {#if showProjectPresence}
              <span
                class="chat-presence-dot"
                data-testid="chat-presence-dot"
                aria-label="Someone online"
              ></span>
            {/if}
          </span>
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
        <span class="chat-row-copy">
          <span class="chat-row-title">{railRowTitle(row)}</span>
          {#if extras?.badge}
            <span class="chat-row-extra-badge" data-testid="chat-row-extra-badge">
              {extras.badge}
            </span>
          {/if}
          {#if scopeLabel}
            <span
              class="chat-row-scope"
              data-testid="chat-row-scope"
              data-kind={scopeLabel.kind}
              title={scopeLabel.text}>{scopeLabel.text}</span
            >
          {/if}
        </span>
      </button>
      <!-- Pin and the unread badge are siblings of the row button (a button
           cannot nest a button), so `.chat-li` — not `.chat-row` — carries the
           hover/selected fill. That keeps the pin inside the highlighted box
           and lets it sit to the LEFT of any badge or unread dot. -->
      <button
        type="button"
        class="chat-pin-btn"
        class:pinned={row.pinned}
        aria-label={row.pinned ? `Unpin ${row.title}` : `Pin ${row.title}`}
        aria-pressed={row.pinned}
        data-testid="chat-pin"
        onclick={() => handlePin(row)}
      >
        <!-- Solid once it is pinned, so the control reads as ON at a glance —
             the same filled mark the PINNED section header carries. -->
        <PushPin
          size={12}
          weight={row.pinned ? "fill" : "regular"}
          aria-hidden="true"
        />
      </button>
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
      <!-- Trailing, not leading: the pencil is row status, and between the
           channel glyph and the title it pushed every drafted row's name out
           of the column the rest of the list lines up on. -->
      {#if draftIdSet.has(row.id)}
        {@render draftMark()}
      {/if}
    </div>
    {#if hasChildren && childrenOpen}
      <div
        class="chat-row-children"
        use:observeChildGroup={extras?.onChildrenVisibilityChange}
        role="list"
        aria-label={extras?.childrenLabel ?? `Items for ${row.title}`}
        data-testid="chat-row-children"
      >
        {#each extras?.children ?? [] as child (child.id)}
          <button
            type="button"
            class="chat-row-child"
            class:action={child.kind === "action"}
            class:selected={child.selected === true}
            aria-current={child.selected ? "page" : undefined}
            title={child.meta ? `${child.label} · ${child.meta}` : child.label}
            data-testid="chat-row-child"
            data-child-id={child.id}
            onclick={child.onselect}
          >
            <span
              class="chat-row-child-mark"
              data-child-kind={child.kind ?? "item"}
              data-status={child.status ?? undefined}
              aria-hidden="true"
            >
              {#if child.kind === "action"}
                <Plus size={12} aria-hidden="true" />
              {:else}
                <Chat size={14} aria-hidden="true" />
              {/if}
            </span>
            <span class="chat-row-child-label">{child.label}</span>
            {#if child.meta}
              <span class="chat-row-child-meta">{child.meta}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
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
    flex: 0 0 var(--sidebar-width, 280px);
    align-self: stretch;
    width: var(--sidebar-width, 280px);
    min-height: 0;
    height: auto;
    overflow: hidden;
    border-right: 1px solid var(--line);
    /* One glass pass only. The window already blurs what is behind it; a
       second backdrop-filter here re-blurred and re-saturated that result, so
       `--side-bg` at 18% white painted as near-opaque white instead of the
       translucent rail the design draws. The concept's `.sidebar` is a flat
       `var(--side-bg)` over the window glass with no filter and no inner
       highlight — match it. */
    background: var(--side-bg);
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
    /* `line-height: 1`, as IdentityMark does. The `font:` shorthand resets
       line-height to `normal`, and `normal` is the font's own line box —
       WebKit folds the line gap into it where Chromium does not, so a
       centred all-caps monogram sat visibly high in the app and looked
       fine in the browser harness. An explicit number removes the
       variable. */
    line-height: 1;
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
    /* Keeps a 22px hit target without letting it set the row's height: the
       concept's row is 31px, driven by the 13px/1.45 title, and an unclamped
       22px control pushed every row to 34px. */
    margin-block: -2px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--t3);
    opacity: 0;
    cursor: pointer;
  }

  /* Hover-only, including when already pinned — the PINNED section header is
     what says a row is pinned; the control itself stays out of the way. */
  .chat-li:hover .chat-pin-btn,
  .chat-pin-btn:focus-visible {
    opacity: 1;
  }

  .chat-pin-btn.pinned {
    color: var(--t1);
  }

  .chat-pin-btn:hover {
    color: var(--t1);
    background: var(--btn-bg);
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


  /* 32px single-line rows (tile + label + chord inline), no wrap and no
     resting scrollbar artifact — token contract §6 scopePanel.
     Width comes from the rail, not from this sheet: at a fixed 252px the
     panel hung off the sidebar's right edge on a narrower window. The
     `bottom-stretch` portal spans it to the rail, inset 10px each side — the
     same span the footer account menu uses. */
  /* Double-class, because `.chat-popover` is authored later in this sheet and
     would otherwise win `left` / `right` / `min-width` on equal specificity. */
  .chat-popover.chat-scope-menu {
    box-sizing: border-box;
    min-width: 0;
    max-height: min(60vh, 420px);
    overflow-y: auto;
    scrollbar-width: none;
  }

  .chat-scope-menu::-webkit-scrollbar {
    display: none;
  }

  .chat-new-wrap {
    position: relative;
    display: inline-flex;
  }

  /* The concept's `.new-panel`. */
  .chat-popover.chat-new-menu {
    left: 0;
    right: auto;
    width: 180px;
    min-width: 0;
  }

  .chat-popover-row.chat-scope-row {
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
    flex: 0 0 20px;
    width: 20px;
    height: 20px;
    border-radius: 6px;
    background: var(--btn-bg);
    color: var(--t2);
    font: 700 8px var(--font-ui);
    /* `line-height: 1`, as IdentityMark does. The `font:` shorthand resets
       line-height to `normal`, and `normal` is the font's own line box —
       WebKit folds the line gap into it where Chromium does not, so a
       centred all-caps monogram sat visibly high in the app and looked
       fine in the browser harness. An explicit number removes the
       variable. */
    line-height: 1;
    letter-spacing: 0.02em;
  }

  /* Company marks. Six 135deg pairs from the V2 concept — the point is that
     two companies never look alike at a glance, which a single neutral fill
     cannot do however many slots it has. White ink on all six; they are dark
     enough at both ends to carry it in either theme.

     `scopeAvatarTone()` hashes the label into a slot, so the assignment is
     stable per company but arbitrary across them. Pinning a specific company
     to a specific pair is a host decision, not a UI-package one. */
  .chat-scope-tile.tone-0,
  .chat-scope-avatar.tone-0 {
    background: linear-gradient(135deg, #6d5efc 0%, #c86bf0 100%);
    color: #fff;
  }
  .chat-scope-tile.tone-1,
  .chat-scope-avatar.tone-1 {
    background: linear-gradient(135deg, #ff9f43 0%, #ff5f6d 100%);
    color: #fff;
  }
  .chat-scope-tile.tone-2,
  .chat-scope-avatar.tone-2 {
    background: linear-gradient(135deg, #12c2a0 0%, #7ad86b 100%);
    color: #fff;
  }
  .chat-scope-tile.tone-3,
  .chat-scope-avatar.tone-3 {
    background: linear-gradient(135deg, #2f80ed 0%, #56ccf2 100%);
    color: #fff;
  }
  .chat-scope-tile.tone-4,
  .chat-scope-avatar.tone-4 {
    background: linear-gradient(135deg, #f2529b 0%, #f7b42c 100%);
    color: #fff;
  }
  .chat-scope-tile.tone-5,
  .chat-scope-avatar.tone-5 {
    background: linear-gradient(135deg, #0f8fa8 0%, #6a5af9 100%);
    color: #fff;
  }

  /* "All companies" is not a company — it keeps the neutral fill and the
     Stack glyph so it reads as a scope, not another tenant. */
  .chat-scope-tile.all,
  .chat-scope-avatar.all,
  .chat-scope-avatar.chat-scope-plus {
    background: var(--btn-bg);
    color: var(--t2);
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

  .sidebar-skeleton { padding: 12px 8px; }
  .skeleton-row { display: flex; align-items: center; gap: 10px; height: 36px; }
  .skeleton-icon { width: 20px; height: 20px; border-radius: 5px; background: var(--line); }
  .skeleton-line { height: 10px; border-radius: 4px; background: var(--line); }
  .chat-scroll {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    margin-right: -8px;
    padding: 0 8px 12px 0;
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

  /* The concept's `.grp .d` is a plain 10px mono date — it does NOT inherit
     the label's 600 weight or 0.1em tracking, which is what made the date read
     as loud as the day name beside it. */
  .chat-day-date {
    color: var(--t3);
    font-family: var(--font-mono, inherit);
    font-size: 10px;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    letter-spacing: normal;
  }

  /* Real box so the pin control can sit beside the row (not nested in it). */
  .chat-row-group {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .chat-li {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    min-width: 0;
    /* The concept's `.row` — 6px/8px inset, 8px radius — lives here rather
       than on `.chat-row` so the trailing pin and badge sit inside the same
       hover fill instead of hanging off its right edge. */
    padding: 6px 8px;
    border-radius: 8px;
  }

  .chat-li:hover {
    background: var(--hover);
  }

  .chat-li.active {
    background: var(--sel);
  }

  .chat-row-children-toggle {
    position: absolute;
    left: 8px;
    z-index: 1;
    display: grid;
    place-items: center;
    width: 16px;
    height: 24px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--t3);
    cursor: pointer;
  }

  .chat-row-children-toggle svg {
    transition: transform 120ms ease;
  }

  .chat-row-children-toggle.open svg {
    transform: rotate(90deg);
  }

  .chat-row-children-toggle:hover,
  .chat-row-children-toggle:focus-visible {
    color: var(--t1);
  }

  .chat-row-children {
    display: flex;
    flex-direction: column;
    margin: 0 0 4px 16px;
    padding: 0;
    border: 0;
  }

  .chat-row-child {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    width: 100%;
    min-height: 28px;
    padding: 4px 8px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 13px;
    line-height: 20px;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
  }

  .chat-row-child:hover,
  .chat-row-child:focus-visible {
    background: var(--hover);
    color: var(--t1);
  }

  .chat-row-child.action {
    color: var(--t2);
  }

  .chat-row-child.selected {
    background: var(--sel);
    color: var(--t1);
  }

  .chat-row-child:focus-visible {
    outline: 1px solid var(--t2);
    outline-offset: -1px;
  }

  .chat-row-child-mark {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    color: var(--t3);
  }

  .chat-row-child-mark[data-status="working"] {
    color: var(--v4-accent, #7c9cff);
  }

  .chat-row-child-mark[data-status="needsYou"] {
    color: var(--v4-warning, #e0a33b);
  }

  .chat-row-child-mark[data-status="starting"],
  .chat-row-child-mark[data-status="idle"] {
    color: var(--v4-success, #5fbf7a);
  }

  .chat-row-child-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-row-child-meta {
    color: var(--t3);
    font: inherit;
    max-width: 64px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-row-child.action {
    opacity: 1;
  }

  .chat-row-child.action:hover,
  .chat-row-child.action:focus-visible {
    opacity: 1;
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
    padding: 0;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--t2);
    font: inherit;
    /* Same step as the timeline body so the rail and the conversation share
       one reading size. 13px is the design's body step; the rail sat a step
       above it, which made the sidebar the loudest column on screen. */
    font-size: 13px;
    font-weight: 400;
    /* The shell's own line, 1.45 — at 1.2 a row measured 28px against the
       design's 31px, so the whole rail ran denser than drawn. */
    line-height: 1.45;
    text-align: left;
    cursor: pointer;
  }

  .chat-requests-row {
    color: var(--t3);
    font-size: 12px;
    font-weight: 500;
  }

  .chat-row:hover {
    color: var(--t1);
  }

  .chat-row.active {
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

  /* Production-only affordance the concept does not draw at all. Kept, but
     quiet: it appears only while the row is hovered or focused, so at rest the
     rail reads as the design's plain list of names. */
  .chat-row-scope {
    display: none;
    flex: 0 1000 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--t3);
    font-size: 12px;
    font-weight: 400;
  }

  .chat-li:hover .chat-row-scope,
  .chat-li:focus-within .chat-row-scope {
    display: inline;
  }

  .chat-row-draft {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    color: var(--t3);
    line-height: 0;
  }

  .chat-glyph-wrap {
    position: relative;
    flex: 0 0 16px;
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  /* The concept draws a 13px Hash inside a 16px box. This was a text `#` set
     at 16px, whose ink overshot the box and read heavier than the 16px avatar
     circle on the row below it. */
  .chat-glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 16px;
    width: 16px;
    height: 16px;
    color: var(--t3);
    line-height: 0;
  }

  .chat-presence-dot {
    position: absolute;
    right: -2px;
    bottom: -1px;
    width: 6px;
    height: 6px;
    border: 1.5px solid var(--v4-ground, var(--panel-bg, #151515));
    border-radius: 50%;
    background: var(--v4-ok, #42d77d);
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
    /* `line-height: 1`, as IdentityMark does. The `font:` shorthand resets
       line-height to `normal`, and `normal` is the font's own line box —
       WebKit folds the line gap into it where Chromium does not, so a
       centred all-caps monogram sat visibly high in the app and looked
       fine in the browser harness. An explicit number removes the
       variable. */
    line-height: 1;
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
    /* Counts are mono in the design, like every other number in the chrome —
       and tabular figures keep a two-digit badge from wobbling. */
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
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

  .chat-user-caret {
    display: inline-flex;
    align-items: center;
    color: var(--t3);
    line-height: 0;
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

  /* Host row decoration (`rowExtras`): a quiet badge after the title, and a
     card the host mounts beside the hovered row. */
  .chat-row-extra-badge {
    flex: none;
    margin-left: 2px;
    padding: 0;
    font-size: 10px;
    line-height: 1;
    color: var(--v4-text-3, var(--text-3));
    background: transparent;
    white-space: nowrap;
  }

  .chat-row-hover-card {
    position: fixed;
    z-index: 60;
    min-width: 220px;
    max-width: 320px;
    padding: 8px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--side-bg, var(--v4-glass-bg, #1c1f24));
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.32);
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
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
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

  /* The concept's `.p-item .pi`: a fixed 14px gutter so the labels of a menu
     line up whether or not a given item has a glyph. */
  .chat-popover-ic {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 14px;
    color: var(--t2);
  }

  .chat-scope-sep {
    height: 1px;
    margin: 5px 8px;
    background: var(--line, var(--panel-border));
  }

  .chat-scope-plus {
    display: grid;
    place-items: center;
    background: transparent;
    border: 1px dashed var(--line2, var(--panel-border));
    color: var(--t2);
  }

  .chat-scope-plus svg {
    width: 12px;
    height: 12px;
  }

  .chat-scope-new:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .chat-scope-error {
    margin: 2px 0 0;
    padding: 4px 8px;
    color: var(--danger, #e5484d);
    font-size: 11px;
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
  /* Double-class for the same reason `.chat-scope-menu` needs it: `.chat-popover`
     is authored later in this sheet. The concept's `.filter-panel` is 252px,
     the same width as the scope panel above it. */
  .chat-popover.chat-filter-menu {
    box-sizing: border-box;
    gap: 0;
    width: 252px;
    min-width: 0;
    max-width: min(252px, calc(100vw - 16px));
    /* Tall enough that a normal roster does not need scrolling at all; the
       inherited 280px cap put the People list behind a scrollbar on every
       window. */
    max-height: min(70vh, 520px);
    padding: 6px 2px 6px 6px;
    overflow: hidden;
    z-index: 80;
  }

  /* Concept `.fp-head`: the caption keeps its inset and the action sits on
     the panel's right edge, so Reset / Clear read as part of the caption
     rather than as another row in the list. */
  .chat-filter-caption-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-right: 2px;
  }

  .chat-filter-reset {
    appearance: none;
    padding: 0 6px;
    border: 0;
    background: transparent;
    color: var(--t3);
    font-family: var(--font-ui);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0;
    text-transform: none;
    cursor: pointer;
  }

  .chat-filter-reset:hover {
    color: var(--t1);
  }

  .chat-filter-scroll {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    /* 4px lane for the 4px bar, so it sits clear of the panel's rounded edge
       instead of riding the border. */
    margin-right: 4px;
    padding-right: 4px;
  }

  /* `.p-sec` */
  .chat-filter-caption {
    margin: 0;
    padding: 5px 8px 3px;
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .chat-filter-caption.pad-top {
    padding-top: 12px;
  }

  /* `.p-divider` */
  .chat-filter-divider {
    height: 1px;
    margin: 6px 8px;
    background: var(--line);
  }

  .chat-sort-toggle {
    display: flex;
    gap: 2px;
    /* Flush with the rows below: the concept insets the track 8px, but here it
       sits above full-width rows whose hover fill runs edge to edge, and the
       two disagreeing reads as a misalignment. */
    margin: 2px 0 6px;
    padding: 2px;
    border-radius: 8px;
    background: var(--raised);
  }

  /* `.fp-seg-btn` */
  .chat-sort-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    flex: 1;
    padding: 4px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: color 0.12s;
  }

  .chat-sort-pill:hover {
    color: var(--t1);
  }

  .chat-sort-pill.active {
    background: var(--sel);
    color: var(--t1);
  }

  /* `.p-item` */
  .chat-filter-row {
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
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

  .chat-filter-row:hover {
    background: var(--hover);
  }

  .chat-filter-row:hover,
  .chat-filter-row.active {
    background: var(--hover);
  }

  /* `.p-item .pi` — a fixed 14px glyph gutter so the labels line up. */
  .chat-filter-lead {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 14px;
    color: var(--t2);
    line-height: 1;
  }

  .chat-filter-text {
    flex: 1 1 auto;
    min-width: 0;
  }

  /* `.p-check` */
  /* The one row in this menu that toggles rather than selects, so it wears a
     real checkbox instead of the leading glyph + trailing tick the Show rows
     use. With a leading icon it read as a fourth view. */
  .chat-filter-box {
    display: inline-grid;
    place-items: center;
    flex-shrink: 0;
    box-sizing: border-box;
    width: 14px;
    height: 14px;
    border: 1px solid var(--line2);
    border-radius: 4px;
    background: transparent;
    color: transparent;
    line-height: 0;
    transition:
      background 0.12s,
      border-color 0.12s;
  }

  .chat-filter-box.on {
    border-color: var(--ice-ink);
    background: var(--ice-ink);
    color: var(--badge-fg, #fff);
  }

  .chat-filter-check {
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    flex-shrink: 0;
    width: 13px;
    margin-left: auto;
    color: var(--t2);
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
    box-sizing: border-box;
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

  .chat-person-row:hover {
    background: var(--hover);
  }

  .chat-person-row:hover,
  .chat-person-row.active {
    background: var(--hover);
  }

  .chat-person-avatar {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--line2);
    color: var(--t1);
    font-size: 8px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .chat-person-name {
    flex: 1 1 auto;
  }

  /* `.p-item .you` — a quiet aside on the name, not a pill of its own. */
  .chat-person-tag {
    margin-left: -4px;
    padding: 0;
    border-radius: 0;
    background: none;
    color: var(--t3);
    font-size: 10px;
    font-weight: 400;
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
    background: rgba(0, 0, 0, 0.28);
  }

  .chat-overlay.top {
    align-items: flex-start;
    padding-top: 72px;
  }

  /* Same card as every other panel in the shell — concept `.search-modal`:
     12px, the panel border and fill, the blur that fill expects. It was 14px
     on the flat window surface, so the one popover the user opens most read as
     a different component from the menus around it. */
  .chat-switcher {
    display: flex;
    flex-direction: column;
    width: min(560px, 86%);
    max-height: min(62vh, 460px);
    overflow: hidden;
    border: 1px solid var(--panel-border, var(--v4-hairline));
    border-radius: 12px;
    background: var(--panel-bg, var(--v4-surface-solid, #fff));
    box-shadow: var(--panel-shadow, var(--v4-shadow-window));
    backdrop-filter: blur(40px) saturate(1.5);
    -webkit-backdrop-filter: blur(40px) saturate(1.5);
  }

  .chat-switcher-close {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t3);
    cursor: pointer;
    transition:
      color 0.12s,
      background 0.12s;
  }

  .chat-switcher-close:hover,
  .chat-switcher-close:focus-visible {
    color: var(--t1);
    background: var(--hover);
    outline: none;
  }

  /* `.sm-head` */
  .chat-switcher-search {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 13px 16px;
    border-bottom: 1px solid var(--line, var(--v4-hairline));
    color: var(--t3);
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

  .chat-switcher-row:hover,
  .chat-switcher-row.active {
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
  /*
   * Phone width: a fixed 260px column would leave the conversation ~130px, so
   * the list overlays it instead. `DesktopApp` starts it closed here and
   * closes it again after a channel is picked; the number below is pinned to
   * SIDEBAR_OVERLAY_MAX_PX by `shell/sidebar-layout.test.ts`.
   */
  @media (max-width: 640px) {
    .chat-sidebar {
      position: absolute;
      inset: 0 auto 0 0;
      z-index: 40;
      flex-basis: min(320px, 86vw);
      width: min(320px, 86vw);
      /* Dims the conversation behind it without a second element to keep in
         sync; .desktop-body clips the spread. */
      box-shadow: 0 0 0 100vmax rgb(0 0 0 / 0.45);
      transition: transform 160ms ease;
    }

    /* Closed, but still running: unmounting the list is what stopped the
       roster loading and left the phone with no channel selected at all. */
    .chat-sidebar.offscreen {
      visibility: hidden;
      pointer-events: none;
      transform: translateX(-100%);
      box-shadow: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-sidebar {
      transition: none;
    }
  }
</style>
