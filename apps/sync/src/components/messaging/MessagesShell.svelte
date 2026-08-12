<script lang="ts">
  // Dedicated Messages window (US-009 / DESKTOP-002). A resizable master/detail
  // shell:
  //
  //   ┌──────────────┬─────────────────────────────┐
  //   │ room rail    │   naked conversation /      │
  //   │ (DMs +       │   deep-linked object pane   │
  //   │ group DMs +  │   (Conversation /           │
  //   │ channels)    │    ShareMainPane /           │
  //   │              │    DmRequestCard)            │
  //   └──────────────┴─────────────────────────────┘
  //
  // Direct Messages, connection requests, shared HQ paths, channels, threads,
  // reactions, and the "Your agent" handoff are wired through Tauri commands.
  // This shell owns the data loading and hands shared primitives presentation
  // state plus callbacks. DESKTOP-002: no People/Requests tabs or noisy activity
  // previews — those live behind Mentions & activity; no redundant "Messages"
  // page title; glass only on the navigation rail.
  //
  // Visuals adopt the desktop "Company OS" design language: the standalone
  // Messages window consumes the SAME token layer as the desktop window via
  // `desktop-alt.css` (which `@import`s the canonical token primitives and adds
  // the desktop alias layer + five-size type ramp, scoped to
  // `html[data-window='messages']` alongside `desktop-alt`). Geist Sans is
  // loaded by the shared design system; keep Geist Mono for data.
  // See DESIGN.md → "Big-window type & chrome".
  import '@fontsource-variable/geist-mono/wght.css';
  import '../../desktop-alt/styles/desktop-alt.css';
  import { invoke } from '@tauri-apps/api/core';
  import {
    listen,
    type EventCallback,
    type UnlistenFn,
  } from '@tauri-apps/api/event';
  import { safeUnlisten } from '../../lib/listener-registry';
  import { buildClaudeCodeUrl } from '../../lib/claude-code-link';
  import { hqSkillMarkdownLink } from '../../lib/hq-skill-link';
  import { buildClaudePromptWithSkillCatalog } from '../../lib/skill-catalog-prompt';
  import { appendInboundBatch } from '../../lib/dmThread';
  import { shareTitle } from '../../lib/share-path';
  import Conversation, { type ConversationMessage } from './Conversation.svelte';
  import ComposeMessage, { type ComposeSendResult } from './ComposeMessage.svelte';
  import DmRequestCard from './DmRequestCard.svelte';
  import ChannelView from './ChannelView.svelte';
  import CreateChannel from './CreateChannel.svelte';
  import ThreadPanel from './ThreadPanel.svelte';
  import IdentityMark from './IdentityMark.svelte';
  import ShareMainPane from '../ShareMainPane.svelte';
  import {
    contactPreviewAt,
    contactPreviewText,
    mergeContactPreviews,
    mergeConversations,
    previewFromMessages,
    sortContactsByRecentActivity,
    type ContactPreviewFields,
    type ContactRecencyFields,
    type ConversationEventRecencyFields,
  } from './contact-order';
  import {
    type DmRequest,
    type RequestAction,
    addRequest,
    enrichRequestFromContacts,
    removeRequest,
    requestHasHumanLabel,
    requestDisplayName,
  } from '../../lib/dmRequests';
  import { humanPersonLabel } from '../../lib/visible-labels';
  import {
    type Channel,
    type CompanyLabel,
    channelDisplayName,
    companyNameFor,
    upsertChannel,
    bumpChannelUnread,
    clearChannelUnread,
  } from '../../lib/channels';
  import { type ReactionEvent, dmScope } from '../../lib/reactions';
  import { ReactionController } from '../../lib/reactionController.svelte';
  import { ShareReactionController } from '../../lib/shareReactionController.svelte';
  import type { ShareEvent } from '../../lib/notificationGroups';
  import {
    applySharePreviews,
    buildSharePrompt,
    mergeSharesIntoThread,
    previewRepresentsShare,
    shareSummary,
    sharesForPeer,
  } from '../../lib/shareTimeline';
  import {
    MESSAGE_PERSON_EVENT,
    takePendingConversation,
    type ConversationTarget,
  } from '../../lib/pendingConversation';
  import {
    OPEN_CHANNEL_EVENT,
    OPEN_DM_REQUESTS_EVENT,
    takePendingChannel,
    takePendingDmRequests,
  } from '../../desktop-alt/chat/open-target';
  import {
    createOutboundMessage,
    retrySend,
    runSend,
    type OutboundMessage,
  } from './sendStateMachine';

  interface Props {
    /** Fill the desktop canvas instead of the dedicated native window. */
    embedded?: boolean;
  }

  let { embedded = false }: Props = $props();

  // A person the caller can DM (connection or company teammate). Mirrors the
  // Rust `Contact` wire shape (camelCase).
  interface Contact extends ContactRecencyFields, ContactPreviewFields {
    personUid: string;
    email: string;
    displayName: string;
    companyUid?: string | null;
    source?: string | null;
    lastMessageAt?: string | null;
    lastActivityAt?: string | null;
    lastDmAt?: string | null;
    lastMessageBody?: string | null;
    lastMessagePreview?: string | null;
    lastMessageText?: string | null;
    lastMessageDirection?: string | null;
    previewBody?: string | null;
    previewAt?: string | null;
    previewDirection?: string | null;
  }

  interface DmEvent {
    eventId: string;
    fromPersonUid: string;
    fromEmail: string;
    fromDisplayName: string;
    body: string;
    details?: string | null;
    prompt?: string | null;
    createdAt: string;
  }

  interface ContactsResponse {
    contacts: Contact[];
  }

  interface NotificationHistoryResponse {
    dms?: ConversationEventRecencyFields[];
    shares?: ShareEvent[];
  }

  interface ThreadMessage extends ConversationMessage {
    fromEmail: string;
  }

  interface ThreadResponse {
    messages: ThreadMessage[];
    nextCursor?: string | null;
  }

  interface UnreadSummary {
    unreadDms: number;
    pendingRequests: number;
  }
  let unreadSummary = $state<UnreadSummary>({ unreadDms: 0, pendingRequests: 0 });
  let unreadSummaryLoadGeneration = 0;

  interface AppConfig {
    personUid?: string | null;
    hqFolderPath?: string | null;
    companySlug?: string | null;
  }

  interface RequestsResponse {
    requests: DmRequest[];
    nextCursor?: string | null;
  }

  let contacts = $state<Contact[]>([]);
  let loadingContacts = $state(false);
  let contactsError = $state<string | null>(null);
  let contactsLoadGeneration = 0;
  let contactMutationRevision = 0;
  const contactMutationRevisions = new Map<string, number>();

  // Pending incoming connection requests (US-011 / DESKTOP-002). They feed the
  // unread/activity shortcut and can open the shared <DmRequestCard/> through a
  // deep link. `list_dm_requests` is
  // the source of truth; `dm:request-new` / `dm:request-update` keep it live.
  let requests = $state<DmRequest[]>([]);
  let loadingRequests = $state(false);
  let requestsError = $state<string | null>(null);
  let selectedRequest = $state<DmRequest | null>(null);
  let requestsLoadGeneration = 0;
  let requestMutationRevision = 0;
  const requestMutations = new Map<
    string,
    { revision: number; request: DmRequest | null }
  >();

  // Channels (US-018). `list_channels` is the source of truth for the rail;
  // `channel:new-message` / `channel:updated` keep it live. `selectedChannel`
  // drives the right pane (<ChannelView/>). `companyLabels` feeds the per-company
  // group headers (derived from the caller's memberships).
  let channels = $state<Channel[]>([]);
  let loadingChannels = $state(false);
  let channelsError = $state<string | null>(null);
  let retryingChannels = $state(false);
  let selectedChannel = $state<Channel | null>(null);
  let channelsLoadGeneration = 0;
  let channelMutationRevision = 0;
  const channelMutations = new Map<
    string,
    { revision: number; channel: Channel }
  >();
  let companyLabels = $state<CompanyLabel[]>([]);
  // Create-channel overlay (null = closed). Holds the preset company scope the
  // "+ New channel" affordance was clicked under (undefined slot = personal).
  let creatingChannel = $state(false);
  let creatingGroupDm = $state(false);
  let createPresetCompany = $state<string | null>(null);
  // The signed-in caller's personUid — resolved lazily for the roster's
  // owner/self checks. `whoami`-style resolution lives in Rust; we read it from
  // the unread summary path's identity if available, else leave null (the
  // roster degrades to server-enforced owner gating).
  let selfPersonUid = $state<string | null>(null);
  let hqFolderPath = $state('');
  let companySlug = $state<string | null>(null);
  let previewHydrationRun = 0;
  const PREVIEW_HYDRATION_LIMIT = 40;
  const LIVE_INBOUND_BACKFILL_LIMIT = 50;
  const liveInboundByPeer = new Map<string, DmEvent[]>();

  interface MembershipRow {
    companyUid: string;
    companyName: string | null;
    role: string | null;
    status: string;
  }

  interface ChannelsResponse {
    channels: Channel[];
  }

  // Selected peer + its loaded thread.
  let selected = $state<Contact | null>(null);
  let didAutoSelectConversation = $state(false);
  let messages = $state<ThreadMessage[]>([]);
  let loadingThread = $state(false);
  let threadError = $state<string | null>(null);
  let threadLoadGeneration = 0;

  let sending = $state(false);
  let sendError = $state<string | null>(null);
  let dmSendGeneration = 0;
  /** In-flight / failed optimistic DM sends (same machine as channels). */
  let dmOutboundById = $state<Map<string, OutboundMessage>>(new Map());

  // Share history (client-side merge): the peer's share events from the same
  // notification-history fetch the rail already makes. Rendered as:
  //   - ordinary rail rows that open <ShareMainPane/> (DESKTOP-002),
  //   - inline share-card bubbles in the DM thread, and
  //   - the rail's "Shared a file" preview when a contact's newest item is a share.
  let shareHistory = $state<ShareEvent[]>([]);
  // Selected share notification(s) for the naked payload canvas. Grouped by
  // issuer so multiple shares from one peer open as one ShareMainPane list.
  let selectedShareEvents = $state<ShareEvent[]>([]);

  const peerShares = $derived.by((): ShareEvent[] => {
    const peer = selected;
    if (!peer || peer.source === 'agent') return [];
    return sharesForPeer(shareHistory, {
      // An unresolved compose peer carries a synthetic `email:` uid — match by
      // email only in that case.
      personUid: peer.personUid.startsWith('email:') ? '' : peer.personUid,
      email: peer.email,
    });
  });

  // Reactions on the peer's shares (scope `share:{eventId}` per share, a
  // SEPARATE Rust watch slot from the DM conversation registration).
  const shareReactions = new ShareReactionController();
  $effect(() => {
    void shareReactions.setShares(peerShares.map((s) => s.eventId));
  });

  const shareIds = $derived(new Set(peerShares.map((s) => s.eventId)));

  function shareToMessage(share: ShareEvent): ThreadMessage {
    return {
      eventId: share.eventId,
      fromPersonUid: share.issuerPersonUid || '',
      fromEmail: share.issuerEmail,
      fromDisplayName: share.issuerDisplayName,
      body: shareSummary(share),
      details: null,
      prompt: buildSharePrompt(share),
      createdAt: share.createdAt,
      direction: 'in',
      share,
    };
  }

  // The rendered DM timeline: server DMs (chronological) with the peer's
  // shares merged in as inline share cards. `messages` itself stays DM-only so
  // the DM reaction registration below never claims share ids. Outbound rows
  // carry `sendStatus` from the shared sendStateMachine (US-011 / US-004).
  const displayMessages = $derived.by((): ConversationMessage[] => {
    const withStatus = messages.map((msg) => {
      const outbound = dmOutboundById.get(msg.eventId);
      if (!outbound) return msg;
      return { ...msg, sendStatus: outbound.status };
    });
    if (selected && selected.source !== 'agent') {
      return mergeSharesIntoThread(withStatus, peerShares, shareToMessage);
    }
    return withStatus;
  });

  function patchDmOutboundRow(msg: OutboundMessage): void {
    messages = messages.map((row) =>
      row.eventId === msg.clientId
        ? { ...row, sendStatus: msg.status, body: msg.body }
        : row,
    );
  }

  // Route a reaction toggle to the right controller: share bubbles carry the
  // share's own `share:{eventId}` scope, everything else is the DM scope.
  function toggleThreadReaction(messageId: string, emoji: string): void {
    if (shareIds.has(messageId)) {
      shareReactions.toggle(messageId, emoji);
      return;
    }
    dmReactions?.toggle(messageId, emoji);
  }

  async function openShareInClaude(share: ShareEvent): Promise<void> {
    try {
      const url = buildClaudeCodeUrl({ folder: hqFolderPath, prompt: buildSharePrompt(share) });
      await invoke('open_claude_code_link', { url });
    } catch (err) {
      console.error('messages: open_claude_code_link failed', err);
      throw err;
    }
  }

  // Reactions (US-025) for the open DM conversation. Recreated when the selected
  // peer changes (each conversation is its own messageScope); the message list is
  // (re)registered whenever `messages` changes so the Rust poll path knows which
  // messages to re-fetch reactions for on a "reaction" wake.
  let dmReactions = $state<ReactionController | null>(null);

  $effect(() => {
    const peer = selected;
    if (!peer || peer.source === 'agent' || peer.personUid.startsWith('email:')) {
      // No durable conversation yet (compose-pending / unresolved email) → no
      // reactions surface.
      dmReactions?.dispose();
      dmReactions = null;
      return;
    }
    const controller = new ReactionController(dmScope(peer.personUid));
    dmReactions = controller;
    return () => controller.dispose();
  });

  // Keep the active-conversation registration + loaded reactions in step with the
  // visible DM messages (skips optimistic local-* / pending-* ids — those have no
  // server reactions yet).
  $effect(() => {
    const controller = dmReactions;
    if (!controller) return;
    const ids = messages
      .filter((m) => !m.pending && !m.eventId.startsWith('local-') && !m.eventId.startsWith('pending-'))
      .map((m) => m.eventId);
    void controller.setMessages(ids);
  });

  // New Message compose overlay (US-010).
  let composing = $state(false);

  function openCompose(): void {
    composing = true;
  }

  // Threads (US-022). The open thread, if any, opened from a root message's
  // reply-count affordance in the DM or channel pane. Rendered as a right-side
  // ThreadPanel (overlay on narrow widths, third column on wide). `null` = closed.
  interface OpenThread {
    rootEventId: string;
    scope: 'dm' | 'channel';
    channelId: string | null;
    withPersonUid: string | null;
    title: string;
    showAuthors: boolean;
  }
  let openThread = $state<OpenThread | null>(null);

  // Open the thread for a DM root message. The reply recipient is the selected peer.
  function handleOpenDmThread(rootEventId: string): void {
    if (!selected || selected.source === 'agent') return;
    openThread = {
      rootEventId,
      scope: 'dm',
      channelId: null,
      withPersonUid: selected.personUid,
      title: `Thread · ${displayLabel(selected)}`,
      showAuthors: false,
    };
  }

  // Open the thread for a channel root message. The channel is the current channel.
  function handleOpenChannelThread(rootEventId: string): void {
    if (!selectedChannel) return;
    openThread = {
      rootEventId,
      scope: 'channel',
      channelId: selectedChannel.channelId,
      withPersonUid: null,
      title:
        selectedChannel.scope === 'group'
          ? `Thread · ${channelDisplayName(selectedChannel)}`
          : `Thread · #${channelDisplayName(selectedChannel)}`,
      showAuthors: true,
    };
  }

  function closeThread(): void {
    openThread = null;
  }

  const firstThreadRoot = $derived(
    displayMessages.find(
      (message) =>
        Boolean(message.eventId) &&
        !message.pending &&
        ((message.replyCount ?? 0) > 0 || Boolean(message.rootEventId)),
    ) ?? null,
  );
  const canOpenThreadShortcut = $derived(
    Boolean(selected && selected.source !== 'agent' && !openThread && firstThreadRoot),
  );

  function openFirstAvailableThread(): void {
    if (!canOpenThreadShortcut || !firstThreadRoot) return;
    handleOpenDmThread(firstThreadRoot.rootEventId ?? firstThreadRoot.eventId);
  }

  // A reply landed (or the thread loaded) — bump the matching root message's
  // live reply-count in the DM message list so its affordance stays current.
  function handleThreadReplyCount(rootEventId: string, replyCount: number): void {
    messages = messages.map((m) =>
      m.rootEventId === rootEventId || m.eventId === rootEventId
        ? { ...m, rootEventId: m.rootEventId ?? m.eventId, replyCount }
        : m,
    );
  }

  // Handle a successful compose send. On a connection-requested (202) result the
  // message is rendered optimistically as a Pending bubble and the right pane
  // switches to that pending conversation; on a delivered (200) result we open
  // the normal thread for the recipient. The `dm:request-update` event that
  // flips Pending→active is consumed in US-011 — here we only render the Pending
  // state from the send response.
  function handleComposeSent(result: ComposeSendResult): void {
    invalidateDmWork();
    composing = false;
    const r = result.recipient;
    const peer: Contact = {
      personUid: r.personUid ?? `email:${r.email}`,
      email: r.email,
      displayName: r.displayName ?? r.email,
      companyUid: null,
      source: null,
      lastMessageAt: new Date().toISOString(),
    };
    selectedChannel = null;
    selectedRequest = null;
    selectedShareEvents = [];
    openThread = null;
    selected = peer;
    threadError = null;
    sendError = null;

    if (result.pending) {
      // 202 — held behind a connection request. Render the just-sent message as
      // a Pending bubble; do NOT load a thread (there isn't one yet).
      loadingThread = false;
      messages = [
        {
          eventId: `pending-${Date.now()}`,
          fromPersonUid: 'me',
          fromEmail: '',
          fromDisplayName: 'You',
          body: result.body,
          details: null,
          prompt: null,
          createdAt: new Date().toISOString(),
          direction: 'out',
          pending: true,
          pendingLabel: `Pending — waiting for ${displayLabel(peer)} to accept`,
        },
      ];
    } else {
      // 200 — delivered to an active connection. Open the normal thread (if the
      // recipient resolved to a real personUid); otherwise show the optimistic
      // message until the next poll.
      if (r.personUid) {
        void selectContact(peer);
      } else {
        loadingThread = false;
        messages = [
          {
            eventId: `local-${Date.now()}`,
            fromPersonUid: 'me',
            fromEmail: '',
            fromDisplayName: 'You',
            body: result.body,
            details: null,
            prompt: null,
            createdAt: new Date().toISOString(),
            direction: 'out',
          },
        ];
      }
    }
    // A brand-new conversation may now exist server-side; refresh the rail.
    void loadContacts();
  }

  function displayLabel(c: Contact): string {
    return humanPersonLabel(c);
  }

  function contactSubline(c: Contact): string | null {
    return contactPreviewText(c) ?? c.email?.trim() ?? null;
  }

  // The conversation rail is intentionally room-focused: DMs, group DMs, and
  // channels. Requests and shares still hydrate the activity surface and main
  // pane, but do not crowd this Slack-like navigation list with previews.
  type RailItem =
    | { kind: 'dm'; key: string; time: number; contact: Contact }
    | { kind: 'channel'; key: string; time: number; channel: Channel; unread: number }
    | { kind: 'request'; key: string; time: number; request: DmRequest }
    | { kind: 'share'; key: string; time: number; share: ShareEvent };

  function parseRailTime(iso: string | null | undefined): number {
    const t = Date.parse(iso ?? '');
    return Number.isFinite(t) ? t : 0;
  }

  const railItems = $derived.by((): RailItem[] => {
    const items: RailItem[] = [];
    for (const row of mergeConversations(contacts, channels)) {
      if (row.contact) {
        const newestShare = sharesForPeer(shareHistory, row.contact).at(-1);
        if (newestShare && previewRepresentsShare(row.contact, newestShare)) {
          continue;
        }
        items.push({
          kind: 'dm',
          key: row.key,
          time: row.time,
          contact: row.contact,
        });
      } else if (row.channel) {
        items.push({
          kind: 'channel',
          key: row.key,
          time: row.time,
          channel: row.channel,
          unread: row.unread,
        });
      }
    }
    for (const request of requests) {
      items.push({
        kind: 'request',
        key: `req:${request.pairKey}`,
        time: parseRailTime(request.createdAt),
        request,
      });
    }
    for (const share of shareHistory) {
      items.push({
        kind: 'share',
        key: `share:${share.eventId}`,
        time: parseRailTime(share.createdAt),
        share,
      });
    }
    return items.sort(
      (a, b) => b.time - a.time || a.key.localeCompare(b.key),
    );
  });
  const RAIL_RENDER_BATCH = 60;
  let railQuery = $state('');
  let railVisibleCount = $state(RAIL_RENDER_BATCH);

  function railSearchText(item: RailItem): string {
    if (item.kind === 'dm') return `${displayLabel(item.contact)} ${contactSubline(item.contact) ?? ''}`;
    if (item.kind === 'channel') {
      return `${channelDisplayName(item.channel)} ${channelProvenance(item.channel, companyNameFor(item.channel, companyLabels))}`;
    }
    if (item.kind === 'request') return `${requestDisplayName(item.request)} connection request`;
    return `${shareRowLabel(item.share)} shared path ${item.share.paths.join(' ')}`;
  }

  const filteredRailItems = $derived.by(() => {
    const query = railQuery.trim().toLocaleLowerCase();
    const conversations = railItems.filter(
      (item) => item.kind === 'dm' || item.kind === 'channel',
    );
    if (!query) return conversations;
    return conversations.filter((item) => railSearchText(item).toLocaleLowerCase().includes(query));
  });
  const visibleRailItems = $derived(filteredRailItems.slice(0, railVisibleCount));
  const visibleDirectItems = $derived(
    visibleRailItems.filter(
      (item) => item.kind === 'dm' || (item.kind === 'channel' && item.channel.scope === 'group'),
    ),
  );
  const visibleChannelItems = $derived(
    visibleRailItems.filter((item) => item.kind === 'channel' && item.channel.scope !== 'group'),
  );
  const remainingRailItems = $derived(
    Math.max(0, filteredRailItems.length - visibleRailItems.length),
  );
  const railUnreadCount = $derived(
    Math.max(0, unreadSummary.unreadDms) +
      channels.reduce((total, channel) => total + Math.max(0, channel.unread ?? 0), 0) +
      Math.max(requests.length, Math.max(0, unreadSummary.pendingRequests)),
  );
  const activityUnreadCount = $derived(
    Math.max(0, unreadSummary.unreadDms) +
      Math.max(requests.length, Math.max(0, unreadSummary.pendingRequests)),
  );
  let openingActivity = $state(false);

  async function openMentionsAndActivity(): Promise<void> {
    if (openingActivity) return;
    openingActivity = true;
    try {
      await invoke('open_desktop_alt_window', { route: 'inbox' });
    } catch (err) {
      console.error('messages: open mentions and activity failed', err);
    } finally {
      openingActivity = false;
    }
  }

  $effect(() => {
    if (
      didAutoSelectConversation || loadingContacts || loadingChannels || selected ||
      selectedChannel || selectedRequest || selectedShareEvents.length > 0
    ) return;
    const unreadChannel = channels.find((channel) => (channel.unread ?? 0) > 0);
    const firstConversation = railItems.find(
      (item) => item.kind === 'dm' || item.kind === 'channel',
    );
    const target = unreadChannel
      ? ({ kind: 'channel', channel: unreadChannel } as const)
      : firstConversation;
    if (!target) return;
    didAutoSelectConversation = true;
    if (target.kind === 'channel') selectChannel(target.channel);
    else if (target.kind === 'dm') void selectContact(target.contact);
  });

  $effect(() => {
    // A completely reloaded source list should return to the bounded first
    // window. Live recency updates do not discard data; the explicit Show more
    // affordance keeps the full archive reachable.
    contacts.length;
    channels.length;
    requests.length;
    shareHistory.length;
    railQuery;
    railVisibleCount = RAIL_RENDER_BATCH;
  });

  function selectRequest(req: DmRequest): void {
    invalidateDmWork();
    selected = null;
    selectedChannel = null;
    openThread = null;
    selectedShareEvents = [];
    selectedRequest = req;
    messages = [];
    threadError = null;
    sendError = null;
    loadingThread = false;
  }

  function selectShare(share: ShareEvent): void {
    invalidateDmWork();
    selected = null;
    selectedChannel = null;
    openThread = null;
    selectedRequest = null;
    // Open every share from the same issuer in the payload pane (US-016
    // grouping) so older shares stay reachable.
    selectedShareEvents = sharesForPeer(shareHistory, {
      personUid: share.issuerPersonUid ?? '',
      email: share.issuerEmail,
    });
    if (selectedShareEvents.length === 0) selectedShareEvents = [share];
    messages = [];
    threadError = null;
    sendError = null;
    loadingThread = false;
  }

  function shareRowLabel(share: ShareEvent): string {
    return share.issuerDisplayName?.trim() || share.issuerEmail || 'Shared path';
  }

  function shareRowSubline(share: ShareEvent): string {
    return shareSummary(share);
  }

  function formatShareTime(share: ShareEvent): string | null {
    const date = new Date(share.createdAt);
    if (Number.isNaN(date.getTime())) return null;
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (date.getTime() >= startToday) {
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function formatRequestTime(req: DmRequest): string | null {
    const date = new Date(req.createdAt);
    if (Number.isNaN(date.getTime())) return null;
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (date.getTime() >= startToday) {
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function channelActivityAt(channel: Channel): string | null {
    if (channel.lastActivityAt) return channel.lastActivityAt;
    if (channel.lastMessageAt) return channel.lastMessageAt;
    if (channel.arrivedAt && Number.isFinite(channel.arrivedAt)) {
      return new Date(channel.arrivedAt).toISOString();
    }
    return channel.createdAt ?? null;
  }

  function formatChannelTime(channel: Channel): string | null {
    const value = channelActivityAt(channel);
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;

    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startYesterday = startToday - 24 * 60 * 60 * 1000;
    const time = date.getTime();

    if (time >= startToday) {
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
    if (time >= startYesterday) return 'Yesterday';
    if (date.getFullYear() === now.getFullYear()) {
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function channelProvenance(channel: Channel, company: string | null): string {
    if (channel.scope === 'group') {
      const memberCount = channel.memberCount ?? channel.members?.length ?? 0;
      return memberCount > 0
        ? `Group DM · ${memberCount} ${memberCount === 1 ? 'person' : 'people'}`
        : 'Group DM';
    }
    if (company) return `Channel · ${company}`;
    if (channel.scope === 'personal') return 'Personal channel';
    return 'Channel';
  }

  function requestSubline(req: DmRequest): string {
    const msg = req.message?.trim();
    if (msg) return msg;
    if (req.sharedCompany?.trim()) return `Also in ${req.sharedCompany.trim()}`;
    return 'Wants to connect';
  }

  function formatContactTime(c: Contact): string | null {
    const value = contactPreviewAt(c);
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;

    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startYesterday = startToday - 24 * 60 * 60 * 1000;
    const time = date.getTime();

    if (time >= startToday) {
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
    if (time >= startYesterday) return 'Yesterday';
    if (date.getFullYear() === now.getFullYear()) {
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function applyContactPreview(personUid: string, preview: {
    body: string;
    createdAt: string | null;
    direction: string | null;
  }): void {
    // Never regress a newer preview (e.g. the "Shared a file" share preview)
    // with an older DM preview loaded when the thread opens.
    const current = contacts.find((c) => c.personUid === personUid);
    const currentAt = Date.parse(current?.previewAt ?? '') || 0;
    const nextAt = Date.parse(preview.createdAt ?? '') || 0;
    if (current && currentAt > nextAt) return;
    contacts = sortContactsByRecentActivity(
      contacts.map((contact) =>
        contact.personUid === personUid
          ? {
              ...contact,
              previewBody: preview.body,
              previewAt: preview.createdAt ?? contact.previewAt ?? contact.lastMessageAt ?? null,
              previewDirection: preview.direction,
              lastMessageAt: preview.createdAt ?? contact.lastMessageAt ?? null,
            }
          : contact,
      ),
    );
    noteContactMutation(personUid);
  }

  function noteContactMutation(personUid: string): void {
    contactMutationRevision += 1;
    contactMutationRevisions.set(personUid, contactMutationRevision);
  }

  function mergeContactMutations(
    snapshot: Contact[],
    afterRevision: number,
  ): Contact[] {
    if (contactMutationRevision === afterRevision) return snapshot;
    const merged = new Map(snapshot.map((contact) => [contact.personUid, contact]));
    for (const contact of contacts) {
      if ((contactMutationRevisions.get(contact.personUid) ?? 0) > afterRevision) {
        merged.set(contact.personUid, contact);
      }
    }
    return sortContactsByRecentActivity([...merged.values()]);
  }

  function dmEventTime(dm: DmEvent): number {
    const t = Date.parse(dm.createdAt);
    return Number.isNaN(t) ? 0 : t;
  }

  function rememberLiveInbound(dms: DmEvent[]): void {
    for (const dm of dms) {
      const list = liveInboundByPeer.get(dm.fromPersonUid) ?? [];
      if (!list.some((item) => item.eventId === dm.eventId)) {
        list.push(dm);
      }
      list.sort((a, b) => dmEventTime(a) - dmEventTime(b));
      if (list.length > LIVE_INBOUND_BACKFILL_LIMIT) {
        list.splice(0, list.length - LIVE_INBOUND_BACKFILL_LIMIT);
      }
      liveInboundByPeer.set(dm.fromPersonUid, list);
    }
  }

  function inboundToThreadMessage(dm: DmEvent): ThreadMessage {
    return {
      eventId: dm.eventId,
      fromPersonUid: dm.fromPersonUid,
      fromEmail: dm.fromEmail,
      fromDisplayName: dm.fromDisplayName,
      body: dm.body,
      details: dm.details ?? null,
      prompt: dm.prompt ?? null,
      createdAt: dm.createdAt,
      direction: 'in',
    };
  }

  function appendLiveInbound(base: ThreadMessage[], peerUid: string): ThreadMessage[] {
    return appendInboundBatch(
      base,
      liveInboundByPeer.get(peerUid) ?? [],
      peerUid,
      inboundToThreadMessage,
    );
  }

  function updateContactPreviewsFromInbound(dms: DmEvent[]): void {
    const latestByPeer = new Map<string, DmEvent>();
    for (const dm of dms) {
      const prev = latestByPeer.get(dm.fromPersonUid);
      if (!prev || dmEventTime(dm) >= dmEventTime(prev)) {
        latestByPeer.set(dm.fromPersonUid, dm);
      }
    }
    if (latestByPeer.size === 0) return;

    const byPerson = new Map(contacts.map((contact) => [contact.personUid, contact]));
    for (const [personUid, dm] of latestByPeer) {
      const existing = byPerson.get(personUid);
      byPerson.set(personUid, {
        personUid,
        email: dm.fromEmail,
        displayName: dm.fromDisplayName || dm.fromEmail,
        companyUid: existing?.companyUid ?? null,
        source: existing?.source ?? 'realtime',
        ...existing,
        lastMessageAt: dm.createdAt || existing?.lastMessageAt || null,
        previewBody: dm.body,
        previewAt: dm.createdAt || existing?.previewAt || existing?.lastMessageAt || null,
        previewDirection: 'in',
      });
      noteContactMutation(personUid);
    }
    contacts = sortContactsByRecentActivity(
      [...byPerson.values()].map((contact) => {
        const dm = latestByPeer.get(contact.personUid);
        if (!dm) return contact;
        return {
          ...contact,
          lastMessageAt: dm.createdAt || contact.lastMessageAt || null,
          previewBody: dm.body,
          previewAt: dm.createdAt || contact.previewAt || contact.lastMessageAt || null,
          previewDirection: 'in',
        };
      }),
    );
  }

  function applyLiveInbound(dms: DmEvent[]): void {
    if (dms.length === 0) return;
    rememberLiveInbound(dms);
    updateContactPreviewsFromInbound(dms);

    if (!selected || selected.source === 'agent') return;
    const next = appendLiveInbound(messages, selected.personUid);
    if (next !== messages) {
      messages = next;
    }
  }

  function shouldHydratePreview(c: Contact): boolean {
    if (c.source === 'agent' || c.personUid.startsWith('email:')) return false;
    if (contactPreviewText(c)) return false;
    return Boolean(contactPreviewAt(c));
  }

  async function hydrateContactPreviews(seed: Contact[]): Promise<void> {
    const run = ++previewHydrationRun;
    const queue = seed.filter(shouldHydratePreview).slice(0, PREVIEW_HYDRATION_LIMIT);
    const workerCount = Math.min(4, queue.length);
    if (workerCount === 0) return;

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (queue.length > 0) {
          if (run !== previewHydrationRun) return;
          const contact = queue.shift();
          if (!contact) return;
          try {
            const resp = await invoke<ThreadResponse>('fetch_dm_thread', {
              withPersonUid: contact.personUid,
              limit: 1,
            });
            const preview = previewFromMessages(resp.messages ?? []);
            if (preview && run === previewHydrationRun) {
              applyContactPreview(contact.personUid, preview);
            }
          } catch (err) {
            console.error('messages: preview hydration failed', contact.personUid, err);
          }
        }
      }),
    );
  }

  async function loadContacts(): Promise<void> {
    const generation = ++contactsLoadGeneration;
    const mutationRevision = contactMutationRevision;
    loadingContacts = true;
    contactsError = null;
    try {
      const [resp, history] = await Promise.all([
        invoke<ContactsResponse>('list_contacts'),
        loadContactHistoryEvents(),
      ]);
      if (generation !== contactsLoadGeneration) return;
      shareHistory = history.shares;
      // Overlay "Shared a file" previews for contacts whose newest item is a
      // share (before sorting, so the share recency bumps the row up).
      const nextContacts = mergeContactMutations(
        sortContactsByRecentActivity(
          applySharePreviews(
            mergeContactPreviews(resp.contacts ?? [], history.events),
            history.shares,
          ),
          history.events,
        ),
        mutationRevision,
      );
      contacts = nextContacts;
      void hydrateContactPreviews(nextContacts);
    } catch (err) {
      if (generation !== contactsLoadGeneration) return;
      contactsError = typeof err === 'string' ? err : 'Could not load conversations';
      contacts = [];
      console.error('messages: list_contacts failed', err);
    } finally {
      if (generation === contactsLoadGeneration) loadingContacts = false;
    }
  }

  async function loadContactHistoryEvents(): Promise<{
    events: ConversationEventRecencyFields[];
    shares: ShareEvent[];
  }> {
    try {
      const history = await invoke<NotificationHistoryResponse>('fetch_notification_history', {
        limit: 200,
      });
      return {
        events: history.dms ?? [],
        shares: history.shares ?? [],
      };
    } catch (err) {
      console.error('messages: fetch_notification_history failed', err);
      return { events: [], shares: [] };
    }
  }

  async function loadUnreadSummary(): Promise<void> {
    const generation = ++unreadSummaryLoadGeneration;
    try {
      const summary = await invoke<UnreadSummary>('get_unread_summary');
      if (generation !== unreadSummaryLoadGeneration) return;
      unreadSummary = {
        unreadDms: Math.max(0, summary?.unreadDms ?? 0),
        pendingRequests: Math.max(0, summary?.pendingRequests ?? 0),
      };
    } catch (err) {
      // Non-fatal — the rail still renders.
      console.error('messages: get_unread_summary failed', err);
    }
  }

  function recordRequestMutation(
    pairKey: string,
    request: DmRequest | null,
  ): void {
    requestMutationRevision += 1;
    requestMutations.set(pairKey, {
      revision: requestMutationRevision,
      request,
    });
  }

  function mergeRequestMutations(
    snapshot: DmRequest[],
    afterRevision: number,
  ): DmRequest[] {
    if (requestMutationRevision === afterRevision) return snapshot;
    const merged = new Map(snapshot.map((request) => [request.pairKey, request]));
    for (const [pairKey, mutation] of requestMutations) {
      if (mutation.revision <= afterRevision) continue;
      if (mutation.request) merged.set(pairKey, mutation.request);
      else merged.delete(pairKey);
    }
    return [...merged.values()];
  }

  async function loadRequests(): Promise<void> {
    const generation = ++requestsLoadGeneration;
    const mutationRevision = requestMutationRevision;
    loadingRequests = true;
    requestsError = null;
    try {
      const resp = await invoke<RequestsResponse>('list_dm_requests');
      let next = (resp.requests ?? []).map((request) =>
        enrichRequestFromContacts(request, contacts),
      );
      if (next.some((request) => !requestHasHumanLabel(request))) {
        const response = await invoke<ContactsResponse>('list_contacts');
        next = next.map((request) =>
          enrichRequestFromContacts(request, response.contacts ?? []),
        );
      }
      if (generation !== requestsLoadGeneration) return;
      requests = mergeRequestMutations(next, mutationRevision);
    } catch (err) {
      if (generation !== requestsLoadGeneration) return;
      requestsError =
        typeof err === 'string' ? err : 'Could not load connection requests';
      requests = [];
      console.error('messages: list_dm_requests failed', err);
    } finally {
      if (generation === requestsLoadGeneration) loadingRequests = false;
    }
  }

  function recordChannelMutation(channel: Channel): void {
    channelMutationRevision += 1;
    channelMutations.set(channel.channelId, {
      revision: channelMutationRevision,
      channel,
    });
  }

  function mergeChannelMutations(
    snapshot: Channel[],
    afterRevision: number,
  ): Channel[] {
    if (channelMutationRevision === afterRevision) return snapshot;
    let merged = snapshot;
    for (const mutation of channelMutations.values()) {
      if (mutation.revision > afterRevision) {
        merged = upsertChannel(merged, mutation.channel);
      }
    }
    return merged;
  }

  async function loadChannels(): Promise<void> {
    const generation = ++channelsLoadGeneration;
    const mutationRevision = channelMutationRevision;
    loadingChannels = true;
    channelsError = null;
    try {
      const resp = await invoke<ChannelsResponse | null>('list_channels');
      if (generation !== channelsLoadGeneration) return;
      channels = mergeChannelMutations(resp?.channels ?? [], mutationRevision);
    } catch (err) {
      if (generation !== channelsLoadGeneration) return;
      channelsError = typeof err === 'string' ? err : 'Could not load channels';
      channels = [];
      console.error('messages: list_channels failed', err);
    } finally {
      if (generation === channelsLoadGeneration) loadingChannels = false;
    }
  }

  async function retryChannels(): Promise<void> {
    if (retryingChannels) return;
    retryingChannels = true;
    try {
      await loadChannels();
    } finally {
      retryingChannels = false;
    }
  }

  async function loadCompanyLabels(): Promise<void> {
    try {
      const list = await invoke<MembershipRow[]>('meetings_list_memberships');
      companyLabels = (list ?? [])
        .filter((m) => m.status === 'active')
        .map((m) => ({ companyUid: m.companyUid, companyName: m.companyName }));
    } catch (err) {
      // Non-fatal — group headers fall back to companyUid / the channel's own
      // companyName.
      console.error('messages: meetings_list_memberships failed', err);
    }
  }

  async function loadConfig(): Promise<void> {
    try {
      const cfg = await invoke<AppConfig>('get_config');
      selfPersonUid = cfg?.personUid ?? null;
      hqFolderPath = cfg?.hqFolderPath ?? '';
      companySlug = cfg?.companySlug ?? null;
    } catch (err) {
      // Non-fatal — the roster degrades to server-enforced owner gating, and
      // agent handoff simply omits the folder until config loads.
      console.error('messages: get_config failed', err);
    }
  }

  function selectChannel(c: Channel): void {
    invalidateDmWork();
    selectedChannel = c;
    // Opening a channel clears DM / request / share selection so the pane
    // shows this channel.
    selected = null;
    selectedRequest = null;
    selectedShareEvents = [];
    // Switching channels closes any open thread (it belonged to the old channel).
    openThread = null;
    // Opening a channel optimistically clears its rail unread; ChannelView also
    // calls mark_channel_read server-side.
    channels = clearChannelUnread(channels, c.channelId);
    const cleared = channels.find((channel) => channel.channelId === c.channelId);
    if (cleared) recordChannelMutation(cleared);
  }

  function openCreateChannel(companyUid: string | null): void {
    createPresetCompany = companyUid;
    creatingGroupDm = false;
    creatingChannel = true;
  }

  function openCreateGroupDm(): void {
    createPresetCompany = null;
    creatingGroupDm = true;
    creatingChannel = true;
  }

  function handleChannelCreated(channel: Channel): void {
    creatingChannel = false;
    channels = upsertChannel(channels, channel);
    recordChannelMutation(channel);
    selectChannel(channel);
  }

  // ChannelView patched the channel's metadata (joined, member count) — reflect
  // it in the rail + keep the selected reference fresh.
  function handleChannelChange(channel: Channel): void {
    channels = upsertChannel(channels, channel);
    recordChannelMutation(channel);
    if (selectedChannel?.channelId === channel.channelId) {
      selectedChannel = channel;
    }
  }

  function handleChannelRead(channelId: string): void {
    channels = clearChannelUnread(channels, channelId);
    const channel = channels.find((item) => item.channelId === channelId);
    if (channel) recordChannelMutation(channel);
  }

  // A request card resolved (Accept / Decline / Block succeeded). Prune it from
  // activity state. On Accept, the held first message becomes a live thread —
  // open the standard <Conversation> with the requester so the card is replaced
  // by the thread.
  function handleRequestResolved(req: DmRequest, action: RequestAction): void {
    requests = removeRequest(requests, req.pairKey);
    recordRequestMutation(req.pairKey, null);
    if (selectedRequest?.pairKey === req.pairKey) selectedRequest = null;
    if (action === 'accept') {
      const peer: Contact = {
        personUid: req.fromPersonUid,
        email: req.fromEmail,
        displayName: req.fromDisplayName,
        companyUid: null,
        source: 'request',
        lastMessageAt: req.createdAt,
      };
      void selectContact(peer);
      // The new connection now appears as a contact — refresh the rail.
      void loadContacts();
    }
  }

  // Open a deep-linked conversation ("Message the sharer"). A resolved
  // personUid opens the normal thread; a legacy target with only an email
  // opens an empty conversation whose sends route via `send_dm_to_email`.
  function openConversationTarget(t: ConversationTarget): void {
    const uid = t.personUid?.trim() ?? '';
    const email = t.email?.trim() ?? '';
    if (!uid && !email) return;
    const existing = contacts.find(
      (c) =>
        (uid && c.personUid === uid) ||
        (email && (c.email ?? '').trim().toLowerCase() === email.toLowerCase()),
    );
    const peer: Contact = existing ?? {
      personUid: uid || `email:${email}`,
      email,
      displayName: t.displayName?.trim() || email,
      companyUid: null,
      source: null,
    };
    if (peer.personUid.startsWith('email:')) {
      invalidateDmWork();
      selected = peer;
      selectedChannel = null;
      selectedRequest = null;
      selectedShareEvents = [];
      openThread = null;
      messages = [];
      threadError = null;
      sendError = null;
      loadingThread = false;
    } else {
      void selectContact(peer);
    }
  }

  function invalidateDmWork(): void {
    threadLoadGeneration += 1;
    dmSendGeneration += 1;
    loadingThread = false;
    sending = false;
    dmOutboundById = new Map();
  }

  async function selectContact(c: Contact): Promise<void> {
    const generation = ++threadLoadGeneration;
    dmSendGeneration += 1;
    sending = false;
    dmOutboundById = new Map();
    selected = c;
    // Opening a DM clears channel / request / share selection so the pane shows
    // this conversation.
    selectedChannel = null;
    selectedRequest = null;
    selectedShareEvents = [];
    messages = [];
    threadError = null;
    sendError = null;
    // Switching conversations closes any open thread (it belonged to the old one).
    openThread = null;
    loadingThread = true;
    try {
      const resp = await invoke<ThreadResponse>('fetch_dm_thread', {
        withPersonUid: c.personUid,
      });
      if (
        generation !== threadLoadGeneration ||
        selected?.personUid !== c.personUid
      ) return;
      // Server returns newest-first; render chronologically (oldest → newest).
      messages = appendLiveInbound([...(resp.messages ?? [])].reverse(), c.personUid);
      const preview = previewFromMessages(resp.messages ?? []);
      if (preview) applyContactPreview(c.personUid, preview);
    } catch (err) {
      if (
        generation !== threadLoadGeneration ||
        selected?.personUid !== c.personUid
      ) return;
      threadError = typeof err === 'string' ? err : 'Could not load this conversation';
      messages = [];
      console.error('messages: fetch_dm_thread failed', err);
    } finally {
      if (
        generation === threadLoadGeneration &&
        selected?.personUid === c.personUid
      ) {
        loadingThread = false;
      }
    }
  }

  function openAgentThread(): void {
    invalidateDmWork();
    selectedChannel = null;
    selectedRequest = null;
    selectedShareEvents = [];
    selected = {
      personUid: 'agent:self',
      email: '',
      displayName: 'Your agent',
      companyUid: null,
      source: 'agent',
    };
    messages = [
      {
        eventId: 'agent-status',
        fromPersonUid: 'agent:self',
        fromEmail: '',
        fromDisplayName: 'Your agent',
        body: 'Send me a prompt here and I will open a focused Claude Code session in your HQ workspace.',
        details: null,
        prompt: null,
        createdAt: new Date().toISOString(),
        direction: 'in',
      },
    ];
    threadError = null;
    sendError = null;
    loadingThread = false;
    openThread = null;
  }

  function buildAgentPrompt(text: string): string {
    return [
      hqSkillMarkdownLink('startwork', hqFolderPath),
      '',
      'Continue from the HQ desktop Messages window.',
      '',
      text,
    ].join('\n');
  }

  function dmSendIsCurrent(peer: Contact, generation: number): boolean {
    return (
      generation === dmSendGeneration &&
      selected?.personUid === peer.personUid
    );
  }

  async function sendAgentPrompt(
    text: string,
    peer: Contact,
    generation: number,
  ): Promise<void> {
    const folder = hqFolderPath;
    const basePrompt = buildAgentPrompt(text);
    const prompt = await buildClaudePromptWithSkillCatalog(basePrompt, companySlug);
    const url = buildClaudeCodeUrl({ folder, prompt });
    await invoke('open_claude_code_link', { url });
    if (!dmSendIsCurrent(peer, generation)) return;
    messages = [
      ...messages,
      {
        eventId: `agent-local-${messages.length}-${text.length}`,
        fromPersonUid: 'me',
        fromEmail: '',
        fromDisplayName: 'You',
        body: text,
        details: null,
        prompt,
        createdAt: new Date().toISOString(),
        direction: 'out',
      },
      {
        eventId: `agent-opened-${Date.now()}`,
        fromPersonUid: 'agent:self',
        fromEmail: '',
        fromDisplayName: 'Your agent',
        body: 'Opened in Claude Code.',
        details: folder ? `Workspace: ${folder}` : null,
        prompt,
        createdAt: new Date().toISOString(),
        direction: 'in',
      },
    ];
  }

  async function sendReply(text: string): Promise<void> {
    if (!text || sending || !selected) return;
    const peer = selected;
    const generation = ++dmSendGeneration;
    sendError = null;

    if (peer.source === 'agent') {
      sending = true;
      try {
        await sendAgentPrompt(text, peer, generation);
      } catch (err) {
        if (!dmSendIsCurrent(peer, generation)) return;
        sendError =
          typeof err === 'string' ? err : 'Failed to open Claude Code';
        console.error('messages: send failed', err);
      } finally {
        if (dmSendIsCurrent(peer, generation)) sending = false;
      }
      return;
    }

    if (peer.personUid.startsWith('email:')) {
      // Unresolved (email-only) peer — connection-request path may hold the
      // message (202). Keep the pending chip rather than the send machine.
      sending = true;
      try {
        const sentAt = new Date().toISOString();
        const outcome = await invoke<{ state: string }>('send_dm_to_email', {
          toEmail: peer.email,
          toPersonUid: null,
          body: text,
        });
        if (!dmSendIsCurrent(peer, generation)) return;
        const pending = outcome?.state === 'connectionRequested';
        messages = [
          ...messages,
          {
            eventId: `${pending ? 'pending' : 'local'}-${messages.length}-${text.length}`,
            fromPersonUid: 'me',
            fromEmail: '',
            fromDisplayName: 'You',
            body: text,
            details: null,
            prompt: null,
            createdAt: sentAt,
            direction: 'out',
            pending,
            pendingLabel: pending
              ? `Pending — waiting for ${displayLabel(peer)} to accept`
              : null,
          },
        ];
      } catch (err) {
        if (!dmSendIsCurrent(peer, generation)) return;
        sendError = typeof err === 'string' ? err : 'Failed to send message';
        console.error('messages: send failed', err);
      } finally {
        if (dmSendIsCurrent(peer, generation)) sending = false;
      }
      return;
    }

    // 1:1 DM — same optimistic send machine as channels (Sending → Delivered /
    // Failed tap-to-retry). Do not fork a second state machine.
    const outbound = createOutboundMessage(text);
    const nextMap = new Map(dmOutboundById);
    nextMap.set(outbound.clientId, outbound);
    dmOutboundById = nextMap;
    messages = [
      ...messages,
      {
        eventId: outbound.clientId,
        fromPersonUid: 'me',
        fromEmail: '',
        fromDisplayName: 'You',
        body: outbound.body,
        details: null,
        prompt: null,
        createdAt: outbound.createdAt,
        direction: 'out',
        sendStatus: 'sending',
      },
    ];
    sending = true;

    const result = await runSend(outbound, {
      send: async (msgBody) => {
        // Conversation switched mid-flight — abandon retries without another
        // network hop; UI already cleared this peer's timeline.
        if (!dmSendIsCurrent(peer, generation)) return;
        await invoke('send_dm', { toPersonUid: peer.personUid, body: msgBody });
      },
      onChange: (msg) => {
        // Drop late transitions after the user switched conversations so we
        // never re-pollute Bob's outbound map with Alice's clientId.
        if (!dmSendIsCurrent(peer, generation)) return;
        const map = new Map(dmOutboundById);
        map.set(msg.clientId, { ...msg });
        dmOutboundById = map;
        patchDmOutboundRow(msg);
      },
    });

    if (dmSendIsCurrent(peer, generation)) {
      sending = false;
      sendError = null;
      if (result.status === 'delivered') {
        contacts = sortContactsByRecentActivity(
          contacts.map((contact) =>
            contact.personUid === peer.personUid
              ? {
                  ...contact,
                  lastMessageAt: outbound.createdAt,
                  previewBody: outbound.body,
                  previewAt: outbound.createdAt,
                  previewDirection: 'out',
                }
              : contact,
          ),
        );
        noteContactMutation(peer.personUid);
      }
    }
  }

  async function retryFailedDmSend(eventId: string): Promise<void> {
    const outbound = dmOutboundById.get(eventId);
    if (!outbound || outbound.status !== 'failed' || !selected) return;
    const peer = selected;
    if (peer.source === 'agent' || peer.personUid.startsWith('email:')) return;
    const generation = ++dmSendGeneration;
    sendError = null;
    sending = true;
    await retrySend(outbound, {
      send: async (msgBody) => {
        await invoke('send_dm', { toPersonUid: peer.personUid, body: msgBody });
      },
      onChange: (msg) => {
        if (!dmSendIsCurrent(peer, generation)) return;
        const map = new Map(dmOutboundById);
        map.set(msg.clientId, { ...msg });
        dmOutboundById = map;
        patchDmOutboundRow(msg);
      },
    });
    if (dmSendIsCurrent(peer, generation)) {
      sending = false;
      sendError = null;
    }
  }

  $effect(() => {
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;

    function retainUnlistener(unlisten: UnlistenFn): void {
      const safe = safeUnlisten(unlisten);
      if (disposed) {
        safe();
        return;
      }
      unlisteners.push(safe);
    }

    function registerListener<T>(
      event: string,
      handler: EventCallback<T>,
    ): void {
      void listen<T>(event, handler)
        .then(retainUnlistener)
        .catch((error: unknown) => {
          if (!disposed) {
            console.error(`messages: failed to listen for ${event}`, error);
          }
        });
    }

    // A new DM may arrive while this window is open — refresh the contact list
    // (so a brand-new conversation appears) and the request count. The badge
    // reset is handled in Rust on messages_window_ready.
    registerListener<DmEvent[]>('dm:new-events', (e) => {
      applyLiveInbound(e.payload ?? []);
      void loadContacts();
      void loadUnreadSummary();
    });

    // A brand-new incoming connection request landed (US-011) — append it to the
    // activity state and unread count. Dedupe by
    // pairKey so a re-emit doesn't double-add.
    registerListener<DmRequest>('dm:request-new', (e) => {
      requests = addRequest(requests, e.payload);
      recordRequestMutation(e.payload.pairKey, e.payload);
    });

    // A pending request resolved elsewhere (accepted/declined/blocked, or pruned
    // by the poll diff). Drop it from activity state; clear the detail pane
    // when the open request is the one that left the set.
    registerListener<{ pairKey: string; state?: string }>(
      'dm:request-update',
      (e) => {
        requests = removeRequest(requests, e.payload.pairKey);
        recordRequestMutation(e.payload.pairKey, null);
        if (selectedRequest?.pairKey === e.payload.pairKey) {
          selectedRequest = null;
        }
      },
    );

    // A channel the caller is in has new activity (US-018). If it's the open
    // channel, ChannelView handles its own refresh; otherwise bump the rail
    // unread badge for that channel.
    registerListener<{ channelId: string; unread?: number }>(
      'channel:new-message',
      (e) => {
        const { channelId } = e.payload;
        if (selectedChannel?.channelId === channelId) return; // ChannelView owns it
        // Prefer the authoritative unread the poll computed; fall back to +1.
        if (typeof e.payload.unread === 'number') {
          channels = channels.map((c) =>
            c.channelId === channelId ? { ...c, unread: e.payload.unread } : c,
          );
        } else {
          channels = bumpChannelUnread(channels, channelId, 1);
        }
        const channel = channels.find((item) => item.channelId === channelId);
        if (channel) recordChannelMutation(channel);
      },
    );

    // Reactions on a message in the open DM conversation changed (US-025). The
    // controller ignores events for any scope other than its own, so this safely
    // no-ops when the open pane is a channel or nothing is selected.
    registerListener<ReactionEvent>('message:reaction', (e) => {
      dmReactions?.applyEvent(e.payload);
      // Share-scope events reconcile the inline share cards' reactions.
      shareReactions.applyEvent(e.payload);
    });

    // Deep link from the standalone-window path: `open_messages_window` with a
    // target stashes it in Rust and the ready-handshake (or an already-open
    // focus) emits it here.
    registerListener<ConversationTarget>('messages:open-conversation', (e) => {
      openConversationTarget(e.payload);
    });

    // Deep link from within the SAME desktop window (Notifications page →
    // Messages destination): the sender stashes the target and dispatches
    // hq:message-person; consume the stash whether we were mounted (event) or
    // mounted just after the navigation (initial take below).
    const onMessagePerson = () => {
      const t = takePendingConversation();
      if (t) openConversationTarget(t);
    };
    window.addEventListener(MESSAGE_PERSON_EVENT, onMessagePerson);
    retainUnlistener(() =>
      window.removeEventListener(MESSAGE_PERSON_EVENT, onMessagePerson),
    );
    onMessagePerson();

    // Chat sidebar (US-003) → open a channel in the embedded Messages shell.
    const openPendingChannel = () => {
      const channelId = takePendingChannel();
      if (!channelId) return;
      const match = channels.find((c) => c.channelId === channelId);
      if (match) selectChannel(match);
      else {
        // Channel list may still be loading — retry after the next channels load.
        void loadChannels().then(() => {
          const late = channels.find((c) => c.channelId === channelId);
          if (late) selectChannel(late);
        });
      }
    };
    const onOpenChannel = () => openPendingChannel();
    window.addEventListener(OPEN_CHANNEL_EVENT, onOpenChannel);
    retainUnlistener(() =>
      window.removeEventListener(OPEN_CHANNEL_EVENT, onOpenChannel),
    );
    openPendingChannel();

    // Chat sidebar "Connection requests" row → open shared DmRequestCard.
    const openPendingDmRequests = () => {
      const pending = takePendingDmRequests();
      if (!pending) return;
      const openFirstOrMatch = (list: DmRequest[]) => {
        if (list.length === 0) return;
        const match = pending.pairKey
          ? list.find((r) => r.pairKey === pending.pairKey)
          : null;
        selectRequest(match ?? list[0]!);
      };
      if (requests.length > 0) {
        openFirstOrMatch(requests);
        return;
      }
      void loadRequests().then(() => openFirstOrMatch(requests));
    };
    const onOpenDmRequests = () => openPendingDmRequests();
    window.addEventListener(OPEN_DM_REQUESTS_EVENT, onOpenDmRequests);
    retainUnlistener(() =>
      window.removeEventListener(OPEN_DM_REQUESTS_EVENT, onOpenDmRequests),
    );
    openPendingDmRequests();

    // A brand-new channel/invite appeared, or a channel's metadata changed.
    // Upsert it into the rail so it shows live without a manual refresh.
    registerListener<Channel>('channel:updated', (e) => {
      channels = upsertChannel(channels, e.payload);
      recordChannelMutation(e.payload);
      if (selectedChannel?.channelId === e.payload.channelId) {
        selectedChannel = e.payload;
      }
    });

    // Ready-handshake: both render modes clear the unread badge once Messages is
    // visible. Only the standalone mode may show/focus the native window.
    void loadContacts();
    void loadRequests();
    void loadUnreadSummary();
    void loadChannels();
    void loadCompanyLabels();
    void loadConfig();
    void invoke(embedded ? 'mark_messages_viewed' : 'messages_window_ready');

    return () => {
      disposed = true;
      for (const fn of unlisteners.splice(0)) fn();
      shareReactions.dispose();
    };
  });
</script>

<div class="messages-window" class:embedded data-window="messages">
  <!-- DESKTOP-002: room rail (glass) + naked main canvas. The rail owns
       orientation and compose; no People/Requests tabs or redundant page chrome. -->
  <aside class="rail" aria-label="Conversations">
    <header class="rail-header" data-tauri-drag-region>
      <div class="rail-heading">
        <h2>HQ</h2>
        {#if railUnreadCount > 0}
          <span>{railUnreadCount > 99 ? '99+' : railUnreadCount} unread</span>
        {/if}
      </div>
      <div class="primary-actions">
        <button
          class="new-message-btn"
          type="button"
          onclick={openCompose}
          title="New message"
          aria-label="New message"
          aria-haspopup="dialog"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 12.7 3.5 10l6.9-6.9a1.4 1.4 0 0 1 2 2L5.5 12l-2.5.7Z"></path>
            <path d="m9.5 4 2.5 2.5"></path>
          </svg>
        </button>
      </div>
    </header>

    <div class="rail-body">
      {#snippet dmRow(c: Contact)}
        {@const isActive =
          selected?.personUid === c.personUid &&
          !selectedRequest &&
          selectedShareEvents.length === 0}
        <li>
          <button
            class="contact-row"
            class:active={isActive}
            type="button"
            onclick={() => void selectContact(c)}
            title={contactSubline(c) ? `${displayLabel(c)} — ${contactSubline(c)}` : displayLabel(c)}
            aria-current={isActive ? 'page' : undefined}
            aria-busy={isActive && loadingThread}
            data-provenance="direct-message"
          >
            <IdentityMark kind="person" label={displayLabel(c)} size="small" />
            <span class="contact-meta">
              <span class="contact-top">
                <span class="contact-name">{displayLabel(c)}</span>
                {#if formatContactTime(c)}
                  <time class="contact-time" datetime={contactPreviewAt(c) ?? undefined}>
                    {formatContactTime(c)}
                  </time>
                {/if}
              </span>
            </span>
          </button>
        </li>
      {/snippet}

      {#snippet channelRow(ch: Channel)}
        {@const company = companyNameFor(ch, companyLabels)}
        {@const isGroupDm = ch.scope === 'group'}
        {@const isActive = selectedChannel?.channelId === ch.channelId}
        {@const activityAt = channelActivityAt(ch)}
        <li>
          <button
            class="contact-row channel-row"
            class:active={isActive}
            type="button"
            onclick={() => selectChannel(ch)}
            title={`${isGroupDm ? '' : '#'}${channelDisplayName(ch)}${
              company ? ` — ${company}` : ''
            }`}
            aria-current={isActive ? 'page' : undefined}
            data-provenance={isGroupDm ? 'group-dm' : 'channel'}
          >
            <IdentityMark
              kind={isGroupDm ? 'group' : 'channel'}
              label={channelDisplayName(ch)}
              members={(ch.members ?? []).map((member) => member.displayName)}
              privateChannel={ch.visibility === 'private'}
              size="small"
            />
            <span class="contact-meta">
              <span class="contact-top">
                <span class="contact-name">{channelDisplayName(ch)}</span>
                {#if (ch.unread ?? 0) > 0}
                  <span class="unread-badge" aria-label={`${ch.unread} unread`}>{ch.unread}</span>
                {/if}
                {#if formatChannelTime(ch)}
                  <time class="contact-time" datetime={activityAt ?? undefined}>
                    {formatChannelTime(ch)}
                  </time>
                {/if}
              </span>
            </span>
          </button>
        </li>
      {/snippet}

      {#snippet requestRow(req: DmRequest)}
        {@const isActive = selectedRequest?.pairKey === req.pairKey}
        <li>
          <button
            class="contact-row request-row"
            class:active={isActive}
            type="button"
            onclick={() => selectRequest(req)}
            title={`${requestDisplayName(req)} — connection request`}
            data-testid="request-rail-row"
            data-provenance="connection-request"
            aria-current={isActive ? 'page' : undefined}
          >
            <IdentityMark kind="person" label={requestDisplayName(req)} size="small" />
            <span class="contact-meta">
              <span class="contact-top">
                <span class="contact-name">{requestDisplayName(req)}</span>
                {#if formatRequestTime(req)}
                  <time class="contact-time" datetime={req.createdAt}>{formatRequestTime(req)}</time>
                {/if}
              </span>
              <span class="contact-sub">
                <span class="contact-provenance">Connection request</span>
                <span class="contact-separator" aria-hidden="true"> · </span>
                {requestSubline(req)}
              </span>
            </span>
          </button>
        </li>
      {/snippet}

      {#snippet shareRow(share: ShareEvent)}
        {@const firstPath = share.paths[0] ?? ''}
        {@const isActive = selectedShareEvents.some((e) => e.eventId === share.eventId)}
        <li>
          <button
            class="contact-row share-row"
            class:active={isActive}
            type="button"
            onclick={() => selectShare(share)}
            title={firstPath ? `${shareRowLabel(share)} — ${shareTitle(firstPath)}` : shareRowLabel(share)}
            data-testid="share-rail-row"
            data-provenance="shared-path"
            aria-current={isActive ? 'page' : undefined}
          >
            <IdentityMark kind="file" size="small" />
            <span class="contact-meta">
              <span class="contact-top">
                <span class="contact-name">{shareRowLabel(share)}</span>
                {#if formatShareTime(share)}
                  <time class="contact-time" datetime={share.createdAt}>{formatShareTime(share)}</time>
                {/if}
              </span>
              <span class="contact-sub">
                <span class="contact-provenance">Shared path</span>
                <span class="contact-separator" aria-hidden="true"> · </span>
                {shareRowSubline(share)}
              </span>
            </span>
          </button>
        </li>
      {/snippet}

      <label class="rail-search">
        <span aria-hidden="true">⌕</span>
        <input bind:value={railQuery} type="search" placeholder="Find a conversation" aria-label="Find a conversation" />
      </label>
      <nav class="rail-utility" aria-label="Message shortcuts">
        <button
          type="button"
          disabled={!canOpenThreadShortcut}
          onclick={openFirstAvailableThread}
        >
          <span class="utility-glyph" aria-hidden="true">☷</span>
          <span>Threads</span>
        </button>
        <button
          type="button"
          disabled={openingActivity}
          aria-busy={openingActivity}
          onclick={() => void openMentionsAndActivity()}
        >
          <span class="utility-glyph" aria-hidden="true">@</span>
          <span>{openingActivity ? 'Opening activity…' : 'Mentions & activity'}</span>
          {#if activityUnreadCount > 0}<b>{activityUnreadCount > 99 ? '99+' : activityUnreadCount}</b>{/if}
        </button>
      </nav>

      {#if (loadingContacts || loadingChannels) && !retryingChannels}
        <p class="rail-status">Loading conversations…</p>
      {:else if contactsError}
        <div class="rail-status rail-error" role="alert">
          <p>{contactsError}</p>
          <button
            type="button"
            class="rail-retry"
            onclick={() => loadContacts()}
            disabled={loadingContacts}
            aria-busy={loadingContacts}
          >{loadingContacts ? 'Retrying…' : 'Retry'}</button>
        </div>
      {:else if channelsError || retryingChannels}
        <div class="rail-status rail-error" role="alert">
          <p>{retryingChannels ? 'Retrying channels…' : channelsError}</p>
          <button
            type="button"
            class="rail-retry"
            onclick={retryChannels}
            disabled={retryingChannels}
            aria-busy={retryingChannels}
          >{retryingChannels ? 'Retrying…' : 'Retry'}</button>
        </div>
      {:else}
        {#if requestsError}
          <div class="rail-status rail-error" role="alert">
            <p>{requestsError}</p>
            <button
              type="button"
              class="rail-retry"
              onclick={() => loadRequests()}
              disabled={loadingRequests}
              aria-busy={loadingRequests}
            >{loadingRequests ? 'Retrying…' : 'Retry'}</button>
          </div>
        {/if}
        <div class="rail-section-heading">
          <span>Direct messages</span>
          <button type="button" onclick={openCreateGroupDm} aria-label="New group DM" aria-haspopup="dialog">+</button>
        </div>
        <ul class="contact-list compact-list">
          {#if !railQuery.trim() || 'your agent'.includes(railQuery.trim().toLocaleLowerCase())}
          <li>
            <button
              class="contact-row agent-row"
              class:active={selected?.source === 'agent'}
              type="button"
              onclick={openAgentThread}
              aria-current={selected?.source === 'agent' ? 'page' : undefined}
              data-provenance="agent"
            >
              <IdentityMark kind="agent" size="small" />
              <span class="contact-meta">
                <span class="contact-name">Your agent</span>
                <span class="contact-sub">
                  <span class="contact-provenance">Agent</span>
                  <span class="contact-separator" aria-hidden="true"> · </span>
                  Watching for work that needs you
                </span>
              </span>
            </button>
          </li>
          {/if}
          {#each visibleDirectItems as item (item.key)}
            {#if item.kind === 'dm'}
              {@render dmRow(item.contact)}
            {:else if item.kind === 'channel'}
              {@render channelRow(item.channel)}
            {/if}
          {/each}
        </ul>

        {#if visibleChannelItems.length > 0 || !railQuery.trim()}
          <div class="rail-section-heading">
            <span>Channels</span>
            <button type="button" onclick={() => openCreateChannel(null)} aria-label="New channel" aria-haspopup="dialog">+</button>
          </div>
          <ul class="contact-list compact-list">
            {#each visibleChannelItems as item (item.key)}
              {#if item.kind === 'channel'}{@render channelRow(item.channel)}{/if}
            {/each}
          </ul>
        {/if}

        {#if remainingRailItems > 0}
          <button
            type="button"
            class="rail-show-more"
            onclick={() =>
              (railVisibleCount = Math.min(
                filteredRailItems.length,
                railVisibleCount + RAIL_RENDER_BATCH,
              ))}
          >
            Show {Math.min(RAIL_RENDER_BATCH, remainingRailItems)} more
            <span>{visibleRailItems.length} of {filteredRailItems.length}</span>
          </button>
        {/if}
        {#if filteredRailItems.length === 0 && railQuery.trim()}
          <p class="rail-status">No conversations match “{railQuery.trim()}”.</p>
        {:else if railItems.length === 0}
          <p class="rail-status">No conversations yet.</p>
        {/if}
      {/if}
    </div>
  </aside>

  <!-- Naked main canvas: spacing + hairlines only — no liquid-glass chrome. -->
  <section class="pane" data-testid="messages-main-pane">
    {#if selectedRequest}
      <header class="pane-header">
        <div class="pane-title-stack">
          <h2>Connection request</h2>
          <span class="pane-sub">{requestDisplayName(selectedRequest)}</span>
        </div>
      </header>
      <div class="pane-request" data-testid="request-detail-pane">
        <DmRequestCard request={selectedRequest} onresolved={handleRequestResolved} />
      </div>
    {:else if selectedShareEvents.length > 0}
      <header class="pane-header">
        <div class="pane-title-stack">
          <h2>Shared path</h2>
          <span class="pane-sub">
            {selectedShareEvents[0]?.issuerDisplayName ?? 'Shared with you'}
          </span>
        </div>
      </header>
      <ShareMainPane events={selectedShareEvents} />
    {:else if selectedChannel}
      <ChannelView
        channel={selectedChannel}
        {selfPersonUid}
        onchannelchange={handleChannelChange}
        onread={handleChannelRead}
        onopenthread={handleOpenChannelThread}
        activeRootEventId={openThread?.scope === 'channel' ? openThread.rootEventId : null}
      />
    {:else if !selected}
      <div class="pane-empty">
        <p>Select a conversation to start messaging.</p>
      </div>
    {:else}
      <header class="pane-header" data-testid="dm-header">
        <div class="pane-title-stack">
          {#if selected.source === 'agent'}
            <h2>{displayLabel(selected)}</h2>
          {:else}
            <!-- Reduced chrome (US-011): "<Name> · direct message", no tabs/email. -->
            <h2 data-testid="dm-header-title">
              {displayLabel(selected)} · direct message
            </h2>
          {/if}
        </div>
      </header>
      <Conversation
        messages={displayMessages}
        showAuthors={false}
        loading={loadingThread}
        error={threadError}
        {sending}
        {sendError}
        placeholder={
          selected.source === 'agent'
            ? 'Ask your agent to work on something…'
            : `Message ${displayLabel(selected)}…`
        }
        onsend={sendReply}
        onretrysend={selected.source === 'agent' ? undefined : retryFailedDmSend}
        onopenthread={handleOpenDmThread}
        activeRootEventId={openThread?.scope === 'dm' ? openThread.rootEventId : null}
        reactions={selected.source === 'agent'
          ? {}
          : { ...(dmReactions?.map ?? {}), ...shareReactions.map }}
        ontogglereaction={selected.source === 'agent' ? undefined : toggleThreadReaction}
        onopenshareinclaude={openShareInClaude}
      />
    {/if}
  </section>

  {#if openThread}
    <section class="thread-column">
      <ThreadPanel
        rootEventId={openThread.rootEventId}
        scope={openThread.scope}
        channelId={openThread.channelId}
        withPersonUid={openThread.withPersonUid}
        title={openThread.title}
        showAuthors={openThread.showAuthors}
        onclose={closeThread}
        onreplycount={handleThreadReplyCount}
      />
    </section>
  {/if}

  {#if composing}
    <ComposeMessage onclose={() => (composing = false)} onsent={handleComposeSent} />
  {/if}

  {#if creatingChannel}
    <CreateChannel
      onclose={() => (creatingChannel = false)}
      oncreated={handleChannelCreated}
      presetCompanyUid={createPresetCompany}
      isGroupDm={creatingGroupDm}
    />
  {/if}
</div>

<style>
  /* DESKTOP-002 / DESKTOP-011: monochrome surfaces, five-size type ramp,
     hierarchy by weight + surface split, hairline borders. Liquid glass /
     room-list treatment ONLY on the navigation rail; the main thread and
     notification canvas stay naked (spacing + hairlines, no rounded outer
     chrome). Tokens from desktop-alt.css (data-window='messages'). */

  .messages-window {
    display: flex;
    width: 100vw;
    height: 100vh;
    box-sizing: border-box;
    background: var(--v4-ground, var(--bg-gradient));
    color: var(--fg);
    font-family: var(--font-sans);
    font-size: var(--type-body, var(--text-base));
    letter-spacing: -0.006em;
    overflow: hidden;
  }

  .messages-window.embedded {
    width: 100%;
    height: 100%;
    background: transparent;
  }

  /* ── Left rail ────────────────────────────────────────────────────────── */

  .rail {
    width: 282px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    /* Local separation only: the window/desktop canvas already owns the live
       material, so this rail must not stack another glass sheet over it. */
    background: color-mix(in srgb, var(--v4-text-1, var(--fg)) 4%, transparent);
    min-height: 0;
  }

  /* The rail header is wayfinding, not another boxed toolbar. */
  .rail-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-height: 52px;
    box-sizing: border-box;
    padding: 8px 16px 6px;
    flex-shrink: 0;
  }

  .rail-heading {
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .rail-heading h2 {
    margin: 0;
    color: var(--fg);
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.015em;
    line-height: 1.15;
  }

  .rail-heading span {
    color: var(--muted);
    font-size: var(--type-metadata, var(--text-micro));
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
  }

  .rail-header .primary-actions {
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }

  .rail-header .new-message-btn {
    flex: 0 0 auto;
  }

  .new-message-btn {
    flex-shrink: 0;
    border: 0;
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: 6px;
    background: transparent;
    color: var(--fg);
    font-family: var(--font-sans);
    padding: 0;
    cursor: pointer;
    transition: color 0.12s ease, opacity 0.12s ease;
  }

  .new-message-btn:hover {
    background: var(--row-hover);
    color: var(--fg);
  }

  .new-message-btn svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.4;
  }

  .new-message-btn:focus-visible {
    outline: 2px solid var(--border-strong);
    outline-offset: 1px;
  }

  .rail-body {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding: 0 10px 16px;
  }

  .rail-status {
    margin: var(--space-2) var(--space-3);
    font-size: var(--text-base);
    color: var(--muted);
  }

  .rail-error {
    color: var(--red);
  }

  /* A transient load failure (network blip) is recoverable — give it a Retry
     instead of a dead-end that forces the user to close and reopen the window.
     loadContacts/loadRequests are idempotent (they reset their error on entry). */
  .rail-error p {
    margin: 0 0 var(--space-1);
  }

  .rail-retry {
    border: 1px solid var(--border);
    background: var(--surface-raise);
    color: var(--fg);
    font-family: var(--font-sans);
    font-size: var(--text-micro);
    font-weight: 500;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background-color 0.12s ease, border-color 0.12s ease;
  }

  .rail-retry:hover {
    background: var(--row-hover);
    border-color: var(--border-strong);
  }

  .rail-retry:disabled {
    opacity: 0.58;
    cursor: wait;
  }

  .rail-retry:focus-visible {
    outline: 2px solid var(--border-strong);
    outline-offset: 1px;
  }

  .rail-search {
    height: 34px;
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0 2px 5px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: var(--v4-radius-button, 6px);
    background: color-mix(in srgb, var(--fg) 4%, transparent);
    color: var(--muted);
  }

  .rail-utility {
    display: grid;
    gap: 1px;
    padding: 3px 0 9px;
    border-bottom: 1px solid var(--border);
  }

  .rail-utility button {
    min-height: 31px;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 9px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--muted-2);
    font: inherit;
    font-size: var(--type-body, var(--text-base));
    text-align: left;
    cursor: pointer;
  }

  .rail-utility button:hover,
  .rail-utility button:focus-visible {
    background: var(--row-hover);
    color: var(--fg);
  }

  .rail-utility button:disabled {
    color: var(--muted);
    cursor: default;
    opacity: 0.7;
  }

  .utility-glyph {
    width: 18px;
    color: currentColor;
    text-align: center;
  }

  .rail-utility b {
    min-width: 18px;
    height: 17px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: auto;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--fg);
    color: var(--v4-ground, #111);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
  }

  .rail-search:focus-within {
    border-color: var(--border-strong);
    color: var(--muted-2);
  }

  .rail-search input {
    min-width: 0;
    flex: 1;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: var(--type-body, var(--text-base));
  }

  .rail-search input::placeholder { color: var(--muted); }

  .rail-section-heading {
    min-height: 28px;
    display: flex;
    align-items: center;
    padding: 13px 8px 5px;
    color: var(--muted);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 650;
    letter-spacing: .065em;
    line-height: 1;
    text-transform: uppercase;
  }

  .rail-section-heading button {
    width: 24px;
    height: 24px;
    margin-left: auto;
    border: 0;
    border-radius: var(--v4-radius-button, 6px);
    background: transparent;
    color: var(--muted-2);
    font: inherit;
    font-size: 17px;
    line-height: 1;
    cursor: pointer;
  }

  .rail-section-heading button:hover { background: var(--row-hover); color: var(--fg); }

  /* Unread count on a channel row — neutral, tabular, no decoration color. */
  .unread-badge {
    flex-shrink: 0;
    min-width: 16px;
    height: 15px;
    padding: 0 var(--space-1);
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    background: var(--surface-raise);
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }

  .contact-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .rail-show-more {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: calc(100% - var(--space-4));
    margin: var(--space-2);
    padding: var(--space-2) 0;
    border: 0;
    border-top: 1px solid var(--border);
    border-radius: 0;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: var(--text-base);
    text-align: left;
    cursor: pointer;
  }

  .rail-show-more span {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .rail-show-more:hover {
    color: var(--fg);
  }

  .contact-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 58px;
    text-align: left;
    padding: 9px var(--space-2);
    border: none;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font-family: var(--font-sans);
    font-size: var(--text-base);
    cursor: pointer;
    transition: background-color 0.12s cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .contact-row:hover {
    background: var(--row-hover);
  }

  /* Selected conversation stays open and uses a neutral baseline. */
  .contact-row.active {
    background: color-mix(in srgb, var(--fg) 10%, transparent);
    box-shadow: none;
  }

  .compact-list .contact-row {
    min-height: 34px;
    gap: 8px;
    padding: 4px 8px;
    border-radius: 6px;
  }

  .compact-list .contact-row.active {
    background: color-mix(in srgb, var(--fg) 10%, transparent);
    box-shadow: none;
  }

  .contact-row.active .contact-name {
    font-weight: 700;
  }

  .contact-row:focus-visible {
    outline: 2px solid var(--border-strong);
    outline-offset: -2px;
  }

  .agent-row {
    margin-bottom: var(--space-2);
    border-bottom: 1px solid var(--border);
  }

  /* DESKTOP-011: primary title row + secondary metadata in separate grid slots
     with an explicit 3px gap (never stacked via margin alone). */
  .contact-meta {
    display: grid;
    grid-template-rows: auto;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
    flex: 1;
  }

  .contact-top {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .contact-name {
    flex: 1;
    min-width: 0;
    font-size: var(--type-body, var(--text-base));
    font-weight: 500;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .contact-time {
    flex-shrink: 0;
    font-size: var(--type-metadata, var(--text-micro));
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .contact-sub {
    font-family: var(--font-sans);
    font-size: var(--type-secondary, var(--text-xs));
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .contact-provenance {
    color: var(--muted-2);
    font-weight: 600;
  }

  .contact-separator {
    color: var(--muted);
  }

  /* ── Right conversation / notification canvas (naked) ───────────────── */

  .pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    /* Naked canvas — no glass, no raised outer shell. */
    background: transparent;
    border-radius: 0;
  }

  .pane-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-6);
  }

  .pane-empty p {
    margin: 0;
    font-size: var(--type-body, var(--text-base));
    color: var(--muted);
    text-align: center;
  }

  .pane-header {
    display: flex;
    flex: 0 0 auto;
    align-items: flex-start;
    gap: var(--space-3);
    min-height: 56px;
    box-sizing: border-box;
    padding: 10px 22px;
    border-bottom: 1px solid var(--border);
    background: transparent;
    flex-shrink: 0;
  }

  .pane-title-stack {
    display: grid;
    grid-template-rows: auto auto;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
    flex: 1;
  }

  .pane-header h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--type-section, var(--text-section, 14px));
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pane-sub {
    font-family: var(--font-mono);
    font-size: var(--type-metadata, var(--text-micro));
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .pane-request {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-4) var(--space-5);
  }

  /* ── Thread panel column (US-022 / DESKTOP-011) ────────────────────────── */
  /* Wide default: fixed third column. Narrow collapses the list-detail third
     pane to an overlay so the conversation primary actions stay mounted. */
  .thread-column {
    width: 340px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--border);
    background: color-mix(in srgb, var(--v4-text-1, var(--fg)) 5%, transparent);
  }

  /* Narrow: overlay the conversation pane instead of squeezing a third column
     into a small window. The panel slides over from the right and covers the
     pane; the close/back affordance returns to the main conversation. Primary
     conversation chrome stays visible under the overlay close control. */
  @media (max-width: 720px) {
    .thread-column {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: min(100%, 420px);
      box-shadow: var(--pop-shadow);
      z-index: 5;
    }

    .messages-window {
      position: relative;
    }

    .rail {
      flex-basis: min(280px, 44%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .contact-row,
    .new-message-btn,
    .rail-retry {
      transition: none;
    }
  }
</style>
