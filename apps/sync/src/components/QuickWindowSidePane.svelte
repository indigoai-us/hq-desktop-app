<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import type { Item } from '../lib/notificationGroups';
  import {
    loadNotificationItems,
    getLastReadTs,
  } from '../lib/notificationFeedData';
  import {
    countUnreadConversations,
    conversationRows,
    type ConversationRow,
  } from '../lib/quickWindowPane';
  import {
    channelDisplayName,
    companyNameFor,
    type Channel,
  } from '../lib/channels';
  import NotificationRow from './NotificationRow.svelte';

  // Source list for the quick communications window. DM/share conversations
  // retain the existing grouped history semantics; channels are an optional
  // second source. A failed/legacy list_channels call simply omits the section
  // so direct-message and share behavior remains available.

  interface Props {
    selectedId: string | null;
    selectedChannelId?: string | null;
    viewedIds: ReadonlySet<string>;
    onselect: (item: Item, conversationIds?: string[], conversationItems?: Item[]) => void;
    onselectchannel?: (channel: Channel) => void;
    onattentionchange?: (count: number) => void;
  }

  interface ChannelsResponse {
    channels: Channel[];
  }

  let {
    selectedId,
    selectedChannelId = null,
    viewedIds,
    onselect,
    onselectchannel,
    onattentionchange,
  }: Props = $props();

  let items = $state<Item[]>([]);
  let channels = $state<Channel[]>([]);
  let loading = $state(true);
  let loadingChannels = $state(true);
  let loadError = $state<string | null>(null);
  let channelLoadError = $state<string | null>(null);
  let retrying = $state(false);
  // Snapshot once per mount — matches NotificationFeed (session-stable).
  const lastReadTs = getLastReadTs();
  let loadGeneration = 0;
  let channelLoadGeneration = 0;

  const rows = $derived(conversationRows(items, lastReadTs, viewedIds));
  const orderedChannels = $derived.by(() =>
    channels
      .slice()
      .sort((a, b) => {
        const unreadDelta = (b.unread ?? 0) - (a.unread ?? 0);
        if (unreadDelta !== 0) return unreadDelta;
        return channelTimestamp(b) - channelTimestamp(a);
      })
      .slice(0, 12),
  );
  type RailEntry =
    | { kind: 'conversation'; key: string; timestamp: number; row: ConversationRow }
    | { kind: 'channel'; key: string; timestamp: number; channel: Channel };
  const railEntries = $derived.by((): RailEntry[] =>
    [
      ...rows.map((row) => ({
        kind: 'conversation' as const,
        key: row.key,
        timestamp: row.latest.ts,
        row,
      })),
      ...orderedChannels.map((channel) => ({
        kind: 'channel' as const,
        key: `channel:${channel.channelId}`,
        timestamp: channelTimestamp(channel),
        channel,
      })),
    ].sort((a, b) => b.timestamp - a.timestamp),
  );
  const attentionCount = $derived(
    countUnreadConversations(items, lastReadTs, viewedIds) +
      channels.filter((channel) => (channel.unread ?? 0) > 0).length,
  );

  function channelTimestamp(channel: Channel): number {
    for (const value of [
      channel.lastActivityAt,
      channel.lastMessageAt,
      channel.createdAt,
    ]) {
      const parsed = Date.parse(value ?? '');
      if (Number.isFinite(parsed)) return parsed;
    }
    return channel.arrivedAt ?? 0;
  }

  function formatChannelTime(channel: Channel): string | null {
    const timestamp = channelTimestamp(channel);
    if (!timestamp) return null;
    const date = new Date(timestamp);
    const now = new Date();
    const startToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    if (timestamp >= startToday) {
      return date.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      });
    }
    if (date.getFullYear() === now.getFullYear()) {
      return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
    }
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function channelTitle(channel: Channel): string {
    const label = channelDisplayName(channel);
    return channel.scope === 'group' ? label : `#${label}`;
  }

  function channelContext(channel: Channel): string {
    if (channel.scope === 'group') {
      if (channel.memberCount != null && channel.memberCount > 0) {
        return `Group DM · ${channel.memberCount} ${
          channel.memberCount === 1 ? 'person' : 'people'
        }`;
      }
      // `members` intentionally omits the caller. When the server has not
      // supplied a total memberCount, describe this fallback honestly.
      const others = channel.members?.length ?? 0;
      return others > 0
        ? `Group DM · ${others} ${others === 1 ? 'other' : 'others'}`
        : 'Group DM';
    }
    if (channel.scope === 'personal') return 'Personal channel';
    return `${companyNameFor(channel) ?? 'Company'} channel`;
  }

  function channelAvatar(channel: Channel): string {
    if (channel.scope !== 'group') return '#';
    const initials = (channel.members ?? [])
      .map((member) => member.displayName.trim())
      .filter(Boolean)
      .slice(0, 2)
      .map((name) => name[0]?.toUpperCase() ?? '')
      .join('');
    return initials || 'DM';
  }

  function senderIdentity(actor: string, agent: boolean): string {
    if (agent) return 'AI';
    const initials = actor
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('');
    return initials || 'DM';
  }

  function selectChannel(channel: Channel): void {
    channels = channels.map((candidate) =>
      candidate.channelId === channel.channelId
        ? { ...candidate, unread: 0 }
        : candidate,
    );
    onselectchannel?.({ ...channel, unread: 0 });
  }

  async function load(): Promise<void> {
    const generation = ++loadGeneration;
    loading = true;
    try {
      // Full feed — conversationRows filters dm|share and caps conversations at 30.
      const next = await loadNotificationItems(undefined, { includeUpdates: false });
      if (generation !== loadGeneration) return;
      items = next;
      loadError = null;
    } catch (err) {
      if (generation !== loadGeneration) return;
      console.error('quick-window-pane: load failed', err);
      loadError = 'Messages are unavailable.';
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  async function loadChannels(): Promise<void> {
    const generation = ++channelLoadGeneration;
    loadingChannels = true;
    try {
      const response = await invoke<ChannelsResponse | null>('list_channels');
      if (generation !== channelLoadGeneration) return;
      channels = Array.isArray(response?.channels) ? response.channels : [];
      channelLoadError = null;
    } catch (err) {
      if (generation !== channelLoadGeneration) return;
      // Channels are additive in this compact surface. Older/offline runtimes
      // retain the complete DM/share experience without a blocking error.
      console.error('quick-window-pane: list_channels failed', err);
      channelLoadError = 'Channels are unavailable.';
    } finally {
      if (generation === channelLoadGeneration) loadingChannels = false;
    }
  }

  async function retryFailedSources(): Promise<void> {
    if (retrying) return;
    const retryMessages = loadError !== null;
    const retryChannels = channelLoadError !== null;
    retrying = true;
    try {
      await Promise.all([
        retryMessages ? load() : Promise.resolve(),
        retryChannels ? loadChannels() : Promise.resolve(),
      ]);
    } finally {
      retrying = false;
    }
  }

  // Selecting a channel clears its local unread count immediately. ChannelView
  // also performs the authoritative mark_channel_read call.
  $effect(() => {
    const id = selectedChannelId;
    if (!id || !channels.some((channel) => channel.channelId === id && (channel.unread ?? 0) > 0)) {
      return;
    }
    channels = channels.map((channel) =>
      channel.channelId === id ? { ...channel, unread: 0 } : channel,
    );
  });

  $effect(() => {
    onattentionchange?.(attentionCount);
  });

  // Load on mount; debounce reloads on the same signals NotificationFeed and
  // the full Messages rail use.
  $effect(() => {
    void load();
    void loadChannels();

    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    let channelReloadTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      loadGeneration += 1;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        void load();
      }, 400);
    };
    const scheduleChannelReload = () => {
      channelLoadGeneration += 1;
      if (channelReloadTimer) clearTimeout(channelReloadTimer);
      channelReloadTimer = setTimeout(() => {
        channelReloadTimer = null;
        void loadChannels();
      }, 250);
    };

    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (unlisten: () => void) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };
    void listen('dm:unread-summary', scheduleReload).then(track);
    void listen('sync:complete', scheduleReload).then(track);
    void listen('channel:new-message', scheduleChannelReload).then(track);
    void listen('channel:updated', scheduleChannelReload).then(track);

    return () => {
      disposed = true;
      loadGeneration += 1;
      channelLoadGeneration += 1;
      if (reloadTimer) clearTimeout(reloadTimer);
      if (channelReloadTimer) clearTimeout(channelReloadTimer);
      for (const unlisten of unlisteners) unlisten();
    };
  });
