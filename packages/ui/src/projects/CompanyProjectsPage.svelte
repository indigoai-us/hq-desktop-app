<script lang="ts">
  /**
   * Company Projects — portfolio Kanban (DESKTOP-004).
   *
   * Defaults to a four-column board: Not started · In progress · Active · Complete.
   * Active requires a live execution signal from the sessions store; board.json
   * "active" alone is In progress. Board/List, search, state filter, and owner
   * filter share one control row; New project remains the primary action.
   */
  import { onMount } from "svelte";
  import type { PlatformAdapter } from "@hq/platform";
  import { buildClaudeCodeUrl } from "../files/claude-code-link.js";
  import {
    applyProjectProvenance,
    emptyProjectProvenanceIndex,
    indexProjectProvenance,
    loadCompanyGoals,
    loadCompanyProjectProvenance,
    loadLocalProjects,
    loadLocalProjectStories,
    projectIdentity,
    type ProjectProvenanceIndex,
    type Objective,
    withProjectStatus,
    configureProjectsApi,
    ProjectsUnavailableError,
  } from "./local-projects.js";
  import {
    PROJECT_RENDER_BATCH,
    progressiveWindow,
  } from "../common/progressive-collection.js";
  import { responsiblePerson } from "../common/provenance.js";
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
  } from "./projects-model.js";
  import { relativeActivity } from "../sessions/sessions.js";
  import {
    configureSessionsApi,
    sessionsStore,
    startSessionsStore,
  } from "../sessions/sessions-store.svelte.js";
  import ProjectDetailView from "./ProjectDetailView.svelte";
  import ProjectRow from "./ProjectRow.svelte";
  import ProvenanceLine from "../common/ProvenanceLine.svelte";
  import UnavailableNote from "../common/UnavailableNote.svelte";
  import "../home/tokens.css";

  interface Props {
    /** Platform seam — projects/settings/shell slices + capability flags. */
    adapter: PlatformAdapter;
    slug: string;
    onnewproject?: () => void | Promise<void>;
  }

  /** Legacy cycle filter kept for needs-link + work-actions contracts. */
  type ProjectFilter = "all" | "active" | "needs-link";

  let { adapter, slug, onnewproject }: Props = $props();

  // Wire the module-level project/session seams to this platform adapter.
  $effect.pre(() => {
    configureProjectsApi(adapter.projects);
    configureSessionsApi(adapter.sessions);
  });

  let objectives = $state<Objective[]>([]);
  let projects = $state<Project[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  /** Free-text filter over project name/description. */
  let searchQuery = $state("");
  /** Portfolio state filter (All states / column). */
  let stateFilter = $state<PortfolioStateFilter>("all");
  /** Owner filter — empty string means Anyone. */
  let ownerFilter = $state("");
  /** Board is the DESKTOP-004 default. */
  let viewMode = $state<PortfolioViewMode>("board");
  /**
   * Legacy projectFilter still supports the needs-link cycle used by Link goal
   * empty-state contracts and company-work-actions.
   */
  let projectFilter = $state<ProjectFilter>("all");
  let actionBusy = $state<string | null>(null);
  let actionMessage = $state<string | null>(null);
  let newProjectPending = $state(false);
  let selected = $state<Project | null>(null);
  let stories = $state<Story[]>([]);
  let storiesLoading = $state(false);
  let storiesError = $state<string | null>(null);
  let selectedStoryId = $state<string | null>(null);
  /**
   * Project story reads are independent native requests. A user can return to
   * the portfolio and open another project before the first request settles,
   * so every selection owns a generation and may only commit to that exact
   * company/project pair.
   */
  let storyLoadGeneration = 0;
  /**
   * The workspace list is refreshed in the background and may re-deliver the
   * same company slug through props. Keep the open project/task workspace in
   * place for those same-company refreshes; only a real company change should
   * reset local navigation.
   */
  let loadedSlug: string | null = null;
  // Best-effort cloud attribution fills only fields absent from local metadata.
  let cloudProvenance = $state<ProjectProvenanceIndex>(
    emptyProjectProvenanceIndex(),
  );
  let provenanceUnavailable = $state(false);
  /** Web (needs-new-API): projects backend unavailable → standard degraded state. */
  let projectsUnavailable = $state(false);
  let visibleByColumn = $state<Record<PortfolioColumn, number>>({
    "not-started": PROJECT_RENDER_BATCH,
    "in-progress": PROJECT_RENDER_BATCH,
    active: PROJECT_RENDER_BATCH,
    complete: PROJECT_RENDER_BATCH,
  });
  let now = $state(Date.now());

  function invalidateStoryLoad(): void {
    storyLoadGeneration += 1;
    storiesLoading = false;
  }

  function isCurrentStoryLoad(
    generation: number,
    companySlug: string,
    selectedIdentity: string,
  ): boolean {
    return (
      generation === storyLoadGeneration &&
      slug === companySlug &&
      selected !== null &&
      projectIdentity(selected) === selectedIdentity
    );
  }

  async function refreshSelectedStoriesForProvenance(
    project: Project,
  ): Promise<void> {
    if (!project.prdPath) return;
    const companySlug = slug;
    const selectedIdentity = projectIdentity(project);
    const generation = storyLoadGeneration + 1;
    storyLoadGeneration = generation;
    storiesLoading = true;
    try {
      const nextStories = await loadLocalProjectStories(
        project.prdPath,
        project.provenance,
      );
      if (!isCurrentStoryLoad(generation, companySlug, selectedIdentity))
        return;
      stories = nextStories;
      storiesError = null;
      if (
        selectedStoryId !== null &&
        !nextStories.some((story) => story.id === selectedStoryId)
      ) {
        selectedStoryId = null;
      }
    } catch (err) {
      if (!isCurrentStoryLoad(generation, companySlug, selectedIdentity))
        return;
      // Attribution refresh is best-effort. Keep the already-visible stories
      // rather than blanking the workspace if this local reread fails.
      console.warn("story provenance refresh failed:", err);
    } finally {
      if (isCurrentStoryLoad(generation, companySlug, selectedIdentity)) {
        storiesLoading = false;
      }
    }
  }

  async function createProject(): Promise<void> {
    if (!onnewproject || newProjectPending) return;
    newProjectPending = true;
    try {
      await onnewproject();
    } finally {
      newProjectPending = false;
    }
  }

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
      .map((project) => applyProjectProvenance(project, cloudProvenance))
      .sort(compareProjectsByRecency),
  );

  const sessions = $derived(sessionsStore.sessions);

  function leadLabel(project: Project): string | null {
    const person = responsiblePerson(project.provenance, "project");
    return person === "Unassigned" ? null : person;
  }

  function showMoreProjects(column: PortfolioColumn, nextCount: number): void {
    visibleByColumn = { ...visibleByColumn, [column]: nextCount };
  }

  function normalizeId(value: string | null | undefined): string {
    return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
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
      project.prdPath.split("/").filter(Boolean).at(-2),
    ]
      .map(normalizeId)
      .filter(Boolean);
  }

  function projectMatchesObjective(
    project: Project,
    objective: Objective,
  ): boolean {
    const ids = objectiveIds(objective);
    if (ids.size === 0) return false;
    return projectTokens(project).some((token) => ids.has(token));
  }

  function projectLinkedToAnyGoal(project: Project): boolean {
    return objectives.some((objective) =>
      projectMatchesObjective(project, objective),
    );
  }

  function linkedGoalLabel(project: Project): string | null {
    const goal = objectives.find((objective) =>
      projectMatchesObjective(project, objective),
    );
    if (!goal) return null;
    return goal.title || goal.id || null;
  }

  function resolveColumn(project: Project): PortfolioColumn {
    // Active only when projectLiveRunView finds a real live session signal.
    return portfolioColumn(
      project,
      projectLiveRunView(project, sessions, now) !== null,
    );
  }

  function matchesProjectFilter(
    project: Project,
    filter: ProjectFilter,
  ): boolean {
    if (filter === "needs-link") return !projectLinkedToAnyGoal(project);
    if (filter === "active") {
      const col = resolveColumn(project);
      return col === "active" || col === "in-progress";
    }
    return true;
  }

  function filterLabel(filter: ProjectFilter): string {
    if (filter === "active") return "Active";
    if (filter === "needs-link") return "Needs link";
    return "All";
  }

  function cycleFilter() {
    projectFilter =
      projectFilter === "all"
        ? "active"
        : projectFilter === "active"
          ? "needs-link"
          : "all";
  }

  const ownerOptions = $derived.by(() => {
    const names = new Set<string>();
    for (const project of companyProjects) {
      const lead = leadLabel(project);
      if (lead) names.add(lead);
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
      const desc = (project.description ?? "").toLowerCase();
      return (
        name.includes(q) ||
        desc.includes(q) ||
        project.id.toLowerCase().includes(q)
      );
    }),
  );

  const portfolioGroups = $derived(
    groupProjectsByPortfolioColumn(filteredCompanyProjects, sessions),
  );

  const liveCount = $derived(portfolioGroups.active.length);

  $effect(() => {
    void searchQuery;
    void stateFilter;
    void ownerFilter;
    void projectFilter;
    void viewMode;
    visibleByColumn = {
      "not-started": PROJECT_RENDER_BATCH,
      "in-progress": PROJECT_RENDER_BATCH,
      active: PROJECT_RENDER_BATCH,
      complete: PROJECT_RENDER_BATCH,
    };
  });

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
      invalidateStoryLoad();
      objectives = [];
      projects = [];
      selected = null;
      stories = [];
      storiesError = null;
      selectedStoryId = null;
      cloudProvenance = emptyProjectProvenanceIndex();
      provenanceUnavailable = false;
    }

    if (!activeSlug) {
      loading = false;
      return;
    }

    loading = true;
    let cancelled = false;
    provenanceUnavailable = false;
    projectsUnavailable = false;

    // Best-effort and decoupled: cloud attribution must never gate local work.
    void loadCompanyProjectProvenance(activeSlug)
      .then((rows) => {
        if (cancelled) return;
        cloudProvenance = indexProjectProvenance(rows);
        provenanceUnavailable = false;
        if (selected) {
          const refreshed = applyProjectProvenance(selected, cloudProvenance);
          selected = refreshed;
          void refreshSelectedStoriesForProvenance(refreshed);
        }
      })
      .catch((err) => {
        console.warn(
          `get_company_project_creators(${activeSlug}) failed:`,
          err,
        );
        if (!cancelled) provenanceUnavailable = true;
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
          const selectedIdentity = projectIdentity(selected);
          const refreshed =
            allProjects.find(
              (project) => projectIdentity(project) === selectedIdentity,
            ) ?? selected;
          selected = applyProjectProvenance(refreshed, cloudProvenance);
        }
      } catch (err) {
        if (!cancelled && err instanceof ProjectsUnavailableError) {
          // Standard degraded state, not an error banner.
          projectsUnavailable = true;
          objectives = [];
          projects = [];
          return;
        }
        console.error("CompanyProjectsPage load failed:", err);
        if (!cancelled) {
          error = "Projects unavailable. Try again after a sync.";
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
      "",
      `Link project "${projectDisplayName(project)}" to the right company goal.`,
      `Project id: ${project.id}`,
      project.prdPath ? `PRD: ${project.prdPath}` : null,
      objectives.length > 0
        ? [
            "Available goals:",
            ...objectives.map((goal) => `- ${goal.title || goal.id}`),
          ].join("\n")
        : "No goals are currently synced; create the right goal first if needed.",
      "",
      "Update the local goal/project metadata so this project appears under the correct goal in HQ.",
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    actionBusy = `link-${projectIdentity(project)}`;
    actionMessage = null;
    try {
      // Desktop-only affordance (canLaunchApps): on hosts without it, fall
      // back to copying the prompt instead of a dead deep-link.
      if (!adapter.isAvailable("canLaunchApps")) {
        await navigator.clipboard.writeText(prompt);
        actionMessage = "Prompt copied — paste it into Claude Code.";
        return;
      }
      const configResult = await adapter.settings.getConfig();
      const folder =
        configResult.ok && typeof configResult.value?.hqFolderPath === "string"
          ? configResult.value.hqFolderPath
          : "";
      const url = buildClaudeCodeUrl({ folder, prompt });
      const opened = await adapter.shell.openClaudeCodeLink(url);
      if (!opened.ok) throw new Error(opened.message ?? "Open failed");
      actionMessage = "Opened in Claude Code.";
    } catch (err) {
      console.error("open_claude_code_link failed:", err);
      try {
        await navigator.clipboard.writeText(prompt);
        actionMessage = "Prompt copied.";
      } catch {
        actionMessage = "Could not open Claude Code.";
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
    return new Date(time).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }

  function listUpdatedLabel(project: Project): string {
    const iso = project.updatedAt || project.createdAt;
    if (!iso) return "Not recorded";
    // Prefer compact relative when sessions helper can parse it; else short date.
    const rel = relativeActivity(iso, now);
    if (rel !== "Not recorded") return rel;
    return formatProjectDate(iso) ?? "Not recorded";
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
    const companySlug = slug;
    const selectedIdentity = projectIdentity(project);
    const generation = storyLoadGeneration + 1;
    storyLoadGeneration = generation;
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
      const nextStories = await loadLocalProjectStories(
        project.prdPath,
        project.provenance,
      );
      if (!isCurrentStoryLoad(generation, companySlug, selectedIdentity))
        return;
      stories = nextStories;
    } catch (err) {
      if (!isCurrentStoryLoad(generation, companySlug, selectedIdentity))
        return;
      console.error("get_local_project_prd failed:", err);
      const detail = err instanceof Error ? err.message : String(err);
      storiesError = `Could not load this project’s stories — ${detail}`;
      stories = [];
    } finally {
      if (isCurrentStoryLoad(generation, companySlug, selectedIdentity)) {
        storiesLoading = false;
      }
    }
  }

  function retrySelectedStories(): Promise<void> | void {
    const project = selected;
    if (!project) return;
    return openProject(project);
  }

  function openProjectFromKey(event: KeyboardEvent, project: Project): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void openProject(project);
  }

  function backToProjects(): void {
    invalidateStoryLoad();
    selected = null;
    stories = [];
    storiesError = null;
    selectedStoryId = null;
  }

  function onProjectStatusChange(
    changedIdentity: string,
    status: string,
  ): void {
    if (selected) {
      const nextSelected = withProjectStatus(selected, changedIdentity, status);
      if (nextSelected !== selected) selected = nextSelected;
    }
    projects = projects.map((project) =>
      withProjectStatus(project, changedIdentity, status),
    );
  }

  function onStoryPassesChange(storyId: string, passes: boolean): void {
    // A late cloud-provenance reread contains the disk snapshot from before
    // this successful write. Retire it before committing the persisted result
    // so it cannot restore the old passes value over the user's change.
    invalidateStoryLoad();
    stories = stories.map((story) =>
      story.id === storyId ? { ...story, passes } : story,
    );
    if (selected) {
      const selectedIdentity = projectIdentity(selected);
      const nextComplete = stories.filter((story) =>
        story.id === storyId ? passes : story.passes,
      ).length;
      selected = { ...selected, storiesComplete: nextComplete };
      projects = projects.map((project) =>
        projectIdentity(project) === selectedIdentity
          ? { ...project, storiesComplete: nextComplete }
          : project,
      );
    }
  }
</script>

<section
  class="company-projects"
  aria-labelledby="company-projects-title"
  data-testid="company-projects-page"
>
  {#if selected}
    <ProjectDetailView
      {adapter}
      project={selected}
      {stories}
      {storiesLoading}
      {storiesError}
      onretryStories={retrySelectedStories}
      {objectives}
      onback={backToProjects}
      onselectStory={openStory}
      onStatusChange={onProjectStatusChange}
      {selectedStory}
      {provenanceUnavailable}
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
          {companyProjects.length === 1 ? " project" : " projects"}
          {#if liveCount > 0}
            · {liveCount} live
          {/if}
          · stories live here (no separate Tasks tab)
        </span>
      </div>
      <div
        class="project-actions detail-primary-actions"
        aria-label="Project actions"
      >
        {#if actionMessage}
          <span class="action-status" role="status">{actionMessage}</span>
        {/if}
        {#if onnewproject}
          <button
            type="button"
            class="primary-action"
            onclick={createProject}
            disabled={newProjectPending}
            aria-busy={newProjectPending}
          >
            {newProjectPending ? "Opening…" : "New project"}
          </button>
        {/if}
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
        <span class="visually-hidden">Filter by owner or creator</span>
        <select
          bind:value={ownerFilter}
          data-testid="portfolio-owner-filter"
          aria-label="Filter by project owner or creator"
        >
          <option value="">Person · Anyone</option>
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
          class:is-active={viewMode === "board"}
          aria-pressed={viewMode === "board"}
          data-testid="view-toggle-board"
          onclick={() => (viewMode = "board")}
        >
          Board
        </button>
        <button
          type="button"
          class="toggle-segment"
          class:is-active={viewMode === "list"}
          aria-pressed={viewMode === "list"}
          data-testid="view-toggle-list"
          onclick={() => (viewMode = "list")}
        >
          List
        </button>
      </div>
    </div>

    {#if error}
      <div class="projects-error" role="alert">{error}</div>
    {/if}

    <div class="portfolio-body" aria-busy={loading}>
      {#if projectsUnavailable}
        <UnavailableNote
          label="Projects"
          message="Project boards aren't available in this app yet. Use the HQ desktop app to browse and run projects."
          testid="projects-unavailable"
        />
      {:else if loading}
        <div
          class="board-loading"
          aria-busy="true"
          aria-label="Loading projects"
        >
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
          <p>
            Projects will appear here after they sync into the local workspace.
          </p>
        </div>
      {:else if filteredCompanyProjects.length === 0}
        <div class="empty-state" data-testid="filtered-projects-empty-state">
          <span>No projects match the current filters</span>
          <p>
            {#if projectFilter === "needs-link"}
              No projects match {filterLabel(projectFilter).toLowerCase()}.
            {:else}
              Change the state, owner, or search filters to see more projects.
            {/if}
          </p>
        </div>
      {:else if viewMode === "board"}
        <div
          class="kanban-board"
          data-testid="portfolio-kanban"
          aria-label="Projects by operational state"
        >
          {#each PORTFOLIO_COLUMNS as column (column)}
            {@const columnProjects = portfolioGroups[column]}
            {@const renderWindow = progressiveWindow(
              columnProjects,
              visibleByColumn[column],
              PROJECT_RENDER_BATCH,
            )}
            <section
              class="kanban-column"
              data-testid={`portfolio-column-${column}`}
              aria-labelledby={`portfolio-col-${column}`}
            >
              <header class="kanban-column-head">
                <span
                  class="kanban-column-title"
                  id={`portfolio-col-${column}`}
                >
                  {#if column === "active"}
                    <span class="live-dot" aria-hidden="true"></span>
                  {/if}
                  {PORTFOLIO_COLUMN_LABEL[column]}
                  <span class="kanban-column-count"
                    >{columnProjects.length}</span
                  >
                </span>
                <span class="kanban-column-caption"
                  >{PORTFOLIO_COLUMN_CAPTION[column]}</span
                >
              </header>
              <div class="kanban-stack">
                {#if columnProjects.length === 0}
                  <div class="column-empty">
                    <span>No projects</span>
                  </div>
                {:else}
                  {#each renderWindow.items as project (projectIdentity(project))}
                    {@const liveRun = projectLiveRunView(
                      project,
                      sessions,
                      now,
                    )}
                    {@const goal = linkedGoalLabel(project)}
                    <ProjectRow
                      {project}
                      showCompany={false}
                      goalLabel={goal}
                      {provenanceUnavailable}
                      liveRun={column === "active" ? liveRun : null}
                      stateContext={portfolioStateContext(column, project)}
                      {now}
                      onselect={(p) => void openProject(p)}
                      onlinkgoal={!goal ? requestLinkProject : undefined}
                      linkBusy={actionBusy ===
                        `link-${projectIdentity(project)}`}
                    />
                  {/each}
                  {#if renderWindow.remaining > 0}
                    <button
                      type="button"
                      class="show-more-projects"
                      data-testid={`show-more-projects-${column}`}
                      onclick={() =>
                        showMoreProjects(column, renderWindow.nextCount)}
                    >
                      Show {renderWindow.nextCount - renderWindow.items.length} more
                      <span>· {renderWindow.remaining} remaining</span>
                    </button>
                  {/if}
                {/if}
              </div>
            </section>
          {/each}
        </div>
      {:else}
        <div
          class="project-list-surface"
          data-testid="portfolio-list"
          aria-label="Projects list"
        >
          <div class="project-table-head">
            <span>Project</span>
            <span>Goal</span>
            <span>Provenance</span>
            <span>Tasks</span>
            <span>Updated</span>
          </div>
          {#each PORTFOLIO_COLUMNS as column (column)}
            {@const columnProjects = portfolioGroups[column]}
            {@const renderWindow = progressiveWindow(
              columnProjects,
              visibleByColumn[column],
              PROJECT_RENDER_BATCH,
            )}
            {#if columnProjects.length > 0}
              <div class="project-group-label">
                <span>{PORTFOLIO_COLUMN_LABEL[column]}</span>
                <span class="group-count">{columnProjects.length}</span>
              </div>
              {#each renderWindow.items as project (projectIdentity(project))}
                {@const progress = projectProgress(
                  project.storiesComplete,
                  project.storiesTotal,
                )}
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
                    <strong class="list-name"
                      >{projectDisplayName(project)}</strong
                    >
                    <span class="list-desc">
                      {project.description ||
                        (project.createdAt
                          ? `started ${formatProjectDate(project.createdAt)}`
                          : "No description")}
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
                          {actionBusy === `link-${projectIdentity(project)}`
                            ? "Opening…"
                            : "Link"}
                        </button>
                      {/if}
                    </span>
                  </div>
                  <div class="list-goal">{goal ?? "No goal"}</div>
                  <div
                    class="list-provenance"
                    data-testid="project-list-provenance"
                  >
                    <ProvenanceLine
                      provenance={project.provenance}
                      kind="project"
                      unavailable={provenanceUnavailable}
                    />
                  </div>
                  <div
                    class="list-progress"
                    aria-label={`${progress.percent}% complete`}
                  >
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
              {#if renderWindow.remaining > 0}
                <button
                  type="button"
                  class="show-more-projects list-show-more"
                  data-testid={`show-more-projects-${column}`}
                  onclick={() =>
                    showMoreProjects(column, renderWindow.nextCount)}
                >
                  Show {renderWindow.nextCount - renderWindow.items.length} more
                  <span>· {renderWindow.remaining} remaining</span>
                </button>
              {/if}
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
    gap: var(--v4-space-2);
    margin-left: auto;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  .toggle-segment {
    display: inline-flex;
    align-items: center;
    padding: 4px 10px;
    border: 0;
    border-bottom: 1px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-body, 12px);
    font-weight: 600;
    cursor: pointer;
    transition:
      border-color 140ms ease,
      color 140ms ease;
  }

  .toggle-segment:hover {
    border-bottom-color: var(--v4-rowline);
    color: var(--v4-text-1);
  }

  .toggle-segment.is-active {
    border-bottom-color: var(--v4-text-2);
    background: transparent;
    color: var(--v4-text-1);
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

  @media (max-width: 1040px) {
    .kanban-board {
      grid-template-columns: repeat(4, minmax(160px, 1fr));
      gap: 8px;
    }

    .kanban-column {
      min-width: 160px;
    }
  }

  /* Viewport width includes the 220px primary rail. Use the actual project
     canvas too so all four columns remain visible at the 960px native minimum. */
  @container company-projects (max-width: 900px) {
    .kanban-board {
      grid-template-columns: repeat(4, minmax(160px, 1fr));
      gap: 8px;
    }

    .kanban-column {
      min-width: 160px;
    }
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
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
  }

  .show-more-projects {
    width: 100%;
    min-height: 30px;
    padding: 5px 8px;
    border: 0;
    border-top: 1px solid var(--v4-rowline);
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-secondary, 11px);
    text-align: left;
    cursor: pointer;
  }

  .show-more-projects span {
    color: var(--v4-text-3);
  }

  .show-more-projects:hover {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .show-more-projects:focus-visible {
    outline: 2px solid var(--v4-control-border);
    outline-offset: -2px;
  }

  .list-show-more {
    min-width: 680px;
    padding: 7px 4px;
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
    grid-template-columns:
      minmax(210px, 1.25fr)
      minmax(96px, 0.6fr)
      minmax(220px, 1.1fr)
      105px
      74px;
    align-items: center;
    gap: 10px;
    min-width: 745px;
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

  .list-provenance {
    min-width: 0;
    padding: 7px 0;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
    white-space: normal;
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

  .projects-error {
    padding: 12px 0;
    border: 0;
    border-top: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: transparent;
    color: var(--v4-error);
    font-size: var(--type-body, 12px);
  }

  .empty-state {
    padding: 12px;
    border: 0;
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

  @container company-projects (max-width: 820px) {
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

    /* Keep all four columns visible at the native minimum; the board remains
       horizontally scrollable if content or user font scaling needs more. */
    .kanban-board,
    .board-loading {
      grid-template-columns: repeat(4, minmax(160px, 1fr));
      gap: 8px;
    }

    .kanban-column {
      min-width: 160px;
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
    .list-provenance,
    .list-updated {
      min-width: 0;
    }

    .list-show-more {
      min-width: 0;
    }
  }
</style>
