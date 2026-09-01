<script lang="ts">
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
  import type { PlatformAdapter } from "@hq/platform";
  import V4TitleBar from "../home/V4TitleBar.svelte";
  import ChannelSkeleton from "./ChannelSkeleton.svelte";
  import ChatSidebar from "../chat/ChatSidebar.svelte";
  import ChannelConversation from "../chat/messaging/ChannelConversation.svelte";
  import AgentThinkingRow from "../chat/messaging/AgentThinkingRow.svelte";
  import SetupChannelIntro from "../chat/SetupChannelIntro.svelte";
  import { isSetupChannel } from "../chat/setup-channel.js";
  import AttachmentTray from "../chat/messaging/AttachmentTray.svelte";
  import type { FileAttachmentModel } from "../chat/messaging/channelMessageModels.js";
  import ReplyPanel, {
    type ReplyPreview,
  } from "../chat/messaging/ReplyPanel.svelte";
  import BoardTab from "../chat/messaging/BoardTab.svelte";
  import ChannelFilesTab from "../chat/messaging/ChannelFilesTab.svelte";
  import NotificationsView from "../inbox/NotificationsView.svelte";
  import SharedFilesOverlay from "../inbox/SharedFilesOverlay.svelte";
  import CommandPalette, {
    type CommandPaletteItem,
  } from "../common/CommandPalette.svelte";
  import ShellSettings, {
    type ShellSettingsProfile,
  } from "../settings/ShellSettings.svelte";
  import ChannelStatusPopover from "../chat/ChannelStatusPopover.svelte";
  import MemberProfilePanel from "../chat/MemberProfilePanel.svelte";
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
  import { onDestroy, onMount, untrack } from "svelte";
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
  import type {
    ChannelStatusModel,
    StatusPersonRow,
  } from "../chat/channel-status-model.js";
  import { applyChannelRoster, parseChannelMembers } from "./mesh-overlay.js";
  import {
    loadLiveChannelTabs,
    projectIdForRow,
    projectTabKey,
    rosterStatusForRow,
    type LiveChannelTabs,
  } from "./live-channel-tabs.js";
  import { HQ_CONSOLE_BASE } from "../common/hq-console.js";
  import {
    disambiguateMentionTargets,
    mentionTargetsFromContacts,
    mentionTargetsFromContactsPayload,
    mergeMentionRosters,
    type MentionTarget,
  } from "../chat/mentions.js";
  import {
    clearFromMessages,
    isAgentUid,
    startThinking,
    tick,
    type ThinkingEntry,
  } from "../chat/agent-thinking.js";
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
  import { conversationPairKey } from "../chat/messaging/chat-attachments.js";
  import {
    presignUrlFromResult,
    uploadChatAttachments,
    type PutChatAttachment,
  } from "../chat/messaging/upload-chat-attachments.js";
  import type { ConversationRow } from "../chat/sidebar-model.js";
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
    requestConversation,
    takePendingConversation,
    type ConversationTarget,
  } from "../chat/pending-conversation.js";
  import type { ChannelDirectoryRow } from "../chat/channel-directory-reconciler.js";
  import type { Workspace } from "../chat/workspaces.js";
  import {
    buildCompanyDisplayMap,
    companyDisplayName,
  } from "../company/company-display-map.js";
  import {
    accountChromeFromSelf,
    isSelf,
    settingsProfileFromSelf,
    type SelfIdentity,
  } from "../identity/self.js";
  import { createTenantStorage } from "../identity/tenant-storage.js";
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
    /** Wake events (host bridges MeshClient → bus); null when offline. */
    wakes?: ChatWakeBus | null;
    /** Workspace memberships → sidebar company scopes. */
    companies?: Workspace[] | null;
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
    wakes = null,
    companies = null,
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

  let view = $state<
    | "conversation"
    | "notifications"
    | "settings"
    | "meetings"
    | "library"
    | "shared-files"
  >("conversation");
  let libraryTab = $state<LibraryTab>("skills");
  let settingsSection = $state<EmbeddedSettingsSection | null>(null);
  let meetingFocusRequest = $state<{
    meetingId: string;
    sequence: number;
  } | null>(null);
  let meetingFocusSequence = 0;
  let embeddedNavigationError = $state<string | null>(null);
  let tab = $state<ChannelTab>("chat");
  let openReplyRootId = $state<string | null>(null);
  let attachTray = $state<{
    selectedId: string;
    items: FileAttachmentModel[];
  } | null>(null);
  let replyPreviewByRoot = $state<Record<string, ReplyPreview>>({});
  let replyCountOverride = $state<Record<string, number>>({});
  let narrowViewport = $state(false);
  let sidebarCollapsed = $state(false);
  let selectedRow = $state<ConversationRow | null>(initialRow);
  $effect(() => {
    const next = initialRow;
    if (!next) return;
    untrack(() => {
      if (!selectedRow) selectedRow = next;
    });
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
  /** Channel-header member pill → status/members popover. */
  let membersOpen = $state(false);
  /** Channel-header info control → project description dialog. */
  let projectAboutOpen = $state(false);

  const searchKindLabel: Record<ChannelTab | string, string> = {
    channel: "Channel",
    dm: "Direct message",
    group: "Group",
  };

  /**
   * Command-palette items: NAVIGATE actions (Notifications, Settings) plus one
   * CONVERSATION row per injected search row (ranked by recency in the
   * palette). Selecting a conversation opens it in the shell.
   */
  const isWeb = $derived(adapter.kind === "web");

  const paletteCommands = $derived.by((): CommandPaletteItem[] => {
    const nav: CommandPaletteItem[] = [
      {
        id: "command-go-notifications",
        label: "Notifications",
        detail: "Open the notifications feed",
        action: () => {
          view = "notifications";
        },
      },
      {
        id: "command-go-meetings",
        label: "Meetings",
        detail: "Open the meetings agenda",
        action: () => {
          view = "meetings";
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
    if (!isWeb) {
      nav.push({
        id: "command-go-marketplace",
        label: "Marketplace",
        detail: "Open marketplace in the library",
        action: () => openLibrary("marketplace"),
      });
    }
    const conversations: CommandPaletteItem[] = searchRows.map((row) => ({
      id: `conversation-${row.id}`,
      label: row.title,
      detail:
        row.kind === "channel"
          ? (row.companyUid ?? "channel")
          : (searchKindLabel[row.kind] ?? "Conversation"),
      lastActivityAt: row.lastActivityAt,
      action: () => handleSelect(row),
    }));
    return [...nav, ...conversations];
  });

  const watched = $derived(companies?.length ?? 0);
  const companyNames = $derived(buildCompanyDisplayMap(companies ?? []));

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
  const activeTab = $derived(isProjectChannel ? tab : "chat");

  /** Real ChannelView composer placeholder (verbatim from the desktop source). */
  const composerPlaceholder = $derived.by(() => {
    const row = selectedRow;
    if (!row) return "Reply…";
    const isGroup = row.kind === "dm" || row.kind === "group";
    return `Message ${isGroup ? row.title : `# ${row.title}`} — or type @ to mention an agent…`;
  });

  let liveTimeline = $state<ConversationMessageWire[]>([]);
  let liveTimelineId = $state<string | null>(null);
  let timelineHydrating = $state(false);
  const timelineCache = new Map<string, ConversationMessageWire[]>();
  /** Last rail activity stamp emitted from a committed DM timeline, per peer. */
  const lastDmTimelineStampByUid = new Map<string, string>();
  /**
   * GET /v1/notify/dm-threads answered 404 for this tenant — the server
   * predates the peer index. Stop asking; the inbox path still runs.
   */
  let dmThreadsUnsupported = false;

  // Client-side "agent is thinking" rows for the open channel. Local only —
  // the backend has no typing/ack events. Per-conversation: a row switch
  // must not keep another channel's optimistic status on screen.
  const AGENT_THINKING_TICK_MS = 5_000;
  let agentThinking = $state<ThinkingEntry[]>([]);

  $effect(() => {
    void selectedRow?.id;
    agentThinking = [];
  });

  onMount(() => {
    const handle = window.setInterval(() => {
      agentThinking = tick(agentThinking, Date.now());
    }, AGENT_THINKING_TICK_MS);
    return () => clearInterval(handle);
  });

  /** Clear thinking rows when those agents appear in a freshly fetched page
   *  (recent messages only — not the full merged timeline, or historical
   *  agent posts would immediately kill a new mention's indicator). */
  function clearThinkingFromIncoming(
    messages: ConversationMessageWire[],
  ): void {
    if (agentThinking.length === 0) return;
    // Timestamp-aware so a full-history hydrate or overlapping catch-up page
    // containing an OLD agent message cannot clear a newer row.
    agentThinking = clearFromMessages(agentThinking, messages);
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
    }
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

  async function applyFetchedTimeline(
    row: ConversationRow,
    raw: unknown | null,
  ): Promise<void> {
    // Apply whenever this row is still selected. Do not require matching
    // timelineSeq — MQTT catch-up / a re-run of the hydrate effect used to
    // bump seq and drop the first successful fetch, leaving a hard-refresh
    // on the opening conversation empty until the user clicked away and back.
    if (selectedRow?.id !== row.id) return;
    timelineHydrating = false;
    if (raw == null) return;
    const incoming = messagesForDisplay(raw);
    commitTimeline(row, incoming);
    clearThinkingFromIncoming(incoming);
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
    commitTimeline(
      row,
      existing.length > 0
        ? mergeFetchedTimeline(existing, raw)
        : incoming,
    );
    clearThinkingFromIncoming(incoming);
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
  const board = $derived<BoardTabData | null>(
    boardHasCards ? overlayBoard : (liveTabs?.board ?? overlayBoard),
  );
  const files = $derived<ChannelFileItemModel[]>(
    overlayFiles.length > 0 ? overlayFiles : (liveTabs?.files ?? []),
  );
  let channelRosterById = $state<
    Record<string, ReturnType<typeof parseChannelMembers>>
  >({});

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

  // ── Member profile panel + remove-member (Slack-style right panel) ──────────
  let openProfileMember = $state<StatusPersonRow | null>(null);
  let removingMemberUid = $state<string | null>(null);
  let selfAvatarUrl = $state<string | null>(null);
  let selfDescription = $state<string | null>(null);

  /** personUid → presigned avatar URL, sourced from the active channel roster
   *  plus the signed-in user's own profile. Feeds chat/thread/panel photos. */
  const avatarByUid = $derived.by(() => {
    const map: Record<string, string> = {};
    const roster =
      channelRosterById[selectedRow?.channelId?.trim() ?? ""] ?? [];
    for (const m of roster) {
      if (m.avatarUrl && m.personUid) map[m.personUid] = m.avatarUrl;
    }
    if (self?.uid && selfAvatarUrl) map[self.uid] = selfAvatarUrl;
    return map;
  });

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
    // One right panel at a time — a profile supersedes an open reply thread.
    openReplyRootId = null;
    openProfileMember = row;
    if (tab !== "chat") tab = "chat";
  }

  function closeMemberProfile(): void {
    openProfileMember = null;
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
      }
    } finally {
      removingMemberUid = null;
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

  const channelStatus = $derived.by((): ChannelStatusModel | null => {
    if (!selectedRow) return null;
    const channelId = selectedRow.channelId?.trim() ?? "";
    const roster = channelRosterById[channelId] ?? [];
    const base =
      channelStatusByRow?.(selectedRow) ??
      liveTabs?.status ??
      (roster.length > 0
        ? rosterStatusForRow(
            selectedRow,
            roster,
            selectedRow.companyUid
              ? companyDisplayName(selectedRow.companyUid, companyNames)
              : null,
          )
        : null);
    if (!base) return null;
    if (roster.length === 0) return base;
    return applyChannelRoster(base, roster, identities);
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
  });

  function openReply(rootEventId: string): void {
    const id = rootEventId.trim();
    if (id) {
      openProfileMember = null;
      openReplyRootId = id;
    }
  }

  function closeReply(): void {
    openReplyRootId = null;
    pendingReplyRootId = null;
    pendingReplyForRowId = null;
    replyApplyInFlight = null;
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
    view = "conversation";
    tab = "chat";
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
    if (activeTab !== "chat") openReplyRootId = null;
  });

  $effect(() => {
    const rowId = selectedRow?.id ?? null;
    const pending = pendingReplyRootId?.trim() || null;
    const boundTo = pendingReplyForRowId;
    untrack(() => {
      if (rowId !== lastReplyRowId) {
        lastReplyRowId = rowId;
        openReplyRootId = null;
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

  function handleSelect(
    row: ConversationRow,
    options?: { replyRootEventId?: string | null; preserveView?: boolean },
  ): void {
    selectedRow = row;
    if (!options?.preserveView) {
      view = "conversation";
      meetingFocusRequest = null;
    }
    tab = "chat";
    paletteOpen = false;
    membersOpen = false;
    projectAboutOpen = false;
    openReplyRootId = null;
    queueReplyForRow(row, options?.replyRootEventId);
    attachTray = null;
    onselectrow?.(row);
  }

  function applyConversationDeepLink(
    link: ConversationDeepLink,
    options?: { preserveView?: boolean },
  ): void {
    const row =
      conversationRowForDeepLink(link, searchRows) ??
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
      },
      { preserveView: pending.automatic && view !== "conversation" },
    );
  }

  function applyPendingConversation(target: ConversationTarget): void {
    applyConversationDeepLink(
      {
        channelId: null,
        personUid: target.personUid?.trim() || null,
        replyRootEventId: target.replyRootEventId ?? null,
      },
      { preserveView: target.automatic === true && view !== "conversation" },
    );
  }

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
    // Company scope is a tenant boundary too. Remove every visible selection
    // before the re-keyed sidebar begins reads in the replacement scope.
    tenantCompanyId = companyUid;
    selectedRow = null;
    liveTimeline = [];
    liveTimelineId = null;
    timelineHydrating = false;
    lastDmTimelineStampByUid.clear();
    dmThreadsUnsupported = false;
    openReplyRootId = null;
    openProfileMember = null;
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
        liveMentionTargets = mentionTargetsFromContactsPayload(res.value);
      });
    return () => {
      cancelled = true;
    };
  });

  onDestroy(() => {
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
  }): Promise<void> {
    const row = selectedRow;
    if (!row?.channelId) return;
    if (row.channelId !== wake.channelId && row.id !== `ch:${wake.channelId}`) {
      return;
    }
    if (timelineHasEvent(liveTimeline, wake.eventId)) return;
    const res = await adapter.messaging.fetchChannel({
      channelId: row.channelId,
      limit: 20,
      since: sinceForChannelWake(liveTimeline, wake.createdAt),
    });
    if (!res.ok) return;
    if (selectedRow?.id !== row.id) return;
    const incoming = messagesForDisplay(res.value);
    commitTimeline(row, mergeFetchedTimeline(liveTimeline, res.value));
    clearThinkingFromIncoming(incoming);
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
      notifications.fetchDmInbox({
        ...(since ? { since } : {}),
        limit: "50",
      }),
      wantThreads
        ? notifications.fetchDmThreads!({ limit: 100 }).catch(() => null)
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
      bus.on("dm:new-message", () => {
        void catchUpDmInbox();
      }),
      bus.on("mesh:catchup", () => {
        const row = selectedRow;
        if (row) void catchUpTimeline(row);
        void catchUpDmInbox();
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
    const fromRow = row?.companyUid?.trim();
    if (fromRow) return fromRow;
    const first = (companies ?? []).find((company) => company.cloudUid?.trim());
    return first?.cloudUid?.trim() || null;
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
    return uploadChatAttachments({
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
          agentThinking = startThinking(
            agentThinking,
            {
              agentUid: row.personUid,
              agentName: row.title?.trim() || "Agent",
            },
            Date.now(),
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
        agentThinking = startThinking(
          agentThinking,
          {
            agentUid: mention.participantUid,
            agentName: mention.displayName,
          },
          Date.now(),
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
      // Send never left — drop every optimistic thinking row so the status
      // cannot outlive a failed mention.
      agentThinking = [];
      throw err;
    }
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
      const existing = (searchRows ?? []).find(
        (row) => row.personUid === dest.personUid,
      );
      handleSelect(
        existing ?? {
          id: `dm:${dest.personUid}`,
          kind: "dm",
          title: dest.title,
          companyUid: null,
          unreadDot: false,
          lastActivityAt: item.createdAtMs,
          pinned: false,
          personUid: dest.personUid,
        },
      );
      return;
    }
    if (dest.kind === "files") {
      // Share rows do not include a company UID. Route to the bounded,
      // server-scoped share list rather than guessing a tenant or aliasing it.
      view = "shared-files";
      paletteOpen = false;
      membersOpen = false;
      projectAboutOpen = false;
    }
  }

  function openLibrary(next: LibraryTab = "skills"): void {
    libraryTab = next;
    view = "library";
    meetingFocusRequest = null;
    paletteOpen = false;
    membersOpen = false;
    projectAboutOpen = false;
  }

  function toggleNotifications(): void {
    view = view === "notifications" ? "conversation" : "notifications";
    meetingFocusRequest = null;
  }

  function openSettings(section: EmbeddedSettingsSection | null = null): void {
    view = "settings";
    settingsSection = section;
    meetingFocusRequest = null;
    paletteOpen = false;
    membersOpen = false;
    projectAboutOpen = false;
    onOpenSettings?.();
  }

  function closeSettings(): void {
    view = "conversation";
    settingsSection = null;
    meetingFocusRequest = null;
  }

  /** Apply a host route after DesktopApp's event listeners have mounted. */
  function applyEmbeddedNavigation(target: EmbeddedNavigationTarget): void {
    embeddedNavigationError = null;
    switch (target.kind) {
      case "home":
      case "messages":
        view = "conversation";
        settingsSection = null;
        meetingFocusRequest = null;
        return;
      case "inbox":
        view = "notifications";
        settingsSection = null;
        meetingFocusRequest = null;
        return;
      case "meetings":
        view = "meetings";
        settingsSection = null;
        meetingFocusRequest = target.meetingId?.trim()
          ? { meetingId: target.meetingId.trim(), sequence: ++meetingFocusSequence }
          : null;
        return;
      case "library":
        openLibrary(target.tab);
        settingsSection = null;
        meetingFocusRequest = null;
        return;
      case "settings":
        meetingFocusRequest = null;
        openSettings(target.section ?? null);
        return;
      case "channel":
        meetingFocusRequest = null;
        requestChannelOpen(target.channelId, {
          replyRootEventId: target.replyRootEventId,
        });
        return;
      case "dm":
        meetingFocusRequest = null;
        requestConversation({
          personUid: target.personUid,
          email: "",
          displayName: "",
          replyRootEventId: target.replyRootEventId,
        });
        return;
      case "unsupported":
        embeddedNavigationError = `${target.reason}: ${target.route}`;
        return;
    }
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

    function onKey(event: KeyboardEvent) {
      const meta = event.metaKey || event.ctrlKey;
      if (!meta) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        paletteOpen = !paletteOpen;
      } else if (key === ",") {
        // macOS-standard ⌘, opens Settings.
        event.preventDefault();
        openSettings();
      } else if (key === "1") {
        event.preventDefault();
        view = "notifications";
        meetingFocusRequest = null;
      } else if (key === "2") {
        event.preventDefault();
        view = "meetings";
        meetingFocusRequest = null;
      } else if (adapter.kind !== "web" && key === "3") {
        event.preventDefault();
        openLibrary("marketplace");
      } else if (key === "4") {
        event.preventDefault();
        openLibrary("skills");
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

<div class="desktop-shell chat-shell" data-testid="desktop-shell">
  <V4TitleBar
    {adapter}
    {version}
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
      view = "meetings";
      meetingFocusRequest = null;
      paletteOpen = false;
      membersOpen = false;
      projectAboutOpen = false;
    }}
    onOpenSettings={() => openSettings()}
    onopenLibrary={() => openLibrary("skills")}
    onopenMarketplace={isWeb ? undefined : () => openLibrary("marketplace")}
    {onopenurl}
  />

  {#if embeddedNavigationError}
    <div
      class="embedded-navigation-error"
      data-testid="embedded-navigation-error"
      role="alert"
    >
      Couldn’t open requested destination. {embeddedNavigationError}
    </div>
  {/if}

  {#if view === "settings"}
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
        onback={closeSettings}
        onsignout={onsignout}
        onopenconsole={onOpenConsole
          ? (url) => onOpenConsole(url ?? HQ_CONSOLE_BASE)
          : undefined}
        consoleBase={HQ_CONSOLE_BASE}
        {updateWakeSeq}
        {refreshAppVersion}
      />
    </div>
  {:else}
    <div class="desktop-body">
      {#if !sidebarCollapsed}
        {#key `${tenantGeneration}:${tenantCompanyId ?? "all"}`}
        <ChatSidebar
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
          onselect={(row, options) =>
            handleSelect(row, {
              preserveView: options?.automatic === true && view !== "conversation",
            })}
          oncompanyscopechange={changeTenantCompany}
          oncommand={() => (paletteOpen = true)}
          onnavigateMessages={() => {
            view = "conversation";
            meetingFocusRequest = null;
          }}
          onopenSettings={() => openSettings()}
          onsignout={onsignout}
        />
        {/key}
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
              view = "conversation";
              meetingFocusRequest = null;
            }}
            onunreadchange={(n) => (unreadCount = n)}
            onopen={openNotification}
          />
        </div>
        {#if view === "shared-files"}
          <SharedFilesOverlay
            {adapter}
            onback={() => {
              view = "conversation";
              meetingFocusRequest = null;
            }}
          />
        {:else if view === "meetings"}
          <MeetingsPage
            {adapter}
            accountId={tenantAccountId}
            storage={tenantStorage}
            sessionGeneration={tenantGeneration}
            onback={() => {
              view = "conversation";
              meetingFocusRequest = null;
            }}
            openExternal={onopenurl}
            focusRequest={meetingFocusRequest}
          />
        {:else if view === "conversation" && selectedRow}
          <header
            class="channel-header chat-shell"
            data-testid="channel-header"
          >
            <div class="channel-title-block">
              <div class="channel-title">
                {#if selectedRow.kind === "channel"}
                  <span class="channel-hash" aria-hidden="true">#</span>
                {/if}
                <h2 data-testid="channel-name">{selectedRow.title}</h2>
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
              {#if isProjectChannel}
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
                      onclick={() => (tab = t.id)}
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
                        )}
                      {self}
                      onclose={() => (membersOpen = false)}
                      {onopenurl}
                      onopenprofile={(row) => {
                        membersOpen = false;
                        openMemberProfile(row);
                      }}
                      onremovemember={(row) => void removeMember(row)}
                      removingUid={removingMemberUid}
                    />
                  {/if}
                </div>
              {/if}
            </div>
          </header>
          {#if projectAboutOpen && isProjectChannel}
            <ProjectAboutDialog
              title={selectedRow.title}
              description={channelStatus?.project.description ?? null}
              onclose={() => (projectAboutOpen = false)}
            />
          {/if}

          {#if activeTab === "chat"}
            <div
              class="chat-stage"
              class:is-setup={isSetupChannel(selectedRow.channelId)}
              data-testid="chat-stage"
              data-reply-open={openReplyRootId || openProfileMember
                ? "true"
                : "false"}
            >
              {#key selectedRow.id}
                {#snippet agentThinkingBelow()}
                  <!-- Inside the conversation scroller (typing-indicator
                       position) — a chat-stage sibling would become a second
                       flex-row column floating top-right. -->
                  <AgentThinkingRow entries={agentThinking} />
                {/snippet}
                {#snippet setupHeader()}
                  <SetupChannelIntro
                    settings={adapter.settings}
                    shell={adapter.shell}
                    {onopenurl}
                  />
                {/snippet}
                <ChannelConversation
                  messages={timeline}
                  reactions={rowReactions}
                  placeholder={composerPlaceholder}
                  {onopenurl}
                  ontogglereaction={persistReaction}
                  selfDisplayName={self?.displayName ?? null}
                  selfPersonUid={self?.uid ?? null}
                  onsend={persistSend}
                  onpresign={presignAttachment}
                  mentionCandidates={mentionRoster}
                  onreply={openReply}
                  onopenprofile={openProfileForAuthor}
                  onopenattachment={openAttachmentTray}
                  onreleaseurl={releaseAttachmentUrl}
                  vaultCompanyUid={attachmentCompanyUid(selectedRow)}
                  {replyPreviewByRoot}
                  {avatarByUid}
                  {displayNameByUid}
                  activeRootEventId={openReplyRootId}
                  loading={timelineHydrating && timeline.length === 0}
                  header={isSetupChannel(selectedRow.channelId)
                    ? setupHeader
                    : undefined}
                  belowMessages={agentThinkingBelow}
                />
              {/key}
              {#if openProfileMember}
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
                    rootEventId={openReplyRootId}
                    scope={replyScope}
                    channelId={selectedRow.channelId}
                    withPersonUid={selectedRow.personUid}
                    {seedRoot}
                    {wakes}
                    reactions={rowReactions}
                    ontogglereaction={persistReaction}
                    selfDisplayName={self?.displayName ?? null}
                    onuploadfiles={uploadFilesForSelectedRow}
                    onpresign={presignAttachment}
                    onopenattachment={openAttachmentTray}
                    onreleaseurl={releaseAttachmentUrl}
                    vaultCompanyUid={attachmentCompanyUid(selectedRow)}
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
              columns={board?.columns ?? []}
              stories={board?.stories ?? {}}
              onOpenInChannel={() => (tab = "chat")}
            />
          {:else}
            <ChannelFilesTab
              {files}
              previewContext={channelFilePreviewContext}
              onloadpreview={loadChannelFilePreview}
              onauthorizeaction={canPerformChannelFileAction}
              onreveal={revealChannelFile}
              onopen={openChannelFile}
            />
          {/if}
        {:else}
          <!-- Pre-selection boot state: skeleton, not a "No data" flash. -->
          <ChannelSkeleton />
        {/if}
      </main>
    </div>
  {/if}

  {#if view === "library"}
    <LibraryOverlay
      {adapter}
      tab={libraryTab}
      {packagesEvents}
      onback={() => {
        view = "conversation";
        meetingFocusRequest = null;
      }}
      onnavigatetab={(next) => (libraryTab = next)}
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

  .desktop-main {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0;
    min-width: 0;
    min-height: 0;
    padding: 0;
    overflow: hidden;
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
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
  }

  .chat-stage:has(.reply-column:not(.overlay)) :global(.conversation) {
    min-width: 320px;
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
</style>
