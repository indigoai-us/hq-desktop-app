<script module lang="ts">
  /** See the note on its use below — deliberately outside the instance so a
   *  remount does not re-ask the server for peers it already 404'd on. */
  const dmNameLookupsTried = new Set<string>();
</script>

<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  import DayGroupHeader from "./DayGroupHeader.svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import CompanyLabel from "../company/CompanyLabel.svelte";
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
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import { formatShortcut } from "../common/keyboard-shortcuts";
  import type { Snippet } from "svelte";
  import type { RuntimeStatus } from "./create-bot/runtime-status.js";
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
  import { localBotCompanies } from "./local-bots.js";
  import type { Workspace } from "./workspaces";
  import { type DmRequest, addRequest, removeRequest } from "./dm-requests";
  import { requestChannelOpen, requestDmRequestsOpen } from "./open-target";
  import {
    messageSearchQueryProblem,
    type ChatSidebarApi,
    type ChatWakeBus,
  } from "./chat-api";
  import { CLOUD_BOT_NAME_TAKEN_REASON, type CloudBotDraft, type EntryPointResult } from "./lifecycle-entry-points.js";
  import { beginWakingSession, markWakingHelloAsking, reopenWakingSession, wakingBotGone, wakingStopFromFailure, type WakingBotSession } from "./create-bot/waking-model.js";
  import {
    upsertWakingSession,
    wakingSessionKey,
    wakingSessionStore,
    withoutWakingSession,
  } from "./create-bot/waking-sessions.js";
  import { agentChatReadiness } from "./agent-channel.js";
  import type {
    AdapterPromise,
    AgentProvisionOptionsView,
    LocalBotCreateInput,
    LocalBotRow,
    LocalBotWorkerOption,
  } from "@hq/platform";
  import type { BotDisplayNames } from "./bot-display-names.js";
  import { localBotForRow, localBotsAsContacts, type LocalBotEntryResult } from "./local-bots.js";
  import type { CreateBotExtras } from "./create-bot/CreateBotFlow.svelte";
  import { botHandle, newBotOtherWayLabel, type BotRuntime } from "./create-bot/create-bot-model.js";
  import type { RuntimeSignInApi } from "./create-bot/RuntimeSignIn.svelte";
  import { botKindFor } from "./bot-kind.js";
  import BotKindChip from "./BotKindChip.svelte";
  import {
    shouldArmDirectorySafety,
    shouldBumpDmUnread,
    type InboxDmActivity,
  } from "./live-catchup";
  import {
    adminCompanyUids,
    browseOnlyCompanyProjectChannels,
  } from "./channel-admin";
  import { isAgentUid } from "./agent-thinking";
  import { isSelf, selfIsAdmin, type SelfIdentity } from "../identity/self.js";
  import { createTenantStorage } from "../identity/tenant-storage.js";
  import {
    archiveConversations,
    archivedRowCount,
    filterByArchived,
    loadArchived,
    loadShowArchived,
    saveArchived,
    saveShowArchived,
    unarchiveConversations,
  } from "./session-archive.js";
  import {
    applyClick as applySelectionClick,
    applySelectionKey,
    clearSelection,
    EMPTY_SELECTION,
    pruneSelection,
    selectAll as selectAllRows,
    selectOnly,
    type SelectionState,
  } from "./session-selection.js";
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import {
    createChannelDirectoryReconciler,
    localDirectoryCursorStorage,
    type ChannelDirectoryRow,
  } from "./channel-directory-reconciler";
  import {
    applyDirectoryFeed,
    applyChannelNotifyLevel,
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
    companyScopedChannels,
    groupByDay,
    omitCompanyScopedChannels,
    groupByType,
    historySearchScopeLabel,
    initialsFor,
    buildScopeOptions,
    loadConversationCache,
    loadDmDots,
    loadPins,
    loadPinnedCompanies,
    loadRecentDms,
    loadSetupPinDismissed,
    loadShowFilter,
    resolveCompanySectionRows,
    type CompanySectionRow,
    migratePinnedCompanySelection,
    mergeContactActivity,
    mergeContactsWithInbox,
    applyDmHumanRecency,
    wakeMayChangeHumanRecency,
    normalizeChannel,
    normalizeConversations,
    rememberRecentDm,
    loadBotSetupChannels,
    rememberBotSetupChannel,
    withoutBotSetupChannels,
    resolveSearchHitRow,
    rowAvatar,
    saveConversationCache,
    saveDmDots,
    savePinnedCompanies,
    savePins,
    saveRecentDms,
    saveSetupPinDismissed,
    saveShowFilter,
    scopePillLabel,
    startOfLocalDay,
    searchCompanyUidFromScope,
    searchHistory,
    historyDayGroups,
    searchHitSnippet,
    takeRailConversations,
    takeAllScopeRailRows,
    withWakingBotRow,
    withCancelledBotRows,
    flattenGrouped,
    pickAutoOpenConversation,
    pickSettledBootConversation,
    pickWelcomeFirstConversation,
    railRowScopeLabel,
    togglePin,
    type CompanyScope,
    type ConversationRow,
    type DmContactInput,
    type MessageSearchHit,
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
  import LazyDoor from "../shell/LazyDoor.svelte";
  import { newChannelSheetDoor, newMessageSheetDoor } from "../shell/lazy-doors.js";
  import { CREATE_MENU_ITEMS, type CreateMenuAction } from "./create-menu.js";
  import NewBotTakeover from "./create-bot/NewBotTakeover.svelte";
  import {
    beginBotRemoval,
    loadAccountBotRemovals,
    loadAccountRemovedBots,
    rememberRemovedBot,
    CANCELLED_CREATE_LOOKUP_DELAYS_MS,
    readCancelledCreate,
    resolveCancelledCreate,
    saveOpenBotRemovals,
    startBotRemoval,
    type BotRemoval,
    type BotRemovalRun,
    type RemoveBotRequest,
  } from "./create-bot/cancel-model.js";
  import { createDraftSignature, releaseCreateKey, releaseCreateKeysFor, takeCreateKey } from "./create-bot/create-key.js";
  import {
    createdByAnotherPerson,
    createdByViewer,
    findCreatedBot,
    rosterBaseline,
  } from "./create-bot/created-bot-lookup.js";
  import { withoutHiddenRequestHits } from "./create-bot/hidden-request-hits.js";
  import type { CompanyCreateSeam } from "./create-company/create-company-flow.js";
  import { registerShortcuts } from "../common/keyboard-shortcuts";
  import { titleWhenTruncated } from "../common/truncation-title";
  import CompanyIcon from "../company/CompanyIcon.svelte";
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

  export interface ChatSidebarActions {
    openCreate: () => void;
    /** The New message sheet (⇧⌘K, owned by the shell registry). */
    openNewMessage: () => void;
    openNewChannel: () => void;
    openSearch: () => void;
    openHistory: () => void;
    /**
     * Open the create modal on the New bot flow (Team, Bots, Settings, Atlas).
     * `companyUid` is the company the user came from; the Cloud step starts on it.
     */
    openNewAgent: (companyUid?: string | null) => void;
  }

  interface Props {
    /** Platform backend seam (web: REST via the platform adapter). */
    api: ChatSidebarApi;
    /** Wake events (web: bridged from the MeshClient). */
    wakes?: ChatWakeBus | null;
    companies?: Workspace[] | null;
    /**
     * Console rail shell: companies live on the rail only, so the sidebar
     * drops its Companies block and company pin menu.
     */
    companiesOnRail?: boolean;
    /** A company's home channel was just created/adopted by `ensureCompanyHomeChannel`
     *  (roster row had no `homeChannelId` yet). Lets the host patch its own
     *  roster copy and refresh from the server, so chrome elsewhere (and a
     *  restart) stays correct without waiting on this sidebar's own local cache. */
    onhomechannelresolved?: (companyUid: string, homeChannelId: string) => void;
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
    /**
     * Bump to re-read pending connection requests only. Hosts tie this to
     * their notification wake (native poll or `notifications:*` MQTT
     * reconcile) so a request that arrives without a `dm:request-new` wake
     * — the web path has none — still surfaces without a remount.
     */
    requestsWakeSeq?: number;
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
     * Home model in the console rail hides this card. Account actions live
     * on the rail avatar (US-010). Phone layout keeps the card.
     */
    hideAccountFooter?: boolean;
    /**
     * Lifecycle entry points. The host runs the card action and navigates to
     * the posted card; the sidebar only offers the rows ("+" modal and the
     * company switcher) and shows a failure reason inline. Hosts without the
     * card seams leave these unset and the rows are hidden.
     */
    oncreatecompany?: (() => Promise<EntryPointResult>) | null;
    /** In-modal company creation (name → details + invites → create). */
    companyCreate?: CompanyCreateSeam | null;
    /**
     * The "+" modal's Cloud option: the host walks the server's create-agent
     * card and opens the new bot's channel. Works for every company.
     */
    oncreateagent?:
      | ((
          companyUid: string,
          draft: CloudBotDraft,
        ) => Promise<EntryPointResult>)
      | null;
    /**
     * The full-window New Bot flow's create. Separate from `oncreateagent` on
     * purpose: it asks the server for the chat-first setup order, which the
     * server runs only for a company in `newBotCompanyUids`.
     */
    oncreatenewbot?:
      | ((
          companyUid: string,
          draft: CloudBotDraft,
        ) => Promise<EntryPointResult>)
      | null;
    /**
     * Companies the full-window New Bot flow is offered for: those the host
     * read the `agents.desktop-agent-creation` flag as on for. Empty until
     * the host has an answer, and empty when it could not get one. While it
     * is empty "New bot" opens the "+" modal's own flow, with no takeover.
     */
    newBotCompanyUids?: readonly string[];
    /**
     * Tells the host which companies a cloud bot can be made in, so it can
     * read their flag: when the list changes, and when the "+" modal opens.
     */
    onagentcompanies?: ((companyUids: string[]) => void) | null;
    /** Polls a just-created cloud bot while its waking screen is open. */
    loadAgentStatus?: ((agentUid: string, brain?: "grok" | "codex" | "claude") => Promise<unknown>) | null;
    retryAgent?: ((agentUid: string) => Promise<unknown>) | null;
    /**
     * Ask the server to remove a cloud bot. Cancel in the new bot flow uses it
     * for a bot the create already made. Safe to call again for the same bot.
     */
    removeAgent?: RemoveBotRequest | null;
    /** A cancelled bot is gone from the server: drop what the host kept for it. */
    onbotremoved?: ((agentUid: string) => void) | null;
    /** Test seam: how long a removal waits before asking the server again. */
    botRemovalRetryMs?: number;
    /**
     * Reads the bots of one company (the member-safe roster the app already
     * reads elsewhere). Cancel uses it to learn whether a create with no
     * answer made a bot. It only reads: Cancel never sends a create.
     */
    loadCompanyBots?: ((companyUid: string) => Promise<unknown>) | null;
    /**
     * A bot found after a create with no answer was taken up as that create's
     * own. The host registers it as it does a create that answered.
     */
    onbotadopted?: ((agentUid: string, draft: CloudBotDraft) => void) | null;
    /**
     * Test seam: how long a cancelled create with no answer waits before each
     * look at the company's bots.
     */
    botCreateLookupMs?: number;
    /** Ask a new cloud bot, on the bot-only lane, to write its first message. */
    sendBotHello?: ((session: WakingBotSession) => Promise<boolean>) | null;
    /** True once that first message is in the direct message. */
    checkBotHello?: ((session: WakingBotSession) => Promise<boolean>) | null;
    restartBrainApproval?: ((agentUid: string, brain: "grok" | "codex" | "claude") => Promise<unknown>) | null;
    submitClaudeLoginCode?: ((agentUid: string, code: string) => Promise<unknown>) | null;
    openExternal?: ((url: string) => void | Promise<void>) | null;
    loadClaudeProviderFlag?: (() => AdapterPromise<boolean>) | null;
    loadCloudProvisionOptions?: ((companyUid: string) => AdapterPromise<AgentProvisionOptionsView>) | null;
    /** `agents.desktop-agent-creation` seam, passed through to the New bot flow. */
    directCloud?: import("./create-bot/direct-cloud-lazy.js").DirectCloudFlowSeam | null;
    /** Personal local bot (local-bots): desktop hosts only; see CreateModal. */
    oncreatebot?:
      | ((input: LocalBotCreateInput, extras?: CreateBotExtras) => Promise<LocalBotEntryResult>)
      | null;
    botRuntimeReady?: Record<string, boolean> | null;
    /** Per-runtime state (not-installed / couldn't-check / signed-out). */
    botRuntimeStatus?: Record<string, RuntimeStatus> | null;
    /** Re-read runtime readiness from the host. */
    onrecheckruntimes?: (() => void | Promise<void>) | null;
    /** Live AiTools payload passed into CreateModal for the install-choice panel. */
    aiTools?: import("../install-choice/install-choice.js").AiTools | null;
    /** HQ folder path — flows into the `claude://code/new?folder=` deep link. */
    hqFolderPath?: string;
    /** Open the assistant desktop app with a pre-filled install prompt. */
    onopenassistant?: (
      assistant: import("../install-choice/install-choice.js").AssistantId,
      url: string,
    ) => Promise<import("../install-choice/install-choice.js").InstallOutcome>;
    /** HQ's own one-click installer for a coding tool. */
    onassistedinstall?: (
      tool: import("../install-choice/install-choice.js").CodingTool,
    ) => Promise<import("../install-choice/install-choice.js").InstallOutcome>;
    /** Ask the host to (re-)probe `detect_ai_tools` lazily when CreateModal opens. */
    onrequestaitools?: () => void;
    botWorkers?: readonly LocalBotWorkerOption[] | null;
    /** New bot flow extras (see CreateModal): taken names, sign-in, avatars. */
    existingBotNames?: readonly string[] | null;
    botSignIn?: RuntimeSignInApi | null;
    onbotsignedin?: ((runtime: BotRuntime) => void | Promise<void>) | null;
    /**
     * The user's own local bots. GET /v1/notify/contacts never lists them, so
     * they are merged into the contacts the "+" modal searches and invites
     * from — otherwise a bot could not be added to a channel or group chat.
     */
    localBots?: readonly LocalBotRow[] | null;
    /** agentUid → display name for local bots that have one. */
    botDisplayNames?: BotDisplayNames | null;
    /**
     * The user's own local bots that this computer cannot run right now — a
     * wiped config, a reinstall, a second Mac. They are not on `localBots`,
     * and drawing them as `Cloud` is what the owner's VM showed happening to
     * four of their own bots the moment the account listing was unavailable.
     */
    ownedLocalBotUids?: readonly string[] | null;
    /** Emits the full normalized conversation list whenever it changes. */
    onrows?: (rows: ConversationRow[]) => void;
    /**
     * Emits the rail rows in DISPLAY order (pinned → day sections → "Last
     * week" once expanded) so the shell's next/previous-conversation
     * shortcuts walk exactly what the user sees.
     */
    ondisplayrows?: (rows: ConversationRow[]) => void;
    /**
     * Hands the shell imperative entry points (new chat, conversation
     * switcher, message search) for app-wide shortcuts and the native menu.
     * Called with null on teardown.
     */
    onactions?: (actions: ChatSidebarActions | null) => void;
    /**
     * Bound for first-paint directory/contacts/DM-request reads. A hung or
     * 404'd optional fetch must not keep the conversation pane on a skeleton.
     * Tests pass a short value; production uses the default.
     */
    bootTimeoutMs?: number;
    /**
     * Land on #welcome at boot even when live channels exist (setup has not
     * been run on this machine yet). See `hasRunWelcomeSetup`.
     */
    /**
     * `true`: #welcome wins the boot pick (setup not run here yet). `false`:
     * real conversations win. `"pending"`: the host has not yet said whether
     * setup is owed — hold the boot pick, briefly, rather than guess.
     */
    welcomeFirst?: boolean | "pending";
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
    /**
     * Host-owned presence for DM rows with a personal local bot (local-bots
     * US-009): "online" / "offline" from the server's heartbeat verdict, null
     * for every other row. Never derived from timestamps here.
     */
    dmPresence?: (row: ConversationRow) => "online" | "offline" | null;
    /** Host decoration per row: badge, hover card, context-menu actions.
     *  Session metadata may still be loading — never hide the rail for it. */
    rowExtrasLoading?: boolean;
    rowExtrasError?: boolean;
    rowExtras?: RowExtrasResolver | null;
    /** Optional content rendered above the account footer. */
    bottomContent?: Snippet;
    /**
     * When true (the `desktop.human-only-conversations` flag is on), rows are
     * ordered and sectioned by the last message a person typed, in three
     * states: a known `lastHumanMessageAt` places the row at that time; a
     * row the server knows holds no human message is placed at its creation
     * time (by `lastActivityAt` when it has none, as a 1:1 DM does today); a
     * row the server sent neither field for falls back to `lastActivityAt`.
     * Default off preserves legacy ordering.
     */
    humanOnly?: boolean;
  }

  let {
    api,
    wakes = null,
    companies = null,
    companiesOnRail = false,
    onhomechannelresolved,
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
    requestsWakeSeq = 0,
    onavatarmap,
    oncommand,
    onnavigateMessages,
    onopenSettings,
    onselect,
    oncompanyscopechange,
    onsignout,
    hideAccountFooter = false,
    oncreatecompany = null,
    companyCreate = null,
    oncreateagent = null,
    oncreatenewbot = null,
    newBotCompanyUids = [],
    onagentcompanies = null,
    loadAgentStatus = null,
    retryAgent = null,
    removeAgent = null,
    onbotremoved = null,
    botRemovalRetryMs = undefined,
    loadCompanyBots = null,
    onbotadopted = null,
    botCreateLookupMs = undefined,
    sendBotHello = null,
    checkBotHello = null,
    restartBrainApproval = null,
    submitClaudeLoginCode = null,
    openExternal = null,
    loadClaudeProviderFlag = null,
    loadCloudProvisionOptions = null,
    directCloud = null,
    oncreatebot = null,
    botRuntimeReady = null,
    botRuntimeStatus = null,
    onrecheckruntimes = null,
    aiTools = null,
    hqFolderPath = "",
    onopenassistant,
    onassistedinstall,
    onrequestaitools,
    botWorkers = null,
    existingBotNames = null,
    botSignIn = null,
    onbotsignedin = null,
    localBots = null,
    botDisplayNames = null,
    ownedLocalBotUids = null,
    onrows,
    ondisplayrows,
    onactions,
    bootTimeoutMs = DEFAULT_SIDEBAR_BOOT_TIMEOUT_MS,
    welcomeFirst = false,
    offscreen = false,
    onShellReady,
    projectHasPresence = () => false,
    dmPresence = () => null,
    rowExtrasLoading = false,
    rowExtrasError = false,
    rowExtras = null,
    bottomContent,
    humanOnly = false,
  }: Props = $props();
  // Host still reports load failures; the sidebar no longer paints them.
  void rowExtrasError;

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
  /**
   * Kept for the account, whatever company the sidebar is scoped to. This
   * sidebar is rebuilt on a company switch, and what a rebuilt sidebar must
   * still have (the bots that are starting) cannot live in a per-company
   * partition. Each entry names its own company.
   */
  const accountStorage = createTenantStorage(
    typeof window !== "undefined" ? window.localStorage : null,
    { accountId: tenantAccountId, companyId: "all" },
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
  /**
   * "Companies" sidebar section pins — companies the user explicitly pinned
   * via the section's header submenu. Empty/absent = no pins yet, so the
   * section falls back to the top-N most active companies (see
   * `companySectionRows` below). Persisted data may still carry the OLD
   * "which companies to show" shape from before this pin model existed
   * (`null` = show all, an array = the exact visible set) — migrated once at
   * load via `migratePinnedCompanySelection` (see that function's doc for the
   * exact migration rule).
   */
  let pinnedCompanies = $state<string[]>(
    migratePinnedCompanySelection(
      loadPinnedCompanies(storage),
      (companies ?? [])
        .map((c) => (c.cloudUid ?? "").trim())
        .filter(Boolean),
    ) ?? [],
  );
  let companiesSectionMenuOpen = $state(false);
  /** companyUid → homeChannelId the client resolved this session via
   * `ensureCompanyHomeChannel` (server didn't have it on the roster yet).
   * Merged into `companySectionRows` ahead of the roster value so a click
   * that just provisioned the channel doesn't wait for the next roster
   * refresh to stop showing disabled. */
  let resolvedHomeChannelIds = $state<Record<string, string>>({});
  /** companyUid → true while an `ensureCompanyHomeChannel` call for that
   * company is in flight (subtle loading state on the row). */
  let companyHomeEnsuring = $state<Record<string, boolean>>({});
  /** companyUid → true once `ensureCompanyHomeChannel` has exhausted its
   * retries for that company. Never carries the raw error text — Corey's
   * product rule is no raw red errors, always a heal path. The row stays
   * clickable; a click re-runs the ensure attempt from scratch. */
  let companyHomeFailed = $state<Record<string, boolean>>({});
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
  /** Archived conversation ids — hidden from the rail until "Show archived". */
  let archivedIds = $state<string[]>(loadArchived(storage));
  const archivedSet = $derived(new Set(archivedIds));
  let showArchived = $state<boolean>(loadShowArchived(storage));
  /** Multi-select: off until the user cmd/shift-clicks or picks "Select". */
  let selectionMode = $state(false);
  let selection = $state<SelectionState>(EMPTY_SELECTION);
  let focusedRowId = $state<string | null>(null);
  /**
   * Shift-hover affordance: empty checkboxes preview which rows can be picked.
   * Tracked at the document level because the modifier can be pressed before
   * the pointer reaches the rail, and cleared on blur/visibility change so a
   * modifier released outside the window cannot strand the boxes on screen.
   */
  let shiftHeld = $state(false);
  let sidebarHovered = $state(false);
  const showSelectGutter = $derived(
    selectionMode || (shiftHeld && sidebarHovered),
  );

  $effect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Shift") shiftHeld = true;
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.key === "Shift") shiftHeld = false;
    }
    function clearShift() {
      shiftHeld = false;
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearShift);
    document.addEventListener("visibilitychange", clearShift);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearShift);
      document.removeEventListener("visibilitychange", clearShift);
    };
  });
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
  let createMenuOpen = $state(false);
  let messageSheetOpen = $state(false);
  let channelSheetOpen = $state(false);
  const createButtonLabel = "New message, channel, or agent";
  let plusBtnEl = $state<HTMLButtonElement | null>(null);
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
        slug: w.slug,
        // Every-plan company icon (NOT gated on brandingEnabled).
        iconUrl: w.iconUrl ?? null,
      })),
  );

  /** The owner's cloud companies by slug — a Local company bot joins these (bot-kinds). */
  const botCompanies = $derived(localBotCompanies(companies));

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
   * Create targets. `scopeCompanies` above is the BROWSE list and keeps
   * companies the user can only look at; creating in one of those is rejected
   * by the server, so the create modal gets the narrower list.
   */
  const createScopeCompanies = $derived(
    companiesForChannelCreate(companies, accountLabel),
  );

  /**
   * Companies a Cloud bot can be added to: the workspace list, plus any company
   * the directory already shows a company channel for. A company created a
   * moment ago has its channel before the workspace list refreshes, and the
   * "New bot" step must not lag behind it.
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

  /**
   * Companies the full-window New Bot flow may create in: the ones a cloud
   * bot can be added to AND the host read the flag as on for. The server
   * runs that flow's setup order for no other company.
   */
  const newBotCompanies = $derived<ScopeCompany[]>(
    oncreatenewbot && newBotCompanyUids.length > 0
      ? agentCompanies.filter((company) =>
          newBotCompanyUids.includes(company.companyUid),
        )
      : [],
  );
  /**
   * The one company the sidebar is showing, or "" when it shows all of them
   * (or the person's own space).
   */
  const scopedCompanyUid = $derived(scope === "all" || scope === "personal" ? "" : scope.trim());
  /**
   * The companies "New bot" opens the full-window flow for, from where the
   * person stands. Scoped to one company, that company alone and only when
   * it has the flag: a person looking at a company without it gets the "+"
   * window's own flow, and is never sent to make a bot in another company.
   * With no single company in view, every company that has the flag.
   */
  const newBotTargets = $derived<ScopeCompany[]>(
    scopedCompanyUid
      ? newBotCompanies.filter((company) => company.companyUid === scopedCompanyUid)
      : newBotCompanies,
  );
  /** True when the person belongs to more than one company. The takeover then names its target. */
  const inSeveralCompanies = $derived(
    new Set([...agentCompanies, ...scopeCompanies].map((company) => company.companyUid)).size > 1,
  );
  /** A string, so the report below runs when the list changes and not on every recompute. */
  const agentCompanyKey = $derived(
    agentCompanies.map((company) => company.companyUid).join("\n"),
  );

  /**
   * Bots made in the New Bot flow that are still starting, one entry per
   * bot. The list belongs to the account, not to this sidebar: it is shared
   * with whichever sidebar replaces this one and it is written to storage,
   * so a company switch, a collapsed sidebar or a restart loses none of
   * them (waking-sessions.ts).
   */
  const wakingStore = wakingSessionStore(tenantAccountId, accountStorage);
  let wakingBots = $state<WakingBotSession[]>(wakingStore.get());
  /** The bot whose waiting screen the takeover shows. Null: the create screen. */
  let openWakingKey = $state<string | null>(null);
  let botSetupChannels = $state<string[]>(loadBotSetupChannels(storage));
  /**
   * Where cancelled bots used to be written: the company partition this
   * sidebar is scoped to. Null when that is the account's own partition.
   */
  const legacyRemovalStorage =
    (tenantCompanyId ?? "").trim() && (tenantCompanyId ?? "").trim() !== "all" ? storage : null;
  /**
   * Cancelled bots: what is being removed, what was removed, what was not.
   * Kept for the account, so the sidebar for any company scope finds a
   * removal that is under way and goes on with it.
   */
  let botRemovals = $state<BotRemoval[]>(loadAccountBotRemovals(accountStorage, legacyRemovalStorage));
  /** Bots the server confirmed removed. Their conversation stays off the list. */
  let removedBotUids = $state<string[]>(loadAccountRemovedBots(accountStorage, legacyRemovalStorage));
  const contactsWithUnreads = $derived(applyPairUnreads(contacts, pairUnreads));

  /**
   * The user's own agents: local bots this machine runs, plus their own bots
   * this machine cannot run right now. They are never the company-wide
   * broadcast clutter the agent-stub rule exists to remove, so they stay on
   * the rail whether or not they have messaged.
   */
  /**
   * The starting bots this sidebar shows: all of them, or when the sidebar
   * is scoped to one company, that company's. A bot being removed has its
   * own row and is not shown as starting.
   */
  const shownWakingBots = $derived(
    wakingBots.filter((session) => {
      const scoped = (tenantCompanyId ?? "").trim();
      if (scoped && scoped !== "all" && session.companyUid && session.companyUid !== scoped) return false;
      return !botIsCancelled(session.agentUid);
    }),
  );
  /** The session the takeover is showing, as it stands now. */
  const openWakingBot = $derived(
    openWakingKey ? wakingBots.find((session) => wakingSessionKey(session) === openWakingKey) ?? null : null,
  );
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

  /** companyUid → homeChannelId, from the roster (`Workspace.homeChannelId`) —
   * resolves `isCompanyHome` by channel id (see channels.ts
   * `isCompanyHomeChannel`). */
  const homeChannelIdByUid = $derived.by(() => {
    const map = new Map<string, string>();
    for (const company of companies ?? []) {
      const uid = (company.cloudUid ?? "").trim();
      const homeChannelId = (company.homeChannelId ?? "").trim();
      if (uid && homeChannelId) map.set(uid, homeChannelId);
    }
    return map;
  });
  const companyDisplayNamesByUid = $derived.by(() => {
    const map = new Map<string, string>();
    for (const company of companies ?? []) {
      const uid = (company.cloudUid ?? "").trim();
      const displayName = (company.displayName ?? "").trim();
      if (uid && displayName) map.set(uid, displayName);
    }
    return map;
  });

  const allRows = $derived(
    withCancelledBotRows(
      // Each bot that is starting keeps a row of its own.
      shownWakingBots.reduce<ConversationRow[]>(
        (rows, bot) => withWakingBotRow(rows, bot),
        withoutBotSetupChannels(normalizeConversations(channelsWithSetup, contactsWithUnreads, {
          pinnedIds: pinsWithSetup,
          dmDots,
          recentDms,
          homeChannelIdByUid,
          companyDisplayNamesByUid,
        }), botSetupChannels),
      ),
      // A cancel whose create has no known outcome names no bot and has no row.
      // Nor has a cancelled bot of a company this sidebar is not showing.
      botRemovals.filter((removal): removal is BotRemoval & { phase: Exclude<BotRemoval["phase"], "unconfirmed"> } => removal.phase !== "unconfirmed" && wakingBotInScope(removal)),
      removedBotUids,
    ),
  );

  /**
   * The sidebar's "Companies" section. When the user has pinned any
   * companies (via the header submenu), only the pinned ones show, in
   * `companies` order. Otherwise the section shows the
   * `DEFAULT_COMPANY_SECTION_LIMIT` most active companies (see
   * `companyActivityScore` / `rankCompaniesByActivity` in sidebar-model.ts).
   * A company with no `homeChannelId` yet is included with `homeChannelId:
   * null` so the row can render disabled ("No company channel yet") instead
   * of silently vanishing.
   *
   * Home channels shown here are NOT removed from the regular channel list:
   * this section is additive, the same way the existing pin star only
   * removes a row from the day sections when the user explicitly stars it
   * (`ConversationRow.pinned`) — pinning a company here does not set that
   * flag, so no new dedup logic was needed.
   */
  const companySectionRows = $derived<CompanySectionRow[]>(
    resolveCompanySectionRows(
      (companies ?? [])
        .filter((c) => c.kind === "company" && (c.cloudUid ?? "").trim())
        .map((c) => ({
          companyUid: (c.cloudUid as string).trim(),
          label: c.displayName || c.slug || c.cloudUid!,
          slug: c.slug ?? null,
          iconUrl: companyIcons.get((c.cloudUid as string).trim()) ?? null,
          homeChannelId:
            c.homeChannelId ?? resolvedHomeChannelIds[(c.cloudUid as string).trim()] ?? null,
        })),
      allRows,
      pinnedCompanies,
    ),
  );

  /**
   * DEBUG instrumentation (2026-09-25): proves, from `~/.hq/logs/hq-sync.log`,
   * that the Companies section actually renders and that `homeChannelId`
   * made it through the roster mapping — without requiring a click. Fires
   * once per non-empty render of the section, not on every recompute.
   */
  let companySectionReadyLogged = false;
  $effect(() => {
    const rows = companySectionRows;
    if (rows.length === 0 || companySectionReadyLogged) return;
    companySectionReadyLogged = true;
    const withHome = rows.filter((r) => Boolean(r.homeChannelId)).length;
    companiesLog(`section ready count=${rows.length} withHome=${withHome}`);
  });

  function toggleCompanyPin(companyUid: string): void {
    pinnedCompanies = pinnedCompanies.includes(companyUid)
      ? pinnedCompanies.filter((uid) => uid !== companyUid)
      : [...pinnedCompanies, companyUid];
    savePinnedCompanies(pinnedCompanies, storage);
  }

  /**
   * Writes one `[companies] …` line to the desktop support log
   * (`~/.hq/logs/hq-sync.log`) via `api.logToFile` — the TS→Rust bridge onto
   * `frontend_log` — so a company-home open (or disabled click) is greppable
   * even with devtools closed. `logToFile` is a required seam now; a failed
   * write (permission, IPC, disk) is logged to the console instead of being
   * silently swallowed, so a broken bridge is itself diagnosable.
   */
  function companiesLog(line: string): void {
    console.warn(`[companies] ${line}`);
    void api.logToFile("companies", line).catch((err) => {
      console.error("[companies] logToFile failed", err);
    });
  }

  /**
   * Companies section row click: the company's home channel id comes
   * straight from the roster (`Workspace.homeChannelId`), so there's no
   * client-side heuristic resolution needed to know WHICH channel to open.
   * If it's already among this sidebar's loaded rows, open it the normal way
   * (`openRow` — mark-read, draft clearing, etc.). Otherwise (e.g. the "All"
   * scope hasn't loaded that company's channels yet) fall back to
   * `requestChannelOpen`, the same generic "open a channel by id" path
   * notifications and deep links use — the shell's navigation loads it by id
   * the same way it would for any of those.
   */
  function openHomeChannelId(
    homeChannelId: string,
    company?: { slug?: string | null; label?: string | null; companyUid?: string | null },
  ): void {
    const loaded = allRows.find((r) => r.channelId === homeChannelId);
    if (loaded) {
      void openRow(loaded);
    } else {
      // Not in the loaded rows yet: the stub row would otherwise paint the
      // raw `chn_…` id as the title/composer placeholder until the full
      // directory catches up. Seed it with the company's display label,
      // matching the home-channel row once loaded, so the header never
      // shows a raw id.
      requestChannelOpen(homeChannelId, {
        title: company?.label || company?.slug || null,
        companyUid: company?.companyUid ?? null,
      });
    }
  }

  /** Up to 3 tries total (the initial attempt plus 2 retries) before the row
   * falls back to the quiet "tap to retry" heal state. */
  const ENSURE_HOME_CHANNEL_MAX_ATTEMPTS = 3;
  /** Backoff between attempts, indexed by the attempt that just failed
   * (attempt 1 failing waits `[0]` before attempt 2, etc). An AUTH_REQUIRED
   * failure reuses the same schedule — the wait gives the background token
   * refresh a chance to land before the retry. */
  const ENSURE_HOME_CHANNEL_RETRY_DELAYS_MS = [400, 1200];

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Companies section row click. The company's home channel id normally
   * comes straight from the roster (`Workspace.homeChannelId`) — no
   * client-side resolution needed to know which channel to open. When it's
   * missing (a new/legacy company still provisioning server-side), the click
   * calls the idempotent `ensureCompanyHomeChannel` endpoint, which creates
   * the channel on the company's first call or adopts the existing one on
   * any later call, then opens it.
   *
   * Corey's product rule: never show a raw red error, always have a heal
   * path. So a failure here is never surfaced verbatim — it retries
   * automatically (with backoff, up to `ENSURE_HOME_CHANNEL_MAX_ATTEMPTS`
   * tries), and if it still fails the row falls back to a quiet "tap to
   * retry" state that re-runs this same function on the next click. The raw
   * reason only ever reaches the support log via `companiesLog`.
   */
  async function openCompanyHome(company: {
    companyUid: string;
    label: string;
    slug?: string | null;
    homeChannelId: string | null;
  }): Promise<void> {
    const label = company.slug || company.label;
    const known = company.homeChannelId ?? resolvedHomeChannelIds[company.companyUid] ?? null;
    if (known) {
      companiesLog(`open company=${label} channel=${known}`);
      openHomeChannelId(known, company);
      return;
    }
    if (companyHomeEnsuring[company.companyUid]) return;
    companyHomeEnsuring = { ...companyHomeEnsuring, [company.companyUid]: true };
    const { [company.companyUid]: _drop, ...clearedFailed } = companyHomeFailed;
    companyHomeFailed = clearedFailed;

    for (let attempt = 1; attempt <= ENSURE_HOME_CHANNEL_MAX_ATTEMPTS; attempt += 1) {
      try {
        const { homeChannelId } = await api.ensureCompanyHomeChannel(company.companyUid);
        resolvedHomeChannelIds = { ...resolvedHomeChannelIds, [company.companyUid]: homeChannelId };
        onhomechannelresolved?.(company.companyUid, homeChannelId);
        companiesLog(`open company=${label} channel=${homeChannelId}`);
        openHomeChannelId(homeChannelId, company);
        const { [company.companyUid]: _clear, ...rest } = companyHomeEnsuring;
        companyHomeEnsuring = rest;
        return;
      } catch (err) {
        // raw-error-ok: log only
        const reason = err instanceof Error ? err.message : String(err);
        companiesLog(
          `open-failed company=${label} attempt=${attempt}/${ENSURE_HOME_CHANNEL_MAX_ATTEMPTS} reason=${reason}`,
        );
        if (attempt < ENSURE_HOME_CHANNEL_MAX_ATTEMPTS) {
          await delay(ENSURE_HOME_CHANNEL_RETRY_DELAYS_MS[attempt - 1] ?? 1200);
        }
      }
    }
    companyHomeFailed = { ...companyHomeFailed, [company.companyUid]: true };
    const { [company.companyUid]: _clear, ...rest } = companyHomeEnsuring;
    companyHomeEnsuring = rest;
  }

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
  // The user's own local bots ride along so they can be found and invited.
  const directoryRows = $derived(
    normalizeConversations(channelsWithSetup, localBotsAsContacts(contactsWithUnreads, localBots, botDisplayNames), {
      pinnedIds: pinsWithSetup,
      dmDots,
      includeContactsWithoutConversation: true,
      homeChannelIdByUid,
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
        ...normalizeChannel(c, { pinnedIds: pins, homeChannelIdByUid }),
        browseOnly: true,
      }),
    ),
  );

  const pendingRequestCount = $derived(pendingRequests.length);

  const filteredRows = $derived(
    applySidebarFilters(
      filterByArchived(
        showFilter === "company-projects" ? [...allRows, ...browseRows] : allRows,
        archivedSet,
        showArchived,
      ),
      {
        scope,
        show: showFilter,
        sort: sortMode,
        personUid: personFilter,
        humanOnly,
      },
    ),
  );

  const companyScoped = $derived(scope !== "all" && scope !== "personal");
  // Home keeps DMs, bots, and project channels. Company channels render
  // under Activity only while that company is the pane (US-008).
  const activityChannelRows = $derived(
    companyScoped ? companyScopedChannels(filteredRows, scope) : [],
  );
  // All scope: company channels sort into the date buckets with DMs, by
  // their most recent message. Home and Personal still omit them.
  const inboxRows = $derived(
    scope === "all" ? filteredRows : omitCompanyScopedChannels(filteredRows),
  );
  const railRows = $derived(
    sortMode === "type" || companyScoped
      ? inboxRows
      : scope === "all"
        ? takeAllScopeRailRows(inboxRows, {
            selectedId: activeId,
            recentPersonUids: recentDms,
          })
        : takeRailConversations(inboxRows, {
            selectedId: activeId,
            recentPersonUids: recentDms,
          }),
  );

  /** US-016: open the newest rail row when the shell has no selection. */
  let autoOpenRequestedId = $state<string | null>(null);
  const hasNonSetupRows = $derived(
    allRows.some((row) => !isSetupChannel(row.channelId)),
  );
  /**
   * The roster already names a company (created on the website or another
   * machine). Its channel rows usually hydrate a beat after the roster, so
   * the settled-boot fallback must not race them into #setup: give the rows
   * one more bounded wait, and open the company's channel the moment it
   * lands. Only after that wait does #setup win — and by then the shell
   * renders it around the existing company, never "Create a company".
   */
  const hasRosterCompany = $derived(
    (companies ?? []).some((company) => company.kind === "company"),
  );
  let companyRowsGraceElapsed = $state(false);
  $effect(() => {
    if (
      selectedId ||
      !bootAttempted ||
      loading ||
      !hasRosterCompany ||
      hasNonSetupRows ||
      companyRowsGraceElapsed
    ) {
      return;
    }
    const timer = setTimeout(() => {
      companyRowsGraceElapsed = true;
      sidebarLog("auto-open-company-grace-elapsed", { waitedMs: bootTimeoutMs });
    }, bootTimeoutMs);
    return () => clearTimeout(timer);
  });
  $effect(() => {
    if (selectedId) {
      autoOpenRequestedId = null;
      return;
    }
    if (autoOpenRequestedId) return;
    // The host has not said yet whether setup is owed here: opening either
    // #welcome or a company channel now would be a guess the person sees.
    if (welcomeFirst === "pending") return;
    // Until setup has been run on this machine, #welcome wins the boot pick:
    // the person needs Run Setup before a company channel is useful.
    if (welcomeFirst) {
      const welcome = pickWelcomeFirstConversation(filteredRows, selectedId);
      if (welcome) {
        autoOpenRequestedId = welcome.id;
        sidebarLog("auto-open-welcome-first", { id: welcome.id });
        void openRow(welcome, undefined, true);
        return;
      }
    }
    // Real conversations auto-open immediately. #setup exists from first
    // paint, so it must not win the empty-selection race against deep links
    // and rows that hydrate a beat later — but once the first fetch has
    // settled (or timed out) with nothing else, open #setup so the pane is
    // never an infinite skeleton.
    // A selected company paints its channels under Activity, not in the
    // Home day groups. Prefer one of those over a personal DM (US-008).
    const livePool =
      companyScoped && activityChannelRows.length > 0
        ? activityChannelRows
        : // All lists company channels too, but boot never opens one on
          // its own (it did not before they joined the date buckets).
          omitCompanyScopedChannels(inboxRows);
    const live = pickAutoOpenConversation(
      livePool.filter((row) => !isSetupChannel(row.channelId)),
      selectedId,
      humanOnly,
    );
    if (live) {
      autoOpenRequestedId = live.id;
      void openRow(live, undefined, true);
      return;
    }
    if (!bootAttempted || loading) return;
    if (hasRosterCompany && !hasNonSetupRows && !companyRowsGraceElapsed) return;
    const fallback = pickSettledBootConversation(
      companyScoped ? filteredRows : omitCompanyScopedChannels(inboxRows),
      selectedId,
      humanOnly,
    );
    if (!fallback) return;
    autoOpenRequestedId = fallback.id;
    sidebarLog("auto-open-fallback", {
      id: fallback.id,
      reason: "no-other-conversations",
    });
    void openRow(fallback, undefined, true);
  });
  const grouped = $derived(
    sortMode === "type"
      ? groupByType(railRows)
      : groupByDay(railRows, Date.now(), {
          humanOnly,
          emptyChannelsLast: scope === "all",
        }),
  );
  /** Rows in painted order — the selection model's range/keyboard order. */
  const renderedRows = $derived([
    ...activityChannelRows,
    ...flattenGrouped(grouped, lastWeekExpanded),
  ]);
  const orderedRowIds = $derived(renderedRows.map((row) => row.id));
  $effect(() => {
    const emit = ondisplayrows;
    if (!emit) return;
    emit(renderedRows);
  });
  // A filter change, an archive, or a company switch can drop selected rows.
  $effect(() => {
    const ids = orderedRowIds;
    const next = pruneSelection(untrack(() => selection), ids);
    if (next !== untrack(() => selection)) selection = next;
  });
  const selectionCount = $derived(selection.selected.length);
  const selectionAllArchived = $derived(
    selectionCount > 0 &&
      selection.selected.every((id) => archivedSet.has(id)),
  );
  const archivedVisibleCount = $derived(archivedRowCount(allRows, archivedSet));

  function setShowArchived(next: boolean): void {
    showArchived = next;
    saveShowArchived(next, storage);
  }

  function persistArchived(next: string[]): void {
    archivedIds = next;
    saveArchived(next, storage);
  }

  /**
   * Archive is reversible and never deletes: it only adds the row id to the
   * archived list, so unread counts and history come back untouched.
   */
  function archiveRows(ids: readonly string[]): void {
    if (ids.length === 0) return;
    persistArchived(archiveConversations(archivedIds, ids));
  }

  function unarchiveRows(ids: readonly string[]): void {
    if (ids.length === 0) return;
    persistArchived(unarchiveConversations(archivedIds, ids));
  }

  function toggleRowArchive(rowId: string): void {
    if (archivedSet.has(rowId)) unarchiveRows([rowId]);
    else archiveRows([rowId]);
  }

  function enterSelectionMode(rowId?: string): void {
    selectionMode = true;
    if (rowId) {
      selection = selectOnly(rowId);
      focusedRowId = rowId;
    }
  }

  function exitSelectionMode(): void {
    selectionMode = false;
    selection = clearSelection();
    focusedRowId = null;
  }

  function archiveSelection(): void {
    const ids = selection.selected;
    if (selectionAllArchived) unarchiveRows(ids);
    else archiveRows(ids);
    exitSelectionMode();
  }

  function selectAllVisible(): void {
    selection = selectAllRows(orderedRowIds);
    focusedRowId = orderedRowIds.at(-1) ?? null;
  }

  /**
   * Row click. cmd/ctrl or shift enters selection mode and never opens the
   * conversation; a plain click in selection mode moves the selection, and
   * outside it opens the row as before.
   */
  function handleRowClick(row: ConversationRow, event: MouseEvent): void {
    const multi = event.metaKey || event.ctrlKey || event.shiftKey;
    if (!selectionMode && !multi) {
      if (row.wakingBot || row.removingBot) {
        // A bot that is starting, or a cancelled bot that still exists: its
        // state lives in the new bot screen, and it has no conversation yet.
        // A starting bot opens on its own waiting screen; a cancelled one
        // opens on the create screen, where its removal is reported.
        openWakingKey = row.wakingBot
          ? row.wakingBot.agentUid || (row.channelId ? `ch:${row.channelId}` : null)
          : null;
        // A screen that stopped because the app was signed out says to open
        // the bot from the list. Doing so starts the wait again.
        const held = openWakingKey
          ? wakingBots.find((session) => wakingSessionKey(session) === openWakingKey)
          : null;
        if (row.wakingBot && !wakingScreenFor(held)) {
          // The waiting screen belongs to the full-window flow. With the
          // company's flag off, or no session to show, the takeover would
          // open on nothing: the bot's own conversation opens instead.
          openWakingKey = null;
          const { wakingBot: _waking, ...plain } = row;
          void openRow(plain);
          return;
        }
        if (held) {
          const reopened = reopenWakingSession(held);
          if (reopened !== held) changeWakingBots((sessions) => upsertWakingSession(sessions, reopened));
        }
        // The same list for as long as it is open, as "New bot" keeps it.
        newBotCompaniesAtOpen = newBotTargets;
        // A starting bot's row goes straight to that bot: no Cloud or Local question.
        newBotChoose = false;
        newBotName = "";
        newBotOpen = true;
        return;
      }
      void openRow(row);
      return;
    }
    event.preventDefault();
    if (!selectionMode) selectionMode = true;
    selection = applySelectionClick(selection, orderedRowIds, row.id, {
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
    });
    focusedRowId = row.id;
  }

  /**
   * Checkbox toggle. Always additive/subtractive (never a replace), so ticking
   * a box can build a selection one row at a time without a modifier key.
   */
  function toggleRowSelection(row: ConversationRow, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (!selectionMode) selectionMode = true;
    selection = applySelectionClick(selection, orderedRowIds, row.id, {
      shiftKey: false,
      metaKey: true,
      ctrlKey: false,
    });
    focusedRowId = row.id;
    if (selection.selected.length === 0) exitSelectionMode();
  }

  function selectionKeydown(event: KeyboardEvent): void {
    if (!selectionMode || event.isComposing) return;
    const result = applySelectionKey(
      selection,
      orderedRowIds,
      {
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
      },
      focusedRowId,
    );
    if (!result.handled) return;
    event.preventDefault();
    selection = result.state;
    focusedRowId = result.focusId;
    if (result.state.selected.length === 0 && event.key === "Escape") {
      exitSelectionMode();
      return;
    }
    if (result.focusId) {
      document
        .querySelector<HTMLElement>(
          `[data-conversation-id="${CSS.escape(result.focusId)}"]`,
        )
        ?.focus();
    }
  }
  $effect(() => {
    const emit = onactions;
    if (!emit) return;
    emit({
      openCreate,
      openNewMessage: () => openCreateAction("message"),
      openNewChannel,
      openSearch,
      openHistory,
      openNewAgent,
    });
    return () => emit(null);
  });
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
    searchHistory(filteredRows, historyQueryDebounced, humanOnly),
  );
  const historyGroups = $derived(
    historyDayGroups(historyRows, new Date(), humanOnly),
  );
  const historyScopeLabel = $derived(
    historySearchScopeLabel(scope, scopeCompanies),
  );
  const historyCompanyUid = $derived(searchCompanyUidFromScope(scope));
  const historyHasQuery = $derived(historyQuery.trim().length > 0);
  const historyQueryProblem = $derived(messageSearchQueryProblem(historyQuery));
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

  function archiveFromMenu(): void {
    if (!contextMenu) return;
    toggleRowArchive(contextMenu.row.id);
    contextMenu = null;
  }

  function selectFromMenu(): void {
    if (!contextMenu) return;
    enterSelectionMode(contextMenu.row.id);
    contextMenu = null;
  }

  /** Mutually exclusive overlays: opening one closes the others (D-03). */
  function closeAllOverlays(): void {
    filterOpen = false;
    scopeMenuOpen = false;
    footerMenuOpen = false;
    createOpen = false;
    createMenuOpen = false;
    messageSheetOpen = false;
    channelSheetOpen = false;
    newBotOpen = false;
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

  /** The company a host entry (Team page Add agent) opened New bot from. */
  let createBotCompanyUid = $state<string | null>(null);
  const createBotCompanySlug = $derived(
    createBotCompanyUid
      ? ((companies ?? []).find((w) => w.cloudUid === createBotCompanyUid)?.slug ?? null)
      : null,
  );
  function openCreate(): void {
    closeAllOverlays();
    createBotCompanyUid = null;
    createSunrise = false;
    createBotHome = null;
    createOpen = true;
  }
  /** The "+" button opens the create menu. New company is not on this menu. */
  function openNewChannel(): void {
    closeAllOverlays();
    channelSheetOpen = true;
  }

  function openCreateFromButton(): void {
    const next = !createMenuOpen;
    closeAllOverlays();
    createMenuOpen = next;
  }

  function openCreateAction(action: CreateMenuAction): void {
    createMenuOpen = false;
    if (action === "message") {
      messageSheetOpen = true;
      return;
    }
    if (action === "channel") {
      channelSheetOpen = true;
      return;
    }
    // "New bot": the full-window takeover, which asks "Cloud or Local?"
    // first. Only when no bot can be made at all does the create window's
    // own bot step open (it says why).
    newBotPreferredCompanyUid = null;
    if (newBotChoicePossible) {
      openNewBotTakeover({ choose: true });
      return;
    }
    createKind = "channel";
    createStep = "bot";
    openCreate();
  }

  /** What the create modal makes inside a company when opened by the host. */
  let createKind = $state<"channel" | "project">("channel");
  /** Which step the create modal opens on — "company" for New company. */
  let createStep = $state<"find" | "company" | "bot">("find");
  /**
   * The full-window New Bot takeover. "New bot" opens it only when the host
   * read the flag as on for at least one company (`newBotCompanies`), and it
   * lists only those. Otherwise "New bot" opens the "+" modal's own flow.
   */
  let newBotOpen = $state(false);
  /**
   * The companies the takeover was opened with. The host reads each flag
   * again every five minutes, and a read that fails counts as off; a person
   * part-way through the takeover keeps the list they started with instead
   * of having the screen taken away under them.
   */
  let newBotCompaniesAtOpen = $state<ScopeCompany[] | null>(null);
  /** The takeover opens on the "Cloud or Local?" question (every New bot entry; not a starting bot's row). */
  let newBotChoose = $state(false);
  /** Open the takeover on its cloud create screen, the choice behind Back. */
  let newBotOpenCloud = $state(false);
  /** The company a New bot entry was opened for (Team page Add agent). */
  let newBotPreferredCompanyUid = $state<string | null>(null);
  /** The "+" window's bot step wears the takeover shell: it was opened from the choice. */
  let createSunrise = $state(false);
  /** The home picked on the choice, preselected in the bot flow. */
  let createBotHome = $state<"local" | "cloud" | null>(null);
  /**
   * The name given on the takeover's first step. It goes with the person to
   * the local steps and back, and to the cloud screen from "Create a cloud
   * bot instead". A new "New bot" starts without one.
   */
  let newBotName = $state("");
  /** A Local bot can be made on this computer. */
  const canMakeLocalBot = $derived(!!oncreatebot);
  /** A cloud bot can be made through the "+" window's flow (companies without the takeover too). */
  const canMakeCloudBotInWindow = $derived(
    !!oncreateagent && agentCompanies.some((company) => company.companyUid.trim()),
  );
  /** "New bot" has something to offer: the choice screen opens. */
  const newBotChoicePossible = $derived(
    canMakeLocalBot || newBotTargets.length > 0 || canMakeCloudBotInWindow,
  );
  const takeoverCompanies = $derived(
    newBotOpen && newBotCompaniesAtOpen?.length
      ? newBotCompaniesAtOpen
      : newBotTargets,
  );
  /**
   * What the takeover's second button says. It opens the "+" window's bot
   * step: local bots, and cloud bots in the companies the takeover does not
   * list.
   */
  /** The takeover lists a company it can make a cloud bot in itself. */
  const takeoverHasCloud = $derived(
    !!oncreatenewbot && !!loadCloudProvisionOptions && takeoverCompanies.length > 0,
  );
  /** Why Cloud is off on the choice screen. Null when it can be picked. */
  const newBotCloudReason = $derived(
    takeoverHasCloud || canMakeCloudBotInWindow
      ? null
      : agentCompanies.length === 0 && scopeCompanies.length === 0
        ? "Cloud bots run in a company. Join or create one first."
        : "Cloud bots aren't available in your companies yet.",
  );
  /** Why Local is off on the choice screen. Null when it can be picked. */
  const newBotLocalReason = $derived(
    canMakeLocalBot ? null : "Local bots can't be made from this app.",
  );
  const takeoverOtherWayLabel = $derived(
    newBotOtherWayLabel({
      local: !!oncreatebot,
      otherCompanies:
        !!oncreateagent &&
        agentCompanies.some(
          (company) => !takeoverCompanies.some((offered) => offered.companyUid === company.companyUid),
        ),
    }),
  );
  $effect(() => {
    if (newBotOpen) return;
    newBotCompaniesAtOpen = null;
    openWakingKey = null;
  });

  /**
   * "New bot" always opens the create screen. Bots that are starting are
   * reached from their own rows; none of them stands in the way of making
   * another one.
   */
  function openNewBotTakeover(options: { choose?: boolean } = {}): void {
    newBotOpenCloud = false;
    newBotName = "";
    newBotFromCreateWindow = createOpen;
    createOpen = false;
    newBotChoose = options.choose ?? true;
    newBotCompaniesAtOpen = newBotTargets;
    openWakingKey = null;
    newBotOpen = true;
  }

  // The host reads the flag per company. Tell it the list when it changes,
  // and again when the "+" menu or the create window opens so an answer older
  // than the host's five minutes is read again before the person reaches
  // "New bot".
  $effect(() => {
    const key = agentCompanyKey;
    void createOpen;
    void createMenuOpen;
    untrack(() => onagentcompanies?.(key ? key.split("\n") : []));
  });

  /** Change the account's list of starting bots. Every sidebar for the account hears of it. */
  function changeWakingBots(change: (sessions: WakingBotSession[]) => WakingBotSession[]): void {
    wakingBots = wakingStore.update(change);
  }

  // A sidebar that was replaced can still finish a create, and it writes the
  // new bot to the shared list. This one hears of it here.
  onMount(() =>
    wakingStore.subscribe(() => {
      wakingBots = wakingStore.get();
    }),
  );

  function beginWakingBot(session: WakingBotSession): void {
    if (botIsCancelled(session.agentUid)) return;
    changeWakingBots((sessions) => upsertWakingSession(sessions, session));
    if (session.agentUid && session.channelId) {
      botSetupChannels = rememberBotSetupChannel(botSetupChannels, session.channelId, storage);
    }
  }

  /**
   * A bot was removed. A key kept for a create of the same bot (same
   * company, same handle) would be answered with the bot that is gone, so
   * it is let go. The takeover makes the handle from the name.
   */
  function forgetKeysOfRemovedBot(companyUid: string, name: string): void {
    for (const key of releaseCreateKeysFor(accountStorage, companyUid, botHandle({ name, handle: "" }))) {
      createBaselines.delete(key);
    }
  }

  function updateWakingBot(session: WakingBotSession): void {
    if (botIsCancelled(session.agentUid)) return;
    // A bot that is live, removed or out of reach is no longer waited for.
    if (session.phase === "ready" || wakingBotGone(session)) {
      if (session.phase === "stopped" && (session.stopped === "removed" || session.stopped === "removing")) {
        forgetKeysOfRemovedBot(session.companyUid, session.name);
      }
      endWakingBot(session);
      return;
    }
    changeWakingBots((sessions) => upsertWakingSession(sessions, session));
  }

  /** The wait for this bot is over: it has no entry and no "starting" row any more. */
  function endWakingBot(session: Pick<WakingBotSession, "agentUid" | "channelId">): void {
    const key = wakingSessionKey(session);
    if (!key) return;
    changeWakingBots((sessions) => withoutWakingSession(sessions, key));
  }

  /**
   * True when a starting bot's row should open its waiting screen: there is
   * a session to show, and its company still has the full-window flow.
   */
  function wakingScreenFor(session: WakingBotSession | null | undefined): boolean {
    if (!session) return false;
    return newBotCompanies.some((company) => company.companyUid === session.companyUid);
  }

  /** True when this sidebar shows the session's company: all companies, or that one. */
  function wakingBotInScope(session: Pick<WakingBotSession, "companyUid">): boolean {
    const scoped = (tenantCompanyId ?? "").trim();
    return !scoped || scoped === "all" || !session.companyUid || session.companyUid === scoped;
  }

  /**
   * Ask a restored bot that can chat for its first message. The request is
   * marked on the session before it leaves, with its key, so whatever asks
   * next (this sidebar again, or the bot's waiting screen) sends the same
   * request. Once it is sent the bot is no longer starting: it has its
   * conversation, where its first message arrives.
   */
  async function askRestoredBot(agentUid: string): Promise<void> {
    const send = sendBotHello;
    const held = wakingStore.get().find((candidate) => candidate.agentUid === agentUid);
    if (!send || !held || held.phase !== "waking" || held.helloAskedAt != null) return;
    const asking = markWakingHelloAsking(held);
    changeWakingBots((sessions) => upsertWakingSession(sessions, asking));
    let sent = false;
    try {
      sent = await send(asking);
    } catch {
      sent = false;
    }
    // Not sent: the bot keeps its row, and opening it asks again under the same key.
    if (sent) endWakingBot(asking);
  }

  /**
   * A restart can outlast a bot. Ask the server once about each bot read
   * back from storage: one that is gone, or that can chat and was already
   * asked for its first message, is no longer shown as starting.
   */
  onMount(() => {
    const readStatus = loadAgentStatus;
    if (!readStatus) return;
    for (const agentUid of wakingStore.takeRestored()) {
      const session = wakingStore.get().find((candidate) => candidate.agentUid === agentUid);
      if (!session) continue;
      void readStatus(agentUid, session.brain ?? undefined)
        .then((result) => {
          const answer = result as { ok?: unknown; value?: unknown } | null;
          if (answer?.ok === true) {
            const phase = String(
              (answer.value as { setupState?: { phase?: unknown } } | null)?.setupState?.phase ?? "",
            ).toLowerCase();
            const gone = phase === "deprovisioning" || phase === "deprovisioned";
            const chatReady = agentChatReadiness(answer.value).chatReady;
            const live = chatReady && session.helloAskedAt != null;
            if (gone) forgetKeysOfRemovedBot(session.companyUid, session.name);
            if (gone || live) endWakingBot(session);
            else if (chatReady) {
              // It can chat and was never asked for its first message. Ask
              // now, without waiting for a click on its row, when this
              // sidebar is showing its company. Otherwise the sidebar that
              // does show it will.
              if (wakingBotInScope(session)) void askRestoredBot(agentUid);
              else wakingStore.deferRestored(agentUid);
            }
            return;
          }
          const stop = wakingStopFromFailure(result);
          if (stop === "removed") forgetKeysOfRemovedBot(session.companyUid, session.name);
          if (stop === "removed" || stop === "no-access") endWakingBot(session);
        })
        .catch(() => {
          // Not known: the bot keeps its row, and its screen asks again.
        });
    }
  });

  // ── Cancel in the new bot flow ───────────────────────────────────────────
  // Cancel stops the create and removes what it made. The sidebar holds the
  // state, so a removal keeps going when the takeover closes and an answer
  // that arrives after Cancel still finds its bot.

  /** The create request that is out now. Cancel marks it; its answer is then handled here. */
  let createInFlight: {
    cancelled: boolean;
    name: string;
    companyUid: string;
    brain: string | null;
    removalId: string | null;
    /** The handle the create was sent with. Cancel looks for it among the company's bots. */
    handle: string;
    /** The key the create went out under. */
    key: string;
    /** True when that key was kept from an earlier press with no answer. */
    reused: boolean;
    /**
     * The bots the company had when Create bot was pressed, by id. Null when
     * that could not be read. A bot is only taken as this create's own when
     * it is not on this list.
     */
    baseline: Promise<ReadonlySet<string> | null>;
    /** The create's answer, when it says what was made. Null when it does not. */
    answer: EntryPointResult | null;
    /** The request has ended, and what follows it here (a look for the bot, a status read) is under way. */
    ended: boolean;
    /** Resolves when this attempt has returned its answer to the screen. */
    finished: Promise<void>;
  } | null = null;

  /**
   * Bots a create that was not cancelled took up: named by its answer, or
   * found by its handle. The settle of an earlier, cancelled create of the
   * same draft must not remove one of these.
   */
  const takenUpBots = new Set<string>();

  /**
   * The company's bots as they were at the first press for each key. Kept
   * for as long as the key is, so a second press of the same draft compares
   * against what was there before the first.
   */
  const createBaselines = new Map<string, Promise<ReadonlySet<string> | null>>();

  /** Read the company's bots before the create is sent. Never throws. */
  function baselineFor(key: string, reused: boolean, companyUid: string): Promise<ReadonlySet<string> | null> {
    const held = createBaselines.get(key);
    if (held) return held;
    // A key from before a restart has no list from before its first press.
    const read = loadCompanyBots;
    let baseline: Promise<ReadonlySet<string> | null> = Promise.resolve(null);
    if (!reused && read) {
      try {
        // Called here, in the press, so the read leaves before the create does.
        baseline = Promise.resolve(read(companyUid)).then(rosterBaseline).catch(() => null);
      } catch {
        baseline = Promise.resolve(null);
      }
    }
    createBaselines.set(key, baseline);
    return baseline;
  }

  /** The server answered this create: its key and its list are let go. */
  function forgetCreateKey(key: string): void {
    releaseCreateKey(accountStorage, key);
    createBaselines.delete(key);
  }

  /**
   * The attempt whose bot is being looked for on the takeover's screen. The
   * create screen says "Checking whether {name} was created..." meanwhile.
   */
  let checkingCreate = $state.raw<object | null>(null);

  /** Shown when the create got no answer. Sending it again picks up the first answer. */
  function createUnknownReason(name: string): string {
    return `We didn't hear back, so we can't tell if ${name.trim() || "this bot"} was created. Try again to pick up where it left off.`;
  }

  /** Shown when a create sent again after no answer is told the name is in use. */
  const CREATE_MAYBE_CREATED_REASON =
    "A bot with that name already exists in this company. It may be the one you just tried to create. Look in Settings, under Bots, before trying again.";

  /** A late answer for a cancelled bot must never bring its waiting screen back. */
  function botIsCancelled(agentUid: string): boolean {
    const uid = agentUid.trim();
    if (!uid) return false;
    return removedBotUids.includes(uid) || botRemovals.some((removal) => removal.agentUid === uid);
  }

  function setBotRemovals(next: BotRemoval[]): void {
    botRemovals = next;
    saveOpenBotRemovals(next, accountStorage);
  }

  function patchBotRemoval(id: string, patch: Partial<BotRemoval>): void {
    setBotRemovals(botRemovals.map((removal) => removal.id === id ? { ...removal, ...patch } : removal));
  }

  /** The takeover's create request, watched so Cancel can reach it. */
  async function createAgentFromTakeover(
    companyUid: string,
    draft: CloudBotDraft,
  ): Promise<EntryPointResult> {
    return sendCreate(companyUid, draft, false);
  }

  /**
   * Send one create. `resent` is true for the one time a create is sent
   * again by the app itself: a kept key was answered with a bot that has
   * since been removed, so the same draft goes out once more under a new key.
   */
  async function sendCreate(companyUid: string, draft: CloudBotDraft, resent: boolean): Promise<EntryPointResult> {
    if (!oncreatenewbot) return { ok: false, blocked: false, reason: "" };
    // One key for this draft, minted at the press and written down before
    // the request leaves. A draft whose last create got no answer gets the
    // same key again: the server answers with what that first request made.
    const keyed = takeCreateKey(accountStorage, createDraftSignature(companyUid, draft));
    const sent: CloudBotDraft = { ...draft, idempotencyKey: keyed.key };
    let finish!: () => void;
    const attempt = {
      cancelled: false,
      name: draft.name,
      companyUid,
      brain: draft.runtime ?? null,
      removalId: null as string | null,
      handle: botHandle({ name: draft.name, handle: draft.handle ?? "" }),
      key: keyed.key,
      reused: keyed.reused,
      // Started before the create is sent, so it shows what was there before.
      baseline: baselineFor(keyed.key, keyed.reused, companyUid),
      answer: null as EntryPointResult | null,
      ended: false,
      finished: new Promise<void>((resolve) => { finish = resolve; }),
    };
    createInFlight = attempt;
    const done = (): void => {
      if (createInFlight === attempt) createInFlight = null;
    };
    const cancelledAnswer: EntryPointResult = { ok: false, blocked: false, reason: "", cancelled: true };
    try {
      let result: EntryPointResult | null = null;
      try {
        result = await oncreatenewbot(companyUid, sent);
      } catch {
        // A create that threw says nothing about what it made.
        result = null;
      }
      const unknown = !result || (!result.ok && result.outcomeUnknown === true);
      // "That name already exists", said to a create that was sent again after
      // no answer, may be about the very bot the first request made: the
      // server checks the name before it looks at the key, so a second request
      // that arrives while the first is still running is refused this way.
      const takenAfterResend =
        keyed.reused && !!result && !result.ok && result.reason === CLOUD_BOT_NAME_TAKEN_REASON;
      // What Cancel settles from. Neither of the two above says what was made.
      attempt.answer = unknown || takenAfterResend ? null : result;
      if (attempt.cancelled) {
        done();
        void settleCancelledCreate(attempt, attempt.answer);
        return cancelledAnswer;
      }
      // The request is over. From here on Cancel settles the attempt itself.
      attempt.ended = true;
      if (unknown || takenAfterResend) {
        // Look for the bot before anything else is offered. Create bot stays
        // held meanwhile, so the common case (the first request did make the
        // bot) never sends a second create at all.
        if (loadCompanyBots) checkingCreate = attempt;
        // After no answer: one look, then the person may send it again. After
        // a refused resend there is nothing more to send: every look is used.
        const found = await lookUpOwnBot(attempt, lookupDelays(unknown ? 1 : 3));
        if (checkingCreate === attempt) checkingCreate = null;
        // Cancel pressed during the looks settles on its own (cancelCreateInFlight).
        if (attempt.cancelled) return cancelledAnswer;
        done();
        if (found) {
          // The bot is this create's own: take it up as its answer would have.
          forgetCreateKey(keyed.key);
          const adopted: EntryPointResult = {
            ok: true,
            target: { channelId: "", cardId: null, cardKind: null, agentUid: found },
          };
          rememberCreatedBot(companyUid, draft, adopted);
          // The host never saw this create answer, so it is told here.
          onbotadopted?.(found, draft);
          return adopted;
        }
        if (unknown) {
          // The key stays: the next press of Create bot for this draft sends it again.
          return { ok: false, blocked: false, reason: createUnknownReason(draft.name), outcomeUnknown: true };
        }
        // The server has answered this key for good, and the bot was not found.
        forgetCreateKey(keyed.key);
        return { ok: false, blocked: false, reason: CREATE_MAYBE_CREATED_REASON };
      }
      const answered = result as EntryPointResult;
      const named = answered.ok && !answered.target.cardId ? (answered.target.agentUid ?? "").trim() : "";
      if (keyed.reused && named && !resent) {
        // A kept key is answered with the bot its first request made, however
        // long ago. That bot may have been removed since. Its status is read
        // once: if the server says it is gone, the key is let go and the same
        // draft is sent once more as a new create.
        if (await botIsGone(named)) {
          if (attempt.cancelled) return cancelledAnswer;
          done();
          forgetCreateKey(keyed.key);
          return sendCreate(companyUid, draft, true);
        }
        if (attempt.cancelled) return cancelledAnswer;
      }
      done();
      // The server answered. Its answer is final for this key.
      forgetCreateKey(keyed.key);
      rememberCreatedBot(companyUid, draft, answered);
      return answered;
    } finally {
      finish();
    }
  }

  /** True when a status read says the server no longer has the bot, or is taking it down. */
  async function botIsGone(agentUid: string): Promise<boolean> {
    if (!loadAgentStatus) return false;
    let status: unknown = null;
    try {
      status = await loadAgentStatus(agentUid);
    } catch {
      return false;
    }
    if (wakingStopFromFailure(status) === "removed") return true;
    const answer = status as { ok?: unknown; value?: unknown } | null;
    if (answer?.ok !== true) return false;
    const phase = String(
      (answer.value as { setupState?: { phase?: unknown } } | null)?.setupState?.phase ?? "",
    ).toLowerCase();
    return phase === "deprovisioning" || phase === "deprovisioned";
  }

  /** The waits before each look at the company's bots. */
  function lookupDelays(count: number): number[] {
    return botCreateLookupMs === undefined
      ? CANCELLED_CREATE_LOOKUP_DELAYS_MS.slice(0, count)
      : Array.from({ length: count }, () => botCreateLookupMs as number);
  }

  /** One look at the company's bots for the bot this create may have made. Null when they cannot be read. */
  function createdBotLookup(attempt: NonNullable<typeof createInFlight>) {
    const read = loadCompanyBots;
    if (!read) return null;
    return async () =>
      findCreatedBot({
        roster: await read(attempt.companyUid),
        companyUid: attempt.companyUid,
        handle: attempt.handle,
        baseline: await attempt.baseline,
      });
  }

  /**
   * Whether a bot found by its handle is this person's own, from the creator
   * the server records. Taking a bot up (`proven` false) is refused only when
   * the server names another person: a read that fails, or does not say,
   * decides nothing. Removing one (`proven` true) needs the server to name
   * this person: anything less is not enough to remove a bot.
   */
  async function ownCreatedBot(agentUid: string, proven = false): Promise<boolean> {
    let status: unknown = null;
    try {
      status = loadAgentStatus ? await loadAgentStatus(agentUid) : null;
    } catch {
      status = null;
    }
    return proven ? createdByViewer(status, self?.uid) : !createdByAnotherPerson(status, self?.uid);
  }

  /**
   * Look for the bot a create with no usable answer made. Reads only.
   * Resolves the bot's id when it is this create's own, else null.
   */
  async function lookUpOwnBot(
    attempt: NonNullable<typeof createInFlight>,
    delaysMs: readonly number[],
  ): Promise<string | null> {
    const outcome = await resolveCancelledCreate(null, createdBotLookup(attempt), {
      delaysMs,
      stopped: () => attempt.cancelled,
    });
    if (outcome.kind !== "created" || !outcome.agentUid || attempt.cancelled) return null;
    // A bot the person cancelled is being removed: it is not taken up.
    if (botIsCancelled(outcome.agentUid)) return null;
    return (await ownCreatedBot(outcome.agentUid)) ? outcome.agentUid : null;
  }

  /**
   * The create answered with a bot. Put it on the list of starting bots
   * here, where the answer arrives, and not only when the takeover shows its
   * waiting screen: the takeover, and this sidebar, may be gone by now (a
   * company switch, a collapsed sidebar), and the bot must still get its row.
   */
  function rememberCreatedBot(companyUid: string, draft: CloudBotDraft, result: EntryPointResult): void {
    // A card in the answer means nothing was created.
    if (!result.ok || result.target.cardId) return;
    const agentUid = result.target.agentUid?.trim() ?? "";
    const channelId = result.target.channelId?.trim() ?? "";
    if (!agentUid && !channelId) return;
    if (agentUid) takenUpBots.add(agentUid);
    beginWakingBot(
      beginWakingSession({ agentUid, channelId, companyUid, name: draft.name, brain: draft.runtime ?? null }),
    );
  }

  /** Cancel while the create request is out. Its answer decides what there is to remove. */
  function cancelCreateInFlight(): void {
    const attempt = createInFlight;
    if (!attempt || attempt.cancelled) return;
    attempt.cancelled = true;
    createInFlight = null;
    const removal = beginBotRemoval({ name: attempt.name, companyUid: attempt.companyUid, brain: attempt.brain });
    attempt.removalId = removal.id;
    setBotRemovals([removal, ...botRemovals]);
    // The key goes with the attempt. A create of the same draft after this
    // is a new create under a new key: it must not be answered with the bot
    // this cancelled attempt made, which is about to be removed.
    forgetCreateKey(attempt.key);
    // The request already ended: nothing else will settle this attempt, so
    // it is settled from here.
    if (attempt.ended) void settleCancelledCreate(attempt, attempt.answer);
    if (checkingCreate === attempt) checkingCreate = null;
  }

  /**
   * The answer to a create the person cancelled. A bot it names exists and
   * is removed. An answer that does not say (a timeout, a dropped
   * connection) is not read as "nothing was created", and the create is not
   * sent again to find out: a first request that never reached the server
   * would then make the bot the person cancelled. The company's bots are
   * read instead, a few times, and searched for the handle.
   */
  async function settleCancelledCreate(
    attempt: NonNullable<typeof createInFlight>,
    result: EntryPointResult | null,
  ): Promise<void> {
    const removalId = attempt.removalId;
    if (!removalId) return;
    const lookedUp = readCancelledCreate(result).kind === "unknown";
    // A create sent under a kept key is answered with the bot that key's
    // first request made, which may be from an earlier day and in use. Cancel
    // removes a starting bot only after the person confirms, and nobody was
    // asked here, so that bot is never removed and is not looked for.
    const outcome = await resolveCancelledCreate(result, attempt.reused ? null : createdBotLookup(attempt), {
      delaysMs: lookupDelays(3),
    });
    if (outcome.kind === "unknown" || (attempt.reused && outcome.kind === "created")) {
      // Still not known, or not this press's to remove. Nothing is claimed.
      patchBotRemoval(removalId, { phase: "unconfirmed" });
      return;
    }
    forgetCreateKey(attempt.key);
    if (outcome.kind === "not-created") {
      patchBotRemoval(removalId, { phase: "not-created" });
      return;
    }
    const agentUid = outcome.agentUid;
    const channelId = outcome.channelId;
    // An older server also makes a channel for the bot. The server does not
    // remove that channel with the bot, so it stays off the list.
    if (channelId) botSetupChannels = rememberBotSetupChannel(botSetupChannels, channelId, storage);
    if (!agentUid) {
      patchBotRemoval(removalId, { channelId, phase: "failed", problem: "unknown-bot" });
      return;
    }
    if (lookedUp) {
      // A later create of the same draft may be the one that made this bot.
      // Its answer says so: wait for it before deciding whose bot this is.
      const later = createInFlight;
      if (
        later &&
        later !== attempt &&
        !later.cancelled &&
        later.companyUid === attempt.companyUid &&
        later.handle === attempt.handle
      ) {
        await later.finished;
      }
    }
    if (takenUpBots.has(agentUid) || botRemovals.some((other) => other.id !== removalId && other.agentUid === agentUid)) {
      // The bot belongs to a create the person did not cancel, or another
      // cancel already accounts for it. This cancel has nothing to remove.
      setBotRemovals(botRemovals.filter((other) => other.id !== removalId));
      return;
    }
    if (lookedUp) {
      // The bot was found by its handle, not named by the create's answer.
      if (!canRemoveBotIn(attempt.companyUid)) {
        // This person may not remove bots: no removal is sent, and the line
        // says who can remove it.
        patchBotRemoval(removalId, { agentUid, phase: "failed", problem: "not-allowed" });
        return;
      }
      // One more check before removing a bot found that way: the server
      // must name this person as its creator.
      if (!(await ownCreatedBot(agentUid, true))) {
        patchBotRemoval(removalId, { phase: "unconfirmed" });
        return;
      }
    }
    patchBotRemoval(removalId, { agentUid, channelId, phase: "removing", problem: null });
    void runRemoval(removalId);
  }

  /**
   * False only when this person is known to be neither owner nor admin of
   * that company. The server allows nobody else to remove a bot, so Cancel
   * must not promise them a removal. A company this list does not know says
   * nothing either way, and the server decides.
   */
  function canRemoveBotIn(companyUid: string): boolean {
    if (isAdmin === true) return true;
    const uid = companyUid.trim();
    const role = ((companies ?? []).find((company) => (company.cloudUid ?? "").trim() === uid)?.role ?? "")
      .trim()
      .toLowerCase();
    return !role || role === "owner" || role === "admin";
  }

  /** The person confirmed that a bot that is starting should be removed. */
  function cancelWakingBot(session: WakingBotSession): void {
    const agentUid = session.agentUid.trim();
    endWakingBot(session);
    openWakingKey = null;
    const removal = beginBotRemoval({
      name: session.name,
      companyUid: session.companyUid,
      agentUid,
      channelId: session.channelId,
      brain: session.brain,
      hadRow: true,
    });
    if (!agentUid) {
      setBotRemovals([{ ...removal, phase: "failed", problem: "unknown-bot" }, ...botRemovals]);
      return;
    }
    setBotRemovals([removal, ...botRemovals.filter((other) => other.agentUid !== agentUid)]);
    void runRemoval(removal.id);
  }

  /**
   * Removals this sidebar is asking the server about right now, and the way
   * to stop each. A run asks every few seconds for up to twenty minutes, so
   * it must not outlive the sidebar that started it: the sidebar that
   * replaces this one picks the removal up from what was written down.
   */
  const removalStops = new Map<string, () => void>();
  onDestroy(() => {
    for (const stop of removalStops.values()) stop();
    removalStops.clear();
  });

  async function runRemoval(id: string): Promise<void> {
    const removal = botRemovals.find((candidate) => candidate.id === id);
    if (!removal || !removal.agentUid || removalStops.has(id)) return;
    if (!removeAgent) {
      patchBotRemoval(id, { phase: "failed", problem: "error" });
      return;
    }
    patchBotRemoval(id, { phase: "removing", problem: null });
    const agentUid = removal.agentUid;
    const run = startBotRemoval(agentUid, removeAgent, { retryMs: botRemovalRetryMs });
    removalStops.set(id, run.stop);
    let outcome: BotRemovalRun = "error";
    try {
      outcome = await run.done;
    } finally {
      if (removalStops.get(id) === run.stop) removalStops.delete(id);
    }
    // Stopped with this sidebar, or by the run that took over for the same
    // bot: nothing was decided. The removal stays written down as under way.
    if (outcome === "stopped") return;
    if (outcome !== "removed") {
      patchBotRemoval(id, { phase: "failed", problem: outcome });
      return;
    }
    // Gone on the server: forget the bot here, and keep its conversation off
    // the list, because the server leaves the thread behind.
    removedBotUids = rememberRemovedBot(removedBotUids, agentUid, accountStorage);
    endWakingBot({ agentUid, channelId: "" });
    forgetKeysOfRemovedBot(removal.companyUid, removal.name);
    patchBotRemoval(id, { phase: "removed", problem: null });
    onbotremoved?.(agentUid);
  }

  /**
   * Put a failed removal away. The bot was not removed, so it goes back to
   * being a bot that is starting: its row and its waiting screen return, and
   * it hands off to chat when it is ready. A bot the server is still taking
   * down gets no waiting screen back: it is on its way out.
   */
  function keepCancelledBot(id: string): void {
    const removal = botRemovals.find((candidate) => candidate.id === id);
    if (!removal || removal.phase !== "failed") return;
    setBotRemovals(botRemovals.filter((candidate) => candidate.id !== id));
    if (!removal.agentUid || removal.problem === "still-removing") return;
    const session = beginWakingSession({
      agentUid: removal.agentUid,
      channelId: removal.channelId,
      companyUid: removal.companyUid,
      name: removal.name,
      brain: removal.brain,
    });
    changeWakingBots((sessions) => upsertWakingSession(sessions, session));
  }

  // A removal the app was in the middle of when it last closed is asked again.
  onMount(() => {
    for (const removal of botRemovals) {
      if (removal.phase === "removing") void runRemoval(removal.id);
    }
  });

  // Finished cancels are read once. They leave when the takeover closes.
  $effect(() => {
    if (newBotOpen) return;
    untrack(() => {
      const finished = (removal: BotRemoval): boolean =>
        removal.phase === "removed" || removal.phase === "not-created" || removal.phase === "unconfirmed";
      if (botRemovals.some(finished)) {
        setBotRemovals(botRemovals.filter((removal) => !finished(removal)));
      }
    });
  });

  /** The bot can chat: take the person to their direct message with it. */
  function openWakingBotChat(session: WakingBotSession): void {
    if (session.agentUid) {
      const row: ConversationRow = allRows.find(
        (candidate) => candidate.kind === "dm" && candidate.personUid === session.agentUid,
      ) ?? {
        id: `dm:${session.agentUid}`,
        kind: "dm",
        title: session.name,
        companyUid: null,
        unreadDot: false,
        lastActivityAt: Date.now(),
        pinned: false,
        personUid: session.agentUid,
      };
      // The row still carries the waking marker for a moment; open the plain row.
      const { wakingBot: _waking, ...plain } = row;
      void openRow(plain);
      return;
    }
    const row = allRows.find((candidate) => candidate.channelId === session.channelId);
    if (row) {
      void openRow(row);
      return;
    }
    requestChannelOpen(session.channelId, {
      title: session.name,
      companyUid: session.companyUid,
    });
  }

  /** The company's plan cannot host a cloud bot: open its channel on the upgrade card. */
  function openUpgradeFromTakeover(target: { companyUid: string; channelId: string; cardId: string }): void {
    newBotOpen = false;
    requestChannelOpen(target.channelId, {
      companyUid: target.companyUid,
      focusCardId: target.cardId,
    });
  }

  /**
   * True when the takeover was opened from the create window's "New bot" row.
   * On the rail it usually opens from the "+" menu, with no window behind it.
   */
  let newBotFromCreateWindow = false;

  /** Cancel goes back to where the person came from: the create window, or the "+" button. */
  async function cancelNewBotTakeover(): Promise<void> {
    newBotOpen = false;
    const backToWindow = newBotFromCreateWindow;
    newBotFromCreateWindow = false;
    if (!backToWindow) {
      await tick();
      plusBtnEl?.focus();
      return;
    }
    createStep = "find";
    createSunrise = false;
    createBotHome = null;
    newBotName = "";
    createOpen = true;
    await tick();
    document.querySelector<HTMLInputElement>('[data-testid="chat-create-query"]')?.focus();
  }

  /**
   * Leave the takeover for the "+" window's bot flow, worn in the same
   * takeover shell: Local from the choice, Cloud in companies the takeover
   * does not list, or the create screen's "local bot instead" (no preset).
   */
  function openBotFlowFromChoice(home: "local" | "cloud" | null, name: string = newBotName): void {
    newBotName = name.trim();
    newBotOpen = false;
    newBotFromCreateWindow = false;
    // Only the company this New bot was opened for (Team page Add agent)
    // carries over; an older preselect must not.
    createBotCompanyUid = newBotPreferredCompanyUid;
    createKind = "channel";
    createStep = "bot";
    createSunrise = true;
    createBotHome = home;
    createOpen = true;
  }

  function openLocalBotFromTakeover(name: string): void {
    openBotFlowFromChoice(null, name);
  }

  /** Back from the bot flow's first step: "Where should it live?" again, with the name. */
  function backToNewBotChoice(name: string = newBotName): void {
    newBotName = name.trim();
    createOpen = false;
    createSunrise = false;
    createBotHome = null;
    newBotCompaniesAtOpen = newBotTargets;
    openWakingKey = null;
    newBotChoose = true;
    newBotOpenCloud = false;
    newBotOpen = true;
  }

  /**
   * "Create a cloud bot instead" on the local steps: the cloud create screen
   * when the takeover has one, else the "+" window's cloud flow.
   */
  function switchLocalToCloud(name: string = newBotName): void {
    if (takeoverHasCloud) {
      backToNewBotChoice(name);
      newBotOpenCloud = true;
      return;
    }
    if (!canMakeCloudBotInWindow) return;
    // Close the local steps first: the window's flow is built for the home
    // it opens with, so the cloud one must open fresh.
    createOpen = false;
    void tick().then(() => openBotFlowFromChoice("cloud", name));
  }

  /** Host entry point (#welcome's "Start a project channel"): open the create modal. */
  export function openCreateChannel(options: { kind?: "channel" | "project" } = {}): void {
    createKind = options.kind ?? "channel";
    createStep = "find";
    openCreate();
  }

  /** Close the create modal; optionally open the channel it just created. */
  function closeCreate(
    openChannelId?: string,
    hint?: { title: string; companyUid: string | null },
  ): void {
    createOpen = false;
    createSunrise = false;
    createBotHome = null;
    newBotPreferredCompanyUid = null;
    // The New channel sheet closes through here too (QA-019).
    channelSheetOpen = false;
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

  /** Host entry point (Team page Add agent): open on the New agent step. */
  function openNewAgent(companyUid: string | null = null): void {
    // Every New bot entry starts on the "Cloud or Local?" question.
    if (newBotChoicePossible) {
      closeAllOverlays();
      newBotPreferredCompanyUid = companyUid;
      openNewBotTakeover({ choose: true });
      return;
    }
    newBotPreferredCompanyUid = null;
    createKind = "channel";
    createStep = "bot";
    openCreate();
    createBotCompanyUid = companyUid;
  }

  /** Failure reason from a switcher-triggered New company, shown inline. */
  let scopeEntryError = $state<string | null>(null);
  let scopeEntryBusy = $state(false);

  async function newCompanyFromSwitcher(): Promise<void> {
    // The in-modal flow owns this when the host wired it: the switcher opens
    // the create modal on its company step instead of jumping to #setup.
    if (companyCreate) {
      scopeMenuOpen = false;
      scopeEntryError = null;
      createKind = "channel";
      createStep = "company";
      openCreate();
      return;
    }
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
      console.warn("[chat-sidebar] new company failed", err);
      scopeEntryError = "Could not start a new company. Try again.";
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

  function scopeShortcutLabel(optionId: string): string {
    // Only Personal keeps a key: ⌘0 collides with zoom-reset and ⌘1–4 switch
    // the main views app-wide.
    if (optionId === "personal") return formatShortcut("Mod+P");
    return "";
  }

  /** Presigned icon for a scope-menu option, or null (all/personal/no icon). */
  function scopeOptionIcon(optionId: string): string | null {
    if (optionId === "all" || optionId === "personal") return null;
    return companyIcons.get(optionId) ?? null;
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
      !contextMenu &&
      !selectionMode
    )
      return;

    function onMouseDown(event: MouseEvent) {
      if (!(event.target instanceof Node)) return;
      // Any outside mousedown dismisses the cursor context menu. Clicks inside
      // it call stopPropagation, so they never reach this handler.
      if (contextMenu) contextMenu = null;
      if (createMenuOpen) {
        const menu = document.querySelector('[data-testid="chat-create-menu"]');
        const inside =
          (plusBtnEl?.contains(event.target) ?? false) ||
          (menu?.contains(event.target) ?? false);
        if (!inside) createMenuOpen = false;
      }
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
      if (selectionMode) {
        exitSelectionMode();
        event.preventDefault();
        return;
      }
      // No `createOpen` branch on purpose — CreateModal owns its own Escape
      // (and backdrop) dismissal; two handlers would double-fire.
      if (createMenuOpen || messageSheetOpen || channelSheetOpen || scopeMenuOpen || filterOpen || footerMenuOpen) {
        createMenuOpen = false;
        if (!messageSheetOpen && !channelSheetOpen) {
          scopeMenuOpen = false;
          filterOpen = false;
          footerMenuOpen = false;
        }
        messageSheetOpen = false;
        channelSheetOpen = false;
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
    const seq = ++messageSearchSeq;
    if (!q) {
      messageSearchHits = [];
      messageSearchError = null;
      messageSearchLoading = false;
      return;
    }
    if (messageSearchQueryProblem(q)) {
      messageSearchHits = [];
      messageSearchError = null;
      messageSearchLoading = false;
      return;
    }
    const companyUid = historyCompanyUid;
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
          // The requests the app writes to a bot are not for the person, and
          // the server's search returns them like any message (review B-3).
          messageSearchHits = withoutHiddenRequestHits(
            Array.isArray(resp?.results) ? resp.results : [],
            self?.uid,
          );
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

  // Human-recency refresh. In humanOnly mode a row whose last human message
  // is known (or known to be absent) is ordered by a value only the server
  // computes, and a channel-message wake does not reconcile the directory. A
  // message a person just typed would then leave the row where it was until
  // the next unrelated reconcile. A wake that could change that value
  // (`wakeMayChangeHumanRecency`) asks for a directory read, at most once per
  // interval: the wake cannot say whether a person typed the message, and
  // work sessions post often. The person's own send from the composer
  // (`channel:own-send`) is known to be typed and is read at once.
  const HUMAN_RECENCY_RECONCILE_MIN_INTERVAL_MS = 20_000;
  let humanRecencyTimer: ReturnType<typeof setTimeout> | null = null;
  let humanRecencyLastRunAt = 0;
  function scheduleHumanRecencyReconcile(immediate: boolean): void {
    if (immediate) {
      // Replaces a pending throttled read, so one send costs one read.
      if (humanRecencyTimer != null) {
        clearTimeout(humanRecencyTimer);
        humanRecencyTimer = null;
      }
      humanRecencyLastRunAt = Date.now();
      scheduleDirectoryReconcile();
      return;
    }
    if (humanRecencyTimer != null) return;
    const wait = Math.max(
      400,
      humanRecencyLastRunAt + HUMAN_RECENCY_RECONCILE_MIN_INTERVAL_MS - Date.now(),
    );
    humanRecencyTimer = setTimeout(() => {
      humanRecencyTimer = null;
      humanRecencyLastRunAt = Date.now();
      void directoryReconciler.reconcile("wake").catch(() => {});
    }, wait);
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
        raceTimeout(api.listContacts({ showBotMessages: false }), bootTimeoutMs, "list_contacts").catch(
          (err) => {
            sidebarLog("boot-error", {
              source: "list_contacts",
              timeout: err instanceof BootTimeoutError,
              // raw-error-ok: telemetry payload only
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
          sidebarLog("boot-error", {
            source: "list_dm_requests",
            timeout: err instanceof BootTimeoutError,
            // raw-error-ok: telemetry payload only
            message: err instanceof Error ? err.message : String(err),
          });
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
        // raw-error-ok: telemetry payload only
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

  /** Re-read pending connection requests alone (no directory/contacts churn). */
  async function refreshRequests(): Promise<void> {
    try {
      const resp = await raceTimeout(
        api.listDmRequests(),
        bootTimeoutMs,
        "list_dm_requests",
      );
      pendingRequests = Array.isArray(resp?.requests) ? resp.requests : [];
    } catch (err) {
      sidebarLog("boot-error", {
        source: "list_dm_requests",
        timeout: err instanceof BootTimeoutError,
        // raw-error-ok: telemetry payload only
        message: err instanceof Error ? err.message : String(err),
      });
      console.error("chat-sidebar: list_dm_requests failed", err);
    }
  }

  $effect(() => {
    const seq = requestsWakeSeq;
    if (seq <= 0) return;
    untrack(() => {
      void refreshRequests();
    });
  });

  // `dmNameLookupsTried` lives in the module script above.

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
      // The DM thread listing may also report each pair's last human
      // message. Entries without those fields change nothing.
      contacts = applyDmHumanRecency(contacts, activity);
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
            if (
              humanOnly &&
              wakeMayChangeHumanRecency(
                channels.find((c) => c.channelId === channelId),
                { createdAt: stamp, fromPersonUid: payload.fromPersonUid },
              )
            ) {
              scheduleHumanRecencyReconcile(false);
            }
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
        wakes.on("channel:own-send", ({ channelId }) => {
          if (!humanOnly) return;
          const channel = channels.find((c) => c.channelId === channelId);
          // A row in the unknown state is ordered by activity, which the
          // send has already stamped.
          const known =
            Boolean((channel?.lastHumanMessageAt ?? "").trim()) ||
            channel?.hasHumanMessage === false;
          if (known) scheduleHumanRecencyReconcile(true);
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

      // Header bell: optimistic level change (or its rollback). Local only —
      // the server write is the shell's; the next directory read confirms it.
      track(
        wakes.on("channel:notify-level", ({ channelId, level }) => {
          channels = applyChannelNotifyLevel(channels, channelId, level);
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

    // Company-scope hotkeys used to live here (⌘0 all, ⌘1–5 companies): they
    // shadowed the shell's ⌘1–4 view switches and ⌘0 zoom-reset, so scope
    // switching now goes through the scope menu / command palette. ⌘P
    // (Personal) has no conflict and stays, routed through the shared registry.
    const unregisterShortcuts = registerShortcuts([
      {
        id: "scope.personal",
        keys: "Mod+P",
        label: "Show only personal",
        group: "Sidebar",
        run: () => selectScope("personal"),
      },
      // ⇧⌘K / ⇧⌘N / ⌥⌘N (the Create menu) are shell bindings so they work
      // from every page; registering them here too would double-bind them
      // and leave them dead wherever this sidebar is unmounted (QA-077).
    ]);

    window.addEventListener(COMPOSER_DRAFT_CHANGED_EVENT, refreshDraftIds);

    return () => {
      window.removeEventListener(COMPOSER_DRAFT_CHANGED_EVENT, refreshDraftIds);
      for (const u of unlisteners) u();
      directoryReconciler.stop();
      if (refreshTimer != null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      if (humanRecencyTimer != null) {
        clearTimeout(humanRecencyTimer);
        humanRecencyTimer = null;
      }
      if (reconcileTimer != null) {
        clearTimeout(reconcileTimer);
        reconcileTimer = null;
      }
      unregisterShortcuts();
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
      console.warn("[chat-sidebar] sign out failed", error);
      signOutError = "Couldn’t sign out. Try again.";
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
        title={`Company scope (${formatShortcut("Mod+P")} Personal)`}
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
                <CompanyIcon iconUrl={scopeOptionIcon(option.id)} size={24} />
              {:else}
                <span
                  class={`chat-scope-avatar tone-${scopeAvatarTone(option.label)}`}
                  aria-hidden="true"
                >
                  {scopeAvatarLabel(option)}
                </span>
              {/if}
              <span class="chat-scope-row-label">
                {option.id === "all" ? "All companies" : option.label}
              </span>
              {#if scopeShortcutLabel(option.id)}
                <span class="chat-scope-shortcut">
                  {scopeShortcutLabel(option.id)}
                </span>
              {/if}
            </button>
          {/each}
          {#if oncreatecompany || companyCreate}
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
                <svg viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 3.5v9M3.5 8h9"
                    stroke="currentColor"
                    stroke-width="1.3"
                    stroke-linecap="round"
                  />
                </svg>
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
      <button
        type="button"
        class="chat-icon-btn"
        bind:this={plusBtnEl}
        data-testid="chat-new-message"
        aria-label={createButtonLabel}
        title={createButtonLabel}
        aria-haspopup="menu"
        aria-expanded={createMenuOpen}
        aria-controls="chat-create-menu"
        onclick={openCreateFromButton}
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
      {#if createMenuOpen}
        <div
          class="chat-popover chat-create-menu"
          id="chat-create-menu"
          role="menu"
          aria-label="Create"
          data-testid="chat-create-menu"
          use:menuPortal={{ anchor: plusBtnEl, placement: "bottom-start" }}
        >
          <div class="chat-create-sec">Create</div>
          {#each CREATE_MENU_ITEMS as item (item.id)}
            <button
              type="button"
              class="chat-popover-row chat-create-row"
              role="menuitem"
              data-testid={"chat-create-menu-" + item.id}
              onclick={() => openCreateAction(item.id)}
            >
              <span class="t">{item.label}</span>
              <span class="chat-scope-shortcut">{formatShortcut(item.keys)}</span>
            </button>
          {/each}
          <p class="chat-create-foot">Scope follows the selected row · {scopeLabel}</p>
        </div>
      {/if}
      <button
        type="button"
        class="chat-icon-btn"
        data-testid="chat-search"
        aria-label="Search or jump to a conversation"
        title="Search or jump to…"
        onclick={openSearch}
        bind:this={searchButton}
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
                <span class="chat-sort-ic" aria-hidden="true">{@render filterIcon("clock")}</span>
                Recent
              </button>
              <button
                type="button"
                class="chat-sort-pill"
                class:active={sortMode === "type"}
                aria-pressed={sortMode === "type"}
                onclick={() => (sortMode = "type")}
              >
                <span class="chat-sort-ic" aria-hidden="true">{@render filterIcon("list")}</span>
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
              <span class="chat-filter-lead" aria-hidden="true">{@render filterIcon("home")}</span>
              <span class="chat-filter-text">My projects</span>
              {#if showFilter === "mine"}
                <span class="chat-filter-check" aria-hidden="true">{@render filterIcon("check")}</span>
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
              <span class="chat-filter-lead" aria-hidden="true">{@render filterIcon("list")}</span>
              <span class="chat-filter-text">All</span>
              {#if showFilter === "all"}
                <span class="chat-filter-check" aria-hidden="true">{@render filterIcon("check")}</span>
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
              <span class="chat-filter-lead" aria-hidden="true">{@render filterIcon("hash")}</span>
              <span class="chat-filter-text">Project channels</span>
              {#if showFilter === "projects"}
                <span class="chat-filter-check" aria-hidden="true">{@render filterIcon("check")}</span>
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
              <span class="chat-filter-lead" aria-hidden="true">{@render filterIcon("bubble")}</span>
              <span class="chat-filter-text">DMs &amp; groups</span>
              {#if showFilter === "dms"}
                <span class="chat-filter-check" aria-hidden="true">{@render filterIcon("check")}</span>
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
                <span class="chat-filter-lead" aria-hidden="true">{@render filterIcon("target")}</span>
                <span class="chat-filter-text">Company projects</span>
                {#if showFilter === "company-projects"}
                  <span class="chat-filter-check" aria-hidden="true">{@render filterIcon("check")}</span>
                {/if}
              </button>
            {/if}

            <button
              type="button"
              class="chat-filter-row"
              class:active={showArchived}
              data-testid="chat-filter-archived"
              aria-pressed={showArchived}
              onclick={() => setShowArchived(!showArchived)}
            >
              <span class="chat-filter-lead" aria-hidden="true">{@render filterIcon("archive")}</span>
              <span class="chat-filter-text">Show archived</span>
              {#if archivedVisibleCount > 0 && !showArchived}
                <span
                  class="chat-filter-meta"
                  data-testid="chat-filter-archived-count">{archivedVisibleCount}</span
                >
              {/if}
              {#if showArchived}
                <span class="chat-filter-check" aria-hidden="true">{@render filterIcon("check")}</span>
              {/if}
            </button>

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

  {#if selectionMode}
    <div
      class="chat-selection-bar"
      data-testid="chat-selection-bar"
      role="toolbar"
      aria-label="Selected conversations"
    >
      <span class="chat-selection-count" data-testid="chat-selection-count">
        {selectionCount} selected
      </span>
      <button
        type="button"
        class="chat-selection-action"
        data-testid="chat-selection-all"
        onclick={selectAllVisible}
      ><RailIcon name="check-circle" />
        Select all
      </button>
      <button
        type="button"
        class="chat-selection-action primary"
        data-testid="chat-selection-archive"
        disabled={selectionCount === 0}
        onclick={archiveSelection}
      ><RailIcon name="archive" />
        {selectionAllArchived ? "Unarchive" : "Archive"}
      </button>
      <button
        type="button"
        class="chat-selection-action"
        data-testid="chat-selection-done"
        onclick={exitSelectionMode}
      ><RailIcon name="check" />
        Done
      </button>
    </div>
  {/if}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="chat-scroll"
    data-testid="chat-conversation-list"
    onmouseenter={() => (sidebarHovered = true)}
    onmouseleave={() => (sidebarHovered = false)}
    data-selection-mode={selectionMode ? "on" : undefined}
    data-select-gutter={showSelectGutter ? "on" : undefined}
    aria-multiselectable={selectionMode ? true : undefined}
    aria-busy={allRows.length === 0 && (!firstRefreshSettled || loading)}
  >
    {#if allRows.length === 0 && (!firstRefreshSettled || loading)}
      <ReadLoader testid="sidebar-loading" />
    {:else}
    {#if pendingRequestCount > 0}
      <button
        type="button"
        class="chat-row chat-requests-row"
        data-testid="chat-connection-requests"
        aria-label={`Connection requests, ${pendingRequestCount} pending`}
        onclick={openConnectionRequests}
      >
        <span class="chat-glyph requests" aria-hidden="true">{@render filterIcon("requests")}</span>
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

    {#if !companiesOnRail && (companies ?? []).length > 0}
      <div class="chat-section-label chat-companies-label" id="chat-companies-label">
        <span>COMPANIES</span>
        <button
          type="button"
          class="chat-companies-edit"
          data-testid="chat-companies-edit"
          aria-haspopup="true"
          aria-expanded={companiesSectionMenuOpen}
          aria-label="More companies"
          title="Pin companies"
          onclick={() => (companiesSectionMenuOpen = !companiesSectionMenuOpen)}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="4" cy="8" r="1.3" fill="currentColor" />
            <circle cx="8" cy="8" r="1.3" fill="currentColor" />
            <circle cx="12" cy="8" r="1.3" fill="currentColor" />
          </svg>
        </button>
      </div>
      {#if companiesSectionMenuOpen}
        <div
          class="chat-companies-menu"
          role="menu"
          data-testid="chat-companies-menu"
          aria-labelledby="chat-companies-label"
        >
          <p class="chat-companies-menu-hint">
            Pin companies to keep them here — otherwise your 3 most active show.
          </p>
          {#each companies ?? [] as company (company.cloudUid ?? company.slug)}
            {@const uid = (company.cloudUid ?? "").trim()}
            {#if uid}
              {@const checked = pinnedCompanies.includes(uid)}
              <label class="chat-companies-menu-item">
                <input
                  type="checkbox"
                  data-testid={`chat-companies-menu-item-${uid}`}
                  {checked}
                  onchange={() => toggleCompanyPin(uid)}
                />
                <CompanyLabel
                  name={company.displayName || company.slug}
                  iconUrl={company.iconUrl}
                  companyUid={uid}
                />
              </label>
            {/if}
          {/each}
        </div>
      {/if}
      <div
        class="chat-list"
        role="list"
        aria-labelledby="chat-companies-label"
        data-testid="chat-companies-section"
      >
        {#if companySectionRows.length === 0}
          <button
            type="button"
            class="chat-row"
            data-testid="create-or-join-company"
            onclick={() => void oncreatecompany?.()}
          >
            <span class="chat-glyph" aria-hidden="true"><RailIcon name="plus" /></span>
            <span class="chat-row-title">Create or join a company</span>
          </button>
          <p class="chat-companies-empty" data-testid="chat-companies-empty">
            Conversations appear here once you belong to a company.
          </p>
        {:else}
          {#each companySectionRows as company (company.companyUid)}
            {#if company.homeChannelId}
              <button
                type="button"
                class="chat-row chat-companies-row"
                class:active={activeId === `ch:${company.homeChannelId}`}
                data-testid={`chat-companies-row-${company.companyUid}`}
                onclick={() => openCompanyHome(company)}
              >
                <span class="chat-row-title"
                  ><CompanyLabel
                    name={company.label}
                    iconUrl={company.iconUrl}
                    companyUid={company.companyUid}
                  /></span
                >
              </button>
            {:else}
              {@const ensuring = companyHomeEnsuring[company.companyUid] === true}
              {@const failed = companyHomeFailed[company.companyUid] === true}
              <button
                type="button"
                class="chat-row chat-row-disabled chat-companies-row"
                data-testid={`chat-companies-row-disabled-${company.companyUid}`}
                aria-busy={ensuring}
                title={ensuring
                  ? "Setting up…"
                  : failed
                    ? "Tap to retry"
                    : "No company channel yet"}
                onclick={() => openCompanyHome(company)}
              >
                <span class="chat-row-title"
                  ><CompanyLabel
                    name={company.label}
                    iconUrl={company.iconUrl}
                    companyUid={company.companyUid}
                  /></span
                >
                {#if ensuring}
                  <span
                    class="chat-companies-row-status"
                    data-testid={`chat-companies-row-status-${company.companyUid}`}
                    aria-hidden="true"
                  >
                    Setting up…
                  </span>
                {:else if failed}
                  <span
                    class="chat-companies-row-status chat-companies-row-status-muted"
                    data-testid={`chat-companies-row-status-${company.companyUid}`}
                    aria-hidden="true"
                  >
                    Tap to retry
                  </span>
                {/if}
              </button>
            {/if}
          {/each}
        {/if}
      </div>
    {/if}

    {#if activityChannelRows.length > 0}
      <div class="chat-section-label" id="chat-activity-label">
        <span>ACTIVITY</span>
      </div>
      <div
        class="chat-list"
        role="list"
        aria-labelledby="chat-activity-label"
        data-testid="company-activity-channels"
      >
        {#each activityChannelRows as row (row.id)}
          {@render conversationRow(row)}
        {/each}
      </div>
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
      <div
        class="chat-list"
        role={selectionMode ? "listbox" : "list"}
        aria-multiselectable={selectionMode ? true : undefined}
        aria-labelledby="chat-pinned-label"
      >
        {#each grouped.pinned as row (row.id)}
          {@render conversationRow(row)}
        {/each}
      </div>
    {/if}

    {#each grouped.sections as section (section.key)}
      <DayGroupHeader label={section.label} id={`chat-sec-${section.key}`} />
      <div
        class="chat-list"
        role={selectionMode ? "listbox" : "list"}
        aria-multiselectable={selectionMode ? true : undefined}
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
        <div
          class="chat-list"
          role={selectionMode ? "listbox" : "list"}
          aria-multiselectable={selectionMode ? true : undefined}
          aria-label="Last week"
        >
          {#each grouped.lastWeek as row (row.id)}
            {@render conversationRow(row)}
          {/each}
        </div>
      {/if}
    {/if}

    {#if (grouped.noMessages?.length ?? 0) > 0}
      <DayGroupHeader label="No messages yet" id="chat-sec-no-messages" />
      <div
        class="chat-list"
        role={selectionMode ? "listbox" : "list"}
        aria-multiselectable={selectionMode ? true : undefined}
        aria-labelledby="chat-sec-no-messages"
        data-testid="chat-no-messages-section"
      >
        {#each grouped.noMessages ?? [] as row (row.id)}
          {@render conversationRow(row)}
        {/each}
      </div>
    {/if}

    <button
      type="button"
      class="chat-history-affordance"
      data-testid="chat-show-history"
      onclick={openHistory}
    ><RailIcon name="chevron-down" />
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

  {@render bottomContent?.()}

  {#if !hideAccountFooter}
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
  {/if}

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
      <button
        type="button"
        class="chat-popover-row"
        role="menuitem"
        data-testid="chat-context-archive"
        onclick={archiveFromMenu}
      >
        {archivedSet.has(contextMenu.row.id)
          ? "Unarchive conversation"
          : "Archive conversation"}
      </button>
      <button
        type="button"
        class="chat-popover-row"
        role="menuitem"
        data-testid="chat-context-select"
        onclick={selectFromMenu}
      >
        Select conversations
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
            {#if historyQueryProblem === "too-short"}
              <div class="chat-empty" role="status">Type at least 2 characters</div>
            {:else if historyQueryProblem === "too-long"}
              <div class="chat-empty" role="status">Search is limited to 100 characters</div>
            {:else if messageSearchLoading && messageSearchHits.length === 0}
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
            role="combobox"
            aria-expanded="true"
            aria-controls="conversation-search-results"
            aria-autocomplete="list"
            aria-activedescendant={switcherResults.length ? `conversation-search-${activeSearchIndex}` : undefined}
            onkeydown={searchKeydown}
          />
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
              <span class="chat-switcher-company"><CompanyLabel name={row.company} /></span>
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

  {#if messageSheetOpen}
    <!-- Portaled so ⇧⌘K / ⇧⌘N show on pages that hide this sidebar (QA-077). -->
    <div class="sheet-portal" use:portal>
      <LazyDoor
        door={newMessageSheetDoor}
        props={{
          api,
          rows: [...directoryRows, ...browseRows],
          contacts: localBotsAsContacts(contacts, localBots, botDisplayNames),
          companies: scopeCompanies,
          activeCompanyUid: scope !== "all" && scope !== "personal" ? scope : null,
          scopeLabel,
          onclose: () => {
            messageSheetOpen = false;
            plusBtnEl?.focus();
          },
          onopen: (row: ConversationRow) => {
            messageSheetOpen = false;
            plusBtnEl?.focus();
            void openRow(row);
          },
        }}
      />
    </div>
  {/if}

  {#if channelSheetOpen}
    <div class="sheet-portal" use:portal>
      <LazyDoor
        door={newChannelSheetDoor}
        props={{
          api,
          rows: [...directoryRows, ...browseRows],
          contacts: localBotsAsContacts(contacts, localBots, botDisplayNames),
          companies: createScopeCompanies,
          activeCompanyUid: scope !== "all" && scope !== "personal" ? scope : null,
          onclose: closeCreate,
          aftercreate: onChannelCreated,
        }}
      />
    </div>
  {/if}

  {#if createOpen}
    <CreateModal
      {api}
      botCompanyUid={createBotCompanyUid}
      botCompanySlug={createBotCompanySlug}
      rows={[...directoryRows, ...browseRows]}
      contacts={localBotsAsContacts(contacts, localBots, botDisplayNames)}
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
      {oncreatecompany}
      {companyCreate}
      {oncreateagent}
      onnewcloudbot={newBotChoicePossible ? () => openNewBotTakeover({ choose: true }) : null}
      {loadClaudeProviderFlag}
      {loadCloudProvisionOptions}
      {directCloud}
      {agentCompanies}
      {oncreatebot}
      {botRuntimeReady}
      {botRuntimeStatus}
      {onrecheckruntimes}
      {aiTools}
      {hqFolderPath}
      {onopenassistant}
      {onassistedinstall}
      {onrequestaitools}
      {botWorkers}
      {existingBotNames}
      {botCompanies}
      {botSignIn}
      {onbotsignedin}
      initialKind={createKind}
      initialStep={createStep}
      sunrise={createSunrise}
      initialBotHome={createBotHome}
      initialBotName={createSunrise ? newBotName : null}
      onsunriseback={createSunrise ? backToNewBotChoice : null}
      onsunrisecloud={createSunrise && newBotCloudReason === null ? switchLocalToCloud : null}
    />
  {/if}

  {#if newBotOpen}
    <NewBotTakeover
      canCreateLocalBot={!!oncreatebot}
      choose={newBotChoose}
      openCloud={newBotOpenCloud}
      initialName={newBotName}
      cloudReason={newBotCloudReason}
      localReason={newBotLocalReason}
      onchoosecloud={canMakeCloudBotInWindow ? (name) => openBotFlowFromChoice("cloud", name) : null}
      onchooselocal={canMakeLocalBot ? (name) => openBotFlowFromChoice("local", name) : null}
      oncancel={cancelNewBotTakeover}
      onopenlocal={takeoverOtherWayLabel ? openLocalBotFromTakeover : null}
      otherWayLabel={takeoverOtherWayLabel}
      nameCompany={inSeveralCompanies}
      companies={takeoverCompanies}
      currentCompanyUid={newBotPreferredCompanyUid ?? (scopedCompanyUid || null)}
      runtimeReady={botRuntimeReady}
      loadProvisionOptions={loadCloudProvisionOptions}
      {loadClaudeProviderFlag}
      oncreate={oncreatenewbot ? createAgentFromTakeover : null}
      checkingCreate={checkingCreate !== null}
      oncancelcreate={cancelCreateInFlight}
      oncancelbot={removeAgent ? cancelWakingBot : null}
      removals={botRemovals}
      onretryremoval={(id) => void runRemoval(id)}
      ondismissremoval={keepCancelledBot}
      getStatus={loadAgentStatus}
      {retryAgent}
      {restartBrainApproval}
      {submitClaudeLoginCode}
      {openExternal}
      sendHello={sendBotHello}
      checkHello={checkBotHello}
      wakingSession={openWakingBot}
      onwaking={beginWakingBot}
      onwakingchange={updateWakingBot}
      onwakingdone={endWakingBot}
      canRemoveBot={canRemoveBotIn}
      onopenchat={openWakingBotChat}
      onclosewaking={() => { newBotOpen = false; }}
      onupgrade={openUpgradeFromTakeover}
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
{#snippet filterIcon(name: string)}
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
    {#if name === "clock"}<circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" />
    {:else if name === "list"}<path d="M3 4.5h10M3 8h10M3 11.5h10" />
    {:else if name === "home"}<path d="M3 7.5 8 3.5l5 4v5H3z" />
    {:else if name === "hash"}<path d="M6.5 3 5.5 13M10.5 3l-1 10M3.5 6.5h9.5M3 9.5h9.5" />
    {:else if name === "bubble"}<path d="M3 4h10v6.5H7.5L4.5 13v-2.5H3z" />
    {:else if name === "target"}<circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="2" />
    {:else if name === "archive"}<path d="M2.5 4h11v2.5h-11zM3.5 6.5v6h9v-6M6.5 9h3" />
    {:else if name === "check"}<path d="M3.5 8.5l3 3 6-7" />
    {:else if name === "requests"}<circle cx="6.5" cy="5.5" r="2.5" /><path d="M2 13c.6-2.4 2.3-3.5 4.5-3.5s3.9 1.1 4.5 3.5M12.5 5v4M10.5 7h4" />
    {/if}
  </svg>
{/snippet}

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
  {@const showProjectPresence =
    row.kind === "channel" &&
    ((row.channelScope ?? "").trim() === "project" ||
      Boolean((row.projectId ?? "").trim())) &&
    projectHasPresence(row)}
  {@const extras = rowExtras?.(row) ?? null}
  {@const hasChildren = Boolean(extras?.children?.length)}
  {@const childrenOpen = childrenAreOpen(row.id, extras?.childrenExpandedByDefault === true)}
  <div class="chat-row-group" data-testid="chat-row-group">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      role={selectionMode ? "presentation" : "listitem"}
      class="chat-li"
      class:gutter-open={showSelectGutter}
      onmouseenter={(e) => showHoverCard(row, e.currentTarget)}
      onmouseleave={scheduleHoverCardHide}
    >
      <span class="chat-select-gutter" aria-hidden={!showSelectGutter}>
        <input
          type="checkbox"
          class="chat-select-check"
          data-testid="chat-row-checkbox"
          data-checkbox-for={row.id}
          tabindex={showSelectGutter ? 0 : -1}
          checked={selectionMode && selection.selected.includes(row.id)}
          aria-label={`Select ${row.title}`}
          onclick={(e) => toggleRowSelection(row, e)}
        />
      </span>
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
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3 2 7 5 3 8" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      {/if}
      <button
        type="button"
        class="chat-row"
        class:unread={!!row.unreadCount || row.unreadDot}
        class:active={activeId === row.id && !extras?.children?.some((child) => child.selected)}
        class:has-badge={hasBadge}
        data-kind={row.kind}
        data-conversation-id={row.id}
        class:selected={selectionMode && selection.selected.includes(row.id)}
        class:archived={archivedSet.has(row.id)}
        class:muted={row.notifyLevel === "muted"}
        role={selectionMode ? "option" : undefined}
        aria-selected={selectionMode
          ? selection.selected.includes(row.id)
          : undefined}
        onkeydown={selectionKeydown}
        data-selected={selectionMode && selection.selected.includes(row.id)
          ? "true"
          : undefined}
        onclick={(e) => handleRowClick(row, e)}
        oncontextmenu={(e) => openContextMenu(row, e)}
      >
        {#if row.wakingBot}
          <span
            class="chat-waking-ring"
            data-testid="chat-waking-bot-ring"
            style={`--chat-waking-progress: ${row.wakingBot.progress}%`}
            aria-label={`${row.title} is waking up`}
          >
            <span>{initialsFor(row.title)}</span>
          </span>
        {:else if row.kind === "channel"}
            <span class="chat-glyph-wrap" aria-hidden="true">
            {#if !hasChildren && isCompanyScopedRow(row)}
              <CompanyIcon iconUrl={rowCompanyIcon(row)} size={16} />
            {:else if !hasChildren}
              <span class="chat-glyph">#</span>
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
          {@const botPresence = dmPresence(row)}
          <span class="chat-avatar-wrap" aria-hidden="true">
            <span
              class="chat-avatar"
              data-testid="chat-dm-avatar"
              data-avatar={avatar.kind}
              data-bot-presence={botPresence ?? undefined}
            >
              {#if avatar.src}
                <img src={avatar.src} alt="" />
              {:else}
                {avatar.initials}
              {/if}
            </span>
            {#if botPresence}
              <span
                class="chat-presence-dot"
                class:offline={botPresence === "offline"}
                data-testid="chat-bot-presence-dot"
                data-presence={botPresence}
                aria-label={botPresence === "online" ? "Bot online" : "Bot offline"}
              ></span>
            {/if}
          </span>
        {/if}
        {#if draftIdSet.has(row.id)}
          {@render draftMark()}
        {/if}
        <span class="chat-row-copy">
          <span class="chat-row-title">{row.title}</span>
          {#if row.kind === "dm"}
            {@const botKind = botKindFor(row.personUid, localBots, ownedLocalBotUids)}
            {#if botKind}
              <BotKindChip
                kind={botKind}
                runtime={localBotForRow(localBots ?? [], row)?.runtime ?? null}
              />
            {/if}
          {/if}
          {#if archivedSet.has(row.id)}
            <span class="chat-row-archived-pill" data-testid="chat-row-archived-pill">
              Archived
            </span>
          {/if}
          {#if row.removingBot}
            <span class="chat-row-archived-pill" data-testid="chat-row-removing-pill" data-phase={row.removingBot.phase}>
              {row.removingBot.phase === "failed" ? "Not removed" : "Removing"}
            </span>
          {/if}
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
              use:titleWhenTruncated={scopeLabel.text}>{scopeLabel.text}</span
            >
          {/if}
        </span>
        {#if scopeLabel}
          <span
            class="chat-row-reveal"
            data-testid="chat-row-reveal"
            aria-hidden="true"
            use:titleWhenTruncated={scopeLabel.text}>{scopeLabel.text}</span
          >
        {/if}
        {#if row.notifyLevel === "muted"}
          <span
            class="chat-row-muted"
            data-testid="chat-row-muted"
            role="img"
            aria-label="Muted"
            title="Notifications muted"
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
              <path
                d="M5.2 3.6A3.6 3.6 0 0 1 11.6 6v2.6l1.2 2H5.4M3.9 10.6l.5-.9V6.9"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path d="M6.6 12.6a1.5 1.5 0 0 0 2.8 0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              <path d="M2.5 2.5l11 11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </span>
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
                <svg width="12" height="12" viewBox="0 0 10 10">
                  <path d="M5 1v8M1 5h8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                </svg>
              {:else}
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round">
                  <path d="M3 3h10v7H7l-4 3V3Z" />
                </svg>
              {/if}
            </span>
            <span class="chat-row-child-label" use:titleWhenTruncated={child.label}
              >{child.label}</span
            >
            {#if child.meta}
              <span class="chat-row-child-meta" use:titleWhenTruncated={child.meta}
                >{child.meta}</span
              >
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<style>
  /* Hit area (AUDIT-2-10..13): every control here has at least a 28x28 px
     clickable box. The ::after pad grows only the axes under 28 px, so the
     drawn size and layout stay as they are. Kept first so a later
     position rule (e.g. absolute) still wins. */
  .chat-pin-btn { position: relative; }
  .chat-pin-btn::after {
    content: "";
    position: absolute;
    inset: min(0px, calc(50% - 14px));
  }
  .chat-sidebar {
    position: relative;
    /* height:100% must include the padding below, or the sidebar renders ~22px
       taller than .desktop-body and its overflow:hidden clips the account
       footer. There is no global border-box reset, so set it here. */
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    flex: 0 0 var(--sidebar-width, 260px);
    align-self: stretch;
    width: var(--sidebar-width, 260px);
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
    /* Row hover/unread churn stays inside the scroller's paint + layout;
       overlays that must escape it are portaled (see portal.ts). */
    contain: layout paint;
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

  .chat-companies-label {
    justify-content: space-between;
  }

  .chat-companies-edit {
    all: unset;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--ice-ink);
    width: 18px;
    height: 18px;
    border-radius: 6px;
  }
  .chat-companies-edit:hover,
  .chat-companies-edit:focus-visible {
    background: var(--hover);
  }

  .chat-companies-menu {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0 8px 6px;
    padding: 6px;
    border-radius: 8px;
    border: 1px solid var(--line2);
    background: var(--panel);
  }
  .chat-companies-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 6px;
    font-size: 12px;
    color: var(--t1);
    cursor: pointer;
  }
  .chat-companies-menu-item:hover {
    background: var(--hover);
  }

  .chat-companies-menu-hint {
    margin: 0 0 4px;
    padding: 2px 6px;
    color: var(--t2);
    font-size: 11px;
    line-height: 1.3;
  }

  .chat-companies-empty {
    margin: 0;
    padding: 6px 12px 10px;
    color: var(--t2);
    font-size: 12px;
  }

  /* Companies section rows are intentionally minimal — name only, single
   * line, no unread badge/dot/status text (requirement 1). */
  .chat-companies-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
  }
  .chat-companies-row .chat-row-title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chat-row-disabled {
    opacity: 0.55;
    cursor: pointer;
  }

  .chat-row-disabled[aria-busy="true"] {
    cursor: default;
  }

  .chat-companies-row-status {
    margin-left: auto;
    font-size: 11px;
    color: var(--ice-ink, inherit);
    opacity: 0.8;
  }

  /* Quiet heal-path hint after ensure-home-channel exhausts its retries.
     Never red, never the raw server/error text — Corey's product rule is no
     raw red errors and always a heal path. The row stays clickable; a click
     re-runs the ensure attempt. */
  .chat-companies-row-status-muted {
    color: var(--t3, inherit);
    opacity: 0.65;
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
    min-width: 0;
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
    font-size: 12px;
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

  /* Skip style/layout/paint for rows scrolled out of the rail. Safe to
     contain: the row draws no focus outline of its own, `.chat-row-reveal` is
     absolutely positioned INSIDE the row, and the row's menus are portaled to
     the shell so containment cannot clip them. See chat/scroll-perf.css.

     A one-line row is 14px of text plus 6px padding each side, about 32px. */
  .chat-row {
    contain: content;
    content-visibility: auto;
    contain-intrinsic-size: auto 34px;
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
    min-height: 0;
    padding: 7px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    /* One step under the timeline body so the rail reads as navigation, not
       content. Line height is fixed in px so row height is set by padding
       alone (7px + 17px + 7px = 31px). */
    font-size: 13px;
    font-weight: 400;
    line-height: 17px;
    text-align: left;
    cursor: pointer;
  }

  /* Direct child of the column scroller: `.chat-row`'s flex-grow would
     stretch it to fill the empty list and float its label mid-panel. */
  .chat-requests-row {
    flex: 0 0 auto;
    color: var(--t2);
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

  /* Muted channels read quieter; unread still shows as a count. */
  .chat-row.muted .chat-row-title {
    color: var(--t3);
  }

  .chat-row-muted {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    color: var(--t3);
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
    font-size: 11px;
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

  .chat-glyph-wrap {
    position: relative;
    flex: 0 0 16px;
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .chat-glyph {
    flex: 0 0 16px;
    width: 16px;
    color: var(--t3);
    font-size: 16px;
    font-weight: 400;
    text-align: center;
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

  .chat-avatar-wrap {
    position: relative;
    display: inline-grid;
    flex: 0 0 16px;
  }

  .chat-presence-dot.offline {
    background: var(--t3, #8a8a8a);
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

  .chat-waking-ring {
    display: grid;
    flex: 0 0 auto;
    place-items: center;
    width: 21px;
    height: 21px;
    border-radius: 50%;
    background: conic-gradient(#e7a069 var(--chat-waking-progress), var(--bg3) 0);
  }

  .chat-waking-ring > span {
    display: grid;
    place-items: center;
    width: 17px;
    height: 17px;
    border-radius: 50%;
    background: var(--bg1);
    color: var(--t1);
    font-size: 7px;
    font-weight: 600;
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
    /* A count, not an alert: muted text on the row's own background. The
       filled pill read louder than the unread title it sits next to. */
    background: transparent;
    color: var(--t3);
    font-size: 11px;
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
    /* Near-opaque popover tier: without a backdrop blur the translucent
       --panel-bg let the timeline read straight through the menu. */
    background: var(--overlay-bg);
    box-shadow: var(--panel-shadow);
  }

  :global(:root[data-force-theme="dark"]) .chat-popover,
  :global(.dark) .chat-popover {
    background: var(--overlay-bg);
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-force-theme="light"])) .chat-popover {
      background: var(--overlay-bg);
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

  /* Muted marker on an archived row; only visible under "Show archived". */
  .chat-row-archived-pill {
    flex: none;
    margin-left: 2px;
    padding: 1px 5px;
    border-radius: 6px;
    font-size: 10px;
    line-height: 1.3;
    color: var(--v4-text-3, var(--text-3));
    background: var(--hover);
    white-space: nowrap;
  }

  .chat-row.archived .chat-row-title {
    opacity: 0.7;
  }

  /* Selection is a state, not an event — no transition on the toggle.
     Banned: the curved left-edge stroke that used to mark selected rows
     (an inset accent box-shadow on the left edge, curved by the 8px radius).
     Selection is carried by the checkbox in .chat-select-gutter. */
  .chat-row.selected {
    background: var(--hover);
  }

  /* Checkbox gutter. Zero-width until a selection exists or Shift is held, so
     resting rows keep their original geometry and nothing jumps on hover. */
  .chat-select-gutter {
    flex: none;
    display: grid;
    place-items: center;
    width: 0;
    height: 24px;
    overflow: hidden;
    opacity: 0;
    transition:
      width 120ms ease,
      opacity 120ms ease;
  }

  .chat-li.gutter-open .chat-select-gutter {
    width: 22px;
    opacity: 1;
  }

  .chat-li.gutter-open .chat-row-children-toggle {
    left: 30px;
  }

  .chat-select-check {
    appearance: none;
    -webkit-appearance: none;
    flex: none;
    box-sizing: border-box;
    width: 15px;
    height: 15px;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line, var(--t3));
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
  }

  .chat-select-check:checked {
    position: relative;
    border-color: var(--accent, var(--t1));
    background: var(--accent, var(--t1));
  }

  /* The glyph is masked, not painted, so its colour is the accent's contrast
     pair. The popover accent is white in dark mode — a white-stroked check
     would vanish into the fill. */
  .chat-select-check:checked::after {
    content: "";
    position: absolute;
    inset: 0;
    background: var(--popover-primary-text, var(--c-bg, var(--bg, #111113)));
    mask: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 13 13'%3E%3Cpath d='M3 6.7 5.4 9.1 10 4.2' fill='none' stroke='%23000' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
      center / 13px 13px no-repeat;
    -webkit-mask: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 13 13'%3E%3Cpath d='M3 6.7 5.4 9.1 10 4.2' fill='none' stroke='%23000' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
      center / 13px 13px no-repeat;
  }

  .chat-select-check:focus-visible {
    outline: 2px solid var(--accent, var(--t1));
    outline-offset: 1px;
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-select-gutter {
      transition: none;
    }
  }

  .chat-selection-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--line, var(--hover));
  }

  .chat-selection-count {
    flex: 1 1 auto;
    font-size: var(--type-metadata, 13px);
    color: var(--t2, var(--text-2));
    white-space: nowrap;
  }

  .chat-selection-action {
    flex: none;
    padding: 3px 8px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: var(--type-metadata, 13px);
    cursor: pointer;
  }

  .chat-selection-action:hover:not(:disabled) {
    background: var(--hover);
  }

  .chat-selection-action.primary {
    background: var(--hover);
  }

  .chat-selection-action:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .chat-filter-meta {
    flex: none;
    font-size: 11px;
    color: var(--v4-text-3, var(--text-3));
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
    background: var(--overlay-bg);
    box-shadow: var(--panel-shadow);
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
    font-size: 13px;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
  }

  /* + Create menu: header, rows, and footer share the 8px row indent;
     shortcuts sit right-aligned like the scope menu. */
  .chat-create-menu {
    min-width: 240px;
    max-height: none;
  }

  .chat-create-sec {
    padding: 4px 8px 6px;
    color: var(--t2);
    font-size: 13px;
    font-weight: 500;
  }

  .chat-popover-row.chat-create-row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 8px;
  }

  .chat-create-row .chat-scope-shortcut {
    margin-left: auto;
  }

  .chat-create-foot {
    margin: 4px 0 0;
    padding: 6px 8px 2px;
    border-top: 1px solid var(--line, var(--panel-border));
    color: var(--t3);
    font-size: 13px;
    line-height: 17px;
  }

  .chat-scope-sep {
    height: 1px;
    margin: 4px 2px;
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
    color: var(--t2);
    font-size: 13px;
    font-weight: 500;
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
    display: inline-grid;
    place-items: center;
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
    width: 16px;
    color: var(--t2);
    line-height: 1;
  }

  .chat-filter-text {
    flex: 1 1 auto;
    min-width: 0;
  }

  .chat-filter-check {
    display: inline-grid;
    place-items: center;
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
  .sheet-portal {
    display: contents;
  }
</style>
