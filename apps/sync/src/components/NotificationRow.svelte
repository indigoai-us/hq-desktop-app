<script lang="ts">
  import { onDestroy } from 'svelte';
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
    /** Compact, visible source/type metadata (for example "Direct message"). */
    sourceLabel?: string;
    text: string;
    /** Epoch ms — rendered as a right-aligned relative timestamp. */
    ts: number;
    unread?: boolean;
    /**
     * Currently-selected row in a list (quick-window side pane). Persistent
     * neutral hover-tint background; independent of hover/expand.
     */
    selected?: boolean;
    /**
     * When false, message rows stay one-line (no hover-expand reply/react).
     * Default true preserves existing popover/widget/inbox behavior.
     */
    hoverExpand?: boolean;
    /** Explicit accessible Open action. */
    onopen?: () => void | Promise<void>;
    /** Optional secondary action, distinct from opening the row destination. */
    onaction?: () => void | Promise<void>;
    /** Hover dismiss (×). */
    ondismiss?: () => void;
    /** Text for the hover open pill; when absent keep 'Open'. */
    actionLabel?: string;
    /** Disable the secondary action while it is already in flight. */
    actionDisabled?: boolean;
    /** When true the dismiss button renders as a text pill reading 'Dismiss'. */
    textDismiss?: boolean;
    /** Message rows: quick-reply submit. */
    onreply?: (text: string) => void | Promise<void>;
    /** Message rows: emoji react tap. */
    onreact?: (emoji: string) => void | Promise<void>;
    /**
     * Fired when reply hold transitions: focus on the reply input or a non-empty
     * draft suspends auto-hide; blur + empty draft releases it.
     */
    onholdchange?: (held: boolean) => void;
    /** Conversation rows (quick-window side pane): unread-count pill replacing the dot. */
    badgeCount?: number;
    /** Marks the actor as an AI agent — renders a subtle agent glyph after the name. */
    agentActor?: boolean;
    /** Slightly roomier one-line rows (desktop Inbox). Collapsed rows stay one line. */
    comfortable?: boolean;
    /** Optional identity hint, surfaced in the collapsed-row tooltip only. */
    identityLabel?: string;
  }

  let {
    type,
    actor,
    sourceLabel,
    text,
    ts,
    unread = false,
    selected = false,
    hoverExpand = true,
    onopen,
    onaction,
    ondismiss,
    actionLabel,
    actionDisabled = false,
    textDismiss = false,
    onreply,
    onreact,
    onholdchange,
    badgeCount = 0,
    agentActor = false,
    comfortable = false,
    identityLabel,
  }: Props = $props();

  let hovered = $state(false);
  let focusWithin = $state(false);
  let replyText = $state('');
  let replyFocused = $state(false);
  let replyInputEl: HTMLInputElement | undefined = $state();
  let openPending = $state(false);
  let actionPending = $state(false);
  let replyPending = $state(false);
  let replyError = $state<string | null>(null);
  let reactionPending = $state<string | null>(null);
  let reactionError = $state<string | null>(null);
  let failedReaction = $state<string | null>(null);
  let openError = $state<string | null>(null);
  let actionError = $state<string | null>(null);

  const isMessage = $derived(type === 'message');
  /** Draft or focus keeps the message expanded even on transient hover-out. */
  const replyHold = $derived(replyFocused || replyText.length > 0);
  // hoverExpand gates message expand so dense lists (side pane) stay one-line;
  // widget surfaces keep the default (true) so reply holds still expand.
  const expanded = $derived(
    isMessage && hoverExpand && (hovered || focusWithin || replyHold),
  );
  const resolvedSourceLabel = $derived(sourceLabel ?? sourceLabelForType(type));
  const unreadLabel = $derived(
    badgeCount > 0 ? `${badgeCount} unread` : unread ? 'Unread' : null,
  );
  const primaryActionLabel = $derived(
    `${
      actor
        ? `Open ${resolvedSourceLabel} from ${actor}: ${text}`
        : `Open ${resolvedSourceLabel}: ${text}`
    }${unreadLabel ? `, ${unreadLabel}` : ''}`,
  );
  const visibleActionPending = $derived(openPending || actionPending);
  const timestampIso = $derived(new Date(ts).toISOString());
  const timestampTitle = $derived(
    new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(ts)),
  );

  // Non-reactive last-notified value — only fire onholdchange on transitions.
  let lastHold = false;
  $effect(() => {
    const current = replyHold;
    if (current !== lastHold) {
      lastHold = current;
      onholdchange?.(current);
    }
  });

  // Effects don't re-run on destroy — release an active hold when the row
  // unmounts (surface switch, list close) so the widget never holds forever.
  onDestroy(() => {
    if (lastHold) {
      lastHold = false;
      onholdchange?.(false);
    }
  });

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

  function isPromiseLike(value: void | Promise<void>): value is Promise<void> {
    return value != null && typeof (value as Promise<void>).then === 'function';
  }

  function handleOpen(): void {
    if (!onopen || openPending || actionPending) return;
    openError = null;
    openPending = true;
    try {
      const result = onopen();
      if (isPromiseLike(result)) {
        void result
          .catch((error) => {
            console.error('notification-row: open failed', error);
            openError = 'Couldn’t open this item.';
          })
          .finally(() => {
            openPending = false;
          });
        return;
      }
    } catch (error) {
      console.error('notification-row: open failed', error);
      openError = 'Couldn’t open this item.';
    }
    openPending = false;
  }

  function handleAction(): void {
    if (!onaction) {
      handleOpen();
      return;
    }
    if (actionPending || openPending || actionDisabled) return;
    actionError = null;
    actionPending = true;
    try {
      const result = onaction();
      if (isPromiseLike(result)) {
        void result
          .catch((error) => {
            console.error('notification-row: action failed', error);
            actionError = 'Couldn’t complete that action.';
          })
          .finally(() => {
            actionPending = false;
          });
        return;
      }
    } catch (error) {
      console.error('notification-row: action failed', error);
      actionError = 'Couldn’t complete that action.';
    }
    actionPending = false;
  }

  function completeReply(): void {
    replyText = '';
    replyError = null;
    // Auto-hide resumes after send.
    // Update the hold synchronously instead of relying solely on a native blur
    // event, which may be skipped if the row/window loses focus mid-send.
    replyFocused = false;
    replyInputEl?.blur();
  }

  function submitReply(): void {
    const value = replyText.trim();
    if (!value || !onreply || replyPending) return;
    replyPending = true;
    try {
      const result = onreply(value);
      if (isPromiseLike(result)) {
        void result
          .then(completeReply)
          .catch((error) => {
            console.error('notification-row: reply failed', error);
            replyError = 'Couldn’t send. Your reply is still here.';
          })
          .finally(() => {
            replyPending = false;
          });
        return;
      }
      completeReply();
    } catch (error) {
      console.error('notification-row: reply failed', error);
      replyError = 'Couldn’t send. Your reply is still here.';
    }
    replyPending = false;
  }

  function react(emoji: string): void {
    if (!onreact || reactionPending) return;
    reactionError = null;
    failedReaction = null;
    reactionPending = emoji;
    try {
      const result = onreact(emoji);
      if (isPromiseLike(result)) {
        void result
          .catch((error) => {
            console.error('notification-row: reaction failed', error);
            failedReaction = emoji;
            reactionError = 'Couldn’t add that reaction.';
          })
          .finally(() => {
            reactionPending = null;
          });
        return;
      }
    } catch (error) {
      console.error('notification-row: reaction failed', error);
      failedReaction = emoji;
      reactionError = 'Couldn’t add that reaction.';
    }
    reactionPending = null;
  }

  function onReplyKeydown(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      submitReply();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      replyText = '';
      replyError = null;
      // Releases hold; normal collapse resumes.
      replyInputEl?.blur();
    }
  }

  function sourceLabelForType(value: NotificationRowType): string {
    switch (value) {
      case 'message':
        return 'Message';
      case 'mention':
        return 'Mention';
      case 'share':
        return 'Shared file';
      case 'sync':
        return 'Workspace';
      case 'deploy':
        return 'Deployment';
      case 'meeting':
        return 'Meeting';
      default:
        return 'System';
    }
  }

  const REACT_EMOJI = ['👍', '❤️', '👀'] as const;
