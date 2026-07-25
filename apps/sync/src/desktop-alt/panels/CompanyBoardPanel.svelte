<script lang="ts">
  /**
   * CompanyBoardPanel — the per-company Overview board (US-011 + DESKTOP-003).
   *
   * Scoped to ONE company. Canvas order (actionable, not dashboard-y):
   *   1. Compact pulse row — real project / story / AC / goal / cloud counts
   *   2. Needs you       — only real exceptions with review / inspect / connect
   *   3. In flight       — live / in-progress projects with goal + status
   *   4. Goals           — compact rows; zero-progress explains "No linked work"
   *   5. Recent activity — honest vault activity + Open inbox
   *
   * Selecting a project drills into ProjectDetailView → StoryKanban → StoryPanel.
   * Load convention: warm-read from company store, $effect keyed on slug with
   * cancel flag, error state. Main canvas is naked: whitespace + hairlines.
   */
  import {
    loadLocalProjects,
    loadLocalProjectStories,
    loadCompanyGoals,
    type Objective,
  } from '../lib/local-projects';
  import {
    classifyStories,
    projectDisplayName,
    projectListStatus,
    projectProgress,
    type Project,
    type Story,
    type StoryState,
  } from '../lib/projects-model';
  import { useCompanyBoard, type CompanyBoardCard } from '../lib/company-board.svelte';
  import { useCompanySummary } from '../lib/company-summary.svelte';
  import ProjectListView from '../components/ProjectListView.svelte';
  import ProjectDetailView from '../pages/ProjectDetailView.svelte';
  import GoalCard from '../v4/GoalCard.svelte';
  import NeedsYouCard from '../v4/NeedsYouCard.svelte';
  import OverviewActivityDigest from '../components/OverviewActivityDigest.svelte';
  import type { HomeCardModel } from '../v4/home-model';
  import '../v4/tokens.css';

  interface Props {
    /** The company/workspace slug this board is scoped to. */
    slug: string;
    /** False for local folders that are not cloud-backed yet. */
    cloudBacked?: boolean;
    /** Navigate to company Projects (toolbar + overview links). */
    onopenprojects?: () => void;
    /** Navigate to company Goals. */
    onopengoals?: () => void;
    /** Navigate to the global Inbox. */
    onopeninbox?: () => void;
  }

  let {
    slug,
    cloudBacked = true,
    onopenprojects,
    onopengoals,
    onopeninbox,
  }: Props = $props();

  interface InFlightDetail {
    storyTitle: string | null;
    priority: number | null;
    labels: string[];
    state: StoryState | null;
  }

  interface RowStatus {
    label: string;
    tone: 'ok' | 'warn' | 'error' | 'idle';
  }

  const summaryState = useCompanySummary({ slug: () => slug, enabled: () => cloudBacked });
  const boardState = useCompanyBoard({ slug: () => slug, enabled: () => cloudBacked });

  // ---- data (projects + goals), scoped to `slug` ---------------------------
  let projects = $state<Project[]>([]);
  let objectives = $state<Objective[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // ---- in-flight story details, loaded lazily per project ------------------
  // Keyed by project id. Best-effort: a failed load omits story metadata and
  // the table falls back to project-level progress.
  let inFlightStory = $state<Record<string, InFlightDetail>>({});

  // ---- drill-in state (mirrors the old BoardPage) --------------------------
  let selected = $state<Project | null>(null);
  let stories = $state<Story[]>([]);
  let storiesLoading = $state(false);
  let storiesError = $state<string | null>(null);

  let selectedStoryId = $state<string | null>(null);
  const selectedStory = $derived(
    selectedStoryId === null
      ? null
      : (stories.find((story) => story.id === selectedStoryId) ?? null),
  );

  // Projects already scoped to this company (the Rust command returns ALL
  // companies; we filter by slug here, exactly as the task specifies).
  const companyProjects = $derived(
    projects.filter((project) => project.company === slug),
  );

  // In-flight projects: rollup is in-progress or live, emphasised (live first).
  const inFlightProjects = $derived(
    companyProjects
      .filter((project) => {
        const status = projectListStatus(project);
        return status === 'live' || status === 'in-progress';
      })
      .sort((a, b) => {
        // live before in-progress, then by name.
        const rank = (p: Project) => (projectListStatus(p) === 'live' ? 0 : 1);
        return rank(a) - rank(b) || projectDisplayName(a).localeCompare(projectDisplayName(b));
      }),
  );

  const boardCards = $derived([
    ...boardState.board.inbox,
    ...boardState.board.doing,
    ...boardState.board.review,
    ...boardState.board.done,
  ]);

  const activeProjectCount = $derived(
    summaryState.summary.board > 0 ? summaryState.summary.board : inFlightProjects.length,
  );

  const storiesInProgress = $derived(
    boardState.board.doing.length + boardState.board.review.length || incompleteStoryCount(inFlightProjects),
  );

  const acPercent = $derived(projectsAcceptancePercent(companyProjects));
  const lastUpdated = $derived(lastUpdatedLabel(boardCards));
  const goalsCount = $derived(objectives.length);
  const projectPulseCount = $derived(
    summaryState.summary.board > 0 ? summaryState.summary.board : companyProjects.length,
  );

  /** Honest cloud label — never invents health beyond backed/error state. */
  const cloudPulse = $derived.by((): { label: string; tone: 'ok' | 'warn' | 'error' | 'idle' } => {
    if (!cloudBacked) return { label: 'local only', tone: 'idle' };
    if (error || boardState.error || summaryState.error) {
      return { label: 'cloud issue', tone: 'error' };
    }
    return { label: 'cloud connected', tone: 'ok' };
  });

  const unlinkedGoals = $derived(
    objectives.filter((objective) => linkedProjects(objective).length === 0),
  );

  /**
   * Needs-you queue from real board/goals/cloud conditions only.
   * Empty when nothing needs attention (no decorative placeholders).
   */
  const needsYouCards = $derived.by((): Array<HomeCardModel & { id: string }> => {
    const cards: Array<HomeCardModel & { id: string }> = [];
    const reviewCount = boardState.board.review.length;
    if (reviewCount > 0) {
      cards.push({
        id: 'review-board',
        title: `Review ${reviewCount} ${reviewCount === 1 ? 'story' : 'stories'} ready for review`,
        sub: 'Acceptance work is waiting on the company board',
        tone: 'warn',
        actions: [{ id: 'review', label: 'Review', kind: 'primary' }],
      });
    }
    if (error || boardState.error) {
      cards.push({
        id: 'board-error',
        title: 'Company board could not refresh',
        sub: error || boardState.error || 'Try again after a sync',
        tone: 'error',
        actions: [{ id: 'inspect', label: 'Inspect', kind: 'secondary' }],
      });
    }
    if (!cloudBacked) {
      cards.push({
        id: 'local-only',
        title: 'This company is local only',
        sub: 'Connect to cloud so synced board activity can appear',
        tone: 'warn',
        actions: [{ id: 'inspect-local', label: 'Inspect', kind: 'secondary' }],
      });
    }
    if (!loading && unlinkedGoals.length > 0) {
      cards.push({
        id: 'unlinked-goals',
        title:
          unlinkedGoals.length === 1
            ? 'Goal has no linked work'
            : `${unlinkedGoals.length} goals have no linked work`,
        sub: 'Connect active projects so progress can roll up',
        tone: 'neutral',
        actions: [{ id: 'connect', label: 'Connect', kind: 'primary' }],
      });
    }
    return cards;
  });

  // Load goals + projects whenever the company slug changes. Cancel-flag guards
  // against an out-of-order completion when the user switches companies fast.
  $effect(() => {
    const activeSlug = slug;
    projects = [];
    objectives = [];
    inFlightStory = {};
    error = null;
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
        const [allProjects, goals] = await Promise.all([
          loadLocalProjects(),
          loadCompanyGoals(activeSlug),
        ]);
        if (cancelled) return;
        projects = allProjects;
        objectives = goals.objectives;
      } catch (err) {
        console.error('CompanyBoardPanel load failed:', err);
        if (!cancelled) {
          error = 'Board unavailable. Try again after a sync.';
          projects = [];
          objectives = [];
        }
      } finally {
        if (!cancelled) loading = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  // Lazily load the in-flight projects' current story titles. Keyed on the set
  // of in-flight project prdPaths so it re-runs when the project set changes.
  $effect(() => {
    const targets = inFlightProjects.filter((project) => project.prdPath);
    if (targets.length === 0) return;

    let cancelled = false;
    for (const project of targets) {
      // Skip projects we've already resolved.
      if (project.id in inFlightStory) continue;
      void (async () => {
        try {
          const projectStories = await loadLocalProjectStories(project.prdPath);
          if (cancelled) return;
          const classified = classifyStories(projectStories);
          const current =
            classified.find((entry) => entry.state === 'in-progress') ??
            classified.find((entry) => entry.state === 'blocked') ??
            classified.find((entry) => entry.state === 'pending') ??
            null;
          inFlightStory = {
            ...inFlightStory,
            [project.id]: {
              storyTitle: current?.story.title ?? null,
              priority: current?.story.priority ?? null,
              labels: current?.story.labels ?? [],
              state: current?.state ?? null,
            },
          };
        } catch (err) {
          console.error('in-flight story load failed:', err);
          if (!cancelled) {
            inFlightStory = {
              ...inFlightStory,
              [project.id]: { storyTitle: null, priority: null, labels: [], state: null },
            };
          }
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  });

  // ---- overview helpers ----------------------------------------------------

  /** Coerce a loosely-typed KR value to a finite number, or null. */
  function looseNumber(value: number | string | null | undefined): number | null {
    if (value == null) return null;
    const n = typeof value === 'number' ? value : Number.parseFloat(value);
    return Number.isFinite(n) ? n : null;
  }

  function clampPercent(value: number): number {
    return Math.max(0, Math.min(100, Math.round(value)));
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
    const linearId = (objective as Objective & { linearInitiativeId?: string | null })
      .linearInitiativeId;
    const normalizedLinearId = normalizeId(linearId);
    if (normalizedLinearId) ids.add(normalizedLinearId);
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

  function objectiveForProject(project: Project): Objective | null {
    const tokens = projectTokens(project);
    return (
      objectives.find((objective) => {
        const ids = objectiveIds(objective);
        return tokens.some((token) => ids.has(token));
      }) ?? null
    );
  }

  function linkedProjects(objective: Objective): Project[] {
    const ids = objectiveIds(objective);
    if (ids.size === 0) return [];
    return companyProjects.filter((project) =>
      projectTokens(project).some((token) => ids.has(token)),
    );
  }

  function incompleteStoryCount(items: Project[]): number {
    return items.reduce(
      (sum, project) => sum + Math.max(0, project.storiesTotal - project.storiesComplete),
      0,
    );
  }

  function projectsAcceptancePercent(items: Project[]): number {
    const total = items.reduce((sum, project) => sum + project.storiesTotal, 0);
    if (total === 0) return 0;
    const complete = items.reduce((sum, project) => sum + project.storiesComplete, 0);
    return clampPercent((complete / total) * 100);
  }

  function objectiveProgress(objective: Objective): number {
    const krPercents = objective.keyResults
      .map((kr) => {
        const current = looseNumber(kr.current);
        const target = looseNumber(kr.target);
        if (current === null || target === null || target <= 0) return null;
        return clampPercent((current / target) * 100);
      })
      .filter((percent): percent is number => percent !== null);
    if (krPercents.length > 0) {
      return clampPercent(
        krPercents.reduce((sum, percent) => sum + percent, 0) / krPercents.length,
      );
    }
    return projectsAcceptancePercent(linkedProjects(objective));
  }

  function goalChip(project: Project): string {
    return objectiveForProject(project)?.title || '—';
  }

  function priorityLabel(priority: number | null | undefined): string {
    return priority === null || priority === undefined ? '—' : `P${priority}`;
  }

  function rowStatus(project: Project, detail: InFlightDetail | undefined): RowStatus {
    const raw = (project.status ?? '').toLowerCase();
    if (detail?.state === 'blocked' || raw.includes('gated') || raw.includes('blocked')) {
      return { label: 'Gated', tone: 'idle' };
    }
    if (raw.includes('review')) {
      return { label: 'Review', tone: 'warn' };
    }
    const status = projectListStatus(project);
    if (status === 'live') return { label: 'Running', tone: 'ok' };
    if (status === 'in-progress') return { label: 'Review', tone: 'warn' };
    return { label: 'Gated', tone: 'idle' };
  }

  function lastUpdatedLabel(cards: CompanyBoardCard[]): string {
    const age = cards.map((card) => card.age).find((value): value is string => Boolean(value));
    if (age) return age;
    return cards.length > 0 ? 'just now' : '—';
  }

  function projectMeta(project: Project, detail: InFlightDetail | undefined): string {
    return detail?.storyTitle || `${project.storiesComplete}/${project.storiesTotal} stories`;
  }

  // ---- overview actions (preserve real navigation; never invent targets) ---

  function handleNeedsYouAction(cardId: string, actionId: string): void {
    if (cardId === 'review-board' && actionId === 'review') {
      const firstInFlight = inFlightProjects[0];
      if (firstInFlight) {
        void openProject(firstInFlight);
        return;
      }
      onopenprojects?.();
      return;
    }
    if (cardId === 'unlinked-goals' && actionId === 'connect') {
      onopengoals?.();
      return;
    }
    if (
      (cardId === 'board-error' && actionId === 'inspect') ||
      (cardId === 'local-only' && actionId === 'inspect-local')
    ) {
      if (cardId === 'board-error') boardState.retry();
      return;
    }
  }

  // ---- drill-in handlers (mirror BoardPage) --------------------------------

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
      // Surface the underlying error, not just a generic line — the real cause
      // (feature-gate rejection, a stale prdPath, or an unresolved HQ folder) is
      // otherwise hidden, making this undiagnosable from the UI alone.
      const detail = err instanceof Error ? err.message : String(err);
      storiesError = `Could not load this project’s stories — ${detail}`;
      stories = [];
    } finally {
      storiesLoading = false;
    }
  }

  function backToList(): void {
    selected = null;
    stories = [];
    storiesError = null;
    selectedStoryId = null;
  }

  // A persisted status change updates the open project + its list row so the
  // new status survives a back-navigation without a full reload.
  function onProjectStatusChange(projectId: string, status: string): void {
    if (selected && selected.id === projectId) {
      selected = { ...selected, status };
    }
    projects = projects.map((project) =>
      project.id === projectId ? { ...project, status } : project,
    );
    // The in-flight set may change; drop the cached story so it reloads.
    if (projectId in inFlightStory) {
      const next = { ...inFlightStory };
      delete next[projectId];
      inFlightStory = next;
    }
  }
</script>

<section class="company-board" aria-label="Board" data-testid="company-board-panel">
  {#if selected}
    <ProjectDetailView
      project={selected}
      {stories}
      {storiesLoading}
      {storiesError}
      {objectives}
      onback={backToList}
      onselectStory={openStory}
      onStatusChange={onProjectStatusChange}
      selectedStory={selectedStory}
      oncloseStory={closeStory}
      onselectDependency={selectStoryById}
      {onStoryPassesChange}
    />
  {:else}
    <div class="overview-content" data-testid="company-overview">
      {#if error}
        <div class="board-error" role="alert" data-testid="board-error">{error}</div>
      {/if}

      <!-- 1. Compact pulse row (live monitor strip — low height, real counts only) -->
      <section class="pulse-row" aria-label="Company pulse" data-testid="overview-pulse">
        <div class="pulse-item">
          <span class="pulse-value">{projectPulseCount}</span>
          <span class="pulse-label">projects</span>
        </div>
        <div class="pulse-item">
          <span class="pulse-value">{storiesInProgress}</span>
          <span class="pulse-label">stories moving</span>
        </div>
        <div class="pulse-item">
          <span class="pulse-value">{acPercent}%</span>
          <span class="pulse-label">checks passing</span>
        </div>
        <div class="pulse-item">
          <span class="pulse-value">{goalsCount}</span>
          <span class="pulse-label">goals</span>
        </div>
        <div class="pulse-item pulse-cloud">
          <span class={`status-dot ${cloudPulse.tone}`} aria-hidden="true"></span>
          <span class="pulse-label">{cloudPulse.label}</span>
          {#if lastUpdated !== '—'}
            <span class="pulse-meta">· {lastUpdated}</span>
          {/if}
        </div>
      </section>

      <div class="overview-columns">
        <div class="overview-col overview-col-main">
          <!-- 2. Needs you -->
          <section
            class="overview-section"
            aria-labelledby="board-needs-title"
            data-testid="overview-needs-you"
          >
            <header class="section-header">
              <h2 id="board-needs-title">Needs you</h2>
              <span>
                {needsYouCards.length}
                {needsYouCards.length === 1 ? 'item' : 'items'}
              </span>
            </header>
            {#if needsYouCards.length === 0}
              <p class="empty-inline">Nothing needs you right now.</p>
            {:else}
              <div class="needs-queue">
                {#each needsYouCards as card (card.id)}
                  <NeedsYouCard
                    {card}
                    onaction={(actionId) => handleNeedsYouAction(card.id, actionId)}
                  />
                {/each}
              </div>
            {/if}
          </section>

          <!-- 3. In flight -->
          <section
            class="overview-section"
            aria-labelledby="board-inflight-title"
            data-testid="overview-in-flight"
          >
            <header class="section-header">
              <h2 id="board-inflight-title">In flight</h2>
              <button
                type="button"
                class="section-link"
                data-testid="overview-view-projects"
                onclick={() => onopenprojects?.()}
              >
                View projects
              </button>
            </header>

            {#if loading}
              <div class="inflight-skeleton-list" aria-busy="true">
                {#each [0, 1] as row (row)}
                  <div class="inflight-skeleton"></div>
                {/each}
              </div>
            {:else if inFlightProjects.length === 0}
              <p class="empty-inline">Nothing in flight</p>
            {:else}
              <div class="work-list" data-testid="inflight-list">
                {#each inFlightProjects as project (project.id)}
                  {@const detail = inFlightStory[project.id]}
                  {@const progress = projectProgress(project.storiesComplete, project.storiesTotal)}
                  {@const status = rowStatus(project, detail)}
                  <div class="work-row" data-testid="inflight-row">
                    <button
                      type="button"
                      class="work-button"
                      onclick={() => openProject(project)}
                    >
                      <span class="work-title">{projectDisplayName(project)}</span>
                      <span class="work-meta">{projectMeta(project, detail)}</span>
                    </button>
                    <span class="goal-chip" data-testid="inflight-goal-chip">{goalChip(project)}</span>
                    <span class="status-pill" class:review={status.tone === 'warn'}>
                      <span class={`status-dot ${status.tone}`} aria-hidden="true"></span>
                      <span>{status.label}</span>
                    </span>
                    <span class="ac-cell" aria-label={`${progress.complete} of ${progress.total} AC`}>
                      <span class="ac-track" aria-hidden="true">
                        <span class="ac-fill" style={`width: ${progress.percent}%`}></span>
                      </span>
                      <span>{progress.complete}/{progress.total}</span>
                    </span>
                  </div>
                {/each}
              </div>
            {/if}
          </section>
        </div>

        <div class="overview-col overview-col-side">
          <!-- 4. Goals -->
          <section
            class="overview-section"
            aria-labelledby="board-goals-title"
            data-testid="overview-goals"
          >
            <header class="section-header">
              <h2 id="board-goals-title">Goals</h2>
              <button
                type="button"
                class="section-link"
                data-testid="overview-view-goals"
                onclick={() => onopengoals?.()}
              >
                View all
              </button>
            </header>
            {#if loading}
              <div class="goals-list" aria-busy="true">
                {#each [0, 1] as row (row)}
                  <div class="goal-skeleton"></div>
                {/each}
              </div>
            {:else if objectives.length === 0}
              <div class="empty-inline" data-testid="empty-goals-state">
                <span>No goals yet</span>
                <p>Company goals will appear here after the next board sync.</p>
              </div>
            {:else}
              <div class="goals-list">
                {#each objectives as objective (objective.id || objective.title)}
                  <GoalCard
                    {objective}
                    progress={objectiveProgress(objective)}
                    projectCount={linkedProjects(objective).length}
                    storyCount={incompleteStoryCount(linkedProjects(objective))}
                  />
                {/each}
              </div>
            {/if}
          </section>

          <!-- 5. Recent activity -->
          <section class="overview-section" data-testid="overview-activity-section">
            <OverviewActivityDigest {slug} {cloudBacked} {onopeninbox} />
          </section>
        </div>
      </div>
    </div>

    {#if false}
      <div aria-hidden="true">
        <ProjectListView
          projects={companyProjects}
          {loading}
          onselect={openProject}
        />
        {activeProjectCount}
      </div>
    {/if}
  {/if}
</section>

<style>
  .company-board {
    display: flex;
    flex-direction: column;
    gap: 0;
    min-width: 0;
    height: 100%;
    color: var(--v4-text-1);
    font-family: var(--font-sans);
    /* Naked canvas — no outer raised panel around the overview body. */
    background: transparent;
  }

  .overview-content {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }

  .board-error {
    padding: 10px 0;
    border: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--v4-error) 28%, var(--v4-rowline));
    border-radius: 0;
    background: transparent;
    color: var(--v4-error);
    font-size: var(--type-body, var(--text-base));
    font-weight: 400;
    line-height: 1.35;
  }

  /* Compact pulse — discrete live monitor; modest radius only on the strip. */
  .pulse-row {
    display: flex;
    align-items: center;
    min-height: 34px;
    min-width: 0;
    overflow: auto hidden;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-field);
    background: var(--v4-inset);
  }

  .pulse-item {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    flex: 0 0 auto;
    padding: 0 12px;
    border-right: 1px solid var(--v4-hairline);
    white-space: nowrap;
  }

  .pulse-item:last-child {
    border-right: 0;
  }

  .pulse-cloud {
    align-items: center;
  }

  .pulse-value {
    color: var(--v4-text-1);
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1.2;
  }

  .pulse-label,
  .pulse-meta {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 400;
    line-height: 1.2;
    text-overflow: ellipsis;
  }

  .overview-columns {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(260px, 0.75fr);
    gap: 20px;
    min-width: 0;
    align-items: start;
  }

  .overview-col {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 18px;
  }

  .overview-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    /* Naked section: no rounded outer box, no raised fill. */
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 28px;
    min-width: 0;
  }

  .section-header h2 {
    margin: 0;
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: 0;
  }

  .section-header span,
  .section-link {
    flex: 0 0 auto;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--v4-text-3);
    font: inherit;
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
    line-height: 1.25;
    cursor: default;
  }

  .section-link {
    cursor: pointer;
  }

  .section-link:hover {
    color: var(--v4-text-2);
  }

  .section-link:focus-visible {
    outline: 1px solid var(--v4-focus-ring);
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .needs-queue {
    display: grid;
    gap: 8px;
  }

  .empty-inline {
    margin: 0;
    padding: 8px 0 4px;
    border-top: 1px solid var(--v4-rowline);
    color: var(--v4-text-3);
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 400;
    line-height: 1.35;
  }

  .empty-inline span {
    display: block;
    color: var(--v4-text-2);
    font-size: var(--type-body, var(--text-base));
    font-weight: 500;
  }

  .empty-inline p {
    margin: 3px 0 0;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
  }

  .goals-list {
    display: flex;
    flex-direction: column;
    min-width: 0;
    border-top: 1px solid var(--v4-rowline);
  }

  .work-list {
    display: flex;
    flex-direction: column;
    min-width: 0;
    border-top: 1px solid var(--v4-rowline);
  }

  .work-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(72px, 100px) auto minmax(72px, 96px);
    align-items: center;
    gap: 12px;
    min-height: 48px;
    padding: 8px 0;
    border-bottom: 1px solid var(--v4-rowline);
  }

  .work-row:last-child {
    border-bottom: 0;
  }

  .work-button {
    display: grid;
    min-width: 0;
    gap: var(--v4-row-stack-gap, 3px);
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .work-button:hover .work-title {
    color: var(--v4-text-1);
  }

  .work-button:focus-visible {
    outline: 1px solid var(--v4-focus-ring);
    outline-offset: 3px;
  }

  .work-title,
  .work-meta {
    overflow: hidden;
    max-width: 100%;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .work-title {
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    font-weight: 500;
    line-height: 1.25;
  }

  .work-meta {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
    line-height: 1.2;
  }

  .goal-chip {
    display: inline-flex;
    max-width: 100%;
    align-items: center;
    min-width: 0;
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Discrete selection/status object — pill keeps radius. */
  .status-pill {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: var(--v4-inset);
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
    line-height: 1;
    white-space: nowrap;
  }

  .status-pill.review {
    border-color: color-mix(in srgb, var(--v4-unread) 32%, var(--v4-hairline));
    background: color-mix(in srgb, var(--v4-unread) 10%, transparent);
    color: var(--v4-unread);
  }

  .ac-cell {
    display: grid;
    grid-template-columns: minmax(36px, 56px) auto;
    align-items: center;
    gap: 8px;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
  }

  .ac-track {
    height: 3px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--v4-control-faint);
  }

  .ac-fill {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--v4-text-2);
  }

  .status-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
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

  .goal-skeleton,
  .inflight-skeleton {
    border: 0;
    border-bottom: 1px solid var(--v4-rowline);
    border-radius: 0;
    background: var(--v4-control-faint);
    animation: board-skeleton-pulse 1.3s ease-in-out infinite;
  }

  .goal-skeleton {
    height: 64px;
    margin-bottom: 4px;
  }

  .inflight-skeleton-list {
    display: grid;
    gap: 0;
    border-top: 1px solid var(--v4-rowline);
  }

  .inflight-skeleton {
    height: 48px;
  }

  @keyframes board-skeleton-pulse {
    0%,
    100% {
      opacity: 0.5;
    }
    50% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .goal-skeleton,
    .inflight-skeleton {
      animation: none;
    }
  }

  @media (max-width: 980px) {
    .overview-columns {
      grid-template-columns: 1fr;
    }

    .work-row {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px 12px;
    }

    .goal-chip {
      grid-column: 1 / 2;
    }

    .status-pill {
      justify-self: end;
    }

    .ac-cell {
      grid-column: 1 / -1;
      max-width: 160px;
    }

    .pulse-row {
      flex-wrap: wrap;
      min-height: 0;
    }

    .pulse-item {
      flex: 1 1 40%;
      padding: 8px 12px;
      border-right: 0;
      border-bottom: 1px solid var(--v4-hairline);
    }
  }

  @media (max-width: 560px) {
    .work-row {
      grid-template-columns: minmax(0, 1fr);
    }

    .status-pill,
    .goal-chip,
    .ac-cell {
      justify-self: start;
    }
  }
</style>
