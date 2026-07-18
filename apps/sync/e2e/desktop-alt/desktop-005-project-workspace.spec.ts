import { describe, expect, it } from 'vitest';
import {
  TASK_COLUMNS,
  TASK_COLUMN_LABEL,
  taskColumn,
  storyLiveRunView,
  sessionMatchesStory,
  projectFilesRootFromPrdPath,
  type Story,
  type PortfolioSessionRef,
} from '../../src/desktop-alt/lib/projects-model';
import { V4_ROW_STACK_GAP_PX, V4_TYPE_SCALE } from '../../src/desktop-alt/v4/model';
import { readRepoFile } from './harness';

/**
 * DESKTOP-005 — Project workspace.
 *
 * Source contracts for: company/Projects/project breadcrumb + writable status,
 * Overview/Tasks/Files/Activity with Tasks default, four task columns, Board/List,
 * honest Active live monitoring, in-workspace task opening (no modal backdrop),
 * naked canvas + five type roles, preserved PRD/README/goal/branch/roll-up/Claude.
 */

describe('DESKTOP-005: project workspace', () => {
  const detail = readRepoFile('src/desktop-alt/pages/ProjectDetailView.svelte');
  const kanban = readRepoFile('src/desktop-alt/components/StoryKanban.svelte');
  const card = readRepoFile('src/desktop-alt/components/StoryCard.svelte');
  const panel = readRepoFile('src/desktop-alt/v4/StoryPanel.svelte');
  const model = readRepoFile('src/desktop-alt/lib/projects-model.ts');
  const projects = readRepoFile('src/desktop-alt/pages/CompanyProjectsPage.svelte');
  const board = readRepoFile('src/desktop-alt/panels/CompanyBoardPanel.svelte');

  const baseStory = (overrides: Partial<Story> = {}): Story => ({
    id: 'DESKTOP-005',
    title: 'Project workspace',
    description: '',
    acceptanceCriteria: ['a', 'b', 'c', 'd'],
    passes: false,
    labels: [],
    dependsOn: [],
    ...overrides,
  });

  const session = (overrides: Partial<PortfolioSessionRef> = {}): PortfolioSessionRef => ({
    project: 'hq-desktop-app',
    company: 'indigo',
    cwd: '/Users/x/HQ/companies/indigo/projects/hq-desktop-app',
    status: 'running',
    startedAt: '2026-07-18T12:00:00Z',
    lastActivityAt: '2026-07-18T12:05:00Z',
    source: 'execute-task DESKTOP-005',
    ...overrides,
  });

  it('toolbar preserves company / Projects / project breadcrumb and writable status', () => {
    expect(detail).toContain('data-testid="project-breadcrumb"');
    expect(detail).toContain('data-testid="crumb-company"');
    expect(detail).toContain('data-testid="detail-back"');
    expect(detail).toContain('>Projects</span>');
    expect(detail).toContain('projectDisplayName(project)');
    expect(detail).toContain('data-testid="status-control"');
    expect(detail).toContain('EDITABLE_PROJECT_STATUSES');
    expect(detail).toContain('setProjectStatus');
    expect(detail).toContain('data-testid="status-trigger"');
  });

  it('provides Overview, Tasks, Files, Activity with Tasks as default surface', () => {
    expect(detail).toContain("tab = $state<Tab>('tasks')");
    expect(detail).toContain('data-testid="tab-overview"');
    expect(detail).toContain('data-testid="tab-board"');
    expect(detail).toContain('data-testid="tab-files"');
    expect(detail).toContain('data-testid="tab-activity"');
    expect(detail).toContain('data-testid="workspace-tabs"');
    expect(detail).toContain('Tasks');
    expect(detail).toContain('Files');
    expect(detail).toContain('Activity');
    expect(detail).toContain('data-testid="detail-overview"');
    expect(detail).toContain('data-testid="detail-board"');
    expect(detail).toContain('data-testid="detail-files"');
    expect(detail).toContain('data-testid="detail-activity"');
  });

  it('defaults Tasks to Kanban with exactly four shared columns', () => {
    expect([...TASK_COLUMNS]).toEqual([
      'not-started',
      'in-progress',
      'active',
      'complete',
    ]);
    expect(TASK_COLUMN_LABEL['not-started']).toBe('Not started');
    expect(TASK_COLUMN_LABEL['in-progress']).toBe('In progress');
    expect(TASK_COLUMN_LABEL.active).toBe('Active');
    expect(TASK_COLUMN_LABEL.complete).toBe('Complete');

    expect(kanban).toContain("viewMode = $state<ViewMode>('board')");
    expect(kanban).toContain('TASK_COLUMNS');
    expect(kanban).toContain('TASK_COLUMN_LABEL');
    expect(kanban).toContain('data-testid="task-kanban"');
    expect(kanban).toContain('data-testid={`task-column-${column}`}');
    expect(kanban).toContain('data-testid="view-toggle-board"');
    expect(kanban).toContain('data-testid="view-toggle-list"');
  });

  it('maps Active only from live session signals matched to the task', () => {
    const stories = [
      baseStory({ id: 'DESKTOP-001', passes: true }),
      baseStory({ id: 'DESKTOP-005', notes: 'started' }),
      baseStory({ id: 'DESKTOP-006' }),
    ];
    // Board status alone is not used; complete when passes.
    expect(taskColumn(stories[0], stories, false)).toBe('complete');
    // Live match → Active.
    expect(taskColumn(stories[1], stories, true)).toBe('active');
    // Signal end + started (notes) → In progress.
    expect(taskColumn(stories[1], stories, false)).toBe('in-progress');
    // Untouched eligible without start markers → Not started (unless first-eligible).
    // First eligible among non-complete is DESKTOP-005 with notes; DESKTOP-006 with no notes:
    expect(taskColumn(stories[2], stories, false)).toBe('not-started');

    expect(sessionMatchesStory(session(), baseStory({ id: 'DESKTOP-005' }))).toBe(true);
    expect(sessionMatchesStory(session({ source: 'other' }), baseStory({ id: 'DESKTOP-009' }))).toBe(
      false,
    );
    expect(model).toContain('sessionMatchesStory');
    expect(model).toContain('storyLiveRunView');
    expect(model).toContain("raw === 'running' || raw === 'awaiting_input'");
  });

  it('Active task cards show only real live fields and never synthesize telemetry', () => {
    const now = Date.parse('2026-07-18T12:10:00Z');
    const view = storyLiveRunView(baseStory(), [session()], now);
    expect(view).not.toBeNull();
    expect(view!.phase).toBe('Running');
    expect(view!.elapsed).toBe('10:00');
    expect(view!.workers).toBe(1);
    expect(view!.subagents).toBeNull();
    expect(view!.progressPercent).toBe(0); // unfinished → 0/4 AC
    expect(view!.lastSignalAt).toBe('2026-07-18T12:05:00Z');
    // No live match → no fabricated run block.
    expect(storyLiveRunView(baseStory({ id: 'OTHER-1' }), [session()], now)).toBeNull();
    expect(storyLiveRunView(baseStory(), [session({ status: 'ended' })], now)).toBeNull();

    expect(card).toContain('data-testid="story-live-run"');
    expect(card).toContain('liveRun.phase');
    expect(card).toContain('liveRun.elapsed');
    expect(card).toContain('liveRun.workers');
    expect(card).toContain('subagents unavailable');
    expect(card).toContain('signal unavailable');
    expect(card).toContain('relativeActivity(liveRun.lastSignalAt, now)');
    // Calm status only — no alert thresholds.
    expect(card).not.toContain('alert-threshold');
    expect(card).not.toContain('is-alerting');
    expect(kanban).not.toContain('alert-threshold');
  });

  it('opens a task inside the project workspace without a dimmed modal backdrop', () => {
    expect(detail).toContain('data-testid="project-task-detail-slot"');
    expect(detail).toContain('data-testid="project-task-workspace"');
    expect(detail).toContain('data-testid="project-task-rail"');
    expect(detail).toContain('<StoryPanel');
    expect(detail).toContain('story={selectedStory}');
    expect(detail).toContain('embedded');
    expect(detail).not.toContain('class="story-backdrop"');
    expect(detail).not.toContain('detail-backdrop');

    expect(panel).not.toContain('class="story-backdrop"');
    expect(panel).toContain('embedded');
    expect(panel).toContain('data-testid="v4-story-panel"');
    expect(panel).toContain('is-embedded');
    // No backdrop element remains in markup (comments about the removal are fine).
    expect(panel).not.toMatch(/class=["']story-backdrop["']/);
    expect(panel).not.toMatch(/<div[^>]*story-backdrop/);

    // Parents pass selection into the workspace rather than overlaying a modal sibling.
    expect(projects).toContain('selectedStory={selectedStory}');
    expect(projects).toContain('oncloseStory={closeStory}');
    expect(projects).not.toContain('<StoryPanel');
    expect(board).toContain('selectedStory={selectedStory}');
    expect(board).toContain('oncloseStory={closeStory}');
    expect(board).not.toContain('<StoryPanel');
  });

  it('preserves the open project workspace across same-company background refreshes', () => {
    expect(projects).toContain('let loadedSlug: string | null = null');
    expect(projects).toContain('const companyChanged = loadedSlug !== activeSlug');
    expect(projects).toContain('if (companyChanged) {');
    expect(projects).toContain(
      'selected = allProjects.find((project) => project.id === selected?.id) ?? selected',
    );

    const resetBlock = projects.match(/if \(companyChanged\) \{([\s\S]*?)\n    \}/)?.[1] ?? '';
    expect(resetBlock).toContain('selected = null');
    expect(resetBlock).toContain('selectedStoryId = null');
  });

  it('preserves PRD, README, linked goal, branch, task roll-up, progress, and Claude actions', () => {
    expect(detail).toContain('data-testid="detail-prd-card"');
    expect(detail).toContain('loadLocalProjectReadme');
    expect(detail).toContain('data-testid="readme-markdown"');
    expect(detail).toContain('data-testid="detail-goal-chip"');
    expect(detail).toContain('prd?.branchName');
    expect(detail).toContain('data-testid="detail-task-rail"');
    expect(detail).toContain('data-testid="detail-progress"');
    expect(detail).toContain('projectProgress');
    expect(detail).toContain('data-testid="open-project-claude"');
    expect(detail).toContain("invoke('open_claude_code_link'");
    expect(detail).toContain('buildClaudeCodeUrl');
    // Files tab uses existing list_hq_dir + Open in Claude via FilePreviewPane.
    expect(detail).toContain('CompanyFileTree');
    expect(detail).toContain('FilePreviewPane');
    expect(detail).toContain('list_hq_dir');
    expect(projectFilesRootFromPrdPath(
      '/Users/x/HQ/companies/indigo/projects/hq-desktop-app/prd.json',
    )).toBe('companies/indigo/projects/hq-desktop-app');
  });

  it('keeps main canvas naked with rounded task cards only; five type roles + 3px stack', () => {
    expect(V4_TYPE_SCALE).toEqual({
      metadata: 10,
      secondary: 11,
      body: 12,
      section: 14,
      detail: 18,
    });
    expect(V4_ROW_STACK_GAP_PX).toBe(3);
    expect(detail).toContain('--type-detail');
    expect(detail).toContain('--type-body');
    expect(detail).toContain('--type-secondary');
    expect(detail).toContain('--type-metadata');
    expect(detail).toContain('--type-section');
    expect(detail).toContain('var(--v4-row-stack-gap, 3px)');
    expect(card).toContain('title-stack');
    expect(card).toContain('var(--v4-row-stack-gap, 3px)');
    expect(card).toMatch(/\.story-card\s*\{[\s\S]*?border-radius:\s*6px;/);
    expect(kanban).toMatch(/\.kanban-column\s*\{[\s\S]*?border-radius:\s*0;/);
    expect(kanban).toMatch(/\.kanban-column\s*\{[\s\S]*?background:\s*transparent;/);
    expect(kanban).toContain('overflow-x: auto');
  });

  it('keeps breadcrumb/status/actions visible while the board can scroll horizontally', () => {
    expect(detail).toContain('flex-shrink: 0');
    expect(detail).toContain('data-testid="project-toolbar-actions"');
    expect(detail).toContain('@container project-detail');
    expect(kanban).toContain('overflow-x: auto');
    expect(kanban).toContain('min-width: 720px');
  });
});
