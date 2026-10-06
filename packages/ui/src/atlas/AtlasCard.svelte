<script lang="ts">
  /**
   * Atlas list card: a type icon, the name, a quiet second line, and for
   * projects with stories a thin progress bar with "done / total stories".
   * Story counts are the node's own (the same source as the map's ring).
   * Projects without stories leave the bar slot empty.
   */
  import type { AtlasNode } from "./atlas-model.js";
  import { atlasStoryProgress } from "./atlas-activity.js";

  interface Props {
    node: AtlasNode;
    meta: string;
    selected?: boolean;
    testid?: string;
    onclick: () => void;
  }

  let { node, meta, selected = false, testid, onclick }: Props = $props();
  const progress = $derived(atlasStoryProgress(node));
</script>

<button
  type="button"
  class="card"
  class:selected
  data-testid={testid}
  data-type={node.type}
  aria-pressed={selected}
  {onclick}
>
  <svg class="ic" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    {#if node.type === "project"}
      <circle cx="8" cy="8" r="4.5" />
    {:else if node.type === "knowledge"}
      <path d="M4 2.5h5.5L12 5v8.5H4z M9.5 2.5V5H12" />
    {:else if node.type === "policy"}
      <path d="M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z" />
    {:else if node.type === "repo"}
      <path d="M6 5L3 8l3 3 M10 5l3 3-3 3" />
    {:else if node.type === "worker"}
      <path d="M3.5 4.5h9v8h-9z M6 8h.01 M10 8h.01 M8 2v2.5" />
    {:else}
      <path d="M8 2.5l1.6 3.4 3.6.4-2.7 2.5.8 3.6L8 10.6l-3.3 1.8.8-3.6-2.7-2.5 3.6-.4z" />
    {/if}
  </svg>
  <span class="body">
    <span class="tt">{node.label}</span>
    <span class="mm">{meta}</span>
    {#if progress}
      <span class="prog" data-testid="atlas-card-progress" data-done={progress.fraction.toFixed(3)}>
        <span class="track"><span class="fill" style:width={`${(progress.fraction * 100).toFixed(1)}%`}></span></span>
        <span class="count" data-testid="atlas-card-count">{progress.text}</span>
      </span>
    {/if}
  </span>
</button>

<style>
  .card {
    display: grid;
    grid-template-columns: 14px 1fr;
    gap: 10px;
    align-items: start;
    width: calc(100% + 20px);
    margin: 0 -10px;
    padding: 8px 10px;
    background: none;
    border: 0;
    border-radius: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .card:hover { background: var(--v4-hover, var(--v4-control-faint)); }
  .card.selected { background: var(--v4-active-row); }
  .ic {
    margin-top: 2px;
    fill: none;
    stroke: var(--v4-text-3);
    stroke-width: 1.25;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .tt {
    font-size: 13px;
    color: var(--v4-text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mm { font-size: 13px; color: var(--v4-text-3); }
  .prog { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  /* Same tone as the map's story ring: text ink, quiet track, stronger done share. */
  .track { position: relative; flex: 1; height: 2px; background: color-mix(in srgb, var(--v4-text-1) 12%, transparent); overflow: hidden; }
  .fill { position: absolute; inset: 0 auto 0 0; background: color-mix(in srgb, var(--v4-text-1) 45%, transparent); }
  .card:hover .fill, .card.selected .fill { background: color-mix(in srgb, var(--v4-text-1) 80%, transparent); }
  /* Fixed count width so every bar in the list ends at the same x. */
  .count { flex: none; min-width: 14ch; text-align: right; font-size: 13px; color: var(--v4-text-3); font-variant-numeric: tabular-nums; }
</style>
