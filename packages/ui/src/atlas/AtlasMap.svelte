<script lang="ts">
  /**
   * Atlas ring map: one SVG layer, one transformed group. Drag pans, wheel
   * zooms, double-click frames all. Keyboard (`0`, `Esc`) is owned by the
   * parent view so it also works while focus sits in the inspector.
   */
  import type { AtlasPresence, AtlasRefEdge } from "./atlas-model.js";
  import { ATLAS_CHIP_SIZE, atlasDockedChips } from "./atlas-presence.js";
  import {
    atlasLabelIds,
    atlasRelatedIds,
    atlasVisibleEdges,
    frameAll,
    viewTransform,
    zoomAt,
    type AtlasPlaced,
    type AtlasRegion,
    type AtlasView,
  } from "./atlas-layout.js";

  interface Props {
    placed: AtlasPlaced[];
    regions: AtlasRegion[];
    edges: AtlasRefEdge[];
    selected: string | null;
    live: Set<string>;
    /** Live actors docked as chips beside their objects (US-013). */
    presence?: AtlasPresence[];
    /** People filter: objects to keep at full strength; null shows all. */
    filterIds?: Set<string> | null;
    /** Actor the people filter is on; their chips stay bright. */
    filterActor?: string | null;
    /** Time scrubber (US-014): per-object opacity at the scrubbed day; null at now. */
    timeOpacity?: Map<string, number> | null;
    nowMs: number;
    view: AtlasView;
    onselect: (id: string | null) => void;
    onview: (view: AtlasView) => void;
  }

  let {
    placed,
    regions,
    edges,
    selected,
    live,
    presence = [],
    filterIds = null,
    filterActor = null,
    timeOpacity = null,
    nowMs,
    view,
    onselect,
    onview,
  }: Props = $props();

  let hovered = $state<string | null>(null);
  let svgEl = $state<SVGSVGElement | null>(null);
  let drag: {
    id: number;
    sx: number;
    sy: number;
    vx: number;
    vy: number;
    moved: boolean;
    node: string | null;
  } | null = null;

  const byId = $derived(new Map(placed.map((p) => [p.id, p])));
  const related = $derived(atlasRelatedIds(selected ?? hovered, edges));
  const shownEdges = $derived(atlasVisibleEdges(edges, selected, hovered));
  const labels = $derived(atlasLabelIds({ placed, selected, hovered, related, nowMs }));
  const focusIds = $derived(selected || hovered ? new Set([selected, hovered, ...related]) : null);
  const chips = $derived(atlasDockedChips(placed, presence));
  const half = ATLAS_CHIP_SIZE / 2;

  function dimmed(id: string): boolean {
    if (filterIds && !filterIds.has(id)) return true;
    return focusIds !== null && !focusIds.has(id);
  }

  export function frame(): void {
    const box = svgEl?.getBoundingClientRect();
    onview(frameAll(placed, box?.width ?? 800, box?.height ?? 560));
  }

  /**
   * A press that ends within the drag threshold is a click: it activates the
   * node it started on (same path as Return) or clears the selection on empty
   * map. Move/up are tracked on window after pointerdown, since WKWebView does
   * not reliably deliver pointer capture, and capture would retarget the
   * release away from the node anyway.
   */
  const DRAG_THRESHOLD = 3;

  function nodeIdAt(target: EventTarget | null): string | null {
    const el = target instanceof Element ? target.closest("[data-atlas-node]") : null;
    return el?.getAttribute("data-atlas-node") ?? null;
  }

  function onpointerdown(event: PointerEvent): void {
    if (event.button !== 0) return;
    drag = {
      id: event.pointerId,
      sx: event.clientX,
      sy: event.clientY,
      vx: view.x,
      vy: view.y,
      moved: false,
      node: nodeIdAt(event.target),
    };
    window.addEventListener("pointermove", onpointermove);
    window.addEventListener("pointerup", onpointerup);
    window.addEventListener("pointercancel", onpointercancel);
  }

  function onpointermove(event: PointerEvent): void {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.sx;
    const dy = event.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    onview({ ...view, x: drag.vx + dx, y: drag.vy + dy });
  }

  function endDrag(): void {
    drag = null;
    window.removeEventListener("pointermove", onpointermove);
    window.removeEventListener("pointerup", onpointerup);
    window.removeEventListener("pointercancel", onpointercancel);
  }

  function onpointerup(event: PointerEvent): void {
    if (!drag || drag.id !== event.pointerId) return;
    const moved =
      drag.moved || Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy) >= DRAG_THRESHOLD;
    const node = drag.node;
    endDrag();
    if (!moved) onselect(node);
  }

  function onpointercancel(event: PointerEvent): void {
    if (drag && drag.id === event.pointerId) endDrag();
  }

  $effect(() => endDrag);

  function onwheel(event: WheelEvent): void {
    event.preventDefault();
    const box = svgEl?.getBoundingClientRect();
    const sx = event.clientX - (box?.left ?? 0);
    const sy = event.clientY - (box?.top ?? 0);
    onview(zoomAt(view, sx, sy, Math.exp(-event.deltaY * 0.0015)));
  }

  function zoomBy(factor: number): void {
    const box = svgEl?.getBoundingClientRect();
    onview(zoomAt(view, (box?.width ?? 800) / 2, (box?.height ?? 560) / 2, factor));
  }
