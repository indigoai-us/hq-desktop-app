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
            <span class="g" title={glyph.label}>{glyph.mark}</span>
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
      <div class="glegend"><span>● on track</span><span>◐ at risk</span><span>○ off track</span><span>✓ complete</span></div>
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
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 12px 16px; flex: none; }
  .toolbar h1 { margin: 0; font-size: var(--type-section); font-weight: 600; }
  .tabs { display: flex; margin-left: 12px; background: var(--v4-control-faint); border: 1px solid var(--v4-control-border); border-radius: 6px; padding: 2px; }
  .tab, .btn { font: inherit; background: transparent; border: 0; color: var(--v4-text-2); }
  .tab { padding: 3px 8px; border-radius: 4px; font-size: var(--type-metadata); }
  .tab[aria-selected="true"] { background: var(--v4-active-row); color: var(--v4-text-1); }
  .grow { flex: 1; }
  .btn { border: 1px solid var(--v4-rowline); border-radius: 6px; padding: 4px 10px; color: var(--v4-text-1); }
  .btn.primary { background: var(--v4-active-row); }
  .chip { font-size: var(--type-metadata); color: var(--v4-text-2); border: 1px solid var(--v4-rowline); border-radius: 980px; padding: 1px 8px; }
  .canvas { padding: 0 16px 16px; overflow: auto; min-height: 0; }
  .sech {
    display: flex; align-items: center; gap: 8px; margin: 0 0 4px;
    font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px;
    letter-spacing: 0.08em; text-transform: uppercase; color: var(--v4-text-3);
  }
  .plain { letter-spacing: 0; text-transform: none; font-family: var(--font-sans, Geist, sans-serif); font-size: 12px; }
  .obj { padding: 12px 8px; border-bottom: 1px solid var(--v4-rowline); border-radius: 6px; }
  .obj:hover { background: var(--v4-hover); }
  .oh { display: grid; grid-template-columns: 18px 1fr auto; gap: 10px; align-items: center; }
  .g, .op, .pct, .ct, .n { font-family: var(--font-mono, ui-monospace, monospace); }
  .g { text-align: center; color: var(--v4-text-2); }
  .tt { font-size: var(--type-body); font-weight: 500; }
  .om, .kt { color: var(--v4-text-2); }
  .om { font-size: var(--type-metadata); color: var(--v4-text-3); margin-top: var(--v4-row-stack-gap); }
  .kr { display: grid; grid-template-columns: 18px 1fr; gap: 10px; padding: 8px 0 0; }
  .n { font-size: 10px; color: var(--v4-text-3); text-align: center; padding-top: 3px; }
  .kt { font-size: var(--type-secondary); }
  .km { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 11px; color: var(--v4-text-3); flex-wrap: wrap; }
  .bar { flex: 1 1 160px; max-width: 560px; height: 3px; background: var(--v4-control-faint); border-radius: 2px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: color-mix(in srgb, var(--v4-text-1) 55%, transparent); }
  .unl, .glegend, .empty { font-size: var(--type-metadata); color: var(--v4-text-3); }
  .unl { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
  .unl b { color: var(--v4-text-2); font-weight: 500; }
  .glegend { display: flex; gap: 14px; margin-top: 16px; font-family: var(--font-mono, ui-monospace, monospace); }
  .shimmer {
    height: 48px; margin: 8px 0; border-radius: 6px;
    background: linear-gradient(90deg, var(--v4-control-faint), var(--v4-hover), var(--v4-control-faint));
  }
</style>
