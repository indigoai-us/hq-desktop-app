<script lang="ts">
  /**
   * Company Projects — portfolio Kanban (DESKTOP-004).
   *
   * Defaults to a four-column board: Not started · In progress · Active · Complete.
   * Active requires a live execution signal from the sessions store; board.json
   * "active" alone is In progress. Board/List, search, state filter, and owner
   * filter share one control row; New project remains the primary action.
   */
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { buildClaudeCodeUrl } from '../../lib/claude-code-link';
  import {
    loadCompanyGoals,
    loadLocalProjects,
    loadLocalProjectStories,
    type Objective,
  } from '../lib/local-projects';
  import {
    compareProjectsByRecency,
    groupProjectsByPortfolioColumn,
    matchesPortfolioStateFilter,
    portfolioColumn,
    portfolioStateContext,
    projectDisplayName,
    projectLiveRunView,
    projectProgress,
    PORTFOLIO_COLUMNS,
    PORTFOLIO_COLUMN_CAPTION,
    PORTFOLIO_COLUMN_LABEL,
    PORTFOLIO_STATE_FILTER_OPTIONS,
    type PortfolioColumn,
    type PortfolioStateFilter,
    type PortfolioViewMode,
    type Project,
    type Story,
  } from '../lib/projects-model';
  import { relativeActivity } from '../lib/sessions';
  import { sessionsStore, startSessionsStore } from '../lib/sessions-store.svelte';
  import ProjectDetailView from './ProjectDetailView.svelte';
  import ProjectRow from '../components/ProjectRow.svelte';
  import '../v4/tokens.css';

  interface Props {
    slug: string;
    onnewproject?: () => void | Promise<void>;
  }

  /** Legacy cycle filter kept for needs-link + work-actions contracts. */
  type ProjectFilter = 'all' | 'active' | 'needs-link';

  let { slug, onnewproject }: Props = $props();

  let objectives = $state<Objective[]>([]);
  let projects = $state<Project[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  /** Free-text filter over project name/description. */
  let searchQuery = $state('');
  /** Portfolio state filter (All states / column). */
  let stateFilter = $state<PortfolioStateFilter>('all');
  /** Owner filter — empty string means Anyone. */
  let ownerFilter = $state('');
  /** Board is the DESKTOP-004 default. */
  let viewMode = $state<PortfolioViewMode>('board');
  /**
   * Legacy projectFilter still supports the needs-link cycle used by Link goal
   * empty-state contracts and company-work-actions.
   */
  let projectFilter = $state<ProjectFilter>('all');
  let actionBusy = $state<string | null>(null);
  let actionMessage = $state<string | null>(null);
  let selected = $state<Project | null>(null);
  let stories = $state<Story[]>([]);
  let storiesLoading = $state(false);
  let storiesError = $state<string | null>(null);
  let selectedStoryId = $state<string | null>(null);
  /**
   * The workspace list is refreshed in the background and may re-deliver the
   * same company slug through props. Keep the open project/task workspace in
   * place for those same-company refreshes; only a real company change should
   * reset local navigation.
   */
  let loadedSlug: string | null = null;
  // project board-id / prdPath → creator (display name). Best-effort, from the
  // cloud board; empty when unavailable so Lead falls back to "Unassigned".
  let creatorByKey = $state<Record<string, string>>({});
  let now = $state(Date.now());

  onMount(() => {
    startSessionsStore();
    const tick = setInterval(() => {
      now = Date.now();
    }, 15_000);
    return () => clearInterval(tick);
  });

  const companyProjects = $derived(
    projects
      .filter((project) => project.company === slug)
      .sort(compareProjectsByRecency),
  );

  const sessions = $derived(sessionsStore.sessions);

  function leadLabel(project: Project): string {
    const byId = creatorByKey[project.id];
    if (byId) return byId;
    const byPath = project.prdPath ? creatorByKey[project.prdPath] : undefined;
    return byPath ?? 'Unassigned';
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

  function projectMatchesObjective(project: Project, objective: Objective): boolean {
    const ids = objectiveIds(objective);
    if (ids.size === 0) return false;
    return projectTokens(project).some((token) => ids.has(token));
  }

  function projectLinkedToAnyGoal(project: Project): boolean {
    return objectives.some((objective) => projectMatchesObjective(project, objective));
  }

  function linkedGoalLabel(project: Project): string | null {
    const goal = objectives.find((objective) => projectMatchesObjective(project, objective));
    if (!goal) return null;
    return goal.title || goal.id || null;
  }

  function resolveColumn(project: Project): PortfolioColumn {
    // Active only when projectLiveRunView finds a real live session signal.
    return portfolioColumn(project, projectLiveRunView(project, sessions, now) !== null);
  }

  function matchesProjectFilter(project: Project, filter: ProjectFilter): boolean {
    if (filter === 'needs-link') return !projectLinkedToAnyGoal(project);
    if (filter === 'active') {
      const col = resolveColumn(project);
      return col === 'active' || col === 'in-progress';
    }
    return true;
  }

  function filterLabel(filter: ProjectFilter): string {
    if (filter === 'active') return 'Active';
    if (filter === 'needs-link') return 'Needs link';
    return 'All';
  }

  function cycleFilter() {
    projectFilter =
      projectFilter === 'all' ? 'active' : projectFilter === 'active' ? 'needs-link' : 'all';
  }

  const ownerOptions = $derived.by(() => {
    const names = new Set<string>();
    for (const project of companyProjects) {
      const lead = leadLabel(project);
      if (lead && lead !== 'Unassigned') names.add(lead);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  });

  const filteredCompanyProjects = $derived(
    companyProjects.filter((project) => {
      if (!matchesProjectFilter(project, projectFilter)) return false;
      const col = resolveColumn(project);
      if (!matchesPortfolioStateFilter(col, stateFilter)) return false;
      if (ownerFilter && leadLabel(project) !== ownerFilter) return false;
      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;
      const name = projectDisplayName(project).toLowerCase();
      const desc = (project.description ?? '').toLowerCase();
      return name.includes(q) || desc.includes(q) || project.id.toLowerCase().includes(q);
    }),
  );

  const portfolioGroups = $derived(
    groupProjectsByPortfolioColumn(filteredCompanyProjects, sessions),
  );

  const liveCount = $derived(portfolioGroups.active.length);

  const selectedStory = $derived(
    selectedStoryId === null
      ? null
      : (stories.find((story) => story.id === selectedStoryId) ?? null),
  );

  $effect(() => {
    const activeSlug = slug;
    error = null;
    const companyChanged = loadedSlug !== activeSlug;
    loadedSlug = activeSlug;

    if (companyChanged) {
      objectives = [];
      projects = [];
      selected = null;
      stories = [];
      storiesError = null;
      selectedStoryId = null;
      creatorByKey = {};
    }

    if (!activeSlug) {
      loading = false;
      return;
    }

    loading = true;
    let cancelled = false;

    // Best-effort, decoupled from the gating load below: a creators fetch must
    // never error the Projects page or block it — the Lead column simply stays
    // "Unassigned" if it fails or the board isn't reachable.
    void invoke<Array<{ id: string; prdPath?: string | null; creator: string }>>(
      'get_company_project_creators',
      { slug: activeSlug },
    )
      .then((rows) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const row of rows ?? []) {
          if (!row?.creator) continue;
          if (row.id) map[row.id] = row.creator;
          if (row.prdPath) map[row.prdPath] = row.creator;
        }
        creatorByKey = map;
      })
      .catch((err) => {
        console.warn(`get_company_project_creators(${activeSlug}) failed:`, err);
      });

    void (async () => {
      try {
        const [goals, allProjects] = await Promise.all([
          loadCompanyGoals(activeSlug),
          loadLocalProjects(),
        ]);
        if (cancelled) return;
        objectives = goals.objectives;
        projects = allProjects;
        if (!companyChanged && selected) {
          selected = allProjects.find((project) => project.id === selected?.id) ?? selected;
        }
      } catch (err) {
        console.error('CompanyProjectsPage load failed:', err);
        if (!cancelled) {
          error = 'Projects unavailable. Try again after a sync.';
          objectives = [];
          projects = [];
        }
      } finally {
        if (!cancelled) loading = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  async function requestLinkProject(project: Project) {
    if (actionBusy) return;
    const prompt = [
      `/goals ${slug}`,
      '',
      `Link project "${projectDisplayName(project)}" to the right company goal.`,
      `Project id: ${project.id}`,
      project.prdPath ? `PRD: ${project.prdPath}` : null,
      objectives.length > 0
        ? ['Available goals:', ...objectives.map((goal) => `- ${goal.title || goal.id}`)].join('\n')
        : 'No goals are currently synced; create the right goal first if needed.',
      '',
      'Update the local goal/project metadata so this project appears under the correct goal in HQ.',
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
    actionBusy = `link-${project.id}`;
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

  // Real project start = its createdAt timestamp (when known), formatted as a
  // short calendar date — not a weekday hashed from the project id.
  function formatProjectDate(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return null;
    return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function listUpdatedLabel(project: Project): string {
    const iso = project.updatedAt || project.createdAt;
    if (!iso) return '—';
    // Prefer compact relative when sessions helper can parse it; else short date.
    const rel = relativeActivity(iso, now);
    if (rel !== '—') return rel;
    return formatProjectDate(iso) ?? '—';
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

  function openProjectFromKey(event: KeyboardEvent, project: Project): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    void openProject(project);
  }

  function backToProjects(): void {
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

<section class="company-projects" aria-labelledby="company-projects-title" data-testid="company-projects-page">
  {#if selected}
    <ProjectDetailView
      project={selected}
      {stories}
      {storiesLoading}
      {storiesError}
      objectives={objectives}
      onback={backToProjects}
      onselectStory={openStory}
      onStatusChange={onProjectStatusChange}
      selectedStory={selectedStory}
      oncloseStory={closeStory}
      onselectDependency={selectStoryById}
      {onStoryPassesChange}
    />
  {:else}
    <header class="projects-header">
      <div class="projects-heading">
        <h2 id="company-projects-title">Projects</h2>
        <span>
          {filteredCompanyProjects.length} of {companyProjects.length}
          {companyProjects.length === 1 ? ' project' : ' projects'}
          {#if liveCount > 0}
            · {liveCount} live
          {/if}
          · stories live here (no separate Tasks tab)
        </span>
      </div>
      <div class="project-actions detail-primary-actions" aria-label="Project actions">
        {#if actionMessage}
          <span class="action-status" role="status">{actionMessage}</span>
        {/if}
        <button type="button" class="primary-action" onclick={() => void onnewproject?.()}>
          New project
        </button>
      </div>
    </header>

    <div class="portfolio-tools" data-testid="portfolio-tools">
      <label class="project-search">
        <span class="visually-hidden">Search projects</span>
        <input
          type="search"
          placeholder="Search projects…"
          bind:value={searchQuery}
          data-testid="project-search"
        />
      </label>

      <label class="tool-select">
        <span class="visually-hidden">Filter by state</span>
        <select
          bind:value={stateFilter}
          data-testid="portfolio-state-filter"
          aria-label="Filter by project state"
        >
          {#each PORTFOLIO_STATE_FILTER_OPTIONS as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      </label>

      <label class="tool-select">
        <span class="visually-hidden">Filter by owner</span>
        <select
          bind:value={ownerFilter}
          data-testid="portfolio-owner-filter"
          aria-label="Filter by project owner"
        >
          <option value="">Owner · Anyone</option>
          {#each ownerOptions as owner (owner)}
            <option value={owner}>{owner}</option>
          {/each}
        </select>
      </label>

      <!-- Legacy cycle filter (All / Active / Needs link) for link handoff + contracts. -->
      <button
        type="button"
        class="tool-button"
        data-testid="portfolio-legacy-filter"
        onclick={cycleFilter}
      >
        Filter: {filterLabel(projectFilter)}
      </button>

      <div class="view-toggle" role="group" aria-label="Project view">
        <button
          type="button"
          class="toggle-segment"
          class:is-active={viewMode === 'board'}
          aria-pressed={viewMode === 'board'}
          data-testid="view-toggle-board"
          onclick={() => (viewMode = 'board')}
        >
          Board
        </button>
        <button
          type="button"
          class="toggle-segment"
          class:is-active={viewMode === 'list'}
          aria-pressed={viewMode === 'list'}
          data-testid="view-toggle-list"
          onclick={() => (viewMode = 'list')}
        >
          List
        </button>
      </div>
    </div>

    {#if error}
      <div class="projects-error" role="alert">{error}</div>
    {/if}

    <div class="portfolio-body" aria-busy={loading}>
      {#if loading}
        <div class="board-loading" aria-busy="true" aria-label="Loading projects">
          {#each PORTFOLIO_COLUMNS as column (column)}
            <div class="skeleton-column">
              <div class="skeleton-header"></div>
              <div class="skeleton-card"></div>
              <div class="skeleton-card"></div>
            </div>
          {/each}
        </div>
      {:else if companyProjects.length === 0}
        <div class="empty-state" data-testid="empty-projects-state">
          <span>No projects yet</span>
          <p>Projects will appear here after they sync into the local workspace.</p>
        </div>
      {:else if filteredCompanyProjects.length === 0}
        <div class="empty-state" data-testid="filtered-projects-empty-state">
          <span>No projects match the current filters</span>
          <p>
            {#if projectFilter === 'needs-link'}
              No projects match {filterLabel(projectFilter).toLowerCase()}.
            {:else}
              Change the state, owner, or search filters to see more projects.
            {/if}
          </p>
        </div>
      {:else if viewMode === 'board'}
        <div
          class="kanban-board"
          data-testid="portfolio-kanban"
          aria-label="Projects by operational state"
        >
          {#each PORTFOLIO_COLUMNS as column (column)}
            {@const columnProjects = portfolioGroups[column]}
            <section
              class="kanban-column"
              data-testid={`portfolio-column-${column}`}
              aria-labelledby={`portfolio-col-${column}`}
            >
              <header class="kanban-column-head">
                <span class="kanban-column-title" id={`portfolio-col-${column}`}>
                  {#if column === 'active'}
                    <span class="live-dot" aria-hidden="true"></span>
                  {/if}
                  {PORTFOLIO_COLUMN_LABEL[column]}
                  <span class="kanban-column-count">{columnProjects.length}</span>
                </span>
                <span class="kanban-column-caption">{PORTFOLIO_COLUMN_CAPTION[column]}</span>
              </header>
              <div class="kanban-stack">
                {#if columnProjects.length === 0}
                  <div class="column-empty">
                    <span>No projects</span>
                  </div>
                {:else}
                  {#each columnProjects as project (project.id)}
                    {@const liveRun = projectLiveRunView(project, sessions, now)}
                    {@const goal = linkedGoalLabel(project)}
                    <ProjectRow
                      {project}
                      showCompany={false}
                      goalLabel={goal}
                      ownerLabel={leadLabel(project)}
                      liveRun={column === 'active' ? liveRun : null}
                      stateContext={portfolioStateContext(column, project)}
                      {now}
                      onselect={(p) => void openProject(p)}
                      onlinkgoal={!goal ? requestLinkProject : undefined}
                      linkBusy={actionBusy === `link-${project.id}`}
                    />
                  {/each}
                {/if}
              </div>
            </section>
          {/each}
        </div>
      {:else}
        <div class="project-list-surface" data-testid="portfolio-list" aria-label="Projects list">
          <div class="project-table-head">
            <span>Project</span>
            <span>Goal</span>
            <span>Owner</span>
            <span>Tasks</span>
            <span>Updated</span>
          </div>
          {#each PORTFOLIO_COLUMNS as column (column)}
            {@const columnProjects = portfolioGroups[column]}
            {#if columnProjects.length > 0}
              <div class="project-group-label">
                <span>{PORTFOLIO_COLUMN_LABEL[column]}</span>
                <span class="group-count">{columnProjects.length}</span>
              </div>
              {#each columnProjects as project (project.id)}
                {@const progress = projectProgress(project.storiesComplete, project.storiesTotal)}
                {@const goal = linkedGoalLabel(project)}
                <div
                  class="project-list-row"
                  data-testid="project-row"
                  role="button"
                  tabindex="0"
                  onclick={() => void openProject(project)}
                  onkeydown={(event) => openProjectFromKey(event, project)}
                >
                  <div class="project-name-cell">
                    <strong class="list-name">{projectDisplayName(project)}</strong>
                    <span class="list-desc">
                      {project.description ||
                        (project.createdAt
                          ? `started ${formatProjectDate(project.createdAt)}`
                          : '—')}
                      {#if !goal}
                        <button
                          type="button"
                          class="link-nudge"
                          onclick={(event) => {
                            event.stopPropagation();
                            void requestLinkProject(project);
                          }}
                          disabled={actionBusy !== null}
                        >
                          {actionBusy === `link-${project.id}` ? 'Opening…' : 'Link'}
                        </button>
                      {/if}
                    </span>
                  </div>
                  <div class="list-goal">{goal ?? '—'}</div>
                  <div class="list-owner">{leadLabel(project)}</div>
                  <div class="list-progress" aria-label={`${progress.percent}% complete`}>
                    <span class="progress-copy">
                      <span>{progress.complete} / {progress.total}</span>
                      <span>{progress.percent}%</span>
                    </span>
                    <span class="mini-progress" aria-hidden="true">
                      <span style={`width: ${progress.percent}%`}></span>
                    </span>
                  </div>
                  <div class="list-updated">{listUpdatedLabel(project)}</div>
                </div>
              {/each}
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .company-projects {
    container: company-projects / inline-size;
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-4, 12px);
    min-width: 0;
    height: 100%;
    color: var(--v4-text-1);
    font-family: var(--font-sans);
    /* Naked main canvas — no raised outer well. */
    background: transparent;
  }

  .projects-header,
  .projects-heading,
  .project-actions,
  .portfolio-tools {
    display: flex;
    align-items: center;
    min-width: 0;
  }

  .projects-header {
    justify-content: space-between;
    gap: var(--v4-space-5, 16px);
    flex-shrink: 0;
  }

  .projects-heading {
    align-items: baseline;
    gap: 9px;
  }

  .projects-heading h2 {
    margin: 0;
    color: var(--v4-text-1);
    font-size: var(--type-detail, var(--text-lg, 18px));
    font-weight: 600;
    line-height: 1.15;
  }

  .projects-heading span {
    color: var(--v4-text-3);
    font-size: var(--type-body, var(--text-base, 12px));
    line-height: 1.25;
  }

  .project-actions {
    flex: 0 0 auto;
    gap: 12px;
    align-items: center;
  }

  .action-status {
    max-width: 150px;
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .primary-action {
    height: 28px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    font: inherit;
    font-size: var(--type-body, 12px);
    cursor: default;
  }

  .portfolio-tools {
    flex-shrink: 0;
    flex-wrap: wrap;
    gap: 8px;
    min-height: 36px;
  }

  .project-search input,
  .tool-select select,
  .tool-button {
    height: 28px;
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-button);
    background: var(--v4-secondary-bg);
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-body, 12px);
  }

  .project-search input {
    min-width: 140px;
    max-width: 220px;
    padding: 0 10px;
  }

  .project-search input::placeholder {
    color: var(--v4-text-3);
  }

  .tool-select select,
  .tool-button {
    padding: 0 10px;
    color: var(--v4-secondary-fg);
    cursor: default;
  }

  .view-toggle {
    display: inline-flex;
    gap: 2px;
    margin-left: auto;
    padding: 2px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
  }

  .toggle-segment {
    display: inline-flex;
    align-items: center;
    padding: 4px 10px;
    border: 0;
    border-radius: calc(var(--v4-radius-button) - 2px);
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-body, 12px);
    font-weight: 600;
    cursor: pointer;
  }

  .toggle-segment:hover {
    color: var(--v4-text-1);
  }

  .toggle-segment.is-active {
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
  }

  .toggle-segment:focus-visible,
  .primary-action:focus-visible,
  .tool-button:focus-visible,
  .project-search input:focus-visible,
  .tool-select select:focus-visible {
    outline: 2px solid var(--v4-control-border);
    outline-offset: 2px;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .portfolio-body {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
  }

  /* Naked board canvas — columns use whitespace + hairlines, not rounded wells. */
  .kanban-board {
    display: grid;
    grid-template-columns: repeat(4, minmax(205px, 1fr));
    gap: 12px;
    min-width: 0;
    height: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    background: transparent;
  }

  .kanban-column {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-width: 205px;
    min-height: 0;
    border-radius: 0;
    background: transparent;
  }

  .kanban-column-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--v4-row-stack-gap, 3px);
    min-height: 36px;
    padding: 0 4px 8px;
    border-bottom: 1px solid var(--v4-hairline);
  }

  .kanban-column-title {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--v4-text-2);
    font-size: var(--type-secondary, 11px);
    font-weight: 600;
    line-height: 1.2;
  }

  .kanban-column-count {
    display: inline-grid;
    place-items: center;
    min-width: 17px;
    height: 17px;
    padding: 0 5px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
    color: var(--v4-text-3);
    font-family: var(--font-mono);
    font-size: var(--type-metadata, 10px);
    font-variant-numeric: tabular-nums;
  }

  .kanban-column-caption {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .live-dot {
    width: 6px;
    height: 6px;
    flex: 0 0 auto;
    border-radius: 999px;
    background: var(--v4-ok);
  }

  .kanban-stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    margin-top: 10px;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 0 2px 4px;
  }

  .column-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 64px;
    padding: 12px;
    border: 1px dashed var(--v4-hairline);
    border-radius: 0;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
  }

  /* List surface — hairline table, no giant rounded well. */
  .project-list-surface {
    min-width: 0;
    overflow: auto;
    border-top: 1px solid var(--v4-hairline);
    background: transparent;
  }

  .project-table-head,
  .project-list-row {
    display: grid;
    grid-template-columns: minmax(200px, 1.4fr) minmax(110px, 0.7fr) 88px 120px 72px;
    align-items: center;
    gap: 12px;
    min-width: 680px;
    padding: 0 4px;
  }

  .project-table-head {
    min-height: 30px;
    border-bottom: 1px solid var(--v4-hairline);
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .project-group-label {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    padding: 0 4px;
    border-bottom: 1px solid var(--v4-rowline);
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .group-count {
    display: inline-grid;
    place-items: center;
    min-width: 17px;
    height: 17px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
    color: var(--v4-text-3);
    font-variant-numeric: tabular-nums;
  }

  .project-list-row {
    min-height: 52px;
    border-bottom: 1px solid var(--v4-rowline);
    color: var(--v4-text-2);
    font-size: var(--type-body, 12px);
    cursor: pointer;
  }

  .project-list-row:hover {
    background: var(--v4-active-row);
  }

  .project-list-row:focus-visible {
    outline: 2px solid var(--v4-control-border);
    outline-offset: -2px;
  }

  .project-name-cell {
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
  }

  .list-name {
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, 12px);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .list-desc,
  .list-goal,
  .list-owner,
  .list-updated {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .list-desc {
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .list-progress {
    display: grid;
    gap: 5px;
    min-width: 0;
  }

  .progress-copy {
    display: flex;
    justify-content: space-between;
    color: var(--v4-text-3);
    font-family: var(--font-mono);
    font-size: var(--type-metadata, 10px);
  }

  .mini-progress {
    height: 3px;
    overflow: hidden;
    border-radius: 3px;
    background: var(--v4-control-faint);
  }

  .mini-progress span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--v4-text-2);
  }

  .link-nudge {
    height: 18px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-secondary, 11px);
    cursor: default;
  }

  .link-nudge:disabled {
    opacity: 0.52;
  }

  .projects-error,
  .empty-state {
    padding: 12px;
    border: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-2);
    font-size: var(--type-body, 12px);
  }

  .empty-state span {
    display: block;
    color: var(--v4-text-1);
    font-size: var(--type-section, 14px);
  }

  .empty-state p {
    margin: 4px 0 0;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
  }

  .board-loading {
    display: grid;
    grid-template-columns: repeat(4, minmax(205px, 1fr));
    gap: 12px;
    min-width: 0;
  }

  .skeleton-column {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .skeleton-header {
    height: 28px;
    border-radius: 0;
    background: var(--v4-control-faint);
    opacity: 0.48;
  }

  .skeleton-card {
    height: 96px;
    border: 1px solid var(--v4-hairline);
    border-radius: 6px;
    background: var(--v4-control-faint);
    opacity: 0.48;
  }

  @media (prefers-reduced-motion: reduce) {
    .toggle-segment {
      transition: none;
    }
  }

  @container company-projects (max-width: 760px) {
    .projects-header {
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
    }

    .projects-heading {
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
    }

    .project-actions {
      flex-wrap: wrap;
      gap: 8px;
    }

    .action-status {
      flex: 1 1 100%;
      max-width: 100%;
      white-space: normal;
    }

    .portfolio-tools {
      align-items: stretch;
    }

    .view-toggle {
      margin-left: 0;
    }

    .project-search input {
      max-width: none;
      width: 100%;
    }

    /* Board may horizontal-scroll; primary tools stay visible above. */
    .kanban-board,
    .board-loading {
      grid-template-columns: repeat(4, minmax(205px, 1fr));
    }

    .project-table-head {
      display: none;
    }

    .project-table-head,
    .project-list-row {
      grid-template-columns: minmax(0, 1fr);
      min-width: 0;
      row-gap: 6px;
      padding: 10px 0;
    }

    .list-progress,
    .list-goal,
    .list-owner,
    .list-updated {
      min-width: 0;
    }
  }
</style>
