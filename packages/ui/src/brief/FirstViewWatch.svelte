<script lang="ts">
  /** First view, the risk slot: the welcome actions left after the other cards, without zero counts. */
  import type { WelcomeAction } from "./brief-welcome-contract.js";
  import { firstViewWatch } from "./brief-first-view-copy.js";

  interface Props {
    list: readonly WelcomeAction[];
  }
  let { list }: Props = $props();
  const rows = $derived(firstViewWatch(list));
</script>

<div class="w fv-card" data-testid="first-view-watch">
  <ul class="fv-rows">
    {#each rows as a (a.id)}
      <li class="fv-row" data-testid="first-view-watch-row" data-kind={a.kind}>
        <b>{a.label}</b>
        {#if a.reason}<span>{a.reason}</span>{/if}
      </li>
    {/each}
  </ul>
</div>

<style>
  .fv-card {
    padding-top: 48px;
  }
  .fv-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .fv-row {
    display: flex;
    flex-direction: column;
    padding: 9px 11px;
    border-radius: 8px;
    background: var(--b-row-bg, rgba(255, 255, 255, 0.14));
    border: 1px solid var(--b-row-line, rgba(255, 255, 255, 0.2));
  }
  .fv-row b {
    font-weight: 500;
    font-size: 13px;
  }
  .fv-row span {
    font-size: 11px;
    color: var(--b-t3);
  }
</style>
