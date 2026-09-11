<script lang="ts">
  /**
   * Atlas tab (US-018) — read-only company graph. People and files open as
   * side panes; hover shows a card. No navigation away from the channel.
   */
  import {
    atlasFill,
    type AtlasGraph,
    type AtlasNode,
  } from "./atlas-model.js";

  interface Props {
    graph: AtlasGraph;
    liveStatus?: { [id: string]: string };
  }

  let { graph, liveStatus = {} }: Props = $props();

  let hoveredId = $state("");
  let selectedId = $state("");

  const hovered = $derived(
    graph.nodes.find((node) => node.id === hoveredId) ?? null,
  );
  const selected = $derived(
    graph.nodes.find((node) => node.id === selectedId) ?? null,
  );
  const people = $derived(graph.nodes.filter((node) => node.type === "person"));
  const files = $derived(graph.nodes.filter((node) => node.type === "file"));

  function nodeById(id: string): AtlasNode | undefined {
    return graph.nodes.find((node) => node.id === id);
  }

  function selectNode(node: AtlasNode): void {
    if (node.type === "person" || node.type === "file") {
      selectedId = node.id;
    }
  }
</script>

<div class="atlas-tab" data-testid="company-tab-atlas">
  <div class="atlas-stage">
    <svg
      class="atlas-canvas"
      viewBox="0 0 800 560"
      role="img"
      aria-label="Company atlas"
      data-testid="atlas-canvas"
    >
      {#each graph.edges as edge (edge.from + "-" + edge.to)}
        {@const from = nodeById(edge.from)}
        {@const to = nodeById(edge.to)}
        {#if from && to}
          <line
            class="atlas-edge"
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
          />
        {/if}
      {/each}
      {#each graph.nodes as node (node.id)}
        <g
          class="atlas-node"
          role="button"
          tabindex="0"
          data-testid={"atlas-node-" + node.id}
          data-type={node.type}
          transform={"translate(" + node.x + " " + node.y + ")"}
          onpointerenter={() => (hoveredId = node.id)}
          onmouseenter={() => (hoveredId = node.id)}
          onpointerleave={() => {
            if (hoveredId === node.id) hoveredId = "";
          }}
          onmouseleave={() => {
            if (hoveredId === node.id) hoveredId = "";
          }}
          onclick={() => selectNode(node)}
          onkeydown={(event) => {
            if (event.key === "Enter" || event.key === " ") selectNode(node);
          }}
        >
          <circle
            r={node.type === "company" ? 22 : 14}
            fill={atlasFill(node.type)}
          />
          {#if liveStatus[node.id]}
            <circle class="atlas-live" cx="10" cy="-10" r="4" />
          {/if}
          <text class="atlas-label" y="32">{node.label}</text>
        </g>
      {/each}
    </svg>
    {#if hovered}
      <div
        class="atlas-hover"
        data-testid="atlas-hover-card"
        style={"left:" + (hovered.x + 16) + "px;top:" + (hovered.y - 12) + "px"}
      >
        <div class="atlas-hover-k">{hovered.type}</div>
        <div class="atlas-hover-t">{hovered.label}</div>
        {#if hovered.subtitle}
          <div class="atlas-hover-s">{hovered.subtitle}</div>
        {/if}
      </div>
    {/if}
  </div>
  <aside class="atlas-panes">
    <section class="atlas-pane" data-testid="atlas-people-pane">
      <div class="atlas-pane-k">People</div>
      {#each people as person (person.id)}
        <button
          type="button"
          class="atlas-pane-row"
          class:on={selectedId === person.id}
          onclick={() => (selectedId = person.id)}
        >
          {person.label}
        </button>
      {/each}
    </section>
    <section class="atlas-pane" data-testid="atlas-files-pane">
      <div class="atlas-pane-k">Files</div>
      {#each files as file (file.id)}
        <button
          type="button"
          class="atlas-pane-row"
          class:on={selectedId === file.id}
          onclick={() => (selectedId = file.id)}
        >
          {file.label}
        </button>
      {/each}
      {#if files.length === 0}
        <div class="atlas-pane-empty">No files on the map</div>
      {/if}
    </section>
    {#if selected}
      <section class="atlas-pane" data-testid="atlas-detail-pane">
        <div class="atlas-pane-k">{selected.type}</div>
        <div class="atlas-pane-t">{selected.label}</div>
        {#if selected.subtitle}
          <div class="atlas-pane-s">{selected.subtitle}</div>
        {/if}
      </section>
    {/if}
  </aside>
</div>

<style>
  .atlas-tab {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 220px;
    min-height: 0;
    height: 100%;
  }

  .atlas-stage {
    position: relative;
    min-height: 360px;
  }

  .atlas-canvas {
    width: 100%;
    height: 100%;
    min-height: 360px;
  }

  .atlas-edge {
    stroke: color-mix(in srgb, var(--t1) 18%, transparent);
    stroke-width: 1.2;
  }

  .atlas-node {
    cursor: pointer;
  }

  .atlas-label {
    fill: var(--t2);
    font-size: 10px;
    text-anchor: middle;
  }

  .atlas-live {
    fill: #4ade80;
  }

  .atlas-hover {
    position: absolute;
    z-index: 2;
    min-width: 140px;
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--raised, #1c1c1c);
    color: var(--t1);
    pointer-events: none;
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
  }

  .atlas-hover-k,
  .atlas-pane-k {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--t3);
  }

  .atlas-hover-t,
  .atlas-pane-t {
    font-size: 13px;
    font-weight: 500;
    margin-top: 2px;
  }

  .atlas-hover-s,
  .atlas-pane-s,
  .atlas-pane-empty {
    font-size: 12px;
    color: var(--t3);
    margin-top: 2px;
  }

  .atlas-panes {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 14px;
    border-left: 1px solid color-mix(in srgb, var(--t1) 8%, transparent);
    overflow: auto;
  }

  .atlas-pane-row {
    appearance: none;
    display: block;
    width: 100%;
    text-align: left;
    padding: 6px 0;
    border: 0;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .atlas-pane-row.on {
    color: var(--t1);
    font-weight: 600;
  }
</style>
