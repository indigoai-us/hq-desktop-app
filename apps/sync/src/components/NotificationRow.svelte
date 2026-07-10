<script lang="ts">
  import { relativeTime } from '../lib/notificationFeedData';

  // Shared one-line notification row — menubar popover feed, desktop widget
  // stack, and combined Inbox all render through this locked design.

  export type NotificationRowType =
    | 'message'
    | 'mention'
    | 'share'
    | 'sync'
    | 'deploy'
    | 'meeting'
    | 'system';

  interface Props {
    type: NotificationRowType;
    /** Bold leading name (e.g. "Corey"); omit for ambient rows. */
    actor?: string;
    text: string;
    /** Epoch ms — rendered as a right-aligned relative timestamp. */
    ts: number;
    unread?: boolean;
    /**
     * Currently-selected row in a list (quick-window side pane). Persistent
     * accent bar + hover-tint background; independent of hover/expand.
     */
    selected?: boolean;
    /**
     * When false, message rows stay one-line (no hover-expand reply/react).
     * Default true preserves existing popover/widget/inbox behavior.
     */
    hoverExpand?: boolean;
    /** Hover "Open" (non-message) + Enter/Space when focused. */
    onopen?: () => void;
    /** Hover dismiss (×). */
    ondismiss?: () => void;
    /** Message rows: quick-reply submit. */
    onreply?: (text: string) => void;
    /** Message rows: emoji react tap. */
    onreact?: (emoji: string) => void;
  }

  let {
    type,
    actor,
    text,
    ts,
    unread = false,
    selected = false,
    hoverExpand = true,
    onopen,
    ondismiss,
    onreply,
    onreact,
  }: Props = $props();

  let hovered = $state(false);
  let focusWithin = $state(false);
  let replyText = $state('');

  const isMessage = $derived(type === 'message');
  // hoverExpand gates message expand so dense lists (side pane) stay one-line.
  const expanded = $derived(isMessage && hoverExpand && (hovered || focusWithin));
  const interactive = $derived(Boolean(onopen));

  function onMouseEnter(): void {
    hovered = true;
  }
  function onMouseLeave(): void {
    hovered = false;
  }
  function onFocusIn(): void {
    focusWithin = true;
  }
  function onFocusOut(e: FocusEvent): void {
    const next = e.relatedTarget as Node | null;
    const root = e.currentTarget as HTMLElement;
    if (next && root.contains(next)) return;
    focusWithin = false;
  }

  function handleOpen(): void {
    onopen?.();
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (!onopen) return;
    // Don't steal keys from the reply input / action buttons.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'BUTTON')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onopen();
    }
  }

  function handleRowClick(e: MouseEvent): void {
    if (!onopen) return;
    // Action buttons / reply input: ignore so reply/react never opens.
    // (Foot also stopPropagations; this covers any bare button/input.)
    const t = e.target as HTMLElement | null;
    if (t?.closest('button, input')) return;
    onopen();
  }

  function submitReply(): void {
    const value = replyText.trim();
    if (!value || !onreply) return;
    onreply(value);
    replyText = '';
  }

  function onReplyKeydown(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      submitReply();
    }
  }

  const REACT_EMOJI = ['👍', '❤️', '👀'] as const;
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="nr"
  class:nr-message={isMessage}
  class:nr-expanded={expanded}
  class:nr-interactive={interactive}
  class:nr-selected={selected}
  data-testid="notification-row"
  data-type={type}
  data-expanded={expanded}
  role={interactive ? 'button' : undefined}
  tabindex={interactive ? 0 : undefined}
  aria-current={selected ? 'true' : undefined}
  onmouseenter={onMouseEnter}
  onmouseleave={onMouseLeave}
  onfocusin={onFocusIn}
  onfocusout={onFocusOut}
  onclick={handleRowClick}
  onkeydown={handleKeydown}
