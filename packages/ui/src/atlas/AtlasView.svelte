<script lang="ts">
  /**
   * Company Atlas view (US-012): toolbar, ring map, inspector. Paints the
   * cached graph for the company in the first frame, then refreshes from the
   * Console atlas endpoint in the background. Loaded only via dynamic import.
   */
  import { onMount, untrack } from "svelte";
  import AtlasMap from "./AtlasMap.svelte";
  import AtlasInspector from "./AtlasInspector.svelte";
  import type { AtlasCache } from "./atlas-cache.js";
  import {
    atlasActorNodeIds,
    atlasDistinctActors,
    atlasPresenceFromActors,
    type AtlasLiveActorInput,
  } from "./atlas-presence.js";
  import {
    atlasEdges,
    atlasRelatedIds,
    frameAll,
    layoutAtlas,
    type AtlasView as AtlasViewBox,
  } from "./atlas-layout.js";
  import type {
    AtlasDetail,
    AtlasGraph,
    AtlasNode,
    AtlasPresence,
  } from "./atlas-model.js";

  interface Props {
    companyUid: string;
    companyName?: string;
    cache: AtlasCache;
    presence?: AtlasPresence[];
    /** Live actors from the shell's presence stores (US-013); mapped onto nodes here. */
    actors?: readonly AtlasLiveActorInput[];
    /** People filter from the sidepane roster: actor uid, or null for everyone. */
    filterActor?: string | null;
    onclearfilter?: () => void;
    /** Working now rows for people with no object on the map. */
    onopenperson?: (actorUid: string) => void;
    loadDetail?: (node: AtlasNode) => Promise<AtlasDetail | undefined>;
    nowMs?: number;
    onopenfiles?: (node: AtlasNode) => void;
    onopenboard?: (node: AtlasNode) => void;
    onmessage?: (who: AtlasPresence) => void;
  }

  let {
    companyUid,
    companyName,
    cache,
    presence: presenceProp = [],
    actors,
    filterActor = null,
    onclearfilter,
    onopenperson,
    loadDetail,
    nowMs = Date.now(),
    onopenfiles,
    onopenboard,
    onmessage,
  }: Props = $props();

  let graph = $state<AtlasGraph | null>(untrack(() => cache.cached(companyUid)));
  let refreshError = $state(false);
  let selected = $state<string | null>(null);
  let view = $state<AtlasViewBox>({ x: 400, y: 280, k: 0.5 });
  let framedFor = "";
  let size = { width: 800, height: 560 };
  let mapHost = $state<HTMLDivElement | null>(null);
  let detail = $state<AtlasDetail | undefined>(undefined);
  let detailLoading = $state(false);
  const details = new Map<string, AtlasDetail | undefined>();

  const layout = $derived(layoutAtlas(graph?.nodes ?? []));
  const edges = $derived(atlasEdges(graph?.edges, graph?.nodes ?? []));
  const byId = $derived(new Map((graph?.nodes ?? []).map((n) => [n.id, n])));
  const selectedNode = $derived(selected ? (byId.get(selected) ?? null) : null);
  const related = $derived(
    [...atlasRelatedIds(selected, edges)]
      .map((id) => byId.get(id))
      .filter((n): n is AtlasNode => Boolean(n)),
  );
  const presence = $derived(
    actors ? atlasPresenceFromActors(actors, graph?.nodes ?? []) : presenceProp,
  );
  const working = $derived(atlasDistinctActors(presence));
  const live = $derived(new Set(presence.map((p) => p.nodeId)));
  const filterIds = $derived(atlasActorNodeIds(presence, filterActor));
  const filterName = $derived(
    filterActor ? (presence.find((p) => p.actorUid === filterActor)?.name ?? null) : null,
  );
  const projectsInProgress = $derived(
    (graph?.nodes ?? []).filter(
      (n) => n.type === "project" && n.stories && n.stories.done < n.stories.total,
    ).length,
  );

  function measure(): void {
    const box = mapHost?.getBoundingClientRect();
    if (box && box.width > 0 && box.height > 0) size = { width: box.width, height: box.height };
  }

  function frame(): void {
    measure();
    view = frameAll(layout.placed, size.width, size.height);
  }

  // Company switch: show that company's cache immediately, refresh behind it.
  $effect(() => {
    const uid = companyUid;
    untrack(() => {
      graph = cache.cached(uid);
      selected = null;
      refreshError = false;
      cache
        .refresh(uid)
        .then((fresh) => {
          if (fresh && uid === companyUid) graph = fresh;
        })
        .catch((err) => {
          console.warn("[atlas] refresh failed", err);
          if (uid === companyUid) refreshError = true;
        });
    });
  });

  // Frame once per company when nodes first arrive.
  $effect(() => {
    const key = `${companyUid}:${layout.placed.length}`;
    if (!layout.placed.length || framedFor.startsWith(`${companyUid}:`)) return;
    framedFor = key;
    untrack(frame);
  });

  $effect(() => {
    const node = selectedNode;
    untrack(() => {
      if (!node || !loadDetail) {
        detail = undefined;
        detailLoading = false;
        return;
      }
      if (details.has(node.id)) {
        detail = details.get(node.id);
        detailLoading = false;
        return;
      }
      detail = undefined;
      detailLoading = true;
      loadDetail(node)
        .then((d) => {
          details.set(node.id, d);
          if (selected === node.id) detail = d;
        })
        .catch((err) => console.warn("[atlas] detail failed", err))
        .finally(() => {
          if (selected === node.id) detailLoading = false;
        });
    });
  });

  function selectId(id: string): void {
    if (id.startsWith("person:")) onopenperson?.(id.slice("person:".length));
    else selected = id;
  }

  function onkeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.key === "Escape" && selected) {
      selected = null;
      event.preventDefault();
    } else if (event.key === "0" && !event.metaKey && !event.ctrlKey) {
      frame();
      event.preventDefault();
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onkeydown);
    return () => window.removeEventListener("keydown", onkeydown);
  });
