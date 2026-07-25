<script lang="ts">
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
  </header>

  <div class="inbox-feed notif-host">
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
    display: grid;
    grid-template-rows: auto auto;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--v4-row-stack-gap, 3px);
  }

  .inbox-titles h1 {
    margin: 0;
    color: var(--v4-text-1, var(--fg));
    font-family: var(--font-display, var(--font-sans));
    font-size: var(--type-detail, var(--text-lg, 18px));
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: -0.01em;
  }

  .inbox-subtitle {
    margin: 0;
    font-size: var(--type-secondary, var(--text-base, 13px));
    line-height: 1.4;
    color: var(--v4-text-3, var(--muted));
  }

  /* Feed sits flush on the page canvas — no card chrome around the list. */
  .inbox-feed {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  /* Map the feed's popover tokens onto the V4 desktop canvas tokens so the
     shared component reads as list-on-canvas, not a nested raised card. */
  .notif-host {
    --popover-bg: transparent;
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

  /* Slightly taller, more readable rows on the naked canvas — no rounded outer
     containers (DESKTOP-002). Spacing + hairlines establish structure. */
  .notif-host :global(.nr) {
    min-height: 36px;
    padding: 0 4px;
    border-radius: 0;
    font-size: var(--type-body, 13px);
  }

  .notif-host :global(.nr-message.nr-expanded) {
    padding: 12px 4px 12px;
  }

  .notif-host :global(.nr-ts) {
    font-size: var(--type-secondary, 11px);
  }

  .notif-host :global(.nr-icon) {
    width: 14px;
    height: 14px;
  }

  /* Comfortable density paddings from NotificationFeed assume a card panel —
     pin labels and rows flush to the canvas edges instead. */
  .notif-host :global(.notif-comfortable .notif-day-label) {
    padding-left: 4px;
    padding-right: 4px;
  }

  .notif-host :global(.notif-comfortable .notif-day-rows) {
    padding-left: 0;
    padding-right: 0;
  }

</style>
