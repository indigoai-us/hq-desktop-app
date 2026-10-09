<script lang="ts">
  /**
   * Atlas ring map: one SVG layer, one transformed group. Drag pans, wheel
   * zooms, double-click frames all. Keyboard (`0`, `Esc`) is owned by the
   * parent view so it also works while focus sits in the inspector.
   */
  import {
    type AtlasPresence,
    type AtlasRefEdge,
  } from "./atlas-model.js";
  import { ATLAS_PULSE_MS, type AtlasTrail } from "./atlas-motion.js";
  import { atlasFocusPlaced, type AtlasFocusOffset } from "./atlas-focus.js";
  import { ATLAS_RING_GAP, ATLAS_RING_MIN_PX, atlasStoryFraction } from "./atlas-activity.js";
  import { ATLAS_DOCK_CAP, atlasDockedChips, atlasUnplacedActors } from "./atlas-presence.js";
  import AtlasFace from "./AtlasFace.svelte";
  import { atlasHoverContent, type AtlasHoverContent } from "./atlas-hover.js";
  import {
    ATLAS_LABEL_PX,
    atlasRelatedIds,
    atlasDistrictLabel,
    atlasDistrictShapes,
    atlasScreenLabels,
    atlasVisibleEdges,
    frameAll,
    viewTransform,
    zoomAt,
    type AtlasPlaced,
    type AtlasRegion,
    type AtlasScreenLabel,
    type AtlasView,
    ATLAS_TYPE_TINT,
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
    /** Live edge with no active object: show the quiet-map hint. */
    nothingActive?: boolean;
    nowMs: number;
    /** Focus mode: related items gathered around the selected project (target positions). */
    focus?: Map<string, AtlasFocusOffset> | null;
    /** Animate focus moves and other transitions. Off (or reduced motion) shows the end state. */
    motion?: boolean;
    /** Projects pulsing once now (id → pulse sequence, so a repeat restarts it). */
    pulses?: ReadonlyMap<string, number>;
    /** Faint trails from projects active now to what they just touched. */
    trails?: readonly AtlasTrail[];
    /** Scrubbed or playing: the day on the map, and while playing that day's biggest changes. */
    playback?: { date: string; caption: string } | null;
    view: AtlasView;
    onselect: (id: string | null) => void;
    onview: (view: AtlasView) => void;
    /** Programmatic camera moves (zoom buttons, frame, zoom to a section); may animate. */
    onfly?: (view: AtlasView) => void;
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
    nothingActive = false,
    nowMs,
    focus = null,
    motion = true,
    pulses = new Map(),
    trails = [],
    playback = null,
    view,
    onselect,
    onview,
    onfly,
  }: Props = $props();

  // The pan and zoom tip shows until the person has moved the map once, ever.
  const HINT_KEY = "hq.atlas.hint-seen.v1";
  function readHintSeen(): boolean {
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem(HINT_KEY) === "1";
    } catch (err) {
      console.debug("[atlas] hint flag unreadable", err);
      return false;
    }
  }
  let hintSeen = $state(readHintSeen());
  function markHintSeen(): void {
    if (hintSeen) return;
    hintSeen = true;
    try {
      localStorage.setItem(HINT_KEY, "1");
    } catch (err) {
      console.debug("[atlas] hint flag not saved", err);
    }
  }

  // No animation work while the window is hidden: CSS animations pause.
  let pageHidden = $state(typeof document !== "undefined" && document.hidden);
  $effect(() => {
    if (typeof document === "undefined") return;
    const sync = () => (pageHidden = document.hidden);
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  });

  // One id per map so two maps on a page never share a gradient.
  const glowId = `atlas-glow-${Math.random().toString(36).slice(2, 8)}`;
  // Chip picture clips, sized to each chip by objectBoundingBox units.
  const clipRoundId = `${glowId}-round`;
  const clipBotId = `${glowId}-bot`;
  // Picture URLs that failed to load; their chips draw initials instead.
  let brokenPictures = $state<ReadonlySet<string>>(new Set());
  function pictureFailed(url: string): void {
    if (brokenPictures.has(url)) return;
    brokenPictures = new Set([...brokenPictures, url]);
  }

  let hovered = $state<string | null>(null);
  /** Key of the actor chip under the pointer; its card replaces the object card. */
  let hoveredChip = $state<string | null>(null);
  /** True while the map is being dragged; hover cards stay hidden. */
  let dragging = $state(false);
  let svgEl = $state<SVGSVGElement | null>(null);
  let drag: {
    id: number;
    sx: number;
    sy: number;
    vx: number;
    vy: number;
    moved: boolean;
    node: string | null;
    section: string | null;
  } | null = null;

  // Where each object is drawn now: home, or its focus-mode orbit spot. Dots
  // keep their home cx/cy and move with a CSS transform; everything drawn in
  // screen space (labels, chips, cards, edges) uses these positions.
  const shown = $derived(atlasFocusPlaced(placed, focus));
  const byId = $derived(new Map(shown.map((p) => [p.id, p])));
  const related = $derived(atlasRelatedIds(selected ?? hovered, edges));
  const shownEdges = $derived(atlasVisibleEdges(edges, selected, hovered));
  let mapWidth = $state(0);
  let mapHeight = $state(0);
  // OWNER-D 4: labels sit in screen space at a fixed readable size; only the
  // ones that fit without overlapping are drawn (see atlasScreenLabels).
  let measureCtx: CanvasRenderingContext2D | null | undefined;
  function measureLabel(text: string): number {
    if (measureCtx === undefined) {
      try {
        measureCtx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
      } catch (err) {
        console.debug("[atlas] canvas text measure unavailable", err);
        measureCtx = null;
      }
      if (measureCtx) measureCtx.font = `400 ${ATLAS_LABEL_PX}px "Geist", -apple-system, sans-serif`;
    }
    const measured = measureCtx?.measureText(text).width;
    // Fallback is a generous per-character width so estimates never under-count.
    return Math.ceil(measured && measured > 0 ? measured : text.length * ATLAS_LABEL_PX * 0.62);
  }
  // QA-109: the legend, help text and zoom controls are fixed over the map, so
  // their boxes (in map screen space) are reserved like section names: no item
  // label or section name is drawn under them at any zoom.
  let legendEl = $state<HTMLElement | null>(null);
  let toolsEl = $state<HTMLElement | null>(null);
  let dockEl = $state<HTMLElement | null>(null);
  let dayEl = $state<HTMLElement | null>(null);
  let fixedBoxes = $state<AtlasScreenLabel["box"][]>([]);
  function measureFixed(): void {
    const origin = svgEl?.getBoundingClientRect();
    if (!origin) return;
    const next: AtlasScreenLabel["box"][] = [];
    for (const el of [legendEl, toolsEl, dockEl, dayEl]) {
      const r = el?.getBoundingClientRect();
      if (!r || r.width === 0 || r.height === 0) continue;
      next.push({ left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top });
    }
    fixedBoxes = next;
  }
  $effect(() => {
    void nothingActive;
    void dockEl;
    void dayEl;
    void playback?.caption;
    void mapWidth;
    void mapHeight;
    if (!legendEl || typeof ResizeObserver === "undefined") {
      measureFixed();
      return;
    }
    const observer = new ResizeObserver(() => measureFixed());
    observer.observe(legendEl);
    if (toolsEl) observer.observe(toolsEl);
    if (dockEl) observer.observe(dockEl);
    if (dayEl) observer.observe(dayEl);
    measureFixed();
    return () => observer.disconnect();
  });
  const meets = (a: AtlasScreenLabel["box"], b: AtlasScreenLabel["box"]) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const districts = $derived(atlasDistrictShapes(placed, regions));
  // A section name stays on screen while any of its section is: it slides
  // down from above the section instead of being cut off at the top edge.
  function keepOnScreen(label: AtlasScreenLabel, shape: { y: number; r: number }): AtlasScreenLabel | null {
    const width = mapWidth || 800;
    const height = mapHeight || 560;
    const bottom = (shape.y + shape.r) * view.k + view.y;
    if (bottom < 28 || label.box.top > height || label.box.right < 0 || label.box.left > width) return null;
    const half = (label.box.right - label.box.left) / 2;
    const x = Math.min(Math.max(label.x, half + 8), width - half - 8);
    const y = Math.max(label.y, 20);
    return { ...label, x, y, box: { left: x - half, top: y - 12, right: x + half, bottom: y + 4 } };
  }
  const sectionCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const n of placed) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    return counts;
  });
  const districtLabels = $derived(
    districts
      .map((d) => keepOnScreen(atlasDistrictLabel(d, view, measureLabel, sectionCounts.get(d.type)), d))
      .filter((d): d is AtlasScreenLabel => d !== null && !fixedBoxes.some((f) => meets(d.box, f))),
  );
  const focusIds = $derived(selected || hovered ? new Set([selected, hovered, ...related]) : null);
  // Actor chips are drawn in screen space, like labels, so they stay one
  // readable size at every zoom. Each stack starts just off the node rim and
  // overlaps to the right.
  const CHIP_PX = 20;
  /** Dock chips: one circle size for people, bots and the +N overflow. */
  const DOCK_CHIP_PX = 22;
  const CHIP_STEP = 15;
  const half = CHIP_PX / 2;
  const chips = $derived(
    atlasDockedChips(shown, presence).map((chip) => {
      const rimX = chip.x1 * view.k + view.x;
      const rimY = chip.y1 * view.k + view.y;
      return { ...chip, rimX, rimY, sx: rimX + 13 + chip.index * CHIP_STEP, sy: rimY - 13 };
    }),
  );

  // Live actors with no object on the map: a screen-space dock at the bottom
  // left, so nobody who is working is missing from the map. Computed from
  // presence, which changes once per live update, never per pointer move.
  const unplaced = $derived(atlasUnplacedActors(presence));
  let dockOpen = $state(false);
  const dockShown = $derived(dockOpen ? unplaced : unplaced.slice(0, ATLAS_DOCK_CAP));
  const dockMore = $derived(unplaced.length - dockShown.length);
  /** Dock chip under the pointer and its centre in map screen space. */
  let dockHover = $state<{ key: string; x: number; y: number } | null>(null);
  function hoverDock(key: string, event: Event): void {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const origin = svgEl?.getBoundingClientRect();
    dockHover = {
      key,
      x: box.left + box.width / 2 - (origin?.left ?? 0),
      y: box.top + box.height / 2 - (origin?.top ?? 0),
    };
  }

  const chipBoxes = $derived(
    chips.map((c) => ({ left: c.sx - half, top: c.sy - half, right: c.sx + half, bottom: c.sy + half })),
  );

  const labels = $derived(
    atlasScreenLabels({
      reserved: [...fixedBoxes, ...chipBoxes],
      yielding: districtLabels.map((d) => d.box),
      placed: shown,
      selected,
      hovered,
      related,
      nowMs,
      view,
      width: mapWidth || 800,
      height: mapHeight || 560,
      measure: measureLabel,
    }),
  );

  // A section name the hovered object's name had to land on steps aside
  // while the hover lasts (see atlasScreenLabels).
  const shownDistrictLabels = $derived.by(() => {
    const hoveredBox = labels.find((l) => l.rank === 0)?.box;
    return hoveredBox ? districtLabels.filter((d) => !meets(d.box, hoveredBox)) : districtLabels;
  });

  const CARD_WIDTH = 280;
  type HoverCard = {
    left: number;
    top: number;
    above: boolean;
    kind: string;
    /** Section colour for the dot beside the kind; none for a person or bot. */
    tint?: string;
    title: string;
    people: { key: string; name: string; bot: boolean; signal?: string; avatarUrl?: string }[];
    /** The hovered person or bot, drawn beside the title. */
    face?: { name: string; bot: boolean; avatarUrl?: string };
    lines: string[];
    /** Rows for a hovered object; person and bot cards use `lines`. */
    content?: AtlasHoverContent;
  };
  function cardAt(cx: number, cy: number, reach: number): Pick<HoverCard, "left" | "top" | "above"> {
    const width = mapWidth || 800;
    const height = mapHeight || 560;
    const left = Math.max(8, Math.min(cx - 18, width - CARD_WIDTH - 8));
    // Below the object by default; above when the lower half has no room.
    const above = cy + reach + 220 > height;
    return { left, top: above ? cy - reach - 10 : cy + reach + 10, above };
  }
  const card = $derived.by((): HoverCard | null => {
    if (dragging) return null;
    const away = dockHover ? unplaced.find((p) => (p.actorUid ?? p.name) === dockHover!.key) : undefined;
    if (away && dockHover) {
      return {
        ...cardAt(dockHover.x, dockHover.y, half + 2),
        kind: away.bot ? "Bot" : "Person",
        title: away.name,
        face: { name: away.name, bot: away.bot, avatarUrl: away.avatarUrl },
        people: [],
        lines: [away.unplaced ?? "", away.signal ?? ""].filter(Boolean),
      };
    }
    const chip = hoveredChip ? chips.find((c) => c.key === hoveredChip) : undefined;
    if (chip) {
      const on = byId.get(chip.nodeId);
      return {
        ...cardAt(chip.sx, chip.sy, half + 2),
        kind: chip.bot ? "Bot" : "Person",
        title: chip.name,
        face: { name: chip.name, bot: chip.bot, avatarUrl: chip.avatarUrl },
        people: [],
        // On a repo the repo line is the place; on a project it is a second line.
        lines: (on?.type === "repo"
          ? [chip.working ?? `Working in ${on.label}`, chip.signal ?? ""]
          : [on ? `Working on ${on.label}` : "", chip.working ?? "", chip.signal ?? ""]
        ).filter(Boolean),
      };
    }
    const node = hovered ? byId.get(hovered) : undefined;
    const content = hoverContent;
    if (!node || !content || content.id !== node.id) return null;
    return {
      ...cardAt(node.x * view.k + view.x, node.y * view.k + view.y, node.r * view.k + (content.rows.people ? 22 : 0)),
      kind: content.rows.kind,
      tint: ATLAS_TYPE_TINT[node.type],
      title: content.rows.title,
      people: [],
      lines: [],
      content: content.rows,
    };
  });
  // Object card rows, worked out once per hovered object (pan and pointer
  // moves only reposition the card).
  const hoverContent = $derived.by((): { id: string; rows: AtlasHoverContent } | null => {
    const node = hovered ? byId.get(hovered) : undefined;
    if (!node || dragging) return null;
    return { id: node.id, rows: atlasHoverContent(node, { byId, edges, presence, nowMs }) };
  });

  function dimmed(id: string): boolean {
    if (filterIds && !filterIds.has(id)) return true;
    return focusIds !== null && !focusIds.has(id);
  }

  export function frame(): void {
    const box = svgEl?.getBoundingClientRect();
    (onfly ?? onview)(frameAll([...placed, ...districts], box?.width ?? 800, box?.height ?? 560));
  }

  /** Fill the map with one section (click on its title). */
  function frameSection(type: string): void {
    const shape = districts.find((d) => d.type === type);
    if (!shape) return;
    const box = svgEl?.getBoundingClientRect();
    (onfly ?? onview)(frameAll([shape], box?.width ?? 800, box?.height ?? 560, 56));
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
      section:
        (event.target instanceof Element ? event.target.closest("[data-atlas-section]") : null)?.getAttribute(
          "data-atlas-section",
        ) ?? null,
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
    dragging = true;
    markHintSeen();
    onview({ ...view, x: drag.vx + dx, y: drag.vy + dy });
  }

  function endDrag(): void {
    drag = null;
    dragging = false;
    window.removeEventListener("pointermove", onpointermove);
    window.removeEventListener("pointerup", onpointerup);
    window.removeEventListener("pointercancel", onpointercancel);
  }

  function onpointerup(event: PointerEvent): void {
    if (!drag || drag.id !== event.pointerId) return;
    const moved =
      drag.moved || Math.hypot(event.clientX - drag.sx, event.clientY - drag.sy) >= DRAG_THRESHOLD;
    const node = drag.node;
    const section = drag.section;
    endDrag();
    if (moved) return;
    if (section) frameSection(section);
    else onselect(node);
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
    markHintSeen();
    onview(zoomAt(view, sx, sy, Math.exp(-event.deltaY * 0.0015)));
  }

  function zoomBy(factor: number): void {
    const box = svgEl?.getBoundingClientRect();
    (onfly ?? onview)(zoomAt(view, (box?.width ?? 800) / 2, (box?.height ?? 560) / 2, factor));
  }
