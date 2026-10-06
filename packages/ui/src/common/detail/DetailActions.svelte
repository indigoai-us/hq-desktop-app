<script lang="ts" module>
  import type { RailIconName } from "../button/rail-icons.js";

  export interface DetailAction {
    label: string;
    icon: RailIconName;
    testid?: string;
    onselect: () => void;
  }
</script>

<script lang="ts">
  /**
   * Shared detail side panel action row: one primary action, then the
   * secondary actions on the same row at the standard button height. The row
   * never wraps. When the panel is too narrow, the last secondary actions
   * move into a "More" menu, one at a time, until the row fits.
   */
  import { tick, untrack } from "svelte";
  import RailButton from "../button/RailButton.svelte";

  interface Props {
    primary?: DetailAction | null;
    secondary?: readonly DetailAction[];
    testid?: string;
  }

  let { primary = null, secondary = [], testid }: Props = $props();

  let row = $state<HTMLDivElement | null>(null);
  let shown = $state(Number.POSITIVE_INFINITY);
  let menuOpen = $state(false);
  let menuRoot = $state<HTMLDivElement | null>(null);

  const visible = $derived(secondary.slice(0, Math.min(shown, secondary.length)));
  const overflow = $derived(secondary.slice(visible.length));

  async function fit(): Promise<void> {
    if (!row) return;
    shown = secondary.length;
    await tick();
    while (row && shown > 0 && row.scrollWidth > row.clientWidth) {
      shown -= 1;
      await tick();
    }
  }

  $effect(() => {
    void secondary.length;
    if (!row || typeof ResizeObserver === "undefined") return;
    let width = row.clientWidth;
    const observer = new ResizeObserver(() => {
      if (!row || row.clientWidth === width) return;
      width = row.clientWidth;
      untrack(() => void fit());
    });
    observer.observe(row);
    untrack(() => void fit());
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!menuOpen) return;
    const onDown = (event: PointerEvent) => {
      if (menuRoot && !menuRoot.contains(event.target as Node)) menuOpen = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") menuOpen = false;
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  });

  function choose(action: DetailAction): void {
    menuOpen = false;
    action.onselect();
  }
</script>

<div class="detail-actions" bind:this={row} data-testid={testid}>
  {#if primary}
    <RailButton icon={primary.icon} variant="primary" data-testid={primary.testid} onclick={primary.onselect}>{primary.label}</RailButton>
  {/if}
  {#each visible as action (action.label)}
    <RailButton icon={action.icon} data-testid={action.testid} onclick={action.onselect}>{action.label}</RailButton>
  {/each}
  {#if overflow.length > 0}
    <div class="more" bind:this={menuRoot}>
      <RailButton
        icon="chevron-down"
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-testid="detail-actions-more"
        onclick={() => (menuOpen = !menuOpen)}
      >More</RailButton>
      {#if menuOpen}
        <div class="menu" role="menu">
          {#each overflow as action (action.label)}
            <button type="button" role="menuitem" data-testid={action.testid} onclick={() => choose(action)}>{action.label}</button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .detail-actions {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 8px;
    margin: 16px 0;
    min-width: 0;
  }
  .more { position: relative; flex: none; }
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 20;
    min-width: 160px;
    padding: 4px;
    border: 1px solid var(--panel-border, var(--v4-control-border));
    border-radius: 8px;
    background: var(--overlay-bg, var(--panel-bg, var(--v4-raised, var(--v4-ground))));
    box-shadow: var(--panel-shadow, none);
  }
  .menu button {
    display: flex;
    align-items: center;
    width: 100%;
    height: var(--hq-btn-h);
    padding: 0 var(--hq-btn-pad-inline);
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t1, var(--v4-text-1));
    font: inherit;
    font-size: var(--hq-btn-font-size);
    text-align: left;
    cursor: pointer;
  }
  .menu button:hover,
  .menu button:focus-visible { background: var(--hover, var(--v4-hover)); outline: none; }
</style>
