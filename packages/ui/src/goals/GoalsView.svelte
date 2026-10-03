<script lang="ts">
  import RailButton from "../common/button/RailButton.svelte";
  /**
   * Company Goals (US-026). Paints the cached board objectives on the first
   * frame, then refreshes from get_local_company_goals. New objective and
   * Link project both open LinkPicker. Created objectives stay in the
   * session cache because board.json is read-only from this app.
   */
  import { onMount } from "svelte";
  import type { PlatformAdapter } from "@hq/platform";
  import "../home/tokens.css";
  import "../common/button/rail-type.css";
  import "../chat/scroll-perf.css";
  import {
    configureProjectsApi,
    dedupeProjects,
    loadCompanyGoals,
    loadLocalProjects,
    type Objective,
  } from "../projects/local-projects.js";
  import { projectDisplayName, type Project } from "../projects/projects-model.js";
  import LinkPicker from "./LinkPicker.svelte";
  import NewGoalSheet from "./NewGoalSheet.svelte";
  import {
    GOAL_PERIODS,
    formatKrEnds,
    goalGlyph,
    krCount,
    krKey,
    krProgress,
    linksForKr,
    matchesPeriod,
    objectiveProgress,
    readGoalsCache,
    mergeGoalsWithCache,
    tallyGlyphs,
    unlinkedProjects,
    writeGoalsCache,
    type GoalPeriod,
    type KrLink,
  } from "./goals-model.js";

  interface Props {
    adapter: PlatformAdapter;
    slug: string;
  }

  let { adapter, slug }: Props = $props();

  const storage = typeof localStorage === "undefined" ? null : localStorage;

  let objectives = $state<Objective[] | null>(null);
  let projects = $state<Project[]>([]);
  let projectsLoaded = $state(false);
  let projectsError = $state<string | null>(null);
  /** Objective whose Add key result form is open (QA-078). */
  let krFormFor = $state<string | null>(null);
  let krTitle = $state("");
  let krTarget = $state("");
  let links = $state<KrLink[]>([]);
  let period = $state<GoalPeriod>("2026");
  let refreshing = $state(false);
  let picker = $state(false);
  let sheet = $state(false);
  let error = $state<string | null>(null);

  const visible = $derived((objectives ?? []).filter((objective) => matchesPeriod(objective.timeframe, period)));
  // The picker only offers the active company's projects, one row per PRD.
  const companyProjects = $derived(dedupeProjects(projects.filter((project) => project.company === slug)));
  const unlinked = $derived(unlinkedProjects(companyProjects, links));
  const summary = $derived(tallyGlyphs(visible));

  function remember(active: string): void {
    if (objectives) writeGoalsCache(storage, active, { objectives, links });
  }

  function paintCache(active: string): void {
    const cached = readGoalsCache(storage, active);
    if (!cached) {
      objectives = [];
      links = [];
      return;
    }
    objectives = cached.objectives;
    links = cached.links;
  }

  const PROJECTS_CACHE_PREFIX = "hq.goals.projects.";

  function paintProjectsCache(active: string): void {
    projectsError = null;
    try {
      const raw = storage?.getItem(PROJECTS_CACHE_PREFIX + active);
      const cached: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(cached)) {
        projects = cached as Project[];
        projectsLoaded = true;
        return;
      }
    } catch (err) {
      console.warn("[goals] projects cache unreadable", err);
    }
    projects = [];
    projectsLoaded = false;
  }

  /** Same source as the Projects page: paint the cache, then refresh from get_local_projects. */
  async function refreshProjects(active: string): Promise<void> {
    projectsError = null;
    try {
      configureProjectsApi(adapter.projects);
      const allProjects = await loadLocalProjects();
      if (slug !== active) return;
      projects = allProjects;
      projectsLoaded = true;
      try {
        storage?.setItem(
          PROJECTS_CACHE_PREFIX + active,
          JSON.stringify(allProjects.filter((project) => project.company === active)),
        );
      } catch (err) {
        console.warn("[goals] projects cache not saved", err);
      }
    } catch (err) {
      if (slug !== active) return;
      console.error("[goals] projects could not be read", err);
      // A cached list stays on screen; only an empty picker shows the error.
      if (!projectsLoaded) projectsError = "Projects could not be loaded.";
    }
  }

  async function refresh(active: string): Promise<void> {
    refreshing = true;
    error = null;
    try {
      configureProjectsApi(adapter.projects);
      const goals = await loadCompanyGoals(active);
      if (slug !== active) return;
      const cached = readGoalsCache(storage, active);
      // Key results added in this app stay on their board objective after a refresh.
      objectives = mergeGoalsWithCache(goals.objectives, cached);
      links = cached?.links ?? links;
      remember(active);
    } catch (err) {
      if (slug !== active) return;
      // AUDIT-3: never paint the transport message; plain copy plus Try again.
      console.error("GoalsView: goals read failed:", err);
      error = "Couldn't read this company's goals.";
      if (!objectives) objectives = [];
    } finally {
      if (slug === active) refreshing = false;
    }
  }

  $effect(() => {
    const active = slug;
    paintCache(active);
    paintProjectsCache(active);
    if (active) {
      void refresh(active);
      void refreshProjects(active);
    }
  });

  onMount(() => {
    if (!objectives) paintCache(slug);
  });

  function linkProject(project: Project, objectiveId: string, key: string): void {
    links = [
      ...links.filter((link) => !(link.objectiveId === objectiveId && link.krKey === key && link.projectId === project.id)),
      { objectiveId, krKey: key, projectId: project.id, projectName: projectDisplayName(project) },
    ];
    remember(slug);
    picker = false;
  }

  function openKrForm(objectiveId: string): void {
    picker = false;
    krTitle = "";
    krTarget = "";
    krFormFor = objectiveId;
  }

  function addKeyResult(): void {
    const objectiveId = krFormFor;
    if (!objectiveId || !krTitle.trim() || !objectives) return;
    objectives = objectives.map((objective) =>
      objective.id === objectiveId
        ? {
            ...objective,
            keyResults: [
              ...objective.keyResults,
              { id: `local-kr-${Date.now()}`, title: krTitle.trim(), current: 0, target: krTarget.trim() || null },
            ],
          }
        : objective,
    );
    remember(slug);
    krFormFor = null;
    // Back to the picker so the new key result can be linked straight away.
    picker = true;
  }

  function createObjective(draft: {
    title: string;
    period: string;
    owner: string;
    keyResults: { title: string; current: string; target: string; unit: string }[];
    links: { krIndex: number; projectId: string; projectName: string }[];
  }): void {
    const created: Objective = {
      id: `local-${Date.now()}`,
      title: draft.title,
      description: "",
      status: "",
      timeframe: draft.period,
      owner: draft.owner || null,
      keyResults: draft.keyResults.map((kr, index) => ({
        id: `local-kr-${index}`,
        title: kr.title,
        current: kr.current,
        target: kr.target,
        unit: kr.unit,
      })),
      initiativeIds: [],
    };
    // Links are saved with the objective in the same update, keyed to the created key results.
    const createdLinks: KrLink[] = draft.links.flatMap((link) => {
      const kr = created.keyResults[link.krIndex];
      return kr
        ? [{ objectiveId: created.id, krKey: krKey(kr, link.krIndex), projectId: link.projectId, projectName: link.projectName }]
        : [];
    });
    objectives = [...(objectives ?? []), created];
    links = [...links, ...createdLinks];
    remember(slug);
    sheet = false;
  }
