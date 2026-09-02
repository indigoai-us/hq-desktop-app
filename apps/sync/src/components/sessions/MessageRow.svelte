<script lang="ts">
  // Session transcript message row. Presentation-pure — props in, callbacks
  // out. Covers: grouped continuation (collapsed header, hover timestamp in
  // the gutter), attachment chips, the streaming caret, the deleted
  // tombstone, and the agent provenance line ("added by Corey Epstein ·
  // Indigo").
  //
  // Lifted from the parked workspace row with every messaging-social
  // affordance removed: no edit/delete (and so no permission mirror), no
  // reaction pills, no thread teaser. A session transcript row is a record of
  // what happened, not a chat message you can act on.
  import AgentBadge from './AgentBadge.svelte';
  import Avatar from './Avatar.svelte';
  import { formatFileSize, formatTime } from './session-types';
  import type { WsMember, WsMessage } from './session-types';

  interface Props {
    message: WsMessage;
    author?: WsMember;
    grouped?: boolean;
    /**
     * Pre-rendered, already-sanitized HTML for this message's body.
     *
     * The row stays presentation-pure and markdown-agnostic: it never imports
     * a renderer and never sanitizes. A host that wants rich bodies renders
     * them with its own CSP-safe renderer and passes the result down; with the
     * prop omitted the row renders plain text exactly as before.
     */
    bodyHtml?: string;
  }

  let { message, author, grouped = false, bodyHtml }: Props = $props();

  const name = $derived(author?.displayName ?? 'Unknown');
  const isAgent = $derived(author?.kind === 'agent');
  const time = $derived(formatTime(message.createdAt));
  const provenance = $derived(
    isAgent && author?.addedBy ? `added by ${author.addedBy} · ${author.company ?? ''}` : null,
  );
</script>

<div
  class="ws-message-row"
  class:grouped
  class:tombstone={message.tombstone}
  class:streaming={message.streaming}
  data-testid="ws-message-row"
  data-message-id={message.id}
>
  <div class="gutter">
    {#if !grouped}
      <Avatar {name} kind={author?.kind ?? 'human'} size={28} />
    {:else}
      <span class="gutter-time">{time}</span>
    {/if}
  </div>

  <div class="main">
    {#if !grouped}
      <div class="head">
        <span class="name">{name}</span>
        {#if isAgent}
          <AgentBadge />
        {/if}
        {#if provenance}
          <span class="provenance" data-testid="ws-agent-provenance">{provenance}</span>
        {/if}
        <span class="time">{time}</span>
      </div>
    {/if}

    {#if message.tombstone}
      <div class="tombstone-body" data-testid="ws-tombstone">This message was deleted.</div>
    {:else}
      <div class="body" aria-busy={message.streaming ? 'true' : undefined}>
        {#if bodyHtml}
          <!-- eslint-disable-next-line svelte/no-at-html-tags -- pre-sanitized
               by the host's CSP-safe markdown renderer; see `bodyHtml` above. -->
          <span class="body-html">{@html bodyHtml}</span>
        {:else}
          {message.body}
        {/if}
        {#if message.streaming}
          <span class="stream-caret" data-testid="ws-stream-caret" aria-hidden="true"></span>
        {/if}
        {#if message.editedAt}
          <span class="edited" title={`Edited ${formatTime(message.editedAt)}`}>(edited)</span>
        {/if}
      </div>

      {#if message.attachments?.length}
        <div class="attachments">
          {#each message.attachments as attachment (attachment.attachmentId)}
            <button type="button" class="attachment" data-testid="ws-attachment-chip">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                <path
                  d="M7.5 1.5h-4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V4.5l-2-3Z"
                  stroke="currentColor"
                  stroke-width="1.1"
                  stroke-linejoin="round"
                />
                <path d="M7.5 1.5v3h2" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" />
              </svg>
              <span class="file-name">{attachment.fileName}</span>
              <span class="file-size">{formatFileSize(attachment.sizeBytes)}</span>
            </button>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .ws-message-row {
    position: relative;
    display: flex;
    gap: var(--v4-space-3);
    padding: 3px var(--v4-space-4);
    border-radius: var(--v4-radius-card);
  }

  .ws-message-row:not(.grouped) {
    margin-top: var(--v4-space-2);
  }

  .ws-message-row:hover,
  .ws-message-row:focus-within {
    background: var(--v4-control-faint);
  }

  .gutter {
    flex: none;
    width: 28px;
    display: flex;
    justify-content: center;
  }

  .gutter-time {
    align-self: flex-start;
    padding-top: 3px;
    font-size: 10px;
    color: var(--v4-idle);
    opacity: 0;
    white-space: nowrap;
  }

  .ws-message-row:hover .gutter-time,
  .ws-message-row:focus-within .gutter-time {
    opacity: 1;
  }

  .main {
    flex: 1;
    min-width: 0;
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: var(--v4-space-2);
    line-height: 1.3;
  }

  .name {
    font-size: var(--type-body);
    font-weight: 500;
    color: var(--v4-text-1);
  }

  .provenance {
    font-size: 11px;
    color: var(--v4-text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .time {
    font-size: 11px;
    color: var(--v4-idle);
  }

  /* Rendered markdown keeps the row's own rhythm: block children collapse
     their outer margins so a one-paragraph body is visually identical to the
     plain-text path. */
  .body :global(p) {
    margin: 0 0 var(--v4-space-2);
  }

  .body :global(p:last-child) {
    margin-bottom: 0;
  }

  .body :global(pre) {
    margin: var(--v4-space-2) 0;
    padding: var(--v4-space-2);
    overflow-x: auto;
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--type-metadata);
  }

  .body :global(code) {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.95em;
  }

  .body :global(ul),
  .body :global(ol) {
    margin: var(--v4-space-2) 0;
    padding-left: 1.4em;
  }

  .body :global(a) {
    color: var(--v4-link, var(--v4-text-1));
  }

  .body {
    margin-top: 1px;
    font-size: var(--type-body);
    line-height: 1.45;
    color: var(--v4-text-1);
    overflow-wrap: break-word;
  }

  .edited {
    margin-left: 4px;
    font-size: 11px;
    color: var(--v4-idle);
  }

  .tombstone .gutter :global(.ws-avatar),
  .tombstone-body {
    opacity: 0.75;
  }

  .tombstone-body {
    margin-top: 1px;
    font-size: var(--type-body);
    font-style: italic;
    color: var(--v4-text-3);
  }

  .attachments {
    display: flex;
    flex-wrap: wrap;
    gap: var(--v4-space-2);
    margin-top: var(--v4-space-2);
  }

  .attachment {
    display: inline-flex;
    align-items: center;
    gap: var(--v4-space-2);
    height: var(--v4-row-h);
    padding: 0 var(--v4-space-3);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-raised);
    color: var(--v4-text-2);
    font-size: var(--type-metadata);
    font-family: inherit;
    cursor: pointer;
  }

  .attachment:hover {
    background: var(--v4-active-row);
  }

  .file-name {
    color: var(--v4-text-1);
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-size {
    font-size: 11px;
    color: var(--v4-text-3);
  }

  .stream-caret {
    display: inline-block;
    width: 2px;
    height: 1em;
    margin-left: 2px;
    vertical-align: text-bottom;
    background: var(--v4-text-2);
    animation: ws-stream-blink 1s steps(2, start) infinite;
  }

  @keyframes ws-stream-blink {
    50% {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .stream-caret {
      animation: none;
      opacity: 0.6;
    }
  }
</style>
