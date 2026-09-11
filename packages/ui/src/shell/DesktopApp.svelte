<script lang="ts">
  import { parseMeshProjectView, projectViewToBoard } from "@hq/core";
  /**
   * DesktopApp — the windowed V2 shell (design source: hq-sync desktop-alt +
   * its dev-harness ?view=v2 preview).
   *
   * Faithful composition of the ported chrome + the REAL messaging stack into
   * the sidebar-first windowed layout the ?view=v2 preview renders:
   *
   *   V4TitleBar (traffic-light inset · HQ wordmark · DAY·DATE · meetings /
   *   notifications / Core)  →  body: ChatSidebar (channel rail: PINNED /
   *   TODAY / YESTERDAY groups, DMs, account row) + the channel view (channel
   *   header with Chat | Board | Files tabs + "Company · project channel"
   *   subtitle + member count, then the REAL ChannelConversation — agent
   *   RunCompleteCard, reactions, and the "/ to run an agent" composer).
   *
   * ZERO NETWORK in the display layer: the conversation is INJECTED
   * (messagesByRow / reactionsByRow resolvers, synchronous). Hosts feed live
   * overlay data or empty accessors — never a fixture stand-in. packages/ui
   * stays platform-pure: every backend touch flows through the injected
   * adapter + api seams and the ChatWakeBus.
   */
  import { failure, type PlatformAdapter } from "@hq/platform";
  import V4TitleBar from "../home/V4TitleBar.svelte";
  import ChannelSkeleton from "./ChannelSkeleton.svelte";
  import SidebarResizeHandle from "./SidebarResizeHandle.svelte";
  import ChatSidebar from "../chat/ChatSidebar.svelte";
  import type { RowExtrasResolver } from "../chat/row-extras.js";
  import {
    SIDEBAR_OVERLAY_MAX_PX,
    sidebarLayout,
  } from "./sidebar-layout.js";
  import { ImagePreviewCache } from "../chat/messaging/image-preview-cache";
  import { createImagePreviewStore } from "../chat/messaging/image-preview-store";
  import { parseMessageAttachments } from "../chat/messaging/channelMessageModels";
  import ChannelConversation from "../chat/messaging/ChannelConversation.svelte";
  import IdentityMark from "../chat/messaging/IdentityMark.svelte";
  import BotKindChip from "../chat/BotKindChip.svelte";
  import { botKindFor } from "../chat/bot-kind.js";
  import { presenceStatus } from "../chat/presence-store.svelte.js";
  import { authorAvatarUrl } from "../chat/messaging/agent-avatars.js";
  import AgentThinkingRow from "../chat/messaging/AgentThinkingRow.svelte";
  import AgentTaskStrip from "../chat/tasks/AgentTaskStrip.svelte";
  import type { AgentTask } from "../chat/tasks/agent-tasks";
  import {
    TaskFeedController,
    isAgentUid as isAgentTaskUid,
  } from "../chat/tasks/task-feed-controller.svelte";
  import SetupChannelIntro from "../chat/SetupChannelIntro.svelte";
  import SetupRunCard from "../chat/SetupRunCard.svelte";
  import SetupConnectStep from "../chat/SetupConnectStep.svelte";
  import SetupFinale from "../chat/SetupFinale.svelte";
  import { SETUP_FAILURE_COPY } from "../chat/setup-run";
  import type { SetupRunApi } from "../chat/setup-run.js";
  import { SetupAgent, SETUP_AGENT_NAME, SETUP_AGENT_UID } from "../chat/setup-agent.svelte";
  import { createLaunchActions } from "../settings/launch-actions";
  import {
    hasRunWelcomeSetup,
    isSetupChannel,
    markWelcomeSetupRun,
    SETUP_CHANNEL_ID,
    setupCompanies,
    setupCompanyActionLabel,
    setupRosterLoading,
    withoutCompaniesSummaryCards,
    withoutSeededCreateCompanyCards,
  } from "../chat/setup-channel.js";
  import {
    findLifecycleCardElement,
    runAddAgentEntry,
    runCreateCompanyEntry,
    type EntryPointResult,
    type EntryPointTarget,
  } from "../chat/lifecycle-entry-points.js";
  import {
    patchLifecycleCardState,
    submitLifecycleCardAction,
    type CardActionIdempotencyStore,
  } from "../chat/card-action.js";
  import {
    agentComposerPlaceholder,
    isAgentConversationRow,
    provisioningFromMessages,
  } from "../chat/agent-channel.js";
  import {
    CONVERSATION_BOOT_GRACE_MS,
    DEFAULT_SIDEBAR_BOOT_TIMEOUT_MS,
    raceTimeout,
  } from "../chat/boot-timeout.js";
  import AttachmentTray from "../chat/messaging/AttachmentTray.svelte";
  import type {
    FileAttachmentModel,
    LifecycleCardActionEvent,
  } from "../chat/messaging/channelMessageModels.js";
  import ReplyPanel, {
    type ReplyPreview,
  } from "../chat/messaging/ReplyPanel.svelte";
  import ArtifactPanel from "../chat/messaging/ArtifactPanel.svelte";
  import type { ChatArtifact } from "../chat/messaging/artifact-model.js";
  import BoardTab from "../chat/messaging/BoardTab.svelte";
  import ChannelFilesTab from "../chat/messaging/ChannelFilesTab.svelte";
  import CompanyTabs from "../chat/CompanyTabs.svelte";
  import TeamTab from "../chat/tabs/TeamTab.svelte";
  import SettingsTab from "../chat/tabs/SettingsTab.svelte";
  import AtlasTab from "../chat/tabs/AtlasTab.svelte";
  import CompanyHero from "../chat/CompanyHero.svelte";
  import {
    parseCompanyTab,
    type CompanyChannelTabId,
    type CompanyTabActionEvent,
    type CompanyTabModel,
  } from "../chat/tabs/tab-model.js";
  import NotificationsView from "../inbox/NotificationsView.svelte";
  import SharedFilesOverlay from "../inbox/SharedFilesOverlay.svelte";
  import CommandPalette, {
    type CommandPaletteItem,
  } from "../common/CommandPalette.svelte";
  import ShellSettings, {
    type ShellSettingsProfile,
  } from "../settings/ShellSettings.svelte";
  import RecommendedUpdateBanner from "../settings/RecommendedUpdateBanner.svelte";
  import {
    dismissRecommendBanner,
    installRecommendedUpdate,
    orchestrationAdapterFrom,
    updateStore,
    type UpdateStoreAdapter,
  } from "../settings/update-store.svelte";
  import type { AdapterResult } from "../settings/update-orchestration";
  import ChannelStatusPopover from "../chat/ChannelStatusPopover.svelte";
  import ConfirmDialog from "../common/ConfirmDialog.svelte";
  import MigrateSessionDialog from "../common/MigrateSessionDialog.svelte";
  import { canMigrateCompanySession } from "../avatars/can-edit.js";
  import {
    digestMigratePayload,
    migrateDestinationCompanies,
    newMigrateOperationId,
    normalizeMigrateDestination,
  } from "../chat/session-migrate.js";
  import MemberProfilePanel from "../chat/MemberProfilePanel.svelte";
  import AgentDetailPanel from "../chat/AgentDetailPanel.svelte";
  import LocalBotDetailPanel from "../chat/LocalBotDetailPanel.svelte";
  import { avatarBase64FromFile } from "../settings/avatar-image.js";
  import { canEditAgentProfile } from "../avatars/can-edit.js";
  import { loadAvatarGallery } from "../avatars/gallery.js";
  import {
    avatarsFromContactPayload,
    composeAvatarByUid,
    fetchBytesWith,
    saveAgentAvatar,
  } from "../avatars/save-agent-avatar.js";
  import type { AvatarPack, AvatarSelection } from "../avatars/types.js";
  import ProjectAboutDialog from "../chat/ProjectAboutDialog.svelte";
  import MeetingsPage from "../meetings/MeetingsPage.svelte";
  import {
    configureMeetingsApi,
    prefetchMeetings,
    setMeetingsViewActive,
    startMeetingsStore,
  } from "../meetings/meetings-store.svelte";
  import { AtlasPage, createGoChord } from "../atlas/index.js";
  import LibraryOverlay from "../library/LibraryOverlay.svelte";
  import type { PackagesEvents } from "../library/packages-events.js";
  import type { LibraryTab } from "../library/library-overlay-model.js";
  import {
    EMBEDDED_NAVIGATION_EVENT,
    type EmbeddedNavigationTarget,
    type EmbeddedSettingsSection,
  } from "./embedded-navigation.js";
  import {
    createNavigationEntry,
    createNavigationHistory,
    destinationCompanyKey,
    destinationFromEmbeddedTarget,
    destinationLabel,
    extraParamCompanyKey,
    historyNeighbor,
    type NavigationDestination,
    type NavigationEntry,
    type NavigationScrollState,
  } from "./navigation-history.js";
  import {
    captureNavigationScroll,
    scheduleNavigationScrollRestore,
  } from "./navigation-scroll.js";
  import {
    createNavigationController,
    type AppliedNavigation,
    type NavigationMode,
    type NavigationResolveOutcome,
  } from "./navigation-controller.js";
  import { consumeNavigationShortcut } from "./navigation-shortcuts.js";
  import { onDestroy, onMount, untrack, type Component } from "svelte";
  import {
    applyColorTheme,
    applyUiSize,
    applyWindowOpacity,
    readStoredTheme,
  } from "../settings/shell-settings-model.js";
  import { readSettingsPrefs } from "../settings/settings-prefs.js";
  import {
    EMPTY_LIVE_SYNC,
    lastSyncLabelFromLive,
    readLiveSyncStatus,
    syncStateFromLive,
    type LiveSyncStatus,
  } from "../settings/live-sync-status.js";
  import type { SyncState } from "../common/sync-model.js";
  import {
    buildChannelStatusModel,
    type ChannelStatusModel,
    type StatusPersonRow,
  } from "../chat/channel-status-model.js";
  import { liveInputsForCompanyProject } from "../chat/live-read-store.svelte.js";
  import { applyChannelRoster, parseChannelMembers } from "./mesh-overlay.js";
  import {
    loadLiveChannelTabs,
    projectIdForRow,
    projectTabKey,
    rosterStatusForRow,
    type LiveChannelTabs,
  } from "./live-channel-tabs.js";
  import { HQ_CONSOLE_BASE } from "../common/hq-console.js";
  import LinkContextMenu from "../common/LinkContextMenu.svelte";
  import {
    handleLinkActivate,
    type LinkMenuAnchor,
  } from "../common/external-links.js";
  import {
    disambiguateMentionTargets,
    mentionTargetsFromContacts,
    mentionTargetsFromContactsPayload,
    mergeMentionRosters,
    stampMentionCompany,
    type MentionTarget,
  } from "../chat/mentions.js";
  import {
    clearRowFromMessages,
    dropRow,
    isAgentUid,
    newestMessageAtFrom,
    startThinkingIn,
    tickAll,
    type ThinkingByRow,
    type ThinkingEntry,
  } from "../chat/agent-thinking.js";
  import {
    LOCAL_BOTS_POLL_MS,
    localBotForRow,
    localBotOfflineNotice,
    localBotPresence,
    type LocalBotEntryResult,
  } from "../chat/local-bots.js";
  import type { LocalBotCreateInput, LocalBotRow, LocalBotWorkerOption, SessionProviderId } from "@hq/platform";
  import BotProgressCard, { type BotProgressState } from "../chat/create-bot/BotProgressCard.svelte";
  import type { CreateBotExtras } from "../chat/create-bot/CreateBotFlow.svelte";
  import type { CloneCandidate } from "../chat/create-bot/create-bot-model.js";
  import type { RuntimeSignInApi, RuntimeSignInState } from "../chat/create-bot/RuntimeSignIn.svelte";
  import type {
    ChatSidebarApi,
    ChatWakeBus,
    ConversationApi,
    ConversationMessageWire,
    NotificationsApi,
    ReplyThreadScope,
    ReplyThreadResponse,
  } from "../chat/chat-api.js";
  import {
    replyNewMatchesConversation,
    replyScopeForRow,
  } from "../chat/chat-api.js";
  import { REPLY_OVERLAY_MAX_PX } from "../chat/reply-layout.js";
  import {
    activityTimelineMessages,
    collectProjectThreadIds,
    groupActivityBursts,
    mergeActivityIntoTimeline,
    projectActivityEntries,
    type ThreadEventsInput,
  } from "../chat/messaging/projectActivity.js";
  import {
    notificationDestination,
    type NotificationItem,
  } from "../inbox/notifications-model.js";
  import {
    messageScopeForRow,
    reactionsFromPayload,
    mergeReactionMaps,
    setMessageReactions,
    toggleIsAdd,
    toggleReaction,
    type ReactionMap,
  } from "../chat/messaging/reactions.js";
  import type {
    BoardTabData,
    ChannelFileItemModel,
    ChannelFilePreview,
  } from "../chat/messaging/channelTabModels.js";
  import {
    MAX_CHANNEL_FILE_PREVIEW_BYTES,
    fileCompanyScope,
    loadVaultFilePreview,
  } from "../chat/messaging/channel-file-preview.js";
  import {
    attachmentVaultScopeUid,
    chatAttachmentValidatorForPlatform,
    conversationPairKey,
  } from "../chat/messaging/chat-attachments.js";
  import {
    presignUrlFromResult,
    uploadChatAttachments,
    type PutChatAttachment,
  } from "../chat/messaging/upload-chat-attachments.js";
  import {
    isStrictlyRicherConversationRow,
    type ConversationRow,
  } from "../chat/sidebar-model.js";
  import {
    composerPlaceholderFor,
    DIRECT_MESSAGE_PLACEHOLDER,
    GROUP_MESSAGE_PLACEHOLDER,
    isRawParticipantUid,
    resolveConversationRow,
    resolveConversationTitle,
  } from "../chat/conversation-title.js";
  import {
    mergeFetchedTimeline,
    mergeTimelineMessages,
    messagesForDisplay,
    normalizeConversationMessages,
    sentMessageFromResult,
    sinceForChannelWake,
    timelineHasEvent,
    timelinePageFromPayload,
  } from "../chat/live-messages.js";
  import {
    DM_INBOX_SINCE_KEY,
    channelActivityFromTimeline,
    dmActivityFromInboxPage,
    dmActivityFromThreadsPage,
    dmActivityFromTimeline,
    type InboxDmActivity,
    isMissingEndpointFailure,
    mergeDmActivity,
    pairUnreadsFromInboxPage,
    shouldArmDirectorySafety,
    TIMELINE_SAFETY_INTERVAL_MS,
  } from "../chat/live-catchup.js";
  import {
    OPEN_CHANNEL_EVENT,
    OPEN_SETTINGS_EVENT,
    conversationDeepLinkFromLocation,
    conversationRowForDeepLink,
    requestChannelOpen,
    shouldOpenReplyDeepLink,
    takePendingChannelOpen,
    type ConversationDeepLink,
    type PendingChannelOpen,
  } from "../chat/open-target.js";
  import {
    MESSAGE_PERSON_EVENT,
    takePendingConversation,
    type ConversationTarget,
  } from "../chat/pending-conversation.js";
  import type { ChannelDirectoryRow } from "../chat/channel-directory-reconciler.js";
  import {
    mergePaletteRows,
    paletteConversationItems,
  } from "./palette-rows.js";
  import type { Workspace } from "../chat/workspaces.js";
  import {
    buildCompanyDisplayMap,
    buildCompanyIconMap,
    companyDisplayName,
    companyIconUrl,
  } from "../company/company-display-map.js";
  import CompanyIcon from "../company/CompanyIcon.svelte";
  import { formatReadonlyTimestamp } from "../chat/messaging/channelMessageModels.js";
  import {
    accountChromeFromSelf,
    isSelf,
    settingsProfileFromSelf,
    type SelfIdentity,
  } from "../identity/self.js";
  import { createTenantStorage } from "../identity/tenant-storage.js";
  import type { RosterStatus } from "../identity/roster-refresh.js";
  import "../chat/tokens.css";
  import "../chat/chat-tokens.css";
  import "../chat/messaging/messaging-tokens.css";
  import "../home/tokens.css";
  import Caret from "../common/Caret.svelte";

  interface Props {
    /** Platform seam — forwarded to the title-bar Core popover. */
    adapter: PlatformAdapter;
    /** App version, shown in the Core popover. */
    version?: string;
    sidebarApi: ChatSidebarApi;
    notificationsApi: NotificationsApi;
    /**
     * Resolve the (injected) timeline for a row, oldest → newest. Synchronous —
     * the display layer never fetches. Defaults to an empty timeline.
     */
    messagesByRow?: (row: ConversationRow) => ConversationMessageWire[];
    /** Resolve the (injected) reaction aggregates for a row. */
    reactionsByRow?: (row: ConversationRow) => ReactionMap;
    /** Persist a fetched/toggled reaction map into the host cache. */
    onreactionscache?: (row: ConversationRow, reactions: ReactionMap) => void;
    /** Resolve the (injected) Board fixture for a row (columns + stories). */
    boardByRow?: (row: ConversationRow) => BoardTabData | null;
    /** Resolve the (injected) Files fixture rows for a row. */
    filesByRow?: (row: ConversationRow) => ChannelFileItemModel[];
    loadFilePreview?: (item: ChannelFileItemModel) => Promise<ChannelFilePreview>;
    /** Platform seam for opening an external URL (run-card preview/diff). */
    onopenurl?: (url: string) => void;
    /** Bubbled lifecycle-card action (host posts in US-009). */
    oncardaction?: (event: LifecycleCardActionEvent) => void;
    /** Wake events (host bridges MeshClient → bus); null when offline. */
    wakes?: ChatWakeBus | null;
    /** Workspace memberships → sidebar company scopes. */
    companies?: Workspace[] | null;
    /**
     * Where the host is in loading `companies` for this session. #setup
     * hides the seeded "Create a company" card and the create hero copy
     * until the roster has loaded once (`ready` | `failed`). Omitted = ready.
     */
    rosterStatus?: RosterStatus | null;
    /** Re-run the host's roster fetch after `rosterStatus === "failed"`. */
    onretryroster?: () => void;
    /**
     * Verified signed-in principal (host-supplied: web = Cognito session,
     * desktop = its auth source). Drives "you" tagging + admin gating in the
     * shared UI. Null on the unauth / empty path.
     */
    self?: SelfIdentity | null;
    /** Native account partition for renderer persistence and async guards. */
    tenantAccountId?: string | null;
    /** Monotonic native auth-session generation. A new value remounts the host. */
    tenantGeneration?: number;
    /**
     * Optional explicit admin/owner flag from a defensive host probe
     * (`identity.isAdmin()`). When omitted, admin is derived from membership
     * roles; unknown ⇒ not-admin (admin affordances hidden).
     */
    isAdmin?: boolean | null;
    accountLabel?: string | null;
    accountInitials?: string | null;
    /** Seed the titlebar bell before NotificationsView mounts. */
    initialUnreadCount?: number;
    /** Pre-selected conversation so the default view renders a live channel. */
    initialRow?: ConversationRow | null;
    /**
     * Optional `?reply=<rootEventId>` target. Web passes this from the
     * conversation URL; desktop honors the same query on its deep-link.
     */
    initialReplyRootEventId?: string | null;
    /**
     * Host-owned directory (local mesh overlay). Forwarded to the sidebar so
     * the rail paints before the async directory reconciler settles.
     */
    seedDirectory?: ChannelDirectoryRow[] | null;
    /**
     * Rows the ⌘K / sidebar-search overlay typeaheads over (channels + people).
     * Injected from the host overlay — the display layer never fetches.
     */
    searchRows?: ConversationRow[];
    /**
     * Signed-in profile for the Settings destination. Null/omitted paints
     * the "No data" profile pane — never a fixture person.
     */
    settingsProfile?: ShellSettingsProfile | null;
    /**
     * Resolve the (injected) channel status/members model for a row — powers the
     * member-pill popover. Synchronous; null when the row has no status fixture.
     */
    channelStatusByRow?: (row: ConversationRow) => ChannelStatusModel | null;
    /** person/agent uid → display name used to join the channel creator roster. */
    identities?: Readonly<Record<string, string>> | null;
    /** Contacts + agents for @ mention completion. */
    mentionCandidates?: MentionTarget[];
    /**
     * Inject the D-08 designed fixtures into the titlebar Core popover (conflict
     * card / packs / update). MUST stay false on real-data paths.
     */
    coreFixtures?: boolean;
    onsignout?: () => Promise<void> | void;
    onOpenSettings?: () => void;
    /** Open HQ Console externally (Settings → Manage account). */
    onOpenConsole?: (url: string) => Promise<void> | void;
    /**
     * Called once the mounted app can receive embedded host navigation.
     * A returned cleanup detaches the host while lifecycle changes unmount it.
     */
    onembeddednavigationready?: () => void | (() => void);
    /** Optional desktop package-operation stream for Library → Installed. */
    packagesEvents?: PackagesEvents | null;
    /** Native app/Core/CLI update event edge for Settings → Updates. */
    updateWakeSeq?: number;
    /** Read the current native app version during an Updates refresh. */
    refreshAppVersion?: () => Promise<string>;
    /** MeshClient notification wakes — bumps NotificationsView to re-fetch REST. */
    notificationWakeSeq?: number;
    /** Host owns native active-thread registration for realtime reply wakes. */
    onactivethreadchange?: (
      active:
        | {
            rootEventId: string;
            scope: ReplyThreadScope;
            channelId?: string | null;
            withPersonUid?: string | null;
            seenReplyIds: string[];
          }
        | null,
    ) => void;
    /**
     * When true, messagesByRow is first-paint only — the shell still fetches
     * REST for the selected row so mentions, member-added lines, and the
     * latest timeline land even when the machine cache is stale.
     */
    hydrateLiveMessages?: boolean;
    /** Persist the REST timeline into the host's shallow cache. */
    onlivemessages?: (
      row: ConversationRow,
      messages: ConversationMessageWire[],
    ) => void;
    /** Persist the conversation the user just opened (fresh-load restore). */
    onselectrow?: (row: ConversationRow) => void;
    /** Desktop: PUT attachment bytes outside the webview (no S3 CORS). */
    putAttachmentObject?: PutChatAttachment;
    /**
     * Host-owned bounded byte transport for presigned Vault GETs. Desktop
     * supplies a native hop. Web uses the Work app's same-origin proxy because
     * Vault buckets do not grant browser CORS to raw presigned URLs.
     */
    getAttachmentObject?: (url: string, maxBytes?: number) => Promise<Response>;
    /**
     * Bound for first-paint optional fetches (directory, contacts, DM
     * threads). Tests pass a short value so a hung/404 call cannot leave the
     * conversation pane on a skeleton.
     */
    bootTimeoutMs?: number;
    /** First successful conversation/empty paint — host reports `shell_ready`. */
    onShellReady?: () => void;
    /** Host-registered full-column destinations keyed by page id. */
    extraPages?: Record<
      string,
      {
        label: string;
        detail?: string;
        /** Optional host-owned create action in the window header. */
        createAction?: { label: string; param: () => string | null };
        /**
         * Optional host-owned "Run Setup" destination for #welcome: a fresh
         * session whose param carries the setup prompt so the page can send
         * it as soon as the provider is ready. Falls back to `createAction`.
         */
        setupAction?: { label: string; param: () => string | null };
        /**
         * Optional host guided-run API. When present, #welcome's Run Setup
         * runs `/setup` natively inside the hero (stepper + question cards)
         * and only falls back to `setupAction` when the host's preflight says
         * the Sessions page must go first. "Show details" opens the session
         * on this page with its id as the param.
         */
        setupRun?: SetupRunApi;
        /** After setup: a fresh session with `/startwork <company>` as its first turn. */
        startworkAction?: { label: string; param: (company: string | null) => string | null };
        component: Component<{
          param?: string | null;
          restoreScroll?: NavigationScrollState | null;
          onnavigate?: (
            param: string | null,
            options?: { mode?: "push" | "replace" },
          ) => void;
        }>;
      }
    >;
    /** Host decoration for sidebar rows: badge, hover card, and actions. */
    rowExtrasLoading?: boolean;
    rowExtrasError?: boolean;
    rowExtras?: RowExtrasResolver | null;
  }

  let {
    adapter,
    version = "0.0.0",
    sidebarApi,
    notificationsApi,
    messagesByRow,
    reactionsByRow,
    onreactionscache,
    boardByRow,
    filesByRow,
    loadFilePreview,
    onopenurl,
    oncardaction,
    wakes = null,
    companies = null,
    rosterStatus = null,
    onretryroster,
    self = null,
    tenantAccountId = null,
    tenantGeneration = 0,
    isAdmin = null,
    accountLabel = null,
    accountInitials = null,
    initialUnreadCount = 0,
    initialRow = null,
    initialReplyRootEventId = null,
    seedDirectory = null,
    searchRows = [],
    settingsProfile,
    channelStatusByRow,
    identities = null,
    mentionCandidates = [],
    coreFixtures = false,
    onsignout,
    onOpenSettings,
    onOpenConsole,
    onembeddednavigationready,
    packagesEvents = null,
    updateWakeSeq = 0,
    refreshAppVersion,
    notificationWakeSeq = 0,
    onactivethreadchange,
    hydrateLiveMessages = false,
    onlivemessages,
    onselectrow,
    putAttachmentObject,
    getAttachmentObject,
    bootTimeoutMs = DEFAULT_SIDEBAR_BOOT_TIMEOUT_MS,
    onShellReady,
    extraPages,
    rowExtrasLoading = false,
    rowExtrasError = false,
    rowExtras = null,
  }: Props = $props();

  const derivedChrome = $derived(accountChromeFromSelf(self));
  const resolvedAccountLabel = $derived(
    accountLabel?.trim() || derivedChrome?.label || null,
  );
  const resolvedAccountInitials = $derived(
    accountInitials?.trim() || derivedChrome?.initials || null,
  );
  const resolvedSettingsProfile = $derived(
    settingsProfile ?? settingsProfileFromSelf(self) ?? null,
  );
  const hasWindowControls = $derived(
    adapter?.capabilities?.hasWindowControls ?? false,
  );
  const recommendBanner = $derived(updateStore.recommendBanner);
  let recommendInstalling = $state(false);

  function updateOrchAdapter(): UpdateStoreAdapter {
    const updates = adapter.updates;
    return orchestrationAdapterFrom({
      getVersions: () =>
        updates.getVersions() as Promise<AdapterResult<Record<string, unknown>>>,
      checkForUpdates: () =>
        updates.checkForUpdates() as Promise<AdapterResult<unknown>>,
      checkCoreState: () =>
        updates.checkCoreState() as Promise<AdapterResult<unknown>>,
      checkCliUpdate: () =>
        updates.checkCliUpdate() as Promise<AdapterResult<unknown>>,
      downloadUpdate: () =>
        updates.downloadUpdate() as Promise<AdapterResult<unknown>>,
      installDownloadedUpdate: () =>
        updates.installDownloadedUpdate() as Promise<AdapterResult<unknown>>,
      getDownloadedUpdate: () =>
        updates.getDownloadedUpdate() as Promise<AdapterResult<unknown>>,
    });
  }

  async function handleRecommendedUpdateNow(): Promise<void> {
    if (recommendInstalling || !adapter.isAvailable("canSelfUpdate")) return;
    recommendInstalling = true;
    try {
      await installRecommendedUpdate(updateOrchAdapter());
    } finally {
      recommendInstalling = false;
    }
  }

  /**
   * Never ask a browser to fetch a presigned Vault URL directly: Vault has no
   * CORS policy for browser clients. The Work web app owns this authenticated
   * same-origin proxy; desktop uses the bounded Rust byte hop passed by its
   * host.
   */
  async function getVaultBytesForHost(
    url: string,
    maxBytes = MAX_CHANNEL_FILE_PREVIEW_BYTES,
  ): Promise<Response> {
    if (getAttachmentObject) return getAttachmentObject(url, maxBytes);
    if (adapter.kind === "web") {
      return fetch("/api/chat-attachment-bytes", {
        headers: {
          "x-hq-source-url": url,
          "x-hq-max-bytes": String(maxBytes),
        },
      });
    }
    throw new Error("No authorized Vault byte transport is available.");
  }

  type ChannelTab = "chat" | "board" | "files";
  const CHANNEL_TABS: ReadonlyArray<{ id: ChannelTab; label: string }> = [
    { id: "chat", label: "Chat" },
    { id: "board", label: "Board" },
    { id: "files", label: "Files" },
  ];
  const AGENT_CHANNEL_TABS = [
    { id: "chat", label: "Chat" },
    { id: "details", label: "Details" },
  ] as const;
  type AgentChannelTab = (typeof AGENT_CHANNEL_TABS)[number]["id"];

  let view = $state<
    | "conversation"
    | "notifications"
    | "settings"
    | "meetings"
    | "atlas"
    | "library"
    | "shared-files"
    | "extra"
  >("conversation");
  let extraPageId = $state<string | null>(null);
  let extraPageParam = $state<string | null>(null);
  let libraryTab = $state<LibraryTab>("skills");
  let libraryItemId = $state<string | null>(null);
  let settingsSection = $state<EmbeddedSettingsSection | null>(null);
  let meetingFocusRequest = $state<{
    meetingId: string;
    sequence: number;
  } | null>(null);
  let meetingFocusSequence = 0;
  let embeddedNavigationError = $state<string | null>(null);
  let navigationPending = $state(false);
  let navigationUnavailable = $state<{
    destination: NavigationDestination;
    reason: string;
  } | null>(null);
  let navigationCanGoBack = $state(false);
  let navigationCanGoForward = $state(false);
  let navigationBackLabel = $state("");
  let navigationForwardLabel = $state("");
  let pendingRestoreScroll = $state<NavigationScrollState | null>(null);
  let cancelScrollRestore: (() => void) | null = null;
  const DESTINATION_UNAVAILABLE = "This destination is no longer available.";
  let tab = $state<ChannelTab>("chat");
  let channelFileKey = $state<string | null>(null);
  let companyTab = $state<CompanyChannelTabId>("chat");
  let companyTabData = $state<CompanyTabModel | null>(null);
  let companyTabLoading = $state(false);
  let companyWallpaper = $state("aurora");
  /** Company display name from the settings tab appearance, when fetched. */
  let companyAppearanceName = $state<string | null>(null);
  let openReplyRootId = $state<string | null>(null);
  /** Right side pane in ARTIFACT mode. Supersedes thread/profile while open;
   *  closing it falls back to whatever pane was open underneath. */
  let openArtifactView = $state<ChatArtifact | null>(null);
  let attachTray = $state<{
    selectedId: string;
    items: FileAttachmentModel[];
  } | null>(null);
  let replyPreviewByRoot = $state<Record<string, ReplyPreview>>({});
  let replyCountOverride = $state<Record<string, number>>({});
  let narrowViewport = $state(false);
  /**
   * On a phone the channel list is an overlay, so it must start closed —
   * otherwise the first thing the app shows is a list covering the
   * conversation. Resolved synchronously from the initial width so there is no
   * frame where the list is on screen before an effect hides it.
   */
  const startsAsOverlay =
    typeof window !== "undefined" &&
    sidebarLayout(window.innerWidth) === "overlay";
  let phoneViewport = $state(startsAsOverlay);
  let sidebarCollapsed = $state(startsAsOverlay);
  let sidebarWidth = $state((() => {
    try { const saved = Number(localStorage.getItem('hq.sidebar.width')); return saved >= 220 && saved <= 440 ? saved : 260; }
    catch { return 260; }
  })());
  let selectedRow = $state<ConversationRow | null>(initialRow);
  let railRows = $state<ConversationRow[]>([]);

  // ── Personal local bots (local-bots US-009) ────────────────────────────────
  // The host's bots API shells to `hq bot list --json`; rows carry the server's
  // online verdict. Polled while the shell is mounted so the DM rail dot and the
  // thread notice track the bot without any CLI on the user's side.
  let localBots = $state<LocalBotRow[]>([]);
  let localBotBusy = $state<string | null>(null);
  let localBotActionError = $state<string | null>(null);
  async function refreshLocalBots(): Promise<void> {
    const api = adapter.bots;
    if (!api) return;
    const result = await api.list();
    if (result.ok) localBots = result.value.bots ?? [];
  }
  onMount(() => {
    if (!adapter.bots) return;
    void refreshLocalBots();
    const handle = window.setInterval(() => void refreshLocalBots(), LOCAL_BOTS_POLL_MS);
    return () => clearInterval(handle);
  });
  /** Which runtimes are signed in here (`{ claude: true, … }`); null until known. */
  let localBotRuntimeReady = $state<Record<string, boolean> | null>(null);
  /** Company/core workers a bot can be created from; loaded once on demand. */
  let localBotWorkers = $state<LocalBotWorkerOption[] | null>(null);
  async function loadLocalBotRuntimeReady(): Promise<void> {
    const preflight = adapter.sessions?.preflight;
    if (!preflight || localBotRuntimeReady) return;
    const result = await preflight();
    if (!result.ok) return;
    const rec = result.value as Record<string, unknown>;
    const next: Record<string, boolean> = {};
    for (const id of ["claude", "codex", "grok"]) {
      next[id] = rec[`${id}Available`] === true && rec[`${id}LoggedIn`] === true;
    }
    localBotRuntimeReady = next;
  }
  async function loadLocalBotWorkers(): Promise<void> {
    const workers = adapter.bots?.workers;
    if (!workers || localBotWorkers) return;
    const result = await workers();
    if (result.ok) localBotWorkers = result.value.workers ?? [];
  }
  onMount(() => {
    if (!adapter.bots) return;
    void loadLocalBotRuntimeReady();
    void loadLocalBotWorkers();
  });
  /**
   * Sidebar "+" → New bot. The CLI provisions the identity, scaffolds the
   * worker (or binds a company worker), installs the launch agent and starts
   * the bot; we then open its DM. The intro DM may not have landed yet, so a
   * synthetic row makes the thread openable immediately and a progress card
   * (Creating → Installing → Online) covers "starting up" until presence
   * reports online or the bot's first message lands.
   */
  interface BotProgressEntry {
    name: string;
    state: BotProgressState;
    reason: string | null;
    /** The draft that made it, so Retry can re-run the same create. */
    input: LocalBotCreateInput;
    extras: CreateBotExtras;
    startedAt: number;
    retrying: boolean;
  }
  /** Seconds a fresh bot may take to come online before the card calls it failed. */
  const BOT_PROGRESS_TIMEOUT_MS = 180_000;
  let botProgressByUid = $state<Record<string, BotProgressEntry>>({});
  function setBotProgress(uid: string, patch: Partial<BotProgressEntry>): void {
    const current = botProgressByUid[uid];
    if (!current) return;
    botProgressByUid = { ...botProgressByUid, [uid]: { ...current, ...patch } };
  }
  function clearBotProgress(uid: string): void {
    if (!botProgressByUid[uid]) return;
    const next = { ...botProgressByUid };
    delete next[uid];
    botProgressByUid = next;
  }
  async function createBotEntry(input: LocalBotCreateInput, extras: CreateBotExtras = {}): Promise<LocalBotEntryResult> {
    const api = adapter.bots;
    if (!api) return { ok: false, reason: "Bots are only available in the HQ desktop app." };
    const result = await api.create(input);
    if (!result.ok) return { ok: false, reason: result.message || `Could not create ${input.name}.` };
    const value = (result.value ?? {}) as Record<string, unknown>;
    const agentUid = typeof value.agentUid === "string" ? value.agentUid.trim() : "";
    await refreshLocalBots();
    if (!agentUid) return { ok: true, agentUid: "", name: input.name };
    // Identity exists (the CLI returned a uid); the launch agent is installing.
    botProgressByUid = {
      ...botProgressByUid,
      [agentUid]: { name: input.name, state: "installing", reason: null, input, extras, startedAt: Date.now(), retrying: false },
    };
    const existing = railRows.find((r) => r.kind === "dm" && r.personUid === agentUid);
    const row: ConversationRow = existing ?? {
      id: `dm:${agentUid}`,
      kind: "dm",
      title: input.name,
      companyUid: null,
      unreadDot: false,
      lastActivityAt: Date.now(),
      pinned: false,
      personUid: agentUid,
    };
    handleSelect(row);
    if (extras.avatar) void saveNewBotAvatar(agentUid, extras.avatar);
    return { ok: true, agentUid, name: input.name };
  }
  /** Best effort: the avatar picked in the flow, saved once the bot has a uid. */
  async function saveNewBotAvatar(agentUid: string, selection: AvatarSelection): Promise<void> {
    try {
      const packs = loadedAvatarPacks ?? (await loadAvatarGallery(adapter.identity)).packs;
      loadedAvatarPacks = packs;
      const saved = await saveAgentAvatar(agentUid, selection, {
        packs,
        fetchBytes: (url) => fetchBytesWith(fetch, url),
        prepareAvatar: async (bytes) => avatarBase64FromFile(new Blob([bytes as BlobPart])),
        updateAgentProfile: (uid, input) => adapter.identity.updateAgentProfile(uid, input),
        selectAgentAvatar: (uid, input) => adapter.identity.selectAgentAvatar(uid, input),
      });
      avatarOverridesByUid = { ...avatarOverridesByUid, [agentUid]: saved.previewDataUrl };
    } catch {
      /* the bot exists; the avatar can be set from its profile later */
    }
  }
  /** Retry from the progress card: start the bot if it exists, else re-run the same create. */
  async function retryBotProgress(uid: string): Promise<void> {
    const entry = botProgressByUid[uid];
    const api = adapter.bots;
    if (!entry || !api || entry.retrying) return;
    setBotProgress(uid, { retrying: true, reason: null });
    const bot = localBots.find((b) => b.agentUid === uid);
    if (bot) {
      const result = await api.start(bot.name);
      if (!result.ok) {
        setBotProgress(uid, { retrying: false, state: "failed", reason: result.message || `Could not start ${bot.name}.` });
        return;
      }
      setBotProgress(uid, { retrying: false, state: "installing", startedAt: Date.now() });
      await refreshLocalBots();
      return;
    }
    clearBotProgress(uid);
    const created = await createBotEntry(entry.input, entry.extras);
    if (!created.ok) {
      botProgressByUid = { ...botProgressByUid, [uid]: { ...entry, retrying: false, state: "failed", reason: created.reason } };
    }
  }
  // Presence drives the card: online → tick then remove; a failed process →
  // reason + Retry; too long without a heartbeat → failed as well.
  $effect(() => {
    const entries = Object.entries(botProgressByUid);
    if (entries.length === 0) return;
    const now = Date.now();
    for (const [uid, entry] of entries) {
      if (entry.state === "online" || entry.state === "failed") continue;
      const bot = localBots.find((b) => b.agentUid === uid);
      if (bot?.online === true) {
        setBotProgress(uid, { state: "online" });
        window.setTimeout(() => clearBotProgress(uid), 1500);
      } else if (bot?.state === "failed") {
        setBotProgress(uid, { state: "failed", reason: localBotOfflineNotice(bot) });
      } else if (now - entry.startedAt > BOT_PROGRESS_TIMEOUT_MS) {
        setBotProgress(uid, { state: "failed", reason: `${entry.name} did not come online. Check that its tool is signed in, then retry.` });
      }
    }
  });
  // The bot's first message replaces the card.
  $effect(() => {
    const uid = selectedRow?.kind === "dm" ? (selectedRow.personUid ?? "").trim() : "";
    if (!uid || !botProgressByUid[uid]) return;
    if (timeline.some((m) => m.fromPersonUid === uid)) clearBotProgress(uid);
  });
  const selectedBotProgress = $derived(
    selectedRow?.kind === "dm" && selectedRow.personUid ? (botProgressByUid[selectedRow.personUid] ?? null) : null,
  );
  /** Bots the new-bot flow can clone: Cloud bots the rail knows, plus this Mac's own. */
  const cloneCandidates = $derived.by<CloneCandidate[]>(() => {
    const out: CloneCandidate[] = [];
    const seen = new Set<string>();
    for (const bot of localBots) {
      const uid = bot.agentUid.trim();
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      out.push({ uid, displayName: bot.name, avatarUrl: avatarByUid[uid] ?? null, kind: "local" });
    }
    for (const row of railRows) {
      const uid = (row.personUid ?? "").trim();
      if (row.kind !== "dm" || !uid || seen.has(uid) || !isAgentUid(uid)) continue;
      seen.add(uid);
      out.push({ uid, displayName: row.title, avatarUrl: avatarByUid[uid] ?? null, kind: "cloud" });
    }
    return out;
  });
  const existingBotNames = $derived(localBots.map((b) => b.name));
  /** Inline runtime sign-in for the flow's Home step (browser login + status poll). */
  const botSignIn = $derived.by<RuntimeSignInApi | null>(() => {
    const sessions = adapter.sessions;
    if (!sessions?.loginStart || !sessions.loginStatus) return null;
    const toState = (result: { ok: true; value: unknown } | { ok: false; message?: string }): RuntimeSignInState => {
      if (!result.ok) return { state: "error", message: result.message || "Could not reach the sign-in." };
      const rec = (result.value ?? {}) as { state?: string; message?: string };
      const state = rec.state === "waiting" || rec.state === "connected" || rec.state === "error" ? rec.state : "disconnected";
      return { state, message: rec.message };
    };
    return {
      loginStart: async (runtime) => toState(await sessions.loginStart!(runtime as SessionProviderId)),
      loginStatus: async (runtime) => toState(await sessions.loginStatus!(runtime as SessionProviderId)),
      loginCancel: sessions.loginCancel
        ? async (runtime) => toState(await sessions.loginCancel!(runtime as SessionProviderId))
        : undefined,
    };
  });
  async function onBotRuntimeSignedIn(): Promise<void> {
    localBotRuntimeReady = null;
    await loadLocalBotRuntimeReady();
  }
  const selectedLocalBot = $derived(localBotForRow(localBots, selectedRow));
  const selectedLocalBotOffline = $derived(
    Boolean(selectedLocalBot && selectedLocalBot.online !== true),
  );
  async function startSelectedLocalBot(): Promise<void> {
    const bot = selectedLocalBot;
    const api = adapter.bots;
    if (!bot || !api || localBotBusy) return;
    localBotBusy = bot.name;
    localBotActionError = null;
    const result = await api.start(bot.name);
    if (!result.ok) localBotActionError = result.message || `Could not start ${bot.name}.`;
    await refreshLocalBots();
    localBotBusy = null;
  }
  let directorySettled = $state(false);
  let conversationBootTimedOut = $state(false);
  $effect(() => {
    if (selectedRow) {
      conversationBootTimedOut = false;
      return;
    }
    const handle = setTimeout(() => {
      conversationBootTimedOut = true;
      console.info("[hq-desktop]", {
        t: Date.now(),
        event: "conversation-boot-timeout",
      });
    }, bootTimeoutMs + CONVERSATION_BOOT_GRACE_MS);
    return () => clearTimeout(handle);
  });
  $effect(() => {
    const next = initialRow;
    if (!next) return;
    untrack(() => {
      if (
        !selectedRow ||
        isStrictlyRicherConversationRow(next, selectedRow)
      ) {
        selectedRow = next;
      }
    });
  });

  $effect(() => {
    const selected = selectedRow;
    const rows = railRows;
    if (!selected) return;
    const rail = resolveConversationRow(selected, rows);
    if (!rail || rail.id !== selected.id) return;
    const currentTitle = untrack(() => selected.title);
    if (rail.title === currentTitle) return;
    if (
      !isRawParticipantUid(currentTitle) &&
      currentTitle !== DIRECT_MESSAGE_PLACEHOLDER &&
      currentTitle !== GROUP_MESSAGE_PLACEHOLDER
    ) {
      return;
    }
    selectedRow = rail;
  });
  let pendingReplyRootId = $state<string | null>(
    initialReplyRootEventId?.trim() || null,
  );
  let pendingReplyForRowId = $state<string | null>(null);
  let replyApplyInFlight = $state<string | null>(null);
  let lastReplyRowId = $state<string | null>(null);
  let unreadCount = $state(initialUnreadCount);
  let liveSync = $state<LiveSyncStatus>({ ...EMPTY_LIVE_SYNC });
  let meshConnectionState = $state<string>("idle");
  let tenantCompanyId = $state<string | null>(null);
  const tenantStorage = $derived(
    createTenantStorage(
      typeof window !== "undefined" ? window.localStorage : null,
      { accountId: tenantAccountId, companyId: tenantCompanyId ?? "all" },
    ),
  );
  const liveSyncState = $derived<SyncState>(syncStateFromLive(liveSync));
  const lastSyncLabel = $derived(lastSyncLabelFromLive(liveSync));
  /** ⌘K / sidebar-search overlay (fixture typeahead, zero-network). */
  let paletteOpen = $state(false);
  let linkMenu = $state<LinkMenuAnchor | null>(null);
  /** Channel-header member pill → status/members popover. */
  let membersOpen = $state(false);
  /** Channel-header info control → project description dialog. */
  let projectAboutOpen = $state(false);

  /**
   * Command-palette items: NAVIGATE actions (Notifications, Settings) plus one
   * CONVERSATION row per indexed conversation — the live rail rows unioned with
   * the host's cached search rows, ranked by match then recency in the palette.
   * Selecting a conversation opens it in the shell.
   */
  const isWeb = $derived(adapter.kind === "web");

  /** Company uid → NAME so palette details never render a `cmp_…` uid. */
  const paletteCompanies = $derived(
    (companies ?? [])
      .filter((w) => (w.cloudUid ?? "").trim())
      .map((w) => ({
        companyUid: (w.cloudUid as string).trim(),
        label: w.displayName?.trim() || w.slug,
        iconUrl: w.iconUrl ?? null,
      })),
  );

  /**
   * The palette indexes the LIVE rail rows unioned with the host's cached
   * `searchRows`. Indexing only the cache let the persisted rail drop a channel
   * the sidebar was still showing (and vice versa) — a conversation could be in
   * one surface and missing from the other.
   */
  const paletteRows = $derived(mergePaletteRows(railRows, searchRows));

  const paletteCommands = $derived.by((): CommandPaletteItem[] => {
    const nav: CommandPaletteItem[] = [
      {
        id: "command-go-notifications",
        label: "Notifications",
        detail: "Open the notifications feed",
        action: () => {
          void navigate({ kind: "notifications" });
        },
      },
      {
        id: "command-go-meetings",
        label: "Meetings",
        detail: "Open the meetings agenda",
        action: () => {
          void navigate({ kind: "meetings" });
        },
      },
      {
        id: "command-go-atlas",
        label: "Atlas",
        detail: "People and bots on projects, live",
        shortcut: "g a",
        action: () => {
          void navigate({ kind: "atlas" });
        },
      },
    ];
    nav.push({
      id: "command-go-library",
      label: "Library",
      detail: "Open skills available to you",
      action: () => openLibrary("skills"),
    });
    nav.push({
      id: "command-go-settings",
      label: "Settings",
      detail: "Open settings",
      action: () => openSettings(),
    });
    for (const [id, page] of Object.entries(extraPages ?? {})) {
      nav.push({
        id: `command-go-${id}`,
        label: page.label,
        detail: page.detail ?? page.label,
        action: () => openExtraPage(id),
      });
    }
    if (!isWeb) {
      nav.push({
        id: "command-go-marketplace",
        label: "Marketplace",
        detail: "Open marketplace in the library",
        action: () => openLibrary("marketplace"),
      });
    }
    // Human labels only. `paletteConversationItems` resolves the channel
    // display name / person name / project title for the primary line and the
    // company name + kind for the secondary line — the old mapping rendered
    // `row.companyUid`, i.e. a raw `cmp_…` uid, as the detail. Raw ids move to
    // `keywords` so they stay searchable without being shown.
    const conversations: CommandPaletteItem[] = paletteConversationItems(
      paletteRows,
      { companies: paletteCompanies },
    ).map((item) => ({
      id: item.id,
      label: item.label,
      detail: item.detail,
      keywords: item.keywords,
      lastActivityAt: item.lastActivityAt,
      // Company channels carry their company's mark so a palette full of
      // `#`-prefixed labels is scannable by company at a glance.
      iconUrl: item.iconUrl,
      showCompanyMark:
        item.row.kind === "channel" &&
        (item.row.channelScope ?? "").trim() === "company",
      action: () => handleSelect(item.row),
    }));
    return [...nav, ...conversations];
  });

  const watched = $derived(companies?.length ?? 0);
  const companyNames = $derived(buildCompanyDisplayMap(companies ?? []));
  /** uid/slug → presigned company icon, for the header + member popover. */
  const companyIcons = $derived(buildCompanyIconMap(companies ?? []));
  /**
   * Icon for the selected conversation's company: the row's server-stamped
   * icon first, then the roster. Company channels only — a project or personal
   * channel header keeps its `#`.
   */
  const selectedCompanyIcon = $derived.by(() => {
    const row = selectedRow;
    if (!row || row.kind !== "channel") return null;
    if ((row.channelScope ?? "").trim() !== "company") return null;
    return row.iconUrl ?? companyIconUrl(row.companyUid, companyIcons);
  });
  const selectedIsCompanyChannel = $derived(
    selectedRow?.kind === "channel" &&
      (selectedRow.channelScope ?? "").trim() === "company",
  );

  /** Company for Atlas — selected conversation company, else first cloud workspace. */
  const atlasCompanyUid = $derived.by(() => {
    const fromRow = (selectedRow?.companyUid ?? "").trim();
    if (fromRow) return fromRow;
    for (const company of companies ?? []) {
      const uid = (company.cloudUid ?? "").trim();
      if (uid) return uid;
    }
    return "";
  });
  const atlasCompanyLabel = $derived(
    companyDisplayName(atlasCompanyUid, companyNames) ||
      companies?.find((c) => c.cloudUid === atlasCompanyUid)?.displayName ||
      null,
  );

  /** "Indigo · project channel" style subtitle under the channel name. */
  const channelSubtitle = $derived.by(() => {
    const row = selectedRow;
    if (!row) return null;
    if (row.kind === "dm") return "Direct message";
    if (row.kind === "group") return "Group message";
    const scope = row.channelScope ?? "channel";
    const kindLabel =
      scope === "project"
        ? "project channel"
        : scope === "company"
          ? "company channel"
          : scope === "personal"
            ? "personal channel"
            : "channel";
    const name = companyDisplayName(row.companyUid, companyNames);
    return name ? `${name} · ${kindLabel}` : kindLabel;
  });

  /**
   * Chat | Board | Files is a project-channel affordance only. Non-project
   * channels, DMs, and groups render no tab strip (spec ChannelView.svelte
   * `{#if isProject}`) and always show the chat body.
   */
  const isProjectChannel = $derived(
    selectedRow?.kind === "channel" &&
      ((selectedRow?.channelScope ?? "channel") === "project" ||
        Boolean(projectIdForRow(selectedRow))),
  );
  let agentSurface = $state<AgentChannelTab>("chat");
  let liveTimeline = $state<ConversationMessageWire[]>([]);
  let liveTimelineId = $state<string | null>(null);
  const provisioning = $derived(provisioningFromMessages(liveTimeline));
  const isAgentChannel = $derived(
    isAgentConversationRow(selectedRow) ||
      (!!selectedRow?.channelId &&
        !isSetupChannel(selectedRow.channelId) &&
        selectedRow.kind === "channel" &&
        provisioning.state !== null),
  );
  const isCompanyChannel = $derived(
    selectedRow?.kind === "channel" &&
      (selectedRow?.channelScope ?? "channel") === "company" &&
      !isSetupChannel(selectedRow.channelId) &&
      !isAgentChannel,
  );
  const activeTab = $derived(isProjectChannel ? tab : "chat");

  const headerTitle = $derived(resolveConversationTitle(selectedRow, railRows));

  /**
   * Company hero shows the company's display name ("Ramen Bae"), not the
   * channel slug ("ramen-bae") — the channel header keeps `#ramen-bae`.
   */
  const companyHeroTitle = $derived(
    companyAppearanceName ||
      companyDisplayName(selectedRow?.companyUid, companyNames) ||
      headerTitle,
  );

  /** Real ChannelView composer placeholder (verbatim from the desktop source). */
  /**
   * The Setup Agent: the guided `/setup` run as a conversation in #welcome.
   * Its turns stream into the channel timeline as messages, the composer
   * replies to it while it is listening, and the prompt under the messages
   * carries choices / cards / the finish buttons. The hero shows its stepper.
   */
  // Starting is not finishing: a relaunch mid-run must still land on
  // #welcome, so only the finish graduates welcome-first boot.
  const setupAgent = new SetupAgent(extraPages?.sessions?.setupRun ?? null, {
    onfinished: recordWelcomeSetupRun,
  });
  $effect(() => () => setupAgent.dispose());
  const inSetupChannelWithAgent = $derived(
    Boolean(selectedRow && isSetupChannel(selectedRow.channelId) && setupAgent.active),
  );
  /** First-seen wall clock per session: synthetic turns need stable, ordered timestamps. */
  const setupAgentClock = new Map<string, number>();
  const setupAgentWires = $derived.by((): ConversationMessageWire[] => {
    const sessionId = setupAgent.sessionId;
    if (!setupAgent.active || !sessionId) return [];
    let base = setupAgentClock.get(sessionId);
    if (base === undefined) {
      base = Date.now();
      setupAgentClock.set(sessionId, base);
    }
    const start = base;
    return setupAgent.transcript.map((turn) => ({
      eventId: turn.id,
      fromPersonUid: turn.role === "agent" ? SETUP_AGENT_UID : (self?.uid ?? null),
      fromDisplayName: turn.role === "agent" ? SETUP_AGENT_NAME : (self?.displayName ?? "You"),
      body: turn.text,
      createdAt: new Date(start + turn.seq * 1000).toISOString(),
      direction: turn.role === "agent" ? "in" : "out",
      replyCount: 0,
    }));
  });
  /** Between the person's turns the agent shows as "thinking", like any other agent. */
  let setupThinkingSince = 0;
  const setupThinking = $derived.by((): ThinkingEntry | null => {
    if (!inSetupChannelWithAgent) return null;
    // Starting a run (or quietly retrying a passing clash) is thinking too:
    // the person clicked and must see the agent at work, not a blank beat.
    if (setupAgent.mode === "starting" || setupAgent.retrying) {
      if (!setupThinkingSince) setupThinkingSince = Date.now();
      return { agentUid: SETUP_AGENT_UID, agentName: SETUP_AGENT_NAME, startedAt: setupThinkingSince, phase: "thinking" };
    }
    if (setupAgent.mode !== "live") {
      setupThinkingSince = 0;
      return null;
    }
    const state = setupAgent.state;
    const phase = setupAgent.snapshot?.phase;
    // Thinking is only while the engine is actually working on a turn — not
    // while it waits for the person, and not once it has finished or stopped.
    // The reported phase can lag or be missed; the event stream is the tiebreak.
    const working = phase === "working" || phase === "starting" || (phase !== "needsYou" && phase !== "ended" && state?.inFlight);
    if (!state || state.done || state.ended || state.question || !working) {
      setupThinkingSince = 0;
      return null;
    }
    if (!setupThinkingSince) setupThinkingSince = Date.now();
    return { agentUid: SETUP_AGENT_UID, agentName: SETUP_AGENT_NAME, startedAt: setupThinkingSince, phase: "thinking" };
  });
  let setupLaunchError = $state<string | null>(null);
  /** The company `/startwork` orients on after setup: the first company in the roster. */
  const startworkCompany = $derived(setupCompanies(companies).find((c) => c.kind === "company")?.slug ?? null);
  const startworkPrompt = $derived(startworkCompany ? `/startwork ${startworkCompany}` : "/startwork");
  /** The finish buttons: open the HQ folder in a coding tool with `/startwork` ready to go. */
  async function launchSetupIn(key: "claude" | "codex"): Promise<void> {
    setupLaunchError = null;
    const res = await adapter.settings.getSetupStatus();
    const folder = res.ok ? ((res.value as { hqFolderPath?: string } | null)?.hqFolderPath?.trim() ?? "") : "";
    if (!folder) {
      setupLaunchError = "HQ folder is not ready yet.";
      return;
    }
    const actions = createLaunchActions({ shell: adapter.shell, hqFolderPath: folder, prompt: startworkPrompt });
    const error = key === "claude" ? await actions.launchClaude() : await actions.launchCodex();
    if (error) setupLaunchError = error;
  }
  /** The run has finished (marker or the person's own "I'm all set"): the finale replaces the prompt. */
  const setupAgentDone = $derived(
    inSetupChannelWithAgent && (setupAgent.mode === "done" || Boolean(setupAgent.state?.done)),
  );
  /** Once setup is done the composer rests; the finale carries every next step. */
  const composerDisabled = $derived(setupAgentDone);
  const SETUP_DONE_PLACEHOLDER = "Setup is complete — pick a next step above.";
  const composerPlaceholder = $derived(
    setupAgentDone
      ? SETUP_DONE_PLACEHOLDER
      : inSetupChannelWithAgent && setupAgent.listening
      ? setupAgent.state?.question?.kind === "choice"
        ? "Type your answer…"
        : "Reply to Setup bot…"
      : isAgentChannel && provisioning.state === "pending"
        ? agentComposerPlaceholder(provisioning.agentName || headerTitle)
        : composerPlaceholderFor(selectedRow, headerTitle),
  );
  const composerLocked = $derived(
    composerDisabled || (isAgentChannel && provisioning.state === "pending"),
  );
  const agentChannelUid = $derived(
    selectedRow?.members?.find((m) => m.personUid.startsWith("agt_"))
      ?.personUid ??
      provisioning.agentUid ??
      null,
  );

  $effect(() => {
    selectedRow?.id;
    companyTabData = null;
    companyWallpaper = "aurora";
    companyAppearanceName = null;
  });

  /** Threads fetched per project channel — bounded so a long-lived project
   *  cannot fan out into hundreds of event requests on channel open. */
  const PROJECT_ACTIVITY_THREAD_CAP = 25;
  let timelineHydrating = $state(false);
  const timelineCache = new Map<string, ConversationMessageWire[]>();
  /** Last rail activity stamp emitted from a committed DM timeline, per peer. */
  const lastDmTimelineStampByUid = new Map<string, string>();
  /** Last rail activity stamp emitted from a committed channel timeline. */
  const lastChannelTimelineStampById = new Map<string, string>();
  /**
   * GET /v1/notify/dm-threads answered 404 for this tenant — the server
   * predates the peer index. Stop asking; the inbox path still runs.
   */
  let dmThreadsUnsupported = false;

  // Client-side "agent is thinking" rows, keyed by conversation row id.
  // Local only — the backend has no typing/ack events. Per-conversation so
  // a row switch neither shows another conversation's status nor forgets
  // this one's: the indicator survives navigating away and back and clears
  // on the signal that ends it (a NEWER message from that agent in that
  // row, a failed send there, or the hard expiry) — never a row switch.
  const AGENT_THINKING_TICK_MS = 5_000;
  let thinkingByRow = $state<ThinkingByRow>({});
  const agentThinking = $derived<ThinkingEntry[]>(
    selectedRow ? (thinkingByRow[selectedRow.id] ?? []) : [],
  );

  // Background-task chips for the agents in the selected conversation — the
  // room-scoped route for a channel (every agent on its roster), the
  // agent-wide view for a DM with an agent. One controller per selection;
  // rebuilt when the roster arrives, disposed on switch/teardown. Nothing is
  // polled when the host exposes neither task view or there is no agent.
  let taskCtl = $state<TaskFeedController | null>(null);
  $effect(() => {
    const row = selectedRow;
    const channelId = row?.channelId?.trim() || null;
    const roster = channelId ? (channelRosterById[channelId] ?? []) : [];
    const peer = row?.personUid?.trim() || null;
    const agentUids = channelId
      ? roster.map((m) => m.personUid)
      : peer && isAgentTaskUid(peer)
        ? [peer]
        : [];
    const roomFetch = adapter.messaging.listChannelAgentTasks;
    const agentFetch = adapter.messaging.listAgentTasks;
    const ctl = new TaskFeedController({
      agentUids,
      channelId,
      fetchRoomTasks: roomFetch
        ? async (agentUid, ch) => unwrapAdapter(await roomFetch(agentUid, ch))
        : null,
      fetchTasks: agentFetch ? async (agentUid) => unwrapAdapter(await agentFetch(agentUid)) : null,
    });
    taskCtl = ctl;
    return () => {
      ctl.dispose();
      if (taskCtl === ctl) taskCtl = null;
    };
  });
  // Rooms: chips live in the thread they were spawned from (ReplyPanel),
  // never in the main pane — a room-wide strip mixes every thread's work.
  // DMs have no threads-of-origin on the agent-wide view, so they keep the
  // strip beneath the conversation.
  const mainPaneTasks = $derived<AgentTask[]>(
    selectedRow?.channelId ? [] : (taskCtl?.tasks ?? []),
  );
  const threadTasks = $derived<AgentTask[]>(
    openReplyRootId
      ? (taskCtl?.tasks ?? []).filter((t) => t.originMessageId === openReplyRootId)
      : [],
  );

  onMount(() => {
    const handle = window.setInterval(() => {
      thinkingByRow = tickAll(thinkingByRow, Date.now());
    }, AGENT_THINKING_TICK_MS);
    return () => clearInterval(handle);
  });

  /** Clear a conversation's thinking rows when those agents appear in a
   *  freshly fetched page for THAT conversation (recent messages only — not
   *  the full merged timeline, or historical agent posts would immediately
   *  kill a new mention's indicator). Background wakes for a conversation
   *  that is not open pass a one-message page built from the wake. */
  function clearThinkingFromIncoming(
    messages: ReadonlyArray<{
      fromPersonUid?: string | null;
      createdAt?: string | null;
    }>,
    rowId: string,
  ): void {
    if (!thinkingByRow[rowId]?.length) return;
    // Timestamp-aware so a full-history hydrate or overlapping catch-up page
    // containing an OLD agent message cannot clear a newer row.
    thinkingByRow = clearRowFromMessages(thinkingByRow, rowId, messages);
  }

  function commitTimeline(
    row: ConversationRow,
    next: ConversationMessageWire[],
  ): void {
    liveTimeline = next;
    liveTimelineId = row.id;
    timelineCache.set(row.id, next);
    onlivemessages?.(row, next);
    if (row.kind === "dm" && row.personUid) {
      const entry = dmActivityFromTimeline(row.personUid, next);
      if (entry) {
        const prev = lastDmTimelineStampByUid.get(entry.personUid);
        if (!prev || entry.lastMessageAt > prev) {
          lastDmTimelineStampByUid.set(entry.personUid, entry.lastMessageAt);
          wakes?.emit?.("dm:pair-unreads", { activity: [entry] });
        }
      }
      return;
    }
    const channelId = row.channelId?.trim() ?? "";
    if (!channelId) return;
    const entry = channelActivityFromTimeline(channelId, next);
    if (!entry) return;
    const prev = lastChannelTimelineStampById.get(entry.channelId);
    if (prev && entry.lastMessageAt <= prev) return;
    lastChannelTimelineStampById.set(entry.channelId, entry.lastMessageAt);
    wakes?.emit?.("channel:new-message", {
      channelId: entry.channelId,
      createdAt: entry.lastMessageAt,
      ...(entry.fromPersonUid ? { fromPersonUid: entry.fromPersonUid } : {}),
      ...(entry.eventId ? { eventId: entry.eventId } : {}),
    });
  }

  async function fetchTimelineRaw(
    row: ConversationRow,
    since?: string,
  ): Promise<unknown | null> {
    const started = performance.now();
    console.info("[hq-desktop]", {
      t: Date.now(),
      event: "timeline-fetch-start",
      id: row.id,
      since: since ?? null,
    });
    try {
      if (row.kind === "dm" && row.personUid) {
        const res = await adapter.messaging.fetchDmThread({
          withPersonUid: row.personUid,
          limit: since ? 20 : 50,
          since,
        });
        console.info("[hq-desktop]", {
          t: Date.now(),
          event: "timeline-fetch-done",
          id: row.id,
          ok: res.ok,
          ms: Math.round(performance.now() - started),
        });
        return res.ok ? res.value : null;
      }
      if (row.channelId) {
        const res = await adapter.messaging.fetchChannel({
          channelId: row.channelId,
          limit: since ? 20 : 50,
          since,
        });
        console.info("[hq-desktop]", {
          t: Date.now(),
          event: "timeline-fetch-done",
          id: row.id,
          ok: res.ok,
          ms: Math.round(performance.now() - started),
        });
        return res.ok ? res.value : null;
      }
      return null;
    } catch (err) {
      console.warn("[hq-desktop]", {
        t: Date.now(),
        event: "timeline-fetch-error",
        id: row.id,
        ms: Math.round(performance.now() - started),
        err: String(err),
      });
      throw err;
    }
  }

  let historyCursors = $state<Record<string, string | null>>({});

  async function loadEarlierTimeline(): Promise<void> {
    const row = selectedRow;
    if (!row) return;
    const generation = tenantGeneration;
    const cursor = historyCursors[row.id];
    if (!cursor) return;
    const raw = row.channelId
      ? unwrapAdapter(await adapter.messaging.fetchChannel({ channelId: row.channelId, cursor, limit: 50 }))
      : null;
    if (selectedRow?.id !== row.id || tenantGeneration !== generation || raw === null) return;
    const page = timelinePageFromPayload(raw);
    historyCursors[row.id] = page.nextCursor === cursor ? null : (page.nextCursor ?? null);
    commitTimeline(row, mergeFetchedTimeline(liveTimeline, raw));
  }

  async function applyFetchedTimeline(
    row: ConversationRow,
    raw: unknown | null,
    pendingCardId?: string,
  ): Promise<void> {
    // Apply whenever this row is still selected. Do not require matching
    // timelineSeq — MQTT catch-up / a re-run of the hydrate effect used to
    // bump seq and drop the first successful fetch, leaving a hard-refresh
    // on the opening conversation empty until the user clicked away and back.
    if (selectedRow?.id !== row.id) return;
    timelineHydrating = false;
    if (raw == null) return;
    historyCursors[row.id] = row.channelId ? (timelinePageFromPayload(raw).nextCursor ?? null) : null;
    let incoming = messagesForDisplay(raw);
    // An immediate readback can lag the accepted mutation. Preserve its
    // pending receipt over a stale open card, but accept any newer state.
    if (pendingCardId && incoming.some((message) => {
      const envelope = message.systemEvent;
      return !!envelope && typeof envelope === "object" &&
        "type" in envelope && envelope.type === "lifecycle_card" &&
        "cardId" in envelope && envelope.cardId === pendingCardId &&
        "state" in envelope && envelope.state === "open";
    })) {
      incoming = patchLifecycleCardState(incoming, pendingCardId, { state: "pending", reason: null });
    }
    commitTimeline(row, incoming);
    clearThinkingFromIncoming(incoming, row.id);
  }

  async function catchUpTimeline(row: ConversationRow): Promise<void> {
    const existing =
      liveTimelineId === row.id
        ? liveTimeline
        : (timelineCache.get(row.id) ?? []);
    const since = sinceForChannelWake(existing);
    const raw = await fetchTimelineRaw(row, since);
    if (selectedRow?.id !== row.id) return;
    if (raw == null) return;
    const incoming = messagesForDisplay(raw);
    // History may have loaded while this refresh was in flight. Merge into
    // the current timeline so its newly prepended page is not discarded.
    const current = liveTimelineId === row.id
      ? liveTimeline
      : (timelineCache.get(row.id) ?? []);
    commitTimeline(row, mergeFetchedTimeline(current, raw));
    clearThinkingFromIncoming(incoming, row.id);
  }

  $effect(() => {
    const row = selectedRow;
    const hydrate = hydrateLiveMessages;
    if (!row) {
      liveTimeline = [];
      liveTimelineId = null;
      timelineHydrating = false;
      return;
    }
    void row.id;
    void row.channelId;
    void row.personUid;
    void hydrate;
    const injected = untrack(() => messagesByRow?.(row) ?? []);
    if (injected.length > 0 && !hydrate) {
      liveTimeline = [];
      liveTimelineId = null;
      return;
    }
    // Do not mount the cached thread inside the click flush — a 20-bubble
    // remount on Deacon froze the next hop. Clear now, paint on the next frame.
    // Keep hydrating=true so "No messages yet" does not flash (US-018).
    liveTimeline = [];
    liveTimelineId = row.id;
    const cached = untrack(() => timelineCache.get(row.id) ?? []);
    timelineHydrating = true;
    const token = row.id;
    const frame = requestAnimationFrame(() => {
      if (selectedRow?.id !== token) return;
      if (cached.length > 0) {
        liveTimeline = cached;
        timelineHydrating = false;
        void catchUpTimeline(row);
        return;
      }
      void fetchTimelineRaw(row)
        .then((raw) => applyFetchedTimeline(row, raw))
        .finally(() => {
          if (selectedRow?.id === token) timelineHydrating = false;
        });
    });
    return () => cancelAnimationFrame(frame);
  });

  const timeline = $derived.by(() => {
    if (!selectedRow) return [];
    const injected = messagesByRow?.(selectedRow) ?? [];
    const rows =
      liveTimelineId === selectedRow.id
        ? liveTimeline
        : injected.length > 0
          ? injected
          : [];
    if (Object.keys(replyCountOverride).length === 0) return rows;
    return rows.map((msg) =>
      replyCountOverride[msg.eventId] != null
        ? { ...msg, replyCount: replyCountOverride[msg.eventId] }
        : msg,
    );
  });
  // ── Project-channel work-mesh activity ───────────────────────────────────
  //
  // A project channel's real trail lives in work-mesh threads, not in the chat
  // table, so the channel used to render empty while a project had a live claim
  // and a progress log. Fetch that trail for the selected project channel and
  // fold it into the same timeline. Best-effort by design: any failure leaves
  // chat-only rendering exactly as before.
  let projectActivityRows = $state<ConversationMessageWire[]>([]);
  let projectActivityKey = $state("");
  let projectActivityLoading = $state(false);

  function activityKeyForRow(row: ConversationRow | null): string {
    if (!row) return "";
    const projectId = (row.projectId ?? "").trim() || projectIdForRow(row) || "";
    const companyUid = (row.companyUid ?? "").trim();
    return projectId && companyUid ? `${companyUid}/${projectId}` : "";
  }

  /** Roster-backed actor names so rows never show a raw `prs_…`. */
  function resolveActivityActor(actorUid: string): string | null {
    const uid = actorUid.trim();
    if (!uid) return null;
    const named = displayNameByUid[uid];
    if (named?.trim()) return named.trim();
    const roster = channelRosterById[selectedRow?.channelId?.trim() ?? ""] ?? [];
    const hit = roster.find((m) => m.personUid === uid);
    return hit?.displayName?.trim() || null;
  }

  async function loadProjectActivity(row: ConversationRow): Promise<void> {
    const key = activityKeyForRow(row);
    if (!key) {
      projectActivityRows = [];
      projectActivityKey = "";
      return;
    }
    const [companyUid, projectId] = key.split("/");
    const api = adapter.workMesh;
    if (!api?.listProjectThreads || !api?.listThreadEvents) return;
    projectActivityLoading = true;
    try {
      // The server-side `projectId` filter is additive and may not be deployed
      // yet, so collectProjectThreadIds filters client-side and pages while a
      // cursor comes back. Once the filter is live, page one has no cursor.
      const threadIds = await collectProjectThreadIds(
        projectId,
        async (cursor) => {
          const res = await api.listProjectThreads!(
            projectId,
            companyUid,
            cursor,
          );
          if (!res.ok) return null;
          const payload = res.value as {
            threads?: unknown;
            nextCursor?: unknown;
          } | null;
          return {
            threads: Array.isArray(payload?.threads) ? payload.threads : [],
            nextCursor:
              typeof payload?.nextCursor === "string" ? payload.nextCursor : null,
          };
        },
        PROJECT_ACTIVITY_THREAD_CAP,
      );
      const pages = await Promise.all(
        threadIds.map(async (threadId): Promise<ThreadEventsInput> => {
          try {
            const res = await api.listThreadEvents!(threadId, companyUid);
            const body = res.ok
              ? (res.value as { events?: unknown } | null)
              : null;
            return {
              threadId,
              events: Array.isArray(body?.events) ? body.events : [],
            };
          } catch {
            return { threadId, events: [] };
          }
        }),
      );
      if (activityKeyForRow(selectedRow) !== key) return;
      const entries = groupActivityBursts(
        projectActivityEntries(pages, { resolveActor: resolveActivityActor }),
      );
      projectActivityRows = activityTimelineMessages(entries);
      projectActivityKey = key;
    } catch (err) {
      console.warn("[hq-desktop]", {
        t: Date.now(),
        event: "project-activity-error",
        key,
        err: String(err),
      });
    } finally {
      if (activityKeyForRow(selectedRow) === key) projectActivityLoading = false;
    }
  }

  $effect(() => {
    const row = selectedRow;
    const key = activityKeyForRow(row);
    if (!row || !key) {
      projectActivityRows = [];
      projectActivityKey = "";
      projectActivityLoading = false;
      return;
    }
    if (projectActivityKey === key) return;
    projectActivityRows = [];
    void loadProjectActivity(row);
  });

  // Diagnostic: what the setup channel is showing and why. Logged only when
  // the picture changes, so the log is not spammed on every timeline poll.
  let lastSetupStateLog = "";
  $effect(() => {
    const hqLog = (globalThis as { __hqLog?: (tag: string, message: string) => void }).__hqLog;
    if (!hqLog || !selectedRow || !isSetupChannel(selectedRow.channelId)) return;
    const snapshot = JSON.stringify({
        selected: selectedRow?.channelId ?? null,
        isSetup: selectedRow ? isSetupChannel(selectedRow.channelId) : null,
        companies: (companies ?? []).map((c) => `${c.kind}:${c.slug}:${c.state}`),
        rosterCompanies: rosterCompanies.map((c) => c.slug),
        rosterStatus: rosterStatus ?? null,
        hasRosterCompany,
        createCompanyRequested,
        timeline: timeline.length,
        shown: timelineWithActivity.length,
        kinds: timeline.map((m) => {
          const ev = (m as { systemEvent?: { type?: string; kind?: string } }).systemEvent;
          return ev ? `${ev.type}/${ev.kind}` : "msg";
        }),
      });
    if (snapshot === lastSetupStateLog) return;
    lastSetupStateLog = snapshot;
    hqLog("setup-state", snapshot);
  });

  /** Chat + work-mesh activity, oldest → newest — what the channel renders. */
  const timelineWithActivity = $derived.by(() => {
    const merged =
      projectActivityRows.length > 0
        ? mergeActivityIntoTimeline(timeline, projectActivityRows)
        : timeline;
    if (!selectedRow || !isSetupChannel(selectedRow.channelId)) return merged;
    // #welcome must not lead with "Create a company" for an account whose
    // roster already holds one (created on the website / another machine).
    const welcome = withoutCompaniesSummaryCards(
      withoutSeededCreateCompanyCards(merged, {
        hasCompany: hasRosterCompany,
        createRequested: createCompanyRequested,
        rosterLoading: setupRosterLoading(companies, rosterStatus),
      }),
    );
    // The Setup Agent's turns are local to this Mac: they render in the
    // channel but are never posted to it.
    return setupAgentWires.length > 0 ? [...welcome, ...setupAgentWires] : welcome;
  });

  /**
   * A project channel with no chat AND no work-mesh events is empty of
   * ACTIVITY, not of messages — the label has to say so.
   */
  const conversationEmptyLabel = $derived(
    isProjectChannel ? "No activity yet" : "No messages yet",
  );

  const messageScope = $derived(messageScopeForRow(selectedRow));
  let liveReactions = $state<ReactionMap>({});
  let reactionScope = $state("");
  const rowReactions = $derived<ReactionMap>(
    mergeReactionMaps(
      selectedRow ? (reactionsByRow?.(selectedRow) ?? {}) : {},
      liveReactions,
    ),
  );
  let liveTabs = $state<LiveChannelTabs | null>(null);
  let liveTabsKey = $state("");
  const overlayBoard = $derived<BoardTabData | null>(
    selectedRow ? (boardByRow?.(selectedRow) ?? null) : null,
  );
  const overlayFiles = $derived<ChannelFileItemModel[]>(
    selectedRow ? (filesByRow?.(selectedRow) ?? []) : [],
  );
  const boardHasCards = $derived(
    Boolean(overlayBoard?.columns.some((column) => column.cards.length > 0)),
  );
  let createdTasks = $state<Record<string, BoardTabData>>({});
  $effect(() => {
    self?.uid;
    createdTasks = {};
  });
  $effect(() => {
    const key = selectedRow ? activityKeyForRow(selectedRow) : "";
    const pending = createdTasks[key];
    const base = boardHasCards ? overlayBoard : liveTabs?.board;
    if (!pending || !base) return;
    const remaining = Object.fromEntries(Object.entries(pending.stories).filter(([id]) => !base.stories[id]));
    if (Object.keys(remaining).length === Object.keys(pending.stories).length) return;
    const next = {...createdTasks};
    if (!Object.keys(remaining).length) delete next[key];
    else next[key] = {...pending, stories: remaining, columns: pending.columns.map(column => ({...column, cards: column.cards.filter(card => remaining[card.storyId])}))};
    createdTasks = next;
  });
  const board = $derived.by((): BoardTabData | null => {
    const base = boardHasCards ? overlayBoard : (liveTabs?.board ?? overlayBoard);
    const added = selectedRow ? createdTasks[activityKeyForRow(selectedRow)] : null;
    if (!added) return base;
    if (!base) return added;
    return { ...base, stories: {...added.stories, ...base.stories}, columns: base.columns.map(column => ({
      ...column, cards: [...column.cards, ...(added.columns.find(c => c.id === column.id)?.cards ?? []).filter(card => !base.stories[card.storyId])],
    })) };
  });

  async function createBoardTask(task: {id: string; title: string; description: string; status: string}): Promise<void> {
    const row = selectedRow;
    const companyUid = row?.companyUid?.trim();
    const projectId = row ? projectIdForRow(row) : null;
    const create = adapter.workMesh.createProjectStory;
    if (!row || !companyUid || !projectId || !create) throw new Error("Project unavailable");
    const key = activityKeyForRow(row);
    const account = self?.uid;
    // A retry after a lost response must not append the same task twice.
    const before = parseMeshProjectView(unwrapAdapter(await adapter.workMesh.getProjectView(projectId, companyUid)));
    if (!before || before.companyUid !== companyUid || before.projectId !== projectId) throw new Error("Project unavailable");
    const existing = before.stories.find(story => story.id === task.id);
    if (existing && existing.title !== task.title) throw new Error("Task ID already exists");
    if (!existing) unwrapAdapter(await create(projectId, companyUid, {...task, passes: task.status === "done"}));
    const saved = parseMeshProjectView(unwrapAdapter(await adapter.workMesh.getProjectView(projectId, companyUid)));
    const story = saved?.stories.find(story => story.id === task.id);
    if (!saved || saved.companyUid !== companyUid || saved.projectId !== projectId || !story) throw new Error("Task not confirmed");
    if (self?.uid !== account) return;
    const prior = createdTasks[key];
    const added = projectViewToBoard({...saved, stories: [story]});
    createdTasks = {...createdTasks, [key]: prior ? {
      ...added, stories: {...prior.stories, ...added.stories},
      columns: added.columns.map(column => ({...column, cards: [...(prior.columns.find(c => c.id === column.id)?.cards ?? []).filter(card => card.storyId !== story.id), ...column.cards]})),
    } : added};
  }
  const files = $derived<ChannelFileItemModel[]>(
    overlayFiles.length > 0 ? overlayFiles : (liveTabs?.files ?? []),
  );
  let channelRosterById = $state<
    Record<string, ReturnType<typeof parseChannelMembers>>
  >({});
  let contactAvatarByUid = $state<Record<string, string>>({});
  let avatarOverridesByUid = $state<Record<string, string>>({});
  let rosterWakeSeq = $state(0);
  let agentAvatarSaving = $state(false);
  let agentAvatarSaveError = $state<string | null>(null);
  let loadedAvatarPacks = $state<AvatarPack[] | null>(null);

  async function loadChannelRoster(channelId: string): Promise<void> {
    const id = channelId.trim();
    if (!id.startsWith("chn_")) return;
    const res = await adapter.messaging.listChannelMembers(id);
    if (!res.ok) return;
    channelRosterById = {
      ...channelRosterById,
      [id]: parseChannelMembers(res.value),
    };
  }

  // ── Member profile / agent detail (Slack-style right panel) ───────────────
  let openProfileMember = $state<StatusPersonRow | null>(null);
  let openAgentMember = $state<StatusPersonRow | null>(null);
  /** Local bot behind an open profile / Details surface; routes to LocalBotDetailPanel. */
  const openLocalBot = $derived.by(() => {
    const uid = openAgentMember?.personUid;
    return uid ? (localBots.find((b) => b.agentUid === uid) ?? null) : null;
  });
  const agentChannelLocalBot = $derived(
    agentChannelUid
      ? (localBots.find((b) => b.agentUid === agentChannelUid) ?? null)
      : null,
  );
  let removingMemberUid = $state<string | null>(null);
  /**
   * Owner-only "Delete channel" (members popover → trash). The shell owns the
   * confirm + the call: the popover closes on outside mousedown and would eat
   * a dialog it rendered itself.
   */
  let deleteChannelConfirmOpen = $state(false);
  let deletingChannel = $state(false);
  /**
   * Company owner/admin "Move to another company" (US-017B). Shell owns the
   * destination picker + confirm — same outside-mousedown reason as delete.
   */
  let migrateSessionTarget = $state<{
    sessionId: string;
    sourceCompanyUid: string;
  } | null>(null);
  let migratingSessionId = $state<string | null>(null);
  let migrateSessionError = $state<string | null>(null);
  /** Last channel-level action failure — rendered under the header, never console-only. */
  let channelActionError = $state<string | null>(null);

  // A new selection starts clean — a stale delete error must not follow the
  // user into the next conversation.
  $effect(() => {
    void selectedRow?.id;
    channelActionError = null;
  });
  let selfAvatarUrl = $state<string | null>(null);
  let selfDescription = $state<string | null>(null);

  /** personUid → presigned avatar URL, sourced from every loaded channel
   *  roster, the contacts list, the signed-in user's own profile, and any
   *  just-saved override. Feeds chat/thread/panel photos — including agent
   *  DMs whose photo arrived on a channel roster or contacts. */
  const avatarByUid = $derived(
    composeAvatarByUid({
      rosters: Object.values(channelRosterById).flat(),
      contacts: contactAvatarByUid,
      selfUid: self?.uid,
      selfAvatarUrl,
      overrides: avatarOverridesByUid,
    }),
  );

  const canEditOpenAgent = $derived(
    canEditAgentProfile({
      agentUid: openProfileMember?.personUid,
      agentCompanyUid: selectedRow?.companyUid,
      companies,
      isAdmin,
    }),
  );

  const canEditSelectedAgent = $derived(
    selectedRow?.kind === "dm" &&
      canEditAgentProfile({
        agentUid: selectedRow.personUid,
        agentCompanyUid: selectedRow.companyUid,
        companies,
        isAdmin,
      }),
  );

  const canMigrateSelectedChannelSessions = $derived(
    canMigrateCompanySession({
      companyUid: selectedRow?.companyUid,
      companies,
    }),
  );
  const migrateDestinationsForSelected = $derived(
    migrateDestinationCompanies(
      companies,
      selectedRow?.companyUid?.trim() ?? "",
    ),
  );
  const canMigrateAtlasSessions = $derived(
    canMigrateCompanySession({
      companyUid: atlasCompanyUid,
      companies,
    }),
  );
  const migrateDestinationsForAtlas = $derived(
    migrateDestinationCompanies(companies, atlasCompanyUid),
  );

  /** personUid → live display name from the channel roster (the profile
   *  display-name override), so chat/thread show the current name instead of
   *  the full name baked into each message at send time. */
  const displayNameByUid = $derived.by(() => {
    const map: Record<string, string> = {};
    const roster =
      channelRosterById[selectedRow?.channelId?.trim() ?? ""] ?? [];
    for (const m of roster) {
      const name = m.displayName?.trim();
      if (name && m.personUid) map[m.personUid] = name;
    }
    return map;
  });

  const profilePanelAvatarUrl = $derived(
    openProfileMember && isSelf(openProfileMember.personUid, self)
      ? selfAvatarUrl
      : (openProfileMember?.avatarUrl ?? null),
  );

  function openMemberProfile(row: StatusPersonRow): void {
    // One right panel at a time — a profile/agent pane supersedes a reply.
    openReplyRootId = null;
    openArtifactView = null;
    if (isAgentUid(row.personUid)) {
      openProfileMember = null;
      openAgentMember = row;
    } else {
      openAgentMember = null;
      openProfileMember = row;
    }
    if (tab !== "chat") tab = "chat";
  }

  function closeMemberProfile(): void {
    openProfileMember = null;
    agentAvatarSaveError = null;
  }

  function openAgentProfileFromHeader(): void {
    const uid = selectedRow?.personUid?.trim();
    if (!uid) return;
    openMemberProfile({
      personUid: uid,
      displayName: headerTitle,
      email: selectedRow?.email?.trim() || null,
      avatarUrl: avatarByUid[uid] ?? null,
      description: null,
      role: "agent",
      statusIcon: "idle",
      online:
        presenceStatus(selectedRow?.companyUid ?? "", uid) === "online",
    });
  }

  async function loadAvatarPacks(): Promise<AvatarPack[]> {
    const loaded = await loadAvatarGallery(adapter.identity);
    loadedAvatarPacks = loaded.packs;
    return loaded.packs;
  }

  async function refreshAvatarsAfterSave(): Promise<void> {
    const ids = Object.keys(channelRosterById);
    await Promise.all(ids.map((id) => loadChannelRoster(id)));
    try {
      const contactsRes = await adapter.messaging.listContacts();
      if (contactsRes.ok) {
        contactAvatarByUid = {
          ...contactAvatarByUid,
          ...avatarsFromContactPayload(contactsRes.value),
        };
      }
    } catch {
      /* keep the optimistic override */
    }
    rosterWakeSeq += 1;
  }

  async function saveOpenAgentAvatar(selection: AvatarSelection): Promise<void> {
    const uid =
      openAgentMember?.personUid?.trim() ||
      openProfileMember?.personUid?.trim();
    if (!uid || agentAvatarSaving) return;
    agentAvatarSaving = true;
    agentAvatarSaveError = null;
    try {
      const packs =
        loadedAvatarPacks ??
        (await loadAvatarGallery(adapter.identity)).packs;
      loadedAvatarPacks = packs;
      const saved = await saveAgentAvatar(uid, selection, {
        packs,
        fetchBytes: (url) => fetchBytesWith(fetch, url),
        prepareAvatar: async (bytes) =>
          avatarBase64FromFile(new Blob([bytes as BlobPart])),
        updateAgentProfile: (agentUid, input) =>
          adapter.identity.updateAgentProfile(agentUid, input),
        selectAgentAvatar: (agentUid, input) =>
          adapter.identity.selectAgentAvatar(agentUid, input),
      });
      avatarOverridesByUid = {
        ...avatarOverridesByUid,
        [uid]: saved.previewDataUrl,
      };
      if (openAgentMember) {
        openAgentMember = {
          ...openAgentMember,
          avatarUrl: saved.previewDataUrl,
        };
      }
      if (openProfileMember) {
        openProfileMember = {
          ...openProfileMember,
          avatarUrl: saved.previewDataUrl,
        };
      }
      await refreshAvatarsAfterSave();
    } catch (err) {
      agentAvatarSaveError =
        err instanceof Error ? err.message : "Could not save the avatar.";
    } finally {
      agentAvatarSaving = false;
    }
  }

  function closeAgentDetail(): void {
    openAgentMember = null;
  }

  function openAgentFromHeader(): void {
    const uid = selectedRow?.personUid?.trim() ?? "";
    if (!uid || !isAgentUid(uid) || selectedRow?.kind !== "dm") return;
    openMemberProfile({
      personUid: uid,
      displayName: headerTitle,
      email: selectedRow.email ?? null,
      avatarUrl: avatarByUid[uid] ?? null,
      description: null,
      role: "agent",
      statusIcon: "idle",
      online:
        presenceStatus(selectedRow.companyUid ?? "", uid) === "online",
    });
  }

  /** Resolve a message author against the live roster to enrich email/role. */
  function openProfileForAuthor(author: {
    personUid: string;
    displayName: string;
  }): void {
    const uid = author.personUid?.trim();
    if (!uid) return;
    const roster =
      channelRosterById[selectedRow?.channelId?.trim() ?? ""] ?? [];
    const match = roster.find((m) => m.personUid === uid);
    const mine = isSelf(uid, self);
    openMemberProfile({
      personUid: uid,
      displayName:
        match?.displayName?.trim() || author.displayName?.trim() || uid,
      email: match?.email?.trim() || null,
      avatarUrl: match?.avatarUrl?.trim() || (mine ? selfAvatarUrl : null),
      description:
        match?.description?.trim() || (mine ? selfDescription : null),
      role: match?.role?.trim() || null,
      statusIcon: "idle",
      online:
        presenceStatus(selectedRow?.companyUid ?? "", uid) === "online",
    });
  }

  async function removeMember(row: StatusPersonRow): Promise<void> {
    const channelId = selectedRow?.channelId?.trim() ?? "";
    if (!channelId.startsWith("chn_") || removingMemberUid) return;
    removingMemberUid = row.personUid;
    try {
      const res = await adapter.messaging.removeChannelMember(
        channelId,
        row.personUid,
      );
      if (res.ok) {
        await loadChannelRoster(channelId);
        if (openProfileMember?.personUid === row.personUid) {
          openProfileMember = null;
        }
        if (openAgentMember?.personUid === row.personUid) {
          openAgentMember = null;
        }
      }
    } finally {
      removingMemberUid = null;
    }
  }

  function openMigrateSession(sessionId: string, sourceCompanyUid: string): void {
    const sid = sessionId.trim();
    const source = sourceCompanyUid.trim();
    if (!sid || !source) return;
    const destinations = migrateDestinationCompanies(companies, source);
    if (destinations.length === 0) {
      channelActionError =
        "No other company is available to move this session into.";
      return;
    }
    if (
      !canMigrateCompanySession({
        companyUid: source,
        companies,
      })
    ) {
      return;
    }
    membersOpen = false;
    migrateSessionError = null;
    migrateSessionTarget = { sessionId: sid, sourceCompanyUid: source };
  }

  async function confirmMigrateSession(
    destinationCompanyUid: string,
  ): Promise<void> {
    const target = migrateSessionTarget;
    const sessionId = target?.sessionId?.trim() ?? "";
    const sourceCompanyUid = target?.sourceCompanyUid?.trim() ?? "";
    const dest = destinationCompanyUid.trim();
    if (!sessionId || !sourceCompanyUid || !dest || migratingSessionId) return;
    if (sourceCompanyUid === dest) return;
    if (
      !canMigrateCompanySession({
        companyUid: sourceCompanyUid,
        companies,
      })
    ) {
      return;
    }
    migratingSessionId = sessionId;
    migrateSessionError = null;
    channelActionError = null;
    try {
      const destination = normalizeMigrateDestination({});
      const expectedVersion = 0;
      const operationId = newMigrateOperationId();
      const digest = await digestMigratePayload({
        sessionId,
        sourceCompanyUid,
        destinationCompanyUid: dest,
        destination,
        expectedVersion,
      });
      const res = await adapter.workMesh.migrateSession(sessionId, {
        operationId,
        digest,
        sourceCompanyUid,
        destinationCompanyUid: dest,
        destination,
        expectedVersion,
      });
      if (!res.ok) {
        migrateSessionError =
          res.message?.trim() || "Couldn't move the session to that company.";
        return;
      }
      migrateSessionTarget = null;
    } catch (err) {
      migrateSessionError = err instanceof Error ? err.message : String(err);
    } finally {
      migratingSessionId = null;
    }
  }

  async function deleteSelectedChannel(): Promise<void> {
    const row = selectedRow;
    const channelId = row?.channelId?.trim() ?? "";
    deleteChannelConfirmOpen = false;
    if (!row || !channelId.startsWith("chn_") || deletingChannel) return;
    deletingChannel = true;
    channelActionError = null;
    try {
      const res = await adapter.messaging.deleteChannel(channelId);
      if (!res.ok) {
        channelActionError =
          res.message?.trim() || `Couldn't delete #${row.title}.`;
        return;
      }
      // Optimistic: drop the rail row now. The server fans out a directory
      // feed change so every other member's rail follows.
      wakes?.emit?.("channel:removed", { channelId });
      timelineCache.delete(row.id);
      // Clear the selection the way changeTenantCompany does so the pane
      // falls back to its empty state instead of a dead conversation.
      membersOpen = false;
      projectAboutOpen = false;
      selectedRow = null;
      liveTimeline = [];
      liveTimelineId = null;
      timelineHydrating = false;
      openReplyRootId = null;
      openProfileMember = null;
      attachTray = null;
      replyPreviewByRoot = {};
    } catch (err) {
      channelActionError = err instanceof Error ? err.message : String(err);
    } finally {
      deletingChannel = false;
    }
  }

  // Load the signed-in avatar once so the profile panel can show a real photo.
  $effect(() => {
    const getProfile = adapter?.identity?.getProfile;
    if (typeof getProfile !== "function") return;
    let cancelled = false;
    void getProfile.call(adapter.identity).then((res) => {
      if (cancelled || !res.ok) return;
      const url = res.value?.profile?.avatarUrl;
      if (typeof url === "string" && url) selfAvatarUrl = url;
      const desc = res.value?.profile?.description;
      if (typeof desc === "string" && desc.trim())
        selfDescription = desc.trim();
    });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const channelId = selectedRow?.channelId?.trim() ?? "";
    if (!channelId.startsWith("chn_")) return;
    let cancelled = false;
    void adapter.messaging.listChannelMembers(channelId).then((res) => {
      if (cancelled || !res.ok) return;
      channelRosterById = {
        ...channelRosterById,
        [channelId]: parseChannelMembers(res.value),
      };
    });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (!membersOpen) return;
    const channelId = selectedRow?.channelId?.trim() ?? "";
    if (!channelId.startsWith("chn_")) return;
    void loadChannelRoster(channelId);
  });

  $effect(() => {
    const row = selectedRow;
    if (!row || !isProjectChannel) {
      liveTabs = null;
      liveTabsKey = "";
      return;
    }
    const key = projectTabKey(row);
    const projectId = projectIdForRow(row);
    const companyUid =
      (row.companyUid ?? "").trim() ||
      (companies ?? []).find((c) => c.cloudUid?.trim())?.cloudUid?.trim() ||
      "";
    if (liveTabsKey && liveTabsKey !== key) {
      liveTabs = null;
      liveTabsKey = "";
    }
    if (!projectId || !companyUid) return;
    if (boardHasCards && overlayFiles.length > 0) return;
    if (liveTabsKey === key && liveTabs) return;
    let cancelled = false;
    void loadLiveChannelTabs({
      row,
      members: channelRosterById[row.channelId?.trim() ?? ""] ?? [],
      companyLabel: companyDisplayName(companyUid, companyNames),
      companyUidFallback: companyUid,
      getProjectView: async (id, company) => {
        try {
          const api = adapter.workMesh;
          if (!api?.getProjectView) return null;
          const res = await api.getProjectView(id, company);
          return res.ok ? res.value : null;
        } catch {
          return null;
        }
      },
      listVaultPrefix: async (company, prefix) => {
        try {
          const api = adapter.files;
          if (!api?.listVaultPrefix) return null;
          const res = await api.listVaultPrefix(company, prefix);
          return res.ok ? res.value : null;
        } catch {
          return null;
        }
      },
      getVaultText: async (company, keyPath) => {
        try {
          const api = adapter.files;
          if (!api?.presignVaultGet) return null;
          const signed = await api.presignVaultGet(company, keyPath);
          if (!signed.ok) return null;
          const url = presignUrlFromResult(signed.value)?.url;
          if (!url) return null;
          const res = await getVaultBytesForHost(
            url,
            MAX_CHANNEL_FILE_PREVIEW_BYTES,
          );
          if (!res.ok) return null;
          return await res.text();
        } catch {
          return null;
        }
      },
    }).then((tabs) => {
      if (cancelled || !tabs) return;
      liveTabs = tabs;
      liveTabsKey = key;
    });
    return () => {
      cancelled = true;
    };
  });

  /** Sidebar presence dot: only when a project channel has a known online actor. */
  function rowHasProjectPresence(row: ConversationRow): boolean {
    if (row.kind !== "channel") return false;
    const isProject =
      (row.channelScope ?? "").trim() === "project" ||
      Boolean((row.projectId ?? "").trim());
    if (!isProject) return false;
    const companyUid = (row.companyUid ?? "").trim();
    if (!companyUid) return false;
    const projectId = (row.projectId ?? "").trim() || projectIdForRow(row);
    const live = liveInputsForCompanyProject(companyUid, projectId);
    // Prefer live-read actors on this project; fall back to channel roster.
    const fromLive = live.liveSessions
      .map((s) => s.actorUid)
      .filter(Boolean);
    if (fromLive.length > 0) {
      return fromLive.some(
        (uid) => presenceStatus(companyUid, uid) === "online",
      );
    }
    const channelId = row.channelId?.trim() ?? "";
    const roster = channelRosterById[channelId] ?? [];
    const actorUids =
      roster.length > 0
        ? roster.map((m) => m.personUid)
        : (row.members ?? []).map((m) => m.personUid);
    if (actorUids.length === 0) {
      // Company-wide online on any presence entry for transparent companies is
      // not enough — without project actors we stay dark (fail closed).
      return false;
    }
    return actorUids.some(
      (uid) => presenceStatus(companyUid, uid) === "online",
    );
  }

  const channelStatus = $derived.by((): ChannelStatusModel | null => {
    if (!selectedRow) return null;
    const channelId = selectedRow.channelId?.trim() ?? "";
    const roster = channelRosterById[channelId] ?? [];
    const companyUid = (selectedRow.companyUid ?? "").trim();
    const projectId = (selectedRow.projectId ?? "").trim() || projectIdForRow(selectedRow);
    const live = liveInputsForCompanyProject(companyUid, projectId);
    const base =
      channelStatusByRow?.(selectedRow) ??
      liveTabs?.status ??
      (roster.length > 0
        ? rosterStatusForRow(
            selectedRow,
            roster,
            companyUid
              ? companyDisplayName(companyUid, companyNames)
              : null,
            companyUid ? companyIconUrl(companyUid, companyIcons) : null,
          )
        : null);
    // Prefer rebuilding from live read + presence when we have sessions.
    const fromLive =
      live.liveSessions.length > 0 || live.presence.length > 0
        ? buildChannelStatusModel({
            project: {
              id: projectId || channelId || selectedRow.id,
              title: selectedRow.title,
              company: companyUid || undefined,
              storiesTotal: base?.stories.total,
              storiesComplete: base?.stories.complete,
              description: base?.project.description ?? null,
            },
            prd: base
              ? {
                  branchName: base.project.branch,
                  repoPath: base.project.repo,
                  repos: base.project.repos,
                  previewUrl: base.project.previewUrl ?? undefined,
                }
              : null,
            members:
              roster.length > 0
                ? roster
                : [
                    ...((base?.members ?? []).map((m) => ({
                      personUid: m.personUid,
                      displayName: m.displayName,
                      email: m.email ?? undefined,
                      role: m.role ?? undefined,
                      avatarUrl: m.avatarUrl ?? undefined,
                      description: m.description ?? undefined,
                    })) ?? []),
                    ...((base?.agents ?? []).map((a) => ({
                      personUid: a.personUid,
                      displayName: a.displayName,
                      email: a.email ?? undefined,
                      role: a.role ?? undefined,
                      avatarUrl: a.avatarUrl ?? undefined,
                      description: a.description ?? undefined,
                      isAgent: true,
                    })) ?? []),
                  ],
            liveSessions: live.liveSessions,
            presence: live.presence,
            companyLabel: base?.companyLabel ?? null,
          })
        : null;
    const merged = fromLive ?? base;
    if (!merged) return null;
    const withRoster =
      roster.length === 0
        ? merged
        : applyChannelRoster(merged, roster, identities);
    // Presence store is the only online source (US-015) — re-apply after roster
    // rebuild so timestamps/sessions never invent connection state.
    const withPresence = (uid: string): boolean =>
      Boolean(companyUid) && presenceStatus(companyUid, uid) === "online";
    return {
      ...withRoster,
      activeSessions:
        fromLive?.activeSessions ?? withRoster.activeSessions ?? [],
      liveAgents: fromLive?.liveAgents?.length
        ? fromLive.liveAgents
        : withRoster.liveAgents,
      members: withRoster.members.map((m) => ({
        ...m,
        online: withPresence(m.personUid),
      })),
      agents: withRoster.agents.map((a) => ({
        ...a,
        online: withPresence(a.personUid),
      })),
    };
  });
  /** Directory count wins; otherwise the status model (fixture fill) so the pill still opens. */
  const memberPillCount = $derived(
    selectedRow?.memberCount && selectedRow.memberCount > 0
      ? selectedRow.memberCount
      : (channelStatus?.memberCount ?? 0),
  );
  const showMemberPill = $derived(
    Boolean(selectedRow) && (memberPillCount > 0 || channelStatus != null),
  );

  function unwrapAdapter<T>(
    result:
      | { ok: true; value: T }
      | { ok?: false; message?: string; reason?: string; code?: string },
  ): T {
    if ("ok" in result && result.ok) return result.value;
    const fail = result as { message?: string; reason?: string; code?: string };
    const detail = fail.message ?? fail.reason ?? "request failed";
    throw new Error(fail.code ? `[${fail.code}] ${detail}` : detail);
  }

  function asReplyThread(value: unknown): ReplyThreadResponse {
    const rec =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const rootRows = rec.root ? normalizeConversationMessages([rec.root]) : [];
    const replies = normalizeConversationMessages(rec.replies ?? []);
    const root = rootRows[0] ?? null;
    const rootCount = root?.replyCount;
    const replyCount =
      typeof rec.replyCount === "number"
        ? rec.replyCount
        : (rootCount ?? replies.length);
    return {
      scope: rec.scope === "dm" ? "dm" : "channel",
      root,
      replies,
      replyCount,
    };
  }

  const conversationApi = $derived<ConversationApi>({
    fetchChannel: async (args) => {
      const raw = unwrapAdapter(await adapter.messaging.fetchChannel(args));
      const page = timelinePageFromPayload(raw);
      return {
        messages: normalizeConversationMessages(page.messages),
        nextCursor: page.nextCursor ?? null,
      };
    },
    sendChannelMessage: async (args) => {
      unwrapAdapter(
        await adapter.messaging.sendChannelMessage(args.channelId, args.body, {
          mentions: args.mentions,
          attachments: args.attachments,
        }),
      );
    },
    fetchDmThread: async (args) => {
      const raw = unwrapAdapter(await adapter.messaging.fetchDmThread(args));
      const page = timelinePageFromPayload(raw);
      return {
        messages: normalizeConversationMessages(page.messages),
        nextCursor: page.nextCursor ?? null,
      };
    },
    sendDm: async (args) => {
      unwrapAdapter(
        await adapter.messaging.sendDm(args.toPersonUid, args.body, {
          attachments: args.attachments,
        }),
      );
    },
    fetchReplyThread: async (args) =>
      asReplyThread(
        unwrapAdapter(await adapter.messaging.fetchReplyThread(args)),
      ),
    sendReply: async (args) => {
      unwrapAdapter(await adapter.messaging.sendReply(args));
    },
    listChannelAgentTasks: adapter.messaging.listChannelAgentTasks
      ? async (args) =>
          unwrapAdapter(
            await adapter.messaging.listChannelAgentTasks!(args.agentUid, args.channelId),
          )
      : undefined,
    listAgentTasks: adapter.messaging.listAgentTasks
      ? async (args) => unwrapAdapter(await adapter.messaging.listAgentTasks!(args.agentUid))
      : undefined,
    runCardAction: async (args) => {
      const raw = unwrapAdapter(
        await adapter.messaging.runCardAction(args),
      ) as Record<string, unknown> | undefined;
      return {
        cardId: typeof raw?.cardId === "string" ? raw.cardId : args.cardId,
        actionId: typeof raw?.actionId === "string" ? raw.actionId : args.actionId,
        eventId: typeof raw?.eventId === "string" ? raw.eventId : undefined,
        state: typeof raw?.state === "string" ? raw.state : "",
        fields: raw?.fields,
        replayed: raw?.replayed === true,
        // US-006/011: create_agent accept mints the agent channel; keep the
        // ids so handleCardAction can select it (they were dropped here).
        agentChannelId:
          typeof raw?.agentChannelId === "string" ? raw.agentChannelId : undefined,
        agentUid: typeof raw?.agentUid === "string" ? raw.agentUid : undefined,
        companyChannelId: typeof raw?.companyChannelId === "string" ? raw.companyChannelId : undefined,
        companyUid: typeof raw?.companyUid === "string" ? raw.companyUid : undefined,
        focusCardId:
          typeof raw?.focusCardId === "string" ? raw.focusCardId : undefined,
        // Entry points: the summary card's create_company action answers with
        // the channel + card it posted; pending checkout answers with a url.
        channelId:
          typeof raw?.channelId === "string" ? raw.channelId : undefined,
        reason: typeof raw?.reason === "string" ? raw.reason : undefined,
        url: typeof raw?.url === "string" ? raw.url : undefined,
      };
    },
    getCompanyTab: adapter.messaging.getCompanyTab
      ? async (companyUid, tabId) =>
          unwrapAdapter(await adapter.messaging.getCompanyTab!(companyUid, tabId))
      : undefined,
    runCompanyTabAction: adapter.messaging.runCompanyTabAction
      ? async (args) => {
          const raw = unwrapAdapter(
            await adapter.messaging.runCompanyTabAction!(args),
          ) as Record<string, unknown> | undefined;
          return {
            cardId: typeof raw?.cardId === "string" ? raw.cardId : args.cardId,
            actionId:
              typeof raw?.actionId === "string" ? raw.actionId : args.actionId,
            eventId: typeof raw?.eventId === "string" ? raw.eventId : undefined,
            state: typeof raw?.state === "string" ? raw.state : "",
            fields: raw?.fields,
            replayed: raw?.replayed === true,
            navigateTo:
              raw?.navigateTo === "chat" ? "chat" : undefined,
            focusCardId:
              typeof raw?.focusCardId === "string" ? raw.focusCardId : undefined,
            channelId:
              typeof raw?.channelId === "string" ? raw.channelId : undefined,
            reason: typeof raw?.reason === "string" ? raw.reason : undefined,
            url: typeof raw?.url === "string" ? raw.url : undefined,
          };
        }
      : undefined,
  });

  // ── Lifecycle entry points (New company / New agent) ─────────────────────

  /** Card the shell should scroll to and focus once the timeline paints it. */
  // Plain (non-reactive) on purpose: the poll compares by identity and a
  // `$state` proxy would never equal the object it was handed.
  let pendingFocusCard: Pick<EntryPointTarget, "cardId" | "cardKind"> | null =
    null;
  let focusCardTimer: ReturnType<typeof setTimeout> | undefined;
  const FOCUS_CARD_POLL_MS = 120;
  const FOCUS_CARD_POLL_LIMIT = 50;
  /** After the first focus, watch this long for the node being re-rendered. */
  const FOCUS_CARD_SETTLE_MS = 150;
  const FOCUS_CARD_SETTLE_LIMIT = 12;

  /**
   * Poll the shell for the target card. Cards arrive asynchronously (the
   * channel opens, hydrates, then the wake delivers the posted card), so a
   * one-shot query would miss it; the poll is bounded so a card that never
   * shows up cannot leak a timer.
   */
  function focusLifecycleCard(
    target: Pick<EntryPointTarget, "cardId" | "cardKind">,
  ): void {
    if (!target.cardId && !target.cardKind) return;
    if (focusCardTimer !== undefined) clearTimeout(focusCardTimer);
    pendingFocusCard = target;
    let attempts = 0;
    const tryFocus = (): void => {
      focusCardTimer = undefined;
      if (pendingFocusCard !== target) return;
      const root: ParentNode =
        typeof document !== "undefined" ? document : ({} as ParentNode);
      const el =
        typeof root.querySelector === "function"
          ? findLifecycleCardElement(root, target)
          : null;
      if (el) {
        pendingFocusCard = null;
        applyCardFocus(el);
        settleCardFocus(el, target, 0);
        return;
      }
      attempts += 1;
      if (attempts >= FOCUS_CARD_POLL_LIMIT) {
        pendingFocusCard = null;
        return;
      }
      focusCardTimer = setTimeout(tryFocus, FOCUS_CARD_POLL_MS);
    };
    // First attempt on a macrotask: the caller (create modal, header button)
    // still has to close / re-enable and restore its own focus first, and the
    // card must win that exchange.
    focusCardTimer = setTimeout(tryFocus, 0);
  }

  function applyCardFocus(el: HTMLElement): void {
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center" });
    }
    el.focus({ preventScroll: true });
  }

  /**
   * A channel switch hydrates in stages, so the node focused first can be
   * replaced a moment later (focus falls to <body>). Re-assert onto the
   * fresh node while ours is detached; never steal focus the user moved.
   */
  function settleCardFocus(
    el: HTMLElement,
    target: Pick<EntryPointTarget, "cardId" | "cardKind">,
    attempt: number,
  ): void {
    if (attempt >= FOCUS_CARD_SETTLE_LIMIT) return;
    focusCardTimer = setTimeout(() => {
      focusCardTimer = undefined;
      let current = el;
      if (!current.isConnected) {
        const next =
          typeof document !== "undefined"
            ? findLifecycleCardElement(document, target)
            : null;
        if (next) {
          applyCardFocus(next);
          current = next;
        }
      }
      settleCardFocus(current, target, attempt + 1);
    }, FOCUS_CARD_SETTLE_MS);
  }

  /** Select the target channel (if not already there) and focus its card. */
  function navigateToEntryTarget(
    target: EntryPointTarget,
    companyUid: string | null,
  ): void {
    const focus = { cardId: target.cardId, cardKind: target.cardKind };
    if (selectedRow?.channelId !== target.channelId || view !== "conversation") {
      requestChannelOpen(target.channelId, {
        companyUid,
        focusCardId: target.cardId,
        focusCardKind: target.cardKind,
      });
    }
    focusLifecycleCard(focus);
  }

  const canRunEntryPoints = $derived(
    typeof adapter.messaging.runCardAction === "function",
  );

  /**
   * Companies the roster already knows about, whatever their sync state. Any
   * of them means the account is NOT a blank slate: #welcome leads with that
   * company and hides the seeded create_company card.
   */
  const rosterCompanies = $derived(setupCompanies(companies));
  /**
   * Boot lands on #welcome until Run Setup has been used on this machine
   * (persisted; see `hasRunWelcomeSetup`). Flips in-session the moment the
   * person starts setup so a later re-open goes to the company channel.
   */
  let welcomeSetupRun = $state(hasRunWelcomeSetup());
  /**
   * An explicit conversation deep link (`?channel=` / `?person=`) is a
   * stronger intent than first landing: it must never be swallowed by the
   * welcome-first boot pick.
   */
  const bootDeepLink = conversationDeepLinkFromLocation();
  const hasBootDeepLink = Boolean(
    bootDeepLink.channelId?.trim() || bootDeepLink.personUid?.trim(),
  );
  function recordWelcomeSetupRun(): void {
    markWelcomeSetupRun();
    welcomeSetupRun = true;
  }
  const hasRosterCompany = $derived(rosterCompanies.length > 0);
  /** The finale's "Open <Company>" button: the roster's first company, or nothing. */
  const finaleCompany = $derived.by(() => {
    const company = rosterCompanies[0];
    if (!company) return null;
    return { label: setupCompanyActionLabel(company), onopen: () => openCompanyFromSetup(company) };
  });
  /** The user explicitly asked for another company this session. */
  let createCompanyRequested = $state(false);

  /** Sidebar / switcher / #welcome "New company": summary card action, then #setup. */
  async function createCompanyEntry(): Promise<EntryPointResult> {
    const result = await runCreateCompanyEntry(conversationApi, {
      hasCompanies: hasRosterCompany,
    });
    createCompanyRequested = result.ok;
    if (result.ok) navigateToEntryTarget(result.target, null);
    return result;
  }

  /**
   * #welcome "Open <Company>" / "Continue setup for <Company>": select the
   * company's own channel when the rail already has it, otherwise switch the
   * sidebar into that company's scope so its rows hydrate and auto-open.
   */
  function openCompanyFromSetup(company: Workspace): void {
    const uid = company.cloudUid?.trim() ?? "";
    const row = uid
      ? railRows.find(
          (candidate) =>
            candidate.kind === "channel" &&
            !candidate.browseOnly &&
            candidate.channelScope === "company" &&
            candidate.companyUid === uid,
        )
      : undefined;
    if (row) {
      handleSelect(row);
      return;
    }
    if (uid) changeTenantCompany(uid);
  }

  /** Sidebar / header "New bot" (Cloud): Team tab action, then the company channel. */
  async function addAgentEntry(companyUid: string): Promise<EntryPointResult> {
    const result = await runAddAgentEntry(conversationApi, companyUid);
    if (result.ok) navigateToEntryTarget(result.target, companyUid);
    return result;
  }

  /**
   * Whether the viewer may act on the current company's Team tab. Read from
   * the tab surface the server sends (its `viewer` is per company), fetched
   * once per company so the header button is right on the Chat tab too.
   */
  let companyTeamCanAct = $state(false);
  let companyTeamCanActUid: string | null = null;
  let headerAddAgentBusy = $state(false);
  let headerAddAgentError = $state<string | null>(null);

  async function loadCompanyTeamCanAct(uid: string): Promise<void> {
    if (companyTeamCanActUid === uid) return;
    companyTeamCanActUid = uid;
    companyTeamCanAct = false;
    headerAddAgentError = null;
    const getTab = conversationApi.getCompanyTab;
    if (!getTab || !conversationApi.runCompanyTabAction) return;
    try {
      const parsed = parseCompanyTab(await getTab(uid, "team"));
      if (companyTeamCanActUid === uid) {
        companyTeamCanAct = parsed?.viewer.canAct === true;
      }
    } catch {
      if (companyTeamCanActUid === uid) companyTeamCanAct = false;
    }
  }

  async function addAgentFromHeader(): Promise<void> {
    const uid = selectedRow?.companyUid?.trim() ?? "";
    if (!uid || headerAddAgentBusy) return;
    headerAddAgentBusy = true;
    headerAddAgentError = null;
    try {
      const result = await addAgentEntry(uid);
      if (!result.ok) headerAddAgentError = result.reason;
    } finally {
      headerAddAgentBusy = false;
    }
  }

  const cardActionKeys: CardActionIdempotencyStore = new Map();

  function applyCardActionFailure(cardId: string, message: string, values?: Record<string, string>): void {
    const row = selectedRow;
    if (!row) return;
    const current =
      liveTimelineId === row.id
        ? liveTimeline
        : (messagesByRow?.(row) ?? liveTimeline);
    commitTimeline(
      row,
      patchLifecycleCardState(current, cardId, {
        state: /timed? out|timeout|network|connection|unavailable|fetch failed|could not reach|\b50[234]\b/i.test(message) ? "open" : "blocked",
        reason: message,
        values,
      }),
    );
  }

  async function loadCompanyTabSurface(
    tabId: CompanyChannelTabId,
  ): Promise<void> {
    const uid = selectedRow?.companyUid?.trim() ?? "";
    if (!uid) {
      companyTabData = null;
      return;
    }
    const getTab = conversationApi.getCompanyTab;
    const fetchId = tabId === "chat" ? "settings" : tabId;
    if (!getTab) {
      if (tabId !== "chat") {
        companyTabData = {
          tab: tabId,
          companyUid: uid,
          viewer: { canAct: false },
          sections: [{ id: tabId, title: tabId, rows: [] }],
        };
      }
      return;
    }
    companyTabLoading = true;
    try {
      const raw = await getTab(uid, fetchId);
      const parsed = parseCompanyTab(raw);
      if (parsed?.appearance?.wallpaper) {
        companyWallpaper = parsed.appearance.wallpaper;
      }
      if (parsed?.appearance?.name?.trim()) {
        companyAppearanceName = parsed.appearance.name.trim();
      }
      companyTabData = tabId === "chat" ? companyTabData : parsed;
      if (tabId === "team" && parsed && companyTeamCanActUid === uid) {
        companyTeamCanAct = parsed.viewer.canAct === true;
      }
    } catch {
      if (tabId !== "chat") {
        companyTabData = {
          tab: tabId,
          companyUid: uid,
          viewer: { canAct: false },
          sections: [{ id: tabId, title: tabId, rows: [] }],
        };
      }
    } finally {
      companyTabLoading = false;
    }
  }

  $effect(() => {
    if (!isCompanyChannel) return;
    const tabId = companyTab;
    void loadCompanyTabSurface(tabId);
  });

  $effect(() => {
    if (!isCompanyChannel) {
      companyTeamCanActUid = null;
      companyTeamCanAct = false;
      headerAddAgentError = null;
      return;
    }
    const uid = selectedRow?.companyUid?.trim() ?? "";
    if (uid) void loadCompanyTeamCanAct(uid);
  });

  async function handleTeamAction(event: CompanyTabActionEvent): Promise<void> {
    const run = conversationApi.runCompanyTabAction;
    if (!run) return;
    const result = await submitLifecycleCardAction({
      event,
      store: cardActionKeys,
      run: (args) =>
        run({
          companyUid: event.companyUid,
          tab: event.tab,
          cardId: args.cardId,
          actionId: args.actionId,
          values: args.values,
          idempotencyKey: args.idempotencyKey,
        }),
      onFailure: () => {},
    });
    if (result?.navigateTo === "chat") {
      pushConversationSurface({ companyTab: "chat" });
      return;
    }
    await loadCompanyTabSurface(companyTab);
  }

  async function handleCardAction(event: LifecycleCardActionEvent): Promise<void> {
    const actionRow = selectedRow;
    oncardaction?.(event);
    if (typeof adapter.messaging.runCardAction !== "function") return;
    const result = await submitLifecycleCardAction({
      event,
      store: cardActionKeys,
      run: conversationApi.runCardAction,
      onFailure: (cardId, message) => applyCardActionFailure(cardId, message, event.values),
    });
    // The HTTP response settles this interaction; MQTT is supplementary.
    // Otherwise a missed lifecycle wake leaves localPending stuck forever.
    if (result && actionRow && selectedRow?.id === actionRow.id) {
      const state = result.state;
      if (state === "open" || state === "pending" || state === "done" || state === "skipped" || state === "blocked") {
        commitTimeline(actionRow, patchLifecycleCardState(liveTimeline, event.cardId, { state, reason: null }));
      }
      // Fetch newly created steps even when no live event arrives. Failure
      // must not turn an already-saved choice into a failed mutation.
      void fetchTimelineRaw(actionRow)
        .then((raw) => applyFetchedTimeline(actionRow, raw, state === "pending" ? event.cardId : undefined))
        .catch(() => {});
    }
    const destination = result?.companyChannelId?.trim() || result?.agentChannelId?.trim();
    if (destination?.startsWith("chn_")) {
      requestChannelOpen(destination, {
        title: result?.companyChannelId ? "Company channel" : headerTitle,
        companyUid: result?.companyUid ?? selectedRow?.companyUid ?? null,
      });
      return;
    }
    if (!result) return;
    // Pending checkout: `retry_checkout` answers with the session url.
    const url = typeof result.url === "string" ? result.url.trim() : "";
    if (/^https?:\/\//i.test(url)) onopenurl?.(url);
    // A card that posts another card (companies_summary → create_company)
    // answers with where it went; land on it.
    const postedCardId =
      typeof result.cardId === "string" ? result.cardId.trim() : "";
    const postedChannelId =
      typeof result.channelId === "string" ? result.channelId.trim() : "";
    if (
      postedCardId &&
      postedCardId !== event.cardId &&
      result.state !== "blocked"
    ) {
      navigateToEntryTarget(
        {
          channelId: postedChannelId || event.channelId,
          cardId: postedCardId,
          cardKind: null,
        },
        selectedRow?.companyUid ?? null,
      );
    }
  }

  function openReply(rootEventId: string): void {
    const id = rootEventId.trim();
    if (!id || !selectedRow) return;
    openProfileMember = null;
    openAgentMember = null;
    openArtifactView = null;
    openReplyRootId = id;
    pushConversationSurface({
      replyRootEventId: id,
      tab: "chat",
      agentSurface: "chat",
      companyTab: "chat",
    });
  }

  /** Artifact mode for the side pane. The thread underneath is left intact so
   *  closing the artifact returns to it. */
  function openArtifact(artifact: ChatArtifact): void {
    openArtifactView = artifact;
    if (tab !== "chat") tab = "chat";
  }

  function closeArtifact(): void {
    openArtifactView = null;
  }

  function closeReply(): void {
    pendingReplyRootId = null;
    pendingReplyForRowId = null;
    replyApplyInFlight = null;
    void leaveCurrentDestination();
  }

  function queueReplyForRow(
    row: ConversationRow,
    replyRootEventId?: string | null,
  ): void {
    const id = replyRootEventId?.trim() || null;
    pendingReplyRootId = id;
    pendingReplyForRowId = id ? row.id : null;
  }

  async function applyReplyDeepLink(rootEventId: string): Promise<void> {
    const id = rootEventId.trim();
    const row = selectedRow;
    const scope = replyScopeForRow(row);
    if (!id || !row || !scope) return;
    replyApplyInFlight = id;
    try {
      const raw = unwrapAdapter(
        await adapter.messaging.fetchReplyThread({
          scope,
          rootEventId: id,
          ...(scope === "channel" && row.channelId
            ? { channelId: row.channelId }
            : {}),
          ...(scope === "dm" && row.personUid
            ? { withPersonUid: row.personUid }
            : {}),
        }),
      );
      if (selectedRow?.id !== row.id || replyApplyInFlight !== id) return;
      if (shouldOpenReplyDeepLink(id, asReplyThread(raw))) {
        openReplyRootId = id;
      }
    } catch {
      if (selectedRow?.id === row.id && replyApplyInFlight === id) {
        openReplyRootId = null;
      }
    } finally {
      if (replyApplyInFlight === id) replyApplyInFlight = null;
    }
  }

  function onReplyCount(
    rootEventId: string,
    count: number,
    preview?: ReplyPreview | null,
  ): void {
    replyCountOverride = { ...replyCountOverride, [rootEventId]: count };
    liveTimeline = liveTimeline.map((msg) =>
      msg.eventId === rootEventId ? { ...msg, replyCount: count } : msg,
    );
    if (preview) {
      replyPreviewByRoot = { ...replyPreviewByRoot, [rootEventId]: preview };
    }
  }

  // Closed-panel `reply:new`: bump visible “N replies”. Open panel on this
  // root re-fetches via ReplyPanel. Other roots do not rewrite the panel.
  $effect(() => {
    if (!wakes) return;
    const row = selectedRow;
    return wakes.on("reply:new", (payload) => {
      if (!replyNewMatchesConversation(payload, row)) return;
      if (openReplyRootId === payload.rootEventId) return;
      const injected = row ? (messagesByRow?.(row) ?? []) : [];
      const source =
        liveTimelineId === row?.id && liveTimeline.length > 0
          ? liveTimeline
          : injected;
      const shown = source.find((msg) => msg.eventId === payload.rootEventId);
      const current =
        replyCountOverride[payload.rootEventId] ?? shown?.replyCount ?? 0;
      if (!shown && replyCountOverride[payload.rootEventId] == null) return;
      onReplyCount(payload.rootEventId, current + 1);
    });
  });

  const replyScope = $derived(
    selectedRow ? replyScopeForRow(selectedRow) : null,
  );
  const seedRoot = $derived(
    openReplyRootId
      ? (timeline.find((msg) => msg.eventId === openReplyRootId) ?? null)
      : null,
  );

  $effect(() => {
    if (activeTab !== "chat") {
      openReplyRootId = null;
      openArtifactView = null;
    }
  });

  $effect(() => {
    const rowId = selectedRow?.id ?? null;
    const pending = pendingReplyRootId?.trim() || null;
    const boundTo = pendingReplyForRowId;
    untrack(() => {
      if (rowId !== lastReplyRowId) {
        lastReplyRowId = rowId;
        openReplyRootId = null;
        openArtifactView = null;
      }
      if (!rowId || !pending) return;
      if (boundTo && boundTo !== rowId) return;
      pendingReplyRootId = null;
      pendingReplyForRowId = null;
      void applyReplyDeepLink(pending);
    });
  });

  $effect(() => {
    const mq =
      typeof window !== "undefined"
        ? window.matchMedia(`(max-width: ${REPLY_OVERLAY_MAX_PX}px)`)
        : null;
    if (!mq) return;
    const apply = () => {
      narrowViewport = mq.matches;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  });

  $effect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(max-width: ${SIDEBAR_OVERLAY_MAX_PX}px)`);
    const apply = () => {
      phoneViewport = mq.matches;
      // Crossing into phone width with the list open would bury the
      // conversation under it. Widening again leaves the choice to the user.
      if (mq.matches) sidebarCollapsed = true;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  });

  function selectConversationRow(
    row: ConversationRow,
    options?: {
      replyRootEventId?: string | null;
      preserveView?: boolean;
      /** The shell picked this row, not the person using it. */
      automatic?: boolean;
    },
  ): void {
    if (selectedRow?.id !== row.id) {
      openProfileMember = null;
      openAgentMember = null;
    }
    selectedRow = row;
    if (!options?.preserveView) {
      view = "conversation";
      meetingFocusRequest = null;
    }
    tab = "chat";
    companyTab = "chat";
    agentSurface = "chat";
    channelFileKey = null;
    paletteOpen = false;
    membersOpen = false;
    projectAboutOpen = false;
    openReplyRootId = null;
    queueReplyForRow(row, options?.replyRootEventId);
    attachTray = null;
    // The phone list overlays the conversation it just navigated to, so it has
    // to get out of the way. On wider screens it is a column and stays put.
    //
    // Only for a deliberate pick: the list auto-selects a row as it mounts, so
    // closing on every select shut the overlay again the instant it opened.
    if (phoneViewport && options?.automatic !== true) sidebarCollapsed = true;
    onselectrow?.(row);
  }

  function currentNavigationScope() {
    const accountId =
      (self?.uid ?? tenantAccountId ?? "local").trim() || "local";
    return { accountId, companyUid: tenantCompanyId };
  }

  function destinationFromConversation(
    row: ConversationRow,
    nested?: {
      replyRootEventId?: string | null;
      tab?: ChannelTab;
      companyTab?: CompanyChannelTabId;
      agentSurface?: AgentChannelTab;
      fileKey?: string | null;
    },
  ): NavigationDestination {
    const replyRootEventId = nested?.replyRootEventId ?? null;
    if (row.channelId) {
      const nextTab = nested?.tab ?? "chat";
      return {
        kind: "channel",
        channelId: row.channelId,
        replyRootEventId,
        tab: nextTab,
        companyTab: nested?.companyTab ?? "chat",
        agentSurface: nested?.agentSurface ?? "chat",
        fileKey: nextTab === "files" ? nested?.fileKey ?? null : null,
      };
    }
    if (row.personUid) {
      return {
        kind: "dm",
        personUid: row.personUid,
        replyRootEventId,
        agentSurface: nested?.agentSurface ?? "chat",
      };
    }
    return { kind: "messages" };
  }

  function currentConversationNested() {
    return {
      replyRootEventId: openReplyRootId,
      tab,
      companyTab,
      agentSurface,
      fileKey: channelFileKey,
    };
  }

  function pushConversationSurface(
    patch: Partial<{
      replyRootEventId: string | null;
      tab: ChannelTab;
      companyTab: CompanyChannelTabId;
      agentSurface: AgentChannelTab;
      fileKey: string | null;
    }>,
  ): void {
    const row = selectedRow;
    if (!row) return;
    const nested = { ...currentConversationNested(), ...patch };
    if (patch.tab && patch.tab !== "chat") nested.replyRootEventId = null;
    if (patch.tab && patch.tab !== "files") nested.fileKey = null;
    if (patch.companyTab && patch.companyTab !== "chat") {
      nested.tab = "chat";
      nested.replyRootEventId = null;
      nested.fileKey = null;
    }
    if (patch.agentSurface && patch.agentSurface !== "chat") {
      nested.replyRootEventId = null;
    }
    void navigate(destinationFromConversation(row, nested));
  }

  function currentShellDestination(): NavigationDestination {
    if (navigationUnavailable) return navigationUnavailable.destination;
    switch (view) {
      case "settings":
        return { kind: "settings", section: settingsSection };
      case "notifications":
        return { kind: "notifications" };
      case "meetings":
        return {
          kind: "meetings",
          meetingId: meetingFocusRequest?.meetingId ?? null,
        };
      case "atlas":
        return { kind: "atlas" };
      case "library":
        return { kind: "library", tab: libraryTab, itemId: libraryItemId };
      case "shared-files":
        return { kind: "shared-files" };
      case "extra":
        if (extraPageId) return extraDestination(extraPageId, extraPageParam);
        return { kind: "messages" };
      default:
        if (selectedRow) {
          return destinationFromConversation(
            selectedRow,
            currentConversationNested(),
          );
        }
        return { kind: "messages" };
    }
  }

  function captureCurrentNavigation(): NavigationEntry | null {
    try {
      return createNavigationEntry(
        currentShellDestination(),
        currentNavigationScope(),
        readNavigationScroll(),
      );
    } catch {
      return null;
    }
  }

  function readNavigationScroll(): NavigationScrollState | null {
    if (typeof document === "undefined") return null;
    return captureNavigationScroll(document);
  }

  function stopScrollRestore(): void {
    cancelScrollRestore?.();
    cancelScrollRestore = null;
  }

  /**
   * The one live session that is legitimately company-less: #welcome's
   * native setup run, which exists before the company it creates. "Open setup
   * chat" lands on it by bare id while the run is in flight; it needs no
   * company key because this app started it for this account. Everything
   * else on the Sessions extra keeps needing its key.
   */
  function companyAccess(
    companyKey: string | null | undefined,
  ): "ok" | "unknown" | "denied" {
    const key = companyKey?.trim() ?? "";
    if (!key) return "ok";
    if (companies == null) return "unknown";
    return companies.some((company) => {
      const uid = (company.cloudUid ?? "").trim();
      const slug = (company.slug ?? "").trim();
      return uid === key || slug === key;
    })
      ? "ok"
      : "denied";
  }

  function companyIsAccessible(companyUid: string | null | undefined): boolean {
    return companyAccess(companyUid) === "ok";
  }

  function accessOutcome(
    destination: NavigationDestination,
    companyKey: string | null | undefined,
  ): NavigationResolveOutcome | null {
    const access = companyAccess(companyKey);
    if (access === "unknown") {
      return { status: "transient-failure", error: "Directory still loading" };
    }
    if (access === "denied") {
      return {
        status: "unavailable",
        destination,
        reason: DESTINATION_UNAVAILABLE,
      };
    }
    return null;
  }

  function rowForDestination(
    destination: NavigationDestination,
  ): ConversationRow | null {
    const rows = [
      ...searchRows,
      ...railRows,
      ...(selectedRow ? [selectedRow] : []),
    ];
    if (destination.kind === "channel") {
      return (
        rows.find((row) => row.channelId === destination.channelId) ?? null
      );
    }
    if (destination.kind === "dm") {
      return (
        rows.find(
          (row) => row.personUid === destination.personUid && !row.channelId,
        ) ?? null
      );
    }
    return null;
  }

  function resolveShellDestination(
    destination: NavigationDestination,
    context: {
      isStale: () => boolean;
      accountId: string;
      companyUid: string | null;
    },
  ): NavigationResolveOutcome | Promise<NavigationResolveOutcome> {
    if (context.isStale()) return { status: "cancelled" };
    if (context.accountId !== currentNavigationScope().accountId) {
      return {
        status: "account-changed",
        accountId: currentNavigationScope().accountId,
      };
    }
    if (destination.kind === "extra") {
      if (!extraPages?.[destination.page]) {
        return {
          status: "rejected",
          reason: `Unknown destination: ${destination.page}`,
        };
      }
      // A session with no company key is not gated: a personal chat, or a
      // fresh one whose company the page has not learned yet. Only a key
      // that is no longer in the membership makes a session unavailable.
      const extraCompany =
        destination.companyUid ?? extraParamCompanyKey(destination.param);
      const extraDenied = accessOutcome(destination, extraCompany);
      if (extraDenied) return extraDenied;
      return { status: "ready", destination };
    }
    if (destination.kind === "channel" || destination.kind === "dm") {
      const row = rowForDestination(destination);
      if (row) {
        // Rows already in the rail came from the membership directory.
        // Only blank after companies has loaded and the uid is gone.
        if (companyAccess(row.companyUid) === "denied") {
          return {
            status: "unavailable",
            destination,
            reason: DESTINATION_UNAVAILABLE,
          };
        }
        return { status: "ready", destination };
      }
      return waitForDestinationRow(destination, context);
    }
    if (destination.kind === "setup-checkout") {
      const checkoutDenied = accessOutcome(
        destination,
        destination.companyUid,
      );
      if (checkoutDenied) return checkoutDenied;
    }
    return { status: "ready", destination };
  }

  function waitForDestinationRow(
    destination: Extract<NavigationDestination, { kind: "channel" | "dm" }>,
    context: { isStale: () => boolean },
  ): Promise<NavigationResolveOutcome> {
    const attempts = 16;
    const delayMs = 50;
    return new Promise((resolve) => {
      let tries = 0;
      const tick = (): void => {
        if (context.isStale()) {
          resolve({ status: "cancelled" });
          return;
        }
        const row = rowForDestination(destination);
        if (row) {
          if (companyAccess(row.companyUid) === "denied") {
            resolve({
              status: "unavailable",
              destination,
              reason: DESTINATION_UNAVAILABLE,
            });
            return;
          }
          resolve({ status: "ready", destination });
          return;
        }
        tries += 1;
        const directoryReady = directorySettled && companies != null;
        if (tries >= attempts || directoryReady) {
          if (!directoryReady && companies == null) {
            resolve({
              status: "transient-failure",
              error: "Directory still loading",
            });
            return;
          }
          resolve({
            status: "unavailable",
            destination,
            reason: DESTINATION_UNAVAILABLE,
          });
          return;
        }
        setTimeout(tick, delayMs);
      };
      setTimeout(tick, delayMs);
    });
  }

  const navigationHistory = createNavigationHistory();

  function syncNavigationChrome(): void {
    const snap = navigationHistory.snapshot();
    navigationCanGoBack = navigationHistory.canGoBack();
    navigationCanGoForward = navigationHistory.canGoForward();
    const back = historyNeighbor(snap, "back");
    const forward = historyNeighbor(snap, "forward");
    navigationBackLabel = back ? destinationLabel(back.destination) : "";
    navigationForwardLabel = forward
      ? destinationLabel(forward.destination)
      : "";
  }

  function applyCommittedNavigation(applied: AppliedNavigation): void {
    syncNavigationChrome();
    paletteOpen = false;
    membersOpen = false;
    projectAboutOpen = false;
    pendingRestoreScroll = applied.entry.scroll ?? null;
    stopScrollRestore();
    if (applied.availability === "unavailable") {
      navigationUnavailable = {
        destination: applied.entry.destination,
        reason: applied.reason ?? DESTINATION_UNAVAILABLE,
      };
      selectedRow = null;
      liveTimeline = [];
      return;
    }
    navigationUnavailable = null;
    embeddedNavigationError = null;
    const next = applied.entry.destination;
    meetingFocusRequest = null;
    switch (next.kind) {
      case "messages":
        view = "conversation";
        settingsSection = null;
        extraPageId = null;
        extraPageParam = null;
        break;
      case "notifications":
        view = "notifications";
        settingsSection = null;
        extraPageId = null;
        extraPageParam = null;
        break;
      case "settings":
        view = "settings";
        settingsSection = next.section ?? null;
        extraPageId = null;
        extraPageParam = null;
        onOpenSettings?.();
        break;
      case "meetings":
        view = "meetings";
        settingsSection = null;
        extraPageId = null;
        extraPageParam = null;
        if (next.meetingId?.trim()) {
          meetingFocusRequest = {
            meetingId: next.meetingId.trim(),
            sequence: ++meetingFocusSequence,
          };
        }
        break;
      case "atlas":
        view = "atlas";
        settingsSection = null;
        extraPageId = null;
        extraPageParam = null;
        break;
      case "library":
        libraryTab = next.tab;
        libraryItemId = next.itemId ?? null;
        view = "library";
        settingsSection = null;
        extraPageId = null;
        extraPageParam = null;
        break;
      case "shared-files":
        view = "shared-files";
        settingsSection = null;
        extraPageId = null;
        extraPageParam = null;
        break;
      case "extra":
        extraPageId = next.page;
        extraPageParam = next.param ?? null;
        view = "extra";
        settingsSection = null;
        break;
      case "setup-checkout": {
        const alreadySetup =
          selectedRow?.channelId === SETUP_CHANNEL_ID && view === "conversation";
        view = "conversation";
        settingsSection = null;
        extraPageId = null;
        extraPageParam = null;
        requestChannelOpen(SETUP_CHANNEL_ID, { companyUid: next.companyUid });
        const row = selectedRow;
        if (alreadySetup && row) void catchUpTimeline(row);
        break;
      }
      case "channel":
      case "dm": {
        view = "conversation";
        settingsSection = null;
        extraPageId = null;
        extraPageParam = null;
        libraryItemId = null;
        const row = rowForDestination(next);
        const reply = next.replyRootEventId ?? null;
        const sameRow = Boolean(row && selectedRow?.id === row.id);
        if (row && !sameRow) {
          selectConversationRow(row, { replyRootEventId: reply });
        } else if (row && sameRow) {
          if ((openReplyRootId ?? null) !== (reply ?? null)) {
            if (reply) queueReplyForRow(row, reply);
            else {
              openReplyRootId = null;
              pendingReplyRootId = null;
              pendingReplyForRowId = null;
            }
          }
        }
        if (next.kind === "channel") {
          tab = next.tab ?? "chat";
          companyTab = next.companyTab ?? "chat";
          agentSurface = next.agentSurface ?? "chat";
          channelFileKey = next.tab === "files" ? next.fileKey ?? null : null;
        } else {
          agentSurface = next.agentSurface ?? "chat";
          channelFileKey = null;
        }
        break;
      }
    }
  }

  const navigation = createNavigationController({
    history: navigationHistory,
    getScope: () => currentNavigationScope(),
    captureCurrent: () => captureCurrentNavigation(),
    captureScroll: () => readNavigationScroll(),
    resolve: (destination, context) =>
      resolveShellDestination(destination, context),
    apply: (applied) => applyCommittedNavigation(applied),
    onPending: (pending) => {
      navigationPending = pending != null;
    },
    onRejected: (reason) => {
      embeddedNavigationError = reason;
    },
  });

  $effect(() => {
    const scroll = pendingRestoreScroll;
    stopScrollRestore();
    if (!scroll || navigationUnavailable) return;
    const generation = navigation.generation();
    cancelScrollRestore = scheduleNavigationScrollRestore(
      () => (typeof document === "undefined" ? null : document),
      scroll,
      {
        isCancelled: () => navigation.generation() !== generation,
      },
    );
    return () => stopScrollRestore();
  });

  function navigate(
    destination: NavigationDestination,
    mode: NavigationMode = "push",
  ) {
    embeddedNavigationError = null;
    return navigation.navigate(destination, mode);
  }

  function resolveDestination(
    destination: NavigationDestination,
    generation?: number,
  ) {
    return navigation.resolveDestination(destination, generation);
  }

  function commitDestination(
    outcome: Extract<
      NavigationResolveOutcome,
      { status: "ready" | "unavailable" }
    >,
    mode: NavigationMode = "push",
    generation: number = navigation.generation(),
  ): boolean {
    return navigation.commitDestination(outcome, mode, generation);
  }

  function goBack() {
    return navigation.back();
  }

  function goForward() {
    return navigation.forward();
  }

  function leaveCurrentDestination() {
    if (navigationHistory.canGoBack()) return goBack();
    return navigate({ kind: "messages" });
  }

  $effect(() => {
    navigation.noteAccount((self?.uid ?? tenantAccountId ?? "").trim());
  });

  $effect(() => {
    if (companies == null) return;
    const allowed = new Set<string>();
    for (const company of companies) {
      const uid = (company.cloudUid ?? "").trim();
      const slug = (company.slug ?? "").trim();
      if (uid) allowed.add(uid);
      if (slug) allowed.add(slug);
    }
    navigation.filterAccessible(allowed);
    const current = navigationHistory.current();
    const shownExtra =
      extraPageId != null
        ? {
            kind: "extra" as const,
            page: extraPageId,
            param: extraPageParam,
          }
        : null;
    const currentIsShownExtra = Boolean(
      shownExtra &&
        current?.destination.kind === "extra" &&
        current.destination.page === shownExtra.page &&
        (current.destination.param ?? null) === shownExtra.param,
    );
    const shownKey = shownExtra
      ? extraParamCompanyKey(shownExtra.param) ??
        (currentIsShownExtra && current
          ? (destinationCompanyKey(current.destination) ?? current.companyUid)
          : null)
      : (current?.companyUid ??
        (current ? destinationCompanyKey(current.destination) : null));
    const extraPruned = Boolean(shownExtra && !currentIsShownExtra);
    const lostCompany = Boolean(shownKey && !allowed.has(shownKey));
    if (!extraPruned && !lostCompany) return;
    if (navigationUnavailable && !extraPruned && !lostCompany) return;
    navigationUnavailable = {
      destination: current?.destination ?? shownExtra ?? { kind: "messages" },
      reason: DESTINATION_UNAVAILABLE,
    };
    extraPageId = null;
    extraPageParam = null;
    selectedRow = null;
    liveTimeline = [];
  });

  function handleSelect(
    row: ConversationRow,
    options?: {
      replyRootEventId?: string | null;
      preserveView?: boolean;
      automatic?: boolean;
    },
  ): void {
    if (options?.automatic || options?.preserveView) {
      selectConversationRow(row, options);
      return;
    }
    if (selectedRow?.id !== row.id) selectedRow = row;
    void navigate(
      destinationFromConversation(row, {
        replyRootEventId: options?.replyRootEventId ?? null,
      }),
    );
  }

  function applyConversationDeepLink(
    link: ConversationDeepLink,
    options?: { preserveView?: boolean },
  ): void {
    const row =
      conversationRowForDeepLink(link, [...searchRows, ...railRows]) ??
      (link.replyRootEventId ? selectedRow : null);
    if (!row) return;
    const reply = link.replyRootEventId?.trim() || null;
    const sameRow = selectedRow?.id === row.id;
    // Notification click-through may fire while Settings/inbox is open with
    // the same row already selected — still need handleSelect to flip view.
    if (sameRow && !reply && view === "conversation") return;
    if (
      sameRow &&
      view === "conversation" &&
      (openReplyRootId === reply ||
        pendingReplyRootId === reply ||
        replyApplyInFlight === reply ||
        pendingReplyForRowId === row.id)
    ) {
      return;
    }
    handleSelect(row, {
      replyRootEventId: reply,
      preserveView: options?.preserveView,
    });
  }

  function applyPendingChannelOpen(pending: PendingChannelOpen): void {
    applyConversationDeepLink(
      {
        channelId: pending.channelId,
        personUid: null,
        replyRootEventId: pending.replyRootEventId,
        title: pending.title,
        companyUid: pending.companyUid,
      },
      { preserveView: pending.automatic && view !== "conversation" },
    );
    if (pending.focusCardId || pending.focusCardKind) {
      focusLifecycleCard({
        cardId: pending.focusCardId,
        cardKind: pending.focusCardKind,
      });
    }
  }

  function applyPendingConversation(target: ConversationTarget): void {
    applyConversationDeepLink(
      {
        channelId: null,
        personUid: target.personUid?.trim() || null,
        replyRootEventId: target.replyRootEventId ?? null,
        displayName: target.displayName?.trim() || null,
      },
      { preserveView: target.automatic === true && view !== "conversation" },
    );
  }

  /**
   * Self-heal a placeholder selection. `selectedRow` is a snapshot taken at
   * open time; when the channel was opened before the directory listed it
   * (a just-created channel, a deep link, a notification), the snapshot is a
   * stub — possibly titled with the raw `chn_…` id — and nothing ever
   * refreshed it, so the header stayed wrong until the user clicked away and
   * back. Once the real row shows up under the same id, adopt it in place.
   * Never touches `view`, replies, or focus: only the row's metadata changes.
   */
  $effect(() => {
    const rows = searchRows;
    const current = untrack(() => selectedRow);
    if (!current) return;
    const real = rows.find((row) => row.id === current.id);
    if (!real || real === current) return;
    if (
      real.title === current.title &&
      (real.companyUid ?? null) === (current.companyUid ?? null)
    ) {
      return;
    }
    selectedRow = real;
  });

  $effect(() => {
    const scope = messageScope;
    if (scope === untrack(() => reactionScope)) return;
    reactionScope = scope;
    liveReactions = {};
  });

  async function persistReaction(
    messageId: string,
    emoji: string,
  ): Promise<void> {
    const scope = messageScope;
    if (!scope || !messageId || !emoji) return;
    if (messageId.startsWith("local-send-")) return;
    const current = rowReactions[messageId];
    const add = toggleIsAdd(current, emoji);
    const previous = liveReactions;
    liveReactions = setMessageReactions(
      liveReactions,
      messageId,
      toggleReaction(current, emoji),
    );
    const res = await adapter.messaging.toggleReaction({
      messageScope: scope,
      messageId,
      emoji,
      add,
    });
    if (!res.ok) {
      liveReactions = previous;
      return;
    }
    const fetched = await adapter.messaging.fetchReactions(scope, messageId);
    if (fetched.ok) {
      liveReactions = setMessageReactions(
        liveReactions,
        messageId,
        reactionsFromPayload(fetched.value),
      );
    }
    if (selectedRow) onreactionscache?.(selectedRow, liveReactions);
  }

  let liveMentionTargets = $state<MentionTarget[]>([]);

  function changeTenantCompany(companyUid: string | null): void {
    if (tenantCompanyId === companyUid) return;
    // Company switching is in-account navigation: the history stack stays.
    // Existing tenant-generation guards still cancel in-flight company reads.
    // Remove every visible selection before the re-keyed sidebar begins reads
    // in the replacement scope.
    tenantCompanyId = companyUid;
    selectedRow = null;
    liveTimeline = [];
    liveTimelineId = null;
    timelineHydrating = false;
    lastDmTimelineStampByUid.clear();
    lastChannelTimelineStampById.clear();
    dmThreadsUnsupported = false;
    thinkingByRow = {};
    openReplyRootId = null;
    openProfileMember = null;
    openAgentMember = null;
    attachTray = null;
    replyPreviewByRoot = {};
    // Meetings is a module-level warm store. Rotate it with the visible
    // company boundary as well, otherwise a completed agenda request could
    // paint metadata from the previously selected workspace.
    configureMeetingsApi({
      accountId: tenantAccountId,
      meetings: adapter.meetings,
      feedback: adapter.feedback,
      settings: adapter.settings,
      storage: tenantStorage,
      sessionGeneration: tenantGeneration,
    });
    startMeetingsStore();
    if (view === "meetings") setMeetingsViewActive(true);
    void prefetchMeetings();
    void navigate({ kind: "messages" });
  }

  /**
   * The tenant the mention roster must be drawn from: the selected channel's
   * own company, falling back to the selected company scope. An unscoped
   * listContacts() seeds the picker with every company the user can see, which
   * is how a foreign-tenant agent became mentionable from a channel that had
   * nothing to do with it. Refetch whenever this changes — not once on mount.
   */
  const mentionRosterCompanyUid = $derived(
    selectedRow?.companyUid?.trim() || tenantCompanyId?.trim() || null,
  );

  // Plain (non-reactive) marker for the scope whose response we will accept.
  // Deliberately NOT $state: it is written inside the effect below, and making
  // it reactive would re-trigger that effect.
  let mentionRosterScope: string | null = null;

  $effect(() => {
    const scope = mentionRosterCompanyUid;
    // The roster is tenant-scoped data. Clear the previous company's rows
    // before the new fetch resolves so the picker can never offer a stale
    // foreign-tenant target during the gap.
    mentionRosterScope = scope;
    liveMentionTargets = [];
    let cancelled = false;
    void adapter.messaging
      .listContacts(scope ? { companyUid: scope } : undefined)
      .then((res) => {
        // Per-channel race guard: a slow in-flight response for the PREVIOUS
        // company must never overwrite the roster for the one now on screen.
        // `cancelled` alone is not enough — check the scope we resolved for
        // still matches the scope currently being displayed.
        if (cancelled || mentionRosterScope !== scope || !res.ok) return;
        // The roster request was tenant-scoped but the rows come back without a
        // company field, so stamp the scope on: that is what lets the picker
        // render "Izzy · Indigo" instead of a uid fragment.
        liveMentionTargets = stampMentionCompany(
          mentionTargetsFromContactsPayload(res.value),
          scope,
        );
      });
    return () => {
      cancelled = true;
    };
  });

  onDestroy(() => {
    stopScrollRestore();
    // Account transitions unmount the shared shell; never leave its singleton
    // cache/snapshot visible until the next identity has finished hydrating.
    configureMeetingsApi(null);
  });

  const mentionRoster = $derived(
    // Resolve companyUid → company label, then re-run disambiguation so two
    // survivors that share a display name render "Izzy (LiveRecover)" vs
    // "Izzy (Indigo)" instead of two identical, unpickable rows.
    disambiguateMentionTargets(
      mergeMentionRosters(
        mentionCandidates,
        liveMentionTargets,
        mentionTargetsFromContacts(
          Object.entries(identities ?? {}).map(([personUid, displayName]) => ({
            personUid,
            displayName,
          })),
        ),
        // Everyone already IN the open channel. A teammate's personal bot is
        // not on the company contacts roster (it has no membership), so
        // without this a channel member could never @mention it — the picker
        // said "No one matches" while the bot sat on the roster.
        mentionTargetsFromContacts(
          (selectedRow?.channelId
            ? (channelRosterById[selectedRow.channelId.trim()] ?? [])
            : []
          ).map((member) => ({
            personUid: member.personUid,
            displayName: member.displayName,
          })),
        ),
        // The user's own local bots: never on the contacts roster, but
        // @mentionable anywhere the user can add them.
        mentionTargetsFromContacts(
          localBots.map((bot) => ({ personUid: bot.agentUid, displayName: bot.name })),
        ),
      ).map((target) => {
        if (!target.companyUid || target.companyName) return target;
        const name = companyDisplayName(target.companyUid, companyNames);
        return name ? { ...target, companyName: name } : target;
      }),
    ),
  );

  async function applyChannelWake(wake: {
    channelId: string;
    eventId?: string;
    createdAt?: string;
    fromPersonUid?: string;
  }): Promise<void> {
    // An agent's reply in a channel that is NOT open ends its thinking row
    // there too — otherwise the stale status greets the user on return. The
    // open channel clears from the fetched page below (same timestamp rule).
    const wakeFrom = (wake.fromPersonUid ?? "").trim();
    if (wakeFrom && isAgentUid(wakeFrom)) {
      clearThinkingFromIncoming(
        [{ fromPersonUid: wakeFrom, createdAt: wake.createdAt ?? null }],
        `ch:${wake.channelId}`,
      );
    }
    const row = selectedRow;
    if (!row?.channelId) return;
    if (row.channelId !== wake.channelId && row.id !== `ch:${wake.channelId}`) {
      return;
    }
    // In-place lifecycle-card updates reuse the same eventId. Skip the
    // already-seen short-circuit and drop `since` so the rewritten envelope
    // is in the page. New events keep main's createdAt short-circuit.
    const already = timelineHasEvent(liveTimeline, wake.eventId);
    if (!already) {
      const wakeAt = (wake.createdAt ?? "").trim();
      if (
        wakeAt &&
        liveTimeline.some((message) => (message.createdAt ?? "") >= wakeAt)
      ) {
        return;
      }
    }
    const res = await adapter.messaging.fetchChannel({
      channelId: row.channelId,
      limit: 20,
      since: already
        ? undefined
        : sinceForChannelWake(liveTimeline, wake.createdAt),
    });
    if (!res.ok) return;
    if (selectedRow?.id !== row.id) return;
    const incoming = messagesForDisplay(res.value);
    commitTimeline(row, mergeFetchedTimeline(liveTimeline, res.value));
    clearThinkingFromIncoming(incoming, row.id);
  }

  /**
   * `backfill` fetches the inbox page WITHOUT the stored `since` cursor, so a
   * machine that already holds a cursor still re-reads recent DM history and
   * can stamp older-day rail rows. It deliberately does not advance the
   * cursor: unread deltas stay the incremental path's job.
   */
  async function catchUpDmInbox(
    { backfill = false }: { backfill?: boolean } = {},
  ): Promise<void> {
    const bus = wakes;
    if (!bus) return;
    const expectedGeneration = tenantGeneration;
    const expectedCompanyId = tenantCompanyId;
    const storage = tenantStorage;
    const since = backfill
      ? undefined
      : storage?.getItem(DM_INBOX_SINCE_KEY)?.trim() || undefined;
    const notifications = adapter.notifications;
    if (!notifications || typeof notifications.fetchDmInbox !== "function") {
      return;
    }
    // The inbox is a feed of messages RECEIVED, capped to a window: a pair
    // where the owner sent last, or whose history predates the window, has
    // no row in it. The backfill pass therefore also reads the per-user DM
    // peer index (GET /v1/notify/dm-threads), which is stamped for both
    // directions. Feature-detected: a 404 (older server) or a host without
    // the method falls back to inbox-only, so old servers keep working.
    const wantThreads =
      backfill &&
      !dmThreadsUnsupported &&
      typeof notifications.fetchDmThreads === "function";
    const [res, threadsRes] = await Promise.all([
      raceTimeout(
        notifications.fetchDmInbox({
          ...(since ? { since } : {}),
          limit: "50",
        }),
        bootTimeoutMs,
        "dm-inbox",
      ).catch(() => failure("timeout", "dm-inbox timed out")),
      wantThreads
        ? raceTimeout(
            notifications.fetchDmThreads!({ limit: 100 }),
            bootTimeoutMs,
            "dm-threads",
          ).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (
      expectedGeneration !== tenantGeneration ||
      expectedCompanyId !== tenantCompanyId
    ) {
      return;
    }
    let threadActivity: InboxDmActivity[] = [];
    if (threadsRes) {
      if (threadsRes.ok) {
        threadActivity = dmActivityFromThreadsPage(threadsRes.value, {
          selfUid: self?.uid,
        });
      } else if (isMissingEndpointFailure(threadsRes)) {
        dmThreadsUnsupported = true;
      }
    }
    if (!res.ok) {
      if (threadActivity.length > 0) {
        bus.emit?.("dm:pair-unreads", { activity: threadActivity });
      }
      return;
    }
    const parsed = pairUnreadsFromInboxPage(res.value, {
      since,
      selfUid: self?.uid,
    });
    const activity = mergeDmActivity(
      dmActivityFromInboxPage(res.value, { selfUid: self?.uid }),
      threadActivity,
    );
    const hasUnreads = Boolean(
      parsed.pairUnreads && parsed.pairUnreads.length > 0,
    );
    const hasActivity = activity.length > 0;
    if (hasUnreads || hasActivity) {
      bus.emit?.("dm:pair-unreads", {
        ...(hasUnreads
          ? {
              pairUnreads: parsed.pairUnreads,
              ...(parsed.delta ? { delta: true } : {}),
            }
          : {}),
        ...(hasActivity ? { activity } : {}),
      });
    }
    if (!backfill && parsed.nextSince)
      storage?.setItem(DM_INBOX_SINCE_KEY, parsed.nextSince);
  }

  $effect(() => {
    const bus = wakes;
    if (!bus) return;
    const unsubs = [
      bus.on("channel:new-message", (wake) => {
        void applyChannelWake(wake);
      }),
      bus.on("dm:new-message", (wake) => {
        // An inbound agent DM ends that agent's thinking row even when its
        // conversation is not open (the open one clears from its page).
        const from = (wake.fromPersonUid ?? "").trim();
        if (wake.direction !== "out" && from && isAgentUid(from)) {
          clearThinkingFromIncoming(
            [{ fromPersonUid: from, createdAt: wake.createdAt ?? null }],
            `dm:${from}`,
          );
        }
        void catchUpDmInbox();
      }),
      bus.on("mesh:catchup", () => {
        const row = selectedRow;
        if (row) void catchUpTimeline(row);
        // Thread events arrive on hq/{companyUid}/thread/# as ids-only wakes,
        // so a catch-up must re-read the project trail too — otherwise a live
        // progress event only appears after the user leaves and returns.
        if (row && activityKeyForRow(row)) void loadProjectActivity(row);
        void catchUpDmInbox();
      }),
      bus.on("work-mesh:thread", ({ companyUid }) => {
        const row = selectedRow;
        if (!row || !activityKeyForRow(row)) return;
        if ((row.companyUid ?? "").trim() !== companyUid) return;
        void loadProjectActivity(row);
      }),
      bus.on("mesh:connection", ({ state }) => {
        meshConnectionState = state;
      }),
    ];
    return () => {
      for (const off of unsubs) off();
    };
  });

  // Stamp DM history on a fresh load (and tenant switch), not only after a
  // live wake. untrack so the fetch itself cannot retrigger this effect.
  $effect(() => {
    void tenantGeneration;
    void tenantCompanyId;
    lastDmTimelineStampByUid.clear();
    lastChannelTimelineStampById.clear();
    dmThreadsUnsupported = false;
    if (!wakes) return;
    untrack(() => {
      void catchUpDmInbox({ backfill: true });
    });
  });

  $effect(() => {
    const row = selectedRow;
    const arm = shouldArmDirectorySafety(meshConnectionState);
    if (!row || !arm) return;
    const id = row.id;
    const tick = () => {
      if (selectedRow?.id !== id) return;
      void catchUpTimeline(row);
    };
    const handle = setInterval(tick, TIMELINE_SAFETY_INTERVAL_MS);
    return () => clearInterval(handle);
  });

  function attachmentCompanyUid(row: ConversationRow | null): string | null {
    return attachmentVaultScopeUid({
      row,
      selfUid: self?.uid,
    });
  }

  const channelFilePreviewContext = $derived(
    JSON.stringify({
      account: self?.uid?.trim() || null,
      companyUid: attachmentCompanyUid(selectedRow),
      conversationId: selectedRow?.id ?? null,
    }),
  );

  /** Upload files for the selected row — shared by the main composer send and
      the ReplyPanel attach seam. */
  async function uploadFilesForSelectedRow(
    files: File[],
  ): Promise<Awaited<ReturnType<typeof uploadChatAttachments>>> {
    const row = selectedRow;
    if (!row) throw new Error("Nothing to send");
    const companyUid = attachmentCompanyUid(row);
    if (!companyUid) {
      throw new Error("Pick a company before attaching a file");
    }
    const isDm = row.kind === "dm" && !!row.personUid;
    const selfUid = self?.uid?.trim() ?? "";
    const cache = imagePreviewCache;
    const uploaded = await uploadChatAttachments({
      files,
      companyUid,
      scope: isDm ? "dm" : "chan",
      scopeId: isDm
        ? conversationPairKey(selfUid, row.personUid ?? "")
        : (row.channelId?.trim() ?? ""),
      presignPut: (cmp, key, contentType) =>
        adapter.files.presignVaultPut(cmp, key, contentType),
      // Vault buckets have no CORS. Web hops through same-origin; desktop
      // sends bytes from Rust so WKWebView never PUTs to S3.
      putObject:
        adapter.kind === "web"
          ? (url, headers, file) =>
              fetch("/api/chat-attachment-upload", {
                method: "PUT",
                headers: { ...headers, "x-hq-upload-url": url },
                body: file,
              })
          : putAttachmentObject,
    });
    // Preserve the local upload preview under its final immutable vault path.
    void Promise.all(uploaded.map(async (item, index) => {
      if (item.kind !== "image" || !cache) return;
      try { await cache.warm(item.companyUid, item.vaultPath, files[index]); }
      catch (error) { console.warn("[image-preview] Upload preview unavailable", error); }
    }));
    return uploaded;
  }

  async function persistSend(
    body: string,
    mentions: MentionTarget[],
    files: File[] = [],
  ): Promise<void> {
    const row = selectedRow;
    if (!row || (!body.trim() && files.length === 0)) {
      throw new Error("Nothing to send");
    }
    // While the Setup Agent is listening, the composer is its reply box.
    if (isSetupChannel(row.channelId) && setupAgent.listening && files.length === 0) {
      await setupAgent.reply(body.trim());
      if (setupAgent.error) throw new Error(setupAgent.error);
      return;
    }
    try {
      let attachments:
        Awaited<ReturnType<typeof uploadChatAttachments>> | undefined;
      if (files.length > 0) {
        attachments = await uploadFilesForSelectedRow(files);
      }
      const extras = {
        body,
        fromPersonUid: self?.uid?.trim() || null,
        fromDisplayName: self?.displayName?.trim() || "You",
        mentions: mentions.length > 0 ? mentions : undefined,
        attachments,
      };
      if (row.kind === "dm" && row.personUid) {
        const res = await adapter.messaging.sendDm(row.personUid, body, {
          attachments,
        });
        if (!res.ok) {
          throw new Error(res.message || "Could not send the message");
        }
        const wire = sentMessageFromResult(res.value, extras);
        if (wire)
          commitTimeline(row, mergeTimelineMessages(liveTimeline, [wire]));
        // A 1:1 DM with an agent is inherently addressed to that agent, so
        // any send starts the indicator — no @mention required (unlike a
        // channel, where only an explicit mention wakes an agent). Started
        // before the catch-up below so a page that already carries the reply
        // clears it immediately.
        if (isAgentUid(row.personUid)) {
          // Pin the row to "newer than the agent's last message" — a local
          // bot's previous reply is usually < 2 min old and would otherwise
          // clear the fresh row on the next catch-up (skew fallback).
          thinkingByRow = startThinkingIn(
            thinkingByRow,
            row.id,
            {
              agentUid: row.personUid,
              agentName: row.title?.trim() || "Bot",
            },
            Date.now(),
            { afterMs: newestMessageAtFrom(liveTimeline, row.personUid) },
          );
        }
        if (!wire) {
          try {
            await catchUpTimeline(row);
          } catch (err) {
            console.warn("[hq-desktop] post-send DM catch-up failed", err);
          }
        }
        return;
      }
      const channelId = row.channelId?.trim() ?? "";
      if (!channelId) throw new Error("No channel to send to");
      if (!channelId.startsWith("chn_") && !isSetupChannel(channelId)) {
        throw new Error(
          "Couldn't send — this channel isn't linked yet. Try reopening it.",
        );
      }
      const res = await adapter.messaging.sendChannelMessage(channelId, body, {
        mentions: mentions.length > 0 ? mentions : undefined,
        attachments,
      });
      if (!res.ok) {
        throw new Error(res.message || "Could not send the message");
      }
      const wire = sentMessageFromResult(res.value, extras);
      if (wire) commitTimeline(row, mergeTimelineMessages(liveTimeline, [wire]));
      // Channel sends need an explicit @agent mention (agent DMs start their
      // row in the DM branch above).
      for (const mention of mentions) {
        if (mention.participantType !== "agent") continue;
        thinkingByRow = startThinkingIn(
          thinkingByRow,
          row.id,
          {
            agentUid: mention.participantUid,
            agentName: mention.displayName,
          },
          Date.now(),
          // Pin to "newer than the agent's last post here" — same fast-
          // responder guard as the DM branch.
          { afterMs: newestMessageAtFrom(liveTimeline, mention.participantUid) },
        );
      }
      // Mention sends write a same-timestamp member_added sibling the POST
      // echo does not include. Catch-up/roster refresh are best-effort — a
      // failed follow-up must not surface as "Couldn't send" after the POST
      // already succeeded (dogfood: CHANNEL_NOT_FOUND after mention send).
      try {
        await catchUpTimeline(row);
        if (mentions.length > 0) await loadChannelRoster(channelId);
      } catch (err) {
        console.warn("[hq-desktop] post-send catch-up failed", err);
      }
    } catch (err) {
      // Send never left — drop this conversation's optimistic thinking rows
      // so the status cannot outlive a failed mention. Other conversations'
      // rows are unrelated to this failure and stay.
      thinkingByRow = dropRow(thinkingByRow, row.id);
      throw err;
    }
  }

  let imagePreviewCache = $state<ImagePreviewCache | null>(null);
  const imagePreviewStore = createImagePreviewStore();
  let previousPreviewAccount = "";
  let previousPreviewCache: ImagePreviewCache | null = null;
  $effect(() => {
    const account = self?.uid?.trim() || tenantAccountId?.trim() || "";
    void tenantGeneration;
    if (previousPreviewAccount && previousPreviewAccount !== account) {
      void previousPreviewCache?.clearAccount().catch((error) => {
        console.warn("[image-preview] Account cache cleanup failed", error);
      });
    }
    previousPreviewAccount = account;
    const cache = account ? new ImagePreviewCache({
      account,
      store: imagePreviewStore,
      load: async (scope, path) => {
        const signed = await adapter.files.presignVaultGet(scope, path);
        if (!signed.ok) throw new Error("Image unavailable");
        const url = presignUrlFromResult(signed.value)?.url;
        if (!url) throw new Error("Image URL missing");
        const response = await getVaultBytesForHost(url, 25 * 1024 * 1024);
        if (!response.ok) throw new Error("Image unavailable");
        return response.blob();
      },
    }) : null;
    imagePreviewCache = cache;
    previousPreviewCache = cache;
    return () => cache?.dispose();
  });

  // Warm only a small recent slice; the cache limits concurrent byte/decode work.
  $effect(() => {
    const cache = imagePreviewCache;
    const scope = attachmentCompanyUid(selectedRow);
    const images = liveTimeline.slice(-20).flatMap(parseMessageAttachments)
      .filter((item) => item.kind === "image" && item.contentType !== "image/svg+xml" && !/\.svg$/i.test(item.name)).slice(-8);
    if (!cache || !scope) return;
    for (const item of images) {
      void cache.warm(item.companyUid || scope, item.vaultPath).catch(() => {
        // The visible attachment owns the accessible retry/error state.
      });
    }
  });

  async function signOutWithImageCleanup(): Promise<void> {
    navigation.clear();
    stopScrollRestore();
    pendingRestoreScroll = null;
    const cache = imagePreviewCache;
    await onsignout?.();
    try { await cache?.clearAccount(); }
    catch (error) { console.warn("[image-preview] Sign-out cache cleanup failed", error); }
  }

  async function presignAttachment(
    companyUid: string,
    vaultPath: string,
  ): Promise<string | null> {
    try {
      const signed = await adapter.files.presignVaultGet(companyUid, vaultPath);
      if (!signed.ok) return null;
      const url = presignUrlFromResult(signed.value)?.url ?? null;
      if (!url || !getAttachmentObject) return url;
      // Desktop: the packaged CSP deliberately blocks remote img-src (no
      // tracking pixels), so <img> can never load the presigned https URL.
      // Pull the bytes over the host's S3 hop and hand back a blob: URL.
      const res = await getAttachmentObject(url);
      if (!res.ok) return null;
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  function releaseAttachmentUrl(url: string): void {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }

  function openAttachmentTray(
    item: FileAttachmentModel,
    items: FileAttachmentModel[] = [],
  ): void {
    const companyUid = attachmentCompanyUid(selectedRow);
    const stamped = (items.length > 0 ? items : [item]).map((entry) => ({
      ...entry,
      companyUid: entry.companyUid || companyUid || "",
    }));
    attachTray = {
      selectedId: item.id || item.vaultPath,
      items: stamped,
    };
  }

  async function resolveTrayUrl(
    item: FileAttachmentModel,
  ): Promise<string | null> {
    if (item.previewUrl) return item.previewUrl;
    const companyUid = item.companyUid || attachmentCompanyUid(selectedRow);
    if (!companyUid || !item.vaultPath) return null;
    // presignAttachment already returns blob: bytes on desktop hosts.
    return presignAttachment(companyUid, item.vaultPath);
  }

  function previewFailure(message: string | null | undefined): ChannelFilePreview {
    const detail = (message ?? "").toLowerCase();
    if (/denied|forbidden|membership|unauth|403/.test(detail)) {
      return { kind: "unavailable", state: "denied", message: "You don't have access to this file." };
    }
    if (/not.?found|missing|404/.test(detail)) {
      return { kind: "unavailable", state: "missing", message: "This file is no longer available." };
    }
    if (/large|limit|size/.test(detail)) {
      return { kind: "unavailable", state: "too-large", message: "This file is too large to preview safely." };
    }
    if (/offline|network|timeout|5\d\d/.test(detail)) {
      return { kind: "unavailable", state: "offline", message: "Couldn't reach the file service. Try again when you're online." };
    }
    return { kind: "unavailable", state: "unsupported", message: "This file can't be previewed safely." };
  }

  function base64Bytes(raw: string): Uint8Array | null {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 !== 0) return null;
    try {
      const binary = atob(raw);
      return Uint8Array.from(binary, (char) => char.charCodeAt(0));
    } catch {
      return null;
    }
  }

  async function loadLocalFilePreview(
    item: ChannelFileItemModel,
  ): Promise<ChannelFilePreview> {
    const localPath = item.localPath?.trim();
    if (!localPath) return previewFailure("missing local file path");
    const result = await adapter.files.getAuthorizedPreview(localPath);
    if (!result.ok) return previewFailure(result.message ?? result.reason);
    const payload = result.value as unknown as Record<string, unknown>;
    const mimeType = typeof payload.mimeType === "string" ? payload.mimeType.toLowerCase() : "";
    const dataBase64 = typeof payload.dataBase64 === "string" ? payload.dataBase64 : "";
    const bytes = base64Bytes(dataBase64);
    if (!bytes) return previewFailure("invalid native preview");
    if (mimeType === "application/pdf") {
      return { kind: "pdf", url: `data:${mimeType};base64,${dataBase64}` };
    }
    if (new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]).has(mimeType)) {
      return { kind: "image", url: `data:${mimeType};base64,${dataBase64}` };
    }
    if (mimeType.startsWith("text/") || mimeType === "application/json") {
      try {
        return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
      } catch {
        return { kind: "unavailable", state: "binary", message: "This binary file can't be previewed safely." };
      }
    }
    return previewFailure("unsupported preview type");
  }

  async function loadChannelFilePreview(
    item: ChannelFileItemModel,
  ): Promise<ChannelFilePreview> {
    if (loadFilePreview) return loadFilePreview(item);
    const selectedCompanyUid = attachmentCompanyUid(selectedRow);
    if (!fileCompanyScope(item, selectedCompanyUid)) {
      return {
        kind: "unavailable",
        state: "denied",
        message: "This file is not available in the current company.",
      };
    }
    if (item.localPath?.trim()) return loadLocalFilePreview(item);
    return loadVaultFilePreview({
      item,
      selectedCompanyUid,
      presign: (companyUid, key) => adapter.files.presignVaultGet(companyUid, key),
      get: getVaultBytesForHost,
    });
  }

  function canPerformChannelFileAction(item: ChannelFileItemModel): boolean {
    return Boolean(
      !item.accessDenied &&
        item.localPath?.trim() &&
        fileCompanyScope(item, attachmentCompanyUid(selectedRow)),
    );
  }

  async function revealChannelFile(item: ChannelFileItemModel): Promise<void> {
    if (!canPerformChannelFileAction(item)) {
      throw new Error("This file is not authorized for the current conversation.");
    }
    const localPath = item.localPath?.trim();
    if (!localPath) throw new Error("No authorized local mirror is available.");
    const result = await adapter.files.revealInFinder(localPath);
    if (!result.ok) throw new Error(result.message ?? "Reveal failed");
  }

  async function openChannelFile(item: ChannelFileItemModel): Promise<void> {
    if (!canPerformChannelFileAction(item)) {
      throw new Error("This file is not authorized for the current conversation.");
    }
    const localPath = item.localPath?.trim();
    if (!localPath) throw new Error("No authorized local mirror is available.");
    const result = await adapter.shell.openFileInClaude(localPath);
    if (!result.ok) throw new Error(result.message ?? "Open failed");
  }

  function openNotification(item: NotificationItem): void {
    const dest = notificationDestination(item);
    if (dest.kind === "dm") {
      const stub: ConversationRow = {
        id: `dm:${dest.personUid}`,
        kind: "dm",
        title: dest.title,
        companyUid: null,
        unreadDot: false,
        lastActivityAt: item.createdAtMs,
        pinned: false,
        personUid: dest.personUid,
      };
      const existing =
        resolveConversationRow(stub, railRows) ??
        (searchRows ?? []).find(
          (row) => row.personUid === dest.personUid && !row.channelId,
        );
      handleSelect(existing ?? stub, {
        replyRootEventId: dest.replyRootEventId,
      });
      return;
    }
    if (dest.kind === "files") {
      // Share rows do not include a company UID. Route to the bounded,
      // server-scoped share list rather than guessing a tenant or aliasing it.
      void navigate({ kind: "shared-files" });
    }
    if (dest.kind === "channel") {
      const row = railRows.find((candidate) => candidate.channelId === dest.channelId);
      if (row) {
        handleSelect(row, { replyRootEventId: dest.replyRootEventId });
      } else {
        requestChannelOpen(dest.channelId, {
          replyRootEventId: dest.replyRootEventId ?? null,
        });
      }
    }
  }

  function openLibrary(next: LibraryTab = "skills"): void {
    void navigate({ kind: "library", tab: next });
  }

  function toggleNotifications(): void {
    if (view === "notifications") void navigate({ kind: "messages" });
    else void navigate({ kind: "notifications" });
  }

  function openSettings(section: EmbeddedSettingsSection | null = null): void {
    void navigate({ kind: "settings", section });
  }

  function extraDestination(
    page: string,
    param: string | null,
  ): NavigationDestination {
    const fromParam = extraParamCompanyKey(param);
    let inherited: string | null = null;
    if (
      !fromParam &&
      page === extraPageId &&
      param &&
      param !== "new" &&
      !param.startsWith("new?")
    ) {
      const current = navigationHistory.current();
      inherited =
        extraParamCompanyKey(extraPageParam) ??
        (current?.destination.kind === "extra"
          ? (current.destination.companyUid ?? null)
          : null) ??
        current?.companyUid ??
        null;
    }
    const companyUid = fromParam ?? inherited;
    return companyUid
      ? { kind: "extra", page, param, companyUid }
      : { kind: "extra", page, param };
  }

  function openExtraPage(id: string, param: string | null = null): void {
    void navigate(extraDestination(id, param));
  }

  function onShellLinkEvent(event: Event): void {
    handleLinkActivate(event, {
      onopenurl,
      onmenu: (menu) => (linkMenu = menu),
      mode: "shell",
    });
  }

  function closeSettings(): void {
    void leaveCurrentDestination();
  }

  /** Apply a host route after DesktopApp's event listeners have mounted. */
  function applyEmbeddedNavigation(target: EmbeddedNavigationTarget): void {
    const destination = destinationFromEmbeddedTarget(target);
    if (!destination) {
      embeddedNavigationError =
        target.kind === "unsupported"
          ? `${target.reason}: ${target.route}`
          : "Unsupported embedded destination";
      return;
    }
    void navigate(destination);
  }

  function sweepStaleAttachmentTrays(reason: string): void {
    if (attachTray) return;
    const leftovers = document.querySelectorAll(
      "[data-testid='attachment-tray']",
    );
    if (leftovers.length === 0) return;
    console.warn("[hq-desktop]", {
      t: Date.now(),
      event: "stale-attachment-tray-removed",
      reason,
      count: leftovers.length,
    });
    leftovers.forEach((node) => node.remove());
  }

  onMount(() => {
    attachTray = null;
    sweepStaleAttachmentTrays("mount");
    const onPointerDown = () => sweepStaleAttachmentTrays("pointerdown");
    window.addEventListener("pointerdown", onPointerDown, true);
    applyColorTheme(readStoredTheme());
    const prefs = readSettingsPrefs(tenantStorage);
    applyUiSize(prefs.uiSize);
    applyWindowOpacity(prefs.windowOpacity);
    const overlayQuery = window.matchMedia(
      `(max-width: ${REPLY_OVERLAY_MAX_PX}px)`,
    );
    const syncOverlay = () => {
      narrowViewport = overlayQuery.matches;
    };
    syncOverlay();
    overlayQuery.addEventListener("change", syncOverlay);

    let syncTimer: number | undefined;
    if (adapter.isAvailable("canSync")) {
      void readLiveSyncStatus(adapter).then((next) => {
        liveSync = next;
      });
      syncTimer = window.setInterval(() => {
        void readLiveSyncStatus(adapter).then((next) => {
          liveSync = next;
        });
      }, 30_000);
    }
    // Warm the pack cache at launch so Core open is a cache read, not `hq`.
    if (adapter.isAvailable("canManagePackages")) {
      void adapter.packages.listPackages();
    }

    // US-010: warm the meetings singleton at launch so the first Meetings
    // open paints from state instead of a cold fetch. View-active gating
    // (poll + focus refresh) stays owned by MeetingsPage.
    configureMeetingsApi({
      accountId: tenantAccountId,
      meetings: adapter.meetings,
      feedback: adapter.feedback,
      settings: adapter.settings,
      storage: tenantStorage,
      sessionGeneration: tenantGeneration,
    });
    startMeetingsStore();
    void prefetchMeetings();

    // US-016: `g a` opens Atlas (Slack-style go chord).
    const goChord = createGoChord((letter) => {
      if (letter !== "a") return false;
      void navigate({ kind: "atlas" });
      return true;
    });

    function onKey(event: KeyboardEvent) {
      if (
        consumeNavigationShortcut(event, {
          onBack: () => {
            if (navigationHistory.canGoBack()) void goBack();
          },
          onForward: () => {
            if (navigationHistory.canGoForward()) void goForward();
          },
        })
      ) {
        goChord.reset();
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      if (meta) {
        const key = event.key.toLowerCase();
        if (key === "k") {
          event.preventDefault();
          paletteOpen = !paletteOpen;
          goChord.reset();
        } else if (key === ",") {
          // macOS-standard ⌘, opens Settings.
          event.preventDefault();
          openSettings();
        } else if (key === "1") {
          event.preventDefault();
          void navigate({ kind: "notifications" });
        } else if (key === "2") {
          event.preventDefault();
          void navigate({ kind: "meetings" });
        } else if (adapter.kind !== "web" && key === "3") {
          event.preventDefault();
          openLibrary("marketplace");
        } else if (key === "4") {
          event.preventDefault();
          openLibrary("skills");
        }
        return;
      }
      if (paletteOpen) return;
      if (goChord.handleKeydown(event)) {
        event.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey);

    function onOpenChannel(event: Event): void {
      const detail = (event as CustomEvent<PendingChannelOpen>).detail;
      const channelId = detail?.channelId?.trim() ?? "";
      if (!channelId) return;
      const reply = detail.replyRootEventId ?? null;
      // Same channel while already on the conversation view → no-op.
      // If Settings/inbox/etc. is open, still force view back to chat.
      if (
        !reply &&
        selectedRow?.channelId === channelId &&
        view === "conversation"
      )
        return;
      applyPendingChannelOpen({
        channelId,
        messageId: detail.messageId ?? null,
        createdAt: detail.createdAt ?? null,
        replyRootEventId: reply,
        automatic: detail.automatic === true,
        title: detail.title ?? null,
        companyUid: detail.companyUid ?? null,
        focusCardId: detail.focusCardId ?? null,
        focusCardKind: detail.focusCardKind ?? null,
      });
    }
    function onMessagePerson(event: Event): void {
      const detail = (event as CustomEvent<ConversationTarget>).detail;
      const personUid = detail?.personUid?.trim() ?? "";
      if (!personUid) return;
      const reply = detail.replyRootEventId ?? null;
      if (
        !reply &&
        selectedRow?.personUid === personUid &&
        !selectedRow.channelId &&
        view === "conversation"
      )
        return;
      applyPendingConversation({ ...detail, automatic: detail.automatic === true });
    }
  function onOpenSettingsEvent(): void {
      openSettings();
    }
    function onEmbeddedNavigation(event: Event): void {
      const target = (event as CustomEvent<EmbeddedNavigationTarget>).detail;
      if (!target || typeof target !== "object" || !("kind" in target)) return;
      applyEmbeddedNavigation(target);
    }
    window.addEventListener(OPEN_CHANNEL_EVENT, onOpenChannel);
    window.addEventListener(MESSAGE_PERSON_EVENT, onMessagePerson);
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpenSettingsEvent);
    window.addEventListener(EMBEDDED_NAVIGATION_EVENT, onEmbeddedNavigation);

    applyConversationDeepLink(conversationDeepLinkFromLocation());
    const pendingChannel = takePendingChannelOpen();
    if (pendingChannel) applyPendingChannelOpen(pendingChannel);
    const pendingDm = takePendingConversation();
    if (pendingDm) applyPendingConversation(pendingDm);
    const detachEmbeddedNavigation = onembeddednavigationready?.();

    return () => {
      detachEmbeddedNavigation?.();
      if (focusCardTimer !== undefined) clearTimeout(focusCardTimer);
      overlayQuery.removeEventListener("change", syncOverlay);
      if (syncTimer !== undefined) window.clearInterval(syncTimer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenSettingsEvent);
      window.removeEventListener(OPEN_CHANNEL_EVENT, onOpenChannel);
      window.removeEventListener(MESSAGE_PERSON_EVENT, onMessagePerson);
      window.removeEventListener(EMBEDDED_NAVIGATION_EVENT, onEmbeddedNavigation);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="desktop-shell chat-shell"
  class:has-window-controls={hasWindowControls}
  data-testid="desktop-shell"
  onclick={onShellLinkEvent}
  onauxclick={onShellLinkEvent}
  oncontextmenu={onShellLinkEvent}
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") onShellLinkEvent(e);
  }}
>
  <V4TitleBar
    {adapter}
    {version}
    primaryAction={(() => {
      const entry = Object.entries(extraPages ?? {}).find(([, page]) => page.createAction);
      if (!entry) return undefined;
      const [id, page] = entry;
      const action = page.createAction!;
      return { label: action.label, onselect: () => openExtraPage(id, action.param()) };
    })()}
    syncState={liveSyncState}
    {lastSyncLabel}
    conflictCount={liveSync.conflicts}
    watchedCount={watched}
    {unreadCount}
    {sidebarCollapsed}
    coreUseFixtures={coreFixtures}
    ontogglesidebar={() => (sidebarCollapsed = !sidebarCollapsed)}
    onopenNotifications={toggleNotifications}
    onopenMeetings={() => {
      void navigate({ kind: "meetings" });
    }}
    onOpenSettings={() => openSettings()}
    onopenLibrary={() => openLibrary("skills")}
    onopenMarketplace={isWeb ? undefined : () => openLibrary("marketplace")}
    {onopenurl}
    canGoBack={navigationCanGoBack}
    canGoForward={navigationCanGoForward}
    backLabel={navigationBackLabel}
    forwardLabel={navigationForwardLabel}
    onback={() => void goBack()}
    onforward={() => void goForward()}
  />

  {#if recommendBanner}
    <RecommendedUpdateBanner
      version={recommendBanner.version}
      message={recommendBanner.message}
      installing={recommendInstalling}
      onupdate={() => void handleRecommendedUpdateNow()}
      ondismiss={dismissRecommendBanner}
    />
  {/if}

  {#if embeddedNavigationError}
    <div
      class="embedded-navigation-error"
      data-testid="embedded-navigation-error"
      role="alert"
    >
      Couldn’t open requested destination. {embeddedNavigationError}
    </div>
  {/if}

  {#if navigationPending}
    <div
      class="embedded-navigation-error"
      data-testid="navigation-pending"
      role="status"
      aria-busy="true"
    >
      Opening destination…
    </div>
  {/if}

  <ConfirmDialog
    open={deleteChannelConfirmOpen && selectedRow != null}
    title={`Delete #${selectedRow?.title ?? "channel"}?`}
    message="This permanently deletes the channel and its messages for everyone in it. This can't be undone."
    confirmLabel="Delete channel"
    danger
    oncancel={() => (deleteChannelConfirmOpen = false)}
    onconfirm={() => void deleteSelectedChannel()}
  />

  <MigrateSessionDialog
    open={migrateSessionTarget != null}
    sessionId={migrateSessionTarget?.sessionId ?? ""}
    sourceLabel={companyDisplayName(
      migrateSessionTarget?.sourceCompanyUid ?? null,
      companyNames,
    )}
    destinations={migrateDestinationCompanies(
      companies,
      migrateSessionTarget?.sourceCompanyUid ?? "",
    )}
    submitting={migratingSessionId != null}
    error={migrateSessionError}
    oncancel={() => {
      if (!migratingSessionId) {
        migrateSessionTarget = null;
        migrateSessionError = null;
      }
    }}
    onconfirm={(destinationCompanyUid) =>
      void confirmMigrateSession(destinationCompanyUid)}
  />

  {#if navigationUnavailable}
    <div class="desktop-body" data-testid="navigation-unavailable-host">
      <div
        class="navigation-unavailable"
        data-testid="navigation-unavailable"
        role="alert"
      >
        <p>{navigationUnavailable.reason}</p>
        <button
          type="button"
          data-testid="navigation-unavailable-back"
          onclick={() => void goBack()}
          disabled={!navigationCanGoBack}
        >
          Back
        </button>
      </div>
    </div>
  {:else if view === "settings"}
    <!-- Settings is a full destination: it REPLACES everything below the
         titlebar. The channel rail is hidden and the whole area becomes the
         two-column Settings surface. -->
    <div class="desktop-body" data-testid="settings-host">
      <ShellSettings
        profile={resolvedSettingsProfile}
        {companies}
        {adapter}
        sessionGeneration={tenantGeneration}
        storage={tenantStorage}
        {version}
        initialSection={settingsSection}
        onsectionchange={(section) => openSettings(section)}
        onback={closeSettings}
        onsignout={onsignout ? signOutWithImageCleanup : undefined}
        onopenconsole={onOpenConsole
          ? (url) => onOpenConsole(url ?? HQ_CONSOLE_BASE)
          : undefined}
        consoleBase={HQ_CONSOLE_BASE}
        {updateWakeSeq}
        {refreshAppVersion}
      />
    </div>
  {:else}
    <div class="desktop-body" style:--sidebar-width={`${sidebarWidth}px`}>
      <!-- Kept mounted while closed at phone width: the list owns roster
           loading and the #setup fallback, so unmounting it leaves the phone
           with nothing selected. -->
      {#if !sidebarCollapsed || phoneViewport}
        {#key `${tenantGeneration}:${tenantCompanyId ?? "all"}`}
        <ChatSidebar
          offscreen={phoneViewport && sidebarCollapsed}
          api={sidebarApi}
          {wakes}
          {companies}
          {self}
          {isAdmin}
          accountLabel={resolvedAccountLabel}
          accountInitials={resolvedAccountInitials}
          selectedId={selectedRow?.id ?? null}
          scopeUid={tenantCompanyId}
          {tenantAccountId}
          {tenantCompanyId}
          {seedDirectory}
          {avatarByUid}
          {rosterWakeSeq}
          onavatarmap={(map) => (contactAvatarByUid = map)}
          onselect={(row, options) =>
            handleSelect(row, {
              preserveView: options?.automatic === true && view !== "conversation",
              automatic: options?.automatic === true,
            })}
          oncompanyscopechange={changeTenantCompany}
          oncommand={() => (paletteOpen = true)}
          onnavigateMessages={() => {
            void navigate({ kind: "messages" });
          }}
          onopenSettings={() => openSettings()}
          onsignout={onsignout ? signOutWithImageCleanup : undefined}
          oncreatecompany={canRunEntryPoints ? createCompanyEntry : null}
          oncreateagent={canRunEntryPoints ? addAgentEntry : null}
          oncreatebot={adapter.bots ? createBotEntry : null}
          botRuntimeReady={localBotRuntimeReady}
          botWorkers={localBotWorkers}
          {cloneCandidates}
          {existingBotNames}
          {botSignIn}
          onbotsignedin={onBotRuntimeSignedIn}
          loadAvatarPacks={adapter.identity ? loadAvatarPacks : null}
          {localBots}
          onrows={(rows) => {
            railRows = rows;
            directorySettled = true;
          }}
          {bootTimeoutMs}
          welcomeFirst={!welcomeSetupRun && !hasBootDeepLink && !initialRow}
          {onShellReady}
          projectHasPresence={rowHasProjectPresence}
          dmPresence={(row) => localBotPresence(localBots, row)}
          {rowExtrasLoading}
          {rowExtrasError}
          rowExtras={rowExtras ? (row) => rowExtras?.(row, view === "extra" && extraPageId ? { page: extraPageId, param: extraPageParam } : null) ?? null : null}
        />
        {/key}
        {#if !phoneViewport}<SidebarResizeHandle bind:width={sidebarWidth} />{/if}
      {/if}

      <main class="desktop-main" aria-label="Channel">
        <div
          class="notifications-layer"
          class:is-active={view === "notifications"}
        >
          <NotificationsView
            api={notificationsApi}
            wakeSeq={notificationWakeSeq}
            signedIn={Boolean(self)}
            onback={() => {
              void leaveCurrentDestination();
            }}
            onunreadchange={(n) => (unreadCount = n)}
            onopen={openNotification}
          />
        </div>
        {#if view === "shared-files"}
          <SharedFilesOverlay
            {adapter}
            onback={() => {
              void leaveCurrentDestination();
            }}
          />
        {:else if view === "extra" && extraPageId && extraPages?.[extraPageId]}
          {@const Page = extraPages[extraPageId].component}
          <div class="extra-page-host" data-testid="extra-page-host" data-page={extraPageId}>
            {#key `${extraPageId}:${extraPageParam ?? ""}`}
              <Page
                param={extraPageParam}
                restoreScroll={pendingRestoreScroll}
                onnavigate={(
                  next: string | null,
                  options?: { mode?: NavigationMode },
                ) => {
                  if (!extraPageId) return;
                  void navigate(
                    extraDestination(extraPageId, next),
                    options?.mode ?? "push",
                  );
                }}
              />
            {/key}
          </div>
        {:else if view === "meetings"}
          <MeetingsPage
            {adapter}
            accountId={tenantAccountId}
            storage={tenantStorage}
            sessionGeneration={tenantGeneration}
            onback={() => {
              void leaveCurrentDestination();
            }}
            openExternal={onopenurl}
            focusRequest={meetingFocusRequest}
          />
        {:else if view === "atlas"}
          <AtlasPage
            companyUid={atlasCompanyUid}
            companyLabel={atlasCompanyLabel}
            featureEnabled={true}
            headerVariant="embedded"
            canMigrate={canMigrateAtlasSessions &&
              migrateDestinationsForAtlas.length > 0}
            migrateDestinations={migrateDestinationsForAtlas}
            onmigratesession={(sessionId) =>
              openMigrateSession(sessionId, atlasCompanyUid)}
            migratingSessionId={migratingSessionId}
            onback={() => {
              void leaveCurrentDestination();
            }}
          />
        {:else if view === "conversation" && selectedRow}
          <header
            class="channel-header chat-shell"
            data-testid="channel-header"
          >
            <div class="channel-title-block">
              <div class="channel-title">
                {#if selectedIsCompanyChannel}
                  <!-- Company channels lead with the company's own mark. -->
                  <CompanyIcon iconUrl={selectedCompanyIcon} size={22} />
                {:else if selectedRow.kind === "channel"}
                  <span class="channel-hash" aria-hidden="true">#</span>
                {/if}
                {#if selectedRow.kind === "dm"}
                  {#if isAgentUid(selectedRow.personUid ?? "")}
                    <button
                      type="button"
                      class="channel-header-agent"
                      data-testid="channel-header-agent"
                      aria-label={`View bot ${headerTitle}`}
                      onclick={openAgentFromHeader}
                    >
                      <span
                        class="channel-header-avatar"
                        data-testid="channel-header-avatar"
                      >
                        <IdentityMark
                          kind="agent"
                          label={headerTitle}
                          agentUid={selectedRow.personUid}
                          avatarUrl={authorAvatarUrl(
                            selectedRow.personUid,
                            avatarByUid,
                          )}
                          size="small"
                          online={presenceStatus(
                            selectedRow.companyUid ?? "",
                            selectedRow.personUid ?? "",
                          ) === "online"}
                        />
                      </span>
                      <h2 data-testid="channel-name">{headerTitle}</h2>
                      <BotKindChip
                        kind={botKindFor(selectedRow.personUid, localBots) ?? "cloud"}
                        runtime={selectedLocalBot?.runtime ?? null}
                        size="md"
                      />
                    </button>
                  {:else}
                    <span
                      class="channel-header-avatar"
                      data-testid="channel-header-avatar"
                    >
                      <IdentityMark
                        kind="person"
                        label={headerTitle}
                        agentUid={selectedRow.personUid}
                        avatarUrl={authorAvatarUrl(
                          selectedRow.personUid,
                          avatarByUid,
                        )}
                        size="small"
                        online={presenceStatus(
                          selectedRow.companyUid ?? "",
                          selectedRow.personUid ?? "",
                        ) === "online"}
                      />
                    </span>
                    <h2 data-testid="channel-name">{headerTitle}</h2>
                  {/if}
                {:else}
                  <h2 data-testid="channel-name">{headerTitle}</h2>
                {/if}
                {#if channelSubtitle}
                  <span class="channel-sub-row">
                    <span class="channel-sub" data-testid="channel-sub"
                      >{channelSubtitle}</span
                    >
                    {#if isProjectChannel}
                      <button
                        type="button"
                        class="project-about-btn"
                        data-testid="project-about"
                        title="Project description"
                        aria-haspopup="dialog"
                        aria-expanded={projectAboutOpen}
                        aria-label="Project description"
                        onclick={() => (projectAboutOpen = !projectAboutOpen)}
                      >
                        <svg
                          viewBox="0 0 16 16"
                          width="14"
                          height="14"
                          fill="none"
                          aria-hidden="true"
                        >
                          <circle
                            cx="8"
                            cy="8"
                            r="5.25"
                            stroke="currentColor"
                            stroke-width="1.2"
                          />
                          <path
                            d="M8 7.15v3.2"
                            stroke="currentColor"
                            stroke-width="1.3"
                            stroke-linecap="round"
                          />
                          <circle
                            cx="8"
                            cy="5.35"
                            r="0.7"
                            fill="currentColor"
                          />
                        </svg>
                      </button>
                    {/if}
                  </span>
                {/if}
              </div>
            </div>

            <div class="channel-header-trailing">
              {#if canEditSelectedAgent}
                <button
                  type="button"
                  class="edit-profile-btn"
                  data-testid="agent-edit-profile"
                  onclick={openAgentProfileFromHeader}
                >
                  Edit profile
                </button>
              {/if}
              {#if isAgentChannel}
                <nav
                  class="project-tabs"
                  aria-label="Bot channel views"
                  data-testid="agent-channel-tabs"
                >
                  {#each AGENT_CHANNEL_TABS as t (t.id)}
                    <button
                      type="button"
                      class="project-tab"
                      class:active={agentSurface === t.id}
                      aria-current={agentSurface === t.id ? "page" : undefined}
                      data-testid={`agent-tab-${t.id}`}
                      onclick={() => pushConversationSurface({ agentSurface: t.id })}
                    >
                      <span>{t.label}</span>
                    </button>
                  {/each}
                </nav>
              {:else if isCompanyChannel}
                {#if companyTeamCanAct}
                  {#if headerAddAgentError}
                    <span
                      class="header-inline-error"
                      role="alert"
                      data-testid="company-add-agent-error"
                    >
                      {headerAddAgentError}
                    </span>
                  {/if}
                  <button
                    type="button"
                    class="header-ghost-btn"
                    data-testid="company-add-agent"
                    aria-label={`Add a bot to ${companyHeroTitle}`}
                    aria-busy={headerAddAgentBusy ? "true" : undefined}
                    disabled={headerAddAgentBusy}
                    onclick={() => void addAgentFromHeader()}
                  >
                    Add bot
                  </button>
                {/if}
                <CompanyTabs
                  active={companyTab}
                  onselect={(id) => pushConversationSurface({ companyTab: id })}
                />
              {:else if isProjectChannel}
                <nav
                  class="project-tabs"
                  aria-label="Channel views"
                  data-testid="channel-tabs"
                >
                  {#each CHANNEL_TABS as t (t.id)}
                    <button
                      type="button"
                      class="project-tab"
                      class:active={tab === t.id}
                      aria-current={tab === t.id ? "page" : undefined}
                      onclick={() => pushConversationSurface({ tab: t.id })}
                    >
                      <span class="project-tab-icon" aria-hidden="true">
                        {#if t.id === "chat"}
                          <svg
                            viewBox="0 0 16 16"
                            width="14"
                            height="14"
                            fill="none"
                          >
                            <path
                              d="M2.75 3.5h10.5v7.25H7.2L4 13.25V10.75H2.75V3.5Z"
                              stroke="currentColor"
                              stroke-width="1.2"
                              stroke-linejoin="round"
                            />
                          </svg>
                        {:else if t.id === "board"}
                          <svg
                            viewBox="0 0 16 16"
                            width="14"
                            height="14"
                            fill="none"
                          >
                            <rect
                              x="2.5"
                              y="2.5"
                              width="4"
                              height="11"
                              rx="0.75"
                              stroke="currentColor"
                              stroke-width="1.2"
                            />
                            <rect
                              x="9.5"
                              y="2.5"
                              width="4"
                              height="7"
                              rx="0.75"
                              stroke="currentColor"
                              stroke-width="1.2"
                            />
                          </svg>
                        {:else}
                          <svg
                            viewBox="0 0 16 16"
                            width="14"
                            height="14"
                            fill="none"
                          >
                            <path
                              d="M4 2.75h4.2L12 5.55V13.25H4V2.75Z"
                              stroke="currentColor"
                              stroke-width="1.2"
                              stroke-linejoin="round"
                            />
                            <path
                              d="M8.2 2.9v2.8H12"
                              stroke="currentColor"
                              stroke-width="1.2"
                              stroke-linejoin="round"
                            />
                          </svg>
                        {/if}
                      </span>
                      <span>{t.label}</span>
                    </button>
                  {/each}
                </nav>
              {/if}

              {#if showMemberPill}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                  class="member-pill-wrap"
                  onmousedown={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    class="member-count-btn"
                    data-testid="channel-members"
                    title="Members"
                    aria-haspopup="dialog"
                    aria-expanded={membersOpen}
                    aria-label={`View ${memberPillCount || "channel"} members`}
                    onclick={() => (membersOpen = !membersOpen)}
                  >
                    <span class="member-count-icon" aria-hidden="true">
                      <svg
                        viewBox="0 0 16 16"
                        width="14"
                        height="14"
                        fill="none"
                      >
                        <circle
                          cx="6"
                          cy="5.5"
                          r="2.25"
                          stroke="currentColor"
                          stroke-width="1.2"
                        />
                        <path
                          d="M2.5 12.5c.4-2 1.9-3 3.5-3s3.1 1 3.5 3"
                          stroke="currentColor"
                          stroke-width="1.2"
                          stroke-linecap="round"
                        />
                        <circle
                          cx="11"
                          cy="6"
                          r="1.75"
                          stroke="currentColor"
                          stroke-width="1.2"
                        />
                        <path
                          d="M11.5 9.5c1.2.2 2.2 1.1 2.5 2.5"
                          stroke="currentColor"
                          stroke-width="1.2"
                          stroke-linecap="round"
                        />
                      </svg>
                    </span>
                    <span class="member-count-num"
                      >{memberPillCount || "·"}</span
                    >
                    <Caret tone="var(--t3)" size="0.9em" />
                  </button>
                  {#if membersOpen && selectedRow}
                    <ChannelStatusPopover
                      model={channelStatus ??
                        rosterStatusForRow(
                          selectedRow,
                          channelRosterById[
                            selectedRow.channelId?.trim() ?? ""
                          ] ?? [],
                          selectedRow.companyUid
                            ? companyDisplayName(
                                selectedRow.companyUid,
                                companyNames,
                              )
                            : null,
                          selectedRow.companyUid
                            ? companyIconUrl(
                                selectedRow.companyUid,
                                companyIcons,
                              )
                            : null,
                        )}
                      {self}
                      {localBots}
                      onclose={() => (membersOpen = false)}
                      {onopenurl}
                      onopenprofile={(row) => {
                        membersOpen = false;
                        openMemberProfile(row);
                      }}
                      onremovemember={(row) => void removeMember(row)}
                      removingUid={removingMemberUid}
                      ondeletechannel={() => {
                        membersOpen = false;
                        deleteChannelConfirmOpen = true;
                      }}
                      deleting={deletingChannel}
                      onmigratesession={canMigrateSelectedChannelSessions &&
                      migrateDestinationsForSelected.length > 0
                        ? (sessionId) =>
                            openMigrateSession(
                              sessionId,
                              selectedRow?.companyUid?.trim() ?? "",
                            )
                        : undefined}
                      migratingSessionId={migratingSessionId}
                    />
                  {/if}
                </div>
              {/if}
            </div>
          </header>
          {#if channelActionError}
            <div
              class="channel-action-error"
              data-testid="channel-action-error"
              role="alert"
            >
              {channelActionError}
            </div>
          {/if}
          {#if projectAboutOpen && isProjectChannel}
            <ProjectAboutDialog
              title={headerTitle}
              description={channelStatus?.project.description ?? null}
              onclose={() => (projectAboutOpen = false)}
            />
          {/if}

          {#if isAgentChannel && agentSurface === "details" && agentChannelLocalBot}
            <LocalBotDetailPanel
              bot={agentChannelLocalBot}
              avatarUrl={avatarByUid[agentChannelLocalBot.agentUid] ?? null}
              {adapter}
              onchanged={refreshLocalBots}
              onclose={() => void leaveCurrentDestination()}
            />
          {:else if isAgentChannel && agentSurface === "details" && agentChannelUid}
            <AgentDetailPanel
              agentUid={agentChannelUid}
              {localBots}
              displayName={headerTitle}
              avatarUrl={avatarByUid[agentChannelUid] ?? null}
              companyUid={selectedRow?.companyUid}
              {companyNames}
              {self}
              {isAdmin}
              {adapter}
              packs={loadedAvatarPacks}
              avatarSaving={agentAvatarSaving}
              avatarSaveError={agentAvatarSaveError}
              onsaveavatar={saveOpenAgentAvatar}
              onclose={() => void leaveCurrentDestination()}
            />
          {:else if isCompanyChannel && companyTab !== "chat"}
            {#if companyTab === "team"}
              <TeamTab
                data={companyTabData ?? {
                  tab: "team",
                  companyUid: selectedRow.companyUid ?? "",
                  viewer: { canAct: false },
                  sections: [],
                }}
                onaction={handleTeamAction}
              />
            {:else if companyTab === "atlas"}
              <AtlasTab
                graph={companyTabData?.graph ?? { nodes: [], edges: [] }}
              />
            {:else if companyTab === "settings"}
              <SettingsTab
                data={companyTabData ?? {
                  tab: "settings",
                  companyUid: selectedRow.companyUid ?? "",
                  viewer: { canAct: false },
                  sections: [],
                }}
                onaction={handleTeamAction}
              />
            {:else}
              <div
                class="company-tab-placeholder"
                data-testid={`company-tab-panel-${companyTab}`}
              >
                {#if companyTabLoading}
                  Loading…
                {:else if (companyTabData?.sections[0]?.rows.length ?? 0) > 0}
                  <TeamTab data={companyTabData!} onaction={handleTeamAction} />
                {:else}
                  {String(companyTab).charAt(0).toUpperCase() + String(companyTab).slice(1)}
                {/if}
              </div>
            {/if}
          {:else if activeTab === "chat"}
            <div
              class="chat-stage"
              class:is-setup={isSetupChannel(selectedRow.channelId)}
              data-testid="chat-stage"
              data-reply-open={openReplyRootId ||
                openProfileMember ||
                openAgentMember
                ? "true"
                : "false"}
            >
              {#key selectedRow.id}
                {#snippet agentThinkingBelow()}
                  <!-- Inside the conversation scroller (typing-indicator
                       position) — a chat-stage sibling would become a second
                       flex-row column floating top-right. -->
                  {#if inSetupChannelWithAgent}
                    {@const agentState = setupAgent.state}
                    {@const stopFailure = setupAgent.failure}
                    <div class="setup-agent-prompt" data-testid="setup-agent-prompt">
                      {#if setupAgentDone}
                        <!-- Finished: one calm block with every next step. -->
                        <SetupFinale
                          onsessions={extraPages?.sessions
                            ? () =>
                                openExtraPage(
                                  "sessions",
                                  extraPages!.sessions.startworkAction?.param(startworkCompany) ??
                                    extraPages!.sessions.createAction?.param() ??
                                    setupAgent.sessionId,
                                )
                            : undefined}
                          onclaude={() => void launchSetupIn("claude")}
                          oncodex={() => void launchSetupIn("codex")}
                          launchError={setupLaunchError}
                          {onopenurl}
                          company={finaleCompany}
                          onrunagain={() => void setupAgent.runAgain()}
                        />
                      {:else if stopFailure && setupAgent.api && setupAgent.providers}
                        <!-- The run stopped: say why, and offer the agents right
                             here — sign in to one, or run again with one that is. -->
                        <SetupConnectStep
                          variant="surface"
                          api={setupAgent.api}
                          providers={setupAgent.providers}
                          lead={SETUP_FAILURE_COPY[stopFailure.kind].title}
                          detail={setupAgent.failureDetail ?? undefined}
                          onrefresh={() => setupAgent.refreshProviders(true)}
                          onrun={(tool) => void setupAgent.runAgain(tool)}
                          runBusy={setupAgent.busy}
                        />
                      {:else}
                      <SetupRunCard
                        variant="prompt"
                        mode={setupAgent.mode === "starting" || setupAgent.mode === "idle" ? "live" : setupAgent.mode}
                        run={agentState}
                        resumeStep={setupAgent.resumeStep}
                        busy={setupAgent.busy || setupAgent.mode === "starting"}
                        error={setupAgent.error}
                        onanswer={(requestId, questionId, values) => void setupAgent.answerChoice(requestId, questionId, values)}
                        onpermission={(requestId, decision) => void setupAgent.answerPermission(requestId, decision)}
                        onsend={(text) => void setupAgent.send(text)}
                        oncontinue={() => void setupAgent.continueRun()}
                        onrunagain={() => void setupAgent.runAgain()}
                        onfinish={() => setupAgent.finish()}
                        idle={setupAgent.snapshot?.phase === "idle"}
                        onstoresecret={setupAgent.canStoreSecrets ? (card, value) => setupAgent.storeSecret(card, value) : undefined}
                      />
                      {/if}
                    </div>
                  {/if}
                  {#if isAgentChannel && provisioning.state}
                    <div
                      class="agent-provision-status"
                      data-testid="agent-provision-status"
                    >
                      {#if provisioning.machineStartedAt}
                        <div
                          data-testid="agent-machine-started"
                          title={provisioning.machineStartedAt}
                        >
                          Machine started {formatReadonlyTimestamp(
                            provisioning.machineStartedAt,
                          )}
                        </div>
                      {/if}
                      {#if provisioning.checkedInAt}
                        <div
                          data-testid="agent-checked-in"
                          title={provisioning.checkedInAt}
                        >
                          {provisioning.agentName} checked in {formatReadonlyTimestamp(
                            provisioning.checkedInAt,
                          )}
                        </div>
                      {/if}
                    </div>
                  {/if}
                  <AgentThinkingRow entries={setupThinking ? [...agentThinking, setupThinking] : agentThinking} />
                  <AgentTaskStrip tasks={mainPaneTasks} />
                {/snippet}
                {#snippet setupHeader()}
                  <SetupChannelIntro
                    settings={adapter.settings}
                    shell={adapter.shell}
                    {onopenurl}
                    onopensessions={extraPages?.sessions?.setupAction || extraPages?.sessions?.createAction
                      ? () =>
                          openExtraPage(
                            "sessions",
                            (extraPages!.sessions.setupAction ?? extraPages!.sessions.createAction!).param(),
                          )
                      : undefined}
                    companies={rosterCompanies}
                    onopencompany={openCompanyFromSetup}
                    oncreatecompany={canRunEntryPoints ? createCompanyEntry : null}
                    {rosterStatus}
                    {onretryroster}
                    onsetupstarted={recordWelcomeSetupRun}
                    agent={setupAgent}
                    onopensessiondetails={extraPages?.sessions
                      ? (sessionId) => openExtraPage("sessions", sessionId)
                      : undefined}
                  />
                {/snippet}
                {#snippet companyHeader()}
                  <CompanyHero title={companyHeroTitle} wallpaper={companyWallpaper} />
                {/snippet}
                {#snippet botProgressHeader()}
                  {#if selectedBotProgress && selectedRow?.personUid}
                    {@const uid = selectedRow.personUid}
                    <BotProgressCard
                      name={selectedBotProgress.name}
                      state={selectedBotProgress.state}
                      reason={selectedBotProgress.reason}
                      retrying={selectedBotProgress.retrying}
                      onretry={() => void retryBotProgress(uid)}
                    />
                  {/if}
                {/snippet}
                {#snippet localBotHeader()}
                  {#if selectedLocalBot && selectedLocalBotOffline}
                    <div class="local-bot-notice" data-testid="local-bot-offline-notice" role="status">
                      <span class="local-bot-notice-text">{localBotOfflineNotice(selectedLocalBot)}</span>
                      {#if !selectedLocalBot.processAlive}
                        <button
                          type="button"
                          class="local-bot-notice-start"
                          data-testid="local-bot-start"
                          disabled={localBotBusy === selectedLocalBot.name}
                          onclick={() => void startSelectedLocalBot()}
                        >
                          {localBotBusy === selectedLocalBot.name ? "Starting…" : "Start"}
                        </button>
                      {/if}
                      {#if localBotActionError}
                        <span class="local-bot-notice-error" role="alert">{localBotActionError}</span>
                      {/if}
                    </div>
                  {/if}
                {/snippet}
                <ChannelConversation
                  restoreScroll={pendingRestoreScroll}
                  {localBots}
                  messages={timelineWithActivity}
                  onseen={async () => {
                    const row = selectedRow;
                    if (!row) return;
                    if (row.kind === "dm" && row.personUid) {
                      await sidebarApi.markDmThreadRead(row.personUid);
                    } else if (row.channelId && !row.browseOnly && row.membership !== "invited") {
                      await sidebarApi.markChannelRead(row.channelId);
                    } else return;
                    wakes?.emit?.("conversation:read", { id: row.id });
                  }}
                  hasEarlier={Boolean(historyCursors[selectedRow.id])}
                  onloadearlier={loadEarlierTimeline}
                  emptyLabel={conversationEmptyLabel}
                  reactions={rowReactions}
                  placeholder={composerPlaceholder}
                  composerLocked={composerLocked}
                  {onopenurl}
                  channelId={selectedRow.channelId}
                  oncardaction={handleCardAction}
                  ontogglereaction={persistReaction}
                  selfDisplayName={self?.displayName ?? null}
                  selfPersonUid={self?.uid ?? null}
                  onsend={persistSend}
                  previewCache={imagePreviewCache}
                  onpresign={presignAttachment}
                  mentionCandidates={mentionRoster}
                  onreply={openReply}
                  onopenprofile={openProfileForAuthor}
                  onopenattachment={openAttachmentTray}
                  onopenartifact={openArtifact}
                  onreleaseurl={releaseAttachmentUrl}
                  vaultCompanyUid={attachmentCompanyUid(selectedRow)}
                  companyUid={selectedRow.companyUid}
                  attachmentValidator={chatAttachmentValidatorForPlatform(adapter.kind)}
                  {replyPreviewByRoot}
                  {avatarByUid}
                  {displayNameByUid}
                  activeRootEventId={openReplyRootId}
                  loading={(timelineHydrating || projectActivityLoading) &&
                    timelineWithActivity.length === 0}
                  landAt={isSetupChannel(selectedRow.channelId) ? "top" : "bottom"}
                  header={isSetupChannel(selectedRow.channelId)
                    ? setupHeader
                    : isCompanyChannel
                      ? companyHeader
                      : selectedBotProgress
                        ? botProgressHeader
                        : selectedLocalBot && selectedLocalBotOffline
                          ? localBotHeader
                          : undefined}
                  belowMessages={agentThinkingBelow}
                  draftKey={selectedRow.id}
                  draftStorage={tenantStorage}
                />
              {/key}
              {#if openArtifactView}
                <div
                  class="reply-column"
                  class:overlay={narrowViewport}
                  data-testid="artifact-column"
                  data-pane-mode="artifact"
                  data-reply-layout={narrowViewport ? "overlay" : "column"}
                >
                  <ArtifactPanel
                    artifact={openArtifactView}
                    onclose={closeArtifact}
                    {onopenurl}
                  />
                </div>
              {:else if openAgentMember && openLocalBot}
                <div
                  class="reply-column profile-column"
                  class:overlay={narrowViewport}
                  data-testid="local-bot-detail-column"
                  data-reply-layout={narrowViewport ? "overlay" : "column"}
                >
                  <LocalBotDetailPanel
                    bot={openLocalBot}
                    avatarUrl={openAgentMember.avatarUrl ??
                      avatarByUid[openLocalBot.agentUid] ??
                      null}
                    {adapter}
                    onchanged={refreshLocalBots}
                    onclose={closeAgentDetail}
                  />
                </div>
              {:else if openAgentMember}
                <div
                  class="reply-column profile-column"
                  class:overlay={narrowViewport}
                  data-testid="agent-detail-column"
                  data-reply-layout={narrowViewport ? "overlay" : "column"}
                >
                  <AgentDetailPanel
                    agentUid={openAgentMember.personUid}
                    {localBots}
                    displayName={openAgentMember.displayName}
                    avatarUrl={openAgentMember.avatarUrl ??
                      avatarByUid[openAgentMember.personUid] ??
                      null}
                    description={openAgentMember.description}
                    companyUid={selectedRow.companyUid}
                    {companyNames}
                    {self}
                    {isAdmin}
                    {adapter}
                    packs={loadedAvatarPacks}
                    loadPacks={loadAvatarPacks}
                    avatarSaving={agentAvatarSaving}
                    avatarSaveError={agentAvatarSaveError}
                    onsaveavatar={saveOpenAgentAvatar}
                    onclose={closeAgentDetail}
                  />
                </div>
              {:else if openProfileMember}
                <div
                  class="reply-column profile-column"
                  class:overlay={narrowViewport}
                  data-testid="profile-column"
                  data-reply-layout={narrowViewport ? "overlay" : "column"}
                >
                  <MemberProfilePanel
                    member={openProfileMember}
                    {self}
                    avatarUrl={profilePanelAvatarUrl}
                    editable={canEditOpenAgent}
                    packs={loadedAvatarPacks}
                    loadPacks={loadAvatarPacks}
                    saving={agentAvatarSaving}
                    saveError={agentAvatarSaveError}
                    onsaveavatar={saveOpenAgentAvatar}
                    onclose={closeMemberProfile}
                  />
                </div>
              {:else if openReplyRootId && replyScope}
                <div
                  class="reply-column"
                  class:overlay={narrowViewport}
                  data-testid="reply-column"
                  data-reply-layout={narrowViewport ? "overlay" : "column"}
                >
                  <ReplyPanel
                    api={conversationApi}
                    {localBots}
                    rootEventId={openReplyRootId}
                    tasks={threadTasks}
                    scope={replyScope}
                    channelId={selectedRow.channelId}
                    withPersonUid={selectedRow.personUid}
                    {seedRoot}
                    {wakes}
                    reactions={rowReactions}
                    ontogglereaction={persistReaction}
                    selfDisplayName={self?.displayName ?? null}
                    selfPersonUid={self?.uid ?? null}
                    onuploadfiles={uploadFilesForSelectedRow}
                    previewCache={imagePreviewCache}
                    onpresign={presignAttachment}
                    onopenattachment={openAttachmentTray}
                    onopenartifact={openArtifact}
                    onreleaseurl={releaseAttachmentUrl}
                    vaultCompanyUid={attachmentCompanyUid(selectedRow)}
                    attachmentValidator={chatAttachmentValidatorForPlatform(adapter.kind)}
                    onclose={closeReply}
                    onreplycount={onReplyCount}
                    onactivethreadchange={onactivethreadchange}
                    {avatarByUid}
                    {displayNameByUid}
                    onopenprofile={openProfileForAuthor}
                    mentionCandidates={mentionRoster}
                    {onopenurl}
                  />
                </div>
              {/if}
            </div>
          {:else if activeTab === "board"}
            <BoardTab
              onCreateTask={adapter.workMesh?.createProjectStory && selectedRow?.companyUid ? createBoardTask : undefined}
              columns={board?.columns ?? []}
              stories={board?.stories ?? {}}
              onOpenInChannel={() => pushConversationSurface({ tab: "chat" })}
            />
          {:else}
            <ChannelFilesTab
              {files}
              previewContext={channelFilePreviewContext}
              previewKey={channelFileKey}
              onloadpreview={loadChannelFilePreview}
              onauthorizeaction={canPerformChannelFileAction}
              onreveal={revealChannelFile}
              onopen={openChannelFile}
              onselectfile={(item) =>
                pushConversationSurface({ tab: "files", fileKey: item.key })}
              onclosepreview={() =>
                pushConversationSurface({ tab: "files", fileKey: null })}
            />
          {/if}
        {:else if conversationBootTimedOut}
          <div
            class="conversation-boot-error"
            data-testid="conversation-boot-error"
            role="alert"
          >
            Couldn’t load conversations.
          </div>
        {:else}
          <!-- Pre-selection boot state: skeleton, not a "No data" flash. -->
          <ChannelSkeleton />
        {/if}
      </main>
    </div>
  {/if}

  {#if view === "library" && !navigationUnavailable}
    <LibraryOverlay
      {adapter}
      tab={libraryTab}
      itemId={libraryItemId}
      {packagesEvents}
      onback={() => {
        void leaveCurrentDestination();
      }}
      onnavigatetab={(next) => void navigate({ kind: "library", tab: next })}
      onnavigateitem={(id) =>
        void navigate({ kind: "library", tab: libraryTab, itemId: id })}
    />
  {/if}

  {#if paletteOpen}
    <CommandPalette
      commands={paletteCommands}
      onclose={() => (paletteOpen = false)}
    />
  {/if}

  {#if attachTray}
    <AttachmentTray
      previewCache={imagePreviewCache}
      items={attachTray.items}
      selectedId={attachTray.selectedId}
      onselect={(id) => {
        if (attachTray) attachTray = { ...attachTray, selectedId: id };
      }}
      onclose={() => (attachTray = null)}
      resolveUrl={resolveTrayUrl}
      onreleaseurl={releaseAttachmentUrl}
      {onopenurl}
    />
  {/if}
  {#if linkMenu}
    <LinkContextMenu
      menu={linkMenu}
      {onopenurl}
      onclose={() => (linkMenu = null)}
    />
  {/if}
</div>

<style>
  .desktop-shell {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    /* Single-scroll guarantee: the shell clips; only leaf scrollers (the
       channel rail, the conversation thread) may scroll. */
    overflow: hidden;
    background: var(--v4-ground, #161618);
    color: var(--t1);
    font: 400 13px/1.45 var(--font-ui);
  }

  /* Interface size scales the whole shell (like Slack's zoom), not just the
     root font-size — most components use fixed px, so a font-size nudge was
     imperceptible. WebKit `zoom` reflows all content uniformly in-window. */
  :global(html[data-ui-size="compact"]) .desktop-shell {
    zoom: 0.9;
  }

  :global(html[data-ui-size="large"]) .desktop-shell {
    zoom: 1.12;
  }

  .desktop-body {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  /* Anchors the phone channel-list overlay (see ChatSidebar's matching block);
     without a positioned ancestor it escapes to the viewport and renders
     behind the title bar. Pinned to SIDEBAR_OVERLAY_MAX_PX by
     shell/sidebar-layout.test.ts. */
  @media (max-width: 640px) {
    .desktop-body {
      position: relative;
    }
  }

  .desktop-main {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0;
    min-width: 0;
    min-height: 0;
    padding: 0;
    overflow: hidden;
    /* In-pane destinations (Meetings, Notifications) are not under the
       overlay traffic lights — don't inherit the window-chrome gutter. */
    --titlebar-leading-inset: 16px;
  }

  .extra-page-host {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .navigation-unavailable {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    min-width: 0;
    min-height: 0;
    padding: 24px;
    color: var(--t2, rgba(255, 255, 255, 0.62));
    font: 400 13px/1.45 var(--font-ui);
    text-align: center;
  }

  .navigation-unavailable button:disabled {
    opacity: 0.5;
  }

  .conversation-boot-error {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    justify-content: center;
    min-width: 0;
    min-height: 0;
    padding: 24px;
    color: var(--t2, rgba(255, 255, 255, 0.62));
    font: 400 13px/1.45 var(--font-ui);
    text-align: center;
  }

  .notifications-layer {
    display: none;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .notifications-layer.is-active {
    display: flex;
  }

  .chat-stage {
    position: relative;
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
  }

  /* Synthetic #setup channel stacks the getting-started intro above the
     live thread instead of the usual conversation | reply-column row. */
  .chat-stage.is-setup {
    flex-direction: column;
  }

  .chat-stage :global(.conversation) {
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
  }

  .chat-stage:has(.reply-column:not(.overlay)) :global(.conversation) {
    min-width: 320px;
  }

  /* Open thread pane takes half the conversation area — a 50/50 split
     between the main channel column and the thread panel. Profile panels
     keep their narrower fixed column (see .reply-column below). */
  .chat-stage:has(.reply-column:not(.profile-column):not(.overlay))
    :global(.conversation) {
    flex: 1 1 0;
    min-width: 360px;
  }

  .reply-column {
    position: relative;
    /* Stacking context (also covers .profile-column). Side-by-side both
       panes are isolated with z-index:auto; DOM order puts this column after
       .conversation so the opaque pane + border-left paint above main-pane
       hover chrome and message text. .overlay still overrides to
       position:absolute; z-index:5. */
    isolation: isolate;
    width: clamp(340px, 34%, 420px);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--line);
    background: var(--v4-ground, #161618);
    transition: width 150ms ease;
  }

  /* Thread pane (not the profile panel): open at half the conversation
     width. flex: 1 1 0 pairs with the sibling .conversation (also
     flex: 1 1 0) for a 50/50 split; the min-width keeps the composer usable
     on narrow windows. The border-left above keeps the hairline divider. */
  .reply-column:not(.profile-column):not(.overlay) {
    width: auto;
    flex: 1 1 0;
    min-width: 360px;
  }

  @media (prefers-reduced-motion: reduce) {
    .reply-column {
      transition: none;
    }
  }

  .reply-column.overlay {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(100%, 420px);
    z-index: 5;
    background: var(--v4-ground, #161618);
  }

  /* Channel header — ported from the real ChannelView: title left, tabs +
     member pill grouped right in `.channel-header-trailing`. */
  .channel-action-error {
    margin: 0 16px 6px;
    padding: 6px 10px;
    border: 1px solid
      color-mix(in srgb, var(--warn-ink, #d9584a) 45%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--warn-ink, #d9584a) 12%, transparent);
    color: var(--t1);
    font: 400 12px/1.4 var(--font-ui);
  }

  .channel-header {
    position: relative;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
    height: 52px;
    padding: 0 20px;
    overflow: visible;
    border-bottom: 1px solid var(--line);
  }

  .channel-title-block {
    display: flex;
    flex-direction: row;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }

  .channel-title {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .channel-header-avatar {
    display: inline-flex;
    flex: 0 0 auto;
    align-self: center;
    align-items: center;
  }

  .channel-header-agent {
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .channel-header-agent h2 {
    margin: 0;
    color: var(--t1);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.45;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .channel-header-agent:hover h2 {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .channel-header-agent:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--t1));
    outline-offset: 2px;
    border-radius: 6px;
  }

  .channel-hash {
    color: var(--t3);
    font-size: 15px;
    font-weight: 600;
  }

  .channel-title h2 {
    margin: 0;
    color: var(--t1);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.45;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .channel-sub-row {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .channel-sub {
    color: var(--t3);
    font-size: 12px;
    font-weight: 400;
    line-height: 1.45;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .project-about-btn {
    appearance: none;
    -webkit-appearance: none;
    display: inline-grid;
    place-items: center;
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 999px;
    background: transparent;
    color: var(--t3);
    cursor: pointer;
  }

  .project-about-btn:hover,
  .project-about-btn[aria-expanded="true"] {
    color: var(--t1);
  }

  .project-about-btn:focus-visible {
    outline: 2px solid var(--fg, var(--t1));
    outline-offset: 1px;
  }

  /* Tabs right-aligned as icon+label; member pill sits beside them. */
  .channel-header-trailing {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 0 0 auto;
    margin-left: auto;
  }

  /* 28px ghost button: same control scale as the tab-row actions. */
  .header-ghost-btn {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 28px;
    min-height: 28px;
    padding: 0 10px;
    border: 1px solid var(--line2, var(--panel-border));
    border-radius: 0;
    background: transparent;
    color: var(--t1);
    font: 500 12px/1 inherit;
    cursor: pointer;
    white-space: nowrap;
  }

  .header-ghost-btn:hover {
    background: var(--hover);
  }

  .header-ghost-btn:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .header-ghost-btn:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--t1));
    outline-offset: 2px;
  }

  .header-inline-error {
    color: var(--danger, #e5484d);
    font-size: 12px;
    max-width: 260px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .edit-profile-btn {
    appearance: none;
    -webkit-appearance: none;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--t2);
    font: 500 12px/1.45 inherit;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  .edit-profile-btn:hover {
    color: var(--t1);
  }

  .edit-profile-btn:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--t1));
    outline-offset: 2px;
  }

  .company-tab-placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 120px;
    color: var(--t3);
    font-size: 13px;
  }

  .project-tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    background: var(--raised);
    border: none;
    border-radius: 8px;
    padding: 2px;
  }

  .project-tab {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 4px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
    transition: color 0.12s;
  }

  .project-tab:hover {
    color: var(--t1);
  }

  .project-tab.active {
    color: var(--t1);
    background: var(--sel);
  }

  .project-tab:focus-visible {
    outline: 2px solid var(--fg, var(--t1));
    outline-offset: 2px;
  }

  .project-tab-icon {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
  }

  .member-count-btn {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--btn-bg);
    color: var(--t2);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .member-count-btn:hover {
    border-color: var(--line2);
    color: var(--t1);
  }

  .member-count-icon {
    display: grid;
    place-items: center;
    color: var(--t3);
  }

  .member-count-num {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
  }


  .member-pill-wrap {
    position: relative;
    z-index: 21;
    flex: 0 0 auto;
  }
  /* ---- Setup Agent prompt (under the #welcome messages) ---------------- */
  /* No box: the block sits under the last message on the message-text
     column — left = row padding 8px + avatar 36px + gap 8px; right = the
     row's 8px padding — so its edges match the messages above. */
  .setup-agent-prompt {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: none;
    margin: 8px 8px 8px 52px;
  }
  .setup-agent-prompt:empty {
    display: none;
  }
  .local-bot-notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin: 12px 16px 4px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--line2);
    color: var(--t2);
    font-size: 12px;
    line-height: 1.4;
  }
  .local-bot-notice-text {
    flex: 1 1 auto;
    min-width: 0;
  }
  .local-bot-notice-start {
    font: inherit;
    font-weight: 600;
    padding: 4px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel-bg, transparent);
    color: var(--t1);
    cursor: pointer;
  }
  .local-bot-notice-start:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .local-bot-notice-error {
    flex-basis: 100%;
    color: var(--danger, #d05f5f);
  }
</style>
