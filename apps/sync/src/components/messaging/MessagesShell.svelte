<script lang="ts">
  // Dedicated Messages window (US-009 / DESKTOP-002). A resizable master/detail
  // shell:
  //
  //   ┌──────────────┬─────────────────────────────┐
  //   │ source-list  │   naked conversation /      │
  //   │ rail         │   notification canvas       │
  //   │ (DMs +       │   (Conversation /           │
  //   │  channels +  │    ShareMainPane /           │
  //   │  requests +  │    DmRequestCard)            │
  //   │  shares)     │                             │
  //   └──────────────┴─────────────────────────────┘
  //
  // Direct Messages, connection requests, shared HQ paths, channels, threads,
  // reactions, and the "Your agent" handoff are wired through Tauri commands.
  // This shell owns the data loading and hands shared primitives presentation
  // state plus callbacks. DESKTOP-002: no People/Requests tabs — requests and
  // share notifications are ordinary recency-sorted rail rows; no redundant
  // "Messages" page title; glass only on the navigation rail.
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
  import { listen } from '@tauri-apps/api/event';
  import { buildClaudeCodeUrl } from '../../lib/claude-code-link';
  import { hqSkillMarkdownLink } from '../../lib/hq-skill-link';
  import { appendInboundBatch } from '../../lib/dmThread';
  import { shareTitle } from '../../lib/share-path';
  import Conversation, { type ConversationMessage } from './Conversation.svelte';
  import ComposeMessage, { type ComposeSendResult } from './ComposeMessage.svelte';
  import DmRequestCard from './DmRequestCard.svelte';
  import ChannelView from './ChannelView.svelte';
  import CreateChannel from './CreateChannel.svelte';
  import ThreadPanel from './ThreadPanel.svelte';
  import CatchUp, { type CatchUpItem } from './v4/CatchUp.svelte';
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
    requestInitials,
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

  interface AppConfig {
    personUid?: string | null;
    hqFolderPath?: string | null;
  }

  interface RequestsResponse {
    requests: DmRequest[];
    nextCursor?: string | null;
  }

  let contacts = $state<Contact[]>([]);
  let loadingContacts = $state(false);
  let contactsError = $state<string | null>(null);

  // Pending incoming connection requests (US-011 / DESKTOP-002). Rendered as
  // ordinary recency-sorted rail rows (not a Requests tab). Selecting a row
  // opens the shared <DmRequestCard/> in the main pane. `list_dm_requests` is
  // the source of truth; `dm:request-new` / `dm:request-update` keep it live.
  let requests = $state<DmRequest[]>([]);
  let loadingRequests = $state(false);
  let requestsError = $state<string | null>(null);
  let selectedRequest = $state<DmRequest | null>(null);

  // Channels (US-018). `list_channels` is the source of truth for the rail;
  // `channel:new-message` / `channel:updated` keep it live. `selectedChannel`
  // drives the right pane (<ChannelView/>). `companyLabels` feeds the per-company
  // group headers (derived from the caller's memberships).
  let channels = $state<Channel[]>([]);
  let loadingChannels = $state(false);
  let channelsError = $state<string | null>(null);
  let selectedChannel = $state<Channel | null>(null);
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
  let messages = $state<ThreadMessage[]>([]);
  let loadingThread = $state(false);
  let threadError = $state<string | null>(null);

  let sending = $state(false);
  let sendError = $state<string | null>(null);

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
  // the DM reaction registration below never claims share ids.
  const displayMessages = $derived(
    selected && selected.source !== 'agent'
      ? mergeSharesIntoThread(messages, peerShares, shareToMessage)
      : messages,
  );

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
      title: `Thread · #${selectedChannel.name}`,
      showAuthors: true,
    };
  }

  function closeThread(): void {
    openThread = null;
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
    selectedRequest = null;
    selectedShareEvents = [];
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

  function initials(c: Contact): string {
    const name = displayLabel(c);
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  function contactSubline(c: Contact): string | null {
    return contactPreviewText(c) ?? c.email?.trim() ?? null;
  }

  // ── Catch-up digest (real data only) ───────────────────────────────────────
  // "While you were away" — conversations waiting for you, built ONLY from
  // signals already loaded: channels carrying a real unread count, and DMs whose
  // last message came IN (the ball is in your court). There is no per-DM unread
  // flag server-side, so we never claim a DM is "unread" — those are framed as
  // waiting. Ranked: unread channels first (by count), then inbound DMs in the
  // existing recency order. It's a digest (top slice), not the whole list.
  let catchUpDismissed = $state(false);

  const CATCH_UP_LIMIT = 6;

  const catchUpItems = $derived.by((): CatchUpItem[] => {
    const channelItems = channels
      .filter((ch) => (ch.unread ?? 0) > 0)
      .slice()
      .sort((a, b) => (b.unread ?? 0) - (a.unread ?? 0))
      .map((ch) => ({
        id: `ch:${ch.channelId}`,
        title: `# ${channelDisplayName(ch)}`,
        detail: `${ch.unread} unread`,
      }));

    const dmItems = contacts
      .filter((c) => ((c.previewDirection ?? c.lastMessageDirection) ?? '') === 'in')
      .map((c) => ({
        id: `dm:${c.personUid}`,
        title: displayLabel(c),
        detail: contactSubline(c) ?? 'Sent you a message',
      }));

    return [...channelItems, ...dmItems]
      .slice(0, CATCH_UP_LIMIT)
      .map((item, index) => ({ ...item, rank: index + 1 }));
  });

  // DESKTOP-002 unified rail: channels + DMs + connection requests + shared HQ
  // path notifications in ONE recency-sorted list. No People/Requests tabs.
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

  function handleCatchUpOpen(item: CatchUpItem): void {
    if (item.id.startsWith('ch:')) {
      const channelId = item.id.slice(3);
      const channel = channels.find((ch) => ch.channelId === channelId);
      if (channel) selectChannel(channel);
      return;
    }
    if (item.id.startsWith('dm:')) {
      const personUid = item.id.slice(3);
      const contact = contacts.find((c) => c.personUid === personUid);
      if (contact) void selectContact(contact);
    }
  }

  function selectRequest(req: DmRequest): void {
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

    contacts = sortContactsByRecentActivity(
      contacts.map((contact) => {
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
    loadingContacts = true;
    contactsError = null;
    try {
      const [resp, historyEvents] = await Promise.all([
        invoke<ContactsResponse>('list_contacts'),
        loadContactHistoryEvents(),
      ]);
      // Overlay "Shared a file" previews for contacts whose newest item is a
      // share (before sorting, so the share recency bumps the row up).
      const nextContacts = sortContactsByRecentActivity(
        applySharePreviews(
          mergeContactPreviews(resp.contacts ?? [], historyEvents),
          shareHistory,
        ),
        historyEvents,
      );
      contacts = nextContacts;
      void hydrateContactPreviews(nextContacts);
    } catch (err) {
      contactsError = typeof err === 'string' ? err : 'Could not load conversations';
      contacts = [];
      console.error('messages: list_contacts failed', err);
    } finally {
      loadingContacts = false;
    }
  }

  async function loadContactHistoryEvents(): Promise<ConversationEventRecencyFields[]> {
    try {
      const history = await invoke<NotificationHistoryResponse>('fetch_notification_history', {
        limit: 200,
      });
      // Same fetch feeds the share timeline + rail share previews.
      shareHistory = history.shares ?? [];
      return history.dms ?? [];
    } catch (err) {
      console.error('messages: fetch_notification_history failed', err);
      return [];
    }
  }

  async function loadUnreadSummary(): Promise<void> {
    try {
      // Kept for parity with the popover summary; the authoritative request
      // count now comes from `loadRequests` (the rendered list). We still read
      // the summary so any future unread surface stays wired.
      await invoke<UnreadSummary>('get_unread_summary');
    } catch (err) {
      // Non-fatal — the rail still renders.
      console.error('messages: get_unread_summary failed', err);
    }
  }

  async function loadRequests(): Promise<void> {
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
      requests = next;
    } catch (err) {
      requestsError =
        typeof err === 'string' ? err : 'Could not load connection requests';
      requests = [];
      console.error('messages: list_dm_requests failed', err);
    } finally {
      loadingRequests = false;
    }
  }

  async function loadChannels(): Promise<void> {
    loadingChannels = true;
    channelsError = null;
    try {
      const resp = await invoke<ChannelsResponse | null>('list_channels');
      channels = resp?.channels ?? [];
    } catch (err) {
      channelsError = typeof err === 'string' ? err : 'Could not load channels';
      channels = [];
      console.error('messages: list_channels failed', err);
    } finally {
      loadingChannels = false;
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
    } catch (err) {
      // Non-fatal — the roster degrades to server-enforced owner gating, and
      // agent handoff simply omits the folder until config loads.
      console.error('messages: get_config failed', err);
    }
  }

  function selectChannel(c: Channel): void {
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
    selectChannel(channel);
  }

  // ChannelView patched the channel's metadata (joined, member count) — reflect
  // it in the rail + keep the selected reference fresh.
  function handleChannelChange(channel: Channel): void {
    channels = upsertChannel(channels, channel);
    if (selectedChannel?.channelId === channel.channelId) {
      selectedChannel = channel;
    }
  }

  function handleChannelRead(channelId: string): void {
    channels = clearChannelUnread(channels, channelId);
  }

  // A request card resolved (Accept / Decline / Block succeeded). Prune it from
  // the unified rail. On Accept, the held first message becomes a live thread —
  // open the standard <Conversation> with the requester so the card is replaced
  // by the thread.
  function handleRequestResolved(req: DmRequest, action: RequestAction): void {
    requests = removeRequest(requests, req.pairKey);
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

  async function selectContact(c: Contact): Promise<void> {
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
      // Server returns newest-first; render chronologically (oldest → newest).
      messages = appendLiveInbound([...(resp.messages ?? [])].reverse(), c.personUid);
      const preview = previewFromMessages(resp.messages ?? []);
      if (preview) applyContactPreview(c.personUid, preview);
    } catch (err) {
      threadError = typeof err === 'string' ? err : 'Could not load this conversation';
      messages = [];
      console.error('messages: fetch_dm_thread failed', err);
    } finally {
      loadingThread = false;
    }
  }

  function openAgentThread(): void {
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

  async function sendAgentPrompt(text: string): Promise<void> {
    const prompt = buildAgentPrompt(text);
    const url = buildClaudeCodeUrl({ folder: hqFolderPath, prompt });
    await invoke('open_claude_code_link', { url });
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
        details: hqFolderPath ? `Workspace: ${hqFolderPath}` : null,
        prompt,
        createdAt: new Date().toISOString(),
        direction: 'in',
      },
    ];
  }

  async function sendReply(text: string): Promise<void> {
    if (!text || sending || !selected) return;
    sending = true;
    sendError = null;
    try {
      if (selected.source === 'agent') {
        await sendAgentPrompt(text);
      } else if (selected.personUid.startsWith('email:')) {
        // Unresolved (email-only) peer — e.g. "Message the sharer" on a legacy
        // share row with no issuerPersonUid. Route through the compose-flow
        // command, which addresses by email and may hold the message behind a
        // connection request (202).
        const sentAt = new Date().toISOString();
        const outcome = await invoke<{ state: string }>('send_dm_to_email', {
          toEmail: selected.email,
          toPersonUid: null,
          body: text,
        });
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
              ? `Pending — waiting for ${displayLabel(selected)} to accept`
              : null,
          },
        ];
      } else {
        const sentAt = new Date().toISOString();
        await invoke('send_dm', { toPersonUid: selected.personUid, body: text });
        // Optimistic append — the durable copy lands in the mirror and shows on
        // the next thread load.
        messages = [
          ...messages,
          {
            eventId: `local-${messages.length}-${text.length}`,
            fromPersonUid: 'me',
            fromEmail: '',
            fromDisplayName: 'You',
            body: text,
            details: null,
            prompt: null,
            createdAt: sentAt,
            direction: 'out',
          },
        ];
        contacts = sortContactsByRecentActivity(
          contacts.map((contact) =>
            contact.personUid === selected?.personUid
              ? {
                  ...contact,
                  lastMessageAt: sentAt,
                  previewBody: text,
                  previewAt: sentAt,
                  previewDirection: 'out',
                }
              : contact,
          ),
        );
      }
    } catch (err) {
      sendError =
        typeof err === 'string'
          ? err
          : selected.source === 'agent'
            ? 'Failed to open Claude Code'
            : 'Failed to send message';
      console.error('messages: send failed', err);
    } finally {
      sending = false;
    }
  }

  $effect(() => {
    const unlisteners: Array<() => void> = [];

    // A new DM may arrive while this window is open — refresh the contact list
    // (so a brand-new conversation appears) and the request count. The badge
    // reset is handled in Rust on messages_window_ready.
    listen<DmEvent[]>('dm:new-events', (e) => {
      applyLiveInbound(e.payload ?? []);
      void loadContacts();
      void loadUnreadSummary();
    }).then((fn) => unlisteners.push(fn));

    // A brand-new incoming connection request landed (US-011) — append it to the
    // Requests list (rail rows follow via railItems). Dedupe by
    // pairKey so a re-emit doesn't double-add.
    listen<DmRequest>('dm:request-new', (e) => {
      requests = addRequest(requests, e.payload);
    }).then((fn) => unlisteners.push(fn));

    // A pending request resolved elsewhere (accepted/declined/blocked, or pruned
    // by the poll diff). Drop it from the unified rail; clear the detail pane
    // when the open request is the one that left the set.
    listen<{ pairKey: string; state?: string }>('dm:request-update', (e) => {
      requests = removeRequest(requests, e.payload.pairKey);
      if (selectedRequest?.pairKey === e.payload.pairKey) selectedRequest = null;
    }).then((fn) => unlisteners.push(fn));

    // A channel the caller is in has new activity (US-018). If it's the open
    // channel, ChannelView handles its own refresh; otherwise bump the rail
    // unread badge for that channel.
    listen<{ channelId: string; unread?: number }>('channel:new-message', (e) => {
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
    }).then((fn) => unlisteners.push(fn));

    // Reactions on a message in the open DM conversation changed (US-025). The
    // controller ignores events for any scope other than its own, so this safely
    // no-ops when the open pane is a channel or nothing is selected.
    listen<ReactionEvent>('message:reaction', (e) => {
      dmReactions?.applyEvent(e.payload);
      // Share-scope events reconcile the inline share cards' reactions.
      shareReactions.applyEvent(e.payload);
    }).then((fn) => unlisteners.push(fn));

    // Deep link from the standalone-window path: `open_messages_window` with a
    // target stashes it in Rust and the ready-handshake (or an already-open
    // focus) emits it here.
    listen<ConversationTarget>('messages:open-conversation', (e) => {
      openConversationTarget(e.payload);
    }).then((fn) => unlisteners.push(fn));

    // Deep link from within the SAME desktop window (Notifications page →
    // Messages destination): the sender stashes the target and dispatches
    // hq:message-person; consume the stash whether we were mounted (event) or
    // mounted just after the navigation (initial take below).
    const onMessagePerson = () => {
      const t = takePendingConversation();
      if (t) openConversationTarget(t);
    };
    window.addEventListener(MESSAGE_PERSON_EVENT, onMessagePerson);
    unlisteners.push(() => window.removeEventListener(MESSAGE_PERSON_EVENT, onMessagePerson));
    onMessagePerson();

    // A brand-new channel/invite appeared, or a channel's metadata changed.
    // Upsert it into the rail so it shows live without a manual refresh.
    listen<Channel>('channel:updated', (e) => {
      channels = upsertChannel(channels, e.payload);
      if (selectedChannel?.channelId === e.payload.channelId) {
        selectedChannel = e.payload;
      }
    }).then((fn) => unlisteners.push(fn));

    // Ready-handshake: tell Rust the listeners are mounted so it shows + focuses
    // the window and resets the unread badge (mirrors DmDetail).
    void loadContacts();
    void loadRequests();
    void loadUnreadSummary();
    void loadChannels();
    void loadCompanyLabels();
    void loadConfig();
    invoke('messages_window_ready');

    return () => {
      for (const fn of unlisteners) fn();
      shareReactions.dispose();
    };
  });
</script>

<div class="messages-window">
  <!-- DESKTOP-002: source-list rail (glass) + naked main canvas. Compact header
       — no redundant "Messages" page title; no People/Requests tabs. -->
  <aside class="rail" aria-label="Conversations">
    <header class="rail-header" data-tauri-drag-region>
      <div class="primary-actions">
        <button
          class="new-message-btn"
          type="button"
          onclick={openCompose}
          title="New message"
          aria-label="New message"
        >
          + New message
        </button>
      </div>
    </header>

    <div class="rail-body">
      {#snippet dmRow(c: Contact)}
        <li>
          <button
            class="contact-row"
            class:active={selected?.personUid === c.personUid && !selectedRequest && selectedShareEvents.length === 0}
            type="button"
            onclick={() => selectContact(c)}
            title={contactSubline(c) ? `${displayLabel(c)} — ${contactSubline(c)}` : displayLabel(c)}
          >
            <span class="contact-avatar" aria-hidden="true">{initials(c)}</span>
            <span class="contact-meta">
              <span class="contact-top">
                <span class="contact-name">{displayLabel(c)}</span>
                {#if formatContactTime(c)}
                  <time class="contact-time" datetime={contactPreviewAt(c) ?? undefined}>
                    {formatContactTime(c)}
                  </time>
                {/if}
              </span>
              {#if contactSubline(c)}
                <span class="contact-sub">{contactSubline(c)}</span>
              {/if}
            </span>
          </button>
        </li>
      {/snippet}

      {#snippet channelRow(ch: Channel)}
        {@const company = companyNameFor(ch, companyLabels)}
        <li>
          <button
            class="contact-row channel-row"
            class:active={selectedChannel?.channelId === ch.channelId}
            type="button"
            onclick={() => selectChannel(ch)}
            title={`#${channelDisplayName(ch)}${company ? ` — ${company}` : ''}`}
          >
            <span class="contact-avatar channel-avatar" aria-hidden="true">#</span>
            <span class="contact-meta">
              <span class="contact-top">
                <span class="contact-name">{channelDisplayName(ch)}</span>
                {#if (ch.unread ?? 0) > 0}
                  <span class="unread-badge" aria-label={`${ch.unread} unread`}>{ch.unread}</span>
                {/if}
              </span>
              {#if company}
                <span class="contact-sub">{company}</span>
              {/if}
            </span>
          </button>
        </li>
      {/snippet}

      {#snippet requestRow(req: DmRequest)}
        <li>
          <button
            class="contact-row request-row"
            class:active={selectedRequest?.pairKey === req.pairKey}
            type="button"
            onclick={() => selectRequest(req)}
            title={`${requestDisplayName(req)} — connection request`}
            data-testid="request-rail-row"
          >
            <span class="contact-avatar request-avatar" aria-hidden="true">{requestInitials(req)}</span>
            <span class="contact-meta">
              <span class="contact-top">
                <span class="contact-name">{requestDisplayName(req)}</span>
                {#if formatRequestTime(req)}
                  <time class="contact-time" datetime={req.createdAt}>{formatRequestTime(req)}</time>
                {/if}
              </span>
              <span class="contact-sub">{requestSubline(req)}</span>
            </span>
          </button>
        </li>
      {/snippet}

      {#snippet shareRow(share: ShareEvent)}
        {@const firstPath = share.paths[0] ?? ''}
        <li>
          <button
            class="contact-row share-row"
            class:active={selectedShareEvents.some((e) => e.eventId === share.eventId)}
            type="button"
            onclick={() => selectShare(share)}
            title={firstPath ? `${shareRowLabel(share)} — ${shareTitle(firstPath)}` : shareRowLabel(share)}
            data-testid="share-rail-row"
          >
            <span class="contact-avatar share-avatar" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
                <path d="M9 1.5V5.5H13" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
              </svg>
            </span>
            <span class="contact-meta">
              <span class="contact-top">
                <span class="contact-name">{shareRowLabel(share)}</span>
                {#if formatShareTime(share)}
                  <time class="contact-time" datetime={share.createdAt}>{formatShareTime(share)}</time>
                {/if}
              </span>
              <span class="contact-sub">{shareRowSubline(share)}</span>
            </span>
          </button>
        </li>
      {/snippet}

      {#if catchUpItems.length > 0 && !catchUpDismissed}
        <div class="catch-up-host">
          <CatchUp
            items={catchUpItems}
            onopen={handleCatchUpOpen}
            ondismiss={() => (catchUpDismissed = true)}
          />
        </div>
      {/if}

      {#if loadingContacts || loadingChannels}
        <p class="rail-status">Loading conversations…</p>
      {:else if contactsError}
        <div class="rail-status rail-error" role="alert">
          <p>{contactsError}</p>
          <button type="button" class="rail-retry" onclick={() => loadContacts()}>Retry</button>
        </div>
      {:else}
        {#if requestsError}
          <div class="rail-status rail-error" role="alert">
            <p>{requestsError}</p>
            <button type="button" class="rail-retry" onclick={() => loadRequests()}>Retry</button>
          </div>
        {/if}
        <div class="rail-actions">
          <button type="button" class="rail-action" onclick={() => openCreateChannel(null)}>
            + New channel
          </button>
          <button type="button" class="rail-action" onclick={openCreateGroupDm}>
            + New group DM
          </button>
        </div>
        <ul class="contact-list">
          <li>
            <button
              class="contact-row agent-row"
              class:active={selected?.source === 'agent'}
              type="button"
              onclick={openAgentThread}
            >
              <span class="contact-avatar bolt-avatar" aria-hidden="true">⚡</span>
              <span class="contact-meta">
                <span class="contact-name">Your agent</span>
                <span class="contact-sub">Watching for work that needs you</span>
              </span>
            </button>
          </li>
          {#each railItems as item (item.key)}
            {#if item.kind === 'dm'}
              {@render dmRow(item.contact)}
            {:else if item.kind === 'channel'}
              {@render channelRow(item.channel)}
            {:else if item.kind === 'request'}
              {@render requestRow(item.request)}
            {:else if item.kind === 'share'}
              {@render shareRow(item.share)}
            {/if}
          {/each}
        </ul>
        {#if railItems.length === 0}
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
      <header class="pane-header">
        <div class="pane-title-stack">
          <h2>{displayLabel(selected)}</h2>
          {#if selected.email}
            <span class="pane-sub">{selected.email}</span>
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
     source-list treatment ONLY on the navigation rail; the main thread and
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

  /* ── Left rail (source-list / liquid-glass control layer) ────────────── */

  .rail {
    width: 300px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    background: var(--surface-rail);
    min-height: 0;
  }

  /* Compact header: primary actions only — no redundant "Messages" title. */
  .rail-header {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4) var(--space-2);
    flex-shrink: 0;
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
    border: 1px solid var(--border-strong);
    background: var(--surface-raise);
    color: var(--fg);
    font-family: var(--font-sans);
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 500;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background-color 0.12s ease, border-color 0.12s ease;
  }

  .new-message-btn:hover {
    background: var(--row-hover);
    border-color: var(--border-strong);
  }

  .new-message-btn:focus-visible {
    outline: 2px solid var(--border-strong);
    outline-offset: 1px;
  }

  .rail-body {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding: var(--space-1) var(--space-2) var(--space-3);
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

  .rail-retry:focus-visible {
    outline: 2px solid var(--border-strong);
    outline-offset: 1px;
  }

  .catch-up-host {
    padding: 0 0 var(--space-2);
  }

  /* Create affordances — moved out of the old Channels tab into the unified rail
     so channels can still be started without a separate view. Quiet ghost
     buttons matching the desktop language. */
  .rail-actions {
    display: flex;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-1) var(--space-2);
  }

  .rail-action {
    flex: 1;
    border: 1px solid var(--border);
    background: var(--surface-raise);
    color: var(--muted-2);
    font-family: var(--font-sans);
    font-size: var(--text-micro);
    font-weight: 500;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;
  }

  .rail-action:hover {
    background: var(--row-hover);
    color: var(--fg);
    border-color: var(--border-strong);
  }

  .rail-action:focus-visible {
    outline: 2px solid var(--border-strong);
    outline-offset: 1px;
  }

  /* Channel rows reuse the contact-row vocabulary so #channels and DMs read as
     one list. The avatar carries a '#' glyph instead of initials. */
  .channel-avatar {
    color: var(--fg);
    font-family: var(--font-display);
    font-size: var(--text-base);
    font-weight: 600;
  }

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
    gap: 1px;
  }

  .contact-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    text-align: left;
    padding: var(--space-2) var(--space-2) var(--space-2) calc(var(--space-2) + 2px);
    border: none;
    border-radius: 6px;
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

  /* Selected conversation: restrained row-active surface + a 2px Indigo edge —
     the desktop "active row" treatment, emphasis kept neutral. */
  .contact-row.active {
    background: var(--row-active);
  }

  .contact-row.active::before {
    content: '';
    position: absolute;
    left: 0;
    top: 7px;
    bottom: 7px;
    width: 2px;
    border-radius: 999px;
    background: var(--fg);
  }

  .contact-row:focus-visible {
    outline: 2px solid var(--border-strong);
    outline-offset: -2px;
  }

  .contact-avatar {
    flex-shrink: 0;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-raise);
    border: 1px solid var(--border);
    color: var(--muted-2);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .agent-row {
    margin-bottom: var(--space-1);
    border-bottom: 1px solid var(--border);
  }

  .bolt-avatar {
    background: var(--surface-raise);
    color: var(--fg);
  }

  /* DESKTOP-011: primary title row + secondary metadata in separate grid slots
     with an explicit 3px gap (never stacked via margin alone). */
  .contact-meta {
    display: grid;
    grid-template-rows: auto auto;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
    flex: 1;
  }

  .contact-top {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
  }

  .contact-name {
    flex: 1;
    min-width: 0;
    font-size: var(--type-body, var(--text-base));
    font-weight: 600;
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

  .request-avatar,
  .share-avatar {
    color: var(--muted-2);
  }

  .share-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
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
    padding: var(--space-4) var(--space-5) var(--space-3);
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
    background: var(--surface-rail);
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
      flex-basis: min(260px, 42%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .contact-row,
    .new-message-btn,
    .rail-action,
    .rail-retry {
      transition: none;
    }
  }
</style>
