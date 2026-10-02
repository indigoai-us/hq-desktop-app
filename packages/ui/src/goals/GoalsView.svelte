<script lang="ts">
  /**
   * Company Goals (US-026). Paints the cached board objectives on the first
   * frame, then refreshes from get_local_company_goals. New objective and
   * Link project both open LinkPicker. Created objectives stay in the
   * session cache because board.json is read-only from this app.
   */
  import { onMount } from "svelte";
  import type { PlatformAdapter } from "@hq/platform";
  import "../home/tokens.css";
  import "../chat/scroll-perf.css";
  import {
    configureProjectsApi,
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
  let links = $state<KrLink[]>([]);
  let period = $state<GoalPeriod>("2026");
  let refreshing = $state(false);
  let picker = $state(false);
  let sheet = $state(false);
  let error = $state<string | null>(null);

  const visible = $derived((objectives ?? []).filter((objective) => matchesPeriod(objective.timeframe, period)));
  const unlinked = $derived(unlinkedProjects(projects.filter((project) => project.company === slug), links));
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

  async function refresh(active: string): Promise<void> {
    refreshing = true;
    error = null;
    try {
      configureProjectsApi(adapter.projects);
      const [goals, allProjects] = await Promise.all([
        loadCompanyGoals(active),
        loadLocalProjects().catch(() => [] as Project[]),
      ]);
      if (slug !== active) return;
      const cached = readGoalsCache(storage, active);
      const localOnly = (cached?.objectives ?? []).filter(
        (objective) => objective.id.startsWith("local-") && !goals.objectives.some((row) => row.id === objective.id),
      );
      objectives = [...goals.objectives, ...localOnly];
      projects = allProjects;
      links = cached?.links ?? links;
      remember(active);
    } catch (err) {
      if (slug !== active) return;
      error = err instanceof Error ? err.message : "Goals could not be read.";
      if (!objectives) objectives = [];
    } finally {
      if (slug === active) refreshing = false;
    }
  }

  $effect(() => {
    const active = slug;
    paintCache(active);
    if (active) void refresh(active);
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

  function createObjective(draft: {
    title: string;
    period: string;
    owner: string;
    keyResults: { title: string; current: string; target: string; unit: string }[];
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
    objectives = [...(objectives ?? []), created];
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
      <span class="chip">{visible.length} objectives · {krCount(visible)} KRs</span>
      {#if summary}<span class="chip">{summary}</span>{/if}
    {/if}
    <button type="button" class="btn" data-testid="link-project" onclick={() => { sheet = false; picker = true; }}>Link project</button>
    <button type="button" class="btn primary" data-testid="new-objective" onclick={() => { picker = false; sheet = true; }}>New objective</button>
  </header>

  {#if !objectives}
    <div class="canvas" aria-busy="true" data-testid="goals-skeleton">
      {#each [0, 1, 2] as i (i)}<div class="shimmer"></div>{/each}
    </div>
  {:else}
    <div class="canvas">
      <div class="sech">Objectives · {period} <span class="grow"></span><span class="plain">Progress averages each objective's KRs</span></div>
      {#if error}<p class="empty">{error}</p>{/if}
      {#if visible.length === 0}
        <p class="empty" data-testid="empty-goals-state">No goals are available from this company's local board yet.</p>
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
          <button type="button" class="btn" onclick={() => (picker = true)}>Link to a KR</button>
        </div>
      {/if}
      <div class="glegend">{#each ["on track", "at risk", "off track", "complete"] as label (label)}<span><i class="sdot" data-status={label}></i>{label}</span>{/each}</div>
    </div>
  {/if}

  {#if picker && objectives}
    <LinkPicker
      {projects}
      {objectives}
      onclose={() => (picker = false)}
      onlink={linkProject}
    />
  {/if}
  {#if sheet && objectives}
    <NewGoalSheet
      {projects}
      {objectives}
      onclose={() => (sheet = false)}
      oncreate={createObjective}
      onlink={linkProject}
    />
  {/if}
</div>

<style>
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
  .tab, .btn { font: inherit; background: transparent; border: 0; color: var(--v4-text-2); }
  .tab { padding: 4px 8px; border-radius: 4px; font-size: 13px; cursor: pointer; }
  .tab[aria-selected="true"] { background: var(--sel); color: var(--t1); }
  .grow { flex: 1; }
  .btn { height: 26px; box-sizing: border-box; border: 1px solid var(--line2); border-radius: 6px; padding: 0 10px; background: var(--btn-bg); color: var(--t1); font-size: 13px; cursor: pointer; }
  .btn.primary { background: var(--t1); color: var(--badge-fg); border-color: transparent; }
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
  .unl { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
  .unl b { color: var(--t2); font-weight: 500; }
  .glegend { display: flex; gap: 14px; margin-top: 16px; padding: 0 8px; }
  .shimmer {
    height: 48px; margin: 8px 0; border-radius: 6px;
    background: linear-gradient(90deg, var(--v4-control-faint), var(--v4-hover), var(--v4-control-faint));
  }
</style>