</script>

<section class="atlas-view" data-testid="atlas-view" data-company={companyUid}>
  <div class="toolbar">
    <h1>Atlas</h1>
    {#if working.length}
      <span class="chip live"><i class="ldot"></i>{working.length} live</span>
    {/if}
    {#if graph}
      <span class="chip" data-testid="atlas-object-count">{graph.nodes.length} objects</span>
    {/if}
    {#if refreshError}
      <span class="chip" title="Showing the last saved map">offline copy</span>
    {/if}
    {#if filterActor}
      <span class="chip" data-testid="atlas-filter-chip">
        {filterName ?? "Person"} · {filterIds?.size ?? 0} live here
        <button type="button" class="clear" aria-label="Clear people filter" onclick={() => onclearfilter?.()}>✕</button>
      </span>
    {/if}
    <div class="grow"></div>
    <button type="button" class="btn" data-testid="atlas-frame-all" onclick={frame}>Frame all</button>
  </div>
  <div class="atlas">
    <div class="map-cell" bind:this={mapHost}>
      {#if graph}
        <AtlasMap
          placed={layout.placed}
          regions={layout.regions}
          {edges}
          {selected}
          {live}
          {presence}
          {filterIds}
          {filterActor}
          {nowMs}
          {view}
          onselect={(id) => (selected = id)}
          onview={(next) => (view = next)}
        />
      {:else}
        <div class="skeleton" data-testid="atlas-skeleton" aria-busy="true" aria-label="Loading Atlas">
          {#each [0, 1, 2, 3, 4, 5] as i (i)}
            <span class="blob" style={`--a:${i * 60 - 90}deg`}></span>
          {/each}
        </div>
      {/if}
    </div>
    <AtlasInspector
      node={selectedNode}
      {detail}
      {detailLoading}
      {related}
      presence={selectedNode ? presence : working}
      company={companyName ?? graph?.company ?? ""}
      objectCount={graph?.nodes.length ?? 0}
      {projectsInProgress}
      {nowMs}
      onselect={selectId}
      {onopenfiles}
      {onopenboard}
      {onmessage}
    />
  </div>
</section>

<style>
  .atlas-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--v4-ground);
    color: var(--v4-text-1);
    font-family: var(--font-sans, "Geist", sans-serif);
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 44px;
    padding: 0 var(--v4-space-4);
    border-bottom: 1px solid var(--v4-rowline);
    flex: none;
  }
  h1 {
    font-size: var(--type-section);
    font-weight: 600;
    margin: 0;
  }
  .grow {
    flex: 1;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 7px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-bg);
    color: var(--v4-text-2);
    font-size: 11px;
  }
  .clear {
    margin-left: 2px;
    padding: 0 2px;
    border: 0;
    background: none;
    color: var(--v4-text-3);
    font: inherit;
    cursor: pointer;
  }
  .ldot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-ok);
  }
  .btn {
    padding: 4px 10px;
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-metadata);
    cursor: pointer;
  }
  .atlas {
    display: grid;
    grid-template-columns: 1fr 340px;
    flex: 1;
    min-height: 0;
  }
  .map-cell {
    position: relative;
    min-width: 0;
    min-height: 0;
  }
  .skeleton {
    position: absolute;
    inset: 0;
  }
  .blob {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 72px;
    height: 72px;
    margin: -36px;
    border-radius: 50%;
    background: var(--v4-control-faint);
    transform: rotate(var(--a)) translateX(170px);
    animation: atlas-pulse 1.2s ease-in-out infinite;
  }
  @keyframes atlas-pulse {
    50% {
      opacity: 0.5;
    }
  }
</style>
