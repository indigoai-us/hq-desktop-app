<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { safeUnlisten } from '../lib/listener-registry';
  import {
    buildNotificationGroups,
    type DayGroup,
    type Item,
  } from '../lib/notificationGroups';
  import {
    loadNotificationTimeline,
    getLastReadTs,
    markAllNotificationsRead,
    isUnread,
    countUnread,
    broadcastNotificationUnreadCount,
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
    /** Popover owns its update notice separately; Inbox includes feed updates. */
    includeUpdates?: boolean;
    /** Explicit successful hydration signal for read-watermark owners. */
    onloadstatechange?: (loaded: boolean) => void;
  }

  let {
    onunreadchange,
    onitemschange,
    showDayLabels = true,
    hideEmptyState = false,
    density = 'compact',
    includeUpdates = true,
    onloadstatechange,
  }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let items = $state<Item[]>([]);
  let lastReadTs = $state(getLastReadTs());
  let updateInstalling = $state(false);
  let updateActionGeneration = $state(0);
  let partialError = $state<string | null>(null);
  let loadGeneration = 0;
  const INITIAL_RENDER_LIMIT = { compact: 32, comfortable: 60 } as const;
  let renderLimit = $state(0);

  $effect(() => {
    renderLimit = Math.max(renderLimit, INITIAL_RENDER_LIMIT[density]);
  });

  /** Session-local dismiss — no backend dismiss API. Keys are item ids or
   *  cluster keys filtered out of the rendered groups. */
  let dismissed = $state(new Set<string>());

  function dismiss(id: string): void {
    const next = new Set(dismissed);
    next.add(id);
    dismissed = next;
  }

  async function load(): Promise<void> {
    const generation = ++loadGeneration;
    onloadstatechange?.(false);
    loading = true;
    error = null;
    partialError = null;
    try {
      const next = await loadNotificationTimeline(undefined, { includeUpdates });
      if (generation !== loadGeneration) return;
      items = next.items;
      // Preserve an expanded chronology across event-driven refreshes. Group
      // slicing naturally clamps the visible result if the new set is smaller.
      renderLimit = Math.max(renderLimit, INITIAL_RENDER_LIMIT[density]);
      const missingSources: string[] = [];
      if (next.historyState === 'failed') missingSources.push('cloud notifications');
      if (next.activityState === 'failed') missingSources.push('local activity');
      if (includeUpdates && next.updateState === 'failed') {
        missingSources.push('update status');
      }
      partialError =
        missingSources.length > 0
          ? `Some ${missingSources.join(' and ')} could not be loaded. Available notifications are still shown.`
          : null;
      const fullyLoaded =
        next.historyState === 'resolved' &&
        next.activityState === 'resolved' &&
        (!includeUpdates || next.updateState === 'resolved');
      onloadstatechange?.(fullyLoaded);
    } catch (e) {
      if (generation !== loadGeneration) return;
      error = typeof e === 'string' ? e : 'Could not load notifications.';
      onloadstatechange?.(false);
    } finally {
      if (generation === loadGeneration) loading = false;
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

  // Group the complete chronology before applying the render cap. Otherwise a
  // large workspace sync is split into misleading partial clusters at each
  // page boundary. Cluster dismissals are filtered at the row layer, while
  // individual dismissals are removed before grouping so surviving clusters
  // recompute their counts.
  const undismissedItems = $derived(items.filter((it) => !dismissed.has(it.id)));
  const allGroups = $derived(
    buildNotificationGroups(undismissedItems, Date.now(), {
      // Inbox intentionally omits day headings, so carrying an identical
      // automated notice into a second invisible day bucket only adds noise.
      aggregateRepeatedMessagesAcrossDays: !showDayLabels,
    }),
  );
  const visibleGroups = $derived.by((): DayGroup[] =>
    allGroups
      .map((group) => ({
        ...group,
        rows: group.rows.filter(
          (row) => row.type === 'single' || !dismissed.has(row.key),
        ),
      }))
      .filter((group) => group.rows.length > 0),
  );
  const visibleItems = $derived.by(() =>
    visibleGroups.flatMap((group) =>
      group.rows.flatMap((row) =>
        row.type === 'single' ? [row.item] : row.items,
      ),
    ),
  );
  const totalVisibleRows = $derived(
    visibleGroups.reduce((total, group) => total + group.rows.length, 0),
  );
  const groups = $derived.by((): DayGroup[] => {
    let rowsLeft = renderLimit;
    const page: DayGroup[] = [];
    for (const group of visibleGroups) {
      if (rowsLeft <= 0) break;
      const rows = group.rows.slice(0, rowsLeft);
      if (rows.length > 0) page.push({ ...group, rows });
      rowsLeft -= rows.length;
    }
    return page;
  });
  const renderedRowCount = $derived(
    groups.reduce((total, group) => total + group.rows.length, 0),
  );
  const remainingCount = $derived(
    Math.max(0, totalVisibleRows - renderedRowCount),
  );
  const unreadCount = $derived(countUnread(visibleItems, lastReadTs));
  $effect(() => {
    onunreadchange?.(unreadCount);
    broadcastNotificationUnreadCount(unreadCount);
  });
  $effect(() => {
    onitemschange?.(visibleItems.length);
  });

  function showMore(): void {
    renderLimit = Math.min(
      totalVisibleRows,
      renderLimit + INITIAL_RENDER_LIMIT[density],
    );
  }

  function retryLoad(): void {
    void load();
  }

  async function openDm(it: Item): Promise<void> {
    if (!it.dm) return;
    try {
      await invoke('open_dm_detail', { event: it.dm });
    } catch (e) {
      console.error('notification-feed: open_dm_detail failed', e);
      throw e;
    }
  }

  async function openShare(it: Item): Promise<void> {
    if (!it.share) return;
    try {
      await invoke('open_share_detail', { events: [it.share] });
    } catch (e) {
      console.error('notification-feed: open_share_detail failed', e);
      throw e;
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
      throw e;
    }
  }

  async function openUpdateSettings(): Promise<void> {
    try {
      await invoke('open_desktop_alt_window', { route: 'settings:updates' });
    } catch (e) {
      console.error('notification-feed: open updates failed', e);
      throw e;
    }
  }

  async function installUpdate(): Promise<void> {
    if (updateInstalling) return;
    updateInstalling = true;
    try {
      await invoke('install_update');
    } catch (e) {
      console.error('notification-feed: install_update failed', e);
      // NotificationRow owns the localized error + Retry affordance. Re-throw
      // without also creating a competing feed-level alert.
      throw e;
    } finally {
      updateInstalling = false;
    }
  }

  /** Mirror DmDetail's composer: real send_dm to the message author. */
  async function replyDm(it: Item, text: string): Promise<void> {
    const peer = it.dm?.fromPersonUid;
    if (!peer || !text.trim()) {
      throw new Error('Quick reply is missing a recipient or message');
    }
    try {
      await invoke('send_dm', { toPersonUid: peer, body: text.trim() });
    } catch (e) {
      console.error('notification-feed: send_dm failed', e);
      // NotificationRow owns the draft. Propagate the failure so it keeps the
      // text visible and offers a retry instead of reporting false success.
      throw e;
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
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      // Invalidate an in-flight snapshot immediately; the debounced reload
      // below will become the only response allowed to update this surface.
      loadGeneration += 1;
      onloadstatechange?.(false);
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        void load();
      }, 400);
    };
    const scheduleUpdateCleared = () => {
      updateInstalling = false;
      // Remount the updater row so its localized retry error cannot outlive
      // authoritative native state saying the pending update has cleared.
      updateActionGeneration += 1;
      scheduleReload();
    };

    // `listen` registers asynchronously. A quick view swap can destroy this
    // feed before it resolves; unlisten immediately in that case instead of
    // retaining an orphaned handler in Tauri's event registry.
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (unlisten: () => void) => {
      const safe = safeUnlisten(unlisten);
      if (disposed) safe();
      else unlisteners.push(safe);
    };
    const registrations = [
      listen('dm:unread-summary', scheduleReload).then(track),
      listen('sync:complete', scheduleReload).then(track),
    ];
    if (includeUpdates) {
      registrations.push(
        listen('update:available', scheduleReload).then(track),
        listen('update:cleared', scheduleUpdateCleared).then(track),
      );
    }
    // Register all native listeners before hydration starts so an update event
    // cannot slip through the mount gap.
    void Promise.allSettled(registrations).then(() => {
      if (!disposed) void load();
    });

    return () => {
      disposed = true;
      loadGeneration += 1;
      if (reloadTimer) clearTimeout(reloadTimer);
      for (const u of unlisteners) u();
    };
  });