</script>

<div class="goals" data-testid="goals-view" data-refreshing={refreshing ? "true" : "false"}>
  <header class="toolbar">
    <h1>Goals</h1>
    <div class="tabs" role="tablist" aria-label="Period">
      {#each GOAL_PERIODS as id (id)}
        <button type="button" class="tab" role="tab" aria-selected={period === id} onclick={() => (period = id)}>{id}</button>
      {/each}
    </div>
    <span class="grow"></span>
    {#if objectives}
      <span class="meta-line" data-meta-line>{visible.length} objectives · {krCount(visible)} KRs</span>
      {#if summary}<span class="meta-line" data-meta-line>{summary}</span>{/if}
    {/if}
    <RailButton icon="link" data-testid="link-project" onclick={() => { sheet = false; picker = true; }}>Link project</RailButton>
    <RailButton icon="plus" variant="primary" data-testid="new-objective" onclick={() => { picker = false; sheet = true; }}>New objective</RailButton>
  </header>

  {#if !objectives}
    <div class="canvas" aria-busy="true" data-testid="goals-skeleton">
      {#each [0, 1, 2] as i (i)}<div class="shimmer"></div>{/each}
    </div>
  {:else}
    <div class="canvas">
      <div class="sech">Objectives · {period} <span class="grow"></span><span class="plain">Progress averages each objective's KRs</span></div>
      {#if error}
        <div class="empty load-error" role="alert" data-testid="goals-load-error">
          <p>{error}</p>
          <RailButton icon="refresh" data-testid="goals-retry" onclick={() => void refresh(slug)}>Try again</RailButton>
        </div>
      {:else if objectives.length === 0}
        <p class="empty" data-testid="empty-goals-state">No goals are available from this company's local board yet.</p>
      {:else if visible.length === 0}
        <!-- QA-067: a period with no goals is not an empty board. -->
        <p class="empty" data-testid="empty-period-state">No goals match {period}. Choose All time to see all {objectives.length} {objectives.length === 1 ? "objective" : "objectives"}.</p>
      {/if}
      {#each visible as objective (objective.id || objective.title)}
        {@const glyph = goalGlyph(objective.status)}
        {@const progress = objectiveProgress(objective)}
        <article class="obj hq-contain-row">
          <div class="oh">
            <span class="g" title={glyph.label}><i class="sdot" data-status={glyph.label}></i></span>
            <div>
              <div class="tt">{objective.title}</div>
              <div class="om">{objective.timeframe || "No timeframe"}{#if objective.owner} · {objective.owner}{/if} · {glyph.label}</div>
            </div>
            <span class="op">{progress == null ? "—" : `${progress}%`}</span>
          </div>
          {#each objective.keyResults as kr, index (krKey(kr, index))}
            {@const pct = krProgress(kr)}
            {@const attached = linksForKr(links, objective.id, krKey(kr, index))}
            <div class="kr">
              <span class="n">KR</span>
              <div>
                <div class="kt">{kr.title || "Key result"}</div>
                <div class="km">
                  <span class="bar"><i style:width="{pct ?? 0}%"></i></span>
                  <span class="pct">{pct == null ? "—" : `${pct}%`}</span>
                  <span class="ct">{formatKrEnds(kr)}</span>
                  {#each attached as link (link.projectId)}
                    <span class="chip">{link.projectName}</span>
                  {/each}
                </div>
              </div>
            </div>
          {/each}
        </article>
      {/each}
      {#if unlinked.length > 0}
        <div class="unl">
          <b>Unlinked projects · {unlinked.length}</b>
          <span>{unlinked.map((project) => projectDisplayName(project)).join(" · ")}</span>
          <RailButton icon="link" onclick={() => (picker = true)}>Link to a KR</RailButton>
        </div>
      {/if}
      <div class="glegend">{#each ["on track", "at risk", "off track", "complete"] as label (label)}<span><i class="sdot" data-status={label}></i>{label}</span>{/each}</div>
    </div>
  {/if}

  {#if picker && objectives}
    <svelte:boundary onerror={(err) => console.error("[goals] link picker failed", err)}>
      <LinkPicker
        projects={projectsLoaded ? companyProjects : null}
        {objectives}
        {projectsError}
        onretry={() => void refreshProjects(slug)}
        onaddkr={openKrForm}
        onclose={() => (picker = false)}
        onlink={linkProject}
      />
      {#snippet failed(_err, reset)}
        <div class="sheet-failed" role="alert" data-testid="link-picker-failed">
          The project picker could not open.
          <button type="button" onclick={reset}>Try again</button>
          <button type="button" onclick={() => (picker = false)}>Close</button>
        </div>
      {/snippet}
    </svelte:boundary>
  {/if}
  {#if krFormFor}
    <form
      class="sheet-failed krform"
      data-testid="add-kr-form"
      aria-label="Add key result"
      onsubmit={(event) => { event.preventDefault(); addKeyResult(); }}
    >
      <input placeholder="Key result" aria-label="Key result" bind:value={krTitle} />
      <input placeholder="Target" aria-label="Target" bind:value={krTarget} />
      <button type="submit" disabled={!krTitle.trim()}>Add</button>
      <button type="button" onclick={() => (krFormFor = null)}>Cancel</button>
    </form>
  {/if}
  {#if sheet && objectives}
    <svelte:boundary onerror={(err) => console.error("[goals] new objective sheet failed", err)}>
      <NewGoalSheet
        projects={projectsLoaded ? companyProjects : null}
        onclose={() => (sheet = false)}
        oncreate={createObjective}
      />
      {#snippet failed(_err, reset)}
        <div class="sheet-failed" role="alert" data-testid="new-goal-sheet-failed">
          The new objective sheet could not open.
          <button type="button" onclick={reset}>Try again</button>
          <button type="button" onclick={() => (sheet = false)}>Close</button>
        </div>
      {/snippet}
    </svelte:boundary>
  {/if}
</div>

<style>
  .sheet-failed {
    position: absolute;
    right: 16px;
    top: 52px;
    z-index: 5;
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 10px 12px;
    background: var(--v4-popover, var(--v4-ground, #111));
    border: 1px solid var(--v4-hairline, var(--v4-rowline));
    border-radius: 8px;
    color: var(--v4-text-2);
  }
  .krform input { font: inherit; color: var(--v4-text-1); background: transparent; border: 1px solid var(--v4-rowline); border-radius: 6px; height: 26px; padding: 0 8px; }
  .sheet-failed button { font: inherit; color: var(--v4-text-1); background: transparent; border: 0; cursor: pointer; }
  /* Segmented controls size to their tabs; nothing stretches or centres them. */
  .tabs, .seg { width: max-content; flex: none; justify-content: flex-start; }
  .goals {
    position: relative;
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--v4-text-1);
    font-family: var(--font-sans, Geist, sans-serif);
  }
  .toolbar { display: flex; align-items: center; gap: 8px; height: 52px; box-sizing: border-box; padding: 0 20px; flex: none; border-bottom: 1px solid var(--line); }
  .toolbar h1 { margin: 0; font-size: var(--type-title, 20px); font-weight: var(--type-title-weight, 500); line-height: var(--type-title-line, 1.25); }
  .tabs { display: flex; gap: 2px; margin-left: 12px; background: var(--hover); border: 1px solid var(--panel-border); border-radius: 6px; padding: 2px; }
  .tab { font: inherit; background: transparent; border: 0; color: var(--v4-text-2); }
  .tab { padding: 4px 8px; border-radius: 4px; font-size: 13px; cursor: pointer; }
  .tab[aria-selected="true"] { background: var(--sel); color: var(--t1); }
  .grow { flex: 1; }
  .chip { font-size: 13px; color: var(--t2); font-variant-numeric: tabular-nums; }
  .canvas { padding: 16px 12px 24px; overflow: auto; min-height: 0; font-size: 13px; }
  .sech {
    display: flex; align-items: center; gap: 8px; margin: 0 0 4px; padding: 0 8px;
    font-size: 13px; font-weight: 500; color: var(--t2);
  }
  .plain { font-weight: 400; color: var(--t3); font-size: 13px; }
  .obj { padding: 7px 8px 10px; border-radius: 8px; }
  .obj:hover { background: var(--hover); }
  .oh { display: grid; grid-template-columns: 16px 1fr auto; gap: 8px; align-items: center; line-height: 17px; }
  .g, .op, .pct, .ct, .n { font-variant-numeric: tabular-nums; }
  .g { display: inline-grid; place-items: center; }
  .sdot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--t2); box-sizing: border-box; }
  .sdot[data-status="at risk"] { background: var(--warn); }
  .sdot[data-status="off track"], .sdot[data-status="not started"] { background: transparent; border: 1px solid var(--t3); }
  .sdot[data-status="complete"] { background: var(--t1); }
  .glegend span { display: inline-flex; align-items: center; gap: 6px; }
  .tt { font-size: 13px; font-weight: 500; }
  .om, .kt { color: var(--t2); }
  .om { font-size: 13px; color: var(--t3); margin-top: 2px; }
  .kr { display: grid; grid-template-columns: 16px 1fr; gap: 8px; padding: 8px 0 0; }
  .n { font-size: 13px; color: var(--t3); text-align: center; }
  .kt { font-size: 13px; }
  .km { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 13px; color: var(--t3); flex-wrap: wrap; }
  .bar { flex: 1 1 160px; max-width: 560px; height: 3px; background: var(--line2); border-radius: 2px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--t2); }
  .unl, .glegend, .empty { font-size: 13px; color: var(--t3); }
  .load-error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  .load-error p { margin: 0; }
  .unl { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
  .unl b { color: var(--t2); font-weight: 500; }
  .glegend { display: flex; gap: 14px; margin-top: 16px; padding: 0 8px; }
  .shimmer {
    height: 48px; margin: 8px 0; border-radius: 6px;
    background: linear-gradient(90deg, var(--v4-control-faint), var(--v4-hover), var(--v4-control-faint));
  }
</style>
