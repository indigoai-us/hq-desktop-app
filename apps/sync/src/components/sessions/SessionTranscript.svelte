<script lang="ts">
  /**
   * The conversation itself.
   *
   * The shape is a CHAT, not an event log, and every decision here follows from
   * that: what you said is a bubble on the right; what the agent said is plain
   * prose on the left with no avatar, no name header and no timestamp gutter;
   * what the agent DID collapses into one quiet expandable row; what it needs
   * from you appears as a card exactly where it happened, and collapses to a
   * line once answered.
   *
   * Assistant prose goes through the app's CSP-safe `renderMessageBodyMarkdown`
   * (no new dependency, no raw source HTML). Operator bubbles use the same
   * renderer so pasted Markdown links remain readable and clickable.
   *
   * Scrolling: the transcript pins itself to the bottom while output streams,
   * UNLESS you have scrolled up to read something — then it holds still and
   * offers a "Jump to latest" chip. An agent that yanks the viewport out from
   * under a reader is the single loudest way a chat surface can misbehave.
   *
   * Presentation-pure: blocks in, decisions out as callbacks. Nothing invokes.
   */
  import { tick } from 'svelte';
  import { readQuestionReplies } from './question-replies';
  import PermissionCard from './PermissionCard.svelte';
  import QuestionCard from './QuestionCard.svelte';
  import ToolGroupRow from './ToolGroupRow.svelte';
  import type { ArtifactActions } from './session-artifacts';
  import type { ChatBlock } from './transcript-adapter';
  import { attachmentLabel } from './context-attachments';
  import { renderMessageBodyMarkdown } from '../../lib/messageMarkdown';
  import './sessions-tokens.css';

  interface Props {
    blocks: ChatBlock[];
    /** True before the first replay lands — draws a quiet placeholder. */
    loading?: boolean;
    /** The centred hint shown when there is nothing to read yet. */
    emptyHint?: string;
    /** Set while a decision is in flight so a card cannot double-fire. */
    busyRequestId?: string | null;
    /**
     * What the agent is doing while nothing new is on screen yet. Rendered as
     * a shimmering tail line so a 10-second hook run or a long tool call never
     * reads as a dead chat. Empty when text is streaming or a card is waiting.
     */
    status?: '' | 'starting' | 'thinking' | 'tools';
    /** Open / Share / Deploy on files a turn produced; absent → listed only. */
    artifactActions?: ArtifactActions | null;
    hasEarlier?: boolean;
    loadingEarlier?: boolean;
    onloadearlier?: () => Promise<void> | void;
    onallowonce?: (requestId: string) => void;
    onallowsession?: (requestId: string) => void;
    ondenypermission?: (requestId: string, message: string) => void;
    onanswerquestion?: (
      requestId: string,
      answers: { questionId: string; values: string[] }[],
    ) => void;
    /**
     * The `model_not_found` line's one-click recovery: open the composer's
     * model menu. Absent, the line still says what went wrong; it just cannot
     * offer the fix.
     */
    onchoosemodel?: () => void;
  }

  let {
    blocks,
    loading = false,
    emptyHint = '',
    busyRequestId = null,
    status = '',
    artifactActions = null,
    hasEarlier = false,
    loadingEarlier = false,
    onloadearlier,
    onallowonce,
    onallowsession,
    ondenypermission,
    onanswerquestion,
    onchoosemodel,
  }: Props = $props();

  let scroller = $state<HTMLDivElement | null>(null);

  const STATUS_LABEL: Record<Exclude<Props['status'], undefined | ''>, string> = {
    starting: 'Starting session…',
    thinking: 'Thinking…',
    tools: 'Working…',
  };

  /**
   * Seconds since the current status began, shown after a short grace period
   * so a quick turn stays quiet while a long one stays honest ("Thinking… 24s").
   */
  let statusSince = $state(0);
  let statusElapsed = $state(0);
  $effect(() => {
    if (!status) {
      statusElapsed = 0;
      return;
    }
    statusSince = Date.now();
    statusElapsed = 0;
    const timer = setInterval(() => {
      statusElapsed = Math.floor((Date.now() - statusSince) / 1000);
    }, 1000);
    return () => clearInterval(timer);
  });
  const statusLabel = $derived(status ? STATUS_LABEL[status] : '');
  const statusTail = $derived(statusElapsed >= 4 ? `${statusElapsed}s` : '');
  /** The adapter's own thinking tail already shimmers — never stack two. */
  const showStatus = $derived(
    Boolean(status) && blocks[blocks.length - 1]?.type !== 'thinking',
  );
  /** The reader has scrolled up: stop following the stream until they return. */
  let pinned = $state(true);

  /**
   * Rendered bodies, keyed by the text itself. A streaming turn re-renders on
   * every delta — without this, one long answer would re-parse the whole
   * transcript's markdown per keystroke of output. Keying on the text (not the
   * block id) means a growing row simply misses until it settles.
   */
  const BODY_CACHE_LIMIT = 200;
  const bodyCache = new Map<string, string>();

  function renderProse(text: string): string {
    const cached = bodyCache.get(text);
    if (cached !== undefined) return cached;
    const html = renderMessageBodyMarkdown(text);
    if (bodyCache.size >= BODY_CACHE_LIMIT) bodyCache.clear();
    bodyCache.set(text, html);
    return html;
  }

  /** Within this many pixels of the bottom still counts as "following". */
  const PIN_SLACK_PX = 48;

  function onScroll() {
    const el = scroller;
    if (!el) return;
    pinned = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLACK_PX;
  }

  function jumpToLatest() {
    pinned = true;
    scrollToBottom();
  }

  function scrollToBottom() {
    const el = scroller;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  async function loadEarlier() {
    const el = scroller;
    if (!el || loadingEarlier || !onloadearlier) return;
    const oldHeight = el.scrollHeight;
    const oldTop = el.scrollTop;
    pinned = false;
    await onloadearlier();
    await tick();
    // Keep the same message under the reader's eye as older blocks prepend.
    el.scrollTop = oldTop + (el.scrollHeight - oldHeight);
  }

  // Follow the stream while the reader is at the bottom. Reading `blocks`
  // (and the tail block's text) is what re-runs this on every delta.
  $effect(() => {
    const tail = blocks[blocks.length - 1];
    void blocks.length;
    void (tail && 'text' in tail ? tail.text : '');
    if (!pinned) return;
    scrollToBottom();
  });

  const isEmpty = $derived(blocks.length === 0);
</script>

<div class="transcript-wrap">
<div
  class="transcript"
  data-testid="session-transcript"
  bind:this={scroller}
  onscroll={onScroll}
>
  {#if loading && isEmpty}
    <p class="quiet-note" data-testid="session-transcript-loading">Loading the conversation…</p>
  {:else if isEmpty}
    <div class="empty" data-testid="session-transcript-empty">
      {#if emptyHint}<p class="empty-hint">{emptyHint}</p>{/if}
    </div>
  {:else}
    <div class="stream">
      {#if hasEarlier}
        <button
          type="button"
          class="load-earlier"
          data-testid="session-load-earlier"
          disabled={loadingEarlier}
          onclick={() => void loadEarlier()}
        >
          {loadingEarlier ? 'Loading earlier messages…' : 'Load earlier messages'}
        </button>
      {/if}
      {#each blocks as block (block.id)}
        {#if block.type === 'userBubble'}
          {@const replies = readQuestionReplies(block.text)}
          <div class="user-row">
            <div class="user-column">
              <div class="user-bubble prose" data-testid="session-user-bubble">
                {#if replies}
                  <div class="question-replies" data-testid="session-question-replies">
                    {#each replies as reply}
                      <section class="question-reply" aria-label="Answered question">
                        <div class="reply-label">Question</div>
                        <div class="reply-question">{@html renderMessageBodyMarkdown(reply.question)}</div>
                        <div class="reply-label">Your answer</div>
                        <div class="reply-answer">{@html renderMessageBodyMarkdown(reply.answer)}</div>
                      </section>
                    {/each}
                  </div>
                {:else}
                  {@html renderMessageBodyMarkdown(block.text)}
                {/if}
              </div>
              {#if block.attachments.length > 0}
                <!-- The context block itself never renders; only what rode along. -->
                <div class="user-attachments" data-testid="session-user-attachments">
                  {#each block.attachments as attachment (attachment.path)}
                    <span
                      class="user-attachment"
                      data-testid="session-user-attachment"
                      data-kind={attachment.kind}
                      title={attachment.path}
                    >
                      Attached: {attachmentLabel(attachment)}
                    </span>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {:else if block.type === 'assistantProse'}
          <div
            class="prose"
            class:streaming={block.streaming}
            data-testid="session-assistant-prose"
            aria-busy={block.streaming ? 'true' : undefined}
          >
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html renderProse(block.text)}
          </div>
        {:else if block.type === 'thinking'}
          <p class="thinking" data-testid="session-thinking" title={block.text}>Thinking…</p>
        {:else if block.type === 'toolGroup'}
          <ToolGroupRow
            summary={block.summary}
            calls={block.calls}
            running={block.running}
            artifacts={block.artifacts}
            {artifactActions}
          />
        {:else if block.type === 'permissionCard'}
          <PermissionCard
            requestId={block.requestId}
            toolName={block.toolName}
            input={block.input}
            suggestions={block.suggestions}
            resolution={block.resolution}
            busy={busyRequestId === block.requestId}
            {onallowonce}
            {onallowsession}
            ondeny={ondenypermission}
          />
        {:else if block.type === 'questionCard'}
          <QuestionCard
            requestId={block.requestId}
            questions={block.questions}
            resolution={block.resolution}
            busy={busyRequestId === block.requestId}
            onsubmit={onanswerquestion}
          />
        {:else if block.type === 'error'}
          <p
            class="inline-error"
            class:warn={block.tone === 'warn'}
            role={block.tone === 'error' ? 'alert' : undefined}
            data-testid="session-inline-error"
            data-code={block.code}
          >
            {block.text}
            {#if block.action === 'chooseModel' && onchoosemodel}
              <button
                type="button"
                class="inline-fix"
                data-testid="session-choose-model"
                onclick={(event) => {
                  // The composer closes its menus on any window click; this
                  // click is asking it to OPEN one.
                  event.stopPropagation();
                  onchoosemodel?.();
                }}
              >
                Choose a model
              </button>
            {/if}
          </p>
        {:else}
          <div class="divider" data-testid="session-divider">
            <span>{block.label}</span>
          </div>
        {/if}
      {/each}
      {#if showStatus}
        <p
          class="thinking working"
          data-testid="session-working"
          data-status={status}
          role="status"
          aria-live="polite"
        >
          {statusLabel}{#if statusTail}<span class="elapsed">{statusTail}</span>{/if}
        </p>
      {/if}
    </div>
  {/if}
</div>

{#if !pinned && !isEmpty}
  <button
    type="button"
    class="jump"
    data-testid="session-jump-to-latest"
    onclick={jumpToLatest}
  >
    ↓ Jump to latest
  </button>
{/if}
</div>

<style>
  .transcript-wrap {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .transcript {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    scrollbar-gutter: stable both-edges;
    padding: var(--v4-space-4) 0 var(--v4-space-3);
    font-family: var(--font-sans);
  }

  /* 760 of readable column plus the composer dock's own 16px gutter, so the
     prose edge lands exactly on the composer bar's edge below it. */
  .stream {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-3);
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    max-width: calc(var(--session-column-width, 760px) + 2 * var(--session-gutter, 16px));
    margin: 0 auto;
    padding: 0 var(--session-gutter, 16px);
  }

  .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: var(--v4-space-4);
  }

  .empty-hint {
    margin: 0;
    max-width: 420px;
    text-align: center;
    font-size: var(--type-secondary);
    line-height: 1.5;
    color: var(--v4-text-3);
  }

  .quiet-note {
    margin: 0;
    padding: var(--v4-space-4);
    text-align: center;
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }

  .load-earlier {
    align-self: center;
    border: 0;
    padding: 4px 8px;
    background: transparent;
    color: var(--v4-text-3);
    font: inherit;
    font-size: var(--type-metadata);
    cursor: pointer;
  }

  .load-earlier:hover:not(:disabled) {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  .load-earlier:disabled {
    cursor: default;
    opacity: 0.7;
  }

  /* --- the operator ---------------------------------------------------- */

  .user-row {
    display: flex;
    min-width: 0;
    justify-content: flex-end;
  }

  .question-replies { display: grid; gap: 20px; }
  .question-reply { min-width: 0; }
  .question-reply + .question-reply { border-top: 1px solid var(--v4-border); padding-top: 16px; }
  .reply-label { font-size: 12px; font-weight: 600; color: var(--v4-text-3); margin-bottom: 6px; }
  .reply-question { color: var(--v4-text-2); margin-bottom: 16px; }
  .reply-answer { color: var(--v4-text-1); }

  .user-column {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    min-width: 0;
    max-width: 85%;
  }

  .user-attachments {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 4px;
  }

  .user-attachment {
    padding: 1px 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    color: var(--v4-text-3);
    font-size: 11px;
    line-height: 1.5;
    white-space: nowrap;
  }

  .user-bubble {
    box-sizing: border-box;
    max-width: 100%;
    padding: 8px 12px;
    border-radius: 14px;
    background: var(--v4-control-faint, var(--v4-raised));
    color: var(--v4-text-1);
    font-size: var(--type-body);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  /* --- the agent ------------------------------------------------------- */

  .prose {
    min-width: 0;
    max-width: 100%;
    font-size: var(--type-body);
    line-height: 1.62;
    color: var(--v4-text-1);
    overflow-wrap: anywhere;
  }

  .prose :global(p) {
    margin: 0 0 0.7em;
  }

  .prose :global(p:last-child) {
    margin-bottom: 0;
  }

  .prose :global(pre) {
    box-sizing: border-box;
    max-width: 100%;
    margin: 0.7em 0;
    padding: var(--v4-space-2);
    overflow-x: auto;
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--type-metadata);
  }

  .prose :global(pre code) {
    white-space: pre;
    overflow-wrap: normal;
  }

  .prose :global(a) {
    overflow-wrap: anywhere;
  }

  .prose :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
  }

  @container (max-width: 520px) {
    .user-column { max-width: 95%; }
  }

  .prose :global(code) {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.92em;
  }

  .prose :global(ul),
  .prose :global(ol) {
    margin: 0 0 0.7em;
    padding-left: 1.3em;
  }

  .prose.streaming::after {
    content: '';
    display: inline-block;
    width: 2px;
    height: 1em;
    margin-left: 2px;
    vertical-align: text-bottom;
    background: var(--v4-text-2);
    animation: caret-blink 1s steps(2, start) infinite;
  }

  @keyframes caret-blink {
    to {
      visibility: hidden;
    }
  }

  .thinking {
    margin: 0;
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
    background: linear-gradient(
      90deg,
      var(--v4-text-3) 0%,
      var(--v4-text-1) 50%,
      var(--v4-text-3) 100%
    );
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: think-shimmer 1.8s linear infinite;
  }

  .working .elapsed {
    margin-left: var(--v4-space-2);
    font-family: var(--font-mono);
    font-size: 0.8em;
    opacity: 0.7;
  }

  @keyframes think-shimmer {
    to {
      background-position: -200% 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .thinking {
      animation: none;
      -webkit-text-fill-color: var(--v4-text-3);
    }
    .prose.streaming::after {
      animation: none;
    }
  }

  /* --- notices --------------------------------------------------------- */

  .inline-error {
    margin: 0;
    padding: 6px 10px;
    border-radius: var(--v4-radius-button);
    background: color-mix(in srgb, var(--v4-error, currentColor) 10%, transparent);
    color: var(--v4-error, var(--v4-text-1));
    font-size: var(--type-metadata);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .inline-error.warn {
    background: color-mix(in srgb, var(--v4-warn, currentColor) 10%, transparent);
    color: var(--v4-warn, var(--v4-text-2));
  }

  /* The recovery sits on the same line as the sentence it fixes. */
  .inline-fix {
    margin-left: var(--v4-space-2);
    height: 20px;
    padding: 0 8px;
    border: 1px solid currentColor;
    border-radius: var(--v4-radius-pill, 999px);
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: 11px;
    line-height: 18px;
    vertical-align: middle;
    cursor: pointer;
  }

  .inline-fix:hover {
    background: color-mix(in srgb, currentColor 12%, transparent);
  }

  .divider {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }

  .divider::before,
  .divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--v4-hairline);
  }

  /* --- follow-the-stream escape hatch ---------------------------------- */

  .jump {
    position: absolute;
    left: 50%;
    bottom: 12px;
    transform: translateX(-50%);
    z-index: 4;
    height: 26px;
    padding: 0 12px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: var(--v4-popover, var(--v4-raised));
    color: var(--v4-text-2);
    font-family: inherit;
    font-size: var(--type-metadata);
    box-shadow: var(--v4-shadow-popover, none);
    cursor: pointer;
  }

  .jump:hover {
    color: var(--v4-text-1);
  }
</style>