</script>

<div class="atlas-map" class:calm={!motion} class:paused={pageHidden} style:--pulse-ms={`${ATLAS_PULSE_MS}ms`} data-testid="atlas-map" bind:clientWidth={mapWidth} bind:clientHeight={mapHeight}>
  <!-- Static ground: a soft vignette and fine grain under the map, so the map
       reads as one image. Under the SVG, so labels are drawn over it. -->
  <div class="ground" aria-hidden="true"></div>
  <svg
    bind:this={svgEl}
    role="application"
    aria-label="Atlas map"
    onpointerdown={onpointerdown}
    ondblclick={frame}
    onwheel={onwheel}
  >
    <defs>
      <!-- Soft glow behind active objects: a wide radial falloff, no blur filter. -->
      <radialGradient id={glowId} data-testid="atlas-glow-gradient">
        <stop class="glow-core" offset="0%" />
        <stop class="glow-mid" offset="45%" />
        <stop class="glow-edge" offset="100%" />
      </radialGradient>
      <clipPath id={clipRoundId} clipPathUnits="objectBoundingBox"><circle cx="0.5" cy="0.5" r="0.5" /></clipPath>
      <clipPath id={clipBotId} clipPathUnits="objectBoundingBox"><rect width="1" height="1" rx="0.15" /></clipPath>
    </defs>
    <g data-testid="atlas-world" class:focusing={focus !== null && focus.size > 0} transform={viewTransform(view)}>
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
      {#each trails as trail (`${trail.from}>${trail.to}`)}
        {@const a = byId.get(trail.from)}
        {@const b = byId.get(trail.to)}
        {#if a && b}
          <line class="trail" data-testid="atlas-trail" x1={a.x} y1={a.y} x2={b.x} y2={b.y} vector-effect="non-scaling-stroke" />
        {/if}
      {/each}
      {#each placed as node (node.id)}
        <g
          class="node"
          class:dim={dimmed(node.id)}
          class:selected={node.id === selected}
          class:lit={filterIds?.has(node.id) ?? false}
          class:active={timeOpacity ? !timeOpacity.has(node.id) : false}
          class:gathered={focus?.has(node.id) ?? false}
          style:transform={focus?.has(node.id) ? `translate(${focus.get(node.id)!.dx.toFixed(2)}px, ${focus.get(node.id)!.dy.toFixed(2)}px)` : null}
          style:--t={timeOpacity?.get(node.id) ?? null}
          data-testid={`atlas-node-${node.id}`}
          data-kind={node.type}
          data-atlas-node={node.id}
          style:--c={ATLAS_TYPE_TINT[node.type]}
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
          {#if timeOpacity && !timeOpacity.has(node.id)}
            <!-- Active at the scrubbed time: a soft glow lifts it off the faded rest. -->
            <circle class="glow" cx={node.x} cy={node.y} r={node.r * 4 + 6} fill={`url(#${glowId})`} />
          {/if}
          <circle class="dot" cx={node.x} cy={node.y} r={node.r} />
          {#if node.stories && node.r * view.k >= ATLAS_RING_MIN_PX}
            {@const done = atlasStoryFraction(node)}
            {#if done !== null}
              <!-- Story progress: a thin track and the done share, clockwise from the top. -->
              <g class="ring" data-testid={`atlas-ring-${node.id}`} data-done={done.toFixed(3)}>
                <circle class="ring-track" cx={node.x} cy={node.y} r={node.r + ATLAS_RING_GAP} vector-effect="non-scaling-stroke" />
                {#if done > 0}
                  <circle
                    class="ring-done"
                    cx={node.x}
                    cy={node.y}
                    r={node.r + ATLAS_RING_GAP}
                    pathLength="100"
                    stroke-dasharray={`${(done * 100).toFixed(2)} 100`}
                    transform={`rotate(-90 ${node.x} ${node.y})`}
                    vector-effect="non-scaling-stroke"
                  />
                {/if}
              </g>
            {/if}
          {/if}
        </g>
      {/each}
      {#each [...pulses] as [id, seq] (`${id}:${seq}`)}
        {@const p = byId.get(id)}
        {#if p}
          <circle class="work-pulse" data-testid={`atlas-pulse-${id}`} cx={p.x} cy={p.y} r={p.r + 4} vector-effect="non-scaling-stroke" />
        {/if}
      {/each}
    </g>
    <g class="labels" data-testid="atlas-labels">
      {#each shownDistrictLabels as label (label.id)}
        <text class="region" data-atlas-section={label.id.slice("district:".length)} data-testid={`atlas-${label.id.replace(":", "-label-")}`} x={label.x} y={label.y} text-anchor="middle">{label.text}<tspan class="count" dx="7">{sectionCounts.get(label.id.slice("district:".length)) ?? ""}</tspan></text>
      {/each}
      {#each labels as label (label.id)}
        <text
          class="label"
          class:dim={dimmed(label.id)}
          class:focus={(label.rank ?? 4) <= 2}
          class:recent={label.rank === 3}
          style:--t={(label.rank ?? 4) <= 2 ? null : (timeOpacity?.get(label.id) ?? null)}
          data-testid={`atlas-label-${label.id}`}
          x={label.x}
          y={label.y}
        >{label.text}</text>
      {/each}
    </g>
    <g class="docks" data-testid="atlas-chips">
      {#each chips as chip (chip.key)}
        {@const picture = chip.avatarUrl && !brokenPictures.has(chip.avatarUrl) ? chip.avatarUrl : null}
        <g
          class="dock"
          class:dim={filterActor ? chip.actorUid !== filterActor : dimmed(chip.nodeId)}
          class:idle={chip.idle ?? false}
          data-testid={`atlas-chip-${chip.actorUid ?? chip.name}`}
          data-node={chip.nodeId}
          data-atlas-node={chip.nodeId}
          data-kind={chip.bot ? "bot" : "human"}
          role="img"
          aria-label={`${chip.name} on ${byId.get(chip.nodeId)?.label ?? chip.nodeId}`}
          onpointerenter={() => {
            hoveredChip = chip.key;
            hovered = chip.nodeId;
          }}
          onpointerleave={() => {
            if (hoveredChip === chip.key) hoveredChip = null;
            if (hovered === chip.nodeId) hovered = null;
          }}
        >
          {#if chip.index === 0}
            <line class="connector" x1={chip.rimX} y1={chip.rimY} x2={chip.sx - half * 0.7} y2={chip.sy + half * 0.7} />
          {/if}
          {#if !chip.idle}
            <circle class="pulse" cx={chip.sx} cy={chip.sy} r={half + 3} />
          {/if}
          {#if picture}
            <image
              class="face"
              data-testid="atlas-chip-picture"
              href={picture}
              x={chip.sx - half}
              y={chip.sy - half}
              width={CHIP_PX}
              height={CHIP_PX}
              preserveAspectRatio="xMidYMid slice"
              clip-path={`url(#${chip.bot ? clipBotId : clipRoundId})`}
              onerror={() => pictureFailed(picture)}
            />
          {/if}
          {#if chip.bot}
            <rect class="mark" class:pictured={picture !== null} x={chip.sx - half} y={chip.sy - half} width={CHIP_PX} height={CHIP_PX} rx="3" />
          {:else}
            <circle class="mark" class:pictured={picture !== null} cx={chip.sx} cy={chip.sy} r={half} />
          {/if}
          {#if !picture}
            <text class="initials" x={chip.sx} y={chip.sy + 3.5} text-anchor="middle">{chip.initials}</text>
          {/if}
        </g>
      {/each}
    </g>
  </svg>
  {#if unplaced.length}
    <div class="unplaced" data-testid="atlas-unplaced" bind:this={dockEl}>
      <div class="unplaced-cap">Not on the map <span class="unplaced-count" data-testid="atlas-unplaced-count">{unplaced.length}</span></div>
      <div class="unplaced-chips">
        {#each dockShown as who (who.actorUid ?? who.name)}
          <span
            class="away"
            class:idle={who.idle ?? false}
            class:dim={filterActor ? who.actorUid !== filterActor : false}
            data-testid={`atlas-unplaced-${who.actorUid ?? who.name}`}
            data-kind={who.bot ? "bot" : "human"}
            role="img"
            tabindex="0"
            aria-label={`${who.name}, ${who.bot ? "bot" : "person"}: ${who.unplaced ?? "not on the map"}`}
            onpointerenter={(event) => hoverDock(who.actorUid ?? who.name, event)}
            onpointerleave={() => {
              if (dockHover?.key === (who.actorUid ?? who.name)) dockHover = null;
            }}
            onfocus={(event) => hoverDock(who.actorUid ?? who.name, event)}
            onblur={() => {
              if (dockHover?.key === (who.actorUid ?? who.name)) dockHover = null;
            }}
          ><AtlasFace name={who.name} bot={who.bot} avatarUrl={who.avatarUrl} size={DOCK_CHIP_PX} /></span>
        {/each}
        {#if dockMore > 0}
          <button
            type="button"
            class="away more"
            data-testid="atlas-unplaced-more"
            aria-label={`Show all ${unplaced.length}`}
            onclick={() => (dockOpen = true)}
          >+{dockMore}</button>
        {/if}
      </div>
    </div>
  {/if}
  {#if card}
    <div
      class="hover-card"
      class:above={card.above}
      data-testid="atlas-hover-card"
      style:left={`${card.left}px`}
      style:top={`${card.top}px`}
      style:width={`${CARD_WIDTH}px`}
    >
      <div class="hc-kind">{#if card.tint}<i class="hc-dot" style:background={card.tint}></i>{/if}{card.kind}</div>
      <div class="hc-title">
        {#if card.face}<span class="hc-avatar" class:bot={card.face.bot} data-testid="atlas-hover-face"><AtlasFace name={card.face.name} bot={card.face.bot} avatarUrl={card.face.avatarUrl} size={20} /></span>{/if}{card.title}
      </div>
      {#if card.content}
        {@const c = card.content}
        {#if c.people}
          <div class="hc-row" data-testid="atlas-hover-people">
            <span class="hc-label">{c.people.label}</span>
            <span class="hc-faces">
              {#each c.people.shown as who (who.key)}
                <span class="hc-face" class:bot={who.bot} title={who.name}><AtlasFace name={who.name} bot={who.bot} avatarUrl={who.avatarUrl} size={14} /></span>
              {/each}
              {#if c.people.more}<span class="hc-more">+{c.people.more}</span>{/if}
            </span>
          </div>
        {/if}
        {#if c.stories}
          <div class="hc-row hc-stories" data-testid="atlas-hover-stories">
            <span class="hc-bar" aria-hidden="true"><i style:width={`${Math.round(c.stories.fraction * 100)}%`}></i></span>
            <span class="hc-text">{c.stories.text}</span>
          </div>
        {/if}
        {#each c.links as link (link.label)}
          <div class="hc-row" data-testid="atlas-hover-links">
            <span class="hc-label">{link.label}</span><span class="hc-text">{link.text}</span>
          </div>
        {/each}
        {#if c.counts}<div class="hc-row hc-text" data-testid="atlas-hover-counts">{c.counts}</div>{/if}
        {#if c.folder}<div class="hc-row hc-text" data-testid="atlas-hover-folder">{c.folder}</div>{/if}
        {#if c.activity}<div class="hc-row hc-text" data-testid="atlas-hover-activity">{c.activity}</div>{/if}
        {#if c.hint}<div class="hc-hint">{c.hint}</div>{/if}
      {:else if card.people.length}
        <div class="hc-people">
          {#each card.people as who (who.key)}
            <div class="hc-who">
              <span class="hc-face" class:bot={who.bot}><AtlasFace name={who.name} bot={who.bot} avatarUrl={who.avatarUrl} size={14} /></span>
              <span class="hc-name">{who.name}</span>
              {#if who.signal}<span class="hc-signal">{who.signal}</span>{/if}
            </div>
          {/each}
        </div>
      {/if}
      {#each card.lines as line (line)}
        <div class="hc-line">{line}</div>
      {/each}
    </div>
  {/if}
  {#if playback}
    <!-- The scrubbed day on the map; while playing, that day's biggest changes. -->
    <div class="day" data-testid="atlas-playback" bind:this={dayEl} aria-live="polite">
      <div class="day-date" data-testid="atlas-playback-date">{playback.date}</div>
      {#if playback.caption}<div class="day-caption" data-testid="atlas-playback-caption">{playback.caption}</div>{/if}
    </div>
  {/if}
  <div class="legend" bind:this={legendEl}>
    <span><i class="ldot"></i>live</span>
    <span><i class="halo-key"></i>someone here now</span>
    {#if nothingActive}<span data-testid="atlas-nothing-active">Nothing active right now</span>{/if}
    {#if !hintSeen}<span class="hint">Drag to pan · Scroll to zoom · Press 0 to frame all</span>{/if}
  </div>
  <div class="map-tools" bind:this={toolsEl}>
    <button type="button" class="zoom-btn" aria-label="Zoom out" onclick={() => zoomBy(1 / 1.25)}>−</button>
    <button type="button" class="zoom-btn" aria-label="Zoom in" onclick={() => zoomBy(1.25)}>+</button>
  </div>
</div>

<style>
  .atlas-map {
    position: relative;
    overflow: hidden;
    min-height: 0;
    height: 100%;
    isolation: isolate;
  }
  /* Static depth: a vignette that darkens the far edges a little, and a fine
     grain at very low strength. Nothing here animates. */
  .ground {
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background: radial-gradient(ellipse 75% 70% at 50% 46%, transparent 55%, rgb(0 0 0 / 0.1) 100%);
  }
  /* Grain: a tiled noise image at 5% strength, the same in both themes. */
  .ground::after {
    content: "";
    position: absolute;
    inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 0 0.5 0 0 0 1 0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");
    background-size: 160px 160px;
    opacity: 0.05;
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
    /* Owner, 2026-10-04: section titles are the quietest text on the map:
       small, uppercase, muted. Item names carry the hierarchy. */
    font-family: var(--font-ui, var(--font-sans, "Geist", sans-serif));
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    fill: var(--v4-text-3);
    fill-opacity: 0.7;
    cursor: pointer;
    transition: fill-opacity 120ms ease;
  }
  .region:hover {
    fill-opacity: 1;
  }
  .region .count {
    letter-spacing: 0;
    fill-opacity: 0.6;
    font-variant-numeric: tabular-nums;
  }
  .edge {
    stroke: var(--v4-text-2, var(--v4-text-3));
    stroke-opacity: 0.45;
    stroke-width: 1;
  }
  /* --t is the scrubber's per-object opacity; playback animates opacity only. */
  .node {
    cursor: pointer;
    outline: none;
    opacity: var(--t, 1);
    /* Focus mode moves dots by transform only, out and back. */
    transition:
      opacity 160ms ease,
      transform 480ms cubic-bezier(0.23, 1, 0.32, 1);
  }
  /* Focus mode: the gathered set stays bright, everything else steps further back. */
  .focusing .node.dim {
    opacity: calc(var(--t, 1) * 0.28);
  }
  .node.gathered {
    opacity: 1;
  }
  .calm .node {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .node {
      transition: none;
    }
  }
  /* Type colour, pulled toward the ink so it reads in light and dark. */
  .dot {
    fill: color-mix(in srgb, var(--c) 80%, var(--v4-text-1));
    transition: fill 120ms ease;
  }
  /* Story ring: monochrome, 1.25px on screen, quiet until hovered or selected. */
  .ring circle {
    fill: none;
    stroke: var(--v4-text-1);
    stroke-width: 1.25px;
    pointer-events: none;
  }
  .ring-track {
    stroke-opacity: 0.12;
  }
  .ring-done {
    stroke-opacity: 0.45;
  }
  .node:hover .ring-done,
  .node.selected .ring-done {
    stroke-opacity: 0.8;
  }
  .glow {
    pointer-events: none;
  }
  .glow-core {
    stop-color: var(--v4-text-1);
    stop-opacity: 0.16;
  }
  .glow-mid {
    stop-color: var(--v4-text-1);
    stop-opacity: 0.06;
  }
  .glow-edge {
    stop-color: var(--v4-text-1);
    stop-opacity: 0;
  }
  /* Active now: lifted toward white so it reads from a framed-out map. */
  .node.active .dot {
    fill: color-mix(in srgb, var(--c) 62%, white);
  }
  .node.active .glow {
    opacity: 1;
  }
  .node:hover .dot,
  .node.selected .dot {
    fill: var(--v4-text-1);
  }
  /* Out of focus: stepped back, but the map stays readable behind the focus set. */
  .node.dim {
    opacity: calc(var(--t, 1) * 0.55);
  }
  /* Picked out by the people filter: full strength whatever its age. */
  .node.lit {
    opacity: 1;
  }
  .node:hover {
    opacity: 1;
  }
  .node:hover .dot {
    stroke: var(--v4-text-1);
    stroke-opacity: 0.35;
    stroke-width: 4px;
    vector-effect: non-scaling-stroke;
    paint-order: stroke;
  }
  .label.dim {
    opacity: 0.4;
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
  /* Work happened: one ring that expands and fades, then is removed. */
  .work-pulse {
    fill: none;
    stroke: var(--v4-text-1);
    stroke-width: 1.25;
    opacity: 0;
    pointer-events: none;
    transform-box: fill-box;
    transform-origin: center;
    animation: atlas-work-pulse var(--pulse-ms, 1200ms) cubic-bezier(0.23, 1, 0.32, 1) 1 forwards;
  }
  @keyframes atlas-work-pulse {
    0% {
      opacity: 0.55;
      transform: scale(1);
    }
    100% {
      opacity: 0;
      transform: scale(2.4);
    }
  }
  /* Active now: thin, faint lines to what the project just touched, drifting slowly. */
  .trail {
    stroke: var(--v4-text-1);
    stroke-opacity: 0.22;
    stroke-width: 1;
    stroke-dasharray: 2 5;
    pointer-events: none;
    animation: atlas-trail-drift 4s linear infinite;
  }
  @keyframes atlas-trail-drift {
    to {
      stroke-dashoffset: -14;
    }
  }
  .paused .trail,
  .paused .work-pulse,
  .paused .halo,
  .paused .pulse {
    animation-play-state: paused;
  }
  .calm .trail {
    animation: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .trail,
    .work-pulse {
      animation: none;
    }
  }
  .dock {
    cursor: pointer;
  }
  .dock.dim {
    opacity: 0.35;
  }
  /* Working: a slow ring around the marker. Only online: grey, no ring. */
  .pulse {
    fill: none;
    stroke: var(--v4-ok);
    stroke-width: 1;
    opacity: 0;
    transform-box: fill-box;
    transform-origin: center;
    animation: atlas-chip-pulse 2.4s ease-out infinite;
    pointer-events: none;
  }
  @keyframes atlas-chip-pulse {
    0% {
      opacity: 0.6;
      transform: scale(0.85);
    }
    100% {
      opacity: 0;
      transform: scale(1.35);
    }
  }
  .dock.idle .mark,
  .dock.idle .connector {
    stroke: var(--v4-text-3);
  }
  /* With a picture the mark is only the ring drawn over it. */
  .mark.pictured {
    fill: none;
  }
  .face {
    pointer-events: none;
  }
  .dock.idle .face {
    opacity: 0.7;
  }
  .dock.idle .initials {
    fill: var(--v4-text-3);
  }
  .connector {
    stroke: var(--v4-ok);
    stroke-width: 1;
    stroke-opacity: 0.55;
  }
  .mark {
    fill: var(--v4-ground);
    fill: rgb(from var(--v4-ground) r g b);
    stroke: var(--v4-ok);
    stroke-width: 1.5;
  }
  .initials {
    font-family: var(--font-sans, "Geist", sans-serif);
    font-size: 9px;
    font-weight: 500;
    fill: var(--v4-text-1);
    pointer-events: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .halo,
    .pulse {
      animation: none;
    }
  }
  .label {
    font-family: var(--font-sans, "Geist", sans-serif);
    font-size: 13px;
    /* Three tones: everything else, recently touched, and the focus set
       (hovered, selected and their relations). */
    fill: var(--v4-text-1);
    /* An item's name follows its dot: older items carry a quieter name. */
    fill-opacity: calc(0.38 + 0.34 * var(--t, 1));
    pointer-events: none;
    transition: fill-opacity 160ms ease;
  }
  .label.recent {
    fill-opacity: 0.85;
  }
  .label.focus {
    fill-opacity: 1;
    font-weight: 500;
  }
  .hover-card {
    position: absolute;
    z-index: 2;
    box-sizing: border-box;
    padding: 10px 12px;
    border: 1px solid var(--v4-control-border);
    /* Opaque: the control tint over the map's own ground, so nothing on the
       map reads through the card. */
    background: var(--v4-ground);
    background:
      linear-gradient(var(--v4-control-bg), var(--v4-control-bg)),
      rgb(from var(--v4-ground) r g b);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
    font-size: 13px;
    line-height: 1.4;
    color: var(--v4-text-1);
    pointer-events: none;
    transform-origin: top left;
    transition:
      opacity 140ms ease,
      transform 140ms cubic-bezier(0.23, 1, 0.32, 1);
    @starting-style {
      opacity: 0;
      transform: scale(0.97);
    }
  }
  .hover-card.above {
    translate: 0 -100%;
    transform-origin: bottom left;
  }
  .hc-kind {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--v4-text-3);
  }
  .hc-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
  }
  .hc-title {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Object rows: spacing only, one line each, long text cut with an ellipsis. */
  .hc-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    margin-top: 6px;
  }
  .hc-label {
    flex: none;
    color: var(--v4-text-3);
  }
  .hc-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--v4-text-2, var(--v4-text-3));
  }
  .hc-faces {
    display: flex;
    align-items: center;
    gap: 3px;
    min-width: 0;
  }
  .hc-more {
    color: var(--v4-text-3);
    margin-left: 2px;
  }
  .hc-bar {
    flex: 0 0 72px;
    height: 3px;
    background: var(--v4-rowline);
  }
  .hc-bar i {
    display: block;
    height: 100%;
    background: var(--v4-text-2, var(--v4-text-1));
  }
  .hc-hint {
    margin-top: 8px;
    font-size: 11px;
    color: var(--v4-text-3);
  }
  .hc-people {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--v4-rowline);
    display: grid;
    gap: 4px;
  }
  .hc-who {
    display: grid;
    grid-template-columns: 14px auto 1fr;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  /* A live person or bot: their picture (or initials) in a green ring. */
  .hc-face,
  .hc-avatar {
    box-sizing: border-box;
    display: inline-grid;
    place-items: center;
    overflow: hidden;
    border-radius: 50%;
    border: 1px solid var(--v4-ok);
    font-size: 7px;
    font-weight: 500;
    line-height: 1;
    color: var(--v4-text-2, var(--v4-text-1));
  }
  .hc-face {
    width: 14px;
    height: 14px;
    align-self: center;
  }
  .hc-avatar {
    width: 20px;
    height: 20px;
    margin-right: 6px;
    vertical-align: -5px;
    font-size: 8px;
  }
  .hc-face.bot,
  .hc-avatar.bot {
    border-radius: 3px;
  }
  .hc-signal {
    color: var(--v4-text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hc-line {
    margin-top: 6px;
    color: var(--v4-text-2, var(--v4-text-3));
  }
  .hc-line + .hc-line {
    margin-top: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .hover-card {
      transition: none;
    }
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
    /* QA-109: an opaque backplate in the map's ground colour, so nothing drawn
       on the map ever reads through the fixed legend and help text. */
    padding: 4px 8px;
    border-radius: var(--v4-radius-button, 6px);
    background: var(--v4-ground);
    background: rgb(from var(--v4-ground) r g b);
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .legend .hint {
    opacity: 0.55;
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
  /* Not on the map: screen space, above the legend; does not pan or zoom. */
  .unplaced {
    position: absolute;
    left: 14px;
    bottom: 44px;
    max-width: min(360px, calc(100% - 28px));
    padding: 6px 8px;
    border-radius: var(--v4-radius-button, 6px);
    background: var(--v4-ground);
    background: rgb(from var(--v4-ground) r g b);
  }
  /* Sentence-case header like the inspector's sections; the count is a quiet number. */
  .unplaced-cap {
    font-size: 13px;
    font-weight: 500;
    color: var(--v4-text-2, var(--v4-text-3));
    margin-bottom: 6px;
  }
  .unplaced-count {
    margin-left: 4px;
    font-weight: 400;
    color: var(--v4-text-3);
    font-variant-numeric: tabular-nums;
  }
  .unplaced-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    /* Room for the presence ring, which sits outside the chip. */
    padding: 3px;
  }
  /* One shape for everyone: people, bots and the overflow are the same circle
     with one hairline. Bot mascots are clipped to the circle, not boxed. A
     share-the-avatar swap: the shared Avatar component can replace the inner
     AtlasFace without touching this frame. */
  .away {
    box-sizing: border-box;
    width: 22px;
    height: 22px;
    flex: none;
    display: inline-grid;
    place-items: center;
    border-radius: 50%;
    border: 1px solid var(--v4-control-border);
    background: var(--v4-control-faint, var(--v4-ground));
    color: var(--v4-text-2);
    font-family: var(--font-sans, "Geist", sans-serif);
    font-size: 9px;
    font-weight: 500;
    line-height: 1;
    padding: 0;
    overflow: hidden;
    cursor: default;
    outline: none;
  }
  /* Live presence only: a thin 2px ring with a 1px gap on the dock surface,
     the same treatment as the Projects live indicator. */
  .away:not(.idle):not(.more) {
    box-shadow: 0 0 0 1px var(--v4-ground), 0 0 0 3px var(--v4-ok);
  }
  .away.dim {
    opacity: 0.35;
  }
  .away.more {
    color: var(--v4-text-3);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    cursor: pointer;
  }
  .away.more:hover {
    color: var(--v4-text-1);
  }
  .away:focus-visible {
    box-shadow: 0 0 0 1px var(--v4-ground), 0 0 0 3px var(--v4-focus-ring, var(--v4-control-border));
  }
  /* Playback date: the canvas title size, quiet; the caption is body size. */
  .day {
    position: absolute;
    left: 16px;
    top: 12px;
    max-width: min(420px, calc(100% - 120px));
    pointer-events: none;
    padding: 2px 8px 4px;
    background: var(--v4-ground);
    background: rgb(from var(--v4-ground) r g b);
  }
  .day-date {
    font-size: var(--type-title, 20px);
    font-weight: 400;
    line-height: 1.25;
    color: var(--v4-text-3);
    font-variant-numeric: tabular-nums;
  }
  .day-caption {
    margin-top: 2px;
    font-size: 13px;
    color: var(--v4-text-2, var(--v4-text-3));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .map-tools {
    position: absolute;
    right: 12px;
    top: 12px;
    display: flex;
    gap: 4px;
  }
  .zoom-btn {
    width: var(--hq-btn-h);
    height: var(--hq-btn-h);
    display: inline-grid;
    place-items: center;
    padding: 0;
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-metadata);
    cursor: pointer;
  }
  .zoom-btn:hover {
    background: var(--v4-hover, var(--v4-control-faint));
  }
</style>
