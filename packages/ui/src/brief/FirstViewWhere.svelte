<script lang="ts">
  /**
   * First view, the b-next slot: where the person works, one row per harness
   * with its session count, and the open action under them. No orbit.
   */
  import type { FirstViewTool } from "./brief-first-view.js";
  import type { WelcomeAction } from "./brief-welcome-contract.js";

  interface Props {
    tools: readonly FirstViewTool[];
    /** The harness's open action; null (or no onopen) shows no button. */
    open?: WelcomeAction | null;
    onopen?: ((action: WelcomeAction) => void) | null;
    busy?: boolean;
  }
  let { tools, open = null, onopen = null, busy = false }: Props = $props();
  const max = $derived(Math.max(1, ...tools.map((t) => t.sessions)));
</script>

<div class="fv-where" data-testid="first-view-where">
  {#each tools as t (t.harness)}
    <div class="fv-wrow" data-testid="first-view-where-row">
      <span class="fv-wname">{t.name}</span>
      <span class="fv-bar"><i style:width="{(t.sessions / max) * 100}%"></i></span>
      <b>{t.sessions}</b>
    </div>
  {/each}
</div>
{#if open && onopen}
  <button type="button" class="fv-open" data-testid="first-view-where-open" disabled={busy} onclick={() => onopen?.(open)}>{open.label}</button>
{/if}

<style>
  .fv-where {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 14px 0;
  }
  .fv-wrow {
    display: grid;
    grid-template-columns: minmax(70px, auto) minmax(0, 1fr) 40px;
    align-items: center;
    gap: 10px;
    font-size: 13px;
  }
  .fv-wname {
    white-space: nowrap;
  }
  .fv-wrow b {
    font-size: 20px;
    font-weight: 400;
    text-align: right;
    letter-spacing: -0.02em;
  }
  .fv-bar {
    height: 6px;
    border-radius: 999px;
    background: rgb(var(--b-ink) / 0.08);
    overflow: hidden;
  }
  .fv-bar i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--b-accent-grad);
  }
  .fv-open {
    align-self: flex-start;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    padding: 7px 14px;
    border-radius: 999px;
    border: 0;
    cursor: pointer;
    background: rgb(var(--b-ink) / 0.9);
    color: var(--b-bg);
  }
  .fv-open:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
