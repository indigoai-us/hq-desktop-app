<script lang="ts">
  // Channel conversation pane (US-018). Renders one channel's thread + composer
  // by REUSING the shared <Conversation showAuthors={true}/> (channels are
  // multi-party, so author names show above incoming messages). The header
  // shows the channel identity, a scope chip (personal/group/company), and
  // a member-count button that opens <ChannelRoster/>.
  //
  // If the caller is invited-but-not-joined, the composer is replaced by a join
  // CTA: joining (join_channel) flips membership to "joined" and the composer
  // appears. The pane owns its own message fetch, send, mark-read, and the
  // live `channel:new-message` refresh for the channel it's showing.
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { safeUnlisten } from '../../lib/listener-registry';
  import { untrack } from 'svelte';
  import Conversation, { type ConversationMessage } from './Conversation.svelte';
  import ChannelRoster from './ChannelRoster.svelte';
  import {
    type Channel,
    type ChannelMessage as ChannelMessageWire,
    channelDisplayName,
    scopeChipLabel,
    isInvitedNotJoined,
  } from '../../lib/channels';
  import { type ReactionEvent, channelScope } from '../../lib/reactions';
  import { ReactionController } from '../../lib/reactionController.svelte';
  import {
    createOutboundMessage,
    retrySend,
    runSend,
    type OutboundMessage,
    type SendStatus,
  } from './sendStateMachine';

  interface Props {
    channel: Channel;
    // The caller's own personUid — passed through to the roster so it can
    // suppress a self-remove button.
    selfPersonUid?: string | null;
    // Bubbled up so the parent (MessagesShell) can clear the rail unread + the
    // channel's metadata when membership/member-count changes here.
    onchannelchange?: (channel: Channel) => void;
    onread?: (channelId: string) => void;
    // Threads (US-022). Forwarded to <Conversation/> so a root message's
    // reply-count affordance opens the ThreadPanel in MessagesShell. Called with
    // the root message's eventId; the parent supplies this channel's id as the
    // thread scope. `activeRootEventId` highlights the open thread's root bubble.
    onopenthread?: (rootEventId: string) => void;
    activeRootEventId?: string | null;
  }

  let {
    channel,
    selfPersonUid = null,
    onchannelchange,
    onread,
    onopenthread,
    activeRootEventId = null,
  }: Props = $props();

  interface ChannelMessageRow extends ConversationMessage {
    fromEmail?: string;
  }

  interface ChannelDetail {
    // Optional: the `/messages` endpoint may return only the message page (the
    // caller already holds the channel from the list). Consumed via a guard
    // below — `if (detail.channel)`.
    channel?: Channel;
    messages: ChannelMessageWire[];
    nextCursor?: string | null;
  }

  const PAGE_SIZE = 50;

  // Local mutable copy of the channel metadata (membership/member-count can
  // change in place via join/roster actions).
  let current = $state<Channel>(untrack(() => channel));
  let messages = $state<ChannelMessageRow[]>([]);
  let loading = $state(false);
  let loadingOlder = $state(false);
  let nextCursor = $state<string | null>(null);
  let threadError = $state<string | null>(null);
  let loadGeneration = 0;
  let activeChannelId: string | null = null;

  let sending = $state(false);
  let sendError = $state<string | null>(null);
  let sendGeneration = 0;
  /** In-flight / failed optimistic sends keyed by clientId. */
  let outboundById = $state<Map<string, OutboundMessage>>(new Map());

  let joining = $state(false);
  let joinError = $state<string | null>(null);
  let joinGeneration = 0;

  let rosterOpen = $state(false);
  let memberCount = $state<number | null>(
    untrack(() => channel.memberCount ?? null),
  );

  // Reactions (US-025) for the open channel. Recreated when the selected channel
  // changes (each channel is its own messageScope), kept in step with the visible
  // messages. Only meaningful for a joined channel (the invited preview has no
  // reactions surface).
  let reactionsCtl = $state<ReactionController | null>(null);

  const title = $derived(channelDisplayName(current));
  const chip = $derived(scopeChipLabel(current));
  const isPersonal = $derived(current.scope === 'personal');
  const isGroup = $derived(current.scope === 'group');
  const invited = $derived(isInvitedNotJoined(current));
  const conversationLabel = $derived(isGroup ? title : `#${title}`);
  const composerPlaceholder = $derived(
    `Message ${conversationLabel} — or type / to run an agent…`,
  );
  const hasOlder = $derived(!!nextCursor);

  // Owner determination: the creator is the channel owner. The Channel wire
  // shape doesn't carry the caller's role, so the roster (which lists per-member
  // roles) is the source of truth — it resolves the caller's own role against
  // `selfPersonUid` and only shows the owner-only remove/invite affordances when
  // the caller IS the owner. ChannelView simply hands the roster `selfPersonUid`
  // and lets it decide; the server also rejects a non-owner's remove/invite POST
  // as defense-in-depth.

  function mapWireMessage(row: ChannelMessageWire): ChannelMessageRow {
    const direction = row.direction === 'out' ? 'out' : 'in';
    return {
      eventId: row.eventId,
      fromPersonUid: row.fromPersonUid,
      fromEmail: row.fromEmail ?? '',
      fromDisplayName: row.fromDisplayName?.trim() || row.fromEmail || 'Unknown',
      body: row.body ?? '',
      details: row.details ?? null,
      prompt: row.prompt ?? null,
      createdAt: row.createdAt,
      direction,
      messageKind: row.messageKind ?? null,
      systemEvent: row.systemEvent ?? null,
      attachment: row.attachment ?? null,
    };
  }

  function patchOutboundRow(outbound: OutboundMessage): void {
    const status: SendStatus = outbound.status;
    messages = messages.map((m) =>
      m.eventId === outbound.clientId
        ? {
            ...m,
            sendStatus: status,
            body: outbound.body,
          }
        : m,
    );
  }

  async function load(): Promise<void> {
    const requestedChannelId = current.channelId;
    const generation = ++loadGeneration;
    loading = true;
    threadError = null;
    sendError = null;
    nextCursor = null;
    try {
      const detail = await invoke<ChannelDetail>('fetch_channel', {
        channelId: requestedChannelId,
        limit: PAGE_SIZE,
        cursor: null,
      });
      if (
        generation !== loadGeneration ||
        current.channelId !== requestedChannelId
      ) return;
      // Server returns newest-first; render oldest → newest.
      const page = (detail.messages ?? []).map(mapWireMessage).reverse();
      // Preserve any in-flight optimistic rows for this channel so a live
      // refresh never silently drops an unacked send.
      const optimistic = messages.filter(
        (m) =>
          m.eventId.startsWith('local-send-') &&
          (m.sendStatus === 'sending' ||
            m.sendStatus === 'pending' ||
            m.sendStatus === 'failed'),
      );
      messages = [...page, ...optimistic];
      nextCursor = detail.nextCursor ?? null;
      if (detail.channel) {
        current = { ...current, ...detail.channel };
        memberCount = current.memberCount ?? memberCount;
        onchannelchange?.(current);
      }
      // Opening a joined channel marks it read.
      if (!invited) void markRead(requestedChannelId);
    } catch (err) {
      if (
        generation !== loadGeneration ||
        current.channelId !== requestedChannelId
      ) return;
      threadError = typeof err === 'string' ? err : 'Could not load this channel';
      console.error('channel-view: fetch_channel failed', err);
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  async function loadOlder(): Promise<void> {
    const cursor = nextCursor;
    if (!cursor || loadingOlder || loading) return;
    const requestedChannelId = current.channelId;
    const generation = loadGeneration;
    loadingOlder = true;
    try {
      const detail = await invoke<ChannelDetail>('fetch_channel', {
        channelId: requestedChannelId,
        limit: PAGE_SIZE,
        cursor,
      });
      if (
        generation !== loadGeneration ||
        current.channelId !== requestedChannelId
      ) return;
      const older = (detail.messages ?? []).map(mapWireMessage).reverse();
      // Dedupe by eventId in case of cursor overlap.
      const seen = new Set(messages.map((m) => m.eventId));
      const fresh = older.filter((m) => !seen.has(m.eventId));
      messages = [...fresh, ...messages];
      nextCursor = detail.nextCursor ?? null;
    } catch (err) {
      if (
        generation !== loadGeneration ||
        current.channelId !== requestedChannelId
      ) return;
      console.error('channel-view: fetch_channel (older) failed', err);
    } finally {
      if (
        generation === loadGeneration &&
        current.channelId === requestedChannelId
      ) {
        loadingOlder = false;
      }
    }
  }

  function retryThread(): Promise<void> {
    return load();
  }

  async function markRead(channelId = current.channelId): Promise<void> {
    try {
      await invoke('mark_channel_read', { channelId });
      onread?.(channelId);
    } catch (err) {
      // Non-fatal — the unread will reconcile on the next poll.
      console.error('channel-view: mark_channel_read failed', err);
    }
  }

  async function send(text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const requestedChannelId = current.channelId;
    const generation = ++sendGeneration;
    sendError = null;

    // Optimistic append — message appears immediately as "Sending…".
    const outbound = createOutboundMessage(body);
    const nextMap = new Map(outboundById);
    nextMap.set(outbound.clientId, outbound);
    outboundById = nextMap;

    const row: ChannelMessageRow = {
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
    };
    messages = [...messages, row];
    sending = true;

    const result = await runSend(outbound, {
      send: async (msgBody) => {
        await invoke('send_channel_message', {
          channelId: requestedChannelId,
          body: msgBody,
        });
      },
      onChange: (msg) => {
        if (
          generation !== sendGeneration &&
          current.channelId !== requestedChannelId
        ) {
          // Still patch if the row exists — never drop.
        }
        const map = new Map(outboundById);
        map.set(msg.clientId, { ...msg });
        outboundById = map;
        patchOutboundRow(msg);
      },
    });

    // Per-message failure lives on the row ("Failed — tap to retry") so we
    // never surface a composer-level error that would block clearing the
    // textarea — the message is already on the timeline and must not be dropped.
    if (
      generation === sendGeneration &&
      current.channelId === requestedChannelId
    ) {
      sending = false;
      sendError = null;
      void result;
    } else {
      // Channel swapped mid-send: leave the row in the old channel's discarded
      // state; the outbound map is cleared on channel change.
      sending = false;
    }
  }

  async function retryFailedSend(eventId: string): Promise<void> {
    const outbound = outboundById.get(eventId);
    if (!outbound || outbound.status !== 'failed') return;
    const requestedChannelId = current.channelId;
    sendError = null;
    sending = true;
    await retrySend(outbound, {
      send: async (msgBody) => {
        await invoke('send_channel_message', {
          channelId: requestedChannelId,
          body: msgBody,
        });
      },
      onChange: (msg) => {
        const map = new Map(outboundById);
        map.set(msg.clientId, { ...msg });
        outboundById = map;
        patchOutboundRow(msg);
      },
    });
    if (current.channelId === requestedChannelId) {
      sending = false;
      sendError = null;
    }
  }

  async function join(): Promise<void> {
    if (joining) return;
    const requestedChannelId = current.channelId;
    const generation = ++joinGeneration;
    joining = true;
    joinError = null;
    try {
      const updated = await invoke<Channel>('join_channel', {
        channelId: requestedChannelId,
      });
      if (
        generation !== joinGeneration ||
        current.channelId !== requestedChannelId
      ) return;
      current = { ...current, ...updated, membership: updated.membership ?? 'joined' };
      onchannelchange?.(current);
      // Now a member — load the thread + mark read.
      await load();
    } catch (err) {
      if (
        generation !== joinGeneration ||
        current.channelId !== requestedChannelId
      ) return;
      joinError = typeof err === 'string' ? err : 'Could not join this channel';
      console.error('channel-view: join_channel failed', err);
    } finally {
      if (
        generation === joinGeneration &&
        current.channelId === requestedChannelId
      ) {
        joining = false;
      }
    }
  }

  function handleRosterCount(count: number): void {
    memberCount = count;
    current = { ...current, memberCount: count };
    onchannelchange?.(current);
  }

  // Reload when the selected channel changes (parent swaps `channel`).
  $effect(() => {
    // Touch channelId so the effect re-runs on selection change.
    const id = channel.channelId;
    // Metadata updates for the SAME channel are applied by the local command /
    // event paths below. Do not subscribe this selection effect to the whole
    // object or onchannelchange would feed a fresh object back from the parent
    // and repeatedly restart the channel load.
    const nextChannel = untrack(() => channel);
    if (activeChannelId === id) return;
    activeChannelId = id;
    loadGeneration += 1;
    sendGeneration += 1;
    joinGeneration += 1;
    current = nextChannel;
    memberCount = nextChannel.memberCount ?? null;
    messages = [];
    nextCursor = null;
    loadingOlder = false;
    outboundById = new Map();
    sending = false;
    joining = false;
    sendError = null;
    joinError = null;
    void id;
    void load();
  });

  // Reactions controller lifecycle: one per channel id. Recreated on channel
  // swap so each channel keeps its own messageScope; disposed on teardown.
  $effect(() => {
    const id = channel.channelId;
    if (!id) {
      reactionsCtl?.dispose();
      reactionsCtl = null;
      return;
    }
    const controller = new ReactionController(channelScope(id));
    reactionsCtl = controller;
    return () => controller.dispose();
  });

  // Keep the active-conversation registration + loaded reactions in step with the
  // visible channel messages (skip optimistic local-* ids — no server reactions
  // yet). Only for a joined channel (the invited preview has no toggle surface).
  $effect(() => {
    const controller = reactionsCtl;
    if (!controller || invited) return;
    const ids = messages
      .filter((m) => !m.eventId.startsWith('local-'))
      .map((m) => m.eventId);
    void controller.setMessages(ids);
  });

  // Live refresh: a `channel:new-message` for THIS channel reloads the thread
  // (and re-marks read since the user is looking at it). Other channels are
  // handled by the parent list. `channel:updated` for this channel patches the
  // local metadata.
  $effect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    const track = (unlisten: () => void) => {
      const safe = safeUnlisten(unlisten);
      if (disposed) safe();
      else unlisteners.push(safe);
    };
    void listen<{ channelId: string; unread?: number }>('channel:new-message', (e) => {
      if (e.payload.channelId === current.channelId) {
        void load();
      }
    }).then(track);
    // Reactions on a message in this channel changed (US-025). The controller
    // ignores events for any other scope, so this is safe even mid-swap.
    void listen<ReactionEvent>('message:reaction', (e) => {
      reactionsCtl?.applyEvent(e.payload);
    }).then(track);
    void listen<Channel>('channel:updated', (e) => {
      if (e.payload.channelId === current.channelId) {
        current = { ...current, ...e.payload };
        memberCount = current.memberCount ?? memberCount;
        onchannelchange?.(current);
      }
    }).then(track);
    return () => {
      disposed = true;
      for (const fn of unlisteners) fn();
    };
  });
