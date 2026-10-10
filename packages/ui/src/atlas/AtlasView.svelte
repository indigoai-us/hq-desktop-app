<script lang="ts">
  import ReadLoader from "../common/ReadLoader.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  import "../common/button/rail-type.css";
  /**
   * Company Atlas view (US-012): toolbar, ring map, inspector. Paints the
   * cached graph for the company in the first frame, then refreshes from the
   * Console atlas endpoint in the background. Loaded only via dynamic import.
   */
  import { atlasNamesFromTelemetry, atlasPeopleFromTelemetry, atlasPersonNodeIds, isForbidden, type AtlasPeopleState } from "./atlas-people.js";
  import { isRawPersonId } from "../common/people/people.js";
  import { onMount, untrack } from "svelte";
  import AtlasMap from "./AtlasMap.svelte";
  import AtlasInspector from "./AtlasInspector.svelte";
  import AtlasScrubber from "./AtlasScrubber.svelte";
  import { atlasFocusOrbit } from "./atlas-focus.js";
  import { atlasBoardStories, atlasTodayChanges, atlasTodayGroups, atlasTodayProjects, type AtlasTodayStories } from "./atlas-today.js";
  import {
    ATLAS_PULSE_MS,
    atlasMotionAllowed,
    atlasPulseIds,
    atlasTouchedIndex,
    atlasTrails,
    atlasWorkState,
    type AtlasWorkState,
  } from "./atlas-motion.js";
  import {
    atlasBiggestChanges,
    atlasDailyCounts,
    atlasDayStart,
    atlasPlaybackCaption,
    atlasScrubLabel,
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
     * Live Board project view by project id; Today's story counters come from
     * it. Without it the rows show no bar.
     */
    loadProjectView?: ((projectId: string) => Promise<unknown>) | null;
    /**
     * OWNER-R4: the web Atlas people read (company telemetry, last 30 days),
     * resolving to the raw body. Runs only after the map has painted.
     */
    loadPeople?: (() => Promise<unknown>) | null;
    /** Animate camera moves (frame all, jump to an item). Off snaps. */
    motion?: boolean;
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
    loadProjectView = null,
    loadPeople = null,
    motion = true,
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
  // True once the person pans or zooms; the map then stops re-framing itself.
  let userMoved = false;
  let size = { width: 800, height: 560 };
  let mapHost = $state<HTMLDivElement | null>(null);
  let detail = $state<AtlasDetail | undefined>(undefined);
  let detailLoading = $state(false);
  const details = new Map<string, AtlasDetail | undefined>();

  // Project dots are sized by recent activity. The layout keys on the day,
  // not the minute, so a ticking clock never re-lays out the map.
  const layoutDay = $derived(atlasDayStart(nowMs));
  const layout = $derived(layoutAtlas(graph?.nodes ?? [], { nowMs: layoutDay, edges: graph?.edges }));
  const edges = $derived(atlasEdges(graph?.edges, graph?.nodes ?? []));
  const byId = $derived(new Map((graph?.nodes ?? []).map((n) => [n.id, n])));
  const selectedNode = $derived(selected ? (byId.get(selected) ?? null) : null);
  const related = $derived(
    [...atlasRelatedIds(selected, edges)]
      .map((id) => byId.get(id))
      .filter((n): n is AtlasNode => Boolean(n)),
  );
  // Focus mode: a selected project gathers its repos, knowledge and policies
  // around it. Computed once per selection (and per layout), never per frame.
  const placedById = $derived(new Map(layout.placed.map((n) => [n.id, n])));
  const focus = $derived.by(() => {
    const center = selected ? placedById.get(selected) : undefined;
    if (!center || center.type !== "project") return null;
    const near = [...atlasRelatedIds(selected, edges)].map((id) => placedById.get(id)).filter((n) => n !== undefined);
    const orbit = atlasFocusOrbit(center, near);
    return orbit.size ? orbit : null;
  });
  // Presence sometimes carries only an id for a name. An id never reaches the
  // screen: the activity read's names fill in, then a plain fallback.
  const presence = $derived.by(() => {
    const raw = actors ? atlasPresenceFromActors(actors, graph?.nodes ?? []) : presenceProp;
    const names = people.status === "ok" ? people.names : undefined;
    return raw.map((p) => {
      const place = byId.get(p.nodeId)?.label;
      const name = isRawPersonId(p.name)
        ? (p.actorUid && names?.get(p.actorUid)) || (p.bot ? "Unnamed bot" : "Unnamed member")
        : p.name;
      return { ...p, name, ...(place ? { place } : {}) };
    });
  });
  // People first, then bots; "working" means a session in progress. Actors
  // who are only online are counted apart so they do not bury the list.
  const everyone = $derived(
    atlasDistinctActors(presence).sort((a, b) => Number(a.bot) - Number(b.bot) || a.name.localeCompare(b.name)),
  );
  const working = $derived(everyone.filter((p) => !p.idle));
  const online = $derived(everyone.filter((p) => p.idle));
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
          if (alive()) people = { status: "ok", people: atlasPeopleFromTelemetry(body), names: atlasNamesFromTelemetry(body) };
        })
        .catch((err: unknown) => {
          console.error("atlas people read failed:", err);
          if (alive()) people = { status: "failed", forbidden: isForbidden(err) };
        });
    });
  });
  // Work motion: one pulse where work advanced since the last read, trails
  // from projects active now. The previous read is kept outside reactivity.
  let prevTouched: Map<string, number> | null = null;
  let prevWork: AtlasWorkState | null = null;
  let motionFor = "";
  let pulseSeq = 0;
  let pulses = $state<Map<string, number>>(new Map());
  const pulseTimers = new Set<ReturnType<typeof setTimeout>>();
  $effect(() => {
    const nodes = graph?.nodes;
    const now = presence;
    const uid = companyUid;
    untrack(() => {
      if (!nodes) return;
      if (motionFor !== uid) {
        motionFor = uid;
        prevTouched = null;
        prevWork = null;
      }
      const ids = atlasMotionAllowed(motion) ? atlasPulseIds({ nodes, prevTouched, presence: now, prevWork }) : [];
      prevTouched = atlasTouchedIndex(nodes);
      prevWork = atlasWorkState(now);
      if (!ids.length) return;
      const seq = ++pulseSeq;
      const next = new Map(pulses);
      for (const id of ids) next.set(id, seq);
      pulses = next;
      const timer = setTimeout(() => {
        pulseTimers.delete(timer);
        const left = new Map(pulses);
        for (const [id, s] of left) if (s === seq) left.delete(id);
        pulses = left;
      }, ATLAS_PULSE_MS + 100);
      pulseTimers.add(timer);
    });
  });
  const trails = $derived(
    atlasTrails({
      nodes: graph?.nodes ?? [],
      edges: graph?.edges,
      live,
      nowMs,
      drawn: placedById,
    }),
  );
  const filterName = $derived(
    filterActor ? (presence.find((p) => p.actorUid === filterActor)?.name ?? null) : null,
  );
  // Time scrubber (US-014). Null index is the live edge: only active objects stay bright.
  let timeMode = $state<AtlasTimeMode>("touched");
  let scrubIndex = $state<number | null>(null);
  const dailyCounts = $derived(atlasDailyCounts(graph?.nodes ?? [], timeMode, nowMs));
  const timeOpacity = $derived(atlasTimeOpacity(graph?.nodes ?? [], timeMode, scrubIndex, nowMs, live));
  // Playback: the day in large quiet type on the map, and while playing the
  // day's biggest changes by name.
  let playing = $state(false);
  const playback = $derived.by(() => {
    if (scrubIndex == null || !graph) return null;
    return {
      date: atlasScrubLabel(scrubIndex, nowMs),
      caption: playing ? atlasPlaybackCaption(atlasBiggestChanges(graph.nodes, timeMode, scrubIndex, nowMs), timeMode) : "",
    };
  });
  const nothingActive = $derived(
    scrubIndex == null && (graph?.nodes ?? []).every((n) => timeOpacity.has(n.id)),
  );
  const empty = $derived(graph !== null && graph.nodes.length === 0);
  const today = $derived(graph ? atlasTodayProjects(atlasTodayGroups(atlasTodayChanges(graph.nodes, nowMs), graph.nodes)) : null);
  // Story counters from the live Board, read once per project per company.
  let todayStories = $state<Record<string, AtlasTodayStories | null>>({});
  let todayStoriesFor = "";
  $effect(() => {
    const load = loadProjectView;
    const company = companyUid;
    const projects = today;
    untrack(() => {
      if (todayStoriesFor !== company) {
        todayStoriesFor = company;
        todayStories = {};
      }
      if (!load || !projects) return;
      for (const project of projects) {
        if (project.slug in todayStories) continue;
        todayStories[project.slug] = null;
        load(project.slug)
          .then((raw) => {
            if (todayStoriesFor === company) todayStories[project.slug] = atlasBoardStories(raw);
          })
          .catch((err) => console.warn(`Atlas board stories for ${project.slug} failed:`, err));
      }
    });
  });
  const emptyLabels = ATLAS_RING_ORDER.map((type, i) => {
    const a = -Math.PI / 2 + (i / ATLAS_RING_ORDER.length) * Math.PI * 2;
    return { type, label: districtLabel(type), x: 450 + Math.cos(a) * 290, y: 320 + Math.sin(a) * 250 };
  });
  const companyTitle = $derived(companyName ?? graph?.company ?? "This company");


  function measure(): void {
    const box = mapHost?.getBoundingClientRect();
    if (box && box.width > 0 && box.height > 0) size = { width: box.width, height: box.height };
  }

  // Camera moves ease instead of snapping, and stop the moment the person
  // pans or zooms. Zoom is interpolated geometrically around the map centre so
  // the path reads as one move, not a slide plus a scale.
  let flight = 0;
  function stopFlight(): void {
    if (flight) cancelAnimationFrame(flight);
    flight = 0;
  }
  function flyTo(target: AtlasViewBox, ms = 320): void {
    stopFlight();
    const calm =
      !motion ||
      typeof requestAnimationFrame !== "function" ||
      (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    // A view that is not a finite number yet (nothing measured) cannot be eased from.
    const finite = [view.x, view.y, view.k, target.x, target.y, target.k].every(Number.isFinite) && view.k > 0 && target.k > 0;
    if (calm || ms <= 0 || !finite) {
      view = target;
      return;
    }
    measure();
    const from = view;
    const cx = size.width / 2;
    const cy = size.height / 2;
    const fromC = { x: (cx - from.x) / from.k, y: (cy - from.y) / from.k };
    const toC = { x: (cx - target.x) / target.k, y: (cy - target.y) / target.k };
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const e = 1 - (1 - t) ** 3;
      const k = from.k * (target.k / from.k) ** e;
      const wx = fromC.x + (toC.x - fromC.x) * e;
      const wy = fromC.y + (toC.y - fromC.y) * e;
      view = t >= 1 ? target : { k, x: cx - wx * k, y: cy - wy * k };
      flight = t < 1 ? requestAnimationFrame(step) : 0;
    };
    flight = requestAnimationFrame(step);
  }

  function frame(animate = false): void {
    measure();
    userMoved = false;
    // OWNER-R4: frame the sections' full reach, not just the dots, so no section is cut off.
    const target = frameAll([...layout.placed, ...atlasDistrictShapes(layout.placed, layout.regions)], size.width, size.height);
    if (animate) flyTo(target);
    else {
      stopFlight();
      view = target;
    }
  }

  /**
   * Bring one object to the middle of the map, zooming in if it is small on
   * screen. A focused project frames itself with its gathered ring.
   */
  function flyToNode(id: string): void {
    const node = placedById.get(id);
    if (!node) return;
    measure();
    const orbit = id === selected ? focus : null;
    if (orbit) {
      const ring = [node, ...[...orbit.entries()].map(([oid, at]) => ({ x: at.x, y: at.y, r: placedById.get(oid)?.r ?? 2 }))];
      const fit = frameAll(ring, size.width, size.height, 72);
      const k = Math.min(fit.k, Math.max(view.k, 2.4));
      flyTo({ k, x: size.width / 2 - node.x * k, y: size.height / 2 - node.y * k });
    } else {
      const k = Math.max(view.k, 1.6);
      flyTo({ k, x: size.width / 2 - node.x * k, y: size.height / 2 - node.y * k });
    }
    userMoved = true;
  }

  /** A click on the map: select it, and glide to a project so focus mode is in view. */
  function selectFromMap(id: string | null): void {
    selected = id;
    if (id && placedById.get(id)?.type === "project") flyToNode(id);
  }

  // Find: type a name, jump to the object.
  let query = $state("");
  let findOpen = $state(false);
  let findEl = $state<HTMLInputElement | null>(null);
  const FIND_PAGE = 8;
  // The query whose full match list is showing; a new query starts paged again.
  let findExpandedFor = $state<string | null>(null);
  const matches = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (graph?.nodes ?? [])
      .filter((n) => n.label.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(b.label.toLowerCase().startsWith(q)) - Number(a.label.toLowerCase().startsWith(q)) ||
          (b.touched ?? 0) - (a.touched ?? 0) ||
          a.label.localeCompare(b.label),
      );
  });
  const found = $derived(findExpandedFor === query ? matches : matches.slice(0, FIND_PAGE));
  function pickFound(id: string): void {
    query = "";
    findOpen = false;
    findEl?.blur();
    selected = id;
    flyToNode(id);
  }
  function onfindkey(event: KeyboardEvent): void {
    if (event.key === "Enter" && found[0]) {
      pickFound(found[0].id);
      event.preventDefault();
    } else if (event.key === "Escape") {
      query = "";
      findEl?.blur();
      event.stopPropagation();
    }
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

  // BLANK-3: no timer ends a pending refresh. While it runs the loader keeps
  // the shared loader (waiting lines, then Try again); a real failure replaces
  // it with the failed state. Without a cached map a failure must never leave
  // the loader up.
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
        // A partial map only replaces the loader, never a saved full map.
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

  // Frame when a company's nodes first arrive, and again when the map grows
  // (the first page, then the full load), so nothing sits cut off at an edge.
  // Once the person has moved the map it is left where they put it.
  $effect(() => {
    const key = `${companyUid}:${layout.placed.length}`;
    if (!layout.placed.length || framedFor === key) return;
    const sameCompany = framedFor.startsWith(`${companyUid}:`);
    framedFor = key;
    if (sameCompany && userMoved) return;
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
    else {
      // From a list (Working now, Related): go to it on the map as well.
      selected = id;
      flyToNode(id);
    }
  }

  function onkeydown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (event.key === "Escape" && selected) {
      selected = null;
      event.preventDefault();
    } else if (event.key === "0" && !event.metaKey && !event.ctrlKey) {
      frame(true);
      event.preventDefault();
    } else if (event.key === "/" && !event.metaKey && !event.ctrlKey && findEl) {
      findEl.focus();
      event.preventDefault();
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onkeydown);
    return () => {
      window.removeEventListener("keydown", onkeydown);
      stopFlight();
      for (const timer of pulseTimers) clearTimeout(timer);
      pulseTimers.clear();
    };
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
    {#if graph && !empty}
      <div class="find">
        <input
          bind:this={findEl}
          bind:value={query}
          type="search"
          placeholder="Find on the map"
          aria-label="Find on the map"
          data-testid="atlas-find"
          autocomplete="off"
          spellcheck="false"
          onfocus={() => (findOpen = true)}
          onblur={() => setTimeout(() => (findOpen = false), 120)}
          onkeydown={onfindkey}
        />
        {#if findOpen && query.trim()}
          <div class="find-list" data-testid="atlas-find-results" role="listbox" aria-label="Matches">
            {#each found as hit (hit.id)}
              <button type="button" class="find-row" role="option" aria-selected="false" onmousedown={(e) => e.preventDefault()} onclick={() => pickFound(hit.id)}>
                <span class="find-name">{hit.label}</span>
                <span class="find-kind">{districtLabel(hit.type).replace(/s$/, "")}</span>
              </button>
            {:else}
              <div class="find-none">Nothing on the map by that name.</div>
            {/each}
            {#if matches.length > found.length}
              <button type="button" class="find-row find-more" data-testid="atlas-find-show-more" onmousedown={(e) => e.preventDefault()} onclick={() => (findExpandedFor = query)}>
                <span class="find-name">Show {matches.length - found.length} more</span>
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    <RailButton icon="eye"
      data-testid="atlas-frame-all"
      disabled={!graph || empty}
      onclick={() => frame(true)}
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
          {focus}
          {motion}
          {pulses}
          {trails}
          {playback}
          onselect={selectFromMap}
          onview={(next) => {
            stopFlight();
            view = next;
            userMoved = true;
          }}
          onfly={(next) => {
            flyTo(next);
            userMoved = true;
          }}
        />
      {:else if loadFailed}
        <div class="empty" data-testid="atlas-error" role="alert">
          <div class="empty-center">
            <div class="empty-ctr" data-reason={refreshError}><b>The map didn't load</b>{FAIL_COPY[refreshError ?? "unavailable"]}</div>
            <RailButton icon="refresh" data-testid="atlas-retry" disabled={retrying} onclick={retry}>{retrying ? "Trying again" : "Retry"}</RailButton>
          </div>
        </div>
      {:else}
        <div class="loading" aria-busy="true" aria-label="Loading Atlas">
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
      onplaying={(p) => (playing = p)}
    />
    </div>
    <AtlasInspector
      node={selectedNode}
      {detail}
      {detailLoading}
      {related}
      presence={selectedNode ? presence : working}
      {online}
      {people}
      selectedPersonId={personFilter}
      onperson={(id) => (personFilter = personFilter === id ? null : id)}
      onpeopleretry={() => (peopleNonce += 1)}
      personMatches={personIds?.size ?? 0}
      {today}
      {todayStories}
      company={companyName ?? graph?.company ?? ""}
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
  .find {
    position: relative;
  }
  .find input {
    width: 200px;
    height: 28px;
    box-sizing: border-box;
    padding: 0 10px;
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-button, 6px);
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
    font: inherit;
    font-size: 13px;
    outline: none;
  }
  .find input::placeholder {
    color: var(--v4-text-3);
  }
  .find input:focus {
    border-color: var(--v4-text-3);
  }
  .find-list {
    position: absolute;
    right: 0;
    top: 34px;
    z-index: 5;
    width: 300px;
    padding: 4px;
    border: 1px solid var(--v4-control-border);
    background: var(--v4-ground);
    background:
      linear-gradient(var(--v4-control-bg), var(--v4-control-bg)),
      rgb(from var(--v4-ground) r g b);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.18);
    max-height: 320px;
    overflow-y: auto;
  }
  .find-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    width: 100%;
    padding: 6px 8px;
    border: 0;
    background: none;
    color: var(--v4-text-1);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .find-row:first-child,
  .find-row:hover {
    background: var(--v4-active-row);
  }
  .find-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .find-more {
    color: var(--v4-text-3);
  }
  .find-kind {
    color: var(--v4-text-3);
    flex: none;
  }
  .find-none {
    padding: 6px 8px;
    color: var(--v4-text-3);
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
  .loading {
    position: absolute;
    inset: 0;
  }
</style>
