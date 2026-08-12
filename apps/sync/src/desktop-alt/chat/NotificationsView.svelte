<script lang="ts">
  /**
   * Unified Notifications feed (US-012).
   *
   * Main-pane view opened from the titlebar bell. Lists hq-pro NOTIF store rows
   * with day groups, All | Unread filter, Mark all read, inline actionKind
   * buttons, and optimistic read-state. Pure mapping lives in
   * notifications-model.ts.
   */
  import { invoke } from '@tauri-apps/api/core';
  import {
    buildNotificationsView,
    classifyNotificationsError,
    emptyFeedState,
    NOTIFICATIONS_EMPTY_MESSAGE,
    NOTIFICATIONS_UNREAD_EMPTY_MESSAGE,
    NOTIFICATIONS_UNSUPPORTED_MESSAGE,
    parseNotificationsResponse,
    reduceAck,
    reduceActionUsed,
    reduceFeedLoaded,
    reduceFilter,
    reduceReadAll,
    type NotificationsFeedState,
    type NotificationsFilter,
  } from './notifications-model';
  import { presentPanelError } from '../lib/panel-error';
  import '../v4/tokens.css';
  import './chat-tokens.css';

  interface Props {
    onback?: () => void;
    /** Fires whenever store unreadCount changes (drives titlebar badge). */
    onunreadchange?: (count: number) => void;
  }

  let { onback, onunreadchange }: Props = $props();

  let feedState = $state(emptyFeedState('all') as NotificationsFeedState);
  let loading = $state(true);
  let listKind = $state('ok' as 'ok' | 'unsupported' | 'auth' | 'generic');
  let listError = $state(null as string | null);
  let markAllPending = $state(false);
  let actionPendingId = $state(null as string | null);
  let loadGeneration = 0;

  const view = $derived(buildNotificationsView(feedState));
  /** Track filter as a primitive so load effect does not re-fire on every feedState rewrite. */
  const filter = $derived(feedState.filter);
  const unreadCount = $derived(feedState.unreadCount);
  const showEmpty = $derived(
    !loading && view.visibleCount === 0 && listKind !== 'auth',
  );
  const emptyCopy = $derived.by(() => {
    if (listKind === 'unsupported') return NOTIFICATIONS_UNSUPPORTED_MESSAGE;
    if (filter === 'unread') return NOTIFICATIONS_UNREAD_EMPTY_MESSAGE;
    return NOTIFICATIONS_EMPTY_MESSAGE;
  });

  let lastReportedUnread = $state<number | null>(null);

  // Only re-fetch when All | Unread toggles — never when items/unreadCount update.
  $effect(() => {
    const unreadOnly = filter === 'unread';
    void loadFeed(unreadOnly);
  });

  // Parent badge: fire only when the count actually changes (avoids effect loops).
  $effect(() => {
    const n = unreadCount;
    if (lastReportedUnread === n) return;
    lastReportedUnread = n;
    onunreadchange?.(n);
  });

  async function loadFeed(unreadOnly: boolean): Promise<void> {
    const generation = ++loadGeneration;
    loading = true;
    listError = null;
    listKind = 'ok';
    try {
      const raw = await invoke<unknown>('fetch_notifications', {
        limit: 50,
        cursor: null,
        unreadOnly,
      });
      if (generation !== loadGeneration) return;
      const parsed = parseNotificationsResponse(raw);
      feedState = reduceFeedLoaded(feedState, parsed);
      listKind = 'ok';
    } catch (err) {
      if (generation !== loadGeneration) return;
      console.error('notifications-view: fetch_notifications failed', err);
      const kind = classifyNotificationsError(err);
      listKind = kind;
      if (kind === 'unsupported') {
        feedState = reduceFeedLoaded(feedState, {
          items: [],
          unreadCount: 0,
          nextCursor: null,
        });
      } else {
        listError =
          kind === 'auth'
            ? 'Sign in to see notifications'
            : presentPanelError(err, { surface: 'notifications' }).message;
      }
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  function setFilter(next: NotificationsFilter): void {
    if (feedState.filter === next) return;
    // $effect re-fetches when filter changes (All vs Unread).
    feedState = reduceFilter(feedState, next);
  }

  async function handleRowClick(id: string, status: string): Promise<void> {
    if (status !== 'unread') return;
    const prev = feedState;
    feedState = reduceAck(feedState, id);
    try {
      await invoke('ack_notification', { id });
    } catch (err) {
      console.error('notifications-view: ack_notification failed', err);
      feedState = prev;
    }
  }

  async function handleMarkAllRead(): Promise<void> {
    if (markAllPending || feedState.unreadCount === 0) return;
    markAllPending = true;
    const prev = feedState;
    feedState = reduceReadAll(feedState);
    try {
      await invoke('read_all_notifications');
    } catch (err) {
      console.error('notifications-view: read_all_notifications failed', err);
      feedState = prev;
    } finally {
      markAllPending = false;
    }
  }

  async function handleAction(
    notificationId: string,
    actionKind: string,
    actionRef: string | null,
  ): Promise<void> {
    if (actionPendingId) return;
    const row = feedState.items.find((i) => i.id === notificationId);
    if (!row || row.actionUsed) return;
    actionPendingId = notificationId;
    const prev = feedState;
    feedState = reduceActionUsed(feedState, notificationId);
    try {
      await invoke('run_notification_action', {
        id: notificationId,
        actionKind,
        actionRef,
      });
    } catch (err) {
      console.error('notifications-view: run_notification_action failed', err);
      feedState = prev;
    } finally {
      actionPendingId = null;
    }
  }
</script>

<section
  class="notifications-view chat-shell"
  aria-labelledby="notifications-title"
  data-testid="notifications-view"
>
  <header class="notif-header">
    <div class="notif-header-leading">
      <button
        type="button"
        class="notif-back"
        data-testid="notifications-back"
        aria-label="Back"
        onclick={() => onback?.()}
      >
        ← Back
      </button>
      <h1 id="notifications-title" data-testid="notifications-title">
        {view.headerTitle}
      </h1>
    </div>

    <div class="notif-header-actions">
      <div
        class="notif-toggle"
        role="group"
        aria-label="Filter notifications"
        data-testid="notifications-filter"
      >
        <button
          type="button"
          class="notif-toggle-btn"
          class:active={feedState.filter === 'all'}
          aria-pressed={feedState.filter === 'all'}
          data-testid="notifications-filter-all"
          onclick={() => setFilter('all')}
        >
          All
        </button>
        <button
          type="button"
          class="notif-toggle-btn"
          class:active={feedState.filter === 'unread'}
          aria-pressed={feedState.filter === 'unread'}
          data-testid="notifications-filter-unread"
          onclick={() => setFilter('unread')}
        >
          Unread
        </button>
      </div>
      <button
        type="button"
        class="notif-mark-all"
        data-testid="notifications-mark-all-read"
        disabled={markAllPending || feedState.unreadCount === 0}
        aria-busy={markAllPending}
        onclick={() => void handleMarkAllRead()}
      >
        {markAllPending ? 'Marking…' : 'Mark all read'}
      </button>
    </div>
  </header>

  <div class="notif-body" data-testid="notifications-list">
    {#if loading && feedState.items.length === 0}
      <div class="notif-status" data-testid="notifications-loading" role="status">
        Loading notifications…
      </div>
    {:else if listError && listKind === 'auth'}
      <div class="notif-status" data-testid="notifications-auth" role="status">
        {listError}
      </div>
    {:else if listError && listKind === 'generic' && feedState.items.length === 0}
      <div class="notif-status" data-testid="notifications-error" role="alert">
        {listError}
      </div>
    {:else if showEmpty}
      <div class="notif-status" data-testid="notifications-empty" role="status">
        {emptyCopy}
      </div>
    {:else}
      {#each view.groups as group (group.key)}
        <section class="notif-day" data-testid="notifications-day-group">
          <h2 class="notif-day-label">{group.label}</h2>
          <ul class="notif-day-rows">
            {#each group.items as row (row.id)}
              <li>
                <!-- div (not button) so inline action buttons stay valid HTML -->
                <div
                  class="notif-row"
                  class:unread={row.status === 'unread'}
                  role="button"
                  tabindex="0"
                  data-testid="notifications-row"
                  data-notification-id={row.id}
                  data-type={row.serverType}
                  data-display-kind={row.displayKind}
                  onclick={() => void handleRowClick(row.id, row.status)}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void handleRowClick(row.id, row.status);
                    }
                  }}
                >
                  <span class="notif-avatar" aria-hidden="true">
                    {row.actorInitials}
                  </span>
                  <span class="notif-main">
                    <span class="notif-verb">
                      <strong>{row.actorName}</strong>
                      {row.verbText.startsWith(row.actorName)
                        ? row.verbText.slice(row.actorName.length)
                        : ` ${row.verbText}`}
                    </span>
                    {#if row.contextLine}
                      <span class="notif-context">{row.contextLine}</span>
                    {/if}
                    {#if row.actionButtons.length > 0}
                      <span class="notif-actions" role="group" aria-label="Actions">
                        {#each row.actionButtons as btn (btn.id)}
                          <button
                            type="button"
                            class={`notif-action-btn ${btn.variant}`}
                            data-testid="notifications-action"
                            data-action-kind={btn.actionKind}
                            disabled={row.actionUsed || actionPendingId === row.id}
                            onclick={(e) => {
                              e.stopPropagation();
                              void handleAction(row.id, btn.actionKind, row.actionRef);
                            }}
                          >
                            {btn.label}
                          </button>
                        {/each}
                      </span>
                    {/if}
                  </span>
                  <span class="notif-meta">
                    <span
                      class="notif-type-icon"
                      data-testid="notifications-type-icon"
                      data-icon={row.typeIcon}
                      aria-hidden="true"
                    >
                      <svg viewBox="0 0 16 16" fill="none" width="14" height="14">
                        {#if row.typeIcon === 'mention'}
                          <circle cx="8" cy="8" r="5.25" stroke="currentColor" stroke-width="1.2" />
                          <path d="M5.5 8.5c0 1.5 1 2.5 2.5 2.5s2.5-1 2.5-2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                          <path d="M10.5 5.5v3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                        {:else if row.typeIcon === 'agent'}
                          <rect x="3" y="4" width="10" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2" />
                          <circle cx="6.25" cy="8" r="0.9" fill="currentColor" />
                          <circle cx="9.75" cy="8" r="0.9" fill="currentColor" />
                        {:else if row.typeIcon === 'review'}
                          <circle cx="8" cy="8" r="5.25" stroke="currentColor" stroke-width="1.2" />
                          <path d="M5.5 8.2l1.7 1.7 3.3-3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
                        {:else if row.typeIcon === 'file'}
                          <path d="M5 2.75h4.2L12 5.55V13.25H5V2.75Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                          <path d="M9.1 2.9v2.8H12" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                        {:else if row.typeIcon === 'dm'}
                          <path d="M2.75 4.25h10.5v7.5H6.5L3.5 13.5V4.25Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                        {:else if row.typeIcon === 'flag'}
                          <path d="M4.25 2.75v10.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                          <path d="M4.25 3.25h7L9.5 6.25l1.75 3H4.25" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                        {:else}
                          <circle cx="8" cy="8" r="5.25" stroke="currentColor" stroke-width="1.2" />
                          <circle cx="8" cy="8" r="1.1" fill="currentColor" />
                        {/if}
                      </svg>
                    </span>
                    {#if row.timestampLabel}
                      <time class="notif-ts" datetime={row.createdAt}>
                        {row.timestampLabel}
                      </time>
                    {/if}
                    {#if row.status === 'unread'}
                      <span
                        class="notif-unread-dot"
                        data-testid="notifications-unread-dot"
                        aria-label="Unread"
                      ></span>
                    {/if}
                  </span>
                </div>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    {/if}
  </div>
</section>

<style>
  .notifications-view {
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: 100%;
    min-height: 0;
    max-width: 720px;
    font: 400 13px/1.45 var(--font-ui);
    color: var(--t1);
  }

  .notif-header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .notif-header-leading {
    display: grid;
    gap: 6px;
    min-width: 0;
  }

  .notif-back {
    appearance: none;
    -webkit-appearance: none;
    align-self: start;
    height: 28px;
    padding: 0 2px;
    border: 0;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .notif-back:hover {
    color: var(--t1);
  }

  .notif-back:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: 2px;
  }

  .notif-header h1 {
    margin: 0;
    color: var(--t1);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.15;
    white-space: nowrap;
  }

  .notif-header-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .notif-toggle {
    display: inline-flex;
    gap: 2px;
    border: none;
    border-radius: 8px;
    background: var(--raised);
    padding: 2px;
    overflow: hidden;
  }

  .notif-toggle-btn {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: color 0.12s;
  }

  .notif-toggle-btn:hover {
    color: var(--t1);
  }

  .notif-toggle-btn.active {
    background: var(--sel);
    color: var(--t1);
  }

  .notif-toggle-btn:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -2px;
  }

  .notif-mark-all {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 31px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--btn-bg);
    color: var(--t1);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 0.12s;
  }

  .notif-mark-all:hover:not(:disabled) {
    border-color: var(--line2);
  }

  .notif-mark-all:active:not(:disabled) {
    border-color: var(--border-active);
  }

  .notif-mark-all:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .notif-mark-all:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: 2px;
  }

  .notif-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    scrollbar-gutter: stable;
  }

  .notif-status {
    padding: 24px 4px;
    color: var(--t3);
    font-size: 13px;
    line-height: 1.4;
  }

  .notif-day {
    margin: 0 0 18px;
  }

  .notif-day-label {
    margin: 0;
    padding: 14px 12px 4px;
    color: var(--t2);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    line-height: 1.2;
    text-transform: uppercase;
  }

  .notif-day-rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .notif-row {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr) auto;
    gap: 12px;
    align-items: center;
    width: 100%;
    padding: 10px 12px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }

  .notif-row:hover {
    background: var(--btn-bg);
    border-color: var(--line2);
  }

  .notif-row:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -2px;
  }

  .notif-avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border: none;
    border-radius: 50%;
    background: var(--line2);
    color: var(--t1);
    font: 600 11px var(--font-ui);
  }

  .notif-main {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .notif-verb {
    overflow: hidden;
    color: var(--t2);
    font-size: 13px;
    font-weight: 400;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .notif-verb strong {
    font-weight: 600;
    color: var(--t1);
  }

  .notif-context {
    overflow: hidden;
    color: var(--t3);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .notif-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }

  .notif-action-btn {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: var(--btn-bg);
    color: var(--t1);
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }

  .notif-action-btn.danger {
    color: var(--warn-ink);
  }

  .notif-action-btn:hover:not(:disabled) {
    border-color: var(--line2);
  }

  .notif-action-btn:active:not(:disabled) {
    border-color: var(--border-active);
  }

  .notif-action-btn:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .notif-meta {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
  }

  .notif-type-icon {
    display: flex;
    align-items: center;
    color: var(--t3);
    opacity: 0.7;
  }

  .notif-ts {
    color: var(--t3);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .notif-unread-dot {
    width: 6px;
    height: 6px;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--ice-ink);
  }

  .notif-row.unread .notif-verb {
    color: var(--t1);
  }
</style>
