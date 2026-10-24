<script lang="ts">
  // Header control for the Activity column (US-006). Wide windows get an
  // "Activity · N" pill that opens and closes the column. Below the column's
  // minimum width the pill gives way to a "People ▾" lens menu with People /
  // Agents / System / All, which changes what the main column shows for this
  // conversation only. The host owns the state; this renders and reports.
  import {
    ACTIVITY_LENSES,
    lensLabel,
    type ActivityLens,
  } from "./activity-column.js";
  import "./chat-tokens.css";

  interface Props {
    /** Agent and system messages the main column hides. */
    count: number;
    open: boolean;
    narrow: boolean;
    /** The lens in effect (menu label and checked item). */
    lens: ActivityLens;
    ontoggle: () => void;
    onlens: (lens: ActivityLens) => void;
  }

  let { count, open, narrow, lens, ontoggle, onlens }: Props = $props();

  let menuOpen = $state(false);
  let root = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!menuOpen) return;
    const away = (e: PointerEvent) => {
      if (root && e.target instanceof Node && !root.contains(e.target)) menuOpen = false;
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") menuOpen = false;
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  });

  function choose(next: ActivityLens): void {
    menuOpen = false;
    onlens(next);
  }
</script>

<div class="activity-control" bind:this={root}>
  {#if narrow}
    <button
      type="button"
      class="activity-pill"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      data-testid="activity-lens"
      onclick={() => (menuOpen = !menuOpen)}>{lensLabel(lens)} ▾</button
    >
    {#if menuOpen}
      <div class="activity-menu" role="menu" data-testid="activity-lens-menu">
        {#each ACTIVITY_LENSES as l (l.id)}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={lens === l.id}
            data-testid={`activity-lens-${l.id}`}
            onclick={() => choose(l.id)}>{l.label}</button
          >
        {/each}
      </div>
    {/if}
  {:else}
    <button
      type="button"
      class="activity-pill"
      class:on={open}
      aria-pressed={open}
      data-testid="activity-toggle"
      data-count={count}
      onclick={ontoggle}>Activity · {count}</button
    >
  {/if}
</div>

<style>
  .activity-control {
    position: relative;
    display: inline-flex;
    flex: 0 0 auto;
  }

  .activity-pill {
    padding: 3px 10px;
    border: 1px solid var(--line2, rgba(255, 255, 255, 0.11));
    border-radius: 999px;
    background: var(--raised, transparent);
    color: var(--t2);
    font: 500 12px/1.4 var(--font-ui);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    cursor: pointer;
  }

  .activity-pill:hover {
    background: var(--hover);
  }

  .activity-pill.on {
    color: var(--t1);
    border-color: var(--border-active, var(--line2));
  }

  .activity-pill:focus-visible,
  .activity-menu button:focus-visible {
    outline: 2px solid var(--border-active);
    outline-offset: 2px;
  }

  .activity-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    min-width: 128px;
    padding: 4px;
    border: 1px solid var(--panel-border, var(--line2));
    border-radius: 8px;
    background: var(--panel-bg, var(--elevated));
    box-shadow: var(--panel-shadow, none);
  }

  .activity-menu button {
    padding: 5px 8px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--t2);
    font: 400 12px/1.4 var(--font-ui);
    text-align: left;
    cursor: pointer;
  }

  .activity-menu button:hover,
  .activity-menu button[aria-checked="true"] {
    background: var(--hover);
    color: var(--t1);
  }
</style>
