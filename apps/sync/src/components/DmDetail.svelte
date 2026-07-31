<script lang="ts">
  // One compact communications window: conversations stay in a roomy two-pane
  // master/detail view, while the Notifications tab reuses the canonical feed.
  // The outer window owns the only Liquid Glass material; all descendants are
  // flat structural layers.
  import '../styles/popover.css';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import type { Item, ShareEvent } from '../lib/notificationGroups';
  import type { Channel } from '../lib/channels';
  import { defaultSelectedId } from '../lib/quickWindowPane';
  import QuickWindowSidePane from './QuickWindowSidePane.svelte';
  import ShareMainPane from './ShareMainPane.svelte';
  import DmThreadPane, { type DmEvent } from './DmThreadPane.svelte';
  import NotificationFeed from './NotificationFeed.svelte';
  import ChannelView from './messaging/ChannelView.svelte';

  interface AppConfig {
    personUid?: string | null;
  }

  let activeTab = $state<'conversations' | 'notifications'>('conversations');

  // The DM that opened the window (the reply target).
  let event = $state<DmEvent | null>(null);
  // Explicit side-pane notification selection; null = show the opening DM.
  let selected = $state<Item | null>(null);
  let selectedChannel = $state<Channel | null>(null);
  // Session-viewed ids clear unread dots without advancing Inbox's global
  // watermark (the Notifications tab retains that chronology).
  let viewedIds = $state(new Set<string>());
  let openingFullView = $state(false);
  let fullViewError = $state<string | null>(null);
  let conversationAttentionCount = $state(0);
  let notificationAttentionCount = $state(0);
  // ChannelView needs the signed-in identity to expose owner-only roster
  // controls without guessing from a group DM's participant list.
  let selfPersonUid = $state<string | null>(null);
  // AppKit owns the blur in production. The browser harness keeps the CSS
  // fallback so visual tests still exercise a representative glass surface.
  const nativeGlass = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

  function badgeLabel(count: number): string {
    return count > 99 ? '99+' : String(count);
  }

  const selectedId = $derived(
    selected
      ? selected.id
      : selectedChannel
        ? null
        : defaultSelectedId('dm', event?.eventId),
  );

  // Full grouped conversation for a selected share row (US-016) — the main
  // pane shows every share from that sender, not just the latest.
  let selectedShareEvents = $state<ShareEvent[]>([]);

  function onselect(item: Item, conversationIds?: string[], conversationItems?: Item[]): void {
    activeTab = 'conversations';
    selectedChannel = null;
    selected = item;
    selectedShareEvents =
      item.kind === 'share'
        ? (conversationItems ?? [item]).flatMap((candidate) =>
            candidate.kind === 'share' && candidate.share ? [candidate.share] : [],
          )
        : [];
    viewedIds = new Set([...viewedIds, item.id, ...(conversationIds ?? [])]);
  }

  function selectChannel(channel: Channel): void {
    activeTab = 'conversations';
    event = null;
    selected = null;
    selectedShareEvents = [];
    selectedChannel = channel;
  }

  function handleChannelChange(channel: Channel): void {
    selectedChannel = channel;
  }

  function handleChannelRead(channelId: string): void {
    if (selectedChannel?.channelId !== channelId) return;
    selectedChannel = { ...selectedChannel, unread: 0 };
  }

  function selectTab(tab: 'conversations' | 'notifications'): void {
    activeTab = tab;
    fullViewError = null;
  }

  function handleTabKeydown(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = Array.from(
      (event.currentTarget as HTMLElement)
        .closest('[role="tablist"]')
        ?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
    );
    if (tabs.length === 0) return;
    const currentIndex = Math.max(0, tabs.indexOf(event.currentTarget as HTMLButtonElement));
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) %
            tabs.length;
    const tab = nextIndex === 0 ? 'conversations' : 'notifications';
    selectTab(tab);
    tabs[nextIndex]?.focus();
  }

  async function openFullView(): Promise<void> {
    if (openingFullView) return;
    openingFullView = true;
    fullViewError = null;
    try {
      if (activeTab === 'notifications') {
        await invoke('open_desktop_alt_window', { route: 'inbox' });
      } else {
        await invoke('open_messages_window', { target: null });
      }
    } catch (err) {
      console.error('dm-detail: open full communications view failed', err);
      fullViewError = 'Could not open the full view. Try again.';
    } finally {
      openingFullView = false;
    }
  }

  $effect(() => {
    let unlistenDetail: (() => void) | undefined;
    let unlistenChannel: (() => void) | undefined;
    let unlistenInbox: (() => void) | undefined;
    let cancelled = false;

    // Identity is additive; never delay the native event listeners or ready
    // handshake on config hydration.
    void invoke<AppConfig>('get_config')
      .then((config) => {
        if (!cancelled) selfPersonUid = config?.personUid ?? null;
      })
      .catch((err) => {
        // Non-fatal: the backend still enforces ownership when identity cannot
        // be hydrated, but the compact window must remain usable.
        console.error('dm-detail: get_config failed', err);
      });

    void (async () => {
      unlistenDetail = await listen<DmEvent>('dm:detail-event', (messageEvent) => {
        activeTab = 'conversations';
        event = messageEvent.payload;
        // Reopening this singleton window must show the just-opened DM, not a
        // stale channel/share selection from a previous open.
        selected = null;
        selectedChannel = null;
        selectedShareEvents = [];
        viewedIds = new Set([...viewedIds, `dm:${messageEvent.payload.eventId}`]);
      });
      unlistenChannel = await listen<Channel>(
        'communications:open-channel',
        (channelEvent) => {
          selectChannel(channelEvent.payload);
        },
      );
      // Retained for runtimes that still emit the legacy quick-Inbox event.
      unlistenInbox = await listen('dm:inbox-open', () => {
        activeTab = 'conversations';
        event = null;
        selected = null;
        selectedChannel = null;
        selectedShareEvents = [];
      });
      if (cancelled) {
        unlistenDetail?.();
        unlistenChannel?.();
        unlistenInbox?.();
        return;
      }
      // Ready-handshake: Rust emits a stashed opening DM only after listeners
      // are mounted, then reveals the native window.
      void invoke('dm_detail_window_ready');
    })();

    return () => {
      cancelled = true;
      unlistenDetail?.();
      unlistenChannel?.();
      unlistenInbox?.();
    };
  });
