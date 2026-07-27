<script lang="ts">
  import { listen } from '@tauri-apps/api/event';
  import type { Item } from '../lib/notificationGroups';
  import {
    loadNotificationItems,
    getLastReadTs,
  } from '../lib/notificationFeedData';
  import { conversationRows } from '../lib/quickWindowPane';
  import NotificationRow from './NotificationRow.svelte';

  // Left inbox strip for share-detail / dm-detail quick windows (US-011 + US-016).
  // Groups recent DMs + shares into one row per conversation so the user can
  // jump without reopening a notification. This filtered conversation surface
  // deliberately does not advance Inbox's global read watermark: doing so
  // would mark update notifications read without ever rendering them.

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
  let loadGeneration = 0;

  const rows = $derived(conversationRows(items, lastReadTs, viewedIds));

  async function load(): Promise<void> {
    const generation = ++loadGeneration;
    loading = true;
    try {
      // Full feed — conversationRows filters dm|share and caps conversations at 30.
      const next = await loadNotificationItems(undefined, { includeUpdates: false });
      if (generation !== loadGeneration) return;
      items = next;
    } catch (err) {
      if (generation !== loadGeneration) return;
      console.error('quick-window-pane: load failed', err);
      items = [];
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  // Load on mount; debounce reloads on the same signals NotificationFeed uses.
  $effect(() => {
    void load();

    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      loadGeneration += 1;
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
      loadGeneration += 1;
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

  /* US-016: subtle type hierarchy without spending a colored accent. */
  .qw-side-list :global(.nr[data-type='share'] .nr-icon) { color: var(--pop-text, #e8e8e8); }
  .qw-side-list :global(.nr[data-type='system'] .nr-icon) { color: var(--pop-muted); }
</style>
