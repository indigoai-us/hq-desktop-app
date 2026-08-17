<script lang="ts">
  import { onDestroy } from 'svelte';
  import NotificationFeed from '../../components/NotificationFeed.svelte';
  import { markAllNotificationsRead } from '../../lib/notificationFeedData';
  import '../v4/tokens.css';

  // Inbox is the unified notification chronology. Hosts the SAME
  // NotificationFeed component (shared data plumbing:
  // fetch_notification_history + get_activity_log + the localStorage read
  // watermark) as the menubar popover; the feed already merges the message
  // (DM) stream with shares and new-file activity and renders everything
  // through the shared one-line NotificationRow (message rows hover-expand to
  // full text with quick-reply + emoji reacts).
  //
  // Header: title + unread/total subtitle. No tabs, no sync button, no overflow menus (US-008).

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
    unread = count;
  }

  function handleItemsChange(count: number): void {
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
    // The feed intentionally clusters related file changes into one visible
    // row. "Events" keeps this source count honest instead of implying that
    // every underlying event must map one-to-one to a rendered row.
    const noun = total === 1 ? 'event' : 'events';
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
      showDayLabels={false}
      density="comfortable"
      onunreadchange={handleUnreadChange}
      onitemschange={handleItemsChange}
      onloadstatechange={(loaded) => (feedLoaded = loaded)}
    />
  </div>
</section>

<style>
  .inbox-page {
    display: flex;
    flex-direction: column;
    gap: 0;
    width: 100%;
    height: 100%;
    min-height: 0;
    max-width: 1180px;
    font-family: var(--font-sans);
    letter-spacing: -0.006em;
  }

  .inbox-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 0;
    min-height: 52px;
    box-sizing: border-box;
    padding: 8px 8px 9px;
    border-bottom: 1px solid var(--v4-rowline, var(--border));
  }

  .inbox-titles {
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .inbox-titles h1 {
    margin: 0;
    color: var(--v4-text-1, var(--fg));
    font-family: var(--font-display, var(--font-sans));
    font-size: 16px;
    font-weight: 700;
    line-height: 1.15;
    letter-spacing: -0.015em;
  }

  .inbox-subtitle {
    margin: 0;
    overflow: hidden;
    font-size: var(--type-metadata, var(--text-micro, 10px));
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
    color: var(--v4-text-3, var(--muted));
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Feed sits flush on the page canvas — no card chrome around the list. */
  .inbox-feed {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    scrollbar-gutter: stable;
    background: transparent;
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

  /* Match Messages' compact two-line hierarchy: 12.5px actor, 10.5px source
     and timestamp, 11.5px preview. Spacing + hairlines establish structure;
     there is no nested card chrome. */
  .notif-host :global(.nr) {
    min-height: 58px;
    padding: 8px;
    border-radius: 0;
    box-shadow: inset 0 -1px 0 var(--v4-rowline, var(--border));
  }

  .notif-host :global(.nr-message.nr-expanded) {
    padding: 10px 8px 11px;
  }

  .notif-host :global(.nr-icon) {
    width: 14px;
    height: 14px;
  }

  .notif-host :global(.nr-ts) {
    font-size: 10.5px;
  }

  /* Comfortable feed spacing assumes a card panel. Pin the flat chronology
     rows directly to the canvas instead. */
  .notif-host :global(.notif-comfortable .notif-day-rows) {
    padding-left: 0;
    padding-right: 0;
    gap: 0;
  }

  @media (max-width: 980px) {
    .inbox-page {
      max-width: none;
    }

    .inbox-header {
      padding-inline: 6px;
    }

    .notif-host :global(.nr) {
      padding-inline: 6px;
    }
  }

</style>
