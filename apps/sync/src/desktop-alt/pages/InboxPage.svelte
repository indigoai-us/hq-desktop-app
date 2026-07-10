<script lang="ts">
  import NotificationFeed from '../../components/NotificationFeed.svelte';

  // Combined Inbox (US-008) — messages and notifications in one place. Hosts
  // the SAME NotificationFeed component (shared data plumbing:
  // fetch_notification_history + get_activity_log + the localStorage read
  // watermark) as the menubar popover; the feed already merges the message
  // (DM) stream with shares and new-file activity and renders everything
  // through the shared one-line NotificationRow (message rows hover-expand to
  // full text with quick-reply + emoji reacts). Header is title + unread
  // count ONLY — no tabs, no sync button, no menus (US-008).
  //
  // The feed is styled with `--popover-*` custom properties; the `.notif-host`
  // scope below aliases them onto the V4 desktop tokens so the rows render in
  // the desktop language (three text grays, hairlines, unread blue) without a
  // component fork.

  let unread = $state(0);
</script>

<section class="page" aria-labelledby="desktop-page-title" data-testid="desktop-alt-inbox">
  <div class="page-header">
    <div>
      <h1 id="desktop-page-title">Inbox</h1>
      <p class="unread-count" data-testid="inbox-unread-count">
        {unread === 0 ? 'All caught up' : `${unread} unread`}
      </p>
    </div>
  </div>

  <div class="notif-host">
    <NotificationFeed showDayLabels={true} onunreadchange={(n) => (unread = n)} />
  </div>
</section>

<style>
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .unread-count {
    margin: 2px 0 0;
    font-size: var(--text-base, 13px);
    color: var(--v4-text-3);
  }

  /* Map the feed's popover tokens onto the V4 desktop tokens so the shared
     component reads as a native desktop surface. Scoped to this host only. */
  .notif-host {
    max-width: 720px;
    --popover-bg: var(--v4-ground);
    --popover-surface: var(--v4-control-faint);
    --popover-text: var(--v4-text-2);
    --popover-text-muted: var(--v4-text-3);
    --popover-text-heading: var(--v4-text-1);
    --popover-action-hover: var(--v4-active-row);
    --popover-danger: var(--v4-error);
    --popover-unread: var(--v4-unread);
    --text-sm: 13px;
  }
</style>
