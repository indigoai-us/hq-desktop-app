<script lang="ts">
  import ReadLoader from "../common/ReadLoader.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  import "../common/button/rail-type.css";
  /**
   * Company Atlas view (US-012): toolbar, ring map, inspector. Paints the
   * cached graph for the company in the first frame, then refreshes from the
   * Console atlas endpoint in the background. Loaded only via dynamic import.
   */
  import { atlasPeopleFromTelemetry, atlasPersonNodeIds, isForbidden, type AtlasPeopleState } from "./atlas-people.js";
  import { onMount, untrack } from "svelte";
  import AtlasMap from "./AtlasMap.svelte";
  import AtlasInspector from "./AtlasInspector.svelte";
  import AtlasScrubber from "./AtlasScrubber.svelte";
  import {
    atlasDailyCounts,
    atlasTimeOpacity,
    type AtlasTimeMode,
  } from "./atlas-timeline.js";
  import { reasonForError, type AtlasCache, type AtlasFailReason } from "./atlas-cache.js";
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
    atlasDistrictShapes,
    layoutAtlas,
    type AtlasView as AtlasViewBox,
  } from "./atlas-layout.js";
  import { ATLAS_RING_ORDER, districtLabel } from "./atlas-model.js";
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
    /** Empty company prompts (US-014): company page row id (projects, team, integrations). */
    onopenpage?: (rowId: string) => void;
    /**
     * In-progress count from the Projects board (QA-065). When set it wins
     * over the graph's story rollup, which the local map does not fill.
     */
    projectsInProgress?: number | null;
    /**
     * OWNER-R4: the web Atlas people read (company telemetry, last 30 days),
     * resolving to the raw body. Runs only after the map has painted.
     */
    loadPeople?: (() => Promise<unknown>) | null;
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
    onopenpage,
    projectsInProgress: boardInProgress = null,
    loadPeople = null,
  }: Props = $props();

  let people = $state<AtlasPeopleState>({ status: "idle" });
  let peopleNonce = $state(0);
  let personFilter = $state<string | null>(null);
  let peopleFor = "";

  let graph = $state<AtlasGraph | null>(untrack(() => cache.cached(companyUid)));
  let refreshError = $state<AtlasFailReason | null>(null);
  // True while a partial (first page) map is on screen and the full load runs.
  let partial = $state(false);
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
  const actorFilterIds = $derived(atlasActorNodeIds(presence, filterActor));
  const selectedPerson = $derived(
    personFilter && people.status === "ok" ? (people.people.find((p) => p.id === personFilter) ?? null) : null,
  );
  // A person picked in the People list lights up the skills they ran.
  const personIds = $derived(selectedPerson ? atlasPersonNodeIds(selectedPerson, graph?.nodes ?? []) : null);
  // With none of their skills on the map, nothing is dimmed; the list says so.
  const filterIds = $derived(personIds && personIds.size > 0 ? personIds : actorFilterIds);

  // OWNER-R4: the people read starts once the map is on screen, so the map
  // never waits for telemetry (3-4 s on large companies).
  $effect(() => {
    const read = loadPeople;
    const uid = companyUid;
    const painted = graph !== null;
    void peopleNonce;
    if (!read || !painted) return;
    const key = `${uid}:${peopleNonce}`;
    if (peopleFor === key) return;
    peopleFor = key;
    people = { status: "loading" };
    personFilter = null;
    const alive = () => companyUid === uid;
    requestAnimationFrame(() => {
      read()
        .then((body) => {
          if (alive()) people = { status: "ok", people: atlasPeopleFromTelemetry(body) };
        })
        .catch((err: unknown) => {
          console.error("atlas people read failed:", err);
          if (alive()) people = { status: "failed", forbidden: isForbidden(err) };
        });
    });
  });
  const filterName = $derived(
    filterActor ? (presence.find((p) => p.actorUid === filterActor)?.name ?? null) : null,
  );
  // Time scrubber (US-014). Null index is the live edge: only active objects stay bright.
  let timeMode = $state<AtlasTimeMode>("touched");
  let scrubIndex = $state<number | null>(null);
  const dailyCounts = $derived(atlasDailyCounts(graph?.nodes ?? [], timeMode, nowMs));
  const timeOpacity = $derived(atlasTimeOpacity(graph?.nodes ?? [], timeMode, scrubIndex, nowMs, live));
  const nothingActive = $derived(
    scrubIndex == null && (graph?.nodes ?? []).every((n) => timeOpacity.has(n.id)),
  );
  const empty = $derived(graph !== null && graph.nodes.length === 0);
  const emptyLabels = ATLAS_RING_ORDER.map((type, i) => {
    const a = -Math.PI / 2 + (i / ATLAS_RING_ORDER.length) * Math.PI * 2;
    return { type, label: districtLabel(type), x: 450 + Math.cos(a) * 290, y: 320 + Math.sin(a) * 250 };
  });
  const companyTitle = $derived(companyName ?? graph?.company ?? "This company");

  const projectsInProgress = $derived(
    boardInProgress ?? (graph?.nodes ?? []).filter(
      (n) => n.type === "project" && n.stories && n.stories.done < n.stories.total,
    ).length,
  );

  function measure(): void {
    const box = mapHost?.getBoundingClientRect();
    if (box && box.width > 0 && box.height > 0) size = { width: box.width, height: box.height };
  }

  function frame(): void {
    measure();
    // OWNER-R4: frame the shaded sections, not just the dots, so no section is cut off.
    view = frameAll([...layout.placed, ...atlasDistrictShapes(layout.placed, layout.regions)], size.width, size.height);
  }

  // Company switch: show that company's cache immediately, refresh behind it.
  $effect(() => {
    const uid = companyUid;
    untrack(() => {
      graph = cache.cached(uid);
      selected = null;
      scrubIndex = null;
      loadGraph(uid);
    });
  });

  // BLANK-3: no timer ends a pending refresh. While it runs the skeleton keeps
  // the shared loader (waiting lines, then Try again); a real failure replaces
  // it with the failed state. Without a cached map a failure must never leave
  // the skeleton up.
  let retrying = $state(false);
  const loadFailed = $derived(refreshError !== null && !graph);

  // Plain-language reason for the failed state; raw transport text stays in the log.
  const FAIL_COPY: Record<AtlasFailReason, string> = {
    "signed-out": "Your HQ sign-in has expired. Sign in again from the menu bar app, then try again.",
    "no-access": "You don't have access to this company's files yet. Ask an admin to add you, then try again.",
    timeout: "The company map took too long to load. Try again in a moment.",
    offline: "We couldn't reach HQ. Check your connection, then try again.",
    unavailable: "We couldn't load your company map just now. Try again in a moment.",
  };

  function loadGraph(uid: string): void {
    refreshError = null;
    partial = false;
    cache
      .refresh(uid, (first) => {
        // A partial map only replaces the skeleton, never a saved full map.
        if (uid !== companyUid || graph) return;
        graph = first;
        partial = true;
      })
      .then((fresh) => {
        if (uid !== companyUid) return;
        partial = false;
        if (fresh) graph = fresh;
        else if (!graph) refreshError = "unavailable";
      })
      .catch((err) => {
        console.warn("[atlas] refresh failed", err);
        if (uid === companyUid) refreshError = reasonForError(err);
      })
      .finally(() => {
        if (uid === companyUid) retrying = false;
      });
  }

  function retry(): void {
    retrying = true;
    loadGraph(companyUid);
  }

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
      <span class="meta-line live" data-meta-line><i class="meta-dot ldot"></i>{working.length} live</span>
    {/if}
    {#if graph}
      <span class="meta-line" data-meta-line data-testid="atlas-object-count">{graph.nodes.length} objects</span>
    {/if}
    {#if partial && !refreshError}
      <span class="meta-line" data-meta-line data-testid="atlas-loading-more" aria-live="polite">loading more</span>
    {/if}
    {#if refreshError && graph}
      <span class="meta-line" data-meta-line title={partial ? "Only part of the map loaded" : "Showing the last saved map"}>{partial ? "partial map" : "offline copy"}</span>
    {/if}
    {#if filterActor}
      <span class="chip" data-testid="atlas-filter-chip">
        {filterName ?? "Person"} · {filterIds?.size ?? 0} live here
        <button type="button" class="clear" aria-label="Clear people filter" onclick={() => onclearfilter?.()}>✕</button>
      </span>
    {/if}
    <div class="grow"></div>
    <RailButton icon="eye"
      data-testid="atlas-frame-all"
      disabled={!graph || empty}
      onclick={frame}
    >Frame all</RailButton>
  </div>
  <div class="atlas">
    <div class="map-col">
    <div class="map-cell" bind:this={mapHost}>
      {#if empty}
        <div class="empty" data-testid="atlas-empty">
          <svg viewBox="0 0 900 640" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
            <circle class="ring" data-testid="atlas-empty-ring" cx="450" cy="320" r="250" />
            {#each emptyLabels as region (region.type)}
              <text class="region" data-testid="atlas-empty-kind" x={region.x} y={region.y} text-anchor="middle">{region.label}</text>
            {/each}
          </svg>
          <div class="empty-center">
            <div class="empty-ctr"><b>{companyTitle} is empty</b>The map fills in as the vault does. Start with one of these.</div>
            <div class="empty-prompts">
              <button type="button" class="empty-p" data-testid="atlas-empty-project" onclick={() => onopenpage?.("projects")}>
                <span class="pk">Projects</span><span class="pt">Add a project</span>
                <span class="ps">A folder with a PRD. Shows at the top of the ring and on the board.</span>
              </button>
              <button type="button" class="empty-p" data-testid="atlas-empty-invite" onclick={() => onopenpage?.("team")}>
                <span class="pk">People</span><span class="pt">Invite</span>
                <span class="ps">Teammates appear in the roster on the left and on the map when they work.</span>
              </button>
              <button type="button" class="empty-p" data-testid="atlas-empty-connect" onclick={() => onopenpage?.("integrations")}>
                <span class="pk">Integrations</span><span class="pt">Connect app</span>
                <span class="ps">Slack, GitHub, Google. Connected apps feed knowledge and signals into the vault.</span>
              </button>
            </div>
          </div>
          <div class="legend"><span><i class="idot"></i>nothing live yet</span></div>
        </div>
      {:else if graph}
        <AtlasMap
          placed={layout.placed}
          regions={layout.regions}
          {edges}
          {selected}
          {live}
          {presence}
          {filterIds}
          {filterActor}
          {timeOpacity}
          {nothingActive}
          {nowMs}
          {view}
          onselect={(id) => (selected = id)}
          onview={(next) => (view = next)}
        />
      {:else if loadFailed}
        <div class="empty" data-testid="atlas-error" role="alert">
          <div class="empty-center">
            <div class="empty-ctr" data-reason={refreshError}><b>The map didn't load</b>{FAIL_COPY[refreshError ?? "unavailable"]}</div>
            <RailButton icon="refresh" data-testid="atlas-retry" disabled={retrying} onclick={retry}>{retrying ? "Trying again" : "Retry"}</RailButton>
          </div>
        </div>
      {:else}
        <div class="skeleton" data-testid="atlas-skeleton" aria-busy="true" aria-label="Loading Atlas">
          {#each [0, 1, 2, 3, 4, 5] as i (i)}
            <span class="blob" style={`--a:${i * 60 - 90}deg`}></span>
          {/each}
          <ReadLoader testid="atlas-loader" surface="atlas" onretry={retry} />
        </div>
      {/if}
    </div>
    <AtlasScrubber
      counts={dailyCounts}
      mode={timeMode}
      index={scrubIndex}
      {nowMs}
      disabled={!graph || empty}
      onmode={(m) => (timeMode = m)}
      onindex={(i) => (scrubIndex = i)}
    />
    </div>
    <AtlasInspector
      node={selectedNode}
      {detail}
      {detailLoading}
      {related}
      presence={selectedNode ? presence : working}
      {people}
      selectedPersonId={personFilter}
      onperson={(id) => (personFilter = personFilter === id ? null : id)}
      onpeopleretry={() => (peopleNonce += 1)}
      personMatches={personIds?.size ?? 0}
      company={companyName ?? graph?.company ?? ""}
      objectCount={loadFailed ? null : (graph?.nodes.length ?? 0)}
      projectsInProgress={loadFailed && boardInProgress == null ? null : projectsInProgress}
      mapFailed={loadFailed}
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
    color: var(--t1, var(--v4-text-1));
    font-family: var(--font-sans, "Geist", sans-serif);
    font-size: 13px;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 52px;
    box-sizing: border-box;
    padding: 0 20px;
    border-bottom: 1px solid var(--line, var(--v4-rowline));
    flex: none;
  }
  h1 {
    font-size: var(--type-title, 20px);
    font-weight: var(--type-title-weight, 500);
    line-height: var(--type-title-line, 1.25);
    margin: 0 8px 0 0;
  }
  .grow {
    flex: 1;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--t2, var(--v4-text-2));
    font-size: 13px;
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
  .atlas {
    display: grid;
    grid-template-columns: 1fr 340px;
    flex: 1;
    min-height: 0;
  }
  .map-col {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .map-cell {
    flex: 1;
    position: relative;
    min-width: 0;
    min-height: 0;
  }
  .empty {
    position: absolute;
    inset: 0;
  }
  .empty svg {
    width: 100%;
    height: 100%;
  }
  .ring {
    fill: none;
    stroke: var(--v4-rowline);
    stroke-width: 1;
    stroke-dasharray: 3 6;
  }
  .region {
    font-size: 13px;
    fill: var(--t3, var(--v4-text-3));
  }
  .empty-center {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, calc(-50% - 36px));
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    width: min(620px, calc(100% - 48px));
  }
  .empty-ctr {
    text-align: center;
    font-size: 13px;
    color: var(--t3, var(--v4-text-3));
    background: var(--v4-ground);
    padding: 0 10px;
  }
  .empty-ctr b {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: var(--t1, var(--v4-text-1));
    margin-bottom: 2px;
  }
  .empty-prompts {
    display: flex;
    gap: 12px;
    width: 100%;
  }
  .empty-p {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    text-align: left;
    padding: 14px 16px;
    border: 0;
    border-radius: 10px;
    background: var(--raised, var(--v4-control-faint));
    color: var(--v4-text-1);
    font: inherit;
    cursor: pointer;
  }
  .empty-p:hover {
    background: var(--hover, var(--v4-active-row));
  }
  .pk {
    font-size: 13px;
    color: var(--t3, var(--v4-text-3));
  }
  .pt {
    font-size: 13px;
    font-weight: 500;
  }
  .ps {
    font-size: 13px;
    color: var(--v4-text-3);
    line-height: 1.4;
  }
  .legend {
    position: absolute;
    left: 14px;
    bottom: 10px;
    font-size: 13px;
    color: var(--v4-text-3);
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .idot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-idle);
  }
  .skeleton :global(.read-loader) {
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    z-index: 1;
    flex-direction: column;
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