</script>

<div class="atlas-map" data-testid="atlas-map">
  <svg
    bind:this={svgEl}
    role="application"
    aria-label="Atlas map"
    onpointerdown={onpointerdown}
    ondblclick={frame}
    onwheel={onwheel}
  >
    <g data-testid="atlas-world" transform={viewTransform(view)}>
      {#each regions as region (region.type)}
        <text class="region" x={region.x} y={region.y - 70} text-anchor="middle">{region.label}</text>
      {/each}
      {#each shownEdges as edge (`${edge.kind}:${edge.source}>${edge.target}`)}
        {@const a = byId.get(edge.source)}
        {@const b = byId.get(edge.target)}
        {#if a && b}
          <line
            class="edge"
            data-testid="atlas-edge"
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            vector-effect="non-scaling-stroke"
          />
        {/if}
      {/each}
      {#each placed as node (node.id)}
        <g
          class="node"
          class:dim={dimmed(node.id)}
          class:selected={node.id === selected}
          style:--t={timeOpacity?.get(node.id) ?? null}
          data-testid={`atlas-node-${node.id}`}
          data-kind={node.type}
          data-atlas-node={node.id}
          role="button"
          tabindex="-1"
          aria-label={node.label}
          aria-pressed={node.id === selected}
          onpointerenter={() => (hovered = node.id)}
          onpointerleave={() => (hovered = hovered === node.id ? null : hovered)}
          onkeydown={(event) => {
            if (event.key === "Enter") onselect(node.id);
          }}
        >
          {#if node.id === selected}
            <circle class="sel-bg" cx={node.x} cy={node.y} r={node.r + 8} />
          {/if}
          {#if live.has(node.id)}
            <circle class="halo" data-testid={`atlas-halo-${node.id}`} cx={node.x} cy={node.y} r={node.r + 4} vector-effect="non-scaling-stroke" />
          {/if}
          <circle class="dot" cx={node.x} cy={node.y} r={node.r} />
          {#if labels.has(node.id)}
            <text
              class="label"
              data-testid={`atlas-label-${node.id}`}
              x={node.x + node.r + 5}
              y={node.y + 4}
            >{node.label}</text>
          {/if}
        </g>
      {/each}
      {#each chips as chip (chip.key)}
        <g
          class="dock"
          class:dim={filterActor ? chip.actorUid !== filterActor : dimmed(chip.nodeId)}
          data-testid={`atlas-chip-${chip.actorUid ?? chip.name}`}
          data-node={chip.nodeId}
          data-kind={chip.bot ? "bot" : "human"}
          aria-label={`${chip.name} on ${byId.get(chip.nodeId)?.label ?? chip.nodeId}`}
        >
          <line
            class="connector"
            x1={chip.x1}
            y1={chip.y1}
            x2={chip.x - half}
            y2={chip.y + half}
            vector-effect="non-scaling-stroke"
          />
          {#if chip.bot}
            <rect class="mark" x={chip.x - half} y={chip.y - half} width={ATLAS_CHIP_SIZE} height={ATLAS_CHIP_SIZE} rx="5" />
          {:else}
            <circle class="mark" cx={chip.x} cy={chip.y} r={half} />
          {/if}
          <text class="initials" x={chip.x} y={chip.y + 3} text-anchor="middle">{chip.initials}</text>
          <title>{chip.name}</title>
        </g>
      {/each}
    </g>
  </svg>
  <div class="legend">
    <span><i class="ldot"></i>live</span>
    <span><i class="halo-key"></i>someone here now</span>
    <span class="hint">drag to pan · wheel to zoom · 0 frames all</span>
  </div>
  <div class="map-tools">
    <button type="button" class="btn" aria-label="Zoom out" onclick={() => zoomBy(1 / 1.25)}>−</button>
    <button type="button" class="btn" aria-label="Zoom in" onclick={() => zoomBy(1.25)}>+</button>
  </div>
</div>

<style>
  .atlas-map {
    position: relative;
    overflow: hidden;
    min-height: 0;
    height: 100%;
  }
  svg {
    display: block;
    width: 100%;
    height: 100%;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  svg:active {
    cursor: grabbing;
  }
  .region {
    font-family: var(--font-mono, "Geist Mono", monospace);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    fill: var(--v4-text-3);
    pointer-events: none;
  }
  .edge {
    stroke: var(--v4-text-3);
    stroke-width: 1;
  }
  /* --t is the scrubber's per-object opacity; playback animates opacity only. */
  .node {
    cursor: pointer;
    outline: none;
    opacity: var(--t, 1);
    transition: opacity 160ms ease;
  }
  .dot {
    fill: var(--v4-text-3);
    transition: fill 120ms ease;
  }
  .node:hover .dot,
  .node.selected .dot {
    fill: var(--v4-text-1);
  }
  .node.dim {
    opacity: calc(var(--t, 1) * 0.35);
  }
  .sel-bg {
    fill: var(--v4-active-row);
  }
  /* Opacity-only pulse; stops under reduced motion. */
  .halo {
    fill: none;
    stroke: var(--v4-ok);
    stroke-width: 1.5;
    opacity: 0.9;
    animation: atlas-halo 1.8s ease-in-out infinite;
  }
  @keyframes atlas-halo {
    50% {
      opacity: 0.35;
    }
  }
  .dock {
    pointer-events: none;
  }
  .dock.dim {
    opacity: 0.35;
  }
  .connector {
    stroke: var(--v4-ok);
    stroke-width: 1;
    stroke-dasharray: 3 3;
  }
  .mark {
    fill: var(--v4-control-bg);
    stroke: var(--v4-ok);
    stroke-width: 1.5;
  }
  .initials {
    font-family: var(--font-mono, "Geist Mono", monospace);
    font-size: 7px;
    font-weight: 600;
    fill: var(--v4-text-1);
  }
  @media (prefers-reduced-motion: reduce) {
    .halo {
      animation: none;
    }
  }
  .label {
    font-family: var(--font-sans, "Geist", sans-serif);
    font-size: 12px;
    fill: var(--v4-text-1);
    paint-order: stroke;
    stroke: var(--v4-ground);
    stroke-width: 3px;
    pointer-events: none;
  }
  .legend {
    position: absolute;
    left: 14px;
    bottom: 12px;
    display: flex;
    gap: 14px;
    align-items: center;
    font-size: 11px;
    color: var(--v4-text-3);
    pointer-events: none;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .legend .hint {
    opacity: 0.7;
    margin-left: 6px;
  }
  .ldot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-ok);
  }
  .halo-key {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.5px solid var(--v4-ok);
    box-sizing: border-box;
  }
  .map-tools {
    position: absolute;
    right: 12px;
    top: 12px;
    display: flex;
    gap: 4px;
  }
  .btn {
    padding: 4px 8px;
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-metadata);
    cursor: pointer;
  }
  .btn:hover {
    background: var(--v4-hover, var(--v4-control-faint));
  }
</style>