</script>

<div class="notif-feed" class:notif-comfortable={density === 'comfortable'} data-density={density}>
  {#if loading && items.length > 0}
    <div class="notif-refreshing" role="status" aria-live="polite">
      <span class="notif-spinner" aria-hidden="true"></span>
      Refreshing notifications
    </div>
  {/if}
  {#if partialError}
    <div class="notif-status notif-partial-error" role="alert">
      <span>{partialError}</span>
      <button type="button" onclick={retryLoad}>Retry</button>
    </div>
  {/if}
  {#if error && items.length > 0}
    <div class="notif-status notif-partial-error" role="alert">
      <span>Could not refresh notifications. Showing the last available activity.</span>
      <button type="button" onclick={retryLoad}>Retry</button>
    </div>
  {/if}
  {#if loading && items.length === 0}
    <div class="notif-skeleton" aria-label="Loading notifications" role="status">
      {#each Array(5) as _}
        <div class="notif-skeleton-row">
          <span class="notif-skeleton-icon"></span>
          <span class="notif-skeleton-copy">
            <span></span>
            <span></span>
          </span>
        </div>
      {/each}
    </div>
  {:else if error && items.length === 0}
    <div class="notif-status notif-error" role="alert">
      <span>{error}</span>
      <button type="button" onclick={retryLoad}>Retry</button>
    </div>
  {:else if items.length === 0}
    {#if !hideEmptyState}
      <div class="notif-empty" role="status">
        <svg class="notif-empty-bell" width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          <path d="M10.3 19.5a2 2 0 0 0 3.4 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
        <p>No notifications yet</p>
        <span class="notif-empty-hint">Messages, shares, new files, and updates will show up here.</span>
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
                  sourceLabel="Direct message"
                  text={it.dm.body}
                  ts={it.ts}
                  unread={isUnread(it, lastReadTs)}
                  comfortable={density === 'comfortable'}
                  onopen={() => openDm(it)}
                  onreply={(text) => replyDm(it, text)}
                  onreact={(emoji) => reactDm(it, emoji)}
                />
              {:else if it.kind === 'share'}
                <NotificationRow
                  type="share"
                  actor={it.actor}
                  sourceLabel="Shared file"
                  text={it.summary}
                  ts={it.ts}
                  unread={isUnread(it, lastReadTs)}
                  comfortable={density === 'comfortable'}
                  onopen={() => openShare(it)}
                  ondismiss={() => dismiss(it.id)}
                />
              {:else if it.kind === 'new-file'}
                <NotificationRow
                  type="sync"
                  actor={it.file?.company}
                  sourceLabel="Workspace activity"
                  text={it.summary}
                  ts={it.ts}
                  unread={isUnread(it, lastReadTs)}
                  comfortable={density === 'comfortable'}
                  onopen={
                    it.file?.company
                      ? () => openCompanyActivity(it.file!.company)
                      : undefined
                  }
                  ondismiss={() => dismiss(it.id)}
                />
              {:else if it.kind === 'update' && it.update}
                {#key `${it.id}:${updateActionGeneration}`}
                  <NotificationRow
                    type="system"
                    actor="HQ"
                    sourceLabel="App update"
                    text={it.summary}
                    ts={it.ts}
                    unread={isUnread(it, lastReadTs)}
                    comfortable={density === 'comfortable'}
                    onopen={() => openUpdateSettings()}
                    onaction={() => installUpdate()}
                    actionLabel={updateInstalling ? 'Updating…' : 'Update now'}
                    actionDisabled={updateInstalling}
                  />
                {/key}
              {/if}
            {:else if row.clusterKind === 'new-file'}
              {@const contributorLabel =
                row.actors.length === 0
                  ? ''
                  : row.actors.length === 1
                    ? ` · ${row.actors[0]}`
                    : ` · ${row.actors.length} contributors`}
              <NotificationRow
                type="sync"
                actor={row.company}
                sourceLabel="Workspace activity"
                text={`${row.count} new files in ${row.company}${contributorLabel}`}
                ts={row.latestTs}
                unread={row.items.some((it) => isUnread(it, lastReadTs))}
                comfortable={density === 'comfortable'}
                onopen={
                  row.company ? () => openCompanyActivity(row.company) : undefined
                }
                ondismiss={() => dismiss(row.key)}
              />
            {:else}
              {@const latest = row.items[0]}
              <NotificationRow
                type="message"
                actor={row.actor}
                sourceLabel="Direct messages"
                text={`${row.count} similar notices · ${row.summary}`}
                ts={row.latestTs}
                unread={row.items.some((it) => isUnread(it, lastReadTs))}
                comfortable={density === 'comfortable'}
                hoverExpand={false}
                onopen={latest?.dm ? () => openDm(latest) : undefined}
              />
            {/if}
          {/each}
        </div>
      </div>
    {/each}
    {#if remainingCount > 0}
      <button
        class="notif-show-more"
        type="button"
        data-testid="notification-show-more"
        onclick={showMore}
      >
        Show {Math.min(INITIAL_RENDER_LIMIT[density], remainingCount)} more
      </button>
    {/if}
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
  .notif-error button,
  .notif-partial-error button {
    margin-left: 8px;
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
  .notif-error button:active {
    transform: scale(0.97);
  }
  .notif-partial-error {
    padding-block: 8px;
    color: var(--popover-text-muted);
  }
  .notif-partial-error button:active {
    transform: scale(0.97);
  }

  .notif-refreshing {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-height: 28px;
    color: var(--popover-text-muted);
    font-size: 11px;
  }

  .notif-spinner {
    width: 10px;
    height: 10px;
    border: 1.5px solid color-mix(in srgb, currentColor 28%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: notif-spin 0.7s linear infinite;
  }

  .notif-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 28px 16px;
    color: var(--popover-text-muted);
  }

  .notif-skeleton {
    display: flex;
    flex-direction: column;
    padding: 4px;
  }

  .notif-skeleton-row {
    min-height: 28px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--popover-divider);
    box-sizing: border-box;
  }

  .notif-skeleton-icon,
  .notif-skeleton-copy span {
    display: block;
    background: var(--popover-action-hover);
    animation: notif-pulse 1s linear infinite alternate;
  }

  .notif-skeleton-icon {
    width: 12px;
    height: 12px;
    flex: 0 0 12px;
    border-radius: 2px;
  }

  .notif-skeleton-copy {
    min-width: 0;
    flex: 1;
    display: grid;
    gap: 4px;
  }

  .notif-skeleton-copy span {
    height: 7px;
    border-radius: 2px;
  }

  .notif-skeleton-copy span:first-child {
    width: 48%;
  }

  .notif-skeleton-copy span:last-child {
    width: 82%;
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
    background:
      linear-gradient(
        to bottom,
        color-mix(in srgb, var(--popover-bg) 82%, transparent) 68%,
        transparent
      );
    color: var(--popover-text-muted);
    font-size: 9.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 5px 2px 3px;
    z-index: 1;
  }

  .notif-day-rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  /* Desktop Inbox: roomier day sections + slightly taller rows via host tokens. */
  .notif-comfortable .notif-day {
    margin-top: 6px;
  }
  .notif-comfortable .notif-day:first-child {
    margin-top: 0;
  }
  .notif-comfortable .notif-day-label {
    padding: 6px 10px 3px;
    font-size: 9.5px;
    letter-spacing: 0.08em;
    border-bottom: 1px solid var(--popover-day-rule, transparent);
  }
  .notif-comfortable .notif-day-rows {
    gap: 0;
    padding: 2px 2px 4px;
  }
  .notif-comfortable .notif-empty {
    padding: 48px 24px;
  }
  .notif-comfortable .notif-empty p {
    font-size: 14px;
    color: var(--popover-text-heading, var(--popover-text));
    font-weight: 600;
  }

  .notif-show-more {
    align-self: center;
    margin: 10px 0 4px;
    padding: 7px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--popover-text-muted);
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: transform 120ms var(--ease-out);
  }

  .notif-show-more:hover,
  .notif-show-more:focus-visible {
    background: var(--popover-action-hover);
    color: var(--popover-text);
    outline: none;
  }

  .notif-show-more:active {
    transform: scale(0.97);
  }

  @keyframes notif-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @keyframes notif-pulse {
    from { opacity: 0.42; }
    to { opacity: 0.88; }
  }

  @media (prefers-reduced-motion: reduce) {
    .notif-error button,
    .notif-partial-error button,
    .notif-show-more {
      transition: none;
    }

    .notif-spinner,
    .notif-skeleton-icon,
    .notif-skeleton-copy span {
      animation: none;
    }

    .notif-spinner {
      animation-duration: 1.4s;
    }

    .notif-error button:active,
    .notif-partial-error button:active,
    .notif-show-more:active {
      transform: none;
    }
  }
</style>
