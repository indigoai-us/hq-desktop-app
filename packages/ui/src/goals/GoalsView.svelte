<script lang="ts">
  import ReadLoader from "../common/ReadLoader.svelte";
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
  import GoalDetailPane from "./GoalDetailPane.svelte";
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
    objectiveLinks,
    saveGoalsCache,
    tallyGlyphs,
    withoutObjectiveLink,
    writeGoalsCache,
    type GoalPeriod,
    type KrLink,
  } from "./goals-model.js";

  interface Props {
    adapter: PlatformAdapter;
    slug: string;
    /** False for people who cannot edit goals: the objective pane is read-only. */
    canEdit?: boolean;
    /** Opens a linked project in the Projects page. */
    onopenproject?: (projectId: string) => void;
  }

  let { adapter, slug, canEdit = true, onopenproject }: Props = $props();

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
  /** Objective open in the side pane (OWNER-R8). */
  let selectedId = $state<string | null>(null);
  let panePicker = $state(false);
  let saveError = $state<string | null>(null);
  let retrySave = $state<(() => void) | null>(null);
  let canvasEl = $state<HTMLElement | null>(null);

  const visible = $derived((objectives ?? []).filter((objective) => matchesPeriod(objective.timeframe, period)));
  // The picker only offers the active company's projects, one row per PRD.
  const companyProjects = $derived(dedupeProjects(projects.filter((project) => project.company === slug)));
  const summary = $derived(tallyGlyphs(visible));
  // BLANK-2: a failed read with nothing loaded shows only the failed line and
  // Try again; "0 objectives" waits for a read that succeeded.
  const failedEmpty = $derived(Boolean(error) && (objectives ?? []).length === 0);
  const selected = $derived((objectives ?? []).find((objective) => rowKey(objective) === selectedId) ?? null);
  const selectedLinks = $derived(selected ? objectiveLinks(links, selected.id) : []);
  // The pane's picker offers only projects this objective does not link yet.
  const addable = $derived(
    companyProjects.filter((project) => !selectedLinks.some((link) => link.projectId === project.id)),
  );

  function rowKey(objective: Objective): string {
    return objective.id || objective.title;
  }

  function openPane(objective: Objective): void {
    selectedId = rowKey(objective);
    panePicker = false;
    saveError = null;
    retrySave = null;
  }

  function closePane(): void {
    const key = selectedId;
    selectedId = null;
    panePicker = false;
    saveError = null;
    retrySave = null;
    if (key == null) return;
    // Focus returns to the row that opened the pane.
    const rows = canvasEl?.querySelectorAll<HTMLElement>("[data-goal-key]") ?? [];
    for (const row of rows) {
      if (row.dataset.goalKey === key) row.focus();
    }
  }

  function onRowKey(event: KeyboardEvent, objective: Objective): void {
    if (event.key !== "Enter" || event.target !== event.currentTarget) return;
    event.preventDefault();
    openPane(objective);
  }

  function onGoalsKey(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !selectedId || panePicker || picker || sheet || krFormFor) return;
    event.preventDefault();
    closePane();
  }

  /**
   * The goal-link write the New objective flow and Link project use (the
   * company goals cache), applied optimistically and rolled back on failure.
   */
  function saveLinks(next: KrLink[]): void {
    const previous = links;
    links = next;
    try {
      saveGoalsCache(storage, slug, { objectives: objectives ?? [], links: next });
      saveError = null;
      retrySave = null;
    } catch (err) {
      console.error("[goals] objective link change not saved", err);
      links = previous;
      saveError = "Couldn't save the change.";
      retrySave = () => saveLinks(next);
    }
  }

  function addFromPane(project: Project, objectiveId: string, key: string): void {
    panePicker = false;
    saveLinks([
      ...links.filter((link) => !(link.objectiveId === objectiveId && link.krKey === key && link.projectId === project.id)),
      { objectiveId, krKey: key, projectId: project.id, projectName: projectDisplayName(project) },
    ]);
  }

  function removeFromPane(projectId: string): void {
    if (!selected) return;
    saveLinks(withoutObjectiveLink(links, selected.id, projectId));
  }

  function remember(active: string): void {
    if (objectives) writeGoalsCache(storage, active, { objectives, links });
  }

  function paintCache(active: string): void {
    const cached = readGoalsCache(storage, active);
    if (!cached) {
      // AUDIT-3: no cache means "still reading", not "no goals"; hold the
      // loader until the board answers so the empty line never flashes.
      objectives = null;
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

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="goals" data-testid="goals-view" data-refreshing={refreshing ? "true" : "false"} onkeydown={onGoalsKey}>
  <header class="toolbar">
    <h1>Goals</h1>
    <div class="tabs" role="tablist" aria-label="Period">
      {#each GOAL_PERIODS as id (id)}
        <button type="button" class="tab" role="tab" aria-selected={period === id} onclick={() => (period = id)}>{id}</button>
      {/each}
    </div>
    <span class="grow"></span>
    {#if objectives && !failedEmpty}
      <span class="meta-line" data-meta-line>{visible.length} objectives · {krCount(visible)} KRs</span>
      {#if summary}<span class="meta-line" data-meta-line>{summary}</span>{/if}
    {/if}
    <RailButton icon="link" data-testid="link-project" onclick={() => { sheet = false; picker = true; }}>Link project</RailButton>
    <RailButton icon="plus" variant="primary" data-testid="new-objective" onclick={() => { picker = false; sheet = true; }}>New objective</RailButton>
  </header>

  {#if !objectives}
    <div class="canvas" aria-busy="true">
      <ReadLoader testid="goals-loader" onretry={() => void refresh(slug)} />
    </div>
  {:else}
    <div class="body">
    <div class="canvas" bind:this={canvasEl}>
      {#if !failedEmpty}<div class="sech">Objectives · {period} <span class="grow"></span><span class="plain">Progress averages each objective's KRs</span></div>{/if}
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
        <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
        <article
          class="obj hq-contain-row"
          class:selected={selectedId === rowKey(objective)}
          data-testid="goal-row"
          data-goal-key={rowKey(objective)}
          role="button"
          tabindex="0"
          aria-pressed={selectedId === rowKey(objective)}
          onclick={() => openPane(objective)}
          onkeydown={(event) => onRowKey(event, objective)}
        >
          <div class="oh">
            <span class="g" title={glyph.label}><i class="sdot" data-status={glyph.label}></i></span>
            <div>
              <div class="tt" title={objective.title}>{objective.title}</div>
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
      <div class="glegend">{#each ["on track", "at risk", "off track", "complete"] as label (label)}<span><i class="sdot" data-status={label}></i>{label}</span>{/each}</div>
    </div>
    {#if selected}
      <GoalDetailPane
        objective={selected}
        links={selectedLinks}
        projects={projectsLoaded ? companyProjects : null}
        {projectsError}
        {canEdit}
        {saveError}
        onclose={closePane}
        {onopenproject}
        onadd={() => { picker = false; sheet = false; panePicker = true; }}
        onremove={removeFromPane}
        onretrysave={retrySave ?? undefined}
        onretryprojects={() => void refreshProjects(slug)}
      />
    {/if}
    </div>
  {/if}

  {#if panePicker && selected && canEdit}
    <svelte:boundary onerror={(err) => console.error("[goals] pane link picker failed", err)}>
      <LinkPicker
        projects={projectsLoaded ? addable : null}
        objectives={[selected]}
        {projectsError}
        onretry={() => void refreshProjects(slug)}
        onaddkr={(id) => { panePicker = false; openKrForm(id); }}
        onclose={() => (panePicker = false)}
        onlink={addFromPane}
      />
      {#snippet failed(_err, reset)}
        <div class="sheet-failed" role="alert" data-testid="pane-link-picker-failed">
          The project picker could not open.
          <button type="button" onclick={reset}>Try again</button>
          <button type="button" onclick={() => (panePicker = false)}>Close</button>
        </div>
      {/snippet}
    </svelte:boundary>
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
  .body { flex: 1; min-height: 0; display: flex; }
  .canvas { flex: 1; min-width: 0; padding: 16px 12px 24px; overflow: auto; min-height: 0; font-size: 13px; }
  .sech {
    display: flex; align-items: center; gap: 8px; margin: 0 0 4px; padding: 0 8px;
    font-size: 13px; font-weight: 500; color: var(--t2);
  }
  .plain { font-weight: 400; color: var(--t3); font-size: 13px; }
  .obj { padding: 7px 8px 10px; border-radius: 8px; }
  .obj { cursor: pointer; }
  .obj:hover { background: var(--hover); }
  .obj.selected { background: var(--sel); }
  .tt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .oh > div { min-width: 0; }
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
  .glegend, .empty { font-size: 13px; color: var(--t3); }
  .load-error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  .load-error p { margin: 0; }
  .glegend { display: flex; gap: 14px; margin-top: 16px; padding: 0 8px; }
</style>
