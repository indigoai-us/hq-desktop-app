<script lang="ts">
  // One compact communications window: conversations stay in a roomy two-pane
  // master/detail view, while the Notifications tab reuses the canonical feed.
  // The outer window owns the only Liquid Glass material; all descendants are
  // flat structural layers.
  import '../styles/popover.css';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { safeUnlisten } from '../lib/listener-registry';
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

  async function openFullView(): Promise<void> {
    if (openingFullView) return;
    openingFullView = true;
    fullViewError = null;
    try {
      if (activeTab === 'notifications') {
        await invoke('open_desktop_alt_window', { route: 'inbox' });
      } else {
        await invoke('open_desktop_alt_window', { route: 'messages' });
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
        safeUnlisten(unlistenDetail)();
        safeUnlisten(unlistenChannel)();
        safeUnlisten(unlistenInbox)();
        return;
      }
      // Ready-handshake: Rust emits a stashed opening DM only after listeners
      // are mounted, then reveals the native window.
      void invoke('dm_detail_window_ready');
    })();

    return () => {
      cancelled = true;
      safeUnlisten(unlistenDetail)();
      safeUnlisten(unlistenChannel)();
      safeUnlisten(unlistenInbox)();
    };
  });
</script>

<div class="detail-window" class:native-glass={nativeGlass}>
  {#if fullViewError}
    <div class="full-view-error-banner" role="alert">{fullViewError}</div>
  {/if}
  <div class="communications-body">
    <div
      id="quick-notifications-panel"
      class="notifications-pane"
      role="tabpanel"
      aria-label="Notifications"
      hidden={activeTab !== 'notifications'}
    >
      <header class="notifications-toolbar" data-tauri-drag-region>
        <button type="button" onclick={() => selectTab('conversations')}>← Messages</button>
        <div>
          <strong>Mentions & activity</strong>
          {#if notificationAttentionCount > 0}
            <span>{badgeLabel(notificationAttentionCount)} unread</span>
          {/if}
        </div>
        <button
          type="button"
          class="notifications-open-full"
          disabled={openingFullView}
          aria-busy={openingFullView}
          onclick={() => void openFullView()}
        >{openingFullView ? 'Opening…' : 'Open inbox ↗'}</button>
      </header>
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
        onopenfull={() => void openFullView()}
        onopenactivity={() => selectTab('notifications')}
        onnewmessage={() => void openFullView()}
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

  .notifications-toolbar {
    min-height: 52px;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 14px;
    padding: 0 18px;
    border-bottom: 1px solid var(--pop-divider);
  }

  .notifications-toolbar > div {
    display: flex;
    align-items: baseline;
    gap: 7px;
  }

  .notifications-toolbar strong {
    color: var(--pop-text);
    font-size: 14px;
  }

  .notifications-toolbar span {
    color: var(--pop-muted);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
  }

  .notifications-toolbar button {
    width: fit-content;
    padding: 5px 0;
    border: 0;
    background: transparent;
    color: var(--pop-muted);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }

  .notifications-toolbar button:hover,
  .notifications-toolbar button:focus-visible {
    color: var(--pop-text);
  }

  .notifications-open-full {
    justify-self: end;
  }

  .detail-window.native-glass {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  .full-view-error-banner {
    position: absolute;
    top: 8px;
    left: 50%;
    z-index: 8;
    transform: translateX(-50%);
    padding: 6px 10px;
    border: 1px solid color-mix(in srgb, var(--popover-danger) 45%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--compact-glass-bg, var(--pop-bg)) 92%, transparent);
    color: var(--popover-danger);
    font-size: 11px;
  }

  .detail-kicker {
    color: var(--pop-muted);
    font-size: 10.5px;
    font-weight: 650;
    letter-spacing: 0.065em;
    line-height: 1.2;
    text-transform: uppercase;
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
    min-height: 30px;
    padding: 4px 8px;
    border-radius: 0;
    box-shadow: inset 0 -1px 0 var(--pop-divider);
    font-size: 13px;
  }

  .notifications-host :global(.nr-message.nr-expanded) {
    padding-block: 8px;
  }

  .notifications-host :global(.nr-primary-action),
  .notifications-host :global(.nr-primary-content) {
    gap: 8px;
  }

  .notifications-host :global(.nr-meta-type) {
    max-width: 15ch;
  }

  .notifications-host :global(.nr-actor) {
    max-width: min(18ch, 44%);
  }

  @media (max-width: 700px) {
    .notifications-pane {
      padding-inline: 16px;
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