</script>

<header class="channel-header" data-tauri-drag-region>
  <div class="channel-title">
    {#if !isGroup}<span class="channel-hash" aria-hidden="true">#</span>{/if}
    <h2>{title}</h2>
    <span class="scope-chip" class:personal={isPersonal} title={`Scope: ${chip}`}>
      {#if isPersonal}
        <span class="scope-glyph" aria-hidden="true">◐</span>
      {/if}
      {chip}
    </span>
  </div>
  <button
    class="member-count-btn"
    type="button"
    onclick={() => (rosterOpen = true)}
    title="View members"
    aria-label={memberCount != null
      ? `View ${memberCount} ${memberCount === 1 ? 'member' : 'members'}`
      : 'View members'}
  >
    {#if memberCount != null}
      {memberCount} {memberCount === 1 ? 'member' : 'members'}
    {:else}
      Members
    {/if}
  </button>
</header>

{#if invited}
  <!-- Invited-but-not-joined: the thread is a read-only preview. `readonly`
       hides the composer and renders a static "preview" note in its place — the
       Join CTA below is the only write affordance. Without readonly the composer
       rendered fully (textarea + Send + ⌘↵) but onsend was a no-op, so a typed
       message silently vanished with no error and no hint to join first. -->
  <Conversation
    {messages}
    showAuthors={true}
    {loading}
    error={threadError}
    onretryload={retryThread}
    sending={false}
    sendError={null}
    placeholder=""
    readonly={true}
    onsend={() => {}}
  />
  <div class="join-cta">
    <p class="join-text">
      You've been invited to <strong>{conversationLabel}</strong>. Join to read the full
      conversation and post.
    </p>
    {#if joinError}
      <p class="join-error" role="alert">{joinError}</p>
    {/if}
    <button
      class="btn btn-join"
      type="button"
      onclick={join}
      disabled={joining}
      aria-busy={joining}
    >
      {#if joining}
        <span class="inline-spinner" aria-hidden="true"></span>
      {/if}
      {joining ? 'Joining…' : isGroup ? 'Join conversation' : `Join #${title}`}
    </button>
  </div>
{:else}
  <Conversation
    {messages}
    showAuthors={true}
    {loading}
    error={threadError}
    onretryload={retryThread}
    {sending}
    {sendError}
    placeholder={composerPlaceholder}
    onsend={send}
    {onopenthread}
    {activeRootEventId}
    reactions={reactionsCtl?.map ?? {}}
    ontogglereaction={reactionsCtl ? reactionsCtl.toggle : undefined}
    onloadolder={loadOlder}
    {loadingOlder}
    {hasOlder}
    onretrysend={retryFailedSend}
  />
{/if}

{#if rosterOpen}
  <ChannelRoster
    channelId={current.channelId}
    {selfPersonUid}
    onclose={() => (rosterOpen = false)}
    oncountchange={handleRosterCount}
  />
{/if}

<style>
  .channel-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid var(--border, var(--pop-divider));
    flex-shrink: 0;
  }

  .channel-title {
    display: flex;
    align-items: center;
    gap: 0.4375rem;
    min-width: 0;
  }

  .channel-hash {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--muted, var(--pop-muted));
  }

  .channel-title h2 {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--fg, var(--pop-text));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .scope-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
    flex-shrink: 0;
    font-size: var(--text-base);
    font-weight: 560;
    letter-spacing: 0.02em;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--muted-2, var(--pop-muted));
  }

  .scope-chip.personal {
    background: transparent;
    color: var(--muted-2);
  }

  .scope-glyph {
    font-size: var(--text-base);
    line-height: 1;
  }

  .member-count-btn {
    margin-left: auto;
    flex-shrink: 0;
    border: 0;
    border-bottom: 1px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--muted-2, var(--pop-muted));
    font-family: inherit;
    font-size: var(--text-base);
    font-weight: 500;
    padding: 0.25rem 0;
    cursor: pointer;
    transition:
      transform 120ms var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1)),
      color 120ms ease,
      border-color 120ms ease;
  }

  .join-cta {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 1rem 1.25rem 1.25rem;
    border-top: 1px solid var(--border, var(--pop-divider));
  }

  .join-text {
    margin: 0;
    font-size: var(--text-base);
    line-height: 1.5;
    color: var(--muted-2, var(--pop-muted));
  }

  .join-text strong {
    color: var(--fg, var(--pop-text));
    font-weight: 600;
  }

  .join-error {
    margin: 0;
    font-size: var(--text-base);
    color: var(--red, var(--popover-danger));
  }

  .btn {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    padding: 0.4375rem 0.875rem;
    border-radius: 7px;
    font-size: var(--text-base);
    font-weight: 600;
    cursor: pointer;
    border: none;
    font-family: inherit;
    transition: background-color 0.12s ease;
  }

  .inline-spinner {
    width: 0.75rem;
    height: 0.75rem;
    flex: 0 0 auto;
    border: 1.5px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: channel-spin 0.72s linear infinite;
  }

  .btn-join {
    background: var(--accent, var(--c-btn-bg));
    color: var(--accent-fg, var(--c-btn-fg));
  }

  .btn-join:hover:not(:disabled) {
    filter: brightness(0.94);
  }

  .btn-join:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* Channel metadata is informative, not a stack of controls in rounded
     containers. Keep it quiet and inline in both Messages surfaces. */
  :global(html[data-window='dm-detail']) .channel-header {
    gap: 0.625rem;
    padding: 0.75rem 1.125rem;
  }

  :global(html[data-window='dm-detail']) .scope-chip {
    gap: 0.1875rem;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--pop-muted);
    font-size: 0.6875rem;
    font-weight: 560;
  }

  :global(html[data-window='dm-detail']) .scope-chip.personal {
    background: transparent;
    color: var(--pop-muted);
  }

  :global(html[data-window='dm-detail']) .member-count-btn {
    font-size: 0.6875rem;
  }

  .member-count-btn:active:not(:disabled),
  .btn:active:not(:disabled) {
    transform: scale(0.97);
  }

  .member-count-btn:focus-visible,
  .btn:focus-visible {
    outline: 2px solid var(--pop-text);
    outline-offset: 2px;
  }

  :global(html[data-window='dm-detail']) .btn {
    transition: transform 120ms var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1));
  }

  :global(html[data-window='dm-detail']) .btn-join {
    border-radius: 6px;
    background: var(--pop-text);
    color: var(--pop-bg);
  }

  :global(html[data-window='dm-detail']) .btn-join:hover:not(:disabled) {
    background: var(--pop-text);
    filter: none;
  }

  @keyframes channel-spin {
    to { transform: rotate(360deg); }
  }

  @media (hover: hover) and (pointer: fine) {
    .member-count-btn:hover {
      border-bottom-color: currentColor;
      color: var(--fg, var(--pop-text));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .inline-spinner {
      animation-duration: 1.4s;
    }

    .member-count-btn,
    .btn {
      transition: none;
    }

    .member-count-btn:active:not(:disabled),
    .btn:active:not(:disabled) {
      transform: none;
    }
  }
</style>