</script>

<aside
  class="qw-side-pane"
  aria-label="Conversations"
  aria-busy={loading || loadingChannels}
>
  <section class="qw-section" aria-labelledby="quick-conversations-label">
    <div class="qw-side-label" id="quick-conversations-label">Conversations</div>

    {#if (loading || loadingChannels) && railEntries.length === 0}
      <div class="qw-skeleton-list" aria-label="Loading conversations" role="status">
        {#each Array(5) as _}
          <div class="qw-skeleton-row">
            <span class="qw-skeleton-avatar"></span>
            <span class="qw-skeleton-copy">
              <span></span>
              <span></span>
            </span>
          </div>
        {/each}
      </div>
    {:else if railEntries.length > 0}
      <div class="qw-side-list">
        {#each railEntries as entry (entry.key)}
          {#if entry.kind === 'conversation'}
            {@const row = entry.row}
            {@const isSelected = selectedId != null && row.ids.includes(selectedId)}
            <NotificationRow
              type={row.kind === 'dm' ? 'message' : 'share'}
              actor={row.actor}
              identityLabel={senderIdentity(row.actor, row.agent)}
              sourceLabel={row.kind === 'dm' ? 'Direct message' : 'Shared file'}
              text={row.latest.kind === 'dm' ? (row.latest.dm?.body ?? row.latest.summary) : row.latest.summary}
              ts={row.latest.ts}
              unread={!isSelected && row.unreadCount > 0}
              badgeCount={isSelected ? 0 : row.unreadCount}
              agentActor={row.agent}
              selected={isSelected}
              hoverExpand={false}
              comfortable
              onopen={() => onselect(row.latest, row.ids, row.items)}
            />
          {:else}
            {@const channel = entry.channel}
            {@const isSelected = selectedChannelId === channel.channelId}
            {@const time = formatChannelTime(channel)}
            <button
              type="button"
              class="channel-row"
              class:active={isSelected}
              data-testid="quick-channel-row"
              aria-current={isSelected ? 'true' : undefined}
              aria-label={`${channelTitle(channel)}, ${channelContext(channel)}${channel.unread ? `, ${channel.unread} unread` : ''}`}
              onclick={() => selectChannel(channel)}
            >
              <span
                class="channel-avatar"
                class:group-avatar={channel.scope === 'group'}
                aria-hidden="true"
              >
                {channelAvatar(channel)}
              </span>
              <span class="channel-copy">
                <span class="channel-title-line">
                  <strong>{channelTitle(channel)}</strong>
                  {#if time}
                    <time datetime={channel.lastActivityAt ?? channel.lastMessageAt ?? channel.createdAt ?? undefined}>
                      {time}
                    </time>
                  {/if}
                </span>
                <span class="channel-context">
                  <span>{channelContext(channel)}</span>
                  {#if !isSelected && (channel.unread ?? 0) > 0}
                    <b aria-label={`${channel.unread} unread`}>{channel.unread}</b>
                  {/if}
                </span>
              </span>
            </button>
          {/if}
        {/each}
      </div>
    {/if}

    {#if loadError || channelLoadError}
      <div class="qw-load-error" role="alert">
        <span>{[loadError, channelLoadError].filter(Boolean).join(' ')}</span>
        <button
          type="button"
          disabled={retrying}
          aria-busy={retrying}
          onclick={() => void retryFailedSources()}
        >
          {#if retrying}
            <span class="qw-retry-spinner" aria-hidden="true"></span>
          {/if}
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    {/if}
  </section>

  {#if !loading && !loadingChannels && !loadError && !channelLoadError && railEntries.length === 0}
    <p class="qw-side-status">No conversations</p>
  {/if}
</aside>

<style>
  .qw-side-pane {
    width: 292px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
    border-right: 1px solid var(--pop-divider);
    padding: 12px 10px 18px;
    overflow-y: auto;
    box-sizing: border-box;
    scrollbar-width: thin;
    scrollbar-color: var(--pop-muted) transparent;
    background: var(--compact-glass-rail, transparent);
  }

  .qw-side-pane::-webkit-scrollbar {
    width: 6px;
  }

  .qw-side-pane::-webkit-scrollbar-thumb {
    background: var(--pop-hover);
    border-radius: 3px;
  }

  .qw-section {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .qw-side-label {
    flex-shrink: 0;
    padding: 8px 8px 7px;
    color: var(--pop-muted);
    font-size: 10.5px;
    font-weight: 650;
    letter-spacing: 0.055em;
    line-height: 1.2;
    text-transform: uppercase;
  }

  .qw-side-status {
    margin: 0;
    padding: 12px 8px;
    font-size: 12.5px;
    color: var(--pop-muted);
  }

  .qw-side-list,
  .qw-skeleton-list {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  .qw-side-list :global(.nr) {
    min-height: 66px;
    padding: 9px 8px;
    border-radius: 0;
    box-shadow: inset 0 -1px 0 var(--pop-divider);
  }

  .qw-side-list :global(.nr-primary-action),
  .qw-side-list :global(.nr-primary-content) {
    gap: 10px;
  }

  .qw-side-list :global(.nr-comfortable-top) {
    gap: 6px;
  }

  .qw-side-list :global(.nr-comfortable-actor) {
    max-width: 13ch;
  }

  .qw-side-list :global(.nr-comfortable-context) {
    max-width: 8ch;
    font-size: 9.5px;
    font-weight: 620;
    letter-spacing: 0.035em;
    text-transform: uppercase;
  }

  .qw-side-list :global(.nr-comfortable-preview) {
    color: var(--pop-muted);
    font-size: 11.5px;
    line-height: 1.35;
  }

  .qw-side-list :global(.nr-selected) {
    background: var(--compact-glass-selected, var(--pop-hover));
  }

  /* US-016: subtle type hierarchy without spending a colored accent. */
  .qw-side-list :global(.nr[data-type='share'] .nr-icon) { color: var(--pop-text, #e8e8e8); }
  .qw-side-list :global(.nr[data-type='system'] .nr-icon) { color: var(--pop-muted); }

  .channel-row {
    width: 100%;
    min-height: 58px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px;
    border: 0;
    border-bottom: 1px solid var(--pop-divider);
    border-radius: 0;
    background: transparent;
    color: var(--pop-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: transform 120ms var(--ease-out);
  }

  .channel-row.active {
    background: var(--compact-glass-selected, var(--pop-hover));
  }

  .channel-row:focus-visible {
    outline: 2px solid var(--pop-text);
    outline-offset: -2px;
  }

  .channel-row:active {
    transform: scale(0.99);
  }

  .channel-avatar {
    width: 30px;
    height: 30px;
    flex: 0 0 30px;
    display: grid;
    place-items: center;
    border: 1px solid var(--pop-divider);
    border-radius: 8px;
    background: var(--pop-hover);
    color: var(--pop-text);
    font-size: 13px;
    font-weight: 650;
  }

  .group-avatar {
    font-size: 10px;
    letter-spacing: 0.025em;
  }

  .channel-copy,
  .qw-skeleton-copy {
    min-width: 0;
    flex: 1;
    display: grid;
    gap: 4px;
  }

  .channel-title-line,
  .channel-context {
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .channel-title-line strong {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    color: var(--pop-text);
    font-size: 13px;
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .channel-title-line time {
    flex: 0 0 auto;
    color: var(--pop-muted);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
  }

  .channel-context {
    color: var(--pop-muted);
    font-size: 11.5px;
  }

  .channel-context > span {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .channel-context b {
    min-width: 17px;
    height: 16px;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
    border: 1px solid var(--pop-divider);
    border-radius: 8px;
    background: var(--pop-hover);
    color: var(--pop-text);
    font-size: 10px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .qw-skeleton-row {
    min-height: 54px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 8px;
    border-bottom: 1px solid var(--pop-divider);
    box-sizing: border-box;
  }

  .qw-skeleton-avatar,
  .qw-skeleton-copy span {
    display: block;
    background: var(--pop-hover);
    animation: quick-pulse 1s linear infinite alternate;
  }

  .qw-skeleton-avatar {
    width: 30px;
    height: 30px;
    flex: 0 0 30px;
    border-radius: 8px;
  }

  .qw-skeleton-copy span {
    height: 7px;
    border-radius: 2px;
  }

  .qw-skeleton-copy span:first-child {
    width: 62%;
  }

  .qw-skeleton-copy span:last-child {
    width: 86%;
  }

  @keyframes quick-pulse {
    from { opacity: 0.42; }
    to { opacity: 0.9; }
  }

  .qw-load-error {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 10px 8px 6px;
    color: var(--popover-danger);
    font-size: 11px;
    line-height: 1.35;
  }

  .qw-load-error span {
    min-width: 0;
    flex: 1;
  }

  .qw-load-error button {
    flex: 0 0 auto;
    padding: 2px 0;
    border: 0;
    border-bottom: 1px solid currentColor;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 650;
    cursor: pointer;
    transition: transform 120ms var(--ease-out);
  }

  .qw-load-error button:disabled {
    cursor: progress;
    opacity: 0.66;
  }

  .qw-load-error button:active:not(:disabled) {
    transform: scale(0.97);
  }

  .qw-retry-spinner {
    width: 9px;
    height: 9px;
    display: inline-block;
    margin-right: 4px;
    border: 1.5px solid color-mix(in srgb, currentColor 30%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: quick-spin 0.7s linear infinite;
    vertical-align: -1px;
  }

  @keyframes quick-spin {
    to { transform: rotate(360deg); }
  }

  @media (hover: hover) and (pointer: fine) {
    .channel-row:hover {
      background: var(--pop-hover);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .channel-row,
    .qw-load-error button {
      transition: none;
    }

    .qw-skeleton-avatar,
    .qw-skeleton-copy span,
    .qw-retry-spinner {
      animation: none;
      opacity: 0.66;
    }

    .channel-row:active,
    .qw-load-error button:active:not(:disabled) {
      transform: none;
    }
  }
</style>
