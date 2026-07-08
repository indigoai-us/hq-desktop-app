<script lang="ts">
  import NotificationFeed from '../../components/NotificationFeed.svelte';

  // Desktop Notifications page — hosts the SAME feed component (and therefore
  // the same data plumbing: fetch_notification_history + get_activity_log +
  // the localStorage read watermark) as the menubar popover's Notifications
  // tab, day-grouped for the wider desktop timeline. Mark-all-read advances
  // the shared watermark; the V4 sidebar badge recomputes off the
  // `hq:notifications-read` window event the lib broadcasts.
  //
  // The feed is styled with `--popover-*` custom properties; the `.notif-host`
  // scope below aliases them onto the V4 desktop tokens so the rows render in
  // the desktop language (three text grays, hairlines, unread blue) without a
  // component fork.

  import { requestConversation } from '../../lib/pendingConversation';
  import type { ShareEvent } from '../../lib/notificationGroups';

  let feedEl: NotificationFeed | undefined = $state();
  let unread = $state(0);

  // "Message the sharer" stays inside the desktop window: stash the target +
  // dispatch hq:message-person; DesktopApp routes to the Messages destination
  // and the MessagesShell there opens the conversation.
  function messageSharer(share: ShareEvent): void {
    requestConversation({
      personUid: share.issuerPersonUid ?? '',
      email: share.issuerEmail,
      displayName: share.issuerDisplayName,
    });
  }
</script>

<section class="page" aria-labelledby="desktop-page-title">
  <div class="page-header">
    <h1 id="desktop-page-title">Notifications</h1>
    <button
      class="mark-read"
      type="button"
      onclick={() => feedEl?.markAllRead()}
      disabled={unread === 0}
    >
      Mark all read
    </button>
  </div>

  <div class="notif-host">
    <NotificationFeed
      bind:this={feedEl}
      showDayLabels={true}
      onunreadchange={(n) => (unread = n)}
      onmessagesharer={messageSharer}
    />
  </div>
</section>

<style>
  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .mark-read {
    padding: 5px 12px;
    font-size: var(--text-base, 13px);
    font-weight: 500;
    font-family: inherit;
    color: var(--v4-text-1);
    background: var(--v4-control-bg);
    border: 1px solid var(--v4-control-border);
    border-radius: 6px;
    cursor: pointer;
    transition: background-color 0.12s ease, opacity 0.12s ease;
  }

  .mark-read:hover:not(:disabled) {
    background: var(--v4-active-row);
  }

  .mark-read:disabled {
    opacity: 0.45;
    cursor: default;
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
