<script lang="ts">
  /**
   * ProjectDetailView — coherent project workspace (DESKTOP-005 / DESKTOP-006).
   *
   * Toolbar preserves company / Projects / project breadcrumb and writable
   * project status. Local tabs: Overview · Tasks · Files · Activity (Tasks is
   * the default primary surface). Tasks default to Not started / In progress /
   * Active / Complete with Board/List controls.
   *
   * A selected task opens a stable split workspace: compact project task rail
   * (selected task stays visible) + in-workspace detail canvas — never a modal
   * or dimmed backdrop. Closing the task returns to the board/list without
   * losing project context.
   *
   * Preserves PRD, README, linked goal, branch, task roll-up, project progress,
   * writable status, and existing file / Open in Claude Code actions. Does not
   * invent backend fields.
   */
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { buildClaudeCodeUrl } from '../../lib/claude-code-link';
  import {
    loadLocalProjectPrd,
    loadLocalProjectReadme,
    type LocalProjectPrdWire,
    type Objective,
  } from '../lib/local-projects';
  import { setProjectStatus } from '../lib/projects-store.svelte';
  import { renderMarkdown } from '../lib/markdown';
  import {
    classifyTasks,
    groupByTaskColumn,
    liveSessionsForProject,
    projectDisplayName,
    projectFilesRootFromPrdPath,
    projectProgress,
    storyLiveRunView,
    TASK_COLUMNS,
    TASK_COLUMN_LABEL,
    toEditableStatus,
    EDITABLE_PROJECT_STATUSES,
    EDITABLE_PROJECT_STATUS_LABEL,
    type EditableProjectStatus,
    type PortfolioSessionRef,
    type Project,
    type Story,
    type TaskColumn,
  } from '../lib/projects-model';
  import { relativeActivity } from '../lib/sessions';
  import { sessionsStore, startSessionsStore } from '../lib/sessions-store.svelte';
  import type { DirEntry } from '../lib/file-tree';
  import StoryKanban from '../components/StoryKanban.svelte';
  import CompanyFileTree from '../components/CompanyFileTree.svelte';
  import FilePreviewPane from '../components/FilePreviewPane.svelte';
  import StoryPanel from '../v4/StoryPanel.svelte';
  import '../v4/tokens.css';

  interface Props {
    /** The project whose detail to show. */
    project: Project;
    /** Stories for this project's prd (loaded by the caller). */
    stories: Story[];
    /** Whether the stories are still loading. */
    storiesLoading?: boolean;
    /** Error string if the stories failed to load. */
    storiesError?: string | null;
    /** Back to the project list (Projects). */
    onback: () => void;
    /** Open a story's detail (parent may also track selection). */
    onselectStory: (story: Story) => void;
    /** Company objectives used for the goal chip + KR card. */
    objectives?: Objective[];
    /**
     * Notify the caller a status persisted (US-010) so it can refresh its list.
     * Optional — the detail view persists + paints optimistically on its own.
     */
    onStatusChange?: (projectId: string, status: EditableProjectStatus) => void;
    /**
     * Currently selected story for in-workspace task detail. When set, the
     * docked StoryPanel opens without a modal backdrop.
     */
    selectedStory?: Story | null;
    /** Close the in-workspace task detail. */
    oncloseStory?: () => void;
    /** Dependency chip reselect inside the task detail. */
    onselectDependency?: (storyId: string) => void;
    /** Story passes toggle callback from the docked panel. */
    onStoryPassesChange?: (storyId: string, passes: boolean) => void;
  }

  let {
    project,
    stories,
    storiesLoading = false,
    storiesError = null,
    onback,
    onselectStory,
    objectives = [],
    onStatusChange,
    selectedStory = null,
    oncloseStory,
    onselectDependency,
    onStoryPassesChange,
  }: Props = $props();

  // ---- README / PRD load ---------------------------------------------------
  let readme = $state<string | null>(null);
  let readmeLoading = $state(false);
  let prd = $state<LocalProjectPrdWire | null>(null);
  let prdLoading = $state(false);

  $effect(() => {
    const prdPath = project.prdPath;
    readme = null;
    if (!prdPath) {
      readmeLoading = false;
      return;
    }
    readmeLoading = true;
    let cancelled = false;
    void (async () => {
      try {
        const content = await loadLocalProjectReadme(prdPath);
        if (!cancelled) readme = content;
      } catch (err) {
        console.error('get_local_project_readme failed:', err);
        if (!cancelled) readme = null;
      } finally {
        if (!cancelled) readmeLoading = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    const prdPath = project.prdPath;
    prd = null;
    if (!prdPath) {
      prdLoading = false;
      return;
    }
    prdLoading = true;
    let cancelled = false;
    void (async () => {
      try {
        const content = await loadLocalProjectPrd(prdPath);
        if (!cancelled) prd = content;
      } catch (err) {
        console.error('get_local_project_prd failed:', err);
        if (!cancelled) prd = null;
      } finally {
        if (!cancelled) prdLoading = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  const hasPrd = $derived(Boolean(project.prdPath));
  const hasReadme = $derived(readme !== null && readme.trim() !== '');
  const readmeHtml = $derived(hasReadme ? renderMarkdown(readme as string) : '');

  // Sessions for Active task matching (DESKTOP-005).
  let now = $state(Date.now());
  onMount(() => {
    startSessionsStore();
    const tick = setInterval(() => {
      now = Date.now();
    }, 15_000);
    return () => clearInterval(tick);
  });
  const sessions = $derived(sessionsStore.sessions as PortfolioSessionRef[]);

  // Task roll-up uses the four operational columns.
  const classifiedTasks = $derived(classifyTasks(stories, sessions));
  const tasksByColumn = $derived(groupByTaskColumn(classifiedTasks));
  const linkedGoal = $derived(findLinkedGoal(project, objectives));
  const keyResults = $derived(linkedGoal?.keyResults ?? []);
  const prdDescription = $derived(prd?.description?.trim() || project.description);
  /** Overview roll-up counts (Not started / In progress / Active / Complete). */
  const overviewTaskRail = $derived.by(() => {
    const sections = [
      { label: 'Not started', count: 0 },
      { label: 'In progress', count: 0 },
      { label: 'Active', count: 0 },
      { label: 'Complete', count: 0 },
    ];
    for (const item of classifiedTasks) {
      if (item.column === 'not-started') sections[0].count += 1;
      else if (item.column === 'in-progress') sections[1].count += 1;
      else if (item.column === 'active') sections[2].count += 1;
      else sections[3].count += 1;
    }
    return sections;
  });
  /** Flat ordered list for keyboard navigation in the stable task rail. */
  const railStoryOrder = $derived.by(() => {
    const ordered: Story[] = [];
    for (const column of TASK_COLUMNS) {
      for (const item of tasksByColumn[column]) {
        ordered.push(item.story);
      }
    }
    return ordered;
  });
  const kpi = $derived.by(() => {
    let notStarted = 0;
    let inProgress = 0;
    let active = 0;
    let complete = 0;
    for (const item of classifiedTasks) {
      if (item.column === 'not-started') notStarted += 1;
      else if (item.column === 'in-progress') inProgress += 1;
      else if (item.column === 'active') active += 1;
      else complete += 1;
    }
    const total = stories.length;
    return {
      notStarted,
      inProgress,
      active,
      complete,
      total,
      progress: projectProgress(complete, total),
    };
  });

  // ---- status control (WRITABLE — US-010 optimistic persist) ---------------
  let statusOverride = $state<EditableProjectStatus | null>(null);
  $effect(() => {
    void project.id;
    void project.status;
    statusOverride = null;
  });
  const currentStatus = $derived(
    statusOverride ?? toEditableStatus(project.status),
  );
  let statusOpen = $state(false);
  let statusError = $state<string | null>(null);
  let statusSaving = $state(false);

  async function selectStatus(next: EditableProjectStatus) {
    statusOpen = false;
    const previous = currentStatus;
    if (next === previous) return;

    statusOverride = next;
    statusError = null;
    statusSaving = true;
    try {
      const result = await setProjectStatus(
        { id: project.id, company: project.company },
        previous,
        next,
      );
      if (result.ok) {
        onStatusChange?.(project.id, next);
      } else {
        statusOverride = previous;
        statusError = result.error;
      }
    } finally {
      statusSaving = false;
    }
  }

  // ---- Workspace tabs (DESKTOP-005) ----------------------------------------
  // Tasks is the primary/default surface.
  type Tab = 'overview' | 'tasks' | 'files' | 'activity';
  let tab = $state<Tab>('tasks');
  // Keep a stable alias so older contracts that look for board still see Tasks
  // as the board surface via data-testid="tab-board" on the Tasks control.
  const boardTabActive = $derived(tab === 'tasks');

  // ---- Files tab (project-scoped tree via existing list_hq_dir) ------------
  let selectedFilePath = $state<string | null>(null);
  let hqFolderPath = $state('');
  const projectFilesRoot = $derived(projectFilesRootFromPrdPath(project.prdPath));

  $effect(() => {
    void project.id;
    selectedFilePath = null;
  });

  $effect(() => {
    let cancelled = false;
    void invoke<{ hqFolderPath?: string }>('get_config')
      .then((config) => {
        if (!cancelled) hqFolderPath = config?.hqFolderPath ?? '';
      })
      .catch((err) => {
        console.error('ProjectDetailView get_config failed:', err);
        if (!cancelled) hqFolderPath = '';
      });
    return () => {
      cancelled = true;
    };
  });

  function inProjectFilesScope(path: string): boolean {
    const root = projectFilesRoot;
    if (!root) return false;
    return path === root || path.startsWith(`${root}/`);
  }

  function loadProjectChildren(relPath: string): Promise<DirEntry[]> {
    if (!inProjectFilesScope(relPath) && relPath !== projectFilesRoot) {
      return Promise.reject(new Error(`path outside project scope: ${relPath}`));
    }
    return invoke<DirEntry[]>('list_hq_dir', { relPath });
  }

  function handleFileSelect(path: string): void {
    if (!inProjectFilesScope(path)) return;
    selectedFilePath = path;
  }

  // ---- Open project in Claude Code ----------------------------------------
  let claudeBusy = $state(false);
  let claudeMessage = $state<string | null>(null);

  async function openProjectInClaude() {
    if (claudeBusy) return;
    claudeBusy = true;
    claudeMessage = null;
    const folder =
      hqFolderPath && projectFilesRoot
        ? `${hqFolderPath.replace(/\/$/, '')}/${projectFilesRoot}`
        : hqFolderPath || '';
    const prompt = [
      `Open project ${projectDisplayName(project)}`,
      project.prdPath ? `PRD: ${project.prdPath}` : null,
      project.description ? `Description: ${project.description}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n');
    try {
      const url = buildClaudeCodeUrl({ folder, prompt });
      await invoke('open_claude_code_link', { url });
      claudeMessage = 'Opened in Claude Code.';
    } catch (err) {
      console.error('open_claude_code_link failed:', err);
      claudeMessage = 'Could not open Claude Code.';
    } finally {
      claudeBusy = false;
    }
  }

  // Project-scoped live sessions for Activity tab (real sessions only).
  const projectSessions = $derived(liveSessionsForProject(project, sessions));

  function onDocClick(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (target && !target.closest('[data-status-control]')) {
      statusOpen = false;
    }
  }

  onMount(() => {
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  });

  function normalizeLink(value: string | null | undefined): string {
    return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function projectTokensForGoal(value: Project): string[] {
    return [
      value.id,
      value.name,
      value.title,
      value.prdPath.split('/').filter(Boolean).at(-2),
    ]
      .map(normalizeLink)
      .filter(Boolean);
  }

  function findLinkedGoal(value: Project, goals: Objective[]): Objective | null {
    const projectTokens = new Set(projectTokensForGoal(value));
    return (
      goals.find((goal) => {
        const goalTokens = [
          goal.id,
          goal.linearInitiativeId ?? undefined,
          ...(goal.initiativeIds ?? []),
        ]
          .map(normalizeLink)
          .filter(Boolean);
        return goalTokens.some((token) => projectTokens.has(token));
      }) ?? null
    );
  }

  function formatKrValue(value: unknown, unit?: string): string {
    if (value === null || value === undefined || value === '') return '—';
    return `${value}${unit ?? ''}`;
  }

  function krProgress(current: unknown, target: unknown): number {
    const currentNum = Number(current);
    const targetNum = Number(target);
    if (!Number.isFinite(currentNum) || !Number.isFinite(targetNum) || targetNum <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((currentNum / targetNum) * 100)));
  }

  function closeTaskDetail() {
    oncloseStory?.();
  }

  function selectRailStory(story: Story) {
    onselectStory(story);
  }

  function shortStoryId(id: string): string {
    const parts = id.split('-');
    return parts.length > 1 ? parts[parts.length - 1] : id;
  }

  function railMeta(story: Story, column: TaskColumn): string {
    const live = storyLiveRunView(story, sessions, now);
    if (live?.elapsed) return `${TASK_COLUMN_LABEL[column]} · ${live.elapsed}`;
    if (typeof story.priority === 'number') {
      return `${TASK_COLUMN_LABEL[column]} · P${story.priority}`;
    }
    return TASK_COLUMN_LABEL[column];
  }

  /**
   * Keyboard selection in the compact task rail: ArrowUp/Down move selection,
   * Home/End jump, Escape closes detail (also handled in StoryPanel).
   */
  function handleRailKeydown(event: KeyboardEvent) {
    if (!selectedStory || railStoryOrder.length === 0) return;
    const index = railStoryOrder.findIndex((s) => s.id === selectedStory.id);
    if (index < 0) return;

    let nextIndex = index;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      nextIndex = Math.min(railStoryOrder.length - 1, index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      nextIndex = Math.max(0, index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      nextIndex = 0;
    } else if (event.key === 'End') {
      event.preventDefault();
      nextIndex = railStoryOrder.length - 1;
    } else {
      return;
    }

    const next = railStoryOrder[nextIndex];
    if (next && next.id !== selectedStory.id) {
      onselectStory(next);
      // Focus the newly selected row for visible focus continuity.
      queueMicrotask(() => {
        const el = document.querySelector<HTMLElement>(
          `[data-testid="task-rail-row"][data-story-id="${CSS.escape(next.id)}"]`,
        );
        el?.focus();
      });
    }
  }
</script>

<section
  class="project-detail"
  class:has-task-detail={selectedStory != null}
  aria-labelledby="project-detail-title"
  data-testid="project-detail-view"
>
  <header class="detail-header">
    <!-- Breadcrumb: company / Projects / project — preserves company context. -->
    <nav class="breadcrumb" aria-label="Breadcrumb" data-testid="project-breadcrumb">
      {#if project.company}
        <span class="crumb-company" data-testid="crumb-company">{project.company}</span>
        <span class="crumb-sep" aria-hidden="true">/</span>
      {/if}
      <button
        type="button"
        class="back-button"
        data-testid="detail-back"
        onclick={onback}
      >
        <span>Projects</span>
      </button>
      <span class="crumb-sep" aria-hidden="true">/</span>
      <span class="crumb-current">{projectDisplayName(project)}</span>
    </nav>

    <div class="toolbar-row">
      <div class="toolbar-identity">
        <h1 id="project-detail-title">{projectDisplayName(project)}</h1>
        {#if project.description}
          <p class="detail-description">{project.description}</p>
        {/if}
      </div>

      <div class="toolbar-actions" data-testid="project-toolbar-actions">
        <!-- Status control (writable; US-010 persists with optimistic UI). -->
        <div class="status-control" data-status-control data-testid="status-control">
          <button
            type="button"
            class="status-badge status-{currentStatus}"
            data-testid="status-trigger"
            aria-haspopup="listbox"
            aria-expanded={statusOpen}
            disabled={statusSaving}
            onclick={() => (statusOpen = !statusOpen)}
          >
            <span class="status-dot" aria-hidden="true"></span>
            <span>{EDITABLE_PROJECT_STATUS_LABEL[currentStatus]}</span>
            <span class="status-caret" aria-hidden="true">⌄</span>
          </button>
          {#if statusOpen}
            <ul class="status-menu" role="listbox" data-testid="status-menu">
              {#each EDITABLE_PROJECT_STATUSES as status (status)}
                <li>
                  <button
                    type="button"
                    class="status-option"
                    role="option"
                    aria-selected={status === currentStatus}
                    data-testid="status-option-{status}"
                    onclick={() => selectStatus(status)}
                  >
                    <span class="status-dot status-{status}" aria-hidden="true"></span>
                    <span>{EDITABLE_PROJECT_STATUS_LABEL[status]}</span>
                    {#if status === currentStatus}
                      <span class="status-current">current</span>
                    {/if}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>

        {#if statusError}
          <span class="status-error" role="alert" data-testid="status-error">
            {statusError}
          </span>
        {/if}

        <button
          type="button"
          class="toolbar-action"
          data-testid="open-project-claude"
          disabled={claudeBusy}
          onclick={() => void openProjectInClaude()}
        >
          {claudeBusy ? 'Opening…' : 'Open in Claude Code'}
        </button>
        {#if claudeMessage}
          <span class="action-status" role="status">{claudeMessage}</span>
        {/if}
      </div>
    </div>

    <!-- Status row: company badge + content indicators. -->
    <div class="status-row">
      {#if project.company}
        <span class="badge company-badge" data-testid="company-badge">
          <span class="status-dot" aria-hidden="true"></span>
          {project.company}
        </span>
      {/if}

      {#if hasPrd}
        <span class="indicator" data-testid="indicator-prd">
          <span aria-hidden="true">▤</span> PRD
        </span>
      {/if}
      {#if hasReadme}
        <span class="indicator" data-testid="indicator-readme">
          <span aria-hidden="true">▦</span> README
        </span>
      {/if}
      {#if linkedGoal}
        <span class="indicator goal-indicator" data-testid="detail-goal-chip">
          <span aria-hidden="true">◎</span> {linkedGoal.title}
        </span>
      {/if}
      {#if prd?.branchName}
        <span class="indicator" data-testid="indicator-branch">
          <span aria-hidden="true">⎇</span> {prd.branchName}
        </span>
      {/if}
    </div>

    <!-- Compact summary strip — progress + task roll-up counts. -->
    {#if hasPrd && kpi.total > 0}
      <div class="kpi-strip" aria-label="Project metrics">
        <div class="kpi-tile kpi-stories">
          <span class="kpi-label">Stories</span>
          <span class="kpi-value">{kpi.complete}<span class="kpi-slash"> / </span>{kpi.total}</span>
          <span class="kpi-bar" data-testid="detail-progress">
            <span class="kpi-bar-fill" style="width: {kpi.progress.percent}%"></span>
          </span>
        </div>
        <div class="kpi-tile">
          <span class="kpi-label">In Progress</span>
          <span class="kpi-value" class:is-zero={kpi.inProgress === 0}>{kpi.inProgress}</span>
        </div>
        <div class="kpi-tile">
          <span class="kpi-label">Active</span>
          <span class="kpi-value" class:is-zero={kpi.active === 0}>{kpi.active}</span>
        </div>
        <div class="kpi-tile">
          <span class="kpi-label">Done</span>
          <span
            class="kpi-value"
            class:is-zero={kpi.complete === 0}
            class:is-done={kpi.complete > 0}>{kpi.complete}</span
          >
        </div>
      </div>
    {/if}

    <nav class="tabs workspace-tabs" aria-label="Project sections" data-testid="workspace-tabs">
      <button
        type="button"
        class="tab"
        class:active={tab === 'overview'}
        data-testid="tab-overview"
        onclick={() => (tab = 'overview')}
      >
        Overview
      </button>
      <button
        type="button"
        class="tab"
        class:active={boardTabActive}
        data-testid="tab-board"
        data-tab="tasks"
        onclick={() => (tab = 'tasks')}
      >
        Tasks
        {#if kpi.total > 0}
          <span class="tab-count">{kpi.total}</span>
        {/if}
      </button>
      <button
        type="button"
        class="tab"
        class:active={tab === 'files'}
        data-testid="tab-files"
        onclick={() => (tab = 'files')}
      >
        Files
      </button>
      <button
        type="button"
        class="tab"
        class:active={tab === 'activity'}
        data-testid="tab-activity"
        onclick={() => (tab = 'activity')}
      >
        Activity
      </button>
    </nav>
  </header>

  <div class="workspace-body" data-testid="project-workspace-body">
    {#if selectedStory}
      <!-- DESKTOP-006: stable task workspace — compact rail + detail, no modal. -->
      <div
        class="task-workspace"
        data-testid="project-task-workspace"
      >
        <aside
          class="project-task-rail"
          aria-label="Project tasks"
          data-testid="project-task-rail"
        >
          <div class="task-rail-tools">
            <span class="task-rail-count" data-testid="task-rail-count">
              {stories.length} {stories.length === 1 ? 'task' : 'tasks'}
            </span>
            <button
              type="button"
              class="task-rail-close"
              data-testid="task-rail-close"
              aria-label="Close task detail"
              onclick={closeTaskDetail}
            >
              Close
            </button>
          </div>
          <div
            class="task-rail-list"
            role="listbox"
            tabindex="-1"
            aria-label="Project task list"
            onkeydown={handleRailKeydown}
          >
            {#each TASK_COLUMNS as column (column)}
              {@const columnStories = tasksByColumn[column]}
              {#if columnStories.length > 0}
                <div class="task-rail-section" data-testid={`task-rail-section-${column}`}>
                  <div class="task-rail-section-label">
                    <span>{TASK_COLUMN_LABEL[column]}</span>
                    <span>{columnStories.length}</span>
                  </div>
                  {#each columnStories as item (item.story.id)}
                    {@const isSelected = item.story.id === selectedStory.id}
                    {@const isLive = column === 'active'}
                    <button
                      type="button"
                      class="task-rail-row"
                      class:is-selected={isSelected}
                      class:is-live={isLive}
                      role="option"
                      aria-selected={isSelected}
                      tabindex={isSelected ? 0 : -1}
                      data-testid="task-rail-row"
                      data-story-id={item.story.id}
                      aria-label={`Story ${item.story.id}: ${item.story.title}`}
                      onclick={() => selectRailStory(item.story)}
                    >
                      <span class="task-rail-id">{shortStoryId(item.story.id)}</span>
                      <span class="task-rail-copy">
                        <span class="task-rail-title">{item.story.title}</span>
                        <span class="task-rail-meta">{railMeta(item.story, column)}</span>
                      </span>
                      {#if isLive}
                        <span class="live-dot" aria-hidden="true"></span>
                      {:else if item.story.passes}
                        <span class="task-rail-done" aria-hidden="true">✓</span>
                      {:else}
                        <span class="task-rail-spacer" aria-hidden="true"></span>
                      {/if}
                    </button>
                  {/each}
                </div>
              {/if}
            {/each}
            {#if stories.length === 0}
              <div class="task-rail-empty">No tasks</div>
            {/if}
          </div>
        </aside>

        <div class="task-detail-slot" data-testid="project-task-detail-slot">
          <StoryPanel
            story={selectedStory}
            project={project}
            prdPath={project.prdPath}
            onclose={closeTaskDetail}
            onselectDependency={onselectDependency}
            {onStoryPassesChange}
            sessions={sessions}
            {now}
            embedded
          />
        </div>
      </div>
    {:else}
      <div class="detail-body">
        {#if tab === 'overview'}
          <div class="overview detail-layout" data-testid="detail-overview">
            <main class="detail-main">
              <section class="info-card prd-card" data-testid="detail-prd-card">
                <h2>PRD</h2>
                {#if prdLoading}
                  <p class="muted-note">Loading PRD...</p>
                {:else}
                  <p>{prdDescription || 'No PRD summary yet.'}</p>
                  <dl class="info-list">
                    <div>
                      <dt>Stories</dt>
                      <dd>{kpi.complete}/{kpi.total}</dd>
                    </div>
                    <div>
                      <dt>Branch</dt>
                      <dd>{prd?.branchName ?? 'not set'}</dd>
                    </div>
                  </dl>
                {/if}
              </section>

              {#if linkedGoal}
                <section class="info-card key-results-card" data-testid="detail-key-results">
                  <h2>Key results</h2>
                  <p class="goal-line">{linkedGoal.title}</p>
                  {#if keyResults.length === 0}
                    <p class="muted-note">No key results yet.</p>
                  {:else}
                    <div class="kr-list">
                      {#each keyResults as kr, index (kr.id || index)}
                        {@const progressValue = krProgress(kr.current, kr.target)}
                        <div class="kr-row">
                          <span>{kr.title || kr.metric || 'Key result'}</span>
                          <strong
                            >{formatKrValue(kr.current, kr.unit)} -> {formatKrValue(
                              kr.target,
                              kr.unit,
                            )}</strong
                          >
                          <span class="mini-track" aria-label={`${progressValue}% progress`}>
                            <span style={`width: ${progressValue}%`}></span>
                          </span>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </section>
              {/if}

              {#if readmeLoading}
                <p class="muted-note">Loading README...</p>
              {:else if hasReadme}
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                <article class="markdown-body" data-testid="readme-markdown">{@html readmeHtml}</article>
              {:else if project.description}
                <section class="info-card">
                  <h2>Description</h2>
                  <p>{project.description}</p>
                </section>
              {/if}
            </main>

            <aside class="overview-task-rail" data-testid="detail-task-rail">
              <h2>Tasks roll-up</h2>
              {#each overviewTaskRail as item (item.label)}
                <div class="rail-row">
                  <span>{item.label}</span>
                  <strong>{item.count}</strong>
                </div>
              {/each}
            </aside>
          </div>
        {:else if tab === 'tasks'}
          <div class="board-tab tasks-tab" data-testid="detail-board">
            {#if storiesError}
              <div class="drill-error" role="alert">{storiesError}</div>
            {:else if !hasPrd}
              <div class="drill-empty">
                <p>This project has no linked PRD yet, so there are no tasks to show.</p>
              </div>
            {:else}
              <StoryKanban
                {stories}
                {sessions}
                loading={storiesLoading}
                {now}
                onselect={onselectStory}
              />
            {/if}
          </div>
        {:else if tab === 'files'}
          <div class="files-tab" data-testid="detail-files">
            {#if !projectFilesRoot}
              <div class="drill-empty">
                <p>Project path unavailable — open the PRD from Tasks or Overview.</p>
              </div>
            {:else}
              <div class="files-layout">
                <div class="files-tree">
                  {#key projectFilesRoot}
                    <CompanyFileTree
                      rootPath={projectFilesRoot}
                      loadChildren={loadProjectChildren}
                      selectedPath={selectedFilePath}
                      onselect={handleFileSelect}
                    />
                  {/key}
                </div>
                <div class="files-preview">
                  {#if selectedFilePath}
                    <FilePreviewPane path={selectedFilePath} {hqFolderPath} />
                  {:else}
                    <div class="files-empty" data-testid="project-files-empty">
                      Select a project file to preview it
                    </div>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {:else}
          <div class="activity-tab" data-testid="detail-activity">
            <section class="activity-panel" aria-label="Project activity">
              <header class="activity-head">
                <h2>Activity</h2>
                <span class="muted-note">
                  Live sessions matched to this project · contextual, not a global dashboard
                </span>
              </header>
              {#if projectSessions.length === 0}
                <div class="drill-empty" data-testid="project-activity-empty">
                  <p>No live sessions for this project right now.</p>
                </div>
              {:else}
                <ul class="session-list">
                  {#each projectSessions as session (`${session.project}:${session.startedAt ?? session.cwd}:${session.status}`)}
                    <li class="session-row">
                      <div class="session-main">
                        <span class="session-status" data-status={session.status}>
                          {session.status}
                        </span>
                        <strong class="session-project">{session.project || project.id}</strong>
                        {#if session.model}
                          <span class="session-meta">{session.model}</span>
                        {/if}
                        {#if session.tool}
                          <span class="session-meta">{session.tool}</span>
                        {/if}
                      </div>
                      <div class="session-foot">
                        {#if session.lastActivityAt}
                          <span>{relativeActivity(session.lastActivityAt, now)}</span>
                        {:else}
                          <span>signal unavailable</span>
                        {/if}
                        {#if session.cwd}
                          <span class="session-cwd" title={session.cwd}>{session.cwd}</span>
                        {/if}
                      </div>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</section>

<style>
  .project-detail {
    container: project-detail / inline-size;
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-3);
    min-width: 0;
    height: 100%;
    font-family: var(--font-sans);
    /* Naked main canvas */
    background: transparent;
  }

  .detail-header {
    flex-shrink: 0;
    min-width: 0;
  }

  .breadcrumb {
    display: flex;
    align-items: center;
    gap: var(--v4-space-1);
    margin-bottom: var(--v4-space-2);
    min-width: 0;
    font-size: var(--type-secondary, var(--text-sm));
  }

  .crumb-company {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, var(--text-sm));
    text-overflow: ellipsis;
    white-space: nowrap;
    text-transform: capitalize;
  }

  .back-button {
    display: inline-flex;
    align-items: center;
    gap: var(--v4-space-1);
    padding: var(--v4-space-1) var(--v4-space-2);
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 500;
    cursor: pointer;
    transition:
      background 140ms ease,
      color 140ms ease;
  }

  .back-button:hover {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .back-button:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }

  .crumb-sep {
    color: var(--v4-text-3);
  }

  .crumb-current {
    overflow: hidden;
    color: var(--v4-text-2);
    font-size: var(--type-secondary, var(--text-sm));
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .toolbar-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--v4-space-3);
    min-width: 0;
  }

  .toolbar-identity {
    min-width: 0;
    flex: 1 1 200px;
  }

  .toolbar-actions {
    display: flex;
    flex-wrap: wrap;
    flex-shrink: 0;
    align-items: center;
    gap: var(--v4-space-2);
  }

  #project-detail-title {
    margin: 0;
    color: var(--v4-text-1);
    font-family: var(--font-sans);
    font-size: var(--type-detail, var(--text-lg));
    font-weight: 600;
    letter-spacing: 0;
    line-height: 1.15;
  }

  .detail-description {
    margin: var(--v4-row-stack-gap, 3px) 0 0;
    color: var(--v4-text-2);
    font-size: var(--type-body, var(--text-base));
    line-height: 1.5;
  }

  .status-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--v4-space-2);
    margin-top: var(--v4-space-3);
  }

  .badge,
  .status-badge,
  .toolbar-action {
    display: inline-flex;
    align-items: center;
    gap: var(--v4-space-1);
    padding: 3px 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: var(--v4-raised);
    color: var(--v4-text-2);
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 500;
  }

  .toolbar-action {
    border-radius: var(--v4-radius-button);
    cursor: pointer;
    font: inherit;
  }

  .toolbar-action:hover {
    border-color: var(--v4-control-border);
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .toolbar-action:disabled {
    cursor: progress;
    opacity: 0.6;
  }

  .action-status {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
  }

  .status-control {
    position: relative;
  }

  .status-badge {
    cursor: pointer;
    transition:
      background 140ms ease,
      border-color 140ms ease;
  }

  .status-badge:hover {
    border-color: var(--v4-control-border);
    background: var(--v4-active-row);
  }

  .status-badge:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }

  .status-caret {
    color: var(--v4-text-3);
    font-size: var(--type-secondary, var(--text-sm));
    line-height: 1;
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-text-2);
  }

  .status-planned .status-dot,
  .status-dot.status-planned {
    background: var(--v4-text-2);
  }
  .status-prd_created .status-dot,
  .status-dot.status-prd_created {
    background: var(--v4-text-1);
  }
  .status-in_progress .status-dot,
  .status-dot.status-in_progress {
    background: var(--v4-warn);
  }
  .status-completed .status-dot,
  .status-dot.status-completed {
    background: var(--v4-ok);
  }
  .status-archived .status-dot,
  .status-dot.status-archived {
    background: var(--v4-text-3);
  }

  .status-menu {
    position: absolute;
    top: calc(100% + var(--v4-space-1));
    left: 0;
    z-index: 50;
    min-width: 160px;
    margin: 0;
    padding: var(--v4-space-1);
    list-style: none;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-popover);
    background: var(--v4-raised);
    box-shadow: var(--v4-shadow-popover);
  }

  .status-option {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    width: 100%;
    padding: var(--v4-space-1) var(--v4-space-2);
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-body, var(--text-base));
    text-align: left;
    cursor: pointer;
  }

  .status-option:hover {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .status-option[aria-selected='true'] {
    color: var(--v4-text-1);
  }

  .status-current {
    margin-left: auto;
    color: var(--v4-text-3);
    font-size: var(--type-body, var(--text-base));
  }

  .status-badge:disabled {
    cursor: progress;
    opacity: 0.6;
  }

  .status-error {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: var(--v4-raised);
    color: var(--v4-warn);
    font-size: var(--type-secondary, var(--text-sm));
    font-weight: 500;
  }

  .indicator {
    display: inline-flex;
    align-items: center;
    gap: var(--v4-space-1);
    color: var(--v4-text-3);
    font-size: var(--type-secondary, var(--text-sm));
  }

  .kpi-strip {
    display: flex;
    flex-wrap: wrap;
    gap: var(--v4-space-3);
    margin-top: var(--v4-space-4);
    max-width: 760px;
  }

  .kpi-tile {
    display: flex;
    flex: 1 1 110px;
    flex-direction: column;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
    padding: 11px 14px;
    border: 1px solid var(--v4-hairline);
    border-radius: 6px;
    background: var(--v4-raised);
  }

  .kpi-label {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 600;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .kpi-value {
    color: var(--v4-text-1);
    font-family: var(--font-sans);
    font-size: var(--type-section, var(--text-kpi));
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }

  .kpi-value.is-zero {
    color: var(--v4-text-3);
  }

  .kpi-value.is-done {
    color: var(--v4-ok);
  }

  .kpi-slash {
    color: var(--v4-text-3);
    font-weight: 600;
  }

  .kpi-bar {
    display: block;
    width: 100%;
    height: 4px;
    margin-top: var(--v4-space-1);
    overflow: hidden;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
  }

  .kpi-bar-fill {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--v4-ok);
    transition: width 180ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  @media (prefers-reduced-motion: reduce) {
    .kpi-bar-fill {
      transition: none;
    }
  }

  .tabs {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--v4-space-1);
    margin-top: var(--v4-space-4);
    padding: var(--v4-space-1);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-field);
    background: var(--v4-control-faint);
  }

  .tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: var(--v4-space-1) var(--v4-space-3);
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-body, var(--text-sm));
    font-weight: 500;
    cursor: pointer;
    transition:
      background 140ms ease,
      color 140ms ease;
  }

  .tab:hover {
    color: var(--v4-text-1);
  }

  .tab.active {
    background: var(--v4-raised);
    color: var(--v4-text-1);
  }

  .tab:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }

  .tab-count {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-variant-numeric: tabular-nums;
  }

  .workspace-body {
    display: flex;
    flex: 1 1 auto;
    gap: 0;
    min-height: 0;
    min-width: 0;
  }

  .detail-body {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    background: transparent;
  }

  /* DESKTOP-006 stable task workspace: compact rail + detail canvas */
  .task-workspace {
    display: grid;
    grid-template-columns: minmax(200px, 280px) minmax(0, 1fr);
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    border: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: transparent;
  }

  .project-task-rail {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--v4-hairline);
    background: var(--v4-chrome);
  }

  .task-rail-tools {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--v4-space-2);
    padding: var(--v4-space-2) var(--v4-space-2);
    border-bottom: 1px solid var(--v4-hairline);
  }

  .task-rail-count {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 600;
    text-transform: uppercase;
  }

  .task-rail-close {
    display: inline-flex;
    align-items: center;
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

  .task-rail-close:hover {
    border-color: var(--v4-control-border);
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .task-rail-close:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }

  .task-rail-list {
    min-height: 0;
    overflow-y: auto;
    padding: 5px;
  }

  .task-rail-section {
    margin-bottom: var(--v4-space-2);
  }

  .task-rail-section-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--v4-space-2);
    padding: 6px 8px 4px;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 600;
    text-transform: uppercase;
  }

  .task-rail-row {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) 12px;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 48px;
    padding: 6px 8px;
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

  .task-rail-row:hover {
    background: var(--v4-active-row);
  }

  .task-rail-row.is-selected {
    background: var(--v4-active-row);
  }

  .task-rail-row:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 1px;
  }

  .task-rail-id {
    color: var(--v4-text-3);
    font-family: var(--font-mono);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 600;
  }

  .task-rail-copy {
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
  }

  .task-rail-title {
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-rail-meta {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-rail-done {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    text-align: center;
  }

  .task-rail-spacer {
    width: 6px;
  }

  .task-rail-empty {
    padding: var(--v4-space-4);
    color: var(--v4-text-3);
    font-size: var(--type-body, var(--text-base));
    text-align: center;
  }

  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-ok);
  }

  .task-detail-slot {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: transparent;
  }

  @media (prefers-reduced-motion: reduce) {
    .task-rail-row {
      transition: none;
    }
  }

  .overview {
    max-width: 760px;
  }

  .muted-note {
    color: var(--v4-text-3);
    font-size: var(--type-body, var(--text-base));
  }

  .info-card {
    padding: var(--v4-space-4);
    border: 1px solid var(--v4-hairline);
    border-radius: 6px;
    background: var(--v4-control-faint);
  }

  .info-card h2 {
    margin: 0 0 var(--v4-space-2);
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 600;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .info-card p {
    margin: 0;
    color: var(--v4-text-2);
    font-size: var(--type-body, var(--text-base));
    line-height: 1.5;
  }

  .info-list {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2);
    margin: 0;
  }

  .info-list div {
    display: flex;
    gap: var(--v4-space-3);
    font-size: var(--type-body, var(--text-base));
  }

  .info-list dt {
    flex-shrink: 0;
    width: 88px;
    color: var(--v4-text-3);
  }

  .info-list dd {
    margin: 0;
    color: var(--v4-text-2);
  }

  .board-tab,
  .files-tab,
  .activity-tab {
    height: 100%;
    min-height: 0;
    background: transparent;
  }

  .drill-error {
    padding: var(--v4-space-3);
    border: 1px solid var(--v4-hairline);
    border-radius: 6px;
    background: var(--v4-control-faint);
    color: var(--v4-warn);
    font-size: var(--type-body, var(--text-base));
  }

  .drill-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--v4-space-6);
    border: 1px dashed var(--v4-hairline);
    border-radius: 0;
    color: var(--v4-text-3);
    font-size: var(--type-body, var(--text-base));
  }

  .drill-empty p {
    margin: 0;
  }

  .files-layout {
    display: flex;
    min-height: 0;
    height: 100%;
    border: 1px solid var(--v4-hairline);
    border-radius: 0;
    overflow: hidden;
  }

  .files-tree {
    flex: 0 0 260px;
    min-width: 200px;
    max-width: 300px;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 6px;
    border-right: 1px solid var(--v4-hairline);
    background: var(--v4-chrome);
  }

  .files-preview {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    overflow: auto;
  }

  .files-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 160px;
    color: var(--v4-text-3);
    font-size: var(--type-body, var(--text-base));
  }

  .activity-panel {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-3);
    min-width: 0;
  }

  .activity-head {
    display: flex;
    flex-direction: column;
    gap: var(--v4-row-stack-gap, 3px);
  }

  .activity-head h2 {
    margin: 0;
    color: var(--v4-text-1);
    font-size: var(--type-section, var(--text-base));
    font-weight: 600;
  }

  .session-list {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .session-row {
    display: flex;
    flex-direction: column;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
    padding: var(--v4-space-3);
    border: 1px solid var(--v4-hairline);
    border-radius: 6px;
    background: var(--v4-raised);
  }

  .session-main {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--v4-space-2);
    min-width: 0;
  }

  .session-status {
    color: var(--v4-text-2);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 600;
    text-transform: uppercase;
  }

  .session-status[data-status='running'],
  .session-status[data-status='awaiting_input'] {
    color: var(--v4-ok);
  }

  .session-project {
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    font-weight: 600;
  }

  .session-meta,
  .session-foot {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
  }

  .session-foot {
    display: flex;
    flex-wrap: wrap;
    gap: var(--v4-space-2);
    min-width: 0;
  }

  .session-cwd {
    overflow: hidden;
    max-width: 100%;
    font-family: var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- README markdown typography ---------------------------------------- */
  .markdown-body {
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    line-height: 1.6;
  }

  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3),
  .markdown-body :global(h4),
  .markdown-body :global(h5),
  .markdown-body :global(h6) {
    margin: var(--v4-space-5) 0 var(--v4-space-2);
    color: var(--v4-text-1);
    font-weight: 600;
    line-height: 1.3;
  }

  .markdown-body :global(h1) {
    font-size: var(--type-section, var(--text-base));
  }
  .markdown-body :global(h2) {
    padding-bottom: var(--v4-space-1);
    border-bottom: 1px solid var(--v4-hairline);
    font-size: var(--type-body, var(--text-base));
  }
  .markdown-body :global(h3) {
    font-size: var(--type-body, var(--text-base));
  }

  .markdown-body :global(p) {
    margin: var(--v4-space-2) 0;
    color: var(--v4-text-2);
  }

  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    margin: var(--v4-space-2) 0;
    padding-left: var(--v4-space-5);
    color: var(--v4-text-2);
  }

  .markdown-body :global(li) {
    margin: var(--v4-space-1) 0;
  }

  .markdown-body :global(a) {
    color: var(--v4-text-1);
    text-decoration: none;
  }

  .markdown-body :global(a:hover) {
    text-decoration: underline;
  }

  .markdown-body :global(code) {
    padding: 1px var(--v4-space-1);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    font-family: var(--font-mono);
    font-size: var(--type-body, var(--text-base));
  }

  .markdown-body :global(pre) {
    margin: var(--v4-space-3) 0;
    padding: var(--v4-space-3);
    overflow-x: auto;
    border: 1px solid var(--v4-hairline);
    border-radius: 6px;
    background: var(--v4-inset);
  }

  .markdown-body :global(pre code) {
    padding: 0;
    background: transparent;
  }

  .markdown-body :global(blockquote) {
    margin: var(--v4-space-3) 0;
    padding: var(--v4-space-1) var(--v4-space-3);
    border-left: 3px solid var(--v4-control-border);
    color: var(--v4-text-3);
  }

  .markdown-body :global(hr) {
    margin: var(--v4-space-4) 0;
    border: 0;
    border-top: 1px solid var(--v4-hairline);
  }

  .markdown-body :global(strong) {
    color: var(--v4-text-1);
    font-weight: 600;
  }

  .detail-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 220px;
    gap: 16px;
    align-items: start;
    min-width: 0;
  }

  .detail-main {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }

  .info-card,
  .overview-task-rail {
    min-width: 0;
    padding: 14px;
    border: 1px solid var(--v4-hairline);
    border-radius: 6px;
    background: var(--v4-raised);
  }

  .info-card h2,
  .overview-task-rail h2 {
    margin: 0 0 8px;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 600;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .info-card p,
  .goal-line {
    margin: 0;
    color: var(--v4-text-2);
    font-size: var(--type-body, var(--text-base));
    line-height: 1.5;
  }

  .info-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin: 12px 0 0;
  }

  .info-list div {
    min-width: 0;
  }

  .info-list dt {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    text-transform: uppercase;
  }

  .info-list dd {
    margin: 3px 0 0;
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kr-list,
  .overview-task-rail {
    display: flex;
    flex-direction: column;
    gap: 9px;
  }

  .kr-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px 10px;
    align-items: center;
    min-width: 0;
  }

  .kr-row span:first-child,
  .rail-row span {
    overflow: hidden;
    color: var(--v4-text-2);
    font-size: var(--type-body, var(--text-base));
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .kr-row strong,
  .rail-row strong {
    color: var(--v4-text-2);
    font-family: var(--font-mono);
    font-size: var(--type-secondary, var(--text-xs));
    font-weight: 500;
  }

  .mini-track {
    grid-column: 1 / -1;
    height: 4px;
    overflow: hidden;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
  }

  .mini-track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--v4-ok);
  }

  .rail-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  /* Responsive: keep breadcrumb/status/actions visible; board can scroll.
     Task rail collapses safely; primary close/open actions stay visible. */
  @container project-detail (max-width: 760px) {
    .detail-layout {
      grid-template-columns: minmax(0, 1fr);
    }

    .task-workspace {
      grid-template-columns: minmax(160px, 220px) minmax(0, 1fr);
    }

    .files-layout {
      flex-direction: column;
    }

    .files-tree {
      flex: 0 0 auto;
      max-width: none;
      width: 100%;
      max-height: 220px;
      border-right: 0;
      border-bottom: 1px solid var(--v4-hairline);
    }
  }

  @container project-detail (max-width: 560px) {
    .task-workspace {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(140px, 32%) minmax(0, 1fr);
    }

    .project-task-rail {
      border-right: 0;
      border-bottom: 1px solid var(--v4-hairline);
    }

    /* Primary close remains visible in the rail tools strip */
    .task-rail-tools {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--v4-chrome);
    }
  }
</style>
