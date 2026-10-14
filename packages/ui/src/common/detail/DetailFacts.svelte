<script lang="ts">
  /**
   * Shared two-column fact list for detail side panels: label column on the
   * left, value on the right, one row rhythm. Empty values drop the row.
   */
  import { visibleFacts, type DetailFact } from "./detail-facts.js";

  interface Props {
    facts: readonly DetailFact[];
    testid?: string;
  }

  let { facts, testid }: Props = $props();
  const rows = $derived(visibleFacts(facts));
</script>

{#if rows.length > 0}
  <dl class="detail-facts" data-testid={testid}>
    {#each rows as fact (fact.label)}
      <dt>{fact.label}</dt>
      <dd class:mono={fact.mono}>{fact.value}</dd>
    {/each}
  </dl>
{/if}

<style>
  .detail-facts {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    column-gap: 12px;
    margin: 16px 0;
    font-size: 13px;
    line-height: 1.45;
  }
  dt,
  dd {
    margin: 0;
    padding: 5px 0;
    border-top: 1px solid var(--v4-rowline, var(--line));
  }
  dt:first-of-type,
  dt:first-of-type + dd { border-top: 0; }
  dt { color: var(--t3, var(--v4-text-3)); }
  dd { color: var(--t1, var(--v4-text-1)); overflow-wrap: anywhere; }
  .mono { font-family: var(--font-mono, ui-monospace, monospace); }
</style>
