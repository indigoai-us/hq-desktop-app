<script lang="ts">
  import { onDestroy } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import type { Item } from '../lib/notificationGroups';
  import {
    loadNotificationItems,
    getLastReadTs,
    markAllNotificationsRead,
    initials,
    relativeTime,
  } from '../lib/notificationFeedData';
  import { conversationRows } from '../lib/quickWindowPane';

  // Left inbox strip for share-detail / dm-detail quick windows (US-011 + US-016).
  // Groups recent DMs + shares into one row per conversation so the user can
  // jump without reopening a notification. Read watermark advances on leave
  // (US-008 pattern from InboxPage) once the feed has loaded.
  //
  // Visuals follow Lizzie frosted list language (avatar chip + actor + preview
  // + relative time) rather than the denser one-line NotificationRow chrome.

  interface Props {
    selectedId: string | null;
    viewedIds: ReadonlySet<string>;
    onselect: (item: Item, conversationIds?: string[], conversationItems?: Item[]) => void;
  }

  let { selectedId, viewedIds, onselect }: Props = $props();

  let items = $state<Item[]>([]);
  let loading = $state(true);
  // Snapshot once per mount — matches NotificationFeed (session-stable).
  const lastReadTs = getLastReadTs();
  let feedLoaded = false;

  const rows = $derived(conversationRows(items, lastReadTs, viewedIds));

  async function load(): Promise<void> {
    loading = true;
    try {
      // Full feed — conversationRows filters dm|share and caps conversations at 30.
      items = await loadNotificationItems();
      feedLoaded = true;
    } catch (err) {
      console.error('quick-window-pane: load failed', err);
      items = [];
    } finally {
      loading = false;
    }
  }

  // Viewing the pane counts as reading the inbox strip: advance the watermark
  // when the window hides or unmounts, gated on a successful load so a flash
  // before data arrives cannot swallow unread state.
  function commitRead(): void {
    if (!feedLoaded) return;
    markAllNotificationsRead();
  }

  onDestroy(commitRead);

  $effect(() => {
    window.addEventListener('pagehide', commitRead);
    return () => window.removeEventListener('pagehide', commitRead);
  });

  // Load on mount; debounce reloads on the same signals NotificationFeed uses.
  $effect(() => {
    void load();

    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        void load();
      }, 400);
    };

    // Disposed flag: run a late unlisten immediately if the pane unmounts
    // before the async listen() registration resolves (no handler leak).
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (u: () => void) => {
      if (disposed) u();
      else unlisteners.push(u);
    };
    void listen('dm:unread-summary', scheduleReload).then(track);
    void listen('sync:complete', scheduleReload).then(track);

    return () => {
      disposed = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      for (const u of unlisteners) u();
    };
  });

  function previewText(row: (typeof rows)[number]): string {
    if (row.latest.kind === 'dm') return row.latest.dm?.body ?? row.latest.summary;
    return row.latest.summary;
  }
</script>

<aside class="qw-side-pane" aria-label="Inbox">
  <div class="qw-side-label">Inbox</div>

  {#if loading && items.length === 0}
    <p class="qw-side-status">Loading…</p>
  {:else if rows.length === 0}
    <p class="qw-side-status">No conversations</p>
  {:else}
    <div class="qw-side-list">
      {#each rows as row (row.key)}
        {@const isSelected = selectedId != null && row.ids.includes(selectedId)}
        {@const unread = !isSelected && row.unreadCount > 0}
        <button
          type="button"
          class="qw-row"
          class:qw-row-selected={isSelected}
          class:qw-row-unread={unread}
          data-kind={row.kind}
          data-testid="notification-row"
          aria-current={isSelected ? 'true' : undefined}
          onclick={() => onselect(row.latest, row.ids, row.items)}
        >
          <span class="qw-av" aria-hidden="true" data-kind={row.kind}>
            {initials(row.actor)}
          </span>
          <span class="qw-copy">
            <span class="qw-top">
              <span class="qw-actor">
                {row.actor}{#if row.agent}<span class="qw-agent" title="Agent" aria-label="Agent">✦</span>{/if}
              </span>
              <span class="qw-ts">{relativeTime(row.latest.ts)}</span>
            </span>
            <span class="qw-preview">{previewText(row)}</span>
          </span>
          {#if unread}
            {#if row.unreadCount > 1}
              <span class="qw-badge" data-testid="unread-count" aria-label="{row.unreadCount} unread"
                >{row.unreadCount}</span
              >
            {:else}
              <span class="qw-dot" aria-label="Unread"></span>
            {/if}
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</aside>

<style>
  .qw-side-pane {
    width: 248px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--pop-divider, rgba(255, 255, 255, 0.1));
    padding: 10px 8px 12px;
    overflow-y: auto;
    box-sizing: border-box;
    background: color-mix(in srgb, var(--c-bg, #2b2b2e) 88%, #000 12%);
    scrollbar-width: thin;
    scrollbar-color: var(--pop-muted) transparent;
  }

  .qw-side-pane::-webkit-scrollbar {
    width: 6px;
  }

  .qw-side-pane::-webkit-scrollbar-thumb {
    background: var(--pop-hover);
    border-radius: 3px;
  }

  .qw-side-label {
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--pop-muted);
    padding: 4px 10px 10px;
    flex-shrink: 0;
  }

  .qw-side-status {
    margin: 0;
    padding: 12px 10px;
    font-size: 12.5px;
    color: var(--pop-muted);
  }

  .qw-side-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
  }

  .qw-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 52px;
    padding: 8px 10px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    box-sizing: border-box;
    transition: background-color 0.12s ease;
  }

  .qw-row:hover {
    background: var(--pop-hover, rgba(255, 255, 255, 0.08));
  }

  .qw-row-selected {
    background: var(--pop-hover, rgba(255, 255, 255, 0.08));
    box-shadow: inset 2px 0 0 var(--pop-accent, #6cb2ff);
  }

  .qw-row:focus-visible {
    outline: 1.5px solid var(--pop-accent, #6cb2ff);
    outline-offset: 1px;
  }

  .qw-av {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.02em;
    color: var(--pop-text);
    background: var(--pop-hover);
    border: 0.5px solid var(--pop-border);
  }

  .qw-av[data-kind='share'] {
    border-radius: 8px;
    color: var(--pop-accent, #6cb2ff);
  }

  .qw-copy {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .qw-top {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .qw-actor {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--pop-text);
  }

  .qw-row-unread .qw-actor {
    font-weight: 650;
  }

  .qw-agent {
    margin-left: 4px;
    font-size: 10px;
    color: var(--pop-muted);
  }

  .qw-ts {
    flex-shrink: 0;
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    color: var(--pop-muted);
  }

  .qw-preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11.5px;
    line-height: 1.3;
    color: var(--pop-muted);
  }

  .qw-row-unread .qw-preview {
    color: color-mix(in srgb, var(--pop-text) 72%, var(--pop-muted));
  }

  .qw-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--pop-accent, #6cb2ff);
    flex-shrink: 0;
  }

  .qw-badge {
    min-width: 16px;
    height: 15px;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--pop-accent, #6cb2ff);
    color: #fff;
    font-size: 10px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  @media (prefers-color-scheme: light) {
    .qw-side-pane {
      background: color-mix(in srgb, var(--c-bg, #fff) 94%, #000 6%);
    }
  }
</style>
