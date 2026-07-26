<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { onDestroy } from 'svelte';
  import NotificationFeed from '../../components/NotificationFeed.svelte';
  import type { ConversationTarget } from '../../lib/pendingConversation';
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
  // Header: title + unread/total subtitle. No tabs, no sync button, no overflow menus (US-008).
  // Deep-link compose ("Message the sharer"): DesktopApp passes a
  // ConversationTarget so the recipient is not lost after US-008 removed the
  // standalone Messages shell.

  interface Props {
    composeTarget?: ConversationTarget | null;
    oncomposedismiss?: () => void;
  }

  let { composeTarget = null, oncomposedismiss }: Props = $props();

  let unread = $state(0);
  let total = $state(0);
  let composeBody = $state('');
  let composeBusy = $state(false);
  let composeError = $state<string | null>(null);
  let composeSent = $state(false);

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

  const composeLabel = $derived.by(() => {
    if (!composeTarget) return '';
    const name = composeTarget.displayName?.trim();
    if (name) return name;
    const email = composeTarget.email?.trim();
    if (email) return email;
    return composeTarget.personUid?.trim() || 'contact';
  });

  $effect(() => {
    // Reset local compose state whenever the deep-link recipient changes.
    void composeTarget;
    composeBody = '';
    composeError = null;
    composeSent = false;
    composeBusy = false;
  });

  async function sendCompose(): Promise<void> {
    if (!composeTarget || composeBusy) return;
    const text = composeBody.trim();
    if (!text) return;
    composeBusy = true;
    composeError = null;
    try {
      const uid = composeTarget.personUid?.trim() ?? '';
      const email = composeTarget.email?.trim() ?? '';
      if (uid && !uid.startsWith('email:')) {
        await invoke('send_dm', { toPersonUid: uid, body: text });
      } else if (email) {
        await invoke('send_dm_to_email', { toEmail: email, body: text });
      } else {
        throw new Error('No recipient uid or email');
      }
      composeSent = true;
      composeBody = '';
    } catch (err) {
      composeError = String(err);
    } finally {
      composeBusy = false;
    }
  }

  function dismissCompose(): void {
    composeBody = '';
    composeError = null;
    composeSent = false;
    oncomposedismiss?.();
  }

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

  {#if composeTarget}
    <div class="inbox-compose" data-testid="inbox-compose-target">
      <div class="inbox-compose-head">
        <strong>Message {composeLabel}</strong>
        <button type="button" class="inbox-compose-dismiss" onclick={dismissCompose}>
          Dismiss
        </button>
      </div>
      {#if composeSent}
        <p class="inbox-compose-sent">Sent.</p>
      {:else}
        <textarea
          class="inbox-compose-input"
          rows="3"
          placeholder={`Write to ${composeLabel}…`}
          bind:value={composeBody}
          disabled={composeBusy}
        ></textarea>
        {#if composeError}
          <p class="inbox-compose-error">{composeError}</p>
        {/if}
        <div class="inbox-compose-actions">
          <button
            type="button"
            class="inbox-compose-send"
            disabled={composeBusy || !composeBody.trim()}
            onclick={() => void sendCompose()}
          >
            {composeBusy ? 'Sending…' : 'Send'}
          </button>
        </div>
      {/if}
    </div>
  {/if}

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

  .inbox-compose {
    display: grid;
    gap: 8px;
    padding: 12px 0;
    border-top: 1px solid var(--v4-rowline, var(--border));
    border-bottom: 1px solid var(--v4-rowline, var(--border));
  }

  .inbox-compose-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .inbox-compose-head strong {
    font-size: var(--type-body, 13px);
    color: var(--v4-text-1, var(--fg));
  }

  .inbox-compose-dismiss {
    border: 0;
    background: transparent;
    color: var(--v4-text-3, var(--muted));
    font: inherit;
    font-size: var(--type-secondary, 12px);
    cursor: pointer;
    padding: 0;
  }

  .inbox-compose-input {
    width: 100%;
    resize: vertical;
    min-height: 72px;
    border: 1px solid var(--v4-rowline, var(--border));
    background: var(--v4-control-faint, var(--c-field-bg));
    color: var(--v4-text-1, var(--fg));
    font: inherit;
    font-size: var(--type-body, 13px);
    padding: 8px 10px;
    border-radius: 0;
  }

  .inbox-compose-actions {
    display: flex;
    justify-content: flex-end;
  }

  .inbox-compose-send {
    border: 1px solid var(--v4-rowline, var(--border));
    background: var(--v4-control-faint, var(--c-field-bg));
    color: var(--v4-text-1, var(--fg));
    font: inherit;
    font-size: var(--type-body, 13px);
    padding: 6px 12px;
    cursor: pointer;
  }

  .inbox-compose-send:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .inbox-compose-error {
    margin: 0;
    color: var(--v4-error, #b00020);
    font-size: var(--type-secondary, 12px);
  }

  .inbox-compose-sent {
    margin: 0;
    color: var(--v4-text-3, var(--muted));
    font-size: var(--type-secondary, 12px);
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
