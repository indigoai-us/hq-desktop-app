<script lang="ts">
  // Shared conversation primitive: a scrollable, Slack-like message timeline plus a
  // reply composer. Extracted from DmDetail.svelte (US-008) so DMs, channels,
  // and threads can all render the same thread + composer surface. Pure
  // presentation — the parent owns the message list, the send call, and the
  // optimistic append; this component just renders `messages` and invokes the
  // `onsend` callback. Visuals (message row + composer CSS) live here so they travel
  // with the component.
  import { tick } from 'svelte';
  import ReactionBar from './ReactionBar.svelte';
  import IdentityMark from './IdentityMark.svelte';
  import { type ReactionMap } from '../../lib/reactions';
  import { copyableText, type CopyKind } from '../../lib/conversation-copy';
  import { renderMessageBodyMarkdown } from '../../lib/messageMarkdown';
  import { shareTitle } from '../../lib/share-path';
  import { sanitizeVisibleIdentifiers } from '../../lib/visible-labels';
  import type { ShareEvent } from '../../lib/notificationGroups';

  // One rendered message in the thread. `direction` is relative to the signed-in
  // user: "out" = I sent it, "in" = the other person sent it. Extra fields
  // beyond these are tolerated (channels/threads carry more) — only these are
  // read here.
  export interface ConversationMessage {
    eventId: string;
    fromPersonUid: string;
    fromDisplayName: string;
    body: string;
    details?: string | null;
    prompt?: string | null;
    createdAt: string;
    direction: 'in' | 'out';
    // Optimistic-send states (US-010). `pending` marks an outbound message that
    // was held behind a connection request — rendered with a "Pending" chip
    // until `dm:request-update` flips it (US-011). `pendingLabel` is the chip
    // text (e.g. "Pending — waiting for Ada to accept").
    pending?: boolean;
    pendingLabel?: string | null;
    // Threads (US-022). A root message carries its own eventId as `rootEventId`
    // and a `replyCount`; when `replyCount > 0` a tap-visible "{n} replies · last
    // {time}" affordance renders under the bubble and opens the thread via
    // `onopenthread`. `lastReplyAt` (ISO) drives the "last {time}" stamp.
    rootEventId?: string | null;
    replyCount?: number | null;
    lastReplyAt?: string | null;
    // Share timeline (share history in Messages). When set, the bubble renders
    // as a distinct inline share card (file icon, filename(s), note,
    // permission, timestamp) instead of a plain text body. `prompt` carries
    // the templated share prompt so the standard Copy-prompt action works; the
    // host passes `onopenshareinclaude` for the Open-in-Claude action.
    share?: ShareEvent | null;
  }

  interface Props {
    messages: ConversationMessage[];
    // Retained for API compatibility. The timeline now identifies every sender,
    // including DMs, so authorship never depends on bubble alignment alone.
    showAuthors?: boolean;
    loading?: boolean;
    error?: string | null;
    /** Retry a failed thread/channel hydration without replacing the pane. */
    onretryload?: () => void | Promise<void>;
    // Composer state, owned by the parent so "Sending…"/disabled/error stays in
    // lockstep with the actual send call.
    sending?: boolean;
    sendError?: string | null;
    placeholder?: string;
    // Called with the trimmed composer text when the user sends. The parent
    // performs the send + optimistic append; on success it should leave
    // `sendError` null, which clears the composer.
    onsend: (text: string) => void | Promise<void>;
    // Reserved for later stories (reactions). No-op by default.
    onreact?: (eventId: string) => void;
    // Threads (US-022). Called with a root message's `rootEventId` when the user
    // taps its reply-count affordance — the parent opens the ThreadPanel.
    onopenthread?: (rootEventId: string) => void;
    // When set, the root bubble whose `rootEventId` matches gets an "active
    // thread" highlight (the ThreadPanel for it is open).
    activeRootEventId?: string | null;
    // Reactions (US-025). The host owns the reaction map (messageId → sorted
    // aggregates) and the toggle. When `ontogglereaction` is set, a ReactionBar
    // renders under every bubble (pills + a tap-visible add-reaction trigger).
    // Hosts that don't support reactions (e.g. an invited-not-joined channel
    // preview) simply omit the callback and no bar renders.
    reactions?: ReactionMap;
    ontogglereaction?: (messageId: string, emoji: string) => void;
    // Share timeline: called with a share-card bubble's ShareEvent when its
    // "Open in Claude" action is tapped (the host owns the deep link).
    onopenshareinclaude?: (share: ShareEvent) => void | Promise<void>;
    // When true, the reply composer is hidden and a static note renders in its
    // place. Used for read-only history or preview panes that have no writable
    // recipient yet.
    readonly?: boolean;
  }

  // `onreact` is part of the public API for a later story (reactions) but unused
  // here, so it's intentionally left out of the destructure to avoid
  // unused-binding noise — it still type-checks as an accepted prop.
  let {
    messages,
    loading = false,
    error = null,
    onretryload,
    sending = false,
    sendError = null,
    placeholder = 'Reply…',
    onsend,
    onopenthread,
    activeRootEventId = null,
    reactions = {},
    ontogglereaction,
    onopenshareinclaude,
    readonly = false,
  }: Props = $props();

  const messageAuthor = (msg: ConversationMessage) =>
    msg.direction === 'out' ? 'You' : (msg.fromDisplayName?.trim() || 'Unknown sender');

  let replyText = $state('');
  // Tracks the last successful copy so the "Copied!" feedback stays scoped to
  // the exact affordance the user clicked — a bubble can offer both a
  // copy-message and a copy-prompt action.
  let copied = $state<{ id: string; kind: CopyKind } | null>(null);
  let copyingKeys = $state(new Set<string>());
  let openingShareIds = $state(new Set<string>());
  type MessageActionKind = CopyKind | 'open-share';
  let actionFailures = $state(new Map<string, string>());
  const isCopied = (id: string, kind: CopyKind) =>
    copied?.id === id && copied?.kind === kind;
  const actionKey = (id: string, kind: MessageActionKind) => `${id}:${kind}`;
  const copyKey = (id: string, kind: CopyKind) => actionKey(id, kind);
  const isCopying = (id: string, kind: CopyKind) => copyingKeys.has(copyKey(id, kind));
  const actionFailure = (id: string, kind: MessageActionKind) =>
    actionFailures.get(actionKey(id, kind)) ?? null;
  const setActionFailure = (id: string, kind: MessageActionKind, message: string | null) => {
    const next = new Map(actionFailures);
    const key = actionKey(id, kind);
    if (message) next.set(key, message);
    else next.delete(key);
    actionFailures = next;
  };
  let scrollEl = $state<HTMLDivElement | null>(null);
  let nearBottom = $state(true);
  let newMessagesAvailable = $state(false);
  let retryingLoad = $state(false);
  let positionedInitialThread = false;
  let previousMessageCount = 0;
  let scrollUpdateGeneration = 0;
  const NEAR_BOTTOM_PX = 72;
  const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

  function isNearBottom(element: HTMLDivElement): boolean {
    return element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_PX;
  }

  function handleThreadScroll(): void {
    if (!scrollEl) return;
    nearBottom = isNearBottom(scrollEl);
    if (nearBottom) newMessagesAvailable = false;
  }

  function jumpToLatest(): void {
    if (!scrollEl) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
    nearBottom = true;
    newMessagesAvailable = false;
  }

  async function retryLoad(): Promise<void> {
    if (!onretryload || retryingLoad || loading) return;
    retryingLoad = true;
    try {
      await onretryload();
    } finally {
      retryingLoad = false;
    }
  }

  // Preserve the reader's place when older content is in view. Initial hydration
  // and already-bottomed conversations follow new content; otherwise a quiet
  // jump affordance appears instead of stealing the scroll position.
  $effect(() => {
    const count = messages.length;
    const previousCount = previousMessageCount;
    const addedMessages = count > previousCount;
    const shouldFollow = !positionedInitialThread || nearBottom;
    const generation = ++scrollUpdateGeneration;
    previousMessageCount = count;

    if (count === 0) {
      positionedInitialThread = false;
      newMessagesAvailable = false;
      nearBottom = true;
      return;
    }

    void (async () => {
      await tick();
      if (generation !== scrollUpdateGeneration || !scrollEl) return;
      if (shouldFollow) {
        scrollEl.scrollTop = scrollEl.scrollHeight;
        nearBottom = true;
        newMessagesAvailable = false;
      } else if (addedMessages) {
        newMessagesAvailable = true;
      }
      positionedInitialThread = true;
    })();
  });

  async function send(): Promise<void> {
    const text = replyText.trim();
    if (!text || sending) return;
    await onsend(text);
    // Clear the composer only on a clean send. The parent sets `sendError`
    // inside `onsend` (synchronously, in its catch) when the send fails, so a
    // null `sendError` here means success — matching DmDetail's prior behavior
    // of clearing `replyText` only in the try path.
    if (!sendError) replyText = '';
  }

  function onReplyKeydown(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void send();
    }
  }

  function formatTime(iso: string): string {
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(iso));
    } catch {
      return '';
    }
  }

  function dayKey(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toDateString();
  }

  function formatDateSeparator(iso: string): string {
    try {
      return new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(new Date(iso));
    } catch {
      return '';
    }
  }

  function startsNewDay(index: number): boolean {
    if (index === 0) return true;
    return dayKey(messages[index - 1]?.createdAt ?? '') !== dayKey(messages[index]?.createdAt ?? '');
  }

  function senderKey(message: ConversationMessage): string {
    return message.fromPersonUid.trim() || message.fromDisplayName.trim();
  }

  function messagesShareGroup(
    previous: ConversationMessage | undefined,
    current: ConversationMessage | undefined,
  ): boolean {
    if (!previous || !current) return false;
    if (previous.direction !== current.direction) return false;
    if (senderKey(previous) !== senderKey(current)) return false;
    if (dayKey(previous.createdAt) !== dayKey(current.createdAt)) return false;

    const previousTime = new Date(previous.createdAt).getTime();
    const currentTime = new Date(current.createdAt).getTime();
    if (Number.isNaN(previousTime) || Number.isNaN(currentTime)) return false;

    const elapsed = currentTime - previousTime;
    return elapsed >= 0 && elapsed <= MESSAGE_GROUP_WINDOW_MS;
  }

  function startsMessageGroup(index: number): boolean {
    return !messagesShareGroup(messages[index - 1], messages[index]);
  }

  function endsMessageGroup(index: number): boolean {
    return !messagesShareGroup(messages[index], messages[index + 1]);
  }

  // Short relative-time stamp for the "last {time}" reply affordance (US-022).
  // Falls back to the absolute clock time for anything older than a day or
  // unparseable.
  function formatRelative(iso: string | null | undefined): string {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';
    const diffMs = Date.now() - then;
    if (diffMs < 0) return 'now';
    const sec = Math.floor(diffMs / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return formatTime(iso);
  }

  // True when this message is a thread root that should show the reply-count
  // affordance (it carries a rootEventId and at least one reply).
  function hasReplies(msg: ConversationMessage): boolean {
    return !!msg.rootEventId && (msg.replyCount ?? 0) > 0;
  }

  function openThread(rootEventId: string | null | undefined): void {
    const id = rootEventId?.trim();
    if (id) onopenthread?.(id);
  }

  // Copy either a message's body or its attached agent prompt to the clipboard.
  // The text selection (trim + empty→null) lives in the pure `copyableText`
  // helper so it stays unit-tested; here we just perform the write and flash the
  // scoped "Copied!" feedback.
  async function copyText(id: string, kind: CopyKind, msg: ConversationMessage): Promise<void> {
    const text = copyableText(msg, kind);
    const key = copyKey(id, kind);
    if (!text || copyingKeys.has(key)) return;
    copyingKeys = new Set(copyingKeys).add(key);
    try {
      await navigator.clipboard.writeText(text);
      setActionFailure(id, kind, null);
      copied = { id, kind };
      setTimeout(() => {
        if (copied?.id === id && copied?.kind === kind) copied = null;
      }, 1800);
    } catch (err) {
      console.error('conversation: clipboard write failed', err);
      setActionFailure(id, kind, 'Couldn’t copy this message.');
    } finally {
      const next = new Set(copyingKeys);
      next.delete(key);
      copyingKeys = next;
    }
  }

  async function openShare(id: string, share: ShareEvent): Promise<void> {
    if (!onopenshareinclaude || openingShareIds.has(id)) return;
    openingShareIds = new Set(openingShareIds).add(id);
    try {
      await onopenshareinclaude(share);
      setActionFailure(id, 'open-share', null);
    } catch (err) {
      console.error('conversation: open share failed', err);
      setActionFailure(id, 'open-share', 'Couldn’t open this share in Claude Code.');
    } finally {
      const next = new Set(openingShareIds);
      next.delete(id);
      openingShareIds = next;
    }
  }

  function retryMessageAction(msg: ConversationMessage, kind: MessageActionKind): void {
    if (kind === 'open-share') {
      if (msg.share) void openShare(msg.eventId, msg.share);
      return;
    }
    void copyText(msg.eventId, kind, msg);
  }

  function actionPending(id: string, kind: MessageActionKind): boolean {
    return kind === 'open-share' ? openingShareIds.has(id) : isCopying(id, kind);
  }
</script>

<div class="dm-thread-wrap">
  <div
    class="dm-thread"
    bind:this={scrollEl}
    onscroll={handleThreadScroll}
    aria-busy={loading}
  >
    {#if loading}
      <p class="dm-thread-status">
        <span class="inline-spinner" aria-hidden="true"></span>
        Loading conversation…
      </p>
    {/if}
    {#if error}
      <div class="dm-thread-status dm-thread-error" role="alert">
        <span>{error}</span>
        {#if onretryload}
          <button
            class="load-retry"
            type="button"
            onclick={() => void retryLoad()}
            disabled={loading || retryingLoad}
            aria-busy={loading || retryingLoad}
          >
            {#if loading || retryingLoad}
              <span class="inline-spinner" aria-hidden="true"></span>
            {/if}
            {loading || retryingLoad ? 'Retrying…' : 'Retry'}
          </button>
        {/if}
      </div>
    {/if}

    {#each messages as msg, index (msg.eventId)}
    {@const groupStart = startsMessageGroup(index)}
    {@const groupEnd = endsMessageGroup(index)}
    {#if startsNewDay(index)}
      <div class="date-separator" aria-label={formatDateSeparator(msg.createdAt)}>
        <span>{formatDateSeparator(msg.createdAt)}</span>
      </div>
    {/if}
      <div
        class="dm-msg dm-msg-{msg.direction}"
        class:dm-msg-group-start={groupStart}
        class:dm-msg-group-end={groupEnd}
      >
      {#if groupStart}
        <span class="dm-msg-avatar">
          <IdentityMark kind="person" label={messageAuthor(msg)} size="regular" />
        </span>
      {:else}
        <span class="dm-msg-avatar-spacer" aria-hidden="true"></span>
      {/if}
      <div class="dm-msg-column">
      {#if groupStart}
        <div class="dm-msg-meta">
          <span class="dm-msg-author">{messageAuthor(msg)}</span>
          <span class="dm-msg-header-time">{formatTime(msg.createdAt)}</span>
        </div>
      {:else}
        <span class="sr-only">From {messageAuthor(msg)} at {formatTime(msg.createdAt)}</span>
      {/if}
      <div
        class="dm-bubble"
        class:dm-bubble-share={!!msg.share}
        class:dm-bubble-thread-active={!!activeRootEventId && msg.rootEventId === activeRootEventId}
      >
        <!-- Copy the whole message. Hover/focus-revealed on every bubble so it
             stays out of the way until wanted; copying the agent prompt is a
             separate, always-visible labelled action below. -->
        <div class="dm-bubble-actions">
          <button
            type="button"
            class="dm-action"
            class:dm-action-done={isCopied(msg.eventId, 'body')}
            onclick={() => copyText(msg.eventId, 'body', msg)}
            disabled={isCopying(msg.eventId, 'body')}
            aria-busy={isCopying(msg.eventId, 'body')}
            aria-label={isCopying(msg.eventId, 'body')
              ? 'Copying message'
              : actionFailure(msg.eventId, 'body')
                ? 'Copy message failed; retry'
              : isCopied(msg.eventId, 'body')
                ? 'Message copied'
                : 'Copy message'}
            title={isCopying(msg.eventId, 'body')
              ? 'Copying…'
              : actionFailure(msg.eventId, 'body')
                ? 'Copy failed — retry'
              : isCopied(msg.eventId, 'body')
                ? 'Copied!'
                : 'Copy message'}
          >
            {#if isCopying(msg.eventId, 'body')}
              <span class="action-spinner" aria-hidden="true"></span>
            {:else if isCopied(msg.eventId, 'body')}
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            {:else}
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3" />
                <path d="M3.5 10.5H3A1.5 1.5 0 0 1 1.5 9V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            {/if}
          </button>
        </div>
        {#if msg.share}
          {@const share = msg.share}
          <!-- Inline share card: file icon + filename(s), note, permission. -->
          <div class="share-card" class:share-card-multi={share.paths.length > 1}>
            <div class="share-card-head">
              <span class="share-card-icon" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
                  <path d="M9 1.5V5.5H13" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
                </svg>
              </span>
              <span class="share-card-label">
                Shared {share.paths.length === 1 ? 'a file' : `${share.paths.length} files`}
              </span>
              <span class="share-card-permission">{share.permission}</span>
            </div>
            <ul class="share-card-paths">
              {#each share.paths as p (p)}
                <li class="share-card-path" title={p}>{shareTitle(p)}</li>
              {/each}
            </ul>
            {#if share.note}
              <p class="share-card-note">{share.note}</p>
            {/if}
          </div>
        {:else}
          <div class="dm-bubble-body selectable-text">{@html renderMessageBodyMarkdown(msg.body)}</div>
        {/if}
        {#if msg.details}
          <div class="dm-bubble-details selectable-text">{msg.details}</div>
        {/if}
        {#if msg.prompt || msg.share}
          <div class="dm-bubble-cta-row">
            {#if msg.prompt}
              <button
                class="btn btn-copy"
                onclick={() => copyText(msg.eventId, 'prompt', msg)}
                disabled={isCopying(msg.eventId, 'prompt')}
                aria-busy={isCopying(msg.eventId, 'prompt')}
                aria-label={msg.share ? 'Copy share prompt to clipboard' : 'Copy agent prompt to clipboard'}
              >
                {isCopying(msg.eventId, 'prompt')
                  ? 'Copying…'
                  : actionFailure(msg.eventId, 'prompt')
                    ? 'Retry copy'
                  : isCopied(msg.eventId, 'prompt')
                    ? 'Copied!'
                    : 'Copy prompt'}
              </button>
            {/if}
            {#if msg.share && onopenshareinclaude}
              {@const share = msg.share}
              <button
                class="btn btn-copy"
                onclick={() => void openShare(msg.eventId, share)}
                disabled={openingShareIds.has(msg.eventId)}
                aria-busy={openingShareIds.has(msg.eventId)}
                aria-label="Open share in Claude Code with prompt"
              >
                {openingShareIds.has(msg.eventId)
                  ? 'Opening…'
                  : actionFailure(msg.eventId, 'open-share')
                    ? 'Retry open'
                    : 'Open in Claude ↗'}
              </button>
            {/if}
          </div>
        {/if}
        {#each (['body', 'prompt', 'open-share'] as const) as actionKind}
          {@const failure = actionFailure(msg.eventId, actionKind)}
          {#if failure}
            <div class="dm-action-error" role="alert">
              <span>{failure}</span>
              <button
                class="dm-action-retry"
                type="button"
                disabled={actionPending(msg.eventId, actionKind)}
                aria-busy={actionPending(msg.eventId, actionKind)}
                onclick={() => retryMessageAction(msg, actionKind)}
              >
                {actionPending(msg.eventId, actionKind) ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          {/if}
        {/each}
      </div>
      {#if hasReplies(msg)}
        <button
          class="thread-affordance"
          type="button"
          onclick={() => openThread(msg.rootEventId)}
          aria-label={`Open thread — ${msg.replyCount} ${(msg.replyCount ?? 0) === 1 ? 'reply' : 'replies'}`}
        >
          <span class="thread-affordance-count">
            {msg.replyCount}
            {(msg.replyCount ?? 0) === 1 ? 'reply' : 'replies'}
          </span>
          {#if msg.lastReplyAt}
            <span class="thread-affordance-time">· last {formatRelative(msg.lastReplyAt)}</span>
          {/if}
        </button>
      {/if}
      {#if ontogglereaction && !msg.pending}
        <ReactionBar
          messageId={msg.eventId}
          reactions={reactions[msg.eventId]}
          ontoggle={ontogglereaction}
        />
      {/if}
      {#if msg.pending}
        <span class="dm-msg-pending">
          {sanitizeVisibleIdentifiers(msg.pendingLabel || 'Pending')}
        </span>
      {:else if msg.direction === 'out' && groupEnd}
        <span class="dm-msg-time">Delivered</span>
      {:else if !groupEnd}
        <span class="sr-only">
          Sent at {formatTime(msg.createdAt)}{msg.direction === 'out' ? ' · Delivered' : ''}
        </span>
      {/if}
      </div>
      </div>
    {/each}
  </div>

  {#if newMessagesAvailable}
    <button
      class="new-messages-jump"
      type="button"
      onclick={jumpToLatest}
      aria-label="Jump to new messages"
    >
      New messages
      <span aria-hidden="true">↓</span>
    </button>
  {/if}
</div>

{#if readonly}
  <div class="dm-reply dm-reply-readonly">
    <span class="dm-reply-hint">Replies aren’t available in this preview.</span>
  </div>
{:else}
  <div class="dm-reply">
    <textarea
      class="dm-reply-input"
      bind:value={replyText}
      onkeydown={onReplyKeydown}
      {placeholder}
      rows="3"
      disabled={sending}
      aria-label="Reply message"
    ></textarea>
    <div class="dm-reply-footer">
      {#if sendError}
        <span class="dm-reply-error" role="alert">{sendError}</span>
      {:else}
        <span class="dm-reply-hint">⌘↵ to send</span>
      {/if}
      <button
        class="btn btn-send"
        onclick={send}
        disabled={sending || replyText.trim().length === 0}
        aria-busy={sending}
      >
        {#if sending}
          <span class="inline-spinner" aria-hidden="true"></span>
        {/if}
        {sending ? 'Sending…' : 'Send'}
      </button>
    </div>
  </div>
{/if}

<style>
  /* ── Thread (scrollable conversation) ─────────────────────────────────── */

  .dm-thread-wrap {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
  }

  .dm-thread {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 1rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0;
    scrollbar-width: thin;
    scrollbar-color: var(--pop-muted) transparent;
  }

  .dm-thread::-webkit-scrollbar {
    width: 6px;
  }

  .dm-thread::-webkit-scrollbar-thumb {
    background: var(--pop-hover);
    border-radius: 3px;
  }

  .dm-thread-status {
    margin: 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--text-base);
    color: var(--pop-muted);
  }

  .dm-thread-error {
    flex-wrap: wrap;
    justify-content: center;
    color: var(--red, var(--popover-danger));
  }

  .load-retry,
  .new-messages-jump {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.3125rem;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  .load-retry {
    padding: 0.1875rem 0;
    border-bottom: 1px solid currentColor;
  }

  .new-messages-jump {
    position: absolute;
    left: 50%;
    bottom: 0.625rem;
    z-index: 3;
    padding: 0.375rem 0.625rem;
    border: 1px solid var(--pop-border);
    border-radius: 999px;
    background: var(--pop-bg);
    color: var(--pop-text);
    box-shadow: 0 8px 24px color-mix(in srgb, #000 16%, transparent);
    transform: translateX(-50%);
    white-space: nowrap;
  }

  .load-retry:active:not(:disabled) {
    transform: scale(0.97);
  }

  .new-messages-jump:active:not(:disabled) {
    transform: translateX(-50%) scale(0.97);
  }

  .load-retry:focus-visible,
  .new-messages-jump:focus-visible {
    outline: 2px solid var(--pop-text);
    outline-offset: 2px;
  }

  .load-retry:disabled {
    cursor: progress;
    opacity: 0.65;
  }

  .dm-msg {
    display: flex;
    flex-direction: column;
    max-width: min(80%, 420px);
    margin-top: 0.1875rem;
  }

  .dm-msg-group-start {
    margin-top: 0.75rem;
  }

  .date-separator + .dm-msg {
    margin-top: 0.125rem;
  }

  .dm-msg-in {
    align-self: flex-start;
    align-items: flex-start;
  }

  .dm-msg-out {
    align-self: flex-end;
    align-items: flex-end;
  }

  .dm-msg-author {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--pop-muted);
    margin: 0 0.25rem 0.125rem;
  }

  .dm-bubble {
    position: relative;
    padding: 0.5rem 0.75rem;
    border-radius: 16px;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* Hover/focus copy-message toolbar, pinned to the bubble's top-right. Hidden
     until the bubble is hovered or something inside it is focused (keyboard
     users reach the button by Tab), so it never clutters the thread. */
  .dm-bubble-actions {
    position: absolute;
    /* Float just above the bubble's top-right corner so the control never sits
       over the message text on hover (Slack/Discord pattern). */
    top: -0.625rem;
    right: 0.375rem;
    z-index: 2;
    display: flex;
    gap: 0.125rem;
    opacity: 0;
    transition: opacity 0.12s ease;
  }

  .dm-bubble:hover .dm-bubble-actions,
  .dm-bubble:focus-within .dm-bubble-actions {
    opacity: 1;
  }

  .dm-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.375rem;
    height: 1.375rem;
    padding: 0;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    background: var(--pop-bg);
    color: var(--pop-text);
    font-size: var(--text-base);
    transition: background-color 0.12s ease, color 0.12s ease;
  }

  .dm-action:hover {
    background: var(--pop-hover);
  }

  .dm-action:focus-visible {
    outline: 2px solid var(--pop-border);
    outline-offset: 1px;
  }

  .dm-action-done {
    color: var(--emerald, var(--popover-success));
  }

  .action-spinner {
    width: 0.75rem;
    height: 0.75rem;
    border: 1.5px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: conversation-spin 0.75s linear infinite;
  }

  .inline-spinner {
    width: 0.75rem;
    height: 0.75rem;
    flex: 0 0 auto;
    border: 1.5px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: conversation-spin 0.72s linear infinite;
  }

  @keyframes conversation-spin {
    to { transform: rotate(360deg); }
  }

  .dm-msg-in .dm-bubble {
    background: var(--pop-hover);
    border-bottom-left-radius: 4px;
  }

  .dm-msg-out .dm-bubble {
    background: var(--c-btn2-bg);
    border-bottom-right-radius: 4px;
  }

  .dm-bubble-body {
    --message-markdown-text: var(--fg, var(--pop-text, #e8e8e8));
    --message-markdown-muted: var(--muted, var(--pop-muted, #a0a0a0));
    --message-markdown-border: var(--border, var(--pop-divider, rgba(255, 255, 255, 0.14)));
    --message-markdown-surface: var(--surface-raise, var(--c-field-bg, rgba(255, 255, 255, 0.06)));
    min-width: 0;
    max-width: 100%;
    margin: 0;
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif);
    font-size: var(--text-base);
    line-height: 1.55;
    color: var(--message-markdown-text);
    white-space: normal;
    overflow-wrap: anywhere;
    word-break: normal;
  }

  .dm-bubble-body > :global(:first-child) {
    margin-top: 0;
  }

  .dm-bubble-body > :global(:last-child) {
    margin-bottom: 0;
  }

  .dm-bubble-body :global(p) {
    margin: 0.375rem 0;
    color: inherit;
  }

  .dm-bubble-body :global(h1),
  .dm-bubble-body :global(h2),
  .dm-bubble-body :global(h3),
  .dm-bubble-body :global(h4),
  .dm-bubble-body :global(h5),
  .dm-bubble-body :global(h6) {
    margin: 1rem 0 0.4rem;
    color: var(--message-markdown-text);
    font-family: var(--font-display, var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif));
    font-weight: 650;
    line-height: 1.18;
    letter-spacing: -0.02em;
  }

  .dm-bubble-body :global(h1) {
    font-size: 1.42em;
  }

  .dm-bubble-body :global(h2) {
    font-size: 1.28em;
  }

  .dm-bubble-body :global(h3) {
    font-size: 1.14em;
  }

  .dm-bubble-body :global(h4),
  .dm-bubble-body :global(h5),
  .dm-bubble-body :global(h6) {
    font-size: 1em;
  }

  .dm-bubble-body :global(ul),
  .dm-bubble-body :global(ol) {
    margin: 0.625rem 0;
    padding-left: 1.4rem;
  }

  .dm-bubble-body :global(li) {
    margin: 0.3rem 0;
    padding-left: 0.2rem;
    line-height: 1.5;
  }

  .dm-bubble-body :global(li > ul),
  .dm-bubble-body :global(li > ol) {
    margin: 0.1875rem 0;
  }

  .dm-bubble-body :global(.task-list) {
    padding-left: 0;
    list-style: none;
  }

  .dm-bubble-body :global(.task-list-item) {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding-left: 0;
  }

  .dm-bubble-body :global(.task-list-item input) {
    flex: 0 0 auto;
    margin: 0.25em 0 0;
    accent-color: var(--message-markdown-muted);
  }

  .dm-bubble-body :global(.task-list-content) {
    min-width: 0;
  }

  .dm-bubble-body :global(a) {
    color: var(--message-markdown-text);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, currentColor 45%, transparent);
    text-underline-offset: 0.125rem;
  }

  .dm-bubble-body :global(a:hover) {
    text-decoration-color: currentColor;
  }

  .dm-bubble-body :global(a:focus-visible) {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }

  .dm-bubble-body :global(strong) {
    color: var(--message-markdown-text);
    font-weight: 650;
  }

  .dm-bubble-body :global(del) {
    color: var(--message-markdown-muted);
  }

  .dm-bubble-body :global(code) {
    padding: 0.0625rem 0.25rem;
    border-radius: 4px;
    background: var(--message-markdown-surface);
    color: var(--message-markdown-text);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 0.92em;
  }

  .dm-bubble-body :global(pre) {
    max-width: 100%;
    margin: 0.625rem 0;
    padding: 0.625rem 0.75rem;
    overflow-x: auto;
    border: 1px solid var(--message-markdown-border);
    border-radius: 0;
    background: var(--message-markdown-surface);
    color: var(--message-markdown-text);
    line-height: 1.5;
    white-space: pre;
    overflow-wrap: normal;
    word-break: normal;
    scrollbar-width: thin;
    scrollbar-color: var(--message-markdown-muted) transparent;
  }

  .dm-bubble-body :global(pre code) {
    padding: 0;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font-size: 0.9em;
    white-space: inherit;
  }

  .dm-bubble-body :global(blockquote) {
    margin: 0.625rem 0;
    padding: 0.0625rem 0 0.0625rem 0.75rem;
    border-left: 2px solid var(--message-markdown-border);
    background: transparent;
    color: var(--message-markdown-muted);
  }

  .dm-bubble-body :global(blockquote p) {
    color: inherit;
  }

  .dm-bubble-body :global(hr) {
    margin: 0.75rem 0;
    border: 0;
    border-top: 1px solid var(--message-markdown-border);
  }

  .dm-bubble-body :global(img) {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0.625rem 0;
    border-radius: 0;
  }

  .dm-bubble-body :global(.markdown-table-scroll) {
    width: 100%;
    max-width: 100%;
    margin: 0.625rem 0;
    overflow-x: auto;
    border: 0;
    border-radius: 0;
    background: transparent;
    scrollbar-width: thin;
    scrollbar-color: var(--message-markdown-muted) transparent;
  }

  .dm-bubble-body :global(.markdown-table-scroll:focus-visible) {
    outline: 2px solid var(--message-markdown-text);
    outline-offset: 2px;
  }

  .dm-bubble-body :global(table) {
    width: 100%;
    min-width: max-content;
    border-spacing: 0;
    border-collapse: collapse;
    color: inherit;
    font-size: 0.9em;
    line-height: 1.4;
    font-variant-numeric: tabular-nums;
  }

  .dm-bubble-body :global(th),
  .dm-bubble-body :global(td) {
    padding: 0.4375rem 0.625rem;
    border-right: 1px solid var(--message-markdown-border);
    border-bottom: 1px solid var(--message-markdown-border);
    text-align: left;
    vertical-align: top;
  }

  .dm-bubble-body :global(th:first-child),
  .dm-bubble-body :global(td:first-child) {
    padding-left: 0;
  }

  .dm-bubble-body :global(th:last-child),
  .dm-bubble-body :global(td:last-child) {
    padding-right: 0;
    border-right: 0;
  }

  .dm-bubble-body :global(tbody tr:last-child td) {
    border-bottom: 0;
  }

  .dm-bubble-body :global(th) {
    color: var(--message-markdown-text);
    font-weight: 650;
  }

  .dm-bubble-body :global(.markdown-align-center) {
    text-align: center;
  }

  .dm-bubble-body :global(.markdown-align-right) {
    text-align: right;
  }

  .dm-bubble-details {
    font-size: var(--text-base);
    line-height: 1.5;
    color: var(--pop-text);
    background: transparent;
    border: 0;
    border-top: 1px solid var(--c-field-border);
    padding: 0.5rem 0 0;
    border-radius: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .dm-msg-time {
    font-size: var(--text-base);
    color: var(--pop-muted);
    margin: 0.125rem 0.25rem 0;
  }

  .dm-msg-pending {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--pop-muted);
    background: transparent;
    padding: 0;
    border-radius: 0;
    margin: 0.1875rem 0.25rem 0;
  }

  .date-separator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.5rem 0;
    color: var(--pop-muted);
    font-size: var(--text-base);
  }

  .date-separator::before,
  .date-separator::after {
    content: '';
    height: 1px;
    flex: 1;
    background: var(--pop-divider);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* ── Thread reply-count affordance (US-022) ───────────────────────────── */
  /* Tap-visible (NOT hover-gated) — the standalone window is frameless and has
     no reliable hover, so the affordance is always rendered under a root bubble
     that has replies. */

  .thread-affordance {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    align-self: inherit;
    margin: 0.25rem 0.125rem 0;
    padding: 0.1875rem 0.5rem;
    border: 1px solid var(--pop-border);
    border-radius: 999px;
    background: var(--pop-hover);
    color: var(--pop-text);
    font-family: inherit;
    font-size: var(--text-base);
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    transition: background-color 0.12s ease, border-color 0.12s ease;
  }

  .thread-affordance:hover,
  .thread-affordance:focus-visible {
    background: var(--c-field-bg);
    border-color: var(--c-field-border);
    outline: none;
  }

  .thread-affordance-count {
    font-weight: 600;
  }

  .thread-affordance-time {
    font-weight: 500;
    color: var(--pop-muted);
  }

  /* The root bubble of the thread currently open in the ThreadPanel. */
  .dm-bubble-thread-active {
    box-shadow:
      0 0 0 1px var(--pop-border),
      0 0 0 4px var(--pop-hover);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: 0.3125rem;
    padding: 0.3125rem 0.625rem;
    border-radius: 6px;
    font-size: var(--text-base);
    font-weight: 500;
    cursor: pointer;
    border: none;
    transition: background-color 0.12s ease, color 0.12s ease;
    font-family: inherit;
  }

  .btn-copy {
    background: var(--pop-hover);
    color: var(--pop-text);
  }

  .btn-copy:hover {
    background: var(--c-field-bg);
  }

  .dm-bubble-cta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .dm-action-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.625rem;
    margin-top: 0.375rem;
    padding-top: 0.375rem;
    border-top: 1px solid var(--pop-divider);
    color: var(--popover-danger, var(--pop-text));
    font-size: 0.6875rem;
    line-height: 1.35;
  }

  .dm-action-retry {
    flex: 0 0 auto;
    padding: 0;
    border: 0;
    border-bottom: 1px solid currentColor;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 650;
    cursor: pointer;
    transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  @media (hover: hover) and (pointer: fine) {
    .dm-action-retry:hover:not(:disabled) {
      border-bottom-color: transparent;
    }
  }

  .dm-action-retry:active:not(:disabled) {
    transform: scale(0.97);
  }

  .dm-action-retry:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }

  .dm-action-retry:disabled {
    cursor: progress;
    opacity: 0.58;
  }

  /* ── Inline share card (share history in Messages) ────────────────────── */

  .share-card {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    min-width: 180px;
  }

  .share-card-head {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .share-card-icon {
    display: inline-flex;
    color: var(--popover-text-muted, #a0a0a0);
  }

  .share-card-label {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--popover-text, #e8e8e8);
  }

  .share-card-permission {
    margin-left: auto;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--popover-text-muted, #a0a0a0);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 999px;
    padding: 0.0625rem 0.375rem;
  }

  .share-card-paths {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .share-card-path {
    font-size: var(--text-base);
    color: var(--popover-text, #e0e0e0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .share-card-note {
    margin: 0;
    font-size: var(--text-base);
    color: var(--popover-text, #e0e0e0);
    background: transparent;
    border: 0;
    border-top: 1px solid var(--popover-divider, rgba(255, 255, 255, 0.15));
    padding: 0.375rem 0 0;
    border-radius: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Messages-window (desktop token) skin for the share card. */
  :global([data-window='messages']) .share-card-label {
    color: var(--fg);
  }

  :global([data-window='messages']) .share-card-icon {
    color: var(--muted-2);
  }

  :global([data-window='messages']) .share-card-permission {
    font-family: var(--font-mono);
    color: var(--muted-2);
    border-color: var(--border-strong);
  }

  :global([data-window='messages']) .share-card-path {
    color: var(--fg);
  }

  :global([data-window='messages']) .share-card-note {
    font-size: var(--text-base);
    color: var(--fg);
    background: transparent;
    border-top-color: var(--border-strong);
    border-radius: 0;
  }

  /* ── Reply composer ───────────────────────────────────────────────────── */

  .dm-reply {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.875rem 1.25rem 1rem;
    border-top: 1px solid var(--pop-divider);
  }

  .dm-reply-input {
    width: 100%;
    box-sizing: border-box;
    resize: none;
    padding: 0.5rem 0.625rem;
    border-radius: 8px;
    border: 1px solid var(--pop-border);
    background: var(--pop-hover);
    color: var(--pop-text);
    font-family: inherit;
    font-size: var(--text-base);
    line-height: 1.4;
  }

  .dm-reply-input:focus {
    outline: none;
    border-color: var(--c-field-border);
    background: var(--c-field-bg);
  }

  .dm-reply-input:disabled {
    opacity: 0.6;
  }

  .dm-reply-footer {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .dm-reply-hint {
    font-size: var(--text-base);
    color: var(--pop-muted);
  }

  .dm-reply-error {
    font-size: var(--text-base);
    color: var(--red, var(--popover-danger));
    word-break: break-word;
  }

  .btn-send {
    margin-left: auto;
    background: var(--c-btn-bg);
    color: var(--c-btn-fg);
  }

  .btn-send:hover:not(:disabled) {
    filter: brightness(0.94);
  }

  .btn-send:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* ── Compact communications window ──────────────────────────────────────
   * The native Messages mini window uses one outer glass material. Ordinary
   * incoming prose stays directly on that canvas; only outbound speech gets a
   * restrained neutral surface, and shared files remain true object cards.
   * Full Messages keeps its separate override layer below unchanged.
   * ────────────────────────────────────────────────────────────────────── */

  :global(html[data-window='dm-detail']) .dm-thread {
    padding: 1rem 1.375rem 1.25rem;
    gap: 0;
  }

  :global(html[data-window='dm-detail']) .dm-msg {
    max-width: min(84%, 560px);
    margin-top: 0.25rem;
  }

  :global(html[data-window='dm-detail']) .dm-msg-group-start {
    margin-top: 0.875rem;
  }

  :global(html[data-window='dm-detail']) .date-separator + .dm-msg {
    margin-top: 0.1875rem;
  }

  :global(html[data-window='dm-detail']) .dm-msg-in .dm-bubble:not(.dm-bubble-share) {
    padding: 0.125rem 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  :global(html[data-window='dm-detail']) .dm-msg-out .dm-bubble:not(.dm-bubble-share) {
    padding: 0.5rem 0.6875rem;
    border: 1px solid color-mix(in srgb, var(--pop-text) 9%, transparent);
    border-radius: 10px 10px 3px 10px;
    background: color-mix(in srgb, var(--pop-text) 6%, transparent);
  }

  :global(html[data-window='dm-detail']) .dm-bubble.dm-bubble-share {
    padding: 0.75rem;
    border: 1px solid color-mix(in srgb, var(--pop-text) 12%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--pop-text) 5%, transparent);
  }

  :global(html[data-window='dm-detail']) .dm-bubble-thread-active {
    box-shadow: none;
  }

  :global(html[data-window='dm-detail']) .dm-action {
    border: 0;
    background: transparent;
    color: var(--pop-muted);
    transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  :global(html[data-window='dm-detail']) .dm-action:hover {
    background: transparent;
    color: var(--pop-text);
  }

  :global(html[data-window='dm-detail']) .thread-affordance {
    gap: 0.25rem;
    margin-top: 0.1875rem;
    padding: 0.1875rem 0;
    border: 0;
    border-bottom: 1px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--pop-muted);
    font-size: 0.6875rem;
    font-weight: 560;
    transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  :global(html[data-window='dm-detail']) .thread-affordance:hover {
    border-bottom-color: var(--pop-muted);
    background: transparent;
    color: var(--pop-text);
  }

  :global(html[data-window='dm-detail']) .thread-affordance-count {
    font-weight: 600;
  }

  :global(html[data-window='dm-detail']) .dm-msg-time,
  :global(html[data-window='dm-detail']) .dm-msg-pending {
    font-size: 0.65625rem;
  }

  :global(html[data-window='dm-detail']) .btn {
    transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  :global(html[data-window='dm-detail']) .btn-copy {
    padding: 0.1875rem 0;
    border: 0;
    border-bottom: 1px solid var(--pop-divider);
    border-radius: 0;
    background: transparent;
    color: var(--pop-muted);
  }

  :global(html[data-window='dm-detail']) .btn-copy:hover {
    background: transparent;
    color: var(--pop-text);
  }

  :global(html[data-window='dm-detail']) .share-card-permission {
    padding: 0;
    border: 0;
    border-radius: 0;
  }

  :global(html[data-window='dm-detail']) .new-messages-jump {
    border-color: color-mix(in srgb, var(--pop-text) 12%, transparent);
    background: color-mix(in srgb, var(--pop-bg) 88%, transparent);
    transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  :global(html[data-window='dm-detail']) .dm-action:active:not(:disabled),
  :global(html[data-window='dm-detail']) .thread-affordance:active:not(:disabled),
  :global(html[data-window='dm-detail']) .btn:active:not(:disabled) {
    transform: scale(0.97);
  }

  :global(html[data-window='dm-detail']) .dm-action:focus-visible,
  :global(html[data-window='dm-detail']) .thread-affordance:focus-visible,
  :global(html[data-window='dm-detail']) .btn:focus-visible {
    outline: 2px solid var(--pop-text);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .inline-spinner {
      animation-duration: 1.4s;
    }

    .load-retry,
    .new-messages-jump,
    .dm-action-retry,
    :global(html[data-window='dm-detail']) .dm-action,
    :global(html[data-window='dm-detail']) .thread-affordance,
    :global(html[data-window='dm-detail']) .btn {
      transition: none;
    }

    .load-retry:active:not(:disabled),
    .dm-action-retry:active:not(:disabled),
    :global(html[data-window='dm-detail']) .dm-action:active:not(:disabled),
    :global(html[data-window='dm-detail']) .thread-affordance:active:not(:disabled),
    :global(html[data-window='dm-detail']) .btn:active:not(:disabled) {
      transform: none;
    }

    .new-messages-jump:active:not(:disabled) {
      transform: translateX(-50%);
    }
  }

  /* ──────────────────────────────────────────────────────────────────────
   * Messages-window override layer (desktop "Company OS" language).
   *
   * Conversation is shared: the classic popover DmDetail window renders it as
   * the monochrome light-glass surface defined ABOVE (those rules are the
   * default and stay untouched), while the standalone Messages window adopts
   * the desktop token system. These overrides are gated under
   * `[data-window='messages']` so DmDetail's appearance is unaffected.
   *
   * Outbound vs inbound is distinguished by SURFACE LAYERING + alignment, not
   * a saturated fill: inbound left on a subtle raise surface, outbound
   * right on a restrained neutral "self/primary" tint. Tokens resolve
   * from the shared desktop alias layer (desktop-alt.css).
   * ────────────────────────────────────────────────────────────────────── */

  :global([data-window='messages']) .dm-thread {
    padding: var(--space-4) var(--space-5);
    gap: 0;
    scrollbar-color: var(--scrollbar-thumb) transparent;
  }

  :global([data-window='messages']) .dm-thread-status {
    font-size: var(--text-base);
    color: var(--muted);
  }

  :global([data-window='messages']) .dm-thread-error {
    color: var(--red);
  }

  :global([data-window='messages']) .dm-msg-author {
    display: inline-flex;
    align-items: center;
    max-width: min(32ch, 100%);
    margin: 0 0 var(--space-1);
    padding: 2px 7px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-raise);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0;
    color: var(--muted-2);
    text-overflow: ellipsis;
    text-transform: none;
    white-space: nowrap;
  }

  :global([data-window='messages']) .dm-msg {
    min-width: 0;
    max-width: min(76%, 720px);
    margin-top: var(--space-1);
  }

  :global([data-window='messages']) .dm-msg-group-start {
    margin-top: var(--space-3);
  }

  :global([data-window='messages']) .date-separator + .dm-msg {
    margin-top: var(--space-1);
  }

  :global([data-window='messages']) .dm-bubble {
    min-width: 0;
    max-width: 100%;
    padding: 2px 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  :global([data-window='messages']) .dm-msg-in .dm-bubble {
    background: transparent;
    border-radius: 0;
  }

  :global([data-window='messages']) .dm-msg-out .dm-bubble {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: 10px 10px 3px 10px;
    background: var(--surface-raise);
  }

  /* A shared file is a real actionable object, so it keeps card treatment.
     Ordinary incoming prose remains unboxed on the conversation canvas. */
  :global([data-window='messages']) .dm-bubble-share {
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface-raise);
  }

  :global([data-window='messages']) .dm-bubble-body {
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif);
    font-size: var(--text-base);
    line-height: 1.55;
    color: var(--fg);
  }

  :global([data-window='messages']) .dm-bubble-details {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.5;
    color: var(--fg-data);
    background: transparent;
    border-top-color: var(--border-strong);
    border-radius: 0;
    padding: var(--space-2) 0 0;
  }

  :global([data-window='messages']) .dm-msg-time {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    color: var(--muted-3);
    margin: var(--space-1) var(--space-1) 0;
  }

  :global([data-window='messages']) .dm-msg-pending {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted-2);
    background: transparent;
    border-radius: 0;
    padding: 0;
    margin: var(--space-1) var(--space-1) 0;
  }

  :global([data-window='messages']) .btn-copy {
    background: var(--surface-raise);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--fg);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
  }

  :global([data-window='messages']) .btn-copy:hover {
    background: var(--row-hover);
  }

  :global([data-window='messages']) .dm-action {
    background: var(--surface-panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--muted-2);
  }

  :global([data-window='messages']) .dm-action:hover {
    background: var(--row-hover);
    color: var(--fg);
  }

  :global([data-window='messages']) .dm-action-done {
    color: var(--emerald, #7ee0a8);
  }

  :global([data-window='messages']) .dm-reply,
  :global([data-window='desktop-alt']) .dm-reply {
    padding: var(--space-3) var(--space-5) var(--space-4);
    border-top: 1px solid var(--border);
    /* The window already owns the material. Keep the composer structural so
       its full-width footer cannot compound into an opaque bottom slab. */
    background: transparent;
  }

  :global([data-window='messages']) .dm-reply-input,
  :global([data-window='desktop-alt']) .dm-reply-input {
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: transparent;
    color: var(--fg);
    font-family: var(--font-sans);
    font-size: var(--text-base);
    line-height: 1.45;
  }

  :global([data-window='messages']) .dm-reply-input:focus,
  :global([data-window='desktop-alt']) .dm-reply-input:focus {
    border-color: var(--accent);
    outline: 1px solid var(--accent);
    outline-offset: -1px;
    background: transparent;
  }

  :global([data-window='messages']) .dm-reply-hint {
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
  }

  :global([data-window='messages']) .dm-reply-error {
    font-size: var(--text-sm);
    color: var(--red);
  }

  :global([data-window='messages']) .btn-send {
    background: var(--accent);
    color: var(--accent-fg);
    border-radius: var(--radius-sm);
    font-family: var(--font-sans);
    font-weight: 600;
  }

  :global([data-window='messages']) .btn-send:hover:not(:disabled) {
    background: var(--accent);
    filter: brightness(0.94);
  }

  /* ── Shared message timeline ────────────────────────────────────────────
   * Messages read as authored rows, not opposing chat bubbles. Direction is
   * explicit in the author label (the signed-in sender is "You"), which keeps
   * DMs, group DMs, channels, threads, and the compact window consistent.
   * Only real objects such as shared files retain card treatment.
   */
  .dm-msg,
  :global([data-window='messages']) .dm-msg,
  :global(html[data-window='dm-detail']) .dm-msg {
    display: grid;
    grid-template-columns: 28px minmax(0, 720px);
    align-self: stretch;
    align-items: start;
    gap: 0.625rem;
    width: 100%;
    max-width: none;
    margin-top: 0.1875rem;
  }

  .dm-msg-group-start,
  :global([data-window='messages']) .dm-msg-group-start,
  :global(html[data-window='dm-detail']) .dm-msg-group-start {
    margin-top: 0.875rem;
  }

  .date-separator + .dm-msg,
  :global([data-window='messages']) .date-separator + .dm-msg,
  :global(html[data-window='dm-detail']) .date-separator + .dm-msg {
    margin-top: 0.25rem;
  }

  .dm-msg-in,
  .dm-msg-out {
    align-self: stretch;
    align-items: start;
  }

  .dm-msg-avatar,
  .dm-msg-avatar-spacer {
    display: block;
    width: 28px;
    min-height: 1px;
  }

  .dm-msg-column {
    min-width: 0;
    max-width: 720px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }

  .dm-msg-meta {
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 0.4375rem;
    margin: 0 0 0.125rem;
  }

  .dm-msg-author,
  :global([data-window='messages']) .dm-msg-author {
    display: block;
    min-width: 0;
    max-width: 42ch;
    margin: 0;
    padding: 0;
    overflow: hidden;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--fg, var(--pop-text));
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif);
    font-size: var(--text-base);
    font-weight: 650;
    line-height: 1.3;
    letter-spacing: 0;
    text-overflow: ellipsis;
    text-transform: none;
    white-space: nowrap;
  }

  .dm-msg-header-time {
    flex: 0 0 auto;
    color: var(--muted-3, var(--pop-muted));
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif);
    font-size: var(--text-xs, 0.75rem);
    font-weight: 450;
    line-height: 1.3;
  }

  .dm-bubble,
  .dm-msg-in .dm-bubble,
  .dm-msg-out .dm-bubble,
  :global([data-window='messages']) .dm-bubble,
  :global([data-window='messages']) .dm-msg-in .dm-bubble,
  :global([data-window='messages']) .dm-msg-out .dm-bubble,
  :global(html[data-window='dm-detail']) .dm-msg-in .dm-bubble:not(.dm-bubble-share),
  :global(html[data-window='dm-detail']) .dm-msg-out .dm-bubble:not(.dm-bubble-share) {
    width: 100%;
    max-width: 100%;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  .dm-bubble-share,
  :global([data-window='messages']) .dm-bubble-share,
  :global(html[data-window='dm-detail']) .dm-bubble.dm-bubble-share {
    width: min(100%, 560px);
    padding: 0.75rem;
    border: 1px solid var(--border, var(--pop-border));
    border-radius: 10px;
    background: var(--surface-raise, color-mix(in srgb, var(--pop-text) 5%, transparent));
  }

  .dm-msg-time,
  :global([data-window='messages']) .dm-msg-time,
  :global(html[data-window='dm-detail']) .dm-msg-time {
    margin: 0.1875rem 0 0;
    font-size: var(--text-micro, 0.65625rem);
  }

  .date-separator {
    margin-left: 38px;
  }
</style>
