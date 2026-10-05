<script lang="ts">
  /**
   * Messages surface header: segment tabs (All / People / Requests).
   */
  import type { Snippet } from 'svelte';
  import type { DmEvent } from '../DmThreadPane.svelte';

  // Re-export so callers can import the type alongside the shell.
  export type { DmEvent };

  export type MessagesSegment = 'all' | 'people' | 'requests';

  interface Props {
    segment?: MessagesSegment;
    onsegmentchange?: (segment: MessagesSegment) => void;
    children?: Snippet;
  }

  let {
    segment = $bindable<MessagesSegment>('all'),
    onsegmentchange,
    children,
  }: Props = $props();

  function setSegment(next: MessagesSegment) {
    segment = next;
    onsegmentchange?.(next);
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

  .messages-shell-content {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
</style>