</script>

<div class="detail-window" class:native-glass={nativeGlass}>
  <header class="communications-header" data-tauri-drag-region>
    <h1>Messages</h1>
    <div class="communications-actions">
      {#if fullViewError}
        <span class="full-view-error" role="alert">{fullViewError}</span>
      {/if}
      <button
        type="button"
        class="open-full-view"
        data-testid="communications-open-full"
        disabled={openingFullView}
        aria-busy={openingFullView}
        onclick={() => void openFullView()}
      >
        {#if openingFullView}
          <span class="full-view-spinner" aria-hidden="true"></span>
        {/if}
        {openingFullView ? 'Opening…' : 'Open full view'}
      </button>
    </div>
  </header>

  <div class="communications-tabs" role="tablist" aria-label="Messages views">
    <button
      type="button"
      role="tab"
      class="communications-tab"
      class:active={activeTab === 'conversations'}
      data-testid="communications-tab-conversations"
      aria-selected={activeTab === 'conversations'}
      aria-controls="quick-conversations-panel"
      tabindex={activeTab === 'conversations' ? 0 : -1}
      onclick={() => selectTab('conversations')}
      onkeydown={handleTabKeydown}
    >
      Conversations
      {#if conversationAttentionCount > 0}
        <span class="tab-count" aria-label={`${conversationAttentionCount} unread conversations`}>
          {badgeLabel(conversationAttentionCount)}
        </span>
      {/if}
    </button>
    <button
      type="button"
      role="tab"
      class="communications-tab"
      class:active={activeTab === 'notifications'}
      data-testid="communications-tab-notifications"
      aria-selected={activeTab === 'notifications'}
      aria-controls="quick-notifications-panel"
      tabindex={activeTab === 'notifications' ? 0 : -1}
      onclick={() => selectTab('notifications')}
      onkeydown={handleTabKeydown}
    >
      Notifications
      {#if notificationAttentionCount > 0}
        <span class="tab-count" aria-label={`${notificationAttentionCount} unread notifications`}>
          {badgeLabel(notificationAttentionCount)}
        </span>
      {/if}
    </button>
  </div>

  <div class="communications-body">
    <div
      id="quick-notifications-panel"
      class="notifications-pane"
      role="tabpanel"
      aria-label="Notifications"
      hidden={activeTab !== 'notifications'}
    >
      <div class="notifications-intro">
        <h2>Recent activity</h2>
        <p>Messages, shares, workspace activity, and updates in one chronology.</p>
      </div>
      <div class="notifications-host">
        <NotificationFeed
          density="comfortable"
          showDayLabels={false}
          onunreadchange={(count) => (notificationAttentionCount = count)}
        />
      </div>
    </div>

    <div
      id="quick-conversations-panel"
      class="conversations-layout"
      role="tabpanel"
      data-testid="quick-communications-conversations"
      hidden={activeTab !== 'conversations'}
    >
      <QuickWindowSidePane
        {selectedId}
        selectedChannelId={selectedChannel?.channelId ?? null}
        {viewedIds}
        {onselect}
        onselectchannel={selectChannel}
        onattentionchange={(count) => (conversationAttentionCount = count)}
      />

      <main
        class="detail-main"
        class:group-channel={selectedChannel?.scope === 'group'}
      >
          {#if selectedChannel}
            {#key selectedChannel.channelId}
              <ChannelView
                channel={selectedChannel}
                {selfPersonUid}
                onchannelchange={handleChannelChange}
                onread={handleChannelRead}
              />
            {/key}
          {:else if selected?.kind === 'share' && selected.share}
            {@const shareEvents = selectedShareEvents.length > 0 ? selectedShareEvents : [selected.share]}
            <header class="detail-header">
              <div>
                <span class="detail-kicker">Shared with you</span>
                <h2>{selected.actor || 'Shared files'}</h2>
              </div>
              <span class="detail-count"
                >{shareEvents.length} share{shareEvents.length === 1 ? '' : 's'}</span
              >
            </header>
            <ShareMainPane events={shareEvents} />
          {:else if selected?.kind === 'dm' && selected.dm}
            <header class="detail-header">
              <div>
                <span class="detail-kicker">Direct message</span>
                <h2>{selected.dm.fromDisplayName || 'Direct Message'}</h2>
              </div>
              {#if selected.dm.fromEmail}
                <span class="detail-count">{selected.dm.fromEmail}</span>
              {/if}
            </header>
            <!-- Keyed remount per thread: a fast side-pane switch must not let an
                 older fetch_dm_thread response paint the newer selection. -->
            {#key selected.dm.eventId}
              <DmThreadPane event={selected.dm} />
            {/key}
          {:else if event}
            <header class="detail-header">
              <div>
                <span class="detail-kicker">Direct message</span>
                <h2>{event.fromDisplayName}</h2>
              </div>
              {#if event.fromEmail}
                <span class="detail-count">{event.fromEmail}</span>
              {/if}
            </header>
            {#key event.eventId}
              <DmThreadPane {event} />
            {/key}
          {:else}
            <div class="detail-empty">
              <p>Select a conversation</p>
              <span class="detail-empty-hint">
                Choose a person, shared file, group DM, or channel from the source list.
              </span>
            </div>
          {/if}
      </main>
    </div>
  </div>
</div>

<style>
  :global(html[data-window='dm-detail']),
  :global(html[data-window='dm-detail'] body) {
    margin: 0;
    padding: 0;
    background: transparent;
    color: var(--pop-text);
    color-scheme: light dark;
    font-family: var(--font-sans);
  }

  .detail-window {
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    overflow: hidden;
    border: 1px solid var(--pop-border);
    background: var(--compact-glass-bg, var(--pop-bg));
    color: var(--pop-text);
    box-shadow: inset 0 1px 0 var(--pop-highlight);
    backdrop-filter: var(--glass-filter, blur(36px) saturate(118%) contrast(102%));
    -webkit-backdrop-filter: var(--glass-filter, blur(36px) saturate(118%) contrast(102%));
    font-family: var(--font-sans);
  }

  .detail-window.native-glass {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  .communications-header {
    min-height: 52px;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    padding: 8px 18px 4px;
    box-sizing: border-box;
    background: transparent;
  }

  .detail-kicker {
    color: var(--pop-muted);
    font-size: 10.5px;
    font-weight: 650;
    letter-spacing: 0.065em;
    line-height: 1.2;
    text-transform: uppercase;
  }

  .communications-header h1 {
    margin: 0;
    color: var(--pop-text);
    font-size: 18px;
    font-weight: 680;
    letter-spacing: -0.025em;
    line-height: 1.08;
  }

  .communications-actions {
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
  }

  .open-full-view {
    flex: 0 0 auto;
    min-height: 30px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 3px 0;
    border: 0;
    border-bottom: 1px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--pop-text);
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: transform 120ms var(--ease-out);
  }

  .open-full-view:hover,
  .open-full-view:focus-visible {
    border-bottom-color: var(--pop-muted);
    outline: none;
  }

  .open-full-view:disabled {
    color: var(--pop-muted);
    cursor: progress;
  }

  .open-full-view:active:not(:disabled) {
    transform: scale(0.97);
  }

  .full-view-error {
    max-width: 28ch;
    overflow: hidden;
    color: var(--popover-danger);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .full-view-spinner {
    width: 10px;
    height: 10px;
    flex: 0 0 auto;
    border: 1.5px solid color-mix(in srgb, currentColor 28%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: full-view-spin 0.7s linear infinite;
  }

  .communications-tabs {
    min-height: 35px;
    flex: 0 0 auto;
    display: flex;
    align-items: flex-end;
    gap: 22px;
    padding: 0 18px;
    border-bottom: 1px solid var(--pop-divider);
  }

  .communications-tab {
    align-self: stretch;
    display: inline-flex;
    align-items: center;
    padding: 3px 0 0;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--pop-muted);
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    gap: 6px;
    transition: transform 120ms var(--ease-out);
  }

  .communications-tab.active {
    border-bottom-color: var(--pop-text);
    color: var(--pop-text);
  }

  .communications-tab:focus-visible {
    outline: 2px solid var(--pop-muted);
    outline-offset: 2px;
  }

  .communications-tab:active {
    transform: scale(0.97);
  }

  .tab-count {
    min-width: 14px;
    height: 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
    border-radius: var(--radius-pill);
    background: var(--pop-hover);
    color: currentColor;
    font-size: 9.5px;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .communications-body,
  .conversations-layout {
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  .communications-body {
    display: flex;
  }

  .notifications-pane[hidden],
  .conversations-layout[hidden] {
    display: none;
  }

  .conversations-layout {
    display: flex;
    background: transparent;
  }

  .detail-main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: transparent;
  }

  /* ChannelView is shared with the full Messages window, where every channel
     uses the same leading glyph. In the compact source list a group DM is a
     people conversation, not a hash-prefixed channel, so suppress that glyph
     without forking the shared conversation implementation. */
  .detail-main.group-channel :global(.channel-hash) {
    display: none;
  }

  .detail-header {
    min-height: 48px;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 18px;
    border-bottom: 1px solid var(--pop-divider);
    box-sizing: border-box;
    background: transparent;
  }

  .detail-header > div {
    min-width: 0;
    display: grid;
    gap: 3px;
  }

  .detail-header h2,
  .notifications-intro h2 {
    margin: 0;
    overflow: hidden;
    color: var(--pop-text);
    font-size: 15px;
    font-weight: 650;
    letter-spacing: -0.01em;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail-count {
    min-width: 0;
    max-width: min(42%, 36ch);
    margin-left: auto;
    overflow: hidden;
    color: var(--pop-muted);
    font-size: 11.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 28px;
    text-align: center;
  }

  .detail-empty p {
    margin: 0;
    color: var(--pop-text);
    font-size: 14px;
    font-weight: 600;
  }

  .detail-empty-hint {
    max-width: 38ch;
    color: var(--pop-muted);
    font-size: 12.5px;
    line-height: 1.45;
  }

  .notifications-pane {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 10px 18px 20px;
    box-sizing: border-box;
    background: transparent;
  }

  .notifications-intro {
    flex: 0 0 auto;
    display: grid;
    gap: 4px;
    padding: 3px 8px 11px;
    border-bottom: 1px solid var(--pop-divider);
  }

  .notifications-intro p {
    margin: 0;
    color: var(--pop-muted);
    font-size: 12.5px;
    line-height: 1.4;
  }

  .notifications-host {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding-top: 5px;
    --popover-bg: transparent;
    --popover-surface: var(--pop-hover);
    --popover-text: var(--pop-text);
    --popover-text-muted: var(--pop-muted);
    --popover-text-heading: var(--pop-text);
    --popover-action-hover: var(--pop-hover);
    --popover-divider: var(--pop-divider);
    --popover-unread: var(--pop-text);
  }

  .notifications-host :global(.nr) {
    min-height: 56px;
    padding: 8px;
    border-radius: 0;
    box-shadow: inset 0 -1px 0 var(--pop-divider);
    font-size: 13px;
  }

  .notifications-host :global(.nr-message.nr-expanded) {
    padding-block: 12px;
  }

  .notifications-host :global(.nr-primary-action),
  .notifications-host :global(.nr-primary-content) {
    gap: 10px;
  }

  .notifications-host :global(.nr-meta-type) {
    max-width: 15ch;
  }

  .notifications-host :global(.nr-actor-pill) {
    max-width: min(18ch, 44%);
  }

  @keyframes full-view-spin {
    to { transform: rotate(360deg); }
  }

  @media (max-width: 700px) {
    .communications-header {
      padding-inline: 16px;
    }

    .communications-tabs {
      padding-inline: 16px;
    }

    .notifications-pane {
      padding-inline: 16px;
    }
  }

  @media (hover: hover) and (pointer: fine) {
    .communications-tab:hover {
      color: var(--pop-text);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .open-full-view,
    .communications-tab {
      transition: none;
    }

    .full-view-spinner {
      animation-duration: 1.4s;
    }

    .open-full-view:active:not(:disabled),
    .communications-tab:active {
      transform: none;
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    .detail-window {
      background: var(--c-bg);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
  }
</style>
