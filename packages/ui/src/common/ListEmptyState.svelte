<script lang="ts">
  /**
   * The one empty state for searchable or filterable lists (QA-058). Shows
   * "No matches for '<query>'" with Clear search and the list total when the
   * query or filter hides every row; the plain empty copy only when the
   * unfiltered list has nothing in it.
   */
  import { listEmptyState, type ListEmptyInput } from "./list-empty-state.js";
  import RailButton from "./button/RailButton.svelte";

  interface Props extends ListEmptyInput {
    /** Clears the query and filters. The button hides without it. */
    onclear?: () => void;
    clearLabel?: string;
    testid?: string;
  }

  let { onclear, clearLabel, testid = "list-empty-state", ...input }: Props = $props();

  const view = $derived(listEmptyState(input));
</script>

{#if view}
  <div class="list-empty" data-testid={testid} data-kind={view.kind} role="status">
    <p class="title">{view.title}</p>
    {#if view.kind === "no-matches"}
      <p class="total meta-line" data-meta-line data-testid={`${testid}-total`}>{view.totalLabel}</p>
      {#if onclear}
        <span class="clear">
          <RailButton icon="x" data-testid={`${testid}-clear`} onclick={() => onclear?.()}>
            {clearLabel ?? (input.query?.trim() ? "Clear search" : "Clear filters")}
          </RailButton>
        </span>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .list-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 32px 16px;
    text-align: center;
  }
  .title {
    margin: 0;
    font-size: 13px;
    font-weight: 500;
    color: var(--t1);
  }
  .total {
    margin: 0;
  }
  .clear {
    display: contents;
  }
</style>
