<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { buildNotificationGroups, type Item } from '../lib/notificationGroups';
  import {
    loadNotificationItems,
    getLastReadTs,
    markAllNotificationsRead,
    isUnread,
    countUnread,
  } from '../lib/notificationFeedData';
  import NotificationRow from './NotificationRow.svelte';

  // Inline notifications feed — the popover's Notifications tab body and the
  // desktop Notifications page both host this component. Data loading/merging
  // and the read watermark live in `../lib/notificationFeedData` (shared with
  // the desktop page + unit tests); the pure grouping logic stays in
  // `../lib/notificationGroups`. Rows render through the shared one-line
  // NotificationRow (locked design for popover, widget stack, and Inbox).

  interface Props {
    /** Fires whenever the unread count changes (load, event reload, mark-all-
     *  read) — the popover uses it for the segmented-control badge. */
    onunreadchange?: (count: number) => void;
    /** Fires with the visible (non-dismissed) item total — desktop Inbox
     *  uses this for the subtitle count. */
    onitemschange?: (count: number) => void;
    /** Hide day-group headers (the popover's flat NOTIFICATIONS list). The
     *  desktop page keeps them for the day-grouped timeline. */
    showDayLabels?: boolean;
    /** Suppress the "No notifications yet" empty state. The popover sets this
     *  when it is rendering its own system-notice rows above the feed, so an
     *  empty data feed doesn't read as "nothing here" while a sync-paused /
     *  update row sits right above it. */
    hideEmptyState?: boolean;
    /** Visual density: popover stays compact; desktop Inbox uses roomier rows. */
    density?: 'compact' | 'comfortable';
  }

  let {
    onunreadchange,
    onitemschange,
    showDayLabels = true,
    hideEmptyState = false,
    density = 'compact',
  }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let items = $state<Item[]>([]);
  let lastReadTs = $state(getLastReadTs());

  /** Session-local dismiss — no backend dismiss API. Keys are item ids or
   *  cluster keys filtered out of the rendered groups. */
  let dismissed = $state(new Set<string>());

  function dismiss(id: string): void {
    const next = new Set(dismissed);
    next.add(id);
    dismissed = next;
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      items = await loadNotificationItems();
    } catch (e) {
      error = typeof e === 'string' ? e : 'Could not load notifications.';
      items = [];
    } finally {
      loading = false;
    }
  }

  /** Exposed so a parent can force a refresh (e.g. on popover focus). */
  export function reload(): void {
    void load();
  }

  /** Advance the read watermark — every row's unread dot clears. */
  export function markAllRead(): void {
    lastReadTs = markAllNotificationsRead();
  }

  // Day grouping + per-(company, actor) collapse of new-file rows lives in the
  // pure, unit-tested notificationGroups module. Session-dismissed ids are
  // stripped before grouping so clusters recompute without dismissed members.
  // Unread count uses the same visible set so dismiss keeps the badge in sync.
  const visibleItems = $derived(items.filter((it) => !dismissed.has(it.id)));
  const groups = $derived(buildNotificationGroups(visibleItems));
  const unreadCount = $derived(countUnread(visibleItems, lastReadTs));
  $effect(() => {
    onunreadchange?.(unreadCount);
  });
  $effect(() => {
    onitemschange?.(visibleItems.length);
  });

  async function openDm(it: Item): Promise<void> {
    if (!it.dm) return;
    try {
      await invoke('open_dm_detail', { event: it.dm });
    } catch (e) {
      console.error('notification-feed: open_dm_detail failed', e);
    }
  }

  async function openShare(it: Item): Promise<void> {
    if (!it.share) return;
    try {
      await invoke('open_share_detail', { events: [it.share] });
    } catch (e) {
      console.error('notification-feed: open_share_detail failed', e);
    }
  }

  async function openCompanyActivity(company: string): Promise<void> {
    if (!company) return;
    try {
      await invoke('open_desktop_alt_window', {
        route: `company:${company}:activity`,
      });
    } catch (e) {
      console.error('notification-feed: open activity failed', e);
    }
  }

  /** Mirror DmDetail's composer: real send_dm to the message author. */
  async function replyDm(it: Item, text: string): Promise<void> {
    const peer = it.dm?.fromPersonUid;
    if (!peer || !text.trim()) return;
    try {
      await invoke('send_dm', { toPersonUid: peer, body: text.trim() });
    } catch (e) {
      console.error('notification-feed: send_dm failed', e);
    }
  }

  /** No lightweight per-eventId DM reaction toggle exists for the feed (the
   *  full ReactionController owns a conversation slot). Send the emoji as a
   *  real DM reply body instead — same path as quick-reply. */
  async function reactDm(it: Item, emoji: string): Promise<void> {
    await replyDm(it, emoji);
  }

  // Load on mount, then keep the feed fresh by reloading when new content
  // arrives. A DM lands as `dm:unread-summary`; new files land at `sync:complete`.
  // Both are cheap signals — debounce a single reload so a burst doesn't stack
  // fetches. Listeners are torn down with the component.
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

    // `listen` registers asynchronously. A quick view swap can destroy this
    // feed before it resolves; unlisten immediately in that case instead of
    // retaining an orphaned handler in Tauri's event registry.
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (unlisten: () => void) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
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

