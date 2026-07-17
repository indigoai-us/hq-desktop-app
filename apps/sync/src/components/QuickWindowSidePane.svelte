<script lang="ts">
  import { onDestroy } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import type { Item } from '../lib/notificationGroups';
  import {
    loadNotificationItems,
    getLastReadTs,
    markAllNotificationsRead,
  } from '../lib/notificationFeedData';
  import { conversationRows } from '../lib/quickWindowPane';
  import NotificationRow from './NotificationRow.svelte';

  // Left inbox strip for share-detail / dm-detail quick windows (US-011 + US-016).
  // Groups recent DMs + shares into one row per conversation so the user can
  // jump without reopening a notification. Read watermark advances on leave
  // (US-008 pattern from InboxPage) once the feed has loaded.

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
</script>

<aside class="qw-side-pane" aria-label="Inbox">
  <div class="qw-side-label">INBOX</div>

  {#if loading && items.length === 0}
    <p class="qw-side-status">Loading…</p>
  {:else if rows.length === 0}
    <p class="qw-side-status">No conversations</p>
  {:else}
    <div class="qw-side-list">
      {#each rows as row (row.key)}
        {@const isSelected = selectedId != null && row.ids.includes(selectedId)}
        <NotificationRow
          type={row.kind === 'dm' ? 'message' : 'share'}
          actor={row.actor}
          text={row.latest.kind === 'dm' ? (row.latest.dm?.body ?? row.latest.summary) : row.latest.summary}
          ts={row.latest.ts}
          unread={!isSelected && row.unreadCount > 0}
          badgeCount={isSelected ? 0 : row.unreadCount}
          agentActor={row.agent}
          selected={isSelected}
          hoverExpand={false}
          onopen={() => onselect(row.latest, row.ids, row.items)}
        />
      {/each}
    </div>
  {/if}
</aside>

<style>
  .qw-side-pane {
    width: 208px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--pop-divider);
    padding: 8px 6px;
    overflow-y: auto;
    box-sizing: border-box;
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
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--pop-muted);
    padding: 4px 8px 8px;
    flex-shrink: 0;
  }

  .qw-side-status {
    margin: 0;
    padding: 8px;
    font-size: 0.75rem;
    color: var(--pop-muted);
  }

  .qw-side-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
  }

  /* US-016: subtle type hierarchy — share accent tint; system muted. */
  .qw-side-list :global(.nr[data-type='share'] .nr-icon) { color: var(--pop-accent, #6aa1ff); }
  .qw-side-list :global(.nr[data-type='system'] .nr-icon) { color: var(--pop-muted); }
</style>
