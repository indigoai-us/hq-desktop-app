<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import {
    buildNotificationGroups,
    type Item,
    type Kind,
    type ShareEvent,
  } from '../lib/notificationGroups';
  import { type ReactionEvent } from '../lib/reactions';
  import { ShareReactionController } from '../lib/shareReactionController.svelte';
  import ReactionBar from './messaging/ReactionBar.svelte';
  import {
    loadNotificationItems,
    getLastReadTs,
    markAllNotificationsRead,
    isUnread,
    countUnread,
    relativeTime,
    initials,
  } from '../lib/notificationFeedData';

  // Inline notifications feed — the popover's Notifications tab body and the
  // desktop Notifications page both host this component. Data loading/merging
  // and the read watermark live in `../lib/notificationFeedData` (shared with
  // the desktop page + unit tests); the pure grouping logic stays in
  // `../lib/notificationGroups`. This component owns the day/cluster
  // rendering, the compact row treatment (24px avatar/icon chip, title +
  // relative time + unread dot, muted preview line), and the row-tap routing
  // into the DM/share detail windows plus V4 desktop company Activity routes.

  interface Props {
    /** Fires whenever the unread count changes (load, event reload, mark-all-
     *  read) — the popover uses it for the segmented-control badge. */
    onunreadchange?: (count: number) => void;
    /** Hide day-group headers (the popover's flat NOTIFICATIONS list). The
     *  desktop page keeps them for the day-grouped timeline. */
    showDayLabels?: boolean;
    /** "Message the sharer" routing override. The desktop Notifications page
     *  passes an in-window route (Messages destination + pending
     *  conversation); the popover default opens the standalone Messages
     *  window with the target. */
    onmessagesharer?: (share: ShareEvent) => void;
  }

  let { onunreadchange, showDayLabels = true, onmessagesharer }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let items = $state<Item[]>([]);
  let lastReadTs = $state(getLastReadTs());

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

  const unreadCount = $derived(countUnread(items, lastReadTs));
  $effect(() => {
    onunreadchange?.(unreadCount);
  });

  // Day grouping + per-(company, actor) collapse of new-file rows lives in the
  // pure, unit-tested notificationGroups module.
  const groups = $derived(buildNotificationGroups(items));

  // Which new-file clusters are expanded inline (by cluster key).
  let expanded = $state(new Set<string>());
  function toggleCluster(key: string): void {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  }

  async function openItem(it: Item): Promise<void> {
    try {
      if (it.kind === 'dm' && it.dm) {
        await invoke('open_dm_detail', { event: it.dm });
      } else if (it.kind === 'share' && it.share) {
        await invoke('open_share_detail', { events: [it.share] });
      } else if (it.kind === 'new-file' && it.file?.company) {
        await invoke('open_desktop_alt_window', {
          route: `company:${it.file.company}:activity`,
        });
      }
    } catch (e) {
      console.error('notification-feed: open failed', e);
    }
  }

  // Share reactions: one controller for the visible share rows (bounded so a
  // deep history doesn't fan out dozens of reaction fetches). Realtime
  // `message:reaction` events reconcile it below.
  const WATCHED_SHARES_LIMIT = 30;
  const shareReactions = new ShareReactionController();
  $effect(() => {
    const ids = items
      .filter((it) => it.kind === 'share' && it.share)
      .slice(0, WATCHED_SHARES_LIMIT)
      .map((it) => it.share!.eventId);
    void shareReactions.setShares(ids);
  });

  async function messageSharer(share: ShareEvent): Promise<void> {
    if (onmessagesharer) {
      onmessagesharer(share);
      return;
    }
    try {
      await invoke('open_messages_window', {
        target: {
          personUid: share.issuerPersonUid ?? '',
          email: share.issuerEmail,
          displayName: share.issuerDisplayName,
        },
      });
    } catch (e) {
      console.error('notification-feed: open_messages_window failed', e);
    }
  }

  const clickable = (it: Item) =>
    it.kind === 'dm' || it.kind === 'share' || (it.kind === 'new-file' && Boolean(it.file?.company));

  /** Human rows (dm/share) lead with an initials avatar; ambient new-file
   *  rows keep a quiet icon chip. */
  const hasAvatar = (kind: Kind) => kind === 'dm' || kind === 'share';

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

    const unlisteners: Array<() => void> = [];
    void listen('dm:unread-summary', scheduleReload).then((u) => unlisteners.push(u));
    void listen('sync:complete', scheduleReload).then((u) => unlisteners.push(u));
    // Live reaction updates for the watched share rows.
    void listen<ReactionEvent>('message:reaction', (e) => {
      shareReactions.applyEvent(e.payload);
    }).then((u) => unlisteners.push(u));

    return () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      for (const u of unlisteners) u();
      shareReactions.dispose();
    };
  });
