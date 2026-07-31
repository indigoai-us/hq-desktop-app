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
    orderQuickWindowChannels,
    quickWindowChannelTimestamp,
    type ConversationRow,
  } from '../lib/quickWindowPane';
  import {
    channelDisplayName,
    companyNameFor,
    type Channel,
  } from '../lib/channels';
  import IdentityMark from './messaging/IdentityMark.svelte';

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
  let query = $state('');
  let didAutoSelect = $state(false);
  // Snapshot once per mount — matches NotificationFeed (session-stable).
  const lastReadTs = getLastReadTs();
  let loadGeneration = 0;
  let channelLoadGeneration = 0;

  const rows = $derived(conversationRows(items, lastReadTs, viewedIds));
  const orderedChannels = $derived(orderQuickWindowChannels(channels));
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
  const directEntries = $derived(
    railEntries.filter(
      (entry) => entry.kind === 'conversation' || entry.channel.scope === 'group',
    ),
  );
  const channelEntries = $derived(
    orderedChannels.filter((channel) => channel.scope !== 'group'),
  );
  const normalizedQuery = $derived(query.trim().toLocaleLowerCase());
  const filteredDirectEntries = $derived(
    directEntries.filter((entry) => {
      if (!normalizedQuery) return true;
      return entry.kind === 'conversation'
        ? `${entry.row.actor} ${entry.row.kind}`.toLocaleLowerCase().includes(normalizedQuery)
        : `${channelTitle(entry.channel)} ${channelContext(entry.channel)}`
            .toLocaleLowerCase()
            .includes(normalizedQuery);
    }),
  );
  const filteredChannelEntries = $derived(
    channelEntries.filter((channel) =>
      normalizedQuery
        ? `${channelTitle(channel)} ${channelContext(channel)}`
            .toLocaleLowerCase()
            .includes(normalizedQuery)
        : true,
    ),
  );
  const attentionCount = $derived(
    countUnreadConversations(items, lastReadTs, viewedIds) +
      channels.filter((channel) => (channel.unread ?? 0) > 0).length,
  );

  function channelTimestamp(channel: Channel): number {
    return quickWindowChannelTimestamp(channel);
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

  // Opening the compact window should land on useful content instead of an
  // empty detail pane. Preserve explicit/deep-linked selections; otherwise
  // prefer the first unread conversation, then the most recent source.
  $effect(() => {
    if (didAutoSelect || loading || loadingChannels) return;
    if (selectedId || selectedChannelId) {
      didAutoSelect = true;
      return;
    }

    const firstUnread = directEntries.find((entry) =>
      entry.kind === 'conversation'
        ? entry.row.unreadCount > 0
        : (entry.channel.unread ?? 0) > 0,
    );
    const candidate = firstUnread ?? directEntries[0];
    if (candidate?.kind === 'conversation') {
      didAutoSelect = true;
      onselect(candidate.row.latest, candidate.row.ids, candidate.row.items);
      return;
    }
    if (candidate?.kind === 'channel') {
      didAutoSelect = true;
      selectChannel(candidate.channel);
      return;
    }
    if (channelEntries[0]) {
      didAutoSelect = true;
      selectChannel(channelEntries[0]);
      return;
    }
    didAutoSelect = true;
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
  <section class="qw-section" aria-label="Message sources">
    <label class="qw-search">
      <span class="sr-only">Find a conversation</span>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="7" cy="7" r="4.25"></circle>
        <path d="m10.25 10.25 3 3"></path>
      </svg>
      <input bind:value={query} type="search" placeholder="Find a conversation" />
    </label>
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
        {#if filteredDirectEntries.length > 0}
          <div class="qw-side-label" id="quick-conversations-label">Direct messages</div>
        {/if}
        {#each filteredDirectEntries as entry (entry.key)}
          {#if entry.kind === 'conversation'}
            {@const row = entry.row}
            {@const isSelected = selectedId != null && row.ids.includes(selectedId)}
            <button
              type="button"
              class="conversation-row"
              class:active={isSelected}
              class:unread={!isSelected && row.unreadCount > 0}
              data-testid="quick-conversation-row"
              data-kind={row.kind}
              aria-current={isSelected ? 'true' : undefined}
              aria-label={`${row.actor}${row.kind === 'share' ? ', shared files' : ''}${!isSelected && row.unreadCount > 0 ? `, ${row.unreadCount} unread` : ''}`}
              onclick={() => onselect(row.latest, row.ids, row.items)}
            >
              <IdentityMark kind={row.agent ? 'agent' : 'person'} label={row.actor} size="small" />
              <strong>{row.actor}</strong>
              {#if row.kind === 'share'}
                <span class="row-kind" title="Shared files" aria-hidden="true">↗</span>
              {/if}
              {#if !isSelected && row.unreadCount > 0}
                <span class="row-unread-count" data-testid="quick-unread-count">
                  {row.unreadCount > 99 ? '99+' : row.unreadCount}
                </span>
              {/if}
            </button>
          {:else}
            {@const channel = entry.channel}
            {@const isSelected = selectedChannelId === channel.channelId}
            <button
              type="button"
              class="conversation-row group-dm-row"
              class:active={isSelected}
              class:unread={!isSelected && (channel.unread ?? 0) > 0}
              data-testid="quick-channel-row"
              data-provenance="group-dm"
              aria-current={isSelected ? 'true' : undefined}
              aria-label={`${channelTitle(channel)}, ${channelContext(channel)}${channel.unread ? `, ${channel.unread} unread` : ''}`}
              onclick={() => selectChannel(channel)}
            >
              <IdentityMark
                kind="group"
                label={channelTitle(channel)}
                members={(channel.members ?? []).map((member) => member.displayName)}
                size="small"
              />
              <strong>{channelTitle(channel)}</strong>
              {#if !isSelected && (channel.unread ?? 0) > 0}
                <span class="row-unread-count" data-testid="quick-unread-count">
                  {(channel.unread ?? 0) > 99 ? '99+' : channel.unread}
                </span>
              {/if}
            </button>
          {/if}
        {/each}

        {#if filteredChannelEntries.length > 0}
          <div class="qw-side-label">Channels</div>
        {/if}
        {#each filteredChannelEntries as channel (`channel:${channel.channelId}`)}
          {@const isSelected = selectedChannelId === channel.channelId}
          <button
            type="button"
            class="conversation-row channel-row"
            class:active={isSelected}
            class:unread={!isSelected && (channel.unread ?? 0) > 0}
            data-testid="quick-channel-row"
            data-provenance="channel"
            aria-current={isSelected ? 'true' : undefined}
            aria-label={`${channelTitle(channel)}, ${channelContext(channel)}${channel.unread ? `, ${channel.unread} unread` : ''}`}
            onclick={() => selectChannel(channel)}
          >
            <IdentityMark
              kind="channel"
              privateChannel={channel.visibility === 'private'}
              size="small"
            />
            <strong>{channelDisplayName(channel)}</strong>
            {#if !isSelected && (channel.unread ?? 0) > 0}
              <span class="row-unread-count" data-testid="quick-unread-count">
                {(channel.unread ?? 0) > 99 ? '99+' : channel.unread}
              </span>
            {/if}
          </button>
        {/each}
        {#if normalizedQuery && filteredDirectEntries.length === 0 && filteredChannelEntries.length === 0}
          <p class="qw-side-status">No conversations match “{query.trim()}”.</p>
        {/if}
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
    width: 276px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
    border-right: 1px solid var(--pop-divider);
    padding: 10px 8px 18px;
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

  .qw-search {
    height: 32px;
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0 4px 4px;
    padding: 0 9px;
    border: 1px solid var(--pop-divider);
    border-radius: 7px;
    background: color-mix(in srgb, var(--pop-hover) 55%, transparent);
    color: var(--pop-muted);
  }

  .qw-search:focus-within {
    border-color: color-mix(in srgb, var(--pop-text) 42%, var(--pop-divider));
    color: var(--pop-text);
  }

  .qw-search svg {
    width: 13px;
    height: 13px;
    flex: 0 0 13px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-width: 1.5;
  }

  .qw-search input {
    min-width: 0;
    flex: 1;
    padding: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--pop-text);
    font: inherit;
    font-size: 12px;
  }

  .qw-search input::placeholder {
    color: var(--pop-muted);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .qw-side-label {
    flex-shrink: 0;
    padding: 12px 8px 5px;
    color: var(--pop-muted);
    font-size: 10.5px;
    font-weight: 650;
    letter-spacing: 0.055em;
    line-height: 1.2;
    text-transform: none;
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

  .conversation-row {
    width: 100%;
    min-height: 34px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--pop-muted);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: transform 110ms var(--ease-out);
  }

  .conversation-row.active {
    background: var(--compact-glass-selected, var(--pop-hover));
    color: var(--pop-text);
  }

  .conversation-row.unread {
    color: var(--pop-text);
  }

  .conversation-row:focus-visible {
    outline: 2px solid var(--pop-text);
    outline-offset: -2px;
  }

  .conversation-row:active {
    transform: scale(0.98);
  }

  .conversation-row > strong {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .conversation-row.unread > strong {
    font-weight: 700;
  }

  .row-kind {
    flex: 0 0 auto;
    color: var(--pop-muted);
    font-size: 11px;
  }

  .row-unread-count {
    min-width: 17px;
    height: 17px;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 5px;
    border: 1px solid var(--pop-divider);
    border-radius: 999px;
    background: var(--pop-hover);
    color: var(--pop-text);
    font-size: 9.5px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .qw-skeleton-copy {
    min-width: 0;
    flex: 1;
    display: grid;
    gap: 4px;
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
    .conversation-row:hover {
      background: var(--pop-hover);
      color: var(--pop-text);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .conversation-row,
    .qw-load-error button {
      transition: none;
    }

    .qw-skeleton-avatar,
    .qw-skeleton-copy span,
    .qw-retry-spinner {
      animation: none;
      opacity: 0.66;
    }

    .conversation-row:active,
    .qw-load-error button:active:not(:disabled) {
      transform: none;
    }
  }
</style>
