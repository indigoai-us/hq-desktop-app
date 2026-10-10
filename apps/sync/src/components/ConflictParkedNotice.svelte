<script lang="ts">
  import { untrack } from 'svelte';
  import {
    clearDismissedConflictBatch,
    defaultConflictBatchStorage,
    isConflictBatchDismissed,
    readDismissedConflictBatch,
    writeDismissedConflictBatch,
    type ConflictBatchStorage,
    type ConflictParkedNotice,
  } from '../lib/conflictNotices';

  interface Props {
    notices: readonly ConflictParkedNotice[];
    busyIds: ReadonlySet<string>;
    onShowInFinder: (notice: ConflictParkedNotice) => void;
    onAcknowledge: (notice: ConflictParkedNotice) => void;
    /** Where the dismissed batch is kept so it survives a window reload. */
    storage?: ConflictBatchStorage | null;
    /**
     * Set when a parked-conflict OS notification was clicked: show the card
     * again (even if this batch was dismissed) with the Review list open.
     */
    reviewRequested?: boolean;
    onReviewHandled?: () => void;
  }

  let {
    notices,
    busyIds,
    onShowInFinder,
    onAcknowledge,
    storage = defaultConflictBatchStorage(),
    reviewRequested = false,
    onReviewHandled,
  }: Props = $props();

  // Several parked copies collapse into one card with a count. The per-file
  // rows only render when there is one notice or the person opens the list.
  let expanded = $state(false);
  // The X closes the card for the current batch only (see
  // isConflictBatchDismissed); a notice outside that batch brings it back.
  let dismissedIds = $state<Set<string>>(untrack(() => readDismissedConflictBatch(storage)));
  const dismissed = $derived(isConflictBatchDismissed(notices, dismissedIds));
  const grouped = $derived(notices.length > 1);
  const showRows = $derived(!grouped || expanded);
  const title = $derived(
    grouped ? `${notices.length} conflict copies parked` : 'Conflict copy parked',
  );
  const summary = $derived(
    grouped ? `${notices[0].relativePath} and ${notices.length - 1} more have preserved copies.` : '',
  );

  function dismissBatch(): void {
    dismissedIds = writeDismissedConflictBatch(storage, notices);
    expanded = false;
  }

  $effect(() => {
    if (notices.length <= 1) expanded = false;
  });

  $effect(() => {
    // Wait for the notices to load: a cold notification click can arrive
    // before the pending list does.
    if (!reviewRequested || notices.length === 0) return;
    untrack(() => {
      clearDismissedConflictBatch(storage);
      dismissedIds = new Set();
      expanded = true;
      onReviewHandled?.();
    });
  });
</script>

<!--
  Mounted by HqWorkWorkShell above WorkShell, i.e. outside `.desktop-shell`
  where the app font and the --v4-* tokens live, and over a window whose title
  bar is an overlay (traffic lights draw on top of the webview). So this card:
  - is a fixed overlay under the title bar, never in document flow;
  - sets its own font and only uses tokens defined at :root in
    styles/design-system.css (light and dark), never inherited ones.
-->
{#if notices.length > 0 && !dismissed}
  <section class="conflict-notices" data-testid="conflict-parked-notices" role="status" aria-live="polite">
    <header class="head">
      <div class="copy">
        <strong class="title">{title}</strong>
        {#if grouped}
          <p class="summary">{summary}</p>
        {/if}
      </div>
      <div class="head-actions">
        {#if grouped}
          <button
            type="button"
            class="toggle"
            aria-expanded={expanded}
            onclick={() => (expanded = !expanded)}
          >
            {expanded ? 'Hide' : 'Review'}
          </button>
        {/if}
        <button
          type="button"
          class="close"
          aria-label="Dismiss"
          data-testid="conflict-parked-notices-dismiss"
          onclick={dismissBatch}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </header>
    {#if showRows}
      <ul class="rows">
        {#each notices as notice (notice.id)}
          <li class="conflict-notice" data-testid="conflict-parked-notice">
            <p class="path">
              {#if grouped}{notice.relativePath}{:else}<span>{notice.relativePath}</span> has a preserved copy.{/if}
            </p>
            <div class="actions">
              <button type="button" class="show" disabled={busyIds.has(notice.id)} onclick={() => onShowInFinder(notice)}>
                {busyIds.has(notice.id) ? 'Opening…' : 'Show in Finder'}
              </button>
              <button type="button" class="dismiss" disabled={busyIds.has(notice.id)} aria-label={`Acknowledge ${notice.relativePath}`} onclick={() => onAcknowledge(notice)}>
                {busyIds.has(notice.id) ? 'Saving…' : 'Dismiss'}
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .conflict-notices {
    position: fixed;
    top: calc(var(--titlebar-height, 48px) + 8px);
    right: 16px;
    z-index: 49000;
    box-sizing: border-box;
    width: min(360px, calc(100vw - 32px));
    padding: 10px 12px;
    border: 1px solid var(--pop-border);
    border-radius: var(--radius-popover);
    background: var(--pop-bg);
    box-shadow: var(--pop-shadow);
    color: var(--pop-text);
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    font-size: 12px;
    line-height: 1.4;
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .copy { min-width: 0; }
  .title { display: block; font-size: 13px; font-weight: 600; }
  .summary { margin: 2px 0 0; color: var(--pop-muted); overflow-wrap: anywhere; }

  .rows {
    display: grid;
    gap: 8px;
    max-height: 34vh;
    overflow-y: auto;
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
  }

  .conflict-notice {
    display: grid;
    gap: 6px;
    min-width: 0;
    padding-top: 8px;
    border-top: 1px solid var(--pop-divider);
  }

  .path { margin: 0; color: var(--pop-muted); overflow-wrap: anywhere; }
  .path span { color: var(--pop-text); }
  .actions { display: flex; align-items: center; gap: 8px; }

  button {
    min-height: 26px;
    border: 1px solid var(--pop-border);
    border-radius: var(--radius-button);
    padding: 3px 10px;
    color: var(--pop-text);
    background: transparent;
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    font-size: 12px;
    line-height: 1.3;
    cursor: pointer;
  }

  button.show { font-weight: 600; }
  .head-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; }
  button.toggle { flex: 0 0 auto; }
  /* Icon-only close, same shape as the notification rows' dismiss X. */
  button.close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    min-height: 20px;
    padding: 0;
    border: none;
    border-radius: 5px;
    color: var(--pop-muted);
  }
  button.close:hover { color: var(--pop-text); }
  button:hover:not(:disabled) { background: var(--pop-hover); }
  button:focus-visible { outline: 2px solid var(--pop-focus-ring); outline-offset: var(--pop-focus-offset); }
  button:disabled { cursor: wait; opacity: 0.65; }
</style>
