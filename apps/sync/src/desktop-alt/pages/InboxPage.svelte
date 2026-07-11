<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { onDestroy } from 'svelte';
  import NotificationFeed from '../../components/NotificationFeed.svelte';
  import { markAllNotificationsRead } from '../../lib/notificationFeedData';
  import '../v4/tokens.css';

  // Combined Inbox (US-008) — messages and notifications in one place. Hosts
  // the SAME NotificationFeed component (shared data plumbing:
  // fetch_notification_history + get_activity_log + the localStorage read
  // watermark) as the menubar popover; the feed already merges the message
  // (DM) stream with shares and new-file activity and renders everything
  // through the shared one-line NotificationRow (message rows hover-expand to
  // full text with quick-reply + emoji reacts).
  //
  // Header: title + unread/total subtitle + jump to the dedicated Messages
  // window. No tabs, no sync button, no overflow menus (US-008).

  let unread = $state(0);
  let total = $state(0);

  // Viewing the Inbox counts as reading it (notification-center pattern): the
  // read watermark advances when the user LEAVES the surface — navigate-away
  // unmount or window hide — not while they are still triaging (unread dots
  // stay visible on screen). Gated on the feed having actually loaded so a
  // flash-visit before data arrives can't silently swallow unread state.
  // `markAllNotificationsRead` broadcasts `hq:notifications-read`, which
  // recomputes the sidebar badge in place.
  let feedLoaded = false;

  function handleUnreadChange(count: number): void {
    feedLoaded = true;
    unread = count;
  }

  function handleItemsChange(count: number): void {
    feedLoaded = true;
    total = count;
  }

  function commitRead(): void {
    if (!feedLoaded) return;
    markAllNotificationsRead();
  }

  async function openMessagesWindow(): Promise<void> {
    try {
      await invoke('open_messages_window');
    } catch (e) {
      console.error('inbox: open_messages_window failed', e);
    }
  }

  const subtitle = $derived.by(() => {
    if (total === 0 && unread === 0) return 'All caught up';
    const unreadPart =
      unread === 0 ? 'All caught up' : `${unread} unread`;
    if (total === 0) return unreadPart;
    const noun = total === 1 ? 'notification' : 'notifications';
    return `${unreadPart} · ${total} ${noun}`;
  });

  onDestroy(commitRead);

  $effect(() => {
    window.addEventListener('pagehide', commitRead);
    return () => window.removeEventListener('pagehide', commitRead);
  });
</script>

<section class="inbox-page page" aria-labelledby="desktop-page-title" data-testid="desktop-alt-inbox">
  <header class="page-header inbox-header">
    <div class="inbox-titles">
      <h1 id="desktop-page-title">Inbox</h1>
      <p class="inbox-subtitle" data-testid="inbox-unread-count">
        {subtitle}
      </p>
    </div>
    <div class="inbox-actions">
      <button
        type="button"
        class="inbox-btn"
        data-testid="inbox-open-messages"
        onclick={() => void openMessagesWindow()}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M2.5 3h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3.5 2.6V11h0a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
        </svg>
        Open Messages
      </button>
    </div>
  </header>

  <div class="inbox-panel notif-host">
    <NotificationFeed
      showDayLabels={true}
      density="comfortable"
      onunreadchange={handleUnreadChange}
      onitemschange={handleItemsChange}
    />
  </div>
</section>

<style>
  .inbox-page {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
    max-width: 860px;
    font-family: var(--font-sans);
  }

  .inbox-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 0;
  }

  .inbox-titles {
    min-width: 0;
  }

  .inbox-titles h1 {
    margin: 0;
    color: var(--v4-text-1, var(--fg));
    font-family: var(--font-display, var(--font-sans));
    font-size: var(--text-lg, 18px);
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }

  .inbox-subtitle {
    margin: 4px 0 0;
    font-size: var(--text-base, 13px);
    line-height: 1.4;
    color: var(--v4-text-3, var(--muted));
  }

  .inbox-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .inbox-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 30px;
    padding: 0 12px;
    border: 1px solid var(--v4-control-border, var(--border-strong, rgba(0, 0, 0, 0.1)));
    border-radius: var(--v4-radius-button, 8px);
    background: var(--v4-raised, var(--c-bg, #fff));
    color: var(--v4-text-1, var(--fg));
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: var(--v4-shadow-card-light, 0 1px 1.5px rgba(0, 0, 0, 0.06));
  }

  .inbox-btn:hover {
    background: var(--v4-active-row, var(--row-hover));
  }

  .inbox-btn:focus-visible {
    outline: 2px solid var(--v4-unread, #0a6fd6);
    outline-offset: 2px;
  }

  .inbox-btn svg {
    flex-shrink: 0;
    color: var(--v4-text-2, var(--muted));
  }

  /* Raised feed panel — desktop-native card over the page ground. */
  .inbox-panel {
    flex: 1 1 auto;
    min-height: 0;
    border: 1px solid var(--v4-hairline, var(--border));
    border-radius: var(--v4-radius-card, 14px);
    background: var(--v4-raised, var(--c-bg, #fff));
    box-shadow: var(--v4-shadow-card, 0 1px 2px rgba(0, 0, 0, 0.05));
    overflow: hidden;
  }

  /* Map the feed's popover tokens onto the V4 desktop tokens so the shared
     component reads as a native desktop surface. Scoped to this host only. */
  .notif-host {
    --popover-bg: var(--v4-raised, var(--c-bg, #fff));
    --popover-surface: var(--v4-control-faint, var(--c-field-bg));
    --popover-text: var(--v4-text-2, var(--fg));
    --popover-text-muted: var(--v4-text-3, var(--muted));
    --popover-text-heading: var(--v4-text-1, var(--fg));
    --popover-action-hover: var(--v4-active-row, var(--row-hover));
    --popover-danger: var(--v4-error);
    --popover-unread: var(--v4-unread);
    --popover-day-rule: var(--v4-rowline, var(--border));
    --text-sm: 13px;
  }

  /* Slightly taller, more readable rows inside the desktop panel. */
  .notif-host :global(.nr) {
    min-height: 36px;
    padding: 0 14px;
    border-radius: 10px;
    font-size: 13px;
  }

  .notif-host :global(.nr-message.nr-expanded) {
    padding: 12px 14px 12px;
  }

  .notif-host :global(.nr-ts) {
    font-size: 11px;
  }

  .notif-host :global(.nr-icon) {
    width: 14px;
    height: 14px;
  }

  @media (prefers-color-scheme: dark) {
    .inbox-btn {
      box-shadow: none;
    }
  }
</style>
