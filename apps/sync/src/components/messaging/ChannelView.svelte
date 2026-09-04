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
  import AgentThinkingRow from './AgentThinkingRow.svelte';
  import AgentTaskStrip from './AgentTaskStrip.svelte';
  import { AgentTaskFeedController } from '../../lib/agentTaskFeedController.svelte';
  import { AgentThinkingController } from '../../lib/agentThinkingController.svelte';
  import {
    type Channel,
    channelDisplayName,
    scopeChipLabel,
    isInvitedNotJoined,
  } from '../../lib/channels';
  import { type ReactionEvent, channelScope } from '../../lib/reactions';
  import { foldReplies } from './thread-replies';
  import { ReactionController } from '../../lib/reactionController.svelte';

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
    messages: ChannelMessageRow[];
    nextCursor?: string | null;
  }

  // Local mutable copy of the channel metadata (membership/member-count can
  // change in place via join/roster actions).
  let current = $state<Channel>(untrack(() => channel));
  let messages = $state<ChannelMessageRow[]>([]);
  let loading = $state(false);
  let threadError = $state<string | null>(null);
  let loadGeneration = 0;
  let activeChannelId: string | null = null;

  let sending = $state(false);
  let sendError = $state<string | null>(null);
  let sendGeneration = 0;
  let optimisticSeq = 0;

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
  let thinkingCtl = $state<AgentThinkingController | null>(null);
  // Live background-task strip for the agents on this channel's roster.
  // Built and disposed alongside thinkingCtl — same roster, same lifetime.
  let taskCtl = $state<AgentTaskFeedController | null>(null);

  const title = $derived(channelDisplayName(current));
  const chip = $derived(scopeChipLabel(current));
  const isPersonal = $derived(current.scope === 'personal');
  const isGroup = $derived(current.scope === 'group');
  const invited = $derived(isInvitedNotJoined(current));
  const conversationLabel = $derived(isGroup ? title : `#${title}`);

  // Owner determination: the creator is the channel owner. The Channel wire
  // shape doesn't carry the caller's role, so the roster (which lists per-member
  // roles) is the source of truth — it resolves the caller's own role against
  // `selfPersonUid` and only shows the owner-only remove/invite affordances when
  // the caller IS the owner. ChannelView simply hands the roster `selfPersonUid`
  // and lets it decide; the server also rejects a non-owner's remove/invite POST
  // as defense-in-depth.

  async function load(): Promise<void> {
    const requestedChannelId = current.channelId;
    const generation = ++loadGeneration;
    loading = true;
    threadError = null;
    sendError = null;
    try {
      const detail = await invoke<ChannelDetail>('fetch_channel', {
        channelId: requestedChannelId,
      });
      if (
        generation !== loadGeneration ||
        current.channelId !== requestedChannelId
      ) return;
      // Server returns newest-first; render oldest → newest. Thread-reply rows
      // are folded onto their roots (count + lastReplyAt) so the reply
      // indicator renders in the channel list; replies stay in the thread pane.
      const previousIds = new Set(messages.map((m) => m.eventId));
      const fetched = [...(detail.messages ?? [])].reverse();
      messages = foldReplies(fetched);
      // Only newly arrived senders can dismiss a thinking row — a full reload
      // would otherwise clear on historical agent messages in the thread.
      thinkingCtl?.noteIncoming(fetched.filter((m) => !previousIds.has(m.eventId)));
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
    if (!text || sending) return;
    const requestedChannelId = current.channelId;
    const generation = ++sendGeneration;
    sending = true;
    sendError = null;
    try {
      await invoke('send_channel_message', {
        channelId: requestedChannelId,
        body: text,
      });
      if (
        generation !== sendGeneration ||
        current.channelId !== requestedChannelId
      ) return;
      messages = [
        ...messages,
        {
          eventId: `local-${Date.now()}-${optimisticSeq++}`,
          fromPersonUid: 'me',
          fromEmail: '',
          fromDisplayName: 'You',
          body: text,
          details: null,
          prompt: null,
          createdAt: new Date().toISOString(),
          direction: 'out',
        },
      ];
      void thinkingCtl?.noteOutgoing(text);
    } catch (err) {
      if (
        generation !== sendGeneration ||
        current.channelId !== requestedChannelId
      ) return;
      sendError = typeof err === 'string' ? err : 'Failed to send message';
      console.error('channel-view: send_channel_message failed', err);
      thinkingCtl?.noteSendFailed();
    } finally {
      if (generation === sendGeneration) sending = false;
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

  // Agent-thinking indicator: one controller per channel id. Recreated on
  // channel swap; disposed on teardown. Member loader hits list_channel_members
  // and maps to MentionCandidate (personUid + displayName).
  $effect(() => {
    const id = channel.channelId;
    if (!id) {
      thinkingCtl?.dispose();
      thinkingCtl = null;
      taskCtl?.dispose();
      taskCtl = null;
      return;
    }
    // One roster loader shared by both controllers; each caches its own copy.
    const loadMembers = async () => {
      const resp = await invoke<{ members: Array<{ personUid: string; displayName: string }> }>(
        'list_channel_members',
        { channelId: id },
      );
      return (resp.members ?? []).map((m) => ({
        personUid: m.personUid,
        displayName: m.displayName,
      }));
    };
    const controller = new AgentThinkingController(loadMembers);
    // Room-scoped when the server supports it, agent-wide otherwise.
    const tasks = new AgentTaskFeedController(loadMembers, { channelId: id });
    thinkingCtl = controller;
    taskCtl = tasks;
    return () => {
      controller.dispose();
      tasks.dispose();
    };
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
    companyUid={current.companyUid}
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
    placeholder={`Message ${conversationLabel}…`}
    onsend={send}
    {onopenthread}
    {activeRootEventId}
    reactions={reactionsCtl?.map ?? {}}
    ontogglereaction={reactionsCtl ? reactionsCtl.toggle : undefined}
    companyUid={current.companyUid}
  >
    {#snippet belowMessages()}
      <AgentThinkingRow entries={thinkingCtl?.entries ?? []} />
      <AgentTaskStrip tasks={taskCtl?.tasks ?? []} />
    {/snippet}
  </Conversation>
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