>
  {#if expanded}
    <div class="nr-head">
      <span class="nr-icon" aria-hidden="true">
        {@render typeIcon(type)}
      </span>
      <span class="nr-text nr-text-head">
        {#if actor}<b>{actor}</b>{/if}
      </span>
      <span class="nr-trail">
        <span class="nr-ts">{relativeTime(ts)}</span>
        {#if unread}
          <span class="nr-unread" aria-label="Unread"></span>
        {/if}
      </span>
    </div>
    <div class="nr-body">{text}</div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="nr-foot"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <input
        class="nr-reply"
        type="text"
        placeholder="Reply…"
        bind:value={replyText}
        onkeydown={onReplyKeydown}
      />
      {#each REACT_EMOJI as emoji (emoji)}
        <button
          class="nr-react"
          type="button"
          onclick={() => onreact?.(emoji)}
          aria-label={`React with ${emoji}`}
        >
          {emoji}
        </button>
      {/each}
    </div>
  {:else}
    <span class="nr-icon" aria-hidden="true">
      {@render typeIcon(type)}
    </span>
    <span class="nr-text">
      {#if actor}<b>{actor}</b>{' '}{/if}{text}
    </span>
    <span class="nr-trail">
      <span class="nr-ts">
        {#if unread}
          <span class="nr-unread" aria-label="Unread"></span>
        {/if}
        {relativeTime(ts)}
      </span>
      {#if !isMessage && (onopen || ondismiss)}
        <span class="nr-actions">
          {#if onopen}
            <button class="nr-open" type="button" onclick={(e) => (e.stopPropagation(), handleOpen())}>
              Open
            </button>
          {/if}
          {#if ondismiss}
            <button
              class="nr-dismiss"
              type="button"
              aria-label="Dismiss"
              onclick={(e) => (e.stopPropagation(), ondismiss?.())}
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          {/if}
        </span>
      {/if}
    </span>
  {/if}
</div>

{#snippet typeIcon(t: NotificationRowType)}
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    {#if t === 'message'}
      <path
        d="M2.5 3h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-3.5 2.6V11h0a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linejoin="round"
      />
    {:else if t === 'share'}
      <path
        d="M8 1.8v8.4M4.6 5.2 8 1.8l3.4 3.4M2.8 9.4v3.2a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1V9.4"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    {:else if t === 'sync'}
      <path
        d="M2.5 6.2A5.6 5.6 0 0 1 12.6 4.4M13.4 2v2.8h-2.8M13.5 9.8A5.6 5.6 0 0 1 3.4 11.6M2.6 14v-2.8h2.8"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    {:else if t === 'deploy'}
      <path
        d="M8 13.5V4M4.2 7.8 8 4l3.8 3.8M3 2.5h10"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    {:else if t === 'meeting'}
      <path
        d="M2.5 4.5h7.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1ZM11 8l3.5-2.2v4.4L11 8Z"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    {:else if t === 'mention'}
      <path
        d="M10.4 8a2.4 2.4 0 1 1-4.8 0 2.4 2.4 0 0 1 4.8 0Zm0 0v1.1c0 1 .7 1.7 1.6 1.7 1.2 0 2-.9 2-2.8A6 6 0 1 0 8 14a5.9 5.9 0 0 0 3-.8"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
      />
    {:else}
      <!-- system: thin-stroke info in an angular rounded square -->
      <path
        d="M2.8 2.8h10.4v10.4H2.8Z"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path
        d="M8 7.2v4M8 4.6h.01"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    {/if}
  </svg>
{/snippet}

<style>
  .nr {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 30px;
    padding: 0 11px;
    border-radius: 9px;
    font-size: 12px;
    color: var(--popover-text);
    transition: background-color 0.15s ease;
    box-sizing: border-box;
  }

  .nr-interactive {
    cursor: pointer;
  }

  /* Selected row in a list (quick-window side pane) — persistent, not hover. */
  .nr-selected {
    background: var(--popover-action-hover);
    box-shadow: inset 2px 0 0 var(--popover-unread);
  }

  .nr-message.nr-expanded {
    flex-direction: column;
    align-items: stretch;
    gap: 7px;
    padding: 9px 11px 10px;
    background: var(--popover-action-hover);
    min-height: 0;
  }

  /* Non-message hover / keyboard focus: tint + swap ts for actions */
  .nr:not(.nr-message):hover,
  .nr:not(.nr-message):focus-within {
    background: var(--popover-action-hover);
  }

  .nr-icon {
    flex-shrink: 0;
    width: 12px;
    height: 12px;
    display: grid;
    place-items: center;
    color: var(--popover-text-muted);
  }

  .nr-text {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 450;
    color: var(--popover-text);
  }

  .nr-text b,
  .nr-text-head b {
    font-weight: 600;
  }

  .nr-text-head {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .nr-trail {
    margin-left: auto;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    position: relative;
  }

  .nr-ts {
    font-size: 10.5px;
    color: var(--popover-text-muted);
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .nr-unread {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--popover-unread);
    flex-shrink: 0;
  }

  .nr-actions {
    display: none;
    align-items: center;
    gap: 4px;
  }

  .nr:not(.nr-message):hover .nr-ts,
  .nr:not(.nr-message):focus-within .nr-ts {
    display: none;
  }

  .nr:not(.nr-message):hover .nr-actions,
  .nr:not(.nr-message):focus-within .nr-actions {
    display: inline-flex;
  }

  .nr-open,
  .nr-dismiss {
    height: 20px;
    border-radius: 5px;
    background: var(--popover-action-hover);
    color: var(--popover-text);
    font-size: 10.5px;
    font-weight: 600;
    font-family: inherit;
    border: none;
    cursor: pointer;
    padding: 0 7px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }

  .nr-dismiss {
    width: 20px;
    padding: 0;
  }

  .nr-open:hover,
  .nr-dismiss:hover,
  .nr-open:focus-visible,
  .nr-dismiss:focus-visible {
    outline: none;
  }

  /* Expanded message layout */
  .nr-head {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .nr-head .nr-text {
    flex: 1;
  }

  .nr-body {
    white-space: normal;
    font-size: 12px;
    line-height: 1.45;
    color: var(--popover-text);
    font-weight: 450;
    padding-left: 22px; /* icon (12) + gap (10) */
  }

  .nr-foot {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-left: 22px;
    cursor: default;
  }

  .nr-reply {
    flex: 1;
    min-width: 0;
    height: 24px;
    padding: 0 9px;
    border-radius: 7px;
    background: var(--popover-surface);
    border: 0.5px solid var(--popover-divider);
    color: var(--popover-text);
    font-size: 11px;
    font-family: inherit;
    box-sizing: border-box;
  }

  .nr-reply::placeholder {
    color: var(--popover-text-muted);
  }

  .nr-reply:focus {
    outline: none;
  }

  .nr-react {
    flex: 0 0 auto;
    height: 24px;
    border-radius: 7px;
    background: var(--popover-action-hover);
    border: none;
    font-size: 12px;
    cursor: pointer;
    padding: 0 7px;
    line-height: 1;
    font-family: inherit;
  }

  @media (prefers-reduced-motion: reduce) {
    .nr {
      transition: none;
    }
  }
</style>
