<script lang="ts">
  import {
    parseMeshProjectView,
    projectViewToBoard,
  } from "@hq/core";
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
  import { failure, startJitteredPoll, type PlatformAdapter } from "@hq/platform";
  import V4TitleBar from "../home/V4TitleBar.svelte";
  import ChannelSkeleton from "./ChannelSkeleton.svelte";
  import SidebarResizeHandle from "./SidebarResizeHandle.svelte";
  import ChatSidebar, {
    type ChatSidebarActions,
  } from "../chat/ChatSidebar.svelte";
  import type { RowExtrasResolver } from "../chat/row-extras.js";
  import DmRequestsPanel from "../chat/DmRequestsPanel.svelte";
  import ShortcutCheatSheet from "../common/ShortcutCheatSheet.svelte";
  import {
    formatShortcut,
    registerShortcuts,
    type ShortcutBinding,
  } from "../common/keyboard-shortcuts.js";
  import { createGoChord } from "../common/go-chord.js";
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
    findSetupBot,
    findSetupBotContact,
    firstSignedInRuntime,
    SETUP_BOT_ALREADY_ELSEWHERE,
    SETUP_BOT_GENERIC_FAILURE,
    SETUP_BOT_INTRO,
    SETUP_BOT_KICKOFF,
    SETUP_BOT_MODE,
    SETUP_BOT_NAME,
    SETUP_BOT_NO_RUNTIME,
    SETUP_BOT_UNAVAILABLE,
    SETUP_BOT_WORKER,
    singleFlightStart,
    type SetupBotLauncher,
    type SetupBotRef,
    type SetupBotStart,
  } from "../chat/setup-bot.js";
  import {
    findLifecycleCardElement,
    runCreateCloudBotEntry,
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
  import { coalesceWorkSessionWires } from "../chat/messaging/work-session-wires.js";
  import type { Snippet } from "svelte";
  import ArtifactPanel from "../chat/messaging/ArtifactPanel.svelte";
  import type { ChatArtifact } from "../chat/messaging/artifact-model.js";
  import BoardTab from "../chat/messaging/BoardTab.svelte";
  import ChannelFilesTab from "../chat/messaging/ChannelFilesTab.svelte";
  import CompanyTabs from "../chat/CompanyTabs.svelte";
  import CompanyHero from "../chat/CompanyHero.svelte";
  import {
    companyChannelTabsFor,
    parseCompanyTab,
    type CompanyChannelTabId,
    type CompanyTabModel,
  } from "../chat/tabs/tab-model.js";
  import OfficePanel from "../meet/OfficePanel.svelte";
  import type { OfficeCallsHost } from "../meet/office-host.js";
  import NotificationsView from "../inbox/NotificationsView.svelte";
  import SharedFilesOverlay from "../inbox/SharedFilesOverlay.svelte";
  import CommandPalette, {
    type CommandPaletteItem,
  } from "../common/CommandPalette.svelte";
  import ShellSettings, {
    type ShellSettingsProfile,
  } from "../settings/ShellSettings.svelte";
  import RecommendedUpdateBanner from "../settings/RecommendedUpdateBanner.svelte";
  import MembershipSyncBanner from "./MembershipSyncBanner.svelte";
  import SessionExpiredBanner from "./SessionExpiredBanner.svelte";
  import NotificationActionRecovery from "./NotificationActionRecovery.svelte";
  import {
    cacheLogoAssets,
    readBrandCache,
    syncBrandFromWorkspaces,
    type CachedBrand,
  } from "../brand/brand.js";
  import {
    recoveryFromEvent,
    RECOVERY_EVENT,
    RETRY_EVENT,
    type NativeNotificationRecovery,
  } from "./notification-recovery.js";
  import type { SyncEventHost } from "./sync-events.js";
  import type { HomeConflict } from "../home/home-model.js";
  import {
    emptySyncStatus,
    reduceSyncEvent,
    SYNC_STATUS_EVENTS,
    type SyncStatusState,
  } from "../home/sync-status.js";
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
  import MemberProfilePanel from "../chat/MemberProfilePanel.svelte";
  import AgentDetailPanel from "../chat/AgentDetailPanel.svelte";
  import LocalBotDetailPanel from "../chat/LocalBotDetailPanel.svelte";
  import BotSignInBanner from "../chat/BotSignInBanner.svelte";
  import BotRestoreBanner from "../chat/BotRestoreBanner.svelte";
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
  import {
    onDestroy,
    onMount,
    tick as svelteTick,
    untrack,
    type Component,
  } from "svelte";
  import {
    applyColorTheme,
    applyUiSize,
    applyWindowOpacity,
    hasAppearanceHost,
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
    applyResolvedMentionEmails,
    disambiguateMentionTargets,
    mentionUidsNeedingEmail,
    outsideCompanyLabel,
    mentionTargetsFromContacts,
    mentionTargetsFromContactsPayload,
    mergeMentionRosters,
    stampMentionCompany,
    type MentionTarget,
  } from "../chat/mentions.js";
  import {
    clearAgentEverywhere,
    clearRowFromMessages,
    agentDisplayName,
    applyAgentStatus,
    dropRow,
    isAgentUid,
    newestMessageAtFrom,
    startThinkingIn,
    kickoffThinkingState,
    tickAll,
    type ThinkingByRow,
    type ThinkingEntry,
  } from "../chat/agent-thinking.js";
  import {
    BOT_MESSAGE_NOT_ANSWERED,
    BOT_MESSAGE_START_HERE,
    BOT_NOT_RUNNABLE_HERE,
    BOT_NOT_RUNNABLE_RECHECK,
    BOT_START_NO_MORE_RETRIES,
    botIsConfiguredHere,
    botRunsHere,
    botStartFallbackNotice,
    canStartBot,
    classifyBotStartFailure,
    clearBotStartGate,
    localBotsDisappeared,
    readLocalBotTrace,
    reconcileLocalBotTrace,
    recordBotStartFailure,
    rememberLocalBots,
    type BotStartGate,
    type LocalBotTrace,
  } from "../chat/bot-runnability.js";
  import {
    isAlreadyExistsFailure,
    LOCAL_BOTS_POLL_MS,
    localBotForRow,
    localBotOfflineNotice,
    localBotPresence,
    type LocalBotEntryResult,
    locallyHostedBots,
    plainBotFailure,
    promotedBotCompany,
  } from "../chat/local-bots.js";
  import {
    adoptFallbackNotice,
    BOT_RESTORE_ALL,
    BOT_RESTORE_ALL_BUSY,
    BOT_RESTORE_DISMISS,
    BOT_RESTORE_FAILED,
    BOT_RESTORE_TITLE,
    BOT_START_HERE,
    BOT_START_HERE_BUSY,
    BOT_START_HERE_EXPLAINER,
    BOT_START_HERE_RETRY,
    botRestorePromptBody,
    botRestorePromptDismissed,
    botRestoreRowFailed,
    botRestoreRowLine,
    botRestoreSummary,
    botFailureReason,
    BOT_LIVE_ELSEWHERE_NOTICE,
    botsLiveElsewhereNotice,
    botsNotHere,
    botStaysInCloudLine,
    classifyRemoteBotFailure,
    isNotRunnableHereReason,
    NO_REMOTE_BOT_LISTING,
    ownedBotNotHere,
    ownedBotsNotHere,
    remoteBotListingFailed,
    remoteBotListingNotice,
    remoteBotListingOk,
    REMOTE_BOTS_CALL_TIMEOUT_MS,
    REMOTE_BOTS_POLL_MS,
    REMOTE_BOTS_TIMEOUT_LOG,
    rememberBotRestoreDismissed,
    withPollTimeout,
    type RemoteBotListing,
  } from "../chat/bot-restore.js";
  import {
    AUTO_RESTORE_RUNNING,
    AUTO_RESTORE_STARTING_THIS_BOT,
    autoRestoreAllowed,
    autoRestoreCandidates,
    autoRestoreCoversAll,
    autoRestoreDoneLine,
    autoRestoreDue,
    autoRestoreExhausted,
    autoRestoreFailedLine,
    autoRestoreHeldBack,
    countAutoRestoreAttempt,
    noteAutoRestoreAttempt,
    type AutoRestoreAttempts,
    type AutoRestoreLastAttempts,
  } from "../chat/bot-auto-restore.js";
  import {
    botNeedsSignIn,
    restartBotsNeedingSignIn,
    runtimesNeedingSignIn,
  } from "../chat/runtime-sign-in-again.js";
  import type {
    BotRestoreResult,
    LocalBotCreateInput,
    LocalBotRow,
    LocalBotWorkerOption,
    RemoteBotRow,
    SessionProviderId,
  } from "@hq/platform";
  import BotProgressCard, { type BotProgressState } from "../chat/create-bot/BotProgressCard.svelte";
  import type { CreateBotExtras } from "../chat/create-bot/CreateBotFlow.svelte";
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
    stepConversation,
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
    OPEN_DM_REQUESTS_EVENT,
    OPEN_SETTINGS_EVENT,
    conversationDeepLinkFromLocation,
    conversationRowForDeepLink,
    requestChannelOpen,
    shouldOpenReplyDeepLink,
    takePendingChannelOpen,
    takePendingDmRequests,
    type ConversationDeepLink,
    type PendingChannelOpen,
  } from "../chat/open-target.js";
  import type { DmRequest, RequestAction } from "../chat/dm-requests.js";
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
  import {
    joinableMemberships,
    type Workspace,
    type WorkspacesResult,
  } from "../chat/workspaces.js";
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
     * App-level event subscription (Tauri `listen`, or a web bridge), used to
     * observe sync outcomes the command result cannot report — see
     * `syncMembership`. Omitted on platforms without an event bus; the
     * membership banner degrades to reporting dispatch errors only.
     */
    syncEvents?: SyncEventHost | null;
    /**
     * Where the host is in loading `companies` for this session. #setup
     * hides the seeded "Create a company" card and the create hero copy
     * until the roster has loaded once (`ready` | `failed`). Omitted = ready.
     */
    rosterStatus?: RosterStatus | null;
    /** Re-run the host's roster fetch after `rosterStatus === "failed"`. */
    onretryroster?: () => void;
    /**
     * Start reauthentication from the session-expired banner (PL-03). The
     * desktop host clears the dead session and lands the user on its sign-in
     * surface. Omitted → the banner states the problem without an action.
     */
    onsignin?: () => void | Promise<void>;
    /**
     * Verified signed-in principal (host-supplied: web = Cognito session,
     * desktop = its auth source). Drives "you" tagging + admin gating in the
     * shared UI. Null on the unauth / empty path.
     */
    self?: SelfIdentity | null;
    /** Native account partition for renderer persistence and async guards. */
    tenantAccountId?: string | null;
    /**
     * Agents the user has a real conversation with. Creating an agent
     * announces it to the whole company, so an `agt_*` rail row stays hidden
     * until it messages the user; a host with its own record of past agent
     * conversations seeds it here.
     */
    engagedAgentUids?: readonly string[] | null;
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
    /**
     * US-018 native calling seams. Supplied by a desktop host; absent on the
     * web. The Office tab is gated on `adapter.capabilities.nativeCalls`, and
     * the panel refuses in its own voice when this is missing.
     */
    callsHost?: OfficeCallsHost | null;
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
    callsHost = null,
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
    syncEvents = null,
    rosterStatus = null,
    onretryroster,
    onsignin,
    self = null,
    tenantAccountId = null,
    engagedAgentUids = null,
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

  /**
   * Desktop-window counterpart of the menubar popover's "You've been added
   * to {company} — Sync to pull it" notice (see MembershipSyncBanner.svelte).
   * Dismissal is session-only (in-memory), matching the popover.
   */
  let dismissedMemberships = $state(new Set<string>());
  let membershipSyncPending = $state(false);
  let membershipSyncError = $state<string | null>(null);
  /** Company slug of the in-flight pull, so outcome events can be matched. */
  let membershipSyncTarget = $state<string | null>(null);
  const membershipsToPull = $derived(
    joinableMemberships(companies ?? []).filter(
      (w) => !dismissedMemberships.has(w.slug),
    ),
  );

  function dismissMembershipPrompt(slugs: string[]): void {
    const next = new Set(dismissedMemberships);
    for (const slug of slugs) next.add(slug);
    dismissedMemberships = next;
  }

  /**
   * Session-expired notice (PL-03). `start_sync` returns Ok on the needs-reauth
   * path and emits `sync:auth-error` instead, so without this banner a paused
   * session is invisible in the desktop window — the tray popover was the only
   * surface that said so. Dismissal is session-only; the next auth error shows
   * it again.
   */
  let authErrorMessage = $state<string | null>(null);
  let authSignInPending = $state(false);

  async function startReauth(): Promise<void> {
    if (!onsignin || authSignInPending) return;
    authSignInPending = true;
    try {
      await onsignin();
    } catch (err) {
      console.error("sign-in from session-expired banner failed:", err);
    } finally {
      authSignInPending = false;
    }
  }

  /**
   * Native-notification action retry (PL-03). The controller window owns the
   * action routing, so it broadcasts its recovery record here and re-runs the
   * action when this shell asks. See ./notification-recovery.ts.
   */
  let notificationRecovery = $state<NativeNotificationRecovery | null>(null);
  let notificationRetrying = $state(false);

  function retryNotificationAction(): void {
    const host = syncEvents;
    if (!host?.emit || !notificationRecovery || notificationRetrying) return;
    // Optimistic: the controller echoes the authoritative state back on
    // RECOVERY_EVENT, which either clears the banner or releases the control.
    notificationRetrying = true;
    void Promise.resolve(host.emit(RETRY_EVENT)).catch((err) => {
      console.error("notification retry: emit failed:", err);
      notificationRetrying = false;
    });
  }

  $effect(() => {
    const host = syncEvents;
    if (!host) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void host
      .listen(RECOVERY_EVENT, (event) => {
        const parsed = recoveryFromEvent(event?.payload);
        if (!parsed) return;
        notificationRecovery = parsed.recovery;
        notificationRetrying = parsed.recovery ? parsed.retrying : false;
      })
      .then(
        (un) => {
          if (disposed) un();
          else unlisten = un;
        },
        (err) => {
          console.error("notification recovery: subscribe failed:", err);
        },
      );

    return () => {
      disposed = true;
      unlisten?.();
    };
  });

  /**
   * White-label brand for the title bar (PL-04). Resolved from the same
   * membership enrichment the popover reads (`Workspace.brand` +
   * `brandingEnabled`), through the shared runtime so the cache, the
   * entitlement rule and the offline fallback stay identical.
   */
  let brandState = $state<CachedBrand | null>(null);

  function brandStorage(): Storage | null {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      // Storage disabled (private mode / sandboxed host): no cache, no brand
      // beyond what the live roster carries this session.
      return null;
    }
  }

  $effect(() => {
    const storage = brandStorage();
    if (!storage) return;
    const roster = companies;
    // A roster that has not arrived (or failed to) is not evidence that the
    // entitlement was withdrawn. Keep painting the cached logo — that is the
    // offline launch the brand cache exists for.
    if (roster == null || rosterStatus === "failed") {
      brandState = readBrandCache(storage);
      return;
    }
    const preferSlug = selectedCompanySlug || null;
    const next = syncBrandFromWorkspaces(roster, {
      cloudReachable: true,
      preferSlug,
      storage,
    });
    brandState = next;
    if (next) {
      void cacheLogoAssets(next, storage).then(
        (cached) => {
          brandState = cached;
        },
        (err) => {
          console.error("brand: caching logo assets failed:", err);
        },
      );
    }
  });

  const brandCompanyName = $derived.by(() => {
    const slug = brandState?.companySlug;
    if (!slug) return null;
    return (
      (companies ?? []).find((c) => c.slug === slug)?.displayName ?? slug
    );
  });

  /**
   * `start_sync` returns as soon as the runner is REGISTERED, not when the
   * pull finishes, and it deliberately returns Ok on the needs-reauth path
   * (commands/sync.rs — "avoids red error UI", emitting `sync:auth-error`
   * instead). So the command result alone can neither confirm the membership
   * arrived nor report the most likely failure. Completion and auth failure
   * both arrive as events; `syncEvents` is how this platform-agnostic shell
   * hears them.
   */
  async function syncMembership(): Promise<void> {
    if (membershipSyncPending || !adapter.isAvailable("canSync")) return;
    const target = membershipsToPull[0];
    if (!target) return;
    membershipSyncPending = true;
    membershipSyncError = null;
    membershipSyncTarget = target.slug;
    try {
      // Scoped to the company the banner names — an unscoped call is
      // SyncRunScope::All, which syncs every workspace on the machine and is
      // not what "pull it onto this machine" promises. Matches CompanyPage.
      const result = await adapter.sync.startSync(target.slug);
      if (!result.ok) {
        console.error("membership sync failed:", result.reason, result.message);
        membershipSyncError =
          result.message?.trim() || "Sync could not be started.";
        membershipSyncPending = false;
      } else if (!syncEvents) {
        // No event bridge on this platform: the run was dispatched, but this
        // shell cannot observe its outcome. Release the control rather than
        // leave a spinner that can never resolve.
        membershipSyncPending = false;
      }
    } catch (err) {
      console.error("membership sync failed:", err);
      membershipSyncError =
        err instanceof Error && err.message.trim()
          ? err.message
          : "Sync could not be started.";
      membershipSyncPending = false;
    }
  }

  /**
   * Live sync progress for the title bar chip.
   *
   * The runner emits no running total: `sync:plan` says how many files a
   * company intends to move and `sync:progress` fires once per file, so the
   * count is reduced here rather than read off any single event. Separate
   * subscription from the membership-banner effect below because that one
   * filters to one company and this one deliberately watches every run.
   */
  let syncStatus = $state<SyncStatusState>(emptySyncStatus());

  /**
   * Per-file conflict rows for the Core popover. Separate from the reducer
   * above because that one only needs the phase; this one needs the path so
   * the row's Keep local / Keep cloud buttons have something to resolve.
   */
  $effect(() => {
    const host = syncEvents;
    if (!host) return;
    let disposed = false;
    const handles: Array<() => void> = [];

    const track = (pending: Promise<() => void>): void => {
      void pending.then(
        (un) => {
          if (disposed) un();
          else handles.push(un);
        },
        (err) => {
          console.error("conflicts: event subscribe failed:", err);
        },
      );
    };

    track(
      host.listen("sync:conflict", (event) => {
        const payload = (event?.payload ?? {}) as Record<string, unknown>;
        const path =
          typeof payload.path === "string" && payload.path.trim()
            ? payload.path.trim()
            : null;
        if (!path) return;
        if (conflictFiles.some((c) => c.path === path)) return;
        conflictFiles = [
          ...conflictFiles,
          {
            path,
            canAutoResolve: payload.canAutoResolve === true,
            status: "pending",
            at: Date.now(),
          },
        ];
      }),
    );
    // A fresh run re-reports whatever is still conflicted, so a stale row from
    // the previous run must not linger with a path that may no longer exist.
    track(
      host.listen("sync:all-complete", () => {
        conflictFiles = [];
      }),
    );

    return () => {
      disposed = true;
      for (const un of handles) un();
    };
  });

  $effect(() => {
    const host = syncEvents;
    if (!host) return;
    let disposed = false;
    const handles: Array<() => void> = [];

    for (const name of SYNC_STATUS_EVENTS) {
      void host.listen(name, (event) => {
        syncStatus = reduceSyncEvent(syncStatus, name, event?.payload);
      }).then(
        (un) => {
          if (disposed) un();
          else handles.push(un);
        },
        (err) => {
          console.error(`sync status: subscribe to ${name} failed:`, err);
        },
      );
    }

    return () => {
      disposed = true;
      for (const un of handles) un();
    };
  });

  /**
   * Sync outcome events. Without these the banner cannot distinguish "pulled"
   * from "silently did nothing because the session needs a refresh", which is
   * exactly the state a newly-added user is most likely to be in.
   */
  $effect(() => {
    const host = syncEvents;
    if (!host) return;
    let disposed = false;
    const handles: Array<() => void> = [];

    const track = (pending: Promise<() => void>): void => {
      void pending.then(
        (un) => {
          if (disposed) un();
          else handles.push(un);
        },
        (err) => {
          console.error("membership sync: event subscribe failed:", err);
        },
      );
    };

    track(
      host.listen("sync:auth-error", (event) => {
        const message = (
          event as { payload?: { message?: string } } | undefined
        )?.payload?.message;
        membershipSyncPending = false;
        membershipSyncError =
          message?.trim() ||
          "Your HQ session needs a quick refresh. Sign in again to keep sync moving.";
        // The membership banner only exists while there is a company to pull.
        // The session is broken either way, so say so in its own banner too.
        authErrorMessage =
          message?.trim() ||
          "Your HQ session needs a quick refresh. Sign in again to keep sync moving.";
      }),
    );
    // `begin_reauth` clears the dead session and announces it without a sync
    // run, so the banner must hear this event as well or a reauth started
    // elsewhere leaves this window looking signed in.
    track(
      host.listen("auth:reauth-required", () => {
        authErrorMessage =
          "Your HQ session needs a quick refresh. Sign in again to keep sync moving.";
      }),
    );
    // `sync:complete` is emitted PER COMPANY (SyncCompleteEvent carries
    // `company`), and the daemon syncs in the background, so an unfiltered
    // handler would clear this banner on some other workspace's run. Match the
    // company this banner actually started.
    track(
      host.listen("sync:complete", (event) => {
        const company = (
          event as { payload?: { company?: string } } | undefined
        )?.payload?.company;
        if (!company || company === membershipSyncTarget) {
          membershipSyncPending = false;
          membershipSyncError = null;
        }
        // A completed run proves the session works again.
        authErrorMessage = null;
      }),
    );
    // Terminal backstop: a run that attempts the company but never emits a
    // per-company complete (aborted, company-level error) still ends here.
    track(
      host.listen("sync:all-complete", (event) => {
        const errors =
          (event as { payload?: { errors?: Array<{ company?: string; message?: string }> } }
            | undefined)?.payload?.errors ?? [];
        const mine = errors.find(
          (e) => !membershipSyncTarget || e.company === membershipSyncTarget,
        );
        membershipSyncPending = false;
        if (mine) membershipSyncError = mine.message?.trim() || "Sync failed.";
      }),
    );
    // NOTE: deliberately NOT listening to `sync:error`. That event is PER FILE
    // (`SyncErrorEvent { company, path, message }`) and a run continues past
    // it, so treating one as terminal would flash a failure — and release the
    // button — while the pull is still going.

    return () => {
      disposed = true;
      for (const un of handles) {
        try {
          un();
        } catch (err) {
          console.error("membership sync: unlisten failed:", err);
        }
      }
    };
  });

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
    | "library"
    | "shared-files"
    | "extra"
    | "dm-requests"
  >("conversation");
  let extraPageId = $state<string | null>(null);
  let extraPageParam = $state<string | null>(null);
  /** Which pending request the Requests panel should bring into view first. */
  let dmRequestsFocusPairKey = $state<string | null>(null);
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
  /**
   * US-018: the company tabs this host may actually offer. Office appears only
   * when the platform adapter reports native calling, so the web build never
   * advertises a destination it cannot open.
   */
  const companyTabsForHost = $derived(
    companyChannelTabsFor({
      nativeCalls: adapter?.capabilities?.nativeCalls === true,
    }),
  );
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
  let threadWidth = $state<number | null>(null);
  let threadDrag: { x: number; width: number } | null = null;

  function resizeThread(handle: HTMLElement, width: number) {
    const stageWidth =
      handle.parentElement?.parentElement?.getBoundingClientRect().width ?? 0;
    if (!stageWidth) return;
    const minimum = Math.min(280, stageWidth / 2);
    const maximum = stageWidth - Math.min(360, stageWidth / 2);
    threadWidth = Math.round(Math.max(minimum, Math.min(maximum, width)));
  }

  function startThreadDrag(event: PointerEvent) {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    threadDrag = {
      x: event.clientX,
      width: handle.parentElement!.getBoundingClientRect().width,
    };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function moveThreadDrag(event: PointerEvent) {
    if (!threadDrag) return;
    resizeThread(
      event.currentTarget as HTMLElement,
      threadDrag.width + threadDrag.x - event.clientX,
    );
  }

  function stopThreadDrag(event: PointerEvent) {
    threadDrag = null;
    const handle = event.currentTarget as HTMLElement;
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
  }

  function resizeThreadKey(event: KeyboardEvent) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const handle = event.currentTarget as HTMLElement;
    resizeThread(
      handle,
      handle.parentElement!.getBoundingClientRect().width +
        (event.key === "ArrowLeft" ? 20 : -20),
    );
    event.preventDefault();
  }
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
  /** Rail rows in display order (pinned → days → expanded last week). */
  let displayRows = $state<ConversationRow[]>([]);
  /** Sidebar entry points for app-wide shortcuts; null while unmounted. */
  let sidebarActions = $state<ChatSidebarActions | null>(null);
  let cheatSheetOpen = $state(false);

  // ── Personal local bots (local-bots US-009) ────────────────────────────────
  // The host's bots API shells to `hq bot list --json`; rows carry the server's
  // online verdict. Polled while the shell is mounted so the DM rail dot and the
  // thread notice track the bot without any CLI on the user's side.
  let localBotRecords = $state<LocalBotRow[]>([]);
  const localBots = $derived(locallyHostedBots(localBotRecords));
  let localBotBusy = $state<string | null>(null);
  let localBotActionError = $state<string | null>(null);
  /**
   * A BOT THAT CANNOT RUN HERE SAYS SO (desktop UX feedback, round 5).
   *
   * The account owns the bot, but this Mac has no local runtime for it — a
   * reinstall, or a second computer, where `hq bot list` is empty while the
   * cloud still has the agent. The owner's VM adopted exactly that bot, opened
   * its DM, and the app then presented it as a normal thinking bot forever
   * while every start answered "no such bot". Keyed by agent uid → the honest
   * sentence its DM shows.
   */
  let unrunnableBotUids = $state<Record<string, string>>({});
  /**
   * Start budget per bot name. A definitive failure ("no such bot", not signed
   * in, held) closes it after ONE attempt; a transient one (CLI timeout,
   * unreachable) is bounded at `BOT_START_MAX_ATTEMPTS`. Nothing in the app
   * re-issues a start once the gate is closed.
   */
  let botStartGate = $state<BotStartGate>({});
  /**
   * The failure event. Policy `transient-indicators-clear-on-newer-event-not-time-window`:
   * a thinking row is never cleared by a timer — it is cleared by a NEWER
   * event. A definitive start failure is that event, so it goes through here
   * instead of a bot message, ending the row everywhere that bot was shown as
   * working and leaving the honest state in its place.
   */
  function noteBotCannotRunHere(agentUid: string, reason: string = BOT_NOT_RUNNABLE_HERE): void {
    const uid = (agentUid ?? "").trim();
    if (!uid) return;
    unrunnableBotUids = { ...unrunnableBotUids, [uid]: reason };
    thinkingByRow = clearAgentEverywhere(thinkingByRow, uid);
  }
  /**
   * Per-machine memory for the bot surfaces: the restore prompt's dismissal
   * and the trace of bots this computer has run. Read once, never thrown from.
   */
  const botMachineMemory = (() => {
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  })();
  /**
   * BOTS THIS COMPUTER HAS RUN (uid → name).
   *
   * `hq bot list` reads each bot's own config, so a wiped bot silently drops
   * off it — which is how one of the owner's own bots came to be drawn as
   * `Cloud` and to sit under a spinner for 2 m 39 s while the account listing
   * was unavailable. A uid this app has seen on this Mac's listing, and no
   * longer sees, is local evidence that needs no server: your bot, here, with
   * nothing left to run it.
   */
  let localBotTrace = $state<LocalBotTrace>(readLocalBotTrace(botMachineMemory));
  async function refreshLocalBots(): Promise<void> {
    const api = adapter.bots;
    if (!api) return;
    const result = await api.list();
    if (!result.ok) return;
    const bots = result.value.bots ?? [];
    // A BOT THAT DROPPED OFF THIS MAC'S LISTING IS THE WIPE, AS IT HAPPENS.
    // The account's own listing is what turns that into the honest notice,
    // and on the VM it was on a 120 s timer that had stopped — so the DM
    // showed a live composer for 6 m 40 s. Asking again right here bounds
    // that by one local poll (30 s) whatever the remote cadence is doing.
    const vanished = localBotsDisappeared(localBotRecords, bots);
    localBotRecords = bots;
    localBotTrace = rememberLocalBots(botMachineMemory, localBotTrace, localBotRecords);
    if (vanished.length > 0) void refreshRemoteBots(true);
  }
  /**
   * BOTS COME BACK AFTER A REINSTALL.
   *
   * `hq bot list` above only knows THIS computer, which is why the app could
   * not tell "no such bot" from "your bot, safe in HQ, with nothing here to
   * run it" — the state that had test-bot's DM spinning for 41 s while its own
   * setup said it could not run here. `hq bot list --remote` is the account's
   * own view: every local bot the person owns, each flagged `here` or not.
   * Null until the first listing lands (and on hosts without the command), so
   * "not here" is never inferred from an answer that has not arrived.
   */
  let remoteBotListing = $state<RemoteBotListing>(NO_REMOTE_BOT_LISTING);
  /** One plain sentence when the listing failed; null while it is fine. */
  const remoteListingNotice = $derived(remoteBotListingNotice(remoteBotListing.failure));
  /**
   * This HQ Cloud has no listing route yet, so nothing can be brought back
   * from it. The actions that depend on it are not offered — the sentence
   * above says why, instead of a button that cannot work.
   */
  const botRestoreUnavailable = $derived(remoteBotListing.failure !== null);
  /**
   * One remote listing call in flight at a time — released in `finally`, and
   * bounded, so it can never be pinned.
   *
   * The VM's Defect 8: three calls, then none for 16 m 38 s, while the 30 s
   * local poller kept firing from the same `onMount`. The cadence below is a
   * plain `setInterval` and always was, so nothing here re-arms a chain that
   * could be lost; what this guard buys is that a slow or hung call can
   * neither pile CLI invocations up behind it nor outlive one tick. A person
   * asking (Check again, a finished adopt or restore) always gets a fresh
   * call — `force` skips the guard, never the bound.
   */
  let remoteBotPollBusy = false;
  async function refreshRemoteBots(force = false): Promise<void> {
    const listRemote = adapter.bots?.listRemote;
    if (!listRemote) return;
    if (remoteBotPollBusy && !force) return;
    remoteBotPollBusy = true;
    try {
      const outcome = await withPollTimeout(() => listRemote(), REMOTE_BOTS_CALL_TIMEOUT_MS);
      // A call that never answered is not evidence either: the last good rows
      // stay exactly as they were, one line goes to the log, and the next
      // tick asks again.
      if (outcome.timedOut) {
        console.warn(REMOTE_BOTS_TIMEOUT_LOG);
        return;
      }
      const result = outcome.value;
      // A LISTING THAT FAILED IS NOT EVIDENCE ABOUT ANY BOT. An empty listing
      // and "no answer" must never read the same, so a failure keeps the last
      // good rows (marked stale) and only changes what the app can offer.
      if (result.ok && Array.isArray(result.value?.bots)) {
        remoteBotListing = remoteBotListingOk(result.value.bots);
        localBotTrace = reconcileLocalBotTrace(botMachineMemory, localBotTrace, result.value.bots);
        return;
      }
      if (!result.ok && result.message) {
        console.warn("[hq-desktop] remote bot list failed:", result.message);
      }
      remoteBotListing = remoteBotListingFailed(
        remoteBotListing,
        result.ok ? "malformed" : classifyRemoteBotFailure(result.reason, result.message),
      );
    } catch (err) {
      // A host that throws instead of answering must not end the cadence.
      console.warn("[hq-desktop] remote bot list failed:", err);
      remoteBotListing = remoteBotListingFailed(remoteBotListing, "network");
    } finally {
      remoteBotPollBusy = false;
    }
  }
  /**
   * A start that actually ran: the budget resets and the honest "cannot run
   * here" notice goes with it. Every successful start in the shell — the
   * progress card's Retry, the offline notice's Start, the bot's own profile
   * panel, the sign-in-again restart — comes through here, so a bot that is
   * now running never keeps a notice that says it is not.
   */
  function noteBotStarted(name: string, agentUid: string): void {
    botStartGate = clearBotStartGate(botStartGate, name);
    const uid = (agentUid ?? "").trim();
    if (!uid || !unrunnableBotUids[uid]) return;
    const { [uid]: _running, ...rest } = unrunnableBotUids;
    unrunnableBotUids = rest;
  }
  /**
   * The one place a bot start happens. The gate decides whether it may run at
   * all, a success reopens the gate, and a failure is classified exactly once.
   */
  async function startBotByName(name: string, agentUid: string): Promise<{ ok: boolean; reason: string | null }> {
    const api = adapter.bots;
    if (!api) return { ok: false, reason: botStartFallbackNotice(name) };
    if (!canStartBot(botStartGate, name)) {
      return { ok: false, reason: `${botStartFallbackNotice(name)} ${BOT_START_NO_MORE_RETRIES}` };
    }
    const result = await api.start(name);
    if (result.ok) {
      noteBotStarted(name, agentUid);
      return { ok: true, reason: null };
    }
    // The bots API shells out to the CLI, so `message` can be its own words.
    // They belong in the log; the caller gets a written sentence.
    const raw = result.message ?? "";
    if (raw) console.warn("[hq-desktop] bot start failed:", raw);
    return { ok: false, reason: applyBotStartFailure(name, agentUid, raw) };
  }
  /**
   * A bot that turned up in this Mac's list can run here after all (the person
   * created it, or its config arrived): drop the notice.
   *
   * A CLOSED GATE OUTRANKS THE LIST. `hq bot list` said the owner's bots were
   * there while every start answered "no such bot"; a start that actually ran
   * is better evidence than a listing, so a bot whose gate a definitive
   * failure closed keeps its honest state until "Check again" reopens it.
   */
  $effect(() => {
    const records = localBotRecords;
    untrack(() => {
      const cleared = Object.keys(unrunnableBotUids)
        .map((uid) => records.find((row) => row.agentUid.trim() === uid))
        .filter((bot): bot is LocalBotRow => Boolean(bot))
        // A closed gate outranks a bare listing — but not a listing that
        // shows the bot's process alive HERE. A live local pid is the one
        // claim only this Mac can make, and it is exactly what was missing
        // when every start answered "no such bot", so its arrival is the
        // newer event the notice was waiting for and the gate reopens with
        // it. A launch agent reported installed is not that evidence: the
        // failure this guards against had one (see botIsConfiguredHere).
        .filter((bot) => canStartBot(botStartGate, bot.name) || botIsConfiguredHere(bot));
      if (cleared.length === 0) return;
      const next = { ...unrunnableBotUids };
      let gate = botStartGate;
      for (const bot of cleared) {
        delete next[bot.agentUid.trim()];
        gate = clearBotStartGate(gate, bot.name);
      }
      unrunnableBotUids = next;
      botStartGate = gate;
    });
  });
  /**
   * RUNNABILITY IS LOCAL EVIDENCE FIRST, enhanced by the account's listing.
   *
   * A DM with an owned local bot that is not set up here shows the honest
   * notice from the first frame — no start is issued, and nothing spins. That
   * has to hold when the account listing is missing, unreachable or refused,
   * which is exactly the state the owner's VM was in: the listing answered 404
   * and a wiped bot's DM went back to a normal composer and a 2 m 39 s
   * spinner. So the listing only ADDS bots to this set; this computer's own
   * trace carries it when the listing cannot. Cloud and fleet bots are in
   * neither, so their behaviour is untouched.
   */
  const ownedBotsMissingHere = $derived(
    ownedBotsNotHere(remoteBotListing, localBotTrace, localBotRecords),
  );
  /**
   * The owned bots that are RUNNING on another computer right now.
   *
   * They are still offered — every manual surface can bring one here — but
   * nothing takes them automatically, and every notice about one says what
   * starting it here costs, because the machine credentials rotate and the
   * other Mac's copy stops at its next token refresh.
   */
  const botsLiveElsewhere = $derived(autoRestoreHeldBack(remoteBotListing, localBotRecords));
  const liveElsewhereUids = $derived(
    new Set(botsLiveElsewhere.map((bot) => bot.agentUid.trim()).filter(Boolean)),
  );
  $effect(() => {
    const owned = ownedBotsMissingHere;
    const live = liveElsewhereUids;
    untrack(() => {
      for (const bot of owned) {
        // A bot that is live elsewhere gets the sentence that names the
        // consequence instead of the "open it on that computer" one, and it
        // is re-read when the listing changes: a bot that goes offline over
        // there must stop being described as running.
        const reason = live.has(bot.agentUid) ? BOT_LIVE_ELSEWHERE_NOTICE : BOT_NOT_RUNNABLE_HERE;
        const current = unrunnableBotUids[bot.agentUid];
        if (current === reason) continue;
        // Only the two listing-derived sentences are re-written here: a reason
        // a failed START put there is newer evidence than the listing is.
        if (current && current !== BOT_LIVE_ELSEWHERE_NOTICE && current !== BOT_NOT_RUNNABLE_HERE) {
          continue;
        }
        noteBotCannotRunHere(bot.agentUid, reason);
      }
    });
  });
  /**
   * The person's own local bots, including the ones nothing here can run, so
   * no bot of theirs is ever drawn as `Cloud` because a listing failed.
   */
  const ownedLocalBotUids = $derived(ownedBotsMissingHere.map((bot) => bot.agentUid));
  /** The open DM's bot, when the account owns it and this computer cannot run it. */
  const selectedBotNotHere = $derived(
    selectedRow?.kind === "dm" ? ownedBotNotHere(ownedBotsMissingHere, selectedRow.personUid) : null,
  );
  /** The open DM's bot cannot run here — the honest state, or null. */
  const selectedBotCannotRun = $derived(
    selectedRow?.kind === "dm" && selectedRow.personUid
      ? (unrunnableBotUids[selectedRow.personUid.trim()] ?? null)
      : null,
  );
  /**
   * "Check again": re-read this Mac's bots once, on demand — the only thing
   * the desktop can honestly offer for a bot that lives on another computer.
   * A person asking counts as consent to try the bot once more, so this is
   * also the one thing that reopens a closed start gate. Never a loop: one
   * click, one listing.
   */
  let botRecheckBusy = $state(false);
  async function recheckSelectedBot(): Promise<void> {
    const uid = selectedRow?.kind === "dm" ? (selectedRow.personUid ?? "").trim() : "";
    if (!uid || botRecheckBusy) return;
    botRecheckBusy = true;
    try {
      // Both halves: this computer's bots, and the account's own listing that
      // decides whether the bot is here at all.
      await Promise.all([refreshLocalBots(), refreshRemoteBots(true)]);
      const bot = localBotRecords.find((row) => row.agentUid.trim() === uid);
      if (!bot) return;
      botStartGate = clearBotStartGate(botStartGate, bot.name);
      const { [uid]: _runnableAgain, ...rest } = unrunnableBotUids;
      unrunnableBotUids = rest;
    } finally {
      botRecheckBusy = false;
    }
  }
  onMount(() => {
    if (!adapter.bots) return;
    void refreshLocalBots();
    void refreshRemoteBots();
    // Jittered (R2): a fixed period put every client's bot refresh on the
    // same beat, and a throttled pass now pushes its successor out.
    const stopLocal = startJitteredPoll({
      intervalMs: LOCAL_BOTS_POLL_MS,
      tick: () => refreshLocalBots(),
    });
    const stopRemote = startJitteredPoll({
      intervalMs: REMOTE_BOTS_POLL_MS,
      tick: () => refreshRemoteBots(),
    });
    return () => {
      stopLocal();
      stopRemote();
    };
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
    input?: LocalBotCreateInput;
    extras: CreateBotExtras;
    /**
     * Set when this card is a bot being brought back (`hq bot adopt`), not one
     * being created. Retry then re-runs the adopt: the account already owns
     * this bot, and creating a second one is exactly what adopt exists to
     * prevent.
     */
    adoptName?: string;
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
    if (!result.ok) {
      // The bots API shells out to `hq bot create`, so `message` can be the
      // CLI's relay of hq-pro's own words ("HQ API /v1/agents → 409: Entity
      // with type=… already exists"). That belongs in the log, never on
      // screen: the caller gets a written sentence plus the raw text to match
      // known conditions against.
      const raw = result.message ?? "";
      if (raw) console.warn("[hq-desktop] bot create failed:", raw);
      return { ok: false, reason: plainBotFailure(raw, `Could not create ${input.name}.`), raw };
    }
    const value = (result.value ?? {}) as Record<string, unknown>;
    const agentUid = typeof value.agentUid === "string" ? value.agentUid.trim() : "";
    await refreshLocalBots();
    if (!agentUid) return { ok: true, agentUid: "", name: input.name };
    // A kickoff turn starts with no message from the person, so nothing else
    // would show "is thinking…" while the bot works on it.
    if (input.kickoff?.trim()) kickoffPendingByUid = { ...kickoffPendingByUid, [agentUid]: input.name };
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
    void saveNewBotProfile(agentUid, extras);
    return { ok: true, agentUid, name: input.name };
  }
  /**
   * The parts of the create flow neither create path has a field for — the job
   * title and the avatar pick — written onto the agent profile now that the
   * bot has a uid. Sequential: both land on the same profile document. Local
   * bots bring both; a cloud bot brings the title.
   */
  async function saveNewBotProfile(agentUid: string, extras: CreateBotExtras): Promise<void> {
    const title = extras.title?.trim() ?? "";
    if (title) {
      try {
        await adapter.identity.updateAgentProfile(agentUid, { title });
      } catch (err) {
        // The bot exists and works; only its subtitle is missing.
        console.warn("[hq-desktop] bot title save failed:", err);
      }
    }
    if (extras.avatar) await saveNewBotAvatar(agentUid, extras.avatar);
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
  /**
   * SETUP AS A LOCAL BOT (bots v2, step 3). Run Setup no longer starts a
   * scripted `/setup` session: it creates a Local bot named `setup` from the
   * core template and opens its DM, so onboarding is a normal conversation
   * with a bot that stays afterwards. Copy, names and the launcher contract
   * live in `chat/setup-bot.ts`; everything here reuses `createBotEntry` (and
   * therefore the progress card, the synthetic DM row and presence polling).
   */
  /** Set once the setup bot was started this session, automatically or by Run Setup. */
  let setupBotAutoStarted = false;
  /** True while startSetupBot is creating the bot, so #welcome can say so. */
  let setupBotStarting = $state(false);
  let setupBotStartError = $state<string | null>(null);
  // Every hosting kind counts as "already here": a setup bot promoted to the
  // cloud is filtered out of `localBots`, but it is still the person's bot and
  // must be opened, never re-created.
  const existingSetupBot = $derived(findSetupBot(localBotRecords));
  const setupBotRuntimeReady = $derived(Boolean(firstSignedInRuntime(localBotRuntimeReady)));
  const setupBotLauncher = $derived.by<SetupBotLauncher | null>(() =>
    adapter.bots && SETUP_BOT_MODE
      ? { existing: Boolean(existingSetupBot), ready: setupBotRuntimeReady, starting: setupBotStarting, error: setupBotStartError, start: startSetupBot }
      : null,
  );
  /**
   * Open a setup bot's DM; setup counts as run from that moment.
   *
   * ADOPT-TIME RUNNABILITY CHECK. Adopting a bot the account owns in the cloud
   * opens its conversation — it does NOT give this Mac a way to run it. When
   * no local config exists here, the DM says so from the first frame instead
   * of presenting a normal bot that will never answer.
   */
  function openSetupBotDm(bot: SetupBotRef): void {
    if (!botRunsHere(localBotRecords, bot.agentUid)) {
      noteBotCannotRunHere(bot.agentUid);
      // A cloud-only setup bot is one the account owns, so the notice can
      // offer to bring it back here rather than only "Check again" — but only
      // once the account's own listing says so. Ask for it now.
      void refreshRemoteBots(true);
    }
    const existing = railRows.find((row) => row.kind === "dm" && row.personUid === bot.agentUid);
    handleSelect(
      existing ?? {
        id: `dm:${bot.agentUid}`,
        kind: "dm",
        title: bot.name,
        companyUid: null,
        unreadDot: false,
        lastActivityAt: Date.now(),
        pinned: false,
        personUid: bot.agentUid,
      },
    );
    recordWelcomeSetupRun();
  }
  /**
   * Create the setup bot, or open the one that already exists — on this Mac
   * OR in the cloud account. Never creates a second one: `singleFlightStart`
   * hands a caller that arrives mid-start the running start's own result,
   * because each surface only disables its own button (the owner's log caught
   * two `hq bot create setup` calls 1.3 s apart).
   */
  const setupBotStartGate = singleFlightStart(async (): Promise<SetupBotStart> => {
    setupBotStarting = true;
    setupBotStartError = null;
    try {
      const result = await runSetupBotStart();
      if (!result.ok) setupBotStartError = result.reason;
      return result;
    } catch (err) {
      // A sentence, never a stack: the surfaces render this verbatim.
      console.warn("[hq-desktop] setup bot start threw:", err);
      setupBotStartError = SETUP_BOT_GENERIC_FAILURE;
      return { ok: false, reason: SETUP_BOT_GENERIC_FAILURE };
    } finally {
      setupBotStarting = false;
    }
  });
  function startSetupBot(): Promise<SetupBotStart> {
    return setupBotStartGate();
  }
  /**
   * The setup bot this account already owns, wherever it lives. `hq bot list`
   * only knows this Mac, so after a reinstall — or on a second Mac — the local
   * list is empty while the cloud account still owns the agent entity, and a
   * create 409s. The DM roster is the desktop's one cloud-side view of the
   * person's own bots, so it is asked before anything is created.
   */
  async function findExistingSetupBot(): Promise<SetupBotRef | null> {
    const local = findSetupBot(localBotRecords);
    if (local) return local;
    try {
      const contacts = await adapter.messaging?.listContacts?.();
      if (contacts?.ok) return findSetupBotContact(contacts.value);
    } catch (err) {
      // A roster we cannot read only costs us the early adoption: a create
      // that then 409s is adopted below.
      console.warn("[hq-desktop] could not check the cloud roster for a setup bot:", err);
    }
    return null;
  }
  async function runSetupBotStart(): Promise<SetupBotStart> {
    // Any start (the automatic one or a click) settles the automatic start.
    setupBotAutoStarted = true;
    if (!adapter.bots) return { ok: false, reason: SETUP_BOT_UNAVAILABLE };
    await refreshLocalBots();
    const existing = await findExistingSetupBot();
    if (existing) {
      openSetupBotDm(existing);
      return { ok: true, existing: true };
    }
    // Re-read sign-in state: the Connect step signs in through the setup run's
    // own API, so a readiness answer cached at boot can be a click out of date.
    localBotRuntimeReady = null;
    await loadLocalBotRuntimeReady();
    const runtime = firstSignedInRuntime(localBotRuntimeReady);
    if (!runtime) return { ok: false, reason: SETUP_BOT_NO_RUNTIME };
    // `intro` is sent by the runtime on start, so the first message is
    // instant instead of a ~30 s wait for a model turn; `kickoff` then runs
    // one turn by itself so the bot starts step one without waiting for the
    // person to type.
    const created = await createBotEntry({
      name: SETUP_BOT_NAME,
      worker: SETUP_BOT_WORKER,
      runtime,
      intro: SETUP_BOT_INTRO,
      kickoff: SETUP_BOT_KICKOFF,
      // Setup is a personal bot (bot-kinds) — the CLI default, so nothing to pass.
    });
    if (created.ok) {
      recordWelcomeSetupRun();
      return { ok: true, existing: false };
    }
    // "It already exists" is the opposite of a failure: the bot the person
    // needs is there. Another window, another Mac, or this account's earlier
    // install got in first — re-read both views and open it.
    if (isAlreadyExistsFailure(created.raw ?? created.reason)) {
      await refreshLocalBots();
      const adopted = await findExistingSetupBot();
      if (adopted) {
        openSetupBotDm(adopted);
        return { ok: true, existing: true };
      }
      return { ok: false, reason: SETUP_BOT_ALREADY_ELSEWHERE };
    }
    return { ok: false, reason: created.reason };
  }
  /**
   * First open on this Mac: the setup bot starts by itself, so the person is
   * greeted and walked through setup without pressing anything. Only when
   * setup has never been run here, a coding tool is signed in (otherwise Run
   * Setup shows the Connect step first), and once per app session. Run Setup
   * then opens the bot's conversation. A failure leaves Run Setup to retry
   * and explain.
   */
  $effect(() => {
    if (setupBotAutoStarted || !adapter.bots || !SETUP_BOT_MODE || welcomeSetupRun) return;
    // Wait for the shell's first conversation to be chosen, so opening the
    // bot's DM is not undone by the boot selection landing afterwards.
    if (!selectedRow) return;
    if (!firstSignedInRuntime(localBotRuntimeReady)) return;
    setupBotAutoStarted = true;
    void startSetupBot()
      .then((result) => {
        if (!result.ok) console.warn("[hq-desktop] setup bot did not start by itself:", result.reason);
      })
      .catch((err) => console.warn("[hq-desktop] setup bot did not start by itself:", err));
  });
  /** Retry from the progress card: start the bot if it exists, else re-run the same create. */
  async function retryBotProgress(uid: string): Promise<void> {
    const entry = botProgressByUid[uid];
    const api = adapter.bots;
    if (!entry || !api || entry.retrying) return;
    const bot = localBots.find((b) => b.agentUid === uid);
    // Nothing is re-issued once the gate is closed; the card renders its
    // Retry disabled in that state (`canRetry` below) so the click cannot
    // happen at all rather than happening and doing nothing.
    if (bot && !canStartBot(botStartGate, bot.name)) return;
    setBotProgress(uid, { retrying: true, reason: null });
    if (bot) {
      const started = await startBotByName(bot.name, bot.agentUid);
      if (!started.ok) {
        setBotProgress(uid, { retrying: false, state: "failed", reason: started.reason });
        return;
      }
      // Re-read presence FIRST: flipping to "installing" while the list still
      // says "failed" lets the presence effect below stamp it failed again.
      await refreshLocalBots();
      setBotProgress(uid, { retrying: false, state: "installing", startedAt: Date.now() });
      return;
    }
    if (entry.adoptName) {
      const brought = await startBotHere(entry.adoptName, uid);
      if (!brought.ok) setBotProgress(uid, { retrying: false, state: "failed", reason: brought.reason });
      return;
    }
    if (!entry.input) {
      setBotProgress(uid, { retrying: false });
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
      if (entry.state === "online") continue;
      const bot = localBots.find((b) => b.agentUid === uid);
      // A heartbeat is the last word: a bot that checked in is online even if
      // the card had already given up on it.
      if (bot?.online === true) {
        setBotProgress(uid, { state: "online" });
        window.setTimeout(() => clearBotProgress(uid), 1500);
        continue;
      }
      if (entry.state === "failed") continue;
      if (bot?.state === "failed") {
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
  /**
   * The open DM's card is a bot being brought back, not one being created. The
   * bot is still "not here" while the adopt runs, so the progress card has to
   * outrank the honest notice for exactly that window — otherwise pressing
   * "Start on this computer" looks like it did nothing.
   */
  const selectedBotAdopting = $derived(Boolean(selectedBotProgress?.adoptName));
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
  /**
   * The open bot's coding tool needs a new sign-in (`hq bot list` reports it):
   * the bot has paused, so the conversation says so above the composer and
   * offers the sign-in instead of looking silently stuck.
   */
  /**
   * THE NOTICE BELONGS AT THE BOTTOM, NOT THE TOP.
   *
   * The owner's screenshot: the "Start on this computer" card rendered above
   * the oldest message, under a YESTERDAY divider — "this shouldn't be on the
   * top because its easy to miss". He never saw it, typed into the composer,
   * and read that his message was unanswered. So it renders as the LAST thing
   * in the conversation, directly above the composer, where the person already
   * is. Precedence is what the header expression had: the honest "cannot run
   * here" notice outranks the progress card, and the plain offline notice only
   * shows when neither is in play.
   */
  const botNoticeBelow = $derived(
    Boolean(selectedBotCannotRun && !selectedBotAdopting) ||
      Boolean(!selectedBotProgress && selectedLocalBot && selectedLocalBotOffline),
  );
  const selectedLocalBotNeedsSignIn = $derived(botNeedsSignIn(selectedLocalBot));
  /** Coding tools some local bot is paused on — evidence a "Connected" tool is dead. */
  const staleRuntimes = $derived(runtimesNeedingSignIn(localBots));
  /**
   * Which coding tools the Connect step must treat as signed out despite the
   * CLI saying otherwise: a run that stopped with "Failed to authenticate",
   * and any tool a local bot is paused on.
   */
  function setupStaleTools(failure: { kind: string } | null): ("claude" | "codex")[] {
    const out = new Set<"claude" | "codex">();
    for (const runtime of staleRuntimes) if (runtime === "claude" || runtime === "codex") out.add(runtime);
    if (failure?.kind === "auth") {
      const ran = setupAgent.lastRunTool;
      if (ran) out.add(ran);
      else if (setupAgent.providers) {
        if (setupAgent.providers.claudeLoggedIn) out.add("claude");
        if (setupAgent.providers.codexLoggedIn) out.add("codex");
      }
    }
    return [...out];
  }
  /** Restart the bots paused on a tool after it was signed in again elsewhere. */
  async function afterRuntimeSignedIn(runtime: string): Promise<void> {
    await restartBotsNeedingSignIn(runtime as LocalBotRow["runtime"], adapter.bots ?? null, {
      // Same gate as every other start: a bot whose start already failed
      // definitively is not re-issued here either, and one that does start
      // drops its "cannot run here" notice.
      canStart: (bot) => canStartBot(botStartGate, bot.name),
      onstarted: (bot) => noteBotStarted(bot.name, bot.agentUid),
    });
    await refreshLocalBots();
  }
  async function startSelectedLocalBot(): Promise<void> {
    const bot = selectedLocalBot;
    if (!bot || !adapter.bots || localBotBusy) return;
    // A definitive failure is never re-issued, and transient ones are bounded:
    // the owner's VM retried the same doomed start ~48 times.
    if (!canStartBot(botStartGate, bot.name)) return;
    localBotBusy = bot.name;
    localBotActionError = null;
    const started = await startBotByName(bot.name, bot.agentUid);
    if (!started.ok) localBotActionError = started.reason;
    await refreshLocalBots();
    localBotBusy = null;
  }
  /** The bot's own profile panel starts it through the same gate. */
  async function startBotFromProfile(bot: LocalBotRow): Promise<{ ok: boolean; reason: string | null }> {
    return startBotByName(bot.name, bot.agentUid);
  }
  // ── Bringing bots back to this computer ────────────────────────────────────
  /** The bot currently being brought back, so its button can say so. */
  let botAdoptBusy = $state<string | null>(null);
  /** The last adopt failure, as a sentence a person can act on. */
  let botAdoptError = $state<string | null>(null);
  /**
   * "Start on this computer" — `hq bot adopt <name>`.
   *
   * The bot the account owns gets its machine credentials re-issued here, its
   * saved settings, worker folder and startup agent rebuilt, and a start. It
   * keeps its identity, its memory and this conversation; only the half a
   * reinstall took away is put back. Progress rides the same card a new bot
   * uses, and a success clears the gate so the DM becomes a normal bot.
   */
  async function startBotHere(name: string, agentUid: string): Promise<{ ok: boolean; reason: string | null }> {
    const adopt = adapter.bots?.adopt;
    const uid = (agentUid ?? "").trim();
    if (!adopt) return { ok: false, reason: adoptFallbackNotice(name) };
    if (botAdoptBusy) return { ok: false, reason: null };
    botAdoptBusy = name;
    botAdoptError = null;
    if (uid) {
      botProgressByUid = {
        ...botProgressByUid,
        [uid]: { name, state: "installing", reason: null, extras: {}, adoptName: name, startedAt: Date.now(), retrying: false },
      };
    }
    const result = await adopt(name);
    botAdoptBusy = null;
    if (!result.ok) {
      // The bots API shells out to the CLI, so `message` can be its own words
      // (or hq-pro's). They belong in the log; the notice gets a sentence.
      const raw = result.message ?? "";
      if (raw) console.warn("[hq-desktop] bot adopt failed:", raw);
      // A refusal the CLI named is not "please try again": a company bot's
      // identity cannot run on a personal Mac, now or later, and the failure
      // document that says so is exactly the machine text `plainBotFailure`
      // is right to refuse to render.
      const reason = isNotRunnableHereReason(botFailureReason(raw))
        ? botStaysInCloudLine(name)
        : plainBotFailure(raw, adoptFallbackNotice(name));
      if (uid) clearBotProgress(uid);
      botAdoptError = reason;
      return { ok: false, reason };
    }
    // It runs here now: the gate reopens and the honest notice goes with it.
    noteBotStarted(name, uid);
    await Promise.all([refreshLocalBots(), refreshRemoteBots(true)]);
    if (uid) setBotProgress(uid, { retrying: false, state: "installing", startedAt: Date.now() });
    return { ok: true, reason: null };
  }
  /** Start the open DM's bot here, from the "cannot run here" notice. */
  async function startSelectedBotHere(): Promise<void> {
    const bot = selectedBotNotHere;
    if (!bot) return;
    await startBotHere(bot.name, bot.agentUid);
  }
  /**
   * RESTORE MY BOTS — the one prompt after a fresh install or a new Mac.
   *
   * Non-blocking, shown once, and remembered per machine so it never nags at
   * launch. Settings › Bots is where a person asks for it again.
   */
  let botRestoreDismissed = $state(botRestorePromptDismissed(botMachineMemory));
  let botRestoreBusy = $state(false);
  let botRestoreResult = $state<BotRestoreResult | null>(null);
  let botRestoreError = $state<string | null>(null);
  /**
   * What `hq bot restore --all` would actually bring back: bots the account's
   * own listing named, minus any that this Mac's listing shows are here after
   * all. Trace-only bots are deliberately not counted — restoring goes
   * through HQ Cloud, so a listing the app could not read cannot be the basis
   * for offering it.
   */
  const botsMissingHere = $derived(
    botsNotHere(remoteBotListing.rows).filter((bot) => !botRunsHere(localBotRecords, bot.agentUid)),
  );
  // ── Bots come back BY THEMSELVES ──────────────────────────────────────────
  //
  // The owner, on a fresh install: "I don't understand, the whole point of our
  // project was to automatically start up local bots when you installed the
  // app." He opened the setup bot's DM, typed "hi", and read "Not answered yet
  // — this bot isn't running on this computer", with the "Start on this
  // computer" notice above the fold where he never saw it. The mechanism was
  // fine: on the VM `hq bot restore --all --json` brought both bots online in
  // about five seconds. The product was wrong to ask for the click at all.
  //
  // So the app asks for itself. Three trigger points, one effect: the first
  // successful listing after sign-in on a fresh install, the moment a runtime
  // becomes ready (Connect Claude in the wizard re-reads readiness through
  // `onBotRuntimeSignedIn`), and any later listing that shows a runnable bot
  // which is not here — so a bot wiped by an update or a crash comes back the
  // same way a reinstall's does.
  /** Automatic attempts this session, per bot. Never persisted. */
  let autoRestoreAttempts = $state<AutoRestoreAttempts>({});
  /**
   * When each bot was last tried automatically — the back-off, per bot.
   *
   * Per bot rather than per listing, so what is charged and what is waited for
   * can never drift apart: a send that brings ONE bot back charges that bot
   * and waits for that bot, and the others are neither spent nor held.
   */
  let autoRestoreLastAt = $state<AutoRestoreLastAttempts>({});
  /** Single-flight: one automatic restore at a time, ever. */
  let autoRestoreBusy = $state(false);
  /** The bots this automatic restore is bringing back, by uid. */
  let autoRestoringUids = $state<string[]>([]);
  /**
   * The ONE line a person reads about this, cleared by the next newer event
   * and never by a timer (policy
   * `transient-indicators-clear-on-newer-event-not-time-window`).
   */
  let autoRestoreStatus = $state<string | null>(null);
  /** Bots the app could bring back by itself right now. */
  const autoRestorableBots = $derived(autoRestoreCandidates(remoteBotListing, localBotRecords));
  /**
   * A runtime is signed in here — the same readiness check Run Setup uses.
   * Restoring a bot with no runtime to run it only produces a bot that cannot
   * start, so the app waits for the sign-in rather than spending its budget.
   */
  const autoRestoreReady = $derived(
    Boolean(adapter.bots?.restore) &&
      !botRestoreUnavailable &&
      Boolean(firstSignedInRuntime(localBotRuntimeReady)),
  );
  /** True while automatic restore owns these bots: the banner stands down. */
  const autoRestoreHandling = $derived(
    autoRestoreBusy ||
      (autoRestoreReady &&
        autoRestorableBots.length > 0 &&
        !autoRestoreExhausted(autoRestoreAttempts, autoRestorableBots)),
  );
  /** The open DM's bot is one being brought back right now. */
  const selectedBotAutoRestoring = $derived(
    selectedRow?.kind === "dm" && selectedRow.personUid
      ? autoRestoringUids.includes(selectedRow.personUid.trim())
      : false,
  );
  $effect(() => {
    const candidates = autoRestorableBots;
    const ready = autoRestoreReady;
    untrack(() => void autoRestoreIfNeeded(candidates, ready));
  });
  /**
   * Decide, then act. Everything that would make this churn is a guard here:
   * a listing that failed yields no candidates at all, a person-driven restore
   * or adopt owns the CLI while it runs, one listing state is acted on once,
   * and each bot has a budget of `AUTO_RESTORE_MAX_ATTEMPTS`.
   */
  async function autoRestoreIfNeeded(
    candidates: readonly RemoteBotRow[],
    ready: boolean,
  ): Promise<void> {
    if (!ready || candidates.length === 0) return;
    // Never overlapping with a person-driven restore or adopt: two `hq bot`
    // writes at once is exactly what `singleFlightStart` exists to prevent.
    if (autoRestoreBusy || botRestoreBusy || botAdoptBusy) return;
    // A bot never tried goes at once — one wiped by an update or a crash comes
    // back the same way a reinstall's does. One tried already waits: a fresh
    // install lands two listings inside a second (the poll, then the setup
    // bot's DM asking for one), and spending the whole budget on the same
    // evidence twice would leave a transient failure with nothing left.
    const allowed = autoRestoreDue(
      autoRestoreLastAt,
      autoRestoreAllowed(autoRestoreAttempts, candidates),
      Date.now(),
    );
    if (allowed.length === 0) return;
    await runAutoRestore(allowed);
  }
  /**
   * Bring these bots back, with no click — and ONLY these bots.
   *
   * `hq bot restore` takes no names: it brings back every bot the account owns
   * that is not set up here. That is the right call whenever the app is asking
   * for exactly that set — one process, one token, one pass — and the wrong
   * one the moment it is not. A bot held back because it is running on another
   * Mac, or one whose automatic budget is spent, would be taken by the bulk
   * call anyway and charged to nobody, so those go one at a time through
   * `hq bot adopt <name>` instead. What is restored and what is charged are
   * the same set, always.
   *
   * A failure BACKS OFF rather than stopping: the per-bot budget is what ends
   * it. When the budget is gone the manual notice is the honest surface again
   * — which is why nothing here dismisses it permanently.
   */
  async function runAutoRestore(bots: readonly RemoteBotRow[]): Promise<void> {
    const restore = adapter.bots?.restore;
    const adoptOne = adapter.bots?.adopt;
    if (autoRestoreBusy || bots.length === 0) return;
    const bulk = Boolean(restore) && autoRestoreCoversAll(bots, botsMissingHere);
    if (!bulk && !adoptOne) return;
    autoRestoreBusy = true;
    const startedAt = Date.now();
    autoRestoreLastAt = noteAutoRestoreAttempt(autoRestoreLastAt, bots, startedAt);
    autoRestoreAttempts = countAutoRestoreAttempt(autoRestoreAttempts, bots);
    autoRestoringUids = bots.map((bot) => bot.agentUid.trim()).filter(Boolean);
    const names = bots.map((bot) => bot.name);
    autoRestoreStatus = AUTO_RESTORE_RUNNING;
    try {
      const back: string[] = [];
      const stuck: string[] = [];
      if (bulk) {
        // No `--all`: that flag additionally re-issues credentials for the
        // bots already set up here, which this run neither named nor charged.
        const result = await restore!({ all: false });
        if (!result.ok || !result.value) {
          // The bots API shells out to the CLI, so `message` can be its own
          // words. They belong in the log; the line gets a written sentence.
          const raw = (result.ok ? "" : result.message) ?? "";
          if (raw) console.warn("[hq-desktop] automatic bot restore failed:", raw);
          autoRestoreStatus = autoRestoreFailedLine(names, remoteListingNotice);
          return;
        }
        for (const row of result.value.bots ?? []) {
          if (row.action === "restored" || row.action === "repaired") {
            noteBotStarted(row.name, row.agentUid);
            back.push(row.name);
          } else if (botRestoreRowFailed(row)) {
            stuck.push(row.name);
          }
        }
      } else {
        for (const bot of bots) {
          const result = await adoptOne!(bot.name);
          if (result.ok) {
            noteBotStarted(bot.name, bot.agentUid);
            back.push(bot.name);
            continue;
          }
          const raw = result.message ?? "";
          if (raw) console.warn("[hq-desktop] automatic bot adopt failed:", raw);
          stuck.push(bot.name);
        }
      }
      autoRestoreStatus =
        back.length > 0
          ? stuck.length > 0
            ? `${autoRestoreDoneLine(back)} ${autoRestoreFailedLine(stuck, remoteListingNotice)}`
            : autoRestoreDoneLine(back)
          : stuck.length > 0
            ? autoRestoreFailedLine(stuck, remoteListingNotice)
            : null;
      await Promise.all([refreshLocalBots(), refreshRemoteBots(true)]);
    } catch (err) {
      // A host that throws must not leave the app claiming it is still working.
      console.warn("[hq-desktop] automatic bot restore threw:", err);
      autoRestoreStatus = autoRestoreFailedLine(names, remoteListingNotice);
    } finally {
      autoRestoreBusy = false;
      autoRestoringUids = [];
    }
  }
  /**
   * A person wrote to a bot that is not running here: bring it back NOW rather
   * than at the next poll.
   *
   * The message is not lost while that happens. `hq dm` puts a message for an
   * `agt_*` recipient in the agent's OWN durable box inbox server-side
   * (`GET /v1/notify/inbox`, acked explicitly once read), so it waits there,
   * unread, until the bot starts and reads it — which is why the send goes
   * through immediately instead of being held.
   */
  function autoRestoreForSend(agentUid: string): boolean {
    const uid = (agentUid ?? "").trim();
    if (!uid || !autoRestoreReady) return false;
    // `autoRestorableBots` is the automatic set, so a bot that is RUNNING on
    // another computer is not in it — writing to a bot must not take it off
    // the Mac it is answering on. The conversation says so in one sentence and
    // keeps the button, which is the person's to press.
    const bot = autoRestorableBots.find((row) => row.agentUid.trim() === uid);
    if (!bot) return false;
    if (autoRestoreBusy || botRestoreBusy || botAdoptBusy) return autoRestoringUids.includes(uid);
    if (autoRestoreAllowed(autoRestoreAttempts, [bot]).length === 0) return false;
    // A person writing is a NEWER EVENT than the listing that was already
    // acted on, so this one goes straight to the restore — no waiting for the
    // next 120 s listing, which is the whole dead-DM moment.
    void runAutoRestore([bot]);
    return true;
  }
  const showBotRestorePrompt = $derived(
    Boolean(adapter.bots?.restore) &&
      !botRestoreUnavailable &&
      !botRestoreDismissed &&
      !botRestoreResult &&
      // The banner is the FALLBACK now. While the app is bringing the same
      // bots back by itself, a prompt asking for the click it no longer needs
      // is the confusion this whole change removes.
      !autoRestoreHandling &&
      botsMissingHere.length > 0,
  );
  function dismissBotRestorePrompt(): void {
    botRestoreDismissed = true;
    rememberBotRestoreDismissed(botMachineMemory);
  }
  async function restoreMyBots(): Promise<void> {
    const restore = adapter.bots?.restore;
    if (!restore || botRestoreBusy) return;
    botRestoreBusy = true;
    botRestoreError = null;
    const result = await restore({ all: true });
    botRestoreBusy = false;
    if (!result.ok || !result.value) {
      const raw = (result.ok ? "" : result.message) ?? "";
      if (raw) console.warn("[hq-desktop] bot restore failed:", raw);
      botRestoreError = plainBotFailure(raw, BOT_RESTORE_FAILED);
      return;
    }
    botRestoreResult = result.value;
    // Asking counts as answering the prompt: it is not offered again by itself.
    rememberBotRestoreDismissed(botMachineMemory);
    for (const row of result.value.bots ?? []) {
      if (row.action === "restored" || row.action === "repaired") noteBotStarted(row.name, row.agentUid);
    }
    await Promise.all([refreshLocalBots(), refreshRemoteBots(true)]);
  }
  /**
   * One place where a failed start becomes state: it counts against the bot's
   * budget, a "no such bot" turns into the honest "cannot run here" (which
   * also ends the thinking row), and the caller gets a written sentence —
   * never the CLI's or the API's own words.
   */
  function applyBotStartFailure(name: string, agentUid: string, raw: string): string {
    const kind = classifyBotStartFailure(raw);
    botStartGate = recordBotStartFailure(botStartGate, name, kind);
    if (kind === "missing") {
      noteBotCannotRunHere(agentUid);
      return BOT_NOT_RUNNABLE_HERE;
    }
    const sentence = plainBotFailure(raw, botStartFallbackNotice(name));
    return canStartBot(botStartGate, name) ? sentence : `${sentence} ${BOT_START_NO_MORE_RETRIES}`;
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
  /**
   * Per-file conflicts the Core popover lists. Since #913 the runner's
   * per-file `sync:conflict` event is forwarded from both manual Sync Now and
   * the watch daemon, carrying the conflicted path, so these rows reflect the
   * real conflict set; the `sync:complete` aggregate still drives the notice
   * count and the recovery card. This state exists so a row's Keep local /
   * Keep cloud buttons reach `resolve_conflict` instead of doing nothing,
   * which is what they did in the desktop window before (the handlers had
   * stayed behind in the menubar popover).
   */
  let conflictFiles = $state<HomeConflict[]>([]);

  function setConflictStatus(
    path: string,
    status: HomeConflict["status"],
    error?: string,
  ): void {
    conflictFiles = conflictFiles.map((c) =>
      c.path === path ? { ...c, status, error } : c,
    );
  }

  /**
   * Keep local / Keep cloud on a Core-popover conflict row.
   *
   * Runs the same `resolve_conflict` command the menubar popover used (the
   * adapter forwards it to `hq sync resolve`), then re-reads the journal so
   * the conflict count and the sync state settle on the real outcome rather
   * than an optimistic guess.
   */
  async function resolveConflictFile(
    path: string,
    strategy: "keep-local" | "keep-remote",
  ): Promise<void> {
    if (!adapter.isAvailable("canSync")) return;
    if (typeof adapter.sync?.resolveConflict !== "function") return;
    const current = conflictFiles.find((c) => c.path === path);
    if (current && current.status === "resolving") return;
    setConflictStatus(path, "resolving");
    let result;
    try {
      result = await adapter.sync.resolveConflict(path, strategy);
    } catch (err) {
      console.error("resolve_conflict threw:", err);
      setConflictStatus(path, "error", "Could not resolve this file.");
      return;
    }
    if (!result.ok) {
      console.error("resolve_conflict failed:", result.reason, result.message);
      setConflictStatus(
        path,
        "error",
        result.message?.trim() || "Could not resolve this file.",
      );
      return;
    }
    // Resolved files leave the list; the row disappearing IS the confirmation.
    conflictFiles = conflictFiles.filter((c) => c.path !== path);
    liveSync = await readLiveSyncStatus(adapter);
  }

  /**
   * "Open in editor" on a conflict row — same `open_in_editor` command the
   * popover called. It lives on the shell slice (canLaunchApps), not sync.
   */
  async function openConflictInEditor(path: string): Promise<void> {
    if (!adapter.isAvailable("canLaunchApps")) return;
    if (typeof adapter.shell?.openInEditor !== "function") return;
    try {
      const result = await adapter.shell.openInEditor(path);
      if (!result.ok) {
        console.error("open_in_editor failed:", result.reason, result.message);
      }
    } catch (err) {
      console.error("open_in_editor threw:", err);
    }
  }

  /**
   * The title bar's "Resolve conflicts" recovery action.
   *
   * Resolve-all deliberately does NOT pick a strategy on the user's behalf —
   * keep-local and keep-remote each discard one side of every file at once.
   * When per-file rows exist the popover already offers the choice per file;
   * otherwise (the aggregate-only path the runner actually produces) this
   * opens Settings › Sync, which is where the conflict is worked through. The
   * button's own "Opening…" label is written for this.
   */
  function openConflictResolution(): void {
    openSettings("sync");
  }
  /**
   * PL-02 — sync trouble the Core popover reports, read from the SAME
   * `list_syncable_workspaces` envelope the menubar used. The command never
   * rejects on a cloud outage; it resolves `{ cloudReachable: false, error }`,
   * and `manifestError` is set when companies/manifest.yaml could not be read.
   * Defaults are healthy so a host that cannot sync shows no notices at all.
   */
  let cloudReachable = $state(true);
  let cloudError = $state<string | null>(null);
  let manifestError = $state<string | null>(null);
  let syncWorkspaces = $state<Record<string, unknown>[]>([]);
  let hqFolderPath = $state<string | null>(null);

  async function readWorkspaceHealth(): Promise<void> {
    if (!adapter.isAvailable("canSync")) return;
    // `canSync` is a capability flag, not a guarantee that this particular
    // host implements the workspaces listing. Missing method = no notices,
    // not a crash in the shell's mount effect.
    if (typeof adapter.sync?.listSyncableWorkspaces !== "function") return;
    let res;
    try {
      res = await adapter.sync.listSyncableWorkspaces();
    } catch (err) {
      console.error("listSyncableWorkspaces (core notices) threw:", err);
      return;
    }
    if (!res.ok) {
      // `unavailable` is a host without the command, not an outage — saying
      // "Cloud unreachable" there would be a lie.
      if (res.reason !== "unavailable") {
        console.error("listSyncableWorkspaces (core notices) failed:", res.message);
      }
      return;
    }
    const envelope = (res.value ?? {}) as unknown as Partial<WorkspacesResult>;
    cloudReachable = envelope.cloudReachable !== false;
    cloudError =
      typeof envelope.error === "string" && envelope.error.trim()
        ? envelope.error.trim()
        : null;
    manifestError =
      typeof envelope.manifestError === "string" && envelope.manifestError.trim()
        ? envelope.manifestError.trim()
        : null;
    syncWorkspaces = Array.isArray(envelope.workspaces)
      ? (envelope.workspaces as unknown as Record<string, unknown>[])
      : [];
    hqFolderPath =
      typeof envelope.hqFolderPath === "string" && envelope.hqFolderPath.trim()
        ? envelope.hqFolderPath.trim()
        : hqFolderPath;
  }
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

  /** Palette `shortcut` label for a registered binding id. */
  function shortcutLabel(id: string): string | undefined {
    const binding = shellShortcuts.find((b) => b.id === id);
    return binding ? formatShortcut(binding.keys) : undefined;
  }

  /** Companies eligible for "Show only …" scope rows (cloud-backed, non-personal). */
  const scopeCompanies = $derived(
    (companies ?? [])
      .filter((w) => w.kind !== "personal" && (w.cloudUid ?? "").trim())
      .map((w) => ({
        companyUid: (w.cloudUid as string).trim(),
        label: w.displayName?.trim() || w.slug,
      })),
  );

  const paletteCommands = $derived.by((): CommandPaletteItem[] => {
    const nav: CommandPaletteItem[] = [
      {
        id: "command-go-notifications",
        label: "Notifications",
        detail: "Open the notifications feed",
        shortcut: shortcutLabel("view.notifications"),
        action: () => {
          void navigate({ kind: "notifications" });
        },
      },
      {
        id: "command-go-meetings",
        label: "Meetings",
        detail: "Open the meetings agenda",
        shortcut: shortcutLabel("view.meetings"),
        action: () => {
          void navigate({ kind: "meetings" });
        },
      },
    ];
    nav.push({
      id: "command-go-library",
      label: "Library",
      detail: "Open skills available to you",
      shortcut: shortcutLabel("view.library"),
      action: () => openLibrary("skills"),
    });
    nav.push({
      id: "command-go-settings",
      label: "Settings",
      detail: "Open settings",
      shortcut: shortcutLabel("view.settings"),
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
        shortcut: shortcutLabel("view.marketplace"),
        action: () => openLibrary("marketplace"),
      });
    }
    nav.push({
      id: "command-new-chat",
      label: "New chat",
      detail: "Start a channel or direct message",
      shortcut: shortcutLabel("chat.new"),
      action: () => openNewChat(),
    });
    nav.push({
      id: "command-keyboard-shortcuts",
      label: "Keyboard shortcuts",
      detail: "Show every shortcut",
      shortcut: shortcutLabel("help.shortcuts"),
      action: () => {
        cheatSheetOpen = true;
      },
    });
    // Company scope moved out of ⌘0/⌘1–5 (those keys switch main views now);
    // the palette keeps scope switching one keystroke away.
    if (scopeCompanies.length > 0) {
      nav.push({
        id: "command-scope-all",
        label: "Show all companies",
        detail: "Conversations from every company",
        action: () => changeTenantCompany(null),
      });
      for (const company of scopeCompanies) {
        nav.push({
          id: `command-scope-${company.companyUid}`,
          label: `Show only ${company.label}`,
          detail: "Conversations from this company",
          keywords: company.companyUid,
          action: () => changeTenantCompany(company.companyUid),
        });
      }
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
  const selectedCompanySlug = $derived.by(() => {
    const uid = (selectedRow?.companyUid ?? "").trim();
    if (!uid) return "";
    return (
      (companies ?? []).find((c) => (c.cloudUid ?? "").trim() === uid)?.slug ??
      ""
    );
  });

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
    onfinished: () => {
      recordWelcomeSetupRun();
      // On disk too: the window's memory does not survive a reinstall.
      void adapter.settings.markWelcomeSetupComplete?.();
    },
  });
  $effect(() => () => setupAgent.dispose());
  /** In setup-bot mode #welcome is just its banner (resources + the setup
   *  button); the scripted fallback run still needs its transcript. */
  const welcomeIsBannerOnly = $derived(
    Boolean(selectedRow && isSetupChannel(selectedRow.channelId) && setupBotLauncher && !setupAgent.active),
  );
  /**
   * Where the "bringing your bots back" line lives: at the bottom of the
   * conversation when there is one, and in the shell's banner slot only when
   * there is not (the welcome hero, mid-wizard). Never in both.
   */
  const autoRestoreStatusInline = $derived(Boolean(selectedRow) && !welcomeIsBannerOnly);
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
  /** Bots created with a kickoff whose first turn has not been shown yet
   *  (uid → name). Once the intro is in the open DM, the row starts there. */
  let kickoffPendingByUid = $state<Record<string, string>>({});
  $effect(() => {
    const row = selectedRow;
    const uid = row?.kind === "dm" ? (row.personUid?.trim() ?? "") : "";
    if (!row || !uid || !kickoffPendingByUid[uid] || liveTimelineId !== row.id) return;
    const decision = kickoffThinkingState(liveTimeline, uid);
    if (decision.state === "waiting") return;
    const name = kickoffPendingByUid[uid]!;
    const { [uid]: _started, ...rest } = kickoffPendingByUid;
    kickoffPendingByUid = rest;
    if (decision.state === "start") {
      thinkingByRow = startThinkingIn(thinkingByRow, row.id, { agentUid: uid, agentName: row.title?.trim() || name }, Date.now(), {
        afterMs: decision.afterMs,
      });
    }
  });
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
    return () => {
      clearInterval(handle);
    };
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

  /** Same messages (by reference) in the same order — nothing to repaint. */
  function sameTimeline(
    a: ConversationMessageWire[],
    b: ConversationMessageWire[],
  ): boolean {
    if (a === b) return true;
    if (a.length !== b.length || a.length === 0) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }

  function commitTimeline(
    row: ConversationRow,
    next: ConversationMessageWire[],
  ): void {
    // The 8s safety poll re-merges an unchanged page; `mergeFetchedTimeline`
    // hands back the same array when nothing moved, so skip the assignment
    // (and the wake fan-out) instead of re-rendering an identical thread.
    if (liveTimelineId === row.id && sameTimeline(liveTimeline, next)) return;
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
    const cached = untrack(() => timelineCache.get(row.id) ?? []);
    const token = row.id;
    if (cached.length > 0) {
      // Paint the cached thread in THIS tick. The old code cleared the rows
      // and waited a frame, which put a guaranteed empty frame between the
      // two conversations: the pane blanked, then filled, then the list
      // settled against the bottom. Handing the mount its final rows means
      // the first painted frame of the new conversation is already complete
      // and already anchored, and nothing moves afterwards.
      //
      // The frame this used to spend was there to keep a 20-bubble remount
      // out of the click flush. Mounting the same rows one frame later cost
      // the same work and bought a flash, so the cost stays and the flash
      // goes; the cross-fade in `.conversation-layer` covers the swap.
      liveTimeline = cached;
      liveTimelineId = row.id;
      timelineHydrating = false;
      // `catchUpTimeline` reads the timeline state synchronously before its
      // first await. Called bare from an effect body those reads become
      // dependencies of THIS effect, and since it also writes the timeline the
      // effect re-arms itself forever. `untrack` keeps the read out of the
      // dependency set — the frame this used to sit behind hid the problem.
      untrack(() => {
        void catchUpTimeline(row);
      });
      return;
    }
    // Nothing cached: there is no content to hold, so the deferral is free.
    // Keep hydrating=true so "No messages yet" does not flash (US-018) — the
    // conversation shows its bottom-anchored placeholder rows instead.
    liveTimeline = [];
    liveTimelineId = row.id;
    timelineHydrating = true;
    const frame = requestAnimationFrame(() => {
      if (selectedRow?.id !== token) return;
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
  /**
   * The person sent something to a bot that cannot run on this Mac and
   * nothing has come back. The conversation says that plainly — the message
   * must not sit under a spinner that will never end.
   */
  const botMessageUnanswered = $derived.by(() => {
    const uid = selectedRow?.kind === "dm" ? (selectedRow.personUid ?? "").trim() : "";
    if (!uid || !selectedBotCannotRun) return false;
    const selfUid = self?.uid?.trim() ?? "";
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const from = (timeline[i]?.fromPersonUid ?? "").trim();
      if (from && from === uid) return false;
      if (from && from === selfUid) return true;
    }
    return false;
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
    let rows = merged;
    if (selectedRow && isSetupChannel(selectedRow.channelId)) {
      const welcome = withoutCompaniesSummaryCards(
        withoutSeededCreateCompanyCards(merged, {
          hasCompany: hasRosterCompany,
          createRequested: createCompanyRequested,
          rosterLoading: setupRosterLoading(companies, rosterStatus),
        }),
      );
      rows =
        setupAgentWires.length > 0 ? [...welcome, ...setupAgentWires] : welcome;
    }
    return coalesceWorkSessionWires(rows);
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
  let avatarMemo: {
    rosterKeys: string;
    rosters: unknown[];
    contacts: unknown;
    selfUid: unknown;
    selfAvatarUrl: unknown;
    overrides: unknown;
    value: Record<string, string>;
  } | null = null;
  const avatarByUid = $derived.by((): Record<string, string> => {
    // Memoised on input identity: a roster load replaces one channel's array,
    // and every other input is compared by reference, so the map keeps its
    // identity (and downstream props stay stable) when nothing changed.
    const rosterKeys = Object.keys(channelRosterById);
    const rosters = rosterKeys.map((key) => channelRosterById[key]);
    const rosterFingerprint = rosterKeys.join("\u0000");
    const selfUid = self?.uid;
    const memo = avatarMemo;
    if (
      memo &&
      memo.rosterKeys === rosterFingerprint &&
      memo.contacts === contactAvatarByUid &&
      memo.selfUid === selfUid &&
      memo.selfAvatarUrl === selfAvatarUrl &&
      memo.overrides === avatarOverridesByUid &&
      memo.rosters.length === rosters.length &&
      memo.rosters.every((roster, i) => roster === rosters[i])
    ) {
      return memo.value;
    }
    const value = composeAvatarByUid({
      rosters: rosters.flat(),
      contacts: contactAvatarByUid,
      selfUid,
      selfAvatarUrl,
      overrides: avatarOverridesByUid,
    });
    avatarMemo = {
      rosterKeys: rosterFingerprint,
      rosters,
      contacts: contactAvatarByUid,
      selfUid,
      selfAvatarUrl,
      overrides: avatarOverridesByUid,
      value,
    };
    return value;
  });

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

  // Built once: only closes over the platform adapter, which is fixed for
  // the life of the shell (the host remounts on adapter change).
  // svelte-ignore state_referenced_locally
  const conversationApi: ConversationApi = {
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
  };

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
  /** A cloud bot needs the team action to open its sequence and a card read-back. */
  const canCreateCloudBots = $derived(
    canRunEntryPoints && typeof adapter.messaging.runCompanyTabAction === "function",
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
   * Whether this machine is still owed the welcome channel's guided setup,
   * from the host's setup status. A person who set HQ up before the welcome
   * flow existed (Caio: "I previously ran setup, but it showed me this") is
   * not: boot goes to their channels and #welcome shows the finished state.
   * Unknown until the host answers; unknown means owed, as before.
   */
  let welcomeSetupOwed = $state<boolean | null>(null);
  /** The boot pick never waits longer than this for the host's answer. */
  const WELCOME_OWED_TIMEOUT_MS = 2000;
  onMount(() => {
    let settled = false;
    const resolve = (owed: boolean): void => {
      if (settled) return;
      settled = true;
      welcomeSetupOwed = owed;
      if (owed) return;
      welcomeSetupRun = true;
      setupAgent.markAlreadySetUp();
    };
    const timer = window.setTimeout(() => resolve(true), WELCOME_OWED_TIMEOUT_MS);
    void (async () => {
      try {
        const res = await adapter.settings.getSetupStatus();
        const owed = res.ok ? (res.value as { welcomeSetupOwed?: unknown } | null)?.welcomeSetupOwed : undefined;
        // Only an explicit "not owed" skips the welcome; anything else keeps today's behaviour.
        resolve(owed !== false);
      } catch {
        resolve(true);
      }
    })();
    return () => clearTimeout(timer);
  });
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

  /**
   * New bot → Cloud. Creating a company-hosted bot exists on the server only
   * as the Team tab's `add_agent` action plus the `create_agent` card's own
   * turns, so this runs exactly those — headlessly, under the name and handle
   * the New bot flow just collected. The card is never rendered (it is a
   * retired timeline kind) and never focused: the person stays in the New bot
   * flow and lands in the new bot's channel when it is made.
   *
   * The job title is not part of that sequence — no turn has a field for it —
   * so it takes the same route it takes for a Local bot: a PATCH onto the
   * agent profile once the bot has a uid. A retried create carries the draft
   * again, title included, because the flow still holds it.
   */
  async function createCloudBotEntry(
    companyUid: string,
    draft: { name: string; handle: string; title?: string },
  ): Promise<EntryPointResult> {
    const result = await runCreateCloudBotEntry(conversationApi, companyUid, draft);
    if (result.ok) {
      const title = draft.title?.trim() ?? "";
      const agentUid = result.target.agentUid?.trim() ?? "";
      if (title && agentUid) {
        void saveNewBotProfile(agentUid, { title });
      } else if (title) {
        // The bot exists; only its subtitle is missing, and nothing here
        // names the profile to write it to.
        console.warn("[hq-desktop] cloud bot title not saved: the create sequence returned no agent uid");
      }
      navigateToEntryTarget(result.target, companyUid);
    }
    return result;
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
    // US-018: Office is a live native surface, not server-returned rows. It
    // has no company-tab endpoint, so never ask for one.
    if (tabId === "office") {
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

  // An agent's own "still working" status in a channel keeps its row up in the
  // main pane until it posts after the status. Thread-scoped statuses belong
  // to that thread's panel (ReplyPanel), whose replies are what end them.
  $effect(() => {
    if (!wakes) return;
    return wakes.on("agent:status", (wake) => {
      if (wake.threadRoot) return;
      const rowId = `ch:${wake.channelId}`;
      const open = liveTimelineId === rowId ? liveTimeline : [];
      const roster = channelRosterById[wake.channelId] ?? [];
      const rosterName = roster.find((m) => m.personUid === wake.agentUid)?.displayName;
      const name = agentDisplayName(wake.agentUid, open, {
        liveNames: displayNameByUid,
        fallback: rosterName,
      });
      const next = applyAgentStatus(thinkingByRow[rowId] ?? [], wake, name, open, Date.now());
      if (next.length > 0) thinkingByRow = { ...thinkingByRow, [rowId]: next };
    });
  });

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
        view = "conversation";
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
      case "dm-requests":
        dmRequestsFocusPairKey = next.pairKey ?? null;
        view = "dm-requests";
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
          companyTab = next.companyTab === "office" ? "office" : "chat";
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

  /** The sidebar's "Connection requests" row (and any host deep link). */
  function openDmRequests(pairKey?: string | null): void {
    void navigate({ kind: "dm-requests", pairKey: pairKey?.trim() || null });
  }

  /**
   * A request was answered. The panel already pruned it and emitted
   * `dm:request-update`; refresh the rail (accept promotes a new contact) and,
   * on accept, open the conversation with the requester through the same
   * pending-conversation path a deep link uses.
   */
  function handleDmRequestResolved(
    request: DmRequest,
    action: RequestAction,
  ): void {
    rosterWakeSeq += 1;
    if (action !== "accept") return;
    const personUid = request.fromPersonUid?.trim() ?? "";
    if (!personUid) return;
    const target: ConversationTarget = {
      personUid,
      email: request.fromEmail ?? "",
      displayName: request.fromDisplayName ?? "",
      replyRootEventId: null,
    };
    const known = conversationRowForDeepLink(
      { channelId: null, personUid, replyRootEventId: null },
      [...searchRows, ...railRows],
    );
    // The rail may not list the new contact yet; fall back to the messages
    // home rather than leaving the (now empty) request in view.
    if (known) applyPendingConversation(target);
    else void navigate({ kind: "messages" });
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

  /** Everyone already IN the open channel. A teammate's personal bot is not on
   * the company contacts roster (it has no membership), so without this a
   * channel member could never @mention it — the picker said "No one matches"
   * while the bot sat on the roster. */
  const openChannelMentionTargets = $derived(
    mentionTargetsFromContacts(
      (selectedRow?.channelId
        ? (channelRosterById[selectedRow.channelId.trim()] ?? [])
        : []
      ).map((member) => ({
        personUid: member.personUid,
        displayName: member.displayName,
      })),
    ),
  );

  /** The user's own local bots: never on the contacts roster, but @mentionable
   * anywhere the user can add them. */
  const localBotMentionTargets = $derived(
    mentionTargetsFromContacts(
      localBots.map((bot) => ({ personUid: bot.agentUid, displayName: bot.name })),
    ),
  );

  /**
   * The display-name map spans every company and DM peer the app has seen, so
   * it offers people who are not in the open channel's company. That is now
   * correct: the server adds such a person to THAT ONE CHANNEL as a guest and
   * delivers the mention, so filtering these rows out (which this did while the
   * server still answered 403 MENTION_PARTICIPANT_NOT_VISIBLE) would hide
   * people the user can legitimately tag.
   *
   * What these rows must not do is render as a SECOND, identical-looking entry
   * for the same human — two bare "Jacob Posel" rows, one of them a different
   * person entirely. A map row carries a name and nothing else, so a colliding
   * row is labelled "outside <company>" immediately and relabelled with the
   * person's email as soon as the connections roster answers
   * (see mentionEmailByUid). A person is never shown a uid fragment.
   */
  const identityMentionTargets = $derived(
    mentionTargetsFromContacts(
      Object.entries(identities ?? {}).map(([personUid, displayName]) => ({
        personUid,
        displayName,
      })),
    ),
  );

  /**
   * The company a row is "outside" of, from the user's point of view: the open
   * channel's workspace, else the selected one.
   */
  const mentionOutsideLabel = $derived(
    outsideCompanyLabel(
      companyDisplayName(mentionRosterCompanyUid, companyNames),
    ),
  );

  /**
   * Emails resolved from the connections roster for people the app knows only
   * from the app-wide display-name map (uid + name). A person must never be
   * labelled with a uid fragment, so when two such rows collide the email is
   * what finally tells them apart.
   */
  let mentionEmailByUid = $state<Record<string, string>>({});
  // Plain, non-reactive: uids already asked about. Writing it inside the
  // lookup effect must not re-trigger that effect.
  const mentionEmailAsked = new Set<string>();

  /** Rows merged and company-labelled, before disambiguation. */
  const mentionRosterRows = $derived(
    applyResolvedMentionEmails(
      mergeMentionRosters(
        mentionCandidates,
        liveMentionTargets,
        identityMentionTargets,
        openChannelMentionTargets,
        localBotMentionTargets,
      ).map((target) => {
        if (!target.companyUid || target.companyName) return target;
        const name = companyDisplayName(target.companyUid, companyNames);
        return name ? { ...target, companyName: name } : target;
      }),
      mentionEmailByUid,
    ),
  );

  /**
   * Resolve the email for a duplicate-name person we know only by uid, using
   * the same connections roster the DM recipient picker reads. Unscoped on
   * purpose: the whole point is that this person is outside the open channel's
   * company, so the tenant-scoped roster cannot answer. Each uid is asked about
   * once; a failure leaves the row reading "outside <company>" and is logged,
   * never swallowed.
   */
  $effect(() => {
    const wanted = mentionUidsNeedingEmail(mentionRosterRows).filter(
      (uid) => !mentionEmailAsked.has(uid),
    );
    if (wanted.length === 0) return;
    for (const uid of wanted) mentionEmailAsked.add(uid);
    let cancelled = false;
    void (async () => {
      try {
        const res = await adapter.messaging.listContacts();
        if (cancelled) return;
        if (!res.ok) {
          console.warn(
            "[hq-desktop] could not resolve mention emails from the connections roster:",
            res.code ?? res.reason,
            res.message ?? "",
          );
          return;
        }
        const found: Record<string, string> = {};
        for (const row of mentionTargetsFromContactsPayload(res.value)) {
          const email = row.email?.trim();
          if (email && wanted.includes(row.participantUid))
            found[row.participantUid] = email;
        }
        if (Object.keys(found).length === 0) return;
        mentionEmailByUid = { ...mentionEmailByUid, ...found };
      } catch (err) {
        if (cancelled) return;
        console.warn(
          "[hq-desktop] mention email lookup failed; duplicate names stay labelled by company:",
          err,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  const mentionRoster = $derived(
    // Re-run disambiguation after company labels and resolved emails are in,
    // so two survivors sharing a display name render "Jacob Posel (Indigo)" vs
    // "Jacob Posel (jacob@…)" — or "(outside Indigo)" until the email lands —
    // instead of two identical, unpickable rows.
    disambiguateMentionTargets(mentionRosterRows, {
      outsideLabel: mentionOutsideLabel,
    }),
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
   * An inbound DM wake carries ids only. When that pair's conversation is the
   * OPEN one, fetch its new page and commit it — otherwise the reply sat
   * unseen until some other catch-up ran (a healthy mesh only arms the
   * timeline safety ticker when `shouldArmDirectorySafety` says it is
   * degraded), while the wake had already torn down the agent's thinking row.
   * The owner saw a bot's answer announced by a notification and then vanish.
   */
  async function applyDmWake(wake: {
    fromPersonUid: string;
    eventId?: string;
    createdAt?: string;
    direction?: "in" | "out";
  }): Promise<void> {
    if (wake.direction === "out") return;
    const from = (wake.fromPersonUid ?? "").trim();
    if (!from) return;
    const row = selectedRow;
    const peer = (row?.personUid ?? "").trim();
    const isOpen =
      !!row && row.kind === "dm" && (peer === from || row.id === `dm:${from}`);
    // An inbound agent DM ends that agent's thinking row even when its
    // conversation is not open (the open one clears from its page below, so
    // its indicator never disappears before the reply is on screen).
    if (!isOpen) {
      if (isAgentUid(from)) {
        clearThinkingFromIncoming(
          [{ fromPersonUid: from, createdAt: wake.createdAt ?? null }],
          `dm:${from}`,
        );
      }
      return;
    }
    // In-place lifecycle-card updates reuse the same eventId, so an
    // already-seen id re-reads without `since`; a genuinely new event that is
    // no newer than what is already rendered is already on screen, and the
    // wake alone may end the row.
    const already = timelineHasEvent(liveTimeline, wake.eventId);
    if (!already) {
      const wakeAt = (wake.createdAt ?? "").trim();
      if (
        wakeAt &&
        liveTimeline.some((message) => (message.createdAt ?? "") >= wakeAt)
      ) {
        if (isAgentUid(from)) {
          clearThinkingFromIncoming(
            [{ fromPersonUid: from, createdAt: wake.createdAt ?? null }],
            row.id,
          );
        }
        return;
      }
    }
    let res: Awaited<ReturnType<typeof adapter.messaging.fetchDmThread>>;
    try {
      res = await adapter.messaging.fetchDmThread({
        withPersonUid: peer || from,
        limit: 20,
        ...(already
          ? {}
          : { since: sinceForChannelWake(liveTimeline, wake.createdAt) }),
      });
    } catch {
      // Never clear on a failed fetch — a later catch-up ends the row once it
      // can actually show the reply.
      return;
    }
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
        void applyDmWake(wake);
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
    return startJitteredPoll({ intervalMs: TIMELINE_SAFETY_INTERVAL_MS, tick });
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
        // A bot that cannot run here will not think about this message, so
        // no indicator is started for it; the conversation says it is
        // unanswered instead — unless the app can bring the bot back, in
        // which case writing to it is what starts that, right now, instead of
        // at the next 120 s listing. THE DEAD-DM MOMENT MUST BE IMPOSSIBLE
        // WHILE AUTO-RESTORE IS POSSIBLE.
        if (isAgentUid(row.personUid) && unrunnableBotUids[row.personUid.trim()]) {
          autoRestoreForSend(row.personUid);
        }
        if (isAgentUid(row.personUid) && !unrunnableBotUids[row.personUid.trim()]) {
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
    // Settings subsections each push a history entry, so a plain history
    // back would walk Profile → Appearance → … one tab at a time. The Back
    // button means "close Settings": return to whatever the user was looking
    // at before Settings opened, or Messages when Settings was the first stop.
    const { entries, index } = navigationHistory.snapshot();
    for (let i = index - 1; i >= 0; i -= 1) {
      const destination = entries[i]?.destination;
      if (destination && destination.kind !== "settings") {
        void navigate(destination);
        return;
      }
    }
    void navigate({ kind: "messages" });
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

  // `g a` used to flip a standalone Atlas view. Main moved Atlas into a chat
  // tab, so the chord hands the destination to the navigation controller and
  // the history/back-forward stack stays correct.
  const goChord = createGoChord((letter: string) => {
    if (letter !== "a") return false;
    meetingFocusRequest = null;
    void navigate({ kind: "atlas" });
    return true;
  });

  /** Run a sidebar entry point, mounting the rail first if it is collapsed. */
  function withSidebar(fn: (actions: ChatSidebarActions) => void): void {
    if (sidebarActions) {
      fn(sidebarActions);
      return;
    }
    sidebarCollapsed = false;
    void svelteTick().then(() => {
      if (sidebarActions) fn(sidebarActions);
    });
  }

  function openNewChat(): void {
    paletteOpen = false;
    cheatSheetOpen = false;
    withSidebar((actions) => actions.openCreate());
  }

  function stepSelectedConversation(delta: 1 | -1): void {
    const next = stepConversation(displayRows, selectedRow?.id, delta);
    if (!next) return;
    cheatSheetOpen = false;
    handleSelect(next);
  }

  /**
   * App-wide bindings. Ids double as the native View-menu payload ids
   * (`shortcut:invoke` → `runShortcut(id)`), so keep them stable.
   */
  // svelte-ignore state_referenced_locally
  const shellShortcuts: ShortcutBinding[] = [
    {
      id: "palette.toggle",
      keys: "Mod+K",
      label: "Command palette",
      group: "General",
      run: () => {
        cheatSheetOpen = false;
        paletteOpen = !paletteOpen;
        goChord.reset();
      },
    },
    {
      id: "view.settings",
      keys: "Mod+,",
      label: "Settings",
      group: "General",
      run: () => openSettings(),
    },
    {
      id: "help.shortcuts",
      keys: "Mod+/",
      label: "Keyboard shortcuts",
      group: "General",
      // The composer holds focus for most of a session; the cheat sheet is
      // exactly what someone reaches for while typing, so it must not be
      // gated behind blurring the input first.
      allowInInput: true,
      run: () => {
        paletteOpen = false;
        cheatSheetOpen = !cheatSheetOpen;
      },
    },
    {
      id: "help.close",
      keys: "Escape",
      label: "Close this sheet",
      group: "General",
      allowInInput: true,
      // Escape belongs to whichever overlay is open; only claim it for the
      // cheat sheet, otherwise decline so other components keep it.
      run: () => {
        if (!cheatSheetOpen) return false;
        cheatSheetOpen = false;
        return true;
      },
    },
    {
      id: "view.notifications",
      keys: "Mod+1",
      label: "Notifications",
      group: "Views",
      run: () => {
        meetingFocusRequest = null;
        void navigate({ kind: "notifications" });
      },
    },
    {
      id: "view.meetings",
      keys: "Mod+2",
      label: "Meetings",
      group: "Views",
      run: () => {
        meetingFocusRequest = null;
        void navigate({ kind: "meetings" });
      },
    },
    ...(adapter.kind !== "web"
      ? [
          {
            id: "view.marketplace",
            keys: "Mod+3",
            label: "Marketplace",
            group: "Views",
            run: () => openLibrary("marketplace"),
          } satisfies ShortcutBinding,
        ]
      : []),
    {
      id: "view.library",
      keys: "Mod+4",
      label: "Library",
      group: "Views",
      run: () => openLibrary("skills"),
    },
    {
      id: "conversation.next",
      keys: "Mod+Shift+]",
      label: "Next conversation",
      group: "Conversations",
      run: () => stepSelectedConversation(1),
    },
    {
      id: "conversation.previous",
      keys: "Mod+Shift+[",
      label: "Previous conversation",
      group: "Conversations",
      run: () => stepSelectedConversation(-1),
    },
    {
      id: "chat.new",
      keys: "Mod+N",
      label: "New chat",
      group: "Conversations",
      run: () => openNewChat(),
    },
    {
      id: "search.messages",
      keys: "Mod+F",
      label: "Search messages",
      group: "Conversations",
      run: () => {
        paletteOpen = false;
        cheatSheetOpen = false;
        withSidebar((actions) => actions.openHistory());
      },
    },
    {
      id: "search.conversations",
      keys: "Mod+Shift+F",
      label: "Jump to conversation",
      group: "Conversations",
      run: () => {
        paletteOpen = false;
        cheatSheetOpen = false;
        withSidebar((actions) => actions.openSearch());
      },
    },
  ];

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
    // Re-apply on boot, not just on toggle: the attribute lives on <html> and
    // does not survive a reload, so without this the glass returns on every
    // restart and the setting looks like it silently forgot itself.
    const prefs = readSettingsPrefs(tenantStorage);
    applyUiSize(prefs.uiSize);
    // With the desktop appearance host installed, its persisted preference is
    // already live; re-applying the local pref would round-trip a stale copy
    // through the host and clobber the user's theme. Same guard as
    // PrototypeSettingsPanes' onMount.
    if (!hasAppearanceHost()) applyWindowOpacity(prefs.windowOpacity);
    const overlayQuery = window.matchMedia(
      `(max-width: ${REPLY_OVERLAY_MAX_PX}px)`,
    );
    const syncOverlay = () => {
      narrowViewport = overlayQuery.matches;
    };
    syncOverlay();
    overlayQuery.addEventListener("change", syncOverlay);

    let stopSyncPoll: (() => void) | undefined;
    let stopHealthPoll: (() => void) | undefined;
    if (adapter.isAvailable("canSync")) {
      void readLiveSyncStatus(adapter).then((next) => {
        liveSync = next;
      });
      stopSyncPoll = startJitteredPoll({
        intervalMs: 30_000,
        tick: () =>
          readLiveSyncStatus(adapter).then((next) => {
            liveSync = next;
          }),
      });
      // Workspace health hits the cloud, so it runs on a slower beat than the
      // local journal read above.
      void readWorkspaceHealth();
      stopHealthPoll = startJitteredPoll({
        intervalMs: 120_000,
        tick: () => readWorkspaceHealth(),
      });
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

    // Modifier shortcuts live in the shared registry (one capture-phase
    // listener; also the target of native View-menu `shortcut:invoke`).
    const unregisterShortcuts = registerShortcuts(shellShortcuts);

    function onKey(event: KeyboardEvent) {
      // Back/forward stay OUTSIDE the registry on purpose. The registry keys
      // off a declared chord string; `consumeNavigationShortcut` owns a set of
      // bindings that includes non-chord inputs, and re-declaring a subset of
      // them here would silently drop the rest. It self-identifies its own
      // events, so it runs first and returns when it has claimed one — before
      // the modifier guard below, which would otherwise swallow them.
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
        return;
      }

      // US-016: `g a` opens Atlas (Slack-style go chord). Unmodified chords
      // are not a registry concern, so they keep a bubble-phase listener.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (paletteOpen || cheatSheetOpen) return;
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
    function onOpenDmRequests(event: Event): void {
      const detail = (event as CustomEvent<{ pairKey?: string | null }>).detail;
      // Consume the stash so a later mount does not replay this open.
      takePendingDmRequests();
      openDmRequests(detail?.pairKey ?? null);
    }
    function onEmbeddedNavigation(event: Event): void {
      const target = (event as CustomEvent<EmbeddedNavigationTarget>).detail;
      if (!target || typeof target !== "object" || !("kind" in target)) return;
      applyEmbeddedNavigation(target);
    }
    window.addEventListener(OPEN_CHANNEL_EVENT, onOpenChannel);
    window.addEventListener(MESSAGE_PERSON_EVENT, onMessagePerson);
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpenSettingsEvent);
    window.addEventListener(OPEN_DM_REQUESTS_EVENT, onOpenDmRequests);
    window.addEventListener(EMBEDDED_NAVIGATION_EVENT, onEmbeddedNavigation);

    applyConversationDeepLink(conversationDeepLinkFromLocation());
    const pendingChannel = takePendingChannelOpen();
    if (pendingChannel) applyPendingChannelOpen(pendingChannel);
    const pendingDm = takePendingConversation();
    if (pendingDm) applyPendingConversation(pendingDm);
    const pendingRequests = takePendingDmRequests();
    if (pendingRequests) openDmRequests(pendingRequests.pairKey);
    const detachEmbeddedNavigation = onembeddednavigationready?.();

    return () => {
      detachEmbeddedNavigation?.();
      if (focusCardTimer !== undefined) clearTimeout(focusCardTimer);
      overlayQuery.removeEventListener("change", syncOverlay);
      stopSyncPoll?.();
      stopHealthPoll?.();
      window.removeEventListener("keydown", onKey);
      unregisterShortcuts();
      window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenSettingsEvent);
      window.removeEventListener(OPEN_DM_REQUESTS_EVENT, onOpenDmRequests);
      window.removeEventListener(OPEN_CHANNEL_EVENT, onOpenChannel);
      window.removeEventListener(MESSAGE_PERSON_EVENT, onMessagePerson);
      window.removeEventListener(EMBEDDED_NAVIGATION_EVENT, onEmbeddedNavigation);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- `data-shell-focus-fallback` + tabindex="-1": stable focus destination for
     modals whose trigger unmounted while the modal was open (policy
     indigo-app-wide-modal-focus-return-survives-trigger-unmount). -->
<div
  class="desktop-shell chat-shell"
  class:has-window-controls={hasWindowControls}
  data-testid="desktop-shell"
  data-shell-focus-fallback
  tabindex="-1"
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
    conflicts={conflictFiles}
    onresolveconflict={(path, strategy) => resolveConflictFile(path, strategy)}
    onopenconflict={(path) => openConflictInEditor(path)}
    onresolveconflicts={openConflictResolution}
    {manifestError}
    {cloudReachable}
    {cloudError}
    workspaces={syncWorkspaces}
    hqFolderPath={hqFolderPath ?? liveSync.hqFolderPath}
    watchedCount={watched}
    {unreadCount}
    {syncStatus}
    brand={brandState}
    {brandCompanyName}
    onopenSync={() => openSettings("sync")}
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

  {#if autoRestoreStatus && !autoRestoreStatusInline}
    <!-- Bots are coming back and there is no conversation pane to say so in
         (the welcome hero, mid-wizard): one calm line in the shell's banner
         slot instead, so the work is never silent. -->
    <div class="bot-auto-restore-banner" data-testid="bot-auto-restore-status" role="status">
      {autoRestoreStatus}
    </div>
  {/if}

  {#if showBotRestorePrompt || botRestoreResult}
    <!-- Bots come back after a reinstall: one non-blocking prompt, in the
         shell's existing banner slot so it reaches the person wherever they
         landed. Dismissal is remembered per machine; Settings › Bots offers
         it again. -->
    <BotRestoreBanner
      count={botsMissingHere.length}
      liveElsewhere={botsLiveElsewhere.length}
      busy={botRestoreBusy}
      result={botRestoreResult}
      error={botRestoreError}
      onrestore={() => void restoreMyBots()}
      ondismiss={() => {
        botRestoreResult = null;
        dismissBotRestorePrompt();
      }}
    />
  {/if}

  {#if authErrorMessage}
    <SessionExpiredBanner
      message={authErrorMessage}
      signingIn={authSignInPending}
      onsignin={onsignin ? () => void startReauth() : undefined}
      ondismiss={() => (authErrorMessage = null)}
    />
  {/if}

  {#if notificationRecovery}
    <!-- The compact native retry banner could not be created, so the action is
         recovered here instead of dying in the console. -->
    <div class="notification-recovery-banner">
      <NotificationActionRecovery
        message={notificationRecovery.message}
        pending={notificationRetrying}
        onretry={retryNotificationAction}
      />
    </div>
  {/if}

  {#if adapter.isAvailable("canSync") && membershipsToPull.length > 0}
    <MembershipSyncBanner
      memberships={membershipsToPull}
      syncing={membershipSyncPending}
      error={membershipSyncError}
      onsync={() => void syncMembership()}
      ondismiss={dismissMembershipPrompt}
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
          {engagedAgentUids}
          {tenantCompanyId}
          {seedDirectory}
          {avatarByUid}
          {rosterWakeSeq}
          requestsWakeSeq={notificationWakeSeq}
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
          oncreateagent={canCreateCloudBots ? createCloudBotEntry : null}
          oncreatebot={adapter.bots ? createBotEntry : null}
          botRuntimeReady={localBotRuntimeReady}
          botWorkers={localBotWorkers}
          {existingBotNames}
          {botSignIn}
          onbotsignedin={onBotRuntimeSignedIn}
          loadAvatarPacks={adapter.identity ? loadAvatarPacks : null}
          {localBots}
          {ownedLocalBotUids}
          onrows={(rows) => {
            railRows = rows;
            directorySettled = true;
          }}
          ondisplayrows={(rows) => (displayRows = rows)}
          onactions={(actions) => (sidebarActions = actions)}
          {bootTimeoutMs}
          welcomeFirst={welcomeSetupRun || hasBootDeepLink || initialRow ? false : welcomeSetupOwed === null ? "pending" : welcomeSetupOwed}
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
        {:else if view === "dm-requests"}
          <DmRequestsPanel
            api={sidebarApi}
            {wakes}
            focusPairKey={dmRequestsFocusPairKey}
            onback={() => {
              void leaveCurrentDestination();
            }}
            onresolved={handleDmRequestResolved}
          />
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
        {:else if view === "conversation" && selectedRow}
          <header
            class="channel-header chat-shell"
            data-testid="channel-header"
            data-reply-open={openReplyRootId ||
            openProfileMember ||
            openAgentMember
              ? "true"
              : "false"}
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
                        kind={botKindFor(selectedRow.personUid, localBots, ownedLocalBotUids) ?? "cloud"}
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
                <CompanyTabs
                  slug={selectedCompanySlug}
                  {onopenurl}
                  active={companyTab}
                  tabs={companyTabsForHost}
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

          <!-- One selected-company listener survives view/tab changes. Office UI is only visible on its tab. -->
          {#if selectedRow.companyUid}
            <div class="company-office-stage" class:office-background={!(isCompanyChannel && companyTab === "office")} data-testid="company-tab-panel-office">
              <OfficePanel {adapter} {callsHost}
                companyUid={selectedRow.companyUid}
                companyLabel={selectedRow.title ?? "This company"}
                displayName={(uid) => displayNameByUid[uid] || identities?.[uid] || uid}
                visible={isCompanyChannel && companyTab === "office"}
              />
            </div>
          {/if}

          {#if isAgentChannel && agentSurface === "details" && agentChannelLocalBot}
            <LocalBotDetailPanel
              companies={(companies ?? []).filter(c => c.cloudUid?.startsWith("cmp_")).map(c => ({ uid: c.cloudUid!, name: c.displayName || c.slug, slug: c.slug }))}
              {onopenurl}
              bot={agentChannelLocalBot}
              avatarUrl={avatarByUid[agentChannelLocalBot.agentUid] ?? null}
              {adapter}
              onchanged={refreshLocalBots}
              onstart={startBotFromProfile}
              onclose={() => void leaveCurrentDestination()}
            />
          {:else if isAgentChannel && agentSurface === "details" && agentChannelUid}
            <AgentDetailPanel
              agentUid={agentChannelUid}
              {localBots}
              {ownedLocalBotUids}
              displayName={headerTitle}
              avatarUrl={avatarByUid[agentChannelUid] ?? null}
              companyUid={promotedBotCompany(localBotRecords, agentChannelUid) ?? selectedRow?.companyUid}
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
          {:else if isCompanyChannel && companyTab === "office"}
            {#if companyTab === "office"}
              <!--
                US-018: OfficePanel is mounted above and shown via visible=.
              -->
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
                          staleTools={setupStaleTools(stopFailure)}
                          onsignedin={(tool) => afterRuntimeSignedIn(tool)}
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
                  {#if selectedLocalBot && selectedLocalBotNeedsSignIn && adapter.sessions?.loginStart}
                    <BotSignInBanner
                      bot={selectedLocalBot}
                      sessions={adapter.sessions}
                      bots={adapter.bots ?? null}
                      gate={{
                        canStart: (bot) => canStartBot(botStartGate, bot.name),
                        onstarted: (bot) => noteBotStarted(bot.name, bot.agentUid),
                      }}
                      ondone={refreshLocalBots}
                    />
                  {/if}
                  <AgentThinkingRow entries={setupThinking ? [...agentThinking, setupThinking] : agentThinking} />
                  {#if botMessageUnanswered}
                    {#if selectedBotAutoRestoring}
                      <!-- Writing to a bot that is not running here is what
                           STARTS it now. The message is not lost meanwhile:
                           it waits, unread, in the bot's own durable inbox
                           until the bot reads it. -->
                      <div class="bot-unanswered" data-testid="bot-message-starting" role="status">
                        {AUTO_RESTORE_STARTING_THIS_BOT}
                      </div>
                    {:else}
                      <!-- The app has stopped trying by itself, so this is the
                           honest state — and it is never a dead end: the one
                           action that helps is in the same line. -->
                      <div class="bot-unanswered" data-testid="bot-message-unanswered" role="status">
                        <span>{BOT_MESSAGE_NOT_ANSWERED}</span>
                        {#if selectedBotNotHere && adapter.bots?.adopt && !botRestoreUnavailable}
                          <button
                            type="button"
                            class="bot-unanswered-action"
                            data-testid="bot-message-start-here"
                            disabled={botAdoptBusy !== null}
                            onclick={() => void startSelectedBotHere()}
                          >
                            {botAdoptBusy === selectedBotNotHere.name
                              ? BOT_START_HERE_BUSY
                              : BOT_MESSAGE_START_HERE}
                          </button>
                        {:else}
                          <!-- Nothing on this Mac can run it, so "start it
                               here" would be a promise the app cannot keep.
                               Looking again is the one thing that can still
                               change, and it stays in the same line. -->
                          <button
                            type="button"
                            class="bot-unanswered-action"
                            data-testid="bot-message-recheck"
                            disabled={botRecheckBusy}
                            onclick={() => void recheckSelectedBot()}
                          >
                            {botRecheckBusy ? "Checking…" : BOT_NOT_RUNNABLE_RECHECK}
                          </button>
                        {/if}
                      </div>
                    {/if}
                  {/if}
                  <AgentTaskStrip tasks={mainPaneTasks} />
                  {#if autoRestoreStatus && !selectedBotAutoRestoring}
                    <!-- The one visible, calm line while bots come back. -->
                    <div class="bot-auto-restore" data-testid="bot-auto-restore-status" role="status">
                      {autoRestoreStatus}
                    </div>
                  {/if}
                  {#if botNoticeBelow}{@render localBotNotice()}{/if}
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
                    setupBot={setupBotLauncher}
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
                      phase={selectedBotProgress.state}
                      reason={selectedBotProgress.reason}
                      retrying={selectedBotProgress.retrying}
                      canRetry={canStartBot(botStartGate, selectedBotProgress.name)}
                      onretry={() => void retryBotProgress(uid)}
                    />
                  {/if}
                {/snippet}
                {#snippet localBotNotice()}
                  {#if selectedBotCannotRun}
                    <!-- Adopted, but there is no runtime for it here. One
                         honest sentence and the one action the desktop can
                         actually perform: look again. -->
                    <div class="local-bot-notice" data-testid="bot-not-runnable-notice" role="status">
                      <span class="local-bot-notice-text">{selectedBotCannotRun}</span>
                      {#if selectedBotNotHere && adapter.bots?.adopt && !botRestoreUnavailable}
                        <!-- The account owns this bot, so there IS something
                             the desktop can do: bring it back here. Its name,
                             memory and this conversation come with it. -->
                        <button
                          type="button"
                          class="local-bot-notice-start"
                          data-testid="bot-start-here"
                          disabled={botAdoptBusy !== null}
                          onclick={() => void startSelectedBotHere()}
                        >
                          {botAdoptBusy === selectedBotNotHere.name
                            ? BOT_START_HERE_BUSY
                            : botAdoptError
                              ? BOT_START_HERE_RETRY
                              : BOT_START_HERE}
                        </button>
                        <span class="local-bot-notice-hint">{BOT_START_HERE_EXPLAINER}</span>
                      {:else if remoteListingNotice}
                        <!-- Bringing a bot back goes through HQ Cloud, and the
                             app could not read it. Rather than a button that
                             cannot work (or silence, which is what the owner's
                             VM got), one plain sentence says why — and "Check
                             again" below still re-reads this Mac's own bots,
                             which is the half that can change without HQ. -->
                        <span class="local-bot-notice-hint" data-testid="bot-restore-unavailable">
                          {remoteListingNotice}
                        </span>
                      {/if}
                      <button
                        type="button"
                        class="local-bot-notice-start"
                        data-testid="bot-not-runnable-recheck"
                        disabled={botRecheckBusy}
                        onclick={() => void recheckSelectedBot()}
                      >
                        {botRecheckBusy ? "Checking…" : BOT_NOT_RUNNABLE_RECHECK}
                      </button>
                      {#if botAdoptError}
                        <span class="local-bot-notice-error" role="alert" data-testid="bot-start-here-error">
                          {botAdoptError}
                        </span>
                      {/if}
                    </div>
                  {:else if selectedLocalBot && selectedLocalBotOffline}
                    <div class="local-bot-notice" data-testid="local-bot-offline-notice" role="status">
                      <span class="local-bot-notice-text">{localBotOfflineNotice(selectedLocalBot)}</span>
                      {#if !selectedLocalBot.processAlive && !selectedLocalBot.promotionHold}
                        {#if canStartBot(botStartGate, selectedLocalBot.name)}
                          <button
                            type="button"
                            class="local-bot-notice-start"
                            data-testid="local-bot-start"
                            disabled={localBotBusy === selectedLocalBot.name}
                            onclick={() => void startSelectedLocalBot()}
                          >
                            {localBotBusy === selectedLocalBot.name ? "Starting…" : "Start"}
                          </button>
                        {:else}
                          <!-- The gate is closed, so nothing is re-issued by
                               itself. A person asking still counts as consent
                               to look once more — the same one-listing recheck
                               the "cannot run here" notice offers, so a blocked
                               bot is never a dead end inside its own DM. -->
                          <button
                            type="button"
                            class="local-bot-notice-start"
                            data-testid="local-bot-recheck"
                            disabled={botRecheckBusy}
                            onclick={() => void recheckSelectedBot()}
                          >
                            {botRecheckBusy ? "Checking…" : BOT_NOT_RUNNABLE_RECHECK}
                          </button>
                        {/if}
                      {/if}
                      {#if localBotActionError}
                        <span class="local-bot-notice-error" role="alert">{localBotActionError}</span>
                      {/if}
                    </div>
                  {/if}
                {/snippet}
                <!--
                  One layer per conversation. `{#key}` remounts it on every
                  switch, which restarts `conversation-enter` — an opacity-only
                  ease-out that softens the swap. It starts part-visible rather
                  than at zero so the incoming conversation is legible on its
                  first painted frame and the pane never flashes empty.

                  Opacity only, and nothing here animates height, top or
                  margin: the box is identical before and after, so the fade
                  cannot move a single row. `prefers-reduced-motion` drops it.
                -->
                <div class="conversation-layer">
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
                  allowHereMention={Boolean(selectedRow?.channelId)}
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
                  headerOnly={welcomeIsBannerOnly}
                  header={isSetupChannel(selectedRow.channelId)
                    ? setupHeader
                    : isCompanyChannel
                      ? companyHeader
                      : selectedBotProgress && !(selectedBotCannotRun && !selectedBotAdopting)
                        ? botProgressHeader
                        : undefined}
                  belowMessages={agentThinkingBelow}
                  draftKey={selectedRow.id}
                  draftStorage={tenantStorage}
                />
                </div>
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
                    companies={(companies ?? []).filter(c => c.cloudUid?.startsWith("cmp_")).map(c => ({ uid: c.cloudUid!, name: c.displayName || c.slug, slug: c.slug }))}
                    {onopenurl}
                    bot={openLocalBot}
                    avatarUrl={openAgentMember.avatarUrl ??
                      avatarByUid[openLocalBot.agentUid] ??
                      null}
                    {adapter}
                    onchanged={refreshLocalBots}
                    onstart={startBotFromProfile}
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
                    {ownedLocalBotUids}
                    displayName={openAgentMember.displayName}
                    avatarUrl={openAgentMember.avatarUrl ??
                      avatarByUid[openAgentMember.personUid] ??
                      null}
                    description={openAgentMember.description}
                    companyUid={promotedBotCompany(localBotRecords, openAgentMember.personUid) ?? selectedRow.companyUid}
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
                  class:resizable-thread={!narrowViewport}
                  style:--thread-width={threadWidth === null ? "50%" : `${threadWidth}px`}
                  data-testid="reply-column"
                  data-reply-layout={narrowViewport ? "overlay" : "column"}
                >
                  {#if !narrowViewport}
                    <div
                      class="thread-resize-handle"
                      role="separator"
                      aria-label="Resize thread panel"
                      aria-orientation="vertical"
                      aria-valuenow={threadWidth ?? undefined}
                      tabindex="0"
                      onpointerdown={startThreadDrag}
                      onpointermove={moveThreadDrag}
                      onpointerup={stopThreadDrag}
                      onpointercancel={stopThreadDrag}
                      onlostpointercapture={() => {
                        threadDrag = null;
                      }}
                      onkeydown={resizeThreadKey}
                    ></div>
                  {/if}
                  <ReplyPanel
                    api={conversationApi}
                    {localBots}
                    rootEventId={openReplyRootId}
                    tasks={threadTasks}
                    scope={replyScope}
                    channelId={selectedRow.channelId}
                    withPersonUid={selectedRow.personUid}
                    withPersonName={selectedRow.title}
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
                    allowHereMention={Boolean(selectedRow?.channelId)}
                    {onopenurl}
                  />
                </div>
              {/if}
            </div>
          {:else if activeTab === "board"}
            <BoardTab
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

  {#if cheatSheetOpen}
    <ShortcutCheatSheet onclose={() => (cheatSheetOpen = false)} />
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
    overflow: hidden;
  }

  /* Synthetic #setup channel stacks the getting-started intro above the
     live thread instead of the usual conversation | reply-column row. */
  .chat-stage.is-setup {
    flex-direction: column;
  }

  /* The layer carries the column sizing the conversation used to own, so the
     wrapper is invisible to layout — same box, same flex behaviour. */
  .conversation-layer {
    display: flex;
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    animation: conversation-enter 140ms ease-out both;
  }

  .conversation-layer > :global(.conversation) {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }

  /* Starts at 0.55, not 0: the new conversation is readable immediately and
     only the last of the fade is in motion. A fade from zero would replace
     the old "blank then fill" flash with a slower one. */
  @keyframes conversation-enter {
    from {
      opacity: 0.55;
    }
    to {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .conversation-layer {
      animation: none;
    }
  }

  .chat-stage:has(.reply-column:not(.overlay)) .conversation-layer {
    min-width: min(320px, 50%);
  }

  /* Open thread pane takes half the conversation area — a 50/50 split
     between the main channel column and the thread panel. Profile panels
     keep their narrower fixed column (see .reply-column below). */
  .chat-stage:has(.reply-column:not(.profile-column):not(.overlay))
    .conversation-layer {
    flex: 1 1 0;
    min-width: min(360px, 50%);
  }

  .reply-column {
    position: relative;
    /* Stacking context (also covers .profile-column). Side-by-side both
       panes are isolated with z-index:auto; DOM order puts this column after
       .conversation so the opaque pane + border-left paint above main-pane
       hover chrome and message text. .overlay still overrides to
       position:absolute; z-index:5. */
    isolation: isolate;
    width: clamp(min(340px, 50%), 34%, 420px);
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--line);
    background: var(--v4-ground, #161618);
    /* No width transition: animating a flex column's width relayouts the
       whole conversation pane every frame while the thread opens. */
  }

  /* Thread pane (not the profile panel): open at half the conversation
     width. flex: 1 1 0 pairs with the sibling .conversation (also
     flex: 1 1 0) for a 50/50 split; the min-width keeps the composer usable
     on narrow windows. The border-left above keeps the hairline divider. */
  .reply-column:not(.profile-column):not(.overlay) {
    width: auto;
    flex: 1 1 0;
    min-width: min(360px, 50%);
  }

  .reply-column.resizable-thread {
    flex: 0 0 clamp(280px, var(--thread-width, 50%), calc(100% - 360px));
    min-width: min(280px, 50%);
  }

  .thread-resize-handle {
    position: absolute;
    left: -4px;
    top: 0;
    bottom: 0;
    width: 8px;
    z-index: 10;
    cursor: col-resize;
    touch-action: none;
  }

  .thread-resize-handle:hover,
  .thread-resize-handle:focus-visible {
    background: var(--line);
    outline: 1px solid var(--t2);
  }

  .reply-column.overlay {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(100%, 420px);
    z-index: 5;
    background: var(--v4-reading-surface, var(--v4-ground, #161618));
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

  /* Horizontal inset shared by the channel header, the timeline, and the
     composer so their left edges line up. The column reads like a document:
     a centred column capped at 880px: the inset is whatever is left over on
     each side, never under 40px, so the column stays wide on a laptop and the
     margins keep growing on a wide screen (the Claude desktop model). Pulled
     in when a thread or profile pane takes the right-hand third, so the
     messages keep a readable width there. */
  .channel-header,
  .chat-stage {
    --conv-inset: max(40px, calc((100% - 880px) / 2));
  }

  .channel-header[data-reply-open="true"],
  .chat-stage[data-reply-open="true"] {
    --conv-inset: 24px;
  }

  .channel-header {
    position: relative;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 0 0 auto;
    height: 52px;
    padding: 0 var(--conv-inset, 20px);
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

  .edit-profile-btn {
    appearance: none;
    -webkit-appearance: none;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--t2);
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 1.45;
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

  .company-office-stage.office-background { flex: none; height: 0; min-height: 0; overflow: visible; }
  .company-office-stage {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
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
  .local-bot-notice-hint {
    flex-basis: 100%;
    color: var(--t2);
    opacity: 0.85;
  }
  .local-bot-notice-error {
    flex-basis: 100%;
    color: var(--danger, #d05f5f);
  }
  .bot-unanswered {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 4px 16px 8px;
    color: var(--t2);
    font-size: 12px;
    line-height: 1.4;
  }
  /* The way out lives IN the line, not in a card the person has to find. */
  .bot-unanswered-action {
    font: inherit;
    font-weight: 600;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent, var(--t1));
    text-decoration: underline;
    cursor: pointer;
  }
  .bot-unanswered-action:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .bot-auto-restore {
    margin: 4px 16px 8px;
    color: var(--t2);
    font-size: 12px;
    line-height: 1.4;
  }
  /* Hosts the popover-sized recovery row in the shell's banner stack, so the
     moved component keeps its own compact idiom without floating. */
  .notification-recovery-banner {
    flex-shrink: 0;
    border-bottom: 1px solid var(--v4-hairline, rgba(0, 0, 0, 0.08));
    background: color-mix(in srgb, var(--v4-text-1, #111) 6%, transparent);
  }

  .bot-auto-restore-banner {
    margin: 8px 16px;
    padding: 8px 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--line2);
    color: var(--t2);
    font-size: 12px;
    line-height: 1.4;
  }
</style>