</script>

{#snippet leading(it: Item)}
  {#if hasAvatar(it.kind)}
    <span class="notif-avatar notif-avatar-{it.kind}" aria-hidden="true">{initials(it.actor)}</span>
  {:else}
    <span class="notif-icon-chip" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
        <path d="M9 1.5V5.5H13" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
      </svg>
    </span>
  {/if}
{/snippet}

<div class="notif-feed">
  {#if loading && items.length === 0}
    <p class="notif-status">Loading…</p>
  {:else if error}
    <p class="notif-status notif-error" role="alert">{error}</p>
  {:else if items.length === 0}
    <div class="notif-empty" role="status">
      <svg class="notif-empty-bell" width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M10.3 19.5a2 2 0 0 0 3.4 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
      <p>No notifications yet</p>
    </div>
  {:else}
    {#each groups as group (group.key)}
      <div class="notif-day">
        {#if showDayLabels}
          <div class="notif-day-label">{group.label}</div>
        {/if}
        {#each group.rows as row (row.type === 'cluster' ? row.key : row.item.id)}
          {#if row.type === 'single'}
            {@const it = row.item}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <div
              class="notif-row notif-{it.kind} reaction-hover-scope"
              class:clickable={clickable(it)}
              role={clickable(it) ? 'button' : undefined}
              tabindex={clickable(it) ? 0 : undefined}
              onclick={() => clickable(it) && openItem(it)}
              onkeydown={(e) => clickable(it) && (e.key === 'Enter' || e.key === ' ') && openItem(it)}
            >
              {@render leading(it)}
              <div class="notif-main">
                <div class="notif-line1">
                  <span class="notif-actor">{it.actor}</span>
                  <span class="notif-meta">
                    <span class="notif-time">{relativeTime(it.ts)}</span>
                    {#if isUnread(it, lastReadTs)}
                      <span class="notif-unread-dot" aria-label="Unread"></span>
                    {/if}
                  </span>
                </div>
                <div class="notif-summary">{it.summary}</div>
                {#if it.kind === 'share' && it.share}
                  {@const share = it.share}
                  <!-- Reactions + reply live inside the clickable row; stop
                       propagation so a pill/emoji/Message tap never opens the
                       share detail window. -->
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div
                    class="notif-share-actions"
                    onclick={(e) => e.stopPropagation()}
                    onkeydown={(e) => e.stopPropagation()}
                  >
                    <ReactionBar
                      messageId={share.eventId}
                      reactions={shareReactions.map[share.eventId]}
                      ontoggle={shareReactions.toggle}
                      compact
                    />
                    <button
                      class="notif-message-btn"
                      type="button"
                      onclick={() => messageSharer(share)}
                      aria-label={`Message ${it.actor}`}
                    >
                      Message
                    </button>
                  </div>
                {/if}
              </div>
            </div>
          {:else}
            {@const open = expanded.has(row.key)}
            <div
              class="notif-row notif-new-file notif-cluster clickable"
              role="button"
              tabindex="0"
              aria-expanded={open}
              onclick={() => toggleCluster(row.key)}
              onkeydown={(e) =>
                (e.key === 'Enter' || e.key === ' ') &&
                (e.preventDefault(), toggleCluster(row.key))}
            >
              <span class="notif-icon-chip" aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
                  <path d="M9 1.5V5.5H13" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
                </svg>
              </span>
              <div class="notif-main">
                <div class="notif-line1">
                  <span class="notif-actor">{row.actor}</span>
                  <span class="notif-meta">
                    <span class="notif-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
                    <span class="notif-time">{relativeTime(row.latestTs)}</span>
                    {#if row.items.some((it) => isUnread(it, lastReadTs))}
                      <span class="notif-unread-dot" aria-label="Unread"></span>
                    {/if}
                  </span>
                </div>
                <div class="notif-summary">{row.count} new files · {row.company}</div>
              </div>
            </div>
            {#if open}
              <div class="notif-cluster-files">
                {#each row.items as it (it.id)}
                  <div class="notif-file-row">
                    <span class="notif-file-path" title={it.file?.path}>{it.file?.path}</span>
                    <span class="notif-file-time">{relativeTime(it.ts)}</span>
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        {/each}
      </div>
    {/each}
  {/if}
</div>

<style>
  /* Compact feed rows (redesign): 24px leading avatar/icon chip, 13px title
     line with right-aligned relative time + blue unread dot, 12px muted
     preview line. Sized by the host (popover tab body or desktop page). */
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

  /* Empty state — bell + "No notifications yet". */
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

  .notif-day {
    margin-top: 2px;
  }
  .notif-day-label {
    position: sticky;
    top: 0;
    background: var(--popover-bg, #0b0b0d);
    color: var(--popover-text-muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 7px 2px 4px;
    z-index: 1;
  }

  .notif-row {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 7px 2px;
    border-radius: 8px;
  }
  .notif-row.clickable {
    cursor: pointer;
  }
  .notif-row.clickable:hover {
    background: var(--popover-action-hover);
  }

  /* Leading 24px chips. Human rows (dm / share) carry an initials avatar with
     a per-kind tint; ambient new-file rows keep a quiet neutral icon chip. */
  .notif-avatar {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: 0.02em;
    margin-top: 1px;
  }
  .notif-avatar-dm {
    background: rgba(126, 140, 255, 0.18);
    color: #7e8cff;
  }
  .notif-avatar-share {
    background: rgba(70, 214, 166, 0.18);
    color: #2fb98a;
  }
  .notif-icon-chip {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border-radius: 7px;
    background: var(--popover-surface);
    color: var(--popover-text-muted);
    margin-top: 1px;
  }

  .notif-main {
    flex: 1;
    min-width: 0;
  }
  .notif-line1 {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .notif-actor {
    font-size: 13px;
    font-weight: 600;
    color: var(--popover-text-heading);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .notif-meta {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .notif-time {
    font-size: 11px;
    color: var(--popover-text-muted);
    font-variant-numeric: tabular-nums;
  }
  .notif-unread-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--popover-unread, #0a84ff);
  }
  .notif-summary {
    font-size: 12px;
    color: var(--popover-text-muted);
    margin-top: 1px;
    line-height: 1.35;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  /* Share-row inline actions: compact reaction chips + a quiet Message reply
     affordance revealed with the same hover scope as the add-reaction "+". */
  .notif-share-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 3px;
    cursor: default;
  }

  .notif-message-btn {
    flex: 0 0 auto;
    border: 1px solid var(--popover-divider, rgba(255, 255, 255, 0.1));
    background: transparent;
    color: var(--popover-text-muted);
    font-family: inherit;
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
    padding: 4px 8px;
    border-radius: 999px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s ease, background-color 0.12s ease, color 0.12s ease;
  }

  .notif-row:hover .notif-message-btn,
  .notif-row:focus-within .notif-message-btn {
    opacity: 1;
  }

  .notif-message-btn:hover,
  .notif-message-btn:focus-visible {
    background: var(--popover-action-hover);
    color: var(--popover-text);
    outline: none;
  }

  .notif-chevron {
    font-size: 10px;
    color: var(--popover-text-muted);
  }

  /* Inline file list revealed when a new-file cluster is expanded. */
  .notif-cluster-files {
    padding: 2px 2px 6px 33px; /* indent under the chip */
  }
  .notif-file-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 3px 0;
  }
  .notif-file-path {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--popover-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .notif-file-time {
    flex: 0 0 auto;
    font-size: 11px;
    color: var(--popover-text-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