</script>

{#snippet primaryContent()}
  <!-- Locked one-line layout at all times. Hover reveals actions as an
       overlay toolbar (Slack-style) so rows never resize and the list never
       reflows (owner round-2 feedback). -->
  <span class="nr-icon" aria-hidden="true">
    {@render typeIcon(type)}
  </span>
  {#if unread && badgeCount === 0}
    <span class="nr-unread" aria-label="Unread"></span>
  {/if}
  <span
    class="nr-text"
    title={identityLabel
      ? `${identityLabel} · ${actor ? `${actor}: ${text}` : text}`
      : actor
        ? `${actor}: ${text}`
        : text}
  >
    {#if actor}<span class="nr-actor" data-testid="notification-actor" title={actor}>{actor}</span>{#if agentActor}<span class="nr-agent" data-testid="agent-badge" title="Agent" aria-label="Agent sender"><svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 6.5h6v5.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 2.5v2M5.5 4.5 4 3.5M10.5 4.5 12 3.5M6.5 9h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></span>{/if}{' '}{/if}{text}
  </span>
  <span class="nr-trail">
    {#if badgeCount > 0}<span class="nr-count" data-testid="unread-count" aria-label="{badgeCount} unread">{badgeCount}</span>{/if}
    <span class="nr-meta-type" data-testid="notification-source">{resolvedSourceLabel}</span>
    <time class="nr-ts" datetime={timestampIso} title={timestampTitle}>{relativeTime(ts)}</time>
  </span>
{/snippet}

<div
  class="nr"
  class:nr-message={isMessage}
  class:nr-expanded={expanded}
  class:nr-selected={selected}
  class:nr-comfortable={comfortable}
  class:nr-has-error={openError !== null || actionError !== null}
  role="group"
  aria-label={`${actor ? `${actor} ` : ''}${type} notification${
    unreadLabel ? `, ${unreadLabel}` : ''
  }`}
  data-testid="notification-row"
  data-type={type}
  data-expanded={expanded}
  aria-current={selected ? 'true' : undefined}
  onmouseenter={onMouseEnter}
  onmouseleave={onMouseLeave}
  onfocusin={onFocusIn}
  onfocusout={onFocusOut}
>
  {#if onopen}
    <button
      class="nr-primary-action"
      type="button"
      aria-label={primaryActionLabel}
      aria-busy={openPending || actionPending}
      disabled={openPending || actionPending}
      onclick={() => void handleOpen()}
    >
      {@render primaryContent()}
      {#if openPending || actionPending}
        <span class="nr-spinner" data-testid="notification-pending" aria-hidden="true"></span>
      {/if}
    </button>
  {:else}
    <div class="nr-primary-content">
      {@render primaryContent()}
    </div>
  {/if}

  {#if expanded}
    <!-- Slack-style hover toolbar: overlaid on the row's trailing edge so
         revealing it never resizes the row or reflows the list. -->
    <span class="nr-hoverbar" data-testid="notification-hoverbar">
      {#each REACT_EMOJI as emoji (emoji)}
        <button
          class="nr-react"
          type="button"
          disabled={replyPending || reactionPending !== null}
          aria-busy={reactionPending === emoji}
          onclick={() => void react(emoji)}
          aria-label={`React with ${emoji}`}
        >
          {#if reactionPending === emoji}
            <span class="nr-spinner nr-spinner-small" aria-hidden="true"></span>
          {:else}
            {emoji}
          {/if}
        </button>
      {/each}
      {#if onaction}
        <button
          class="nr-message-action"
          type="button"
          data-testid="notification-message-action"
          aria-label={actionLabel ?? 'Run message action'}
          aria-busy={visibleActionPending}
          disabled={actionDisabled || visibleActionPending}
          onclick={() => void handleAction()}
        >
          {#if visibleActionPending}
            <span class="nr-spinner nr-spinner-small" aria-hidden="true"></span>
          {/if}
          {visibleActionPending ? 'Working…' : (actionLabel ?? 'Action')}
        </button>
      {/if}
    </span>
    <!-- Quick-reply overlay anchored below the row — out of normal flow, so
         opening it never pushes sibling rows (PRD US-007 stays reachable). -->
    <div
      class="nr-foot"
    >
      <input
        class="nr-reply"
        type="text"
        placeholder="Reply…"
        bind:this={replyInputEl}
        bind:value={replyText}
        disabled={replyPending}
        aria-invalid={replyError !== null}
        onfocus={() => {
          replyFocused = true;
        }}
        onblur={() => {
          replyFocused = false;
        }}
        onkeydown={onReplyKeydown}
      />
      {#if replyPending}
        <span class="nr-reply-status" data-testid="notification-reply-pending" aria-live="polite">Sending…</span>
      {/if}
      {#if replyError}
        <span
          class="nr-reply-error"
          data-testid="notification-reply-error"
          role="alert"
        >
          <span>{replyPending ? 'Retrying…' : replyError}</span>
          <button
            class="nr-retry"
            type="button"
            data-testid="notification-reply-retry"
            disabled={replyPending}
            aria-busy={replyPending}
            onclick={() => void submitReply()}
          >
            {replyPending ? 'Sending…' : 'Retry'}
          </button>
        </span>
      {/if}
      {#if reactionError}
        <span class="nr-reply-error" role="alert">
          <span>{reactionError}</span>
          <button
            class="nr-retry"
            type="button"
            disabled={reactionPending !== null}
            aria-busy={reactionPending !== null}
            onclick={() => {
              if (failedReaction) react(failedReaction);
            }}
          >
            {reactionPending ? 'Retrying…' : 'Retry'}
          </button>
        </span>
      {/if}
    </div>
  {:else if (!isMessage && (onopen || onaction || ondismiss)) || (isMessage && onaction)}
    <span class="nr-actions">
      {#if onaction || (!isMessage && onopen)}
        <button
          class="nr-open"
          type="button"
          aria-label={actionLabel ?? primaryActionLabel}
          aria-busy={visibleActionPending}
          onclick={() => void handleAction()}
          disabled={actionDisabled || visibleActionPending}
        >
          {#if visibleActionPending}
            <span class="nr-spinner nr-spinner-small" aria-hidden="true"></span>
          {/if}
          {visibleActionPending ? 'Working…' : (actionLabel ?? 'Open')}
        </button>
      {/if}
      {#if ondismiss}
        <button
          class="nr-dismiss"
          class:nr-dismiss-text={textDismiss}
          type="button"
          aria-label="Dismiss"
          onclick={() => ondismiss?.()}
        >
          {#if textDismiss}
            Dismiss
          {:else}
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
              />
            </svg>
          {/if}
        </button>
      {/if}
    </span>
  {/if}
  {#if openError || actionError}
    <span class="nr-action-error" role="alert">
      <span>{openError ?? actionError}</span>
      <button
        class="nr-retry"
        type="button"
        disabled={openPending || actionPending}
        aria-busy={openPending || actionPending}
        onclick={() => {
          if (openError) handleOpen();
          else handleAction();
        }}
      >
        {openPending || actionPending ? 'Retrying…' : 'Retry'}
      </button>
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
    position: relative;
    display: flex;
    align-items: center;
    gap: 0;
    min-height: 32px;
    padding: 0 10px;
    border-radius: 0;
    font-size: 12px;
    color: var(--popover-text);
    transition: background-color 120ms var(--ease-out);
    box-sizing: border-box;
  }

  .nr-comfortable {
    min-height: 36px;
    padding-block: 2px;
  }

  .nr-has-error {
    flex-wrap: wrap;
  }

  .nr-comfortable .nr-primary-action,
  .nr-comfortable .nr-primary-content {
    min-height: 36px;
    gap: 8px;
  }

  .nr-action-error {
    display: flex;
    flex: 1 0 100%;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 3px 0 2px 22px;
    color: var(--popover-danger, var(--popover-text));
    font-size: 10.5px;
    line-height: 1.3;
  }

  /* Selected row in a list (quick-window side pane) — persistent, not hover. */
  .nr-selected {
    background: transparent;
    box-shadow: inset 0 -1px 0 var(--popover-divider);
  }

  /* Hover/expanded message rows keep their exact one-line geometry — actions
     arrive as overlays (.nr-hoverbar / .nr-foot), never by growing the row. */
  .nr-message.nr-expanded {
    background: var(--popover-action-hover);
  }

  .nr-primary-action,
  .nr-primary-content {
    align-self: stretch;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 32px;
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: inherit;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
  }

  .nr-primary-action {
    appearance: none;
    cursor: pointer;
    transition: transform 120ms var(--ease-out);
  }

  .nr-primary-action:disabled {
    cursor: progress;
  }

  .nr-primary-action:focus-visible {
    outline: 2px solid var(--popover-text);
    outline-offset: -2px;
  }

  .nr-primary-action:active:not(:disabled) {
    transform: scale(0.995);
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

  /* Two weights only (owner round-2): regular for body/meta/timestamps,
     semibold reserved for a person actor. Company/ambient actors are muted
     regular text, not bold. */
  .nr-text {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 400;
    color: var(--popover-text);
  }

  .nr-actor {
    font-weight: 600;
    color: var(--popover-text);
  }

  .nr:not([data-type='message']):not([data-type='mention']) .nr-actor {
    font-weight: 400;
    color: var(--popover-text-muted);
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

  .nr-meta-type {
    max-width: 13ch;
    overflow: hidden;
    color: var(--popover-text-muted);
    font-size: 9.5px;
    font-weight: 400;
    letter-spacing: 0.035em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .nr-unread {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--popover-unread);
    flex-shrink: 0;
  }

  .nr-count {
    font-size: 10px;
    font-weight: 400;
    color: var(--popover-text-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    background: transparent;
    font-variant-numeric: tabular-nums;
  }

  .nr-agent {
    display: inline-flex;
    color: var(--popover-text-muted);
    width: 10px;
    height: 10px;
    vertical-align: -1px;
    margin-left: 3px;
  }

  /* Hover actions overlay the row's trailing edge (Slack-style toolbar) on a
     subtle backdrop — revealing them never changes row size or shifts the
     timestamp/siblings. */
  .nr-actions,
  .nr-hoverbar {
    position: absolute;
    right: 6px;
    top: 50%;
    transform: translateY(-50%);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 3px;
    border-radius: 6px;
    background: var(--popover-surface);
    box-shadow:
      inset 0 0 0 0.5px var(--popover-divider),
      0 1px 4px color-mix(in srgb, var(--popover-text) 10%, transparent);
    opacity: 0;
    pointer-events: none;
    z-index: 2;
  }

  .nr:not(.nr-message):hover .nr-actions,
  .nr:not(.nr-message):focus-within .nr-actions,
  .nr-message:not(.nr-expanded):hover .nr-actions,
  .nr-message:not(.nr-expanded):focus-within .nr-actions,
  .nr-expanded .nr-hoverbar {
    opacity: 1;
    pointer-events: auto;
  }

  .nr-open,
  .nr-message-action,
  .nr-dismiss {
    height: 20px;
    border-radius: 5px;
    background: var(--popover-action-hover);
    color: var(--popover-text);
    font-size: 10.5px;
    font-weight: 400;
    font-family: inherit;
    border: none;
    cursor: pointer;
    padding: 0 7px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    transition: transform 120ms var(--ease-out);
  }

  .nr-dismiss {
    width: 20px;
    padding: 0;
  }

  .nr-message-action {
    flex: 0 0 auto;
    height: 24px;
  }

  .nr-dismiss-text {
    width: auto;
    padding: 0 8px;
  }

  .nr-open:hover,
  .nr-message-action:hover,
  .nr-dismiss:hover,
  .nr-open:focus-visible,
  .nr-message-action:focus-visible,
  .nr-dismiss:focus-visible {
    outline: 1.5px solid var(--popover-text-muted);
    outline-offset: 1px;
  }

  .nr-open:disabled,
  .nr-message-action:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .nr-open:active:not(:disabled),
  .nr-message-action:active:not(:disabled),
  .nr-dismiss:active:not(:disabled),
  .nr-react:active:not(:disabled),
  .nr-retry:active:not(:disabled) {
    transform: scale(0.97);
  }

  .nr-spinner {
    width: 11px;
    height: 11px;
    flex: 0 0 auto;
    border: 1.5px solid color-mix(in srgb, currentColor 30%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: nr-spin 0.7s linear infinite;
  }

  .nr-spinner-small {
    width: 9px;
    height: 9px;
  }

  /* Quick-reply overlay — anchored below the row, out of normal flow so
     opening it never pushes sibling rows. */
  .nr-foot {
    position: absolute;
    top: calc(100% - 1px);
    left: 8px;
    right: 8px;
    z-index: 3;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 6px;
    border-radius: 8px;
    background: var(--popover-surface);
    box-shadow:
      inset 0 0 0 0.5px var(--popover-divider),
      0 8px 20px color-mix(in srgb, var(--popover-text) 14%, transparent);
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

  .nr-reply:focus-visible {
    border-color: var(--popover-text-muted);
    outline: 2px solid var(--popover-text-muted);
    outline-offset: 1px;
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

  .nr-react:disabled,
  .nr-reply:disabled {
    cursor: progress;
    opacity: 0.58;
  }

  .nr-reply-status {
    color: var(--popover-text-muted);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .nr-reply-error {
    display: flex;
    flex: 1 0 100%;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--popover-danger, var(--popover-text));
    font-size: 10px;
    line-height: 1.3;
  }

  .nr-retry {
    flex: 0 0 auto;
    padding: 0;
    border: 0;
    border-bottom: 1px solid currentColor;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .nr-retry:focus-visible {
    outline: 1.5px solid currentColor;
    outline-offset: 2px;
  }

  .nr-retry:disabled {
    cursor: progress;
    opacity: 0.58;
  }

  @keyframes nr-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .nr,
    .nr-primary-action,
    .nr-open,
    .nr-message-action,
    .nr-dismiss,
    .nr-react,
    .nr-retry {
      transition: none;
    }

    .nr {
      transition: none;
    }
    .nr-spinner {
      animation-duration: 1.4s;
    }

    .nr-primary-action:active:not(:disabled),
    .nr-open:active:not(:disabled),
    .nr-message-action:active:not(:disabled),
    .nr-dismiss:active:not(:disabled),
    .nr-react:active:not(:disabled),
    .nr-retry:active:not(:disabled) {
      transform: none;
    }
  }
</style>
