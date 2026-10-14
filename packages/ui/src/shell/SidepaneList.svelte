<!--
  Sidepane row list (console-rail US-006).

  Shared row grammar for the Company and Atlas content models, copied from
  the Messages sidebar: 31 px rows, 13 px text, 8 px radius, background-highlight
  selection, and the Messages section label. Lists longer than SIDEPANE_VIRTUALIZE_THRESHOLD items render only
  the rows near the viewport of the enclosing Sidepane body.
-->
<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  import type { RailIconName } from "../common/button/rail-icons.js";
  import {
    SIDEPANE_ROW_HEIGHT,
    SIDEPANE_VIRTUALIZE_THRESHOLD,
    flattenSections,
    windowRange,
    type SidepaneRow,
    type SidepaneSection,
  } from "./sidepane-models.js";

  interface Props {
    sections: readonly SidepaneSection[];
    selectedId?: string | null;
    onselect?: (row: SidepaneRow) => void;
  }

  let { sections, selectedId = null, onselect }: Props = $props();

  const items = $derived(flattenSections(sections));

  let list = $state<HTMLElement | null>(null);
  let scrollTop = $state(0);
  let viewport = $state(0);

  // The enclosing Sidepane body is the scroller; follow it only when the
  // list is long enough to window, so short lists add no listeners.
  $effect(() => {
    if (!list || items.length <= SIDEPANE_VIRTUALIZE_THRESHOLD) return;
    const scroller = list.closest(".sidepane-body") as HTMLElement | null;
    if (!scroller) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      scrollTop = Math.max(0, scroller.scrollTop - list!.offsetTop);
      viewport = scroller.clientHeight;
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(onScroll) : null;
    ro?.observe(scroller);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", onScroll);
      ro?.disconnect();
    };
  });

  // Phosphor Regular section icons, rendered through the shared registry.
  const GLYPH: Record<string, RailIconName> = {
    atlas: "graph",
    workers: "briefcase",
    projects: "kanban",
    activity: "chart-bar",
    goals: "target",
    team: "users",
    groups: "users-three",
    grants: "lock-simple",
    bots: "robot",
    knowledge: "book",
    policies: "shield-check",
    skills: "lightning",
    vault: "folder",
    integrations: "plugs-connected",
    secrets: "key",
    deployments: "upload",
  };


  const range = $derived(windowRange(items.length, scrollTop, viewport || 900));
  const visible = $derived(items.slice(range.start, range.end));
</script>

<div
  class="sidepane-list"
  bind:this={list}
  data-testid="sidepane-list"
  data-windowed={items.length > SIDEPANE_VIRTUALIZE_THRESHOLD ? "true" : undefined}
  style:padding-top={`${range.padTop}px`}
  style:padding-bottom={`${range.padBottom}px`}
  style:--sidepane-row-h={`${SIDEPANE_ROW_HEIGHT}px`}
>
  {#each visible as item (item.key)}
    {#if item.type === "section"}
      <div class="sidepane-section-label" data-testid="sidepane-section-label">{item.label}</div>
    {:else}
      <button
        type="button"
        class="sidepane-row"
        class:is-selected={item.row.id === selectedId}
        aria-current={item.row.id === selectedId ? "page" : undefined}
        data-testid="sidepane-row"
        data-row-id={item.row.id}
        onclick={() => onselect?.(item.row)}
      >
        {#if !item.row.mark && GLYPH[item.row.id]}
          <span class="glyph" aria-hidden="true"><RailIcon name={GLYPH[item.row.id]!} size={16} /></span>
        {/if}
        {#if item.row.mark}
          <span class="mark" class:square={item.row.mark === "square"} aria-hidden="true">
            {item.row.label.slice(0, 1).toUpperCase()}
            {#if item.row.live}<span class="live-dot"></span>{/if}
          </span>
        {/if}
        <span class="label">{item.row.label}</span>
        {#if item.row.count}<span class="count" title={item.row.countScope}>{item.row.count}</span>{/if}
      </button>
    {/if}
  {/each}
</div>

<style>
  .sidepane-list {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .sidepane-section-label {
    display: flex;
    align-items: flex-end;
    height: var(--sidepane-row-h);
    box-sizing: border-box;
    padding: 12px 8px 4px;
    color: var(--t2);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .sidepane-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: var(--sidepane-row-h);
    box-sizing: border-box;
    padding: 7px 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 13px;
    line-height: 17px;
    text-align: left;
    cursor: pointer;
  }

  .sidepane-row:hover {
    background: var(--hover);
  }

  .sidepane-row.is-selected {
    background: var(--sel);
  }

  .sidepane-row:focus-visible {
    outline: 1px solid var(--line2);
    outline-offset: -1px;
  }

  .label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .glyph {
    display: inline-grid;
    place-items: center;
    flex: 0 0 16px;
    width: 16px;
    height: 16px;
    color: var(--t2);
  }

  .glyph :global(svg) {
    width: 16px;
    height: 16px;
  }

  .sidepane-row.is-selected .glyph {
    color: var(--t1);
  }

  .mark {
    position: relative;
    display: inline-grid;
    flex: 0 0 16px;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--line2);
    color: var(--t1);
    font-size: 9px;
    font-weight: 500;
  }

  .mark.square {
    border-radius: 4px;
  }

  .live-dot {
    position: absolute;
    right: -2px;
    bottom: -2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 0 1.5px var(--side-bg);
  }

  .count {
    flex: 0 0 auto;
    color: var(--t3);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
</style>
