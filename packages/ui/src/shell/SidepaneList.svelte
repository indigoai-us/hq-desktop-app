<!--
  Sidepane row list (console-rail US-006).

  Shared row grammar for the Company and Atlas content models, copied from
  the Messages sidebar: 31 px rows, 13 px text, 8 px radius, background-highlight
  selection, and the Messages section label. Lists longer than SIDEPANE_VIRTUALIZE_THRESHOLD items render only
  the rows near the viewport of the enclosing Sidepane body.
-->
<script lang="ts">
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

  const GLYPH: Record<string, string> = {
    atlas: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="2.5"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="M6.6 7.3l3.6 3M17.4 7.3l-3.6 3M6.6 16.7l3.6-3M17.4 16.7l-3.6-3"/></svg>`,
    projects: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="5" height="14" rx="1"/><rect x="10" y="5" width="5" height="9" rx="1"/><rect x="17" y="5" width="4" height="6" rx="1"/></svg>`,
    activity: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 19h16M6 19V9M11 19V5M16 19v-8"/></svg>`,
    team: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0M16 4a3.5 3.5 0 0 1 0 7M21 20a6 6 0 0 0-4-5.6"/></svg>`,
    bots: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="7" width="14" height="12" rx="3"/><path d="M12 3v4M9 13h.01M15 13h.01"/></svg>`,
    groups: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="9" r="3"/><circle cx="16" cy="9" r="3"/><path d="M2.5 19a5.5 5.5 0 0 1 11 0M10.5 19a5.5 5.5 0 0 1 11 0"/></svg>`,
    grants: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3M12 15v2"/></svg>`,
    knowledge: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 5h10a4 4 0 0 1 4 4v10H9a4 4 0 0 0-4 4z"/><path d="M5 5v14"/></svg>`,
    policies: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/></svg>`,
    skills: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 4l6 6-8 8H6v-6z"/></svg>`,
    workers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="8" width="16" height="10" rx="2"/><path d="M8 8V6h8v2M9 13h.01M15 13h.01"/></svg>`,
    vault: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="12" cy="12" r="3"/></svg>`,
    integrations: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 8h8v8H8z"/><path d="M12 3v5M12 16v5M3 12h5M16 12h5"/></svg>`,
    secrets: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="14" r="3"/><path d="M11 14h9l-2-2 2-2h-4"/></svg>`,
    deployments: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 21h14"/></svg>`,
  };

  function sectionGlyph(id: string): string {
    return GLYPH[id] ?? "";
  }

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
        {#if !item.row.mark && sectionGlyph(item.row.id)}
          <span class="glyph" aria-hidden="true">{@html sectionGlyph(item.row.id)}</span>
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
