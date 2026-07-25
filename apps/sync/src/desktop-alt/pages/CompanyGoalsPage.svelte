<script lang="ts">
  /**
   * Company Goals — portfolio list + stable selected-goal detail (DESKTOP-007).
   *
   * Scan-friendly goal list beside a durable detail pane (no card-grid dashboard,
   * no modal). Key results keep current/target/unit + honest computed progress.
   * Linked projects open the existing ProjectDetailView in place. At-risk goals
   * keep Review proposal → Claude Code handoff. Data honesty: no invented links,
   * proposal counts, or progress.
   */
  import { invoke } from '@tauri-apps/api/core';
  import { buildClaudeCodeUrl } from '../../lib/claude-code-link';
  import {
    loadCompanyGoals,
    loadLocalProjects,
    loadLocalProjectStories,
    type KeyResult,
    type Objective,
  } from '../lib/local-projects';
  import {
    projectDisplayName,
    type Project,
    type Story,
  } from '../lib/projects-model';
  import ProjectDetailView from './ProjectDetailView.svelte';

  import '../v4/tokens.css';

  interface Props {
    slug: string;
  }

  type DotTone = 'ok' | 'warn' | 'error' | 'idle';

  interface GoalStatus {
    label: string;
    tone: DotTone;
    atRisk: boolean;
  }

  let { slug }: Props = $props();

  let objectives = $state<Objective[]>([]);
  let projects = $state<Project[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  /** Stable selected goal in the portfolio (list + detail). */
  let selectedGoalId = $state<string | null>(null);

  /** Linked project opened in-place via ProjectDetailView. */
  let selected = $state<Project | null>(null);
  let stories = $state<Story[]>([]);
  let storiesLoading = $state(false);
  let storiesError = $state<string | null>(null);
  let selectedStoryId = $state<string | null>(null);
  let actionBusy = $state<string | null>(null);
  let actionMessage = $state<string | null>(null);

  const companyProjects = $derived(projects.filter((project) => project.company === slug));
  const linkedProjectCount = $derived.by(() => {
    const ids = new Set<string>();
    for (const objective of objectives) {
      for (const project of linkedProjects(objective)) ids.add(project.id);
    }
    return ids.size;
  });
  const targetQuarter = $derived.by(() => {
    const value = objectives.map((objective) => quarterLabel(objective.timeframe)).find(Boolean);
    return value ?? 'No target';
  });
  const selectedStory = $derived(
    selectedStoryId === null
      ? null
      : (stories.find((story) => story.id === selectedStoryId) ?? null),
  );

  function goalKey(objective: Objective): string {
    return objective.id || objective.title || '';
  }

  const selectedGoal = $derived.by(() => {
    if (!selectedGoalId) return null;
    return objectives.find((objective) => goalKey(objective) === selectedGoalId) ?? null;
  });

  const selectedLinked = $derived(selectedGoal ? linkedProjects(selectedGoal) : []);
  const selectedStatus = $derived(
    selectedGoal ? goalStatus(selectedGoal.status) : null,
  );

  $effect(() => {
    const activeSlug = slug;
    objectives = [];
    projects = [];
    error = null;
    selectedGoalId = null;
    selected = null;
    stories = [];
    storiesError = null;
    selectedStoryId = null;

    if (!activeSlug) {
      loading = false;
      return;
    }

    loading = true;
    let cancelled = false;

    void (async () => {
      try {
        const [goals, allProjects] = await Promise.all([
          loadCompanyGoals(activeSlug),
          loadLocalProjects(),
        ]);
        if (cancelled) return;
        objectives = goals.objectives;
        projects = allProjects;
        // Stable detail: auto-select the first goal when the portfolio loads.
        if (goals.objectives.length > 0) {
          selectedGoalId = goalKey(goals.objectives[0]);
        }
      } catch (err) {
        console.error('CompanyGoalsPage load failed:', err);
        if (!cancelled) {
          error = 'Goals unavailable. Try again after a sync.';
          objectives = [];
          projects = [];
          selectedGoalId = null;
        }
      } finally {
        if (!cancelled) loading = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  function goalStatus(raw: string): GoalStatus {
    const normalized = raw.toLowerCase().replace(/[_\s]+/g, '-').trim();
    if (normalized === 'on-track' || normalized === 'active' || normalized === 'running') {
      return { label: 'ON TRACK', tone: 'ok', atRisk: false };
    }
    if (normalized === 'at-risk' || normalized === 'review') {
      return { label: 'AT RISK', tone: 'warn', atRisk: true };
    }
    if (normalized === 'off-track' || normalized === 'blocked') {
      return { label: 'OFF TRACK', tone: 'error', atRisk: true };
    }
    return {
      label: normalized ? normalized.replace(/-/g, ' ').toUpperCase() : 'NO STATUS',
      tone: 'idle',
      atRisk: false,
    };
  }

  function looseNumber(value: number | string | null | undefined): number | null {
    if (value == null || value === '') return null;
    const raw = typeof value === 'number' ? value : value.replace(/,/g, '');
    const parsed = typeof raw === 'number' ? raw : Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function krProgress(kr: KeyResult): number {
    const current = looseNumber(kr.current);
    const target = looseNumber(kr.target);
    if (current === null || target === null || target === 0) return 0;
    if (target < current && current > 0) return clampPercent((target / current) * 100);
    return clampPercent((current / target) * 100);
  }

  function formatValue(value: number | string | null | undefined, unit?: string): string {
    if (value == null || value === '') return '—';
    const text = String(value);
    if (!unit) return text;
    if (unit === '$' || unit.toLowerCase() === 'usd') return `$${text}`;
    if (unit === '%' || unit.startsWith('/')) return `${text}${unit}`;
    return `${text} ${unit}`;
  }

  function keyResultName(kr: KeyResult): string {
    return kr.title || kr.metric || 'Key result';
  }

  function normalizeId(value: string | null | undefined): string {
    return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function objectiveIds(objective: Objective): Set<string> {
    const ids = new Set<string>();
    for (const id of objective.initiativeIds ?? []) {
      const normalized = normalizeId(id);
      if (normalized) ids.add(normalized);
    }
    const linearId = normalizeId(objective.linearInitiativeId);
    if (linearId) ids.add(linearId);
    const ownId = normalizeId(objective.id);
    if (ownId) ids.add(ownId);
    return ids;
  }

  function projectTokens(project: Project): string[] {
    return [
      project.id,
      project.name,
      project.title,
      project.prdPath.split('/').filter(Boolean).at(-2),
    ]
      .map(normalizeId)
      .filter(Boolean);
  }

  function linkedProjects(objective: Objective): Project[] {
    const ids = objectiveIds(objective);
    if (ids.size === 0) return [];
    return companyProjects.filter((project) =>
      projectTokens(project).some((token) => ids.has(token)),
    );
  }

  function overflowCount(items: Project[]): number {
    return Math.max(0, items.length - 3);
  }

  function quarterLabel(value: string | null | undefined): string | null {
    const raw = (value ?? '').trim();
    if (!raw) return null;
    const quarter = raw.match(/Q[1-4]/i)?.[0]?.toUpperCase();
    const year = raw.match(/\b20\d{2}\b/)?.[0];
    if (quarter && year) return `${quarter} ${year}`;
    return quarter ?? raw;
  }

  function ownerLabel(value: string | null | undefined): string {
    const raw = (value ?? '').trim();
    // An unowned objective is honestly "Unassigned" — never invent "Agent"
    // attribution the data doesn't assert (matches Projects/Tasks).
    if (!raw) return 'Unassigned';
    if (raw.toLowerCase() === 'you' || raw.toLowerCase() === 'me') return 'You';
    if (raw.toLowerCase() === 'agent') return 'Agent';
    return raw;
  }

  function riskNote(objective: Objective): string {
    // The at-risk basis is real — derived from a flat/at-risk/blocked KR status
    // (or the objective's own description). We deliberately do NOT append a
    // fabricated proposal-count tail: no such store exists, so claiming the
    // agent already drafted N projects would invent activity that never happened.
    const flat = objective.keyResults.find((kr) => {
      const status = (kr.status ?? '').toLowerCase().replace(/[_\s]+/g, '-');
      return status === 'at-risk' || status === 'flat' || status === 'blocked';
    });
    return `at risk — ${flat ? `${keyResultName(flat)} KR flat` : objective.description || 'progress needs attention'}`;
  }

  function goalListMeta(objective: Objective): string {
    const status = goalStatus(objective.status);
    const owner = ownerLabel(objective.owner);
    const quarter = quarterLabel(objective.timeframe) ?? '—';
    const linked = linkedProjects(objective).length;
    const projectsLabel = `${linked} ${linked === 1 ? 'project' : 'projects'}`;
    return `${status.label} · ${owner} · ${quarter} · ${projectsLabel}`;
  }

  function selectGoal(objective: Objective): void {
    selectedGoalId = goalKey(objective);
  }

  function clearGoalSelection(): void {
    // Narrow collapse: return to the full-width list without losing portfolio data.
    selectedGoalId = null;
  }

  /**
   * Keyboard selection in the goals list: ArrowUp/Down move selection,
   * Home/End jump. Selection stays stable in the detail pane.
   */
  function handleListKeydown(event: KeyboardEvent): void {
    if (objectives.length === 0) return;
    const keys = objectives.map(goalKey);
    const index = selectedGoalId ? keys.indexOf(selectedGoalId) : -1;

    let nextIndex = index;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      nextIndex = Math.min(objectives.length - 1, Math.max(0, index) + (index < 0 ? 0 : 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      nextIndex = Math.max(0, index < 0 ? 0 : index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      nextIndex = 0;
    } else if (event.key === 'End') {
      event.preventDefault();
      nextIndex = objectives.length - 1;
    } else {
      return;
    }

    const next = objectives[nextIndex];
    if (!next) return;
    const nextKey = goalKey(next);
    if (nextKey !== selectedGoalId) {
      selectedGoalId = nextKey;
    }
    queueMicrotask(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-testid="goal-list-row"][data-goal-id="${CSS.escape(nextKey)}"]`,
      );
      el?.focus();
    });
  }

  async function openHqPrompt(kind: string, prompt: string) {
    if (actionBusy) return;
    actionBusy = kind;
    actionMessage = null;
    try {
      const config: { hqFolderPath?: string } = await invoke<{ hqFolderPath?: string }>(
        'get_config',
      ).catch(() => ({}));
      const url = buildClaudeCodeUrl({ folder: config.hqFolderPath ?? '', prompt });
      await invoke('open_claude_code_link', { url });
      actionMessage = 'Opened in Claude Code.';
    } catch (err) {
      console.error('open_claude_code_link failed:', err);
      try {
        await navigator.clipboard.writeText(prompt);
        actionMessage = 'Prompt copied.';
      } catch {
        actionMessage = 'Could not open Claude Code.';
      }
    } finally {
      actionBusy = null;
    }
  }

  function newGoal() {
    const prompt = [
      `/goals ${slug}`,
      '',
      `Create a new measurable company goal for ${slug}.`,
      'Interview me for the missing objective, owner, target quarter, and key results, then update the local company goals source so it appears in HQ.',
    ].join('\n');
    void openHqPrompt('new-goal', prompt);
  }

  function reviewProposal(objective: Objective) {
    const prompt = [
      `/goals ${slug}`,
      '',
      `This goal is flagged at risk: ${objective.title || 'Untitled goal'}.`,
      `Current note: ${riskNote(objective)}`,
      objective.description ? `Goal description: ${objective.description}` : null,
      'Recommend the projects or story changes that should bring the goal back on track, then write the approved updates into the local HQ project/goal files.',
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
    void openHqPrompt(`review-${objective.id || objective.title}`, prompt);
  }

  function selectStoryById(storyId: string): void {
    if (stories.some((story) => story.id === storyId)) {
      selectedStoryId = storyId;
    }
  }

  function openStory(story: Story): void {
    selectedStoryId = story.id;
  }

  function closeStory(): void {
    selectedStoryId = null;
  }

  async function openProject(project: Project): Promise<void> {
    selected = project;
    stories = [];
    storiesError = null;
    selectedStoryId = null;

    if (!project.prdPath) {
      storiesLoading = false;
      return;
    }

    storiesLoading = true;
    try {
      stories = await loadLocalProjectStories(project.prdPath);
    } catch (err) {
      console.error('get_local_project_prd failed:', err);
      const detail = err instanceof Error ? err.message : String(err);
      storiesError = `Could not load this project’s stories — ${detail}`;
      stories = [];
    } finally {
      storiesLoading = false;
    }
  }

  function backToGoals(): void {
    selected = null;
    stories = [];
    storiesError = null;
    selectedStoryId = null;
  }

  function onProjectStatusChange(projectId: string, status: string): void {
    if (selected && selected.id === projectId) {
      selected = { ...selected, status };
    }
    projects = projects.map((project) =>
      project.id === projectId ? { ...project, status } : project,
    );
  }

  function onStoryPassesChange(storyId: string, passes: boolean): void {
    stories = stories.map((story) =>
      story.id === storyId ? { ...story, passes } : story,
    );
    if (selected) {
      const nextComplete = stories.filter((story) =>
        story.id === storyId ? passes : story.passes,
      ).length;
      selected = { ...selected, storiesComplete: nextComplete };
      projects = projects.map((project) =>
        project.id === selected?.id ? { ...project, storiesComplete: nextComplete } : project,
      );
    }
  }
</script>

<section class="company-goals" aria-labelledby="company-goals-title" data-testid="company-goals-page">
  {#if selected}
    <ProjectDetailView
      project={selected}
      {stories}
      {storiesLoading}
      {storiesError}
      objectives={objectives}
      onback={backToGoals}
      onselectStory={openStory}
      onStatusChange={onProjectStatusChange}
      selectedStory={selectedStory}
      oncloseStory={closeStory}
      onselectDependency={selectStoryById}
      {onStoryPassesChange}
    />
  {:else}
    <header class="goals-header">
      <div class="goals-heading title-stack">
        <h2 id="company-goals-title">Goals</h2>
        <span class="goals-sub">
          {objectives.length} {objectives.length === 1 ? 'goal' : 'goals'} · {targetQuarter}
          · linked to {linkedProjectCount} {linkedProjectCount === 1 ? 'project' : 'projects'}
        </span>
      </div>
      <div class="goal-actions detail-primary-actions primary-actions">
        {#if actionMessage}
          <span class="action-status" role="status">{actionMessage}</span>
        {/if}
        <button
          type="button"
          class="new-goal-button"
          data-testid="new-goal-button"
          onclick={newGoal}
          disabled={actionBusy !== null}
        >
          {actionBusy === 'new-goal' ? 'Opening…' : 'New goal'}
        </button>
      </div>
    </header>

    {#if error}
      <div class="goals-error" role="alert" data-testid="goals-error">{error}</div>
    {/if}

    {#if loading}
      <div class="goals-loading" aria-busy="true" data-testid="goals-loading">
        {#each [0, 1, 2] as row (row)}
          <div class="goal-skeleton"></div>
        {/each}
      </div>
    {:else if objectives.length === 0}
      <div class="empty-state" data-testid="empty-goals-state">
        <span>No goals yet</span>
        <p>Company goals will appear here after goals sync into the local workspace.</p>
      </div>
    {:else}
      <!-- DESKTOP-007: scan-friendly list + stable selected-goal detail (no card grid, no modal). -->
      <div
        class="list-detail goals-workspace"
        data-testid="goals-workspace"
        data-detail-open={selectedGoal != null ? 'true' : 'false'}
      >
        <aside class="list-pane goals-list-pane" data-testid="goals-list-pane">
          <div
            class="goals-list"
            role="listbox"
            tabindex="-1"
            aria-label="Company goals"
            data-testid="goals-list"
            onkeydown={handleListKeydown}
          >
            {#each objectives as objective (goalKey(objective))}
              {@const status = goalStatus(objective.status)}
              {@const key = goalKey(objective)}
              {@const isSelected = selectedGoalId === key}
              <button
                type="button"
                class="goal-list-row"
                class:is-selected={isSelected}
                class:at-risk={status.atRisk}
                role="option"
                aria-selected={isSelected}
                tabindex={isSelected ? 0 : -1}
                data-testid="goal-list-row"
                data-goal-id={key}
                aria-label={`Goal ${objective.title || 'Untitled goal'}: ${status.label}`}
                onclick={() => selectGoal(objective)}
              >
                <span class={`status-dot ${status.tone}`} aria-hidden="true"></span>
                <span class="goal-row-copy title-stack">
                  <span class="goal-row-title">{objective.title || 'Untitled goal'}</span>
                  <span class="goal-row-meta">{goalListMeta(objective)}</span>
                </span>
              </button>
            {/each}
          </div>
        </aside>

        <div class="detail-pane goal-detail-pane" data-testid="goal-detail-pane">
          {#if selectedGoal && selectedStatus}
            <article
              class="goal-detail"
              class:at-risk={selectedStatus.atRisk}
              data-testid="goal-detail"
              aria-labelledby="goal-detail-title"
            >
              <header class="goal-detail-header">
                <button
                  type="button"
                  class="goal-detail-back"
                  data-testid="goal-detail-back"
                  aria-label="Back to goals list"
                  onclick={clearGoalSelection}
                >
                  Goals
                </button>
                <div class="goal-detail-heading title-stack">
                  <div class="goal-title-row">
                    <h3 id="goal-detail-title" data-testid="goal-detail-title">
                      {selectedGoal.title || 'Untitled goal'}
                    </h3>
                    <span class="goal-status" data-testid="goal-detail-status">
                      <span class={`status-dot ${selectedStatus.tone}`} aria-hidden="true"></span>
                      <span>{selectedStatus.label}</span>
                    </span>
                  </div>
                  <span class="goal-meta" data-testid="goal-detail-meta">
                    owner: {ownerLabel(selectedGoal.owner)} · target {quarterLabel(selectedGoal.timeframe) ?? '—'}
                  </span>
                </div>
              </header>

              {#if selectedGoal.description}
                <p class="goal-description" data-testid="goal-detail-description">
                  {selectedGoal.description}
                </p>
              {/if}

              <section class="goal-section" aria-label="Key results">
                <h4 class="section-label">Key results</h4>
                <table class="kr-table" data-testid="kr-table">
                  <thead>
                    <tr>
                      <th>Key result</th>
                      <th>Current → target</th>
                      <th>Progress</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#if selectedGoal.keyResults.length === 0}
                      <tr>
                        <td class="kr-empty" colspan="3">No key results yet</td>
                      </tr>
                    {:else}
                      {#each selectedGoal.keyResults as kr, index (kr.id || `${selectedGoal.id}-${index}`)}
                        {@const progress = krProgress(kr)}
                        <tr data-testid="kr-row">
                          <td>{keyResultName(kr)}</td>
                          <td class="kr-value">
                            {formatValue(kr.current, kr.unit)} → {formatValue(kr.target, kr.unit)}
                          </td>
                          <td>
                            <span class="kr-progress" aria-label={`${progress}% progress`}>
                              <span class="progress-track" aria-hidden="true">
                                <span class="progress-fill" style={`width: ${progress}%`}></span>
                              </span>
                              <span>{progress}%</span>
                            </span>
                          </td>
                        </tr>
                      {/each}
                    {/if}
                  </tbody>
                </table>
              </section>

              {#if selectedStatus.atRisk}
                <div class="risk-row" data-testid="at-risk-note">
                  <span class="status-dot warn" aria-hidden="true"></span>
                  <span>{riskNote(selectedGoal)}</span>
                  <button
                    type="button"
                    class="review-proposal-button"
                    data-testid="review-proposal-button"
                    onclick={() => reviewProposal(selectedGoal)}
                    disabled={actionBusy !== null}
                  >
                    {actionBusy === `review-${selectedGoal.id || selectedGoal.title}` ? 'Opening…' : 'Review proposal'}
                  </button>
                </div>
              {/if}

              <footer class="linked-row" data-testid="linked-projects-section">
                <span class="section-label">Linked projects</span>
                <div class="project-chips" data-testid="linked-projects">
                  {#if selectedLinked.length === 0}
                    <span class="muted-chip">None</span>
                  {:else}
                    {#each selectedLinked.slice(0, 3) as project (project.id)}
                      <button
                        type="button"
                        class="project-chip"
                        data-testid="linked-project-chip"
                        onclick={() => openProject(project)}
                      >
                        {projectDisplayName(project)}
                      </button>
                    {/each}
                    {#if overflowCount(selectedLinked) > 0}
                      <span class="muted-chip">+{overflowCount(selectedLinked)}</span>
                    {/if}
                  {/if}
                </div>
              </footer>
            </article>
          {:else}
            <div class="goal-detail-empty" data-testid="goal-detail-empty">
              <span>Select a goal</span>
              <p>Choose a goal from the list to inspect key results and linked projects.</p>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <p class="goals-footnote">
      Goals are objectives with measurable key results. Projects ladder up to goals; progress rolls up automatically.
    </p>
  {/if}
</section>

<style>
  .company-goals {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-4);
    min-width: 0;
    min-height: 0;
    height: 100%;
    background: transparent;
    color: var(--v4-text-1);
    font-family: var(--font-sans);
  }

  .goals-header {
    display: flex;
    flex: 0 0 auto;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--v4-space-4);
    min-width: 0;
  }

  .goals-heading {
    display: grid;
    min-width: 0;
    gap: var(--v4-row-stack-gap, 3px);
  }

  .title-stack {
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
  }

  .goals-heading h2 {
    margin: 0;
    color: var(--v4-text-1);
    font-size: var(--type-section, var(--text-section));
    font-weight: 600;
    line-height: 1.2;
  }

  .goals-sub,
  .goals-footnote {
    margin: 0;
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 400;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .goal-actions {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 10px;
  }

  .action-status {
    max-width: 160px;
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .new-goal-button {
    flex: 0 0 auto;
    height: 30px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    font: inherit;
    font-size: var(--type-body, var(--text-base));
    font-weight: 500;
    line-height: 30px;
    cursor: pointer;
  }

  .new-goal-button:focus-visible,
  .review-proposal-button:focus-visible,
  .project-chip:focus-visible,
  .goal-list-row:focus-visible,
  .goal-detail-back:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }

  .new-goal-button:disabled,
  .review-proposal-button:disabled {
    opacity: 0.52;
    cursor: default;
  }

  .goals-error {
    flex: 0 0 auto;
    padding: 10px 12px;
    border: 1px solid var(--v4-warn);
    border-radius: var(--v4-radius-field);
    background: transparent;
    color: var(--v4-warn);
    font-size: var(--type-body, var(--text-base));
    font-weight: 400;
    line-height: 1.35;
  }

  /* DESKTOP-007 workspace: naked canvas, hairline list/detail split */
  .goals-workspace {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    border: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: transparent;
  }

  .goals-list-pane {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--v4-hairline);
    background: transparent;
  }

  .goals-list {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    overflow-y: auto;
    padding: 6px;
  }

  .goal-list-row {
    display: grid;
    grid-template-columns: 8px minmax(0, 1fr);
    align-items: start;
    gap: 10px;
    width: 100%;
    min-height: 48px;
    padding: 8px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-body, var(--text-base));
    text-align: left;
    cursor: pointer;
    transition: background 140ms ease;
  }

  .goal-list-row:hover {
    background: var(--v4-active-row);
  }

  .goal-list-row.is-selected {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .goal-row-copy {
    min-width: 0;
  }

  .goal-row-title {
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    font-weight: 500;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .goal-row-meta {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .goal-detail-pane {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: transparent;
  }

  .goal-detail {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-4);
    min-width: 0;
    min-height: 0;
    height: 100%;
    padding: var(--v4-space-4);
    overflow-y: auto;
    background: transparent;
  }

  .goal-detail-header {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2);
    min-width: 0;
  }

  .goal-detail-back {
    display: none;
    align-self: flex-start;
    min-height: 24px;
    padding: 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 500;
    cursor: pointer;
  }

  .goal-detail-back:hover {
    border-color: var(--v4-control-border);
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .goal-detail-heading {
    min-width: 0;
  }

  .goal-title-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .goal-title-row h3 {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-detail, var(--text-lg));
    font-weight: 600;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .goal-status {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
    line-height: 1.2;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .goal-meta {
    color: var(--v4-text-3);
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 400;
    line-height: 1.3;
  }

  .goal-description {
    margin: 0;
    color: var(--v4-text-2);
    font-size: var(--type-body, var(--text-base));
    font-weight: 400;
    line-height: 1.45;
  }

  .goal-section {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2);
    min-width: 0;
    padding-top: var(--v4-space-2);
    border-top: 1px solid var(--v4-hairline);
  }

  .section-label {
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .status-dot {
    width: 6px;
    height: 6px;
    flex: 0 0 auto;
    margin-top: 5px;
    border-radius: var(--v4-radius-pill);
  }

  .goal-status .status-dot,
  .risk-row .status-dot {
    margin-top: 0;
  }

  .status-dot.ok {
    background: var(--v4-ok);
  }

  .status-dot.warn {
    background: var(--v4-warn);
  }

  .status-dot.error {
    background: var(--v4-error);
  }

  .status-dot.idle {
    background: var(--v4-idle);
  }

  .kr-table {
    width: 100%;
    min-width: 0;
    border-collapse: collapse;
    table-layout: fixed;
  }

  .kr-table th {
    padding: 0 0 8px;
    border-bottom: 1px solid var(--v4-rowline);
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
    line-height: 1.2;
    text-align: left;
    text-transform: uppercase;
  }

  .kr-table th:nth-child(1) {
    width: 48%;
  }

  .kr-table th:nth-child(2) {
    width: 28%;
  }

  .kr-table th:nth-child(3) {
    width: 24%;
  }

  .kr-table td {
    height: 34px;
    padding: 8px 12px 8px 0;
    border-bottom: 1px solid var(--v4-rowline);
    overflow: hidden;
    color: var(--v4-text-2);
    font-size: var(--type-body, var(--text-base));
    font-weight: 400;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: middle;
  }

  .kr-table td.kr-value {
    color: var(--v4-text-1);
  }

  .kr-table td.kr-empty {
    color: var(--v4-text-3);
    font-size: var(--type-body, var(--text-base));
    text-align: center;
  }

  .kr-progress {
    display: grid;
    grid-template-columns: minmax(48px, 100px) 34px;
    align-items: center;
    gap: 8px;
    color: var(--v4-text-2);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
  }

  .progress-track {
    height: 3px;
    overflow: hidden;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
  }

  .progress-fill {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--v4-text-2);
  }

  .risk-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    padding: 8px 0;
    border-top: 1px solid var(--v4-hairline);
    color: var(--v4-text-2);
    font-size: var(--type-body, var(--text-base));
    font-weight: 400;
    line-height: 1.25;
  }

  .risk-row span:nth-child(2) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .review-proposal-button {
    flex: 0 0 auto;
    margin-left: auto;
    padding: 0 8px;
    min-height: 24px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 500;
    cursor: pointer;
  }

  .review-proposal-button:hover:not(:disabled) {
    border-color: var(--v4-control-border);
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .linked-row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    padding-top: var(--v4-space-2);
    border-top: 1px solid var(--v4-hairline);
  }

  .project-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
  }

  .project-chip,
  .muted-chip {
    display: inline-flex;
    max-width: 220px;
    align-items: center;
    height: 22px;
    padding: 0 8px;
    overflow: hidden;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 400;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-chip {
    cursor: pointer;
  }

  .project-chip:hover {
    color: var(--v4-text-1);
  }

  .goal-detail-empty,
  .empty-state {
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: center;
    justify-content: center;
    min-height: 160px;
    padding: 28px 20px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-3);
    font-size: var(--type-body, var(--text-base));
    font-weight: 400;
    line-height: 1.35;
    text-align: center;
  }

  .empty-state {
    border: 1px dashed var(--v4-hairline);
  }

  .goal-detail-empty span,
  .empty-state span {
    color: var(--v4-text-2);
    font-size: var(--type-body, var(--text-base));
    font-weight: 500;
  }

  .goal-detail-empty p,
  .empty-state p {
    margin: 0;
  }

  .goals-loading {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    padding: 6px 0;
  }

  .goal-skeleton {
    height: 48px;
    border: 0;
    border-radius: 6px;
    background: var(--v4-control-faint);
    animation: goals-skeleton-pulse 1.3s ease-in-out infinite;
  }

  .goals-footnote {
    flex: 0 0 auto;
  }

  @keyframes goals-skeleton-pulse {
    0%,
    100% {
      opacity: 0.5;
    }
    50% {
      opacity: 1;
    }
  }

  @media (max-width: 820px) {
    /* When detail is open, shared .list-detail hides the list pane.
       Surface a back control so the list remains reachable. */
    .goals-workspace[data-detail-open='true'] .goal-detail-back {
      display: inline-flex;
      align-items: center;
    }

    .linked-row {
      align-items: flex-start;
      flex-direction: column;
    }
  }

  @media (max-width: 720px) {
    .goals-header {
      align-items: stretch;
      flex-direction: column;
    }

    .new-goal-button,
    .goal-actions {
      width: 100%;
    }

    .goal-title-row {
      align-items: flex-start;
      flex-direction: column;
      gap: 4px;
    }

    .kr-table {
      display: block;
      overflow-x: auto;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .goal-skeleton {
      animation: none;
    }

    .goal-list-row {
      transition: none;
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    .company-goals,
    .goals-workspace,
    .goals-list-pane,
    .goal-detail-pane,
    .goal-detail {
      background: var(--v4-ground);
    }

    .goal-list-row.is-selected,
    .goal-list-row:hover {
      background: var(--v4-control-faint);
    }
  }
</style>
