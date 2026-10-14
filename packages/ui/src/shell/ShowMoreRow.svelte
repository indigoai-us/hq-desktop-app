<script lang="ts">
  /**
   * The "Show more" row under a paged list (see list-paging.ts). Clicking it
   * or scrolling it into view loads the next page. Styled like the Messages
   * "Show all history" row.
   */
  import { onMount } from "svelte";

  interface Props {
    /** Rows painted so far. */
    shown: number;
    /** Every row in the list. */
    total: number;
    /** Size of the next page. */
    next: number;
    /** What the rows are, for the accessible label ("secrets"). */
    noun?: string;
    onmore: () => void;
    testid?: string;
  }

  let { shown, total, next, noun = "rows", onmore, testid = "show-more-row" }: Props = $props();

  let el = $state<HTMLButtonElement | null>(null);

  onMount(() => {
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onmore();
    });
    observer.observe(el);
    return () => observer.disconnect();
  });
</script>

<button
  bind:this={el}
  type="button"
  class="show-more-row"
  data-testid={testid}
  aria-label={`Show ${next} more ${noun}`}
  onclick={() => onmore()}
>
  Show {next} more <span class="count">· {shown.toLocaleString()} of {total.toLocaleString()}</span>
</button>

<style>
  .show-more-row {
    width: 100%;
    margin-top: 8px;
    padding: 6px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--t2, var(--v4-text-2));
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
  }
  .show-more-row:hover {
    background: var(--hover, var(--v4-hover));
  }
  .count {
    color: var(--t3, var(--v4-text-3));
  }
</style>