<div class="notif-feed" class:notif-comfortable={density === 'comfortable'} data-density={density}>
  {#if loading && items.length === 0}
    <p class="notif-status">Loading…</p>
  {:else if error}
    <p class="notif-status notif-error" role="alert">{error}</p>
  {:else if items.length === 0}
    {#if !hideEmptyState}
      <div class="notif-empty" role="status">
        <svg class="notif-empty-bell" width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M10.3 19.5a2 2 0 0 0 3.4 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
        <p>No notifications yet</p>
        <span class="notif-empty-hint">Messages, shares, and new files will show up here.</span>
      </div>
    {/if}
  {:else if visibleItems.length === 0}
    {#if !hideEmptyState}
      <div class="notif-empty" role="status">
        <p>No notifications yet</p>
      </div>
    {/if}
  {:else}
    {#each groups as group (group.key)}
      <div class="notif-day">
        {#if showDayLabels}
          <div class="notif-day-label">{group.label}</div>
        {/if}
        <div class="notif-day-rows">
          {#each group.rows as row (row.type === 'cluster' ? row.key : row.item.id)}
            {#if row.type === 'single'}
              {@const it = row.item}
              {#if it.kind === 'dm' && it.dm}
                <NotificationRow
                  type="message"
                  actor={it.actor}
                  text={it.dm.body}
                  ts={it.ts}
                  unread={isUnread(it, lastReadTs)}
                  onopen={() => openDm(it)}
                  onreply={(text) => void replyDm(it, text)}
                  onreact={(emoji) => void reactDm(it, emoji)}
                />
              {:else if it.kind === 'share'}
                <NotificationRow
                  type="share"
                  actor={it.actor}
                  text={it.summary}
                  ts={it.ts}
                  unread={isUnread(it, lastReadTs)}
                  onopen={() => openShare(it)}
                  ondismiss={() => dismiss(it.id)}
                />
              {:else if it.kind === 'new-file'}
                <NotificationRow
                  type="sync"
                  text={it.summary}
                  ts={it.ts}
                  unread={isUnread(it, lastReadTs)}
                  onopen={
                    it.file?.company
                      ? () => void openCompanyActivity(it.file!.company)
                      : undefined
                  }
                  ondismiss={() => dismiss(it.id)}
                />
              {/if}
            {:else if !dismissed.has(row.key)}
              <NotificationRow
                type="sync"
                text={`${row.count} new files in ${row.company}`}
                ts={row.latestTs}
                unread={row.items.some((it) => isUnread(it, lastReadTs))}
                onopen={
                  row.company ? () => void openCompanyActivity(row.company) : undefined
                }
                ondismiss={() => dismiss(row.key)}
              />
            {/if}
          {/each}
        </div>
      </div>
    {/each}
  {/if}
</div>

<style>
  /* Feed chrome only — rows live in NotificationRow (shared one-line design). */
  .notif-feed {
    display: flex;
    flex-direction: column;
  }

  .notif-status {
    text-align: center;
    color: var(--popover-text-muted);
    font-size: var(--text-sm);
    padding: 22px 16px;
    margin: 0;
  }
  .notif-error {
    color: var(--popover-danger);
  }

  .notif-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 28px 16px;
    color: var(--popover-text-muted);
  }
  .notif-empty-bell {
    opacity: 0.7;
  }
  .notif-empty p {
    margin: 0;
    font-size: var(--text-sm);
  }
  .notif-empty-hint {
    font-size: 12px;
    opacity: 0.85;
    text-align: center;
    max-width: 28ch;
    line-height: 1.4;
  }

  .notif-day {
    margin-top: 2px;
  }
  .notif-day-label {
    position: sticky;
    top: 0;
    background: var(--popover-bg);
    color: var(--popover-text-muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 7px 2px 4px;
    z-index: 1;
  }

  .notif-day-rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  /* Desktop Inbox: roomier day sections + slightly taller rows via host tokens. */
  .notif-comfortable .notif-day {
    margin-top: 10px;
  }
  .notif-comfortable .notif-day:first-child {
    margin-top: 0;
  }
  .notif-comfortable .notif-day-label {
    padding: 10px 12px 6px;
    font-size: 11px;
    letter-spacing: 0.06em;
    border-bottom: 1px solid var(--popover-day-rule, transparent);
  }
  .notif-comfortable .notif-day-rows {
    gap: 2px;
    padding: 4px 4px 6px;
  }
  .notif-comfortable .notif-empty {
    padding: 48px 24px;
  }
  .notif-comfortable .notif-empty p {
    font-size: 14px;
    color: var(--popover-text-heading, var(--popover-text));
    font-weight: 600;
  }
</style>
