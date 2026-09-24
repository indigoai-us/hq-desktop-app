<script lang="ts">
  /**
   * Messages surface header: segment tabs (All / People / Requests) plus the
   * bot-message toggle (US-006). The toggle is a separate icon button to the
   * right of the segment rail; it stores its state per machine in localStorage.
   */
  import type { Snippet } from 'svelte';
  import {
    SHOW_BOT_MESSAGES_KEY,
    readShowBotMessages,
    writeShowBotMessages,
  } from '../../lib/botMessageFilter';
  import type { DmEvent } from '../DmThreadPane.svelte';

  // Re-export so callers can import the type alongside the shell.
  export type { DmEvent };

  export type MessagesSegment = 'all' | 'people' | 'requests';

  interface Props {
    segment?: MessagesSegment;
    onsegmentchange?: (segment: MessagesSegment) => void;
    showBotMessages?: boolean;
    onshowbotmessageschange?: (value: boolean) => void;
    children?: Snippet;
  }

  let {
    segment = $bindable<MessagesSegment>('all'),
    onsegmentchange,
    showBotMessages = $bindable(readShowBotMessages()),
    onshowbotmessageschange,
    children,
  }: Props = $props();

  function setSegment(next: MessagesSegment) {
    segment = next;
    onsegmentchange?.(next);
  }

  function toggleBotMessages() {
    const next = !showBotMessages;
    showBotMessages = next;
    writeShowBotMessages(next);
    onshowbotmessageschange?.(next);
  }
</script>

<div class="messages-shell-header" data-testid="messages-shell-header">
  <!-- Segment rail: All / People / Requests -->
  <nav class="messages-segments" aria-label="Message filters" data-testid="messages-segments">
    <button
      type="button"
      class="segment-btn"
      class:active={segment === 'all'}
      aria-pressed={segment === 'all'}
      onclick={() => setSegment('all')}
      data-testid="segment-all"
    >All</button>
    <button
      type="button"
      class="segment-btn"
      class:active={segment === 'people'}
      aria-pressed={segment === 'people'}
      onclick={() => setSegment('people')}
      data-testid="segment-people"
    >People</button>
    <button
      type="button"
      class="segment-btn"
      class:active={segment === 'requests'}
      aria-pressed={segment === 'requests'}
      onclick={() => setSegment('requests')}
      data-testid="segment-requests"
    >Requests</button>
  </nav>

  <!-- Bot-message toggle: separate control, icon button -->
  <button
    type="button"
    class="bot-toggle"
    class:active={showBotMessages}
    aria-label={showBotMessages ? 'Hide bot messages' : 'Show bot messages'}
    aria-pressed={showBotMessages}
    title={showBotMessages ? 'Hide bot messages' : 'Show bot messages'}
    onclick={toggleBotMessages}
    data-testid="bot-toggle"
    data-storage-key={SHOW_BOT_MESSAGES_KEY}
  >
    <!-- Bot icon: minimal robot face glyph -->
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2" y="4" width="10" height="7" rx="2" stroke="currentColor" stroke-width="1.25" fill="none"/>
      <rect x="4.5" y="6.5" width="1.5" height="1.5" rx="0.5" fill="currentColor"/>
      <rect x="8" y="6.5" width="1.5" height="1.5" rx="0.5" fill="currentColor"/>
      <line x1="7" y1="1" x2="7" y2="4" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      <circle cx="7" cy="1" r="0.75" fill="currentColor"/>
      <line x1="4.5" y1="9.5" x2="9.5" y2="9.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
    </svg>
  </button>
</div>

<!-- Content slot -->
<div class="messages-shell-content" data-testid="messages-shell-content">
  {@render children?.()}
</div>

<style>
  .messages-shell-header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    flex-shrink: 0;
  }

  .messages-segments {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: 1;
  }

  .segment-btn {
    padding: 3px 8px;
    border: 0;
    border-radius: 5px;
    font: inherit;
    font-size: 12px;
    line-height: 1.4;
    color: var(--v4-text-2, #9ca3af);
    background: transparent;
    cursor: pointer;
    white-space: nowrap;
  }

  .segment-btn:hover {
    background: var(--c-hover, rgb(128 128 128 / 12%));
    color: var(--v4-text-1, #ededed);
  }

  .segment-btn.active {
    background: var(--c-hover, rgb(128 128 128 / 15%));
    color: var(--v4-text-1, #ededed);
    font-weight: 500;
  }

  .bot-toggle {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    color: var(--v4-text-2, #9ca3af);
    background: transparent;
    cursor: pointer;
    transition: color 120ms, background 120ms;
  }

  .bot-toggle:hover {
    background: var(--c-hover, rgb(128 128 128 / 12%));
    color: var(--v4-text-1, #ededed);
  }

  .bot-toggle.active {
    color: var(--v4-text-1, #ededed);
    background: var(--c-hover, rgb(128 128 128 / 18%));
  }

  .bot-toggle:focus-visible {
    outline: 2px solid var(--v4-text-1, #ededed);
    outline-offset: 2px;
  }

  .messages-shell-content {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
</style>
