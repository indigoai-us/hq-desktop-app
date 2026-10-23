<script lang="ts">
  /**
   * Shared empty / "No data" surface. Used when a pane has nothing real to
   * show — never a fixture stand-in.
   */
  import RailIcon from "./button/RailIcon.svelte";
  import RailButton from "./button/RailButton.svelte";
  import type { RailIconName } from "./button/rail-icons.js";

  interface Props {
    title?: string;
    copy?: string;
    testid?: string;
    /** A symbol in a disc above the title, as iOS's empty states lead with. */
    icon?: RailIconName;
    /** Offers Try again (for a pane that is empty because a load failed). */
    onretry?: () => void;
    retryLabel?: string;
  }

  let {
    title = "No data",
    copy = "Nothing to show yet.",
    testid = "empty-state",
    icon,
    onretry,
    retryLabel = "Try again",
  }: Props = $props();
</script>

<div class="empty-state chat-shell" data-testid={testid} role="status">
  {#if icon}
    <span class="empty-state-disc" aria-hidden="true"><RailIcon name={icon} size={16} /></span>
  {/if}
  <p class="empty-state-title">{title}</p>
  {#if copy}
    <p class="empty-state-copy">{copy}</p>
  {/if}
  {#if onretry}
    <span class="empty-state-retry">
      <RailButton icon="refresh" data-testid={`${testid}-retry`} onclick={() => onretry?.()}>{retryLabel}</RailButton>
    </span>
  {/if}
</div>

<style>
  .empty-state {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.375rem;
    padding: 1.5rem 1.25rem;
    min-width: 0;
    min-height: 0;
    text-align: center;
  }

  /* iOS's shared empty state: a symbol disc, a readable measure, and Try
     again when the emptiness is a failure rather than a fact. */
  .empty-state-disc {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    margin-bottom: 4px;
    border-radius: 50%;
    background: var(--btn-bg, var(--v4-control-faint));
    color: var(--t3, var(--v4-text-3));
  }

  .empty-state-title,
  .empty-state-copy {
    max-width: 36ch;
  }

  .empty-state-retry {
    display: contents;
  }

  .empty-state-title {
    margin: 0;
    font-size: 13px;
    font-weight: 500;
    color: var(--t1);
  }

  .empty-state-copy {
    margin: 0;
    font-size: 13px;
    font-weight: 400;
    color: var(--t2);
  }
</style>
