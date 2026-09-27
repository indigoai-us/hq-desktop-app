<script lang="ts">
  /**
   * Thread panel: wraps DmThreadPane with audience-based filtering (US-006).
   * When the bot toggle is off, agent-audience messages are hidden and a quiet
   * "{n} bot messages hidden" line appears at the bottom of the thread.
   * Clicking that line turns the toggle on.
   */
  import DmThreadPane from '../DmThreadPane.svelte';
  import type { DmEvent } from '../DmThreadPane.svelte';
  import {
    countHiddenByAudience,
  } from '../../lib/botMessageFilter';

  interface Props {
    event: DmEvent;
    showBotMessages?: boolean;
    onrequestshowbotmessages?: () => void;
  }

  let { event, showBotMessages = false, onrequestshowbotmessages }: Props = $props();

  // Compute hidden count from the raw messages array. DmThreadPane exposes its
  // filtered messages via the messages prop; we need the unfiltered list to
  // count what's hidden. For now we compute this from the event's audience only
  // (single-event surface). A full thread count is handled inside DmThreadPane
  // via the hiddenCount export below.
  const singleHidden = $derived(
    showBotMessages ? 0 : countHiddenByAudience([event], false),
  );
</script>

<div class="thread-panel" data-testid="thread-panel" data-show-bot={showBotMessages}>
  <DmThreadPane {event} {showBotMessages} />

  {#if !showBotMessages && singleHidden > 0}
    <div class="hidden-notice" data-testid="hidden-bot-messages-notice">
      <button
        type="button"
        class="hidden-notice-btn"
        onclick={() => onrequestshowbotmessages?.()}
        data-testid="show-hidden-bot-messages"
      >
        {singleHidden} bot {singleHidden === 1 ? 'message' : 'messages'} hidden
      </button>
    </div>
  {/if}
</div>

<style>
  .thread-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .hidden-notice {
    flex-shrink: 0;
    display: flex;
    justify-content: center;
    padding: 4px 8px;
  }

  .hidden-notice-btn {
    padding: 2px 8px;
    border: 0;
    border-radius: 4px;
    font: inherit;
    font-size: 11px;
    color: var(--v4-text-2, #9ca3af);
    background: transparent;
    cursor: pointer;
  }

  .hidden-notice-btn:hover {
    color: var(--v4-text-1, #ededed);
    background: var(--c-hover, rgb(128 128 128 / 12%));
    text-decoration: underline;
  }
</style>
