import { describe, expect, it } from 'vitest';
import {
  classifyStories,
  classifyStory,
  groupByState,
  labelColor,
  labelColorIndex,
  LABEL_PALETTE,
  LABEL_PALETTE_SIZE,
  deriveProjectState,
  projectProgress,
  projectProgressFromStories,
  effectiveProjectStatus,
  projectListStatus,
  projectRecencyTime,
  compareProjectsByRecency,
  matchesStatusFilter,
  projectDisplayName,
  portfolioColumn,
  projectHasLiveSignal,
  liveSessionsForProject,
  sessionMatchesProject,
  projectLiveRunView,
  formatLiveElapsed,
  portfolioStateContext,
  groupProjectsByPortfolioColumn,
  PORTFOLIO_COLUMNS,
  PORTFOLIO_COLUMN_LABEL,
  matchesPortfolioStateFilter,
  taskColumn,
  taskIsStarted,
  sessionMatchesStory,
  storyLiveRunView,
  classifyTasks,
  groupByTaskColumn,
  projectFilesRootFromPrdPath,
  TASK_COLUMNS,
  TASK_COLUMN_LABEL,
  type Story,
  type Project,
  type PortfolioSessionRef,
} from '../projects-model';

function story(id: string, overrides: Partial<Story> = {}): Story {
  return {
    id,
    title: `Story ${id}`,
    description: '',
    acceptanceCriteria: [],
    passes: false,
    labels: [],
    dependsOn: [],
    ...overrides,
  };
}

function portfolioSession(
  overrides: Partial<PortfolioSessionRef> = {},
): PortfolioSessionRef {
  return {
    project: 'hq-desktop-app',
    company: 'indigo',
    cwd: '/Users/x/HQ/companies/indigo/projects/hq-desktop-app',
    status: 'running',
    startedAt: '2026-07-18T12:00:00Z',
    lastActivityAt: '2026-07-18T12:05:00Z',
    ...overrides,
  };
}

describe('classifyStories', () => {
  it('marks passing stories complete', () => {
    const result = classifyStories([
      story('US-001', { passes: true }),
      story('US-002', { passes: true }),
    ]);
    expect(result.map((c) => c.state)).toEqual(['complete', 'complete']);
  });

  it('assigns the first eligible story in-progress and the rest pending', () => {
    const result = classifyStories([
      story('US-001', { passes: false }),
      story('US-002', { passes: false }),
      story('US-003', { passes: false }),
    ]);
    expect(result.map((c) => c.state)).toEqual([
      'in-progress',
      'pending',
      'pending',
    ]);
  });

  it('blocks a story with an unmet dependency', () => {
    const result = classifyStories([
      story('US-001', { passes: false }),
      // US-002 depends on the not-yet-complete US-001 → blocked
      story('US-002', { passes: false, dependsOn: ['US-001'] }),
    ]);
    const byId = Object.fromEntries(result.map((c) => [c.story.id, c.state]));
    expect(byId['US-001']).toBe('in-progress');
    expect(byId['US-002']).toBe('blocked');
  });

  it('unblocks a story once its dependency passes', () => {
    const result = classifyStories([
      story('US-001', { passes: true }),
      story('US-002', { passes: false, dependsOn: ['US-001'] }),
    ]);
    const byId = Object.fromEntries(result.map((c) => [c.story.id, c.state]));
    expect(byId['US-001']).toBe('complete');
    // dependency met → US-002 is now the first eligible → in-progress
    expect(byId['US-002']).toBe('in-progress');
  });

  it('only assigns in-progress to one story even with multiple eligible', () => {
    const result = classifyStories([
      story('US-001', { passes: true }),
      story('US-002', { passes: false }),
      story('US-003', { passes: false }),
      story('US-004', { passes: false, dependsOn: ['US-009'] }),
    ]);
    const states = result.map((c) => c.state);
    expect(states.filter((s) => s === 'in-progress')).toHaveLength(1);
    expect(states).toEqual(['complete', 'in-progress', 'pending', 'blocked']);
  });
});

describe('classifyStory', () => {
  it('matches classifyStories for a complete story', () => {
    const all = [story('US-001', { passes: true })];
    expect(classifyStory(all[0], all)).toBe('complete');
  });

  it('reports blocked when a dependency is unmet', () => {
    const all = [
      story('US-001', { passes: false }),
      story('US-002', { passes: false, dependsOn: ['US-001'] }),
    ];
    expect(classifyStory(all[1], all)).toBe('blocked');
  });

  it('distinguishes in-progress from pending via isFirstEligible', () => {
    const all = [story('US-001', { passes: false })];
    expect(classifyStory(all[0], all, true)).toBe('in-progress');
    expect(classifyStory(all[0], all, false)).toBe('pending');
  });
});

describe('groupByState', () => {
  it('buckets each classified story into its state', () => {
    const groups = groupByState(
      classifyStories([
        story('US-001', { passes: true }),
        story('US-002', { passes: false }),
        story('US-003', { passes: false, dependsOn: ['US-009'] }),
      ]),
    );
    expect(groups.complete.map((c) => c.story.id)).toEqual(['US-001']);
    expect(groups['in-progress'].map((c) => c.story.id)).toEqual(['US-002']);
    expect(groups.blocked.map((c) => c.story.id)).toEqual(['US-003']);
    expect(groups.pending).toEqual([]);
  });
});

describe('labelColor determinism', () => {
  it('returns an identical color for the same input', () => {
    const a = labelColor('frontend');
    const b = labelColor('frontend');
    expect(a).toEqual(b);
    expect(a.index).toBe(b.index);
  });

  it('produces a stable index across calls', () => {
    expect(labelColorIndex('frontend')).toBe(labelColorIndex('frontend'));
    expect(labelColorIndex('backend')).toBe(labelColorIndex('backend'));
  });

  it('keeps the index within the palette bounds', () => {
    const samples = ['a', 'bug', 'frontend', 'backend', 'infra', '', 'P1', '🔥'];
    for (const s of samples) {
      const idx = labelColorIndex(s);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(LABEL_PALETTE_SIZE);
      expect(labelColor(s)).toBe(LABEL_PALETTE[idx]);
    }
  });

  it('emits CSS-var-friendly hsla tokens across a multi-hue palette', () => {
    const hues = new Set<string>();
    for (const entry of LABEL_PALETTE) {
      // Each token is a well-formed hsla() string.
      expect(entry.background).toMatch(/^hsla\(\d+, \d+%, \d+%, [\d.]+\)$/);
      expect(entry.border).toMatch(/^hsla\(\d+, \d+%, \d+%, [\d.]+\)$/);
      expect(entry.foreground).toMatch(/^hsla\(\d+, \d+%, \d+%, [\d.]+\)$/);
      hues.add(entry.background.split(',')[0]);
    }
    // The palette spans multiple distinct hues (not a single monochrome shade).
    expect(hues.size).toBeGreaterThan(1);
  });

  it('distributes a realistic label set across multiple shades', () => {
    const labels = [
      'frontend',
      'backend',
      'infra',
      'bug',
      'feature',
      'docs',
      'test',
      'design',
      'security',
      'perf',
      'ci',
      'release',
    ];
    const indices = new Set(labels.map(labelColorIndex));
    // With 12 labels over 8 buckets we expect more than one bucket used.
    expect(indices.size).toBeGreaterThan(3);
  });
});

describe('deriveProjectState', () => {
  it('is pending when there are no stories', () => {
    expect(deriveProjectState(0, 0)).toBe('pending');
  });
  it('is complete when all stories pass', () => {
    expect(deriveProjectState(4, 4)).toBe('complete');
  });
  it('is in-progress when some stories pass', () => {
    expect(deriveProjectState(1, 4)).toBe('in-progress');
  });
  it('is pending when no stories pass', () => {
    expect(deriveProjectState(0, 4)).toBe('pending');
  });
});

describe('projectProgress', () => {
  it('derives complete/total/percent/state', () => {
    expect(projectProgress(3, 6)).toEqual({
      complete: 3,
      total: 6,
      percent: 50,
      state: 'in-progress',
    });
  });

  it('returns 0% with pending state for an empty project', () => {
    expect(projectProgress(0, 0)).toEqual({
      complete: 0,
      total: 0,
      percent: 0,
      state: 'pending',
    });
  });

  it('rounds the percentage', () => {
    expect(projectProgress(1, 3).percent).toBe(33);
    expect(projectProgress(2, 3).percent).toBe(67);
  });

  it('clamps complete to total and floors negatives', () => {
    expect(projectProgress(9, 4)).toEqual({
      complete: 4,
      total: 4,
      percent: 100,
      state: 'complete',
    });
    expect(projectProgress(-2, 4).complete).toBe(0);
  });

  it('computes progress directly from stories', () => {
    const stories = [
      story('US-001', { passes: true }),
      story('US-002', { passes: true }),
      story('US-003', { passes: false }),
    ];
    expect(projectProgressFromStories(stories)).toEqual({
      complete: 2,
      total: 3,
      percent: 67,
      state: 'in-progress',
    });
  });
});

describe('effectiveProjectStatus', () => {
  const base: Pick<Project, 'status' | 'storiesComplete' | 'storiesTotal'> = {
    status: 'active',
    storiesComplete: 0,
    storiesTotal: 0,
  };

  it('treats archived as terminal regardless of story rollup', () => {
    expect(
      effectiveProjectStatus({ ...base, status: 'archived', storiesComplete: 5, storiesTotal: 5 }),
    ).toBe('archived');
  });

  it('reads as complete when an active board has all stories passing', () => {
    expect(
      effectiveProjectStatus({ ...base, storiesComplete: 4, storiesTotal: 4 }),
    ).toBe('complete');
  });

  it('reads as in-progress when some stories pass', () => {
    expect(
      effectiveProjectStatus({ ...base, storiesComplete: 2, storiesTotal: 4 }),
    ).toBe('in-progress');
  });

  it('reads as pending when no stories pass', () => {
    expect(
      effectiveProjectStatus({ ...base, storiesComplete: 0, storiesTotal: 4 }),
    ).toBe('pending');
  });
});

describe('projectDisplayName', () => {
  const proj = (overrides: Partial<Project>): Project => ({
    id: 'proj-x',
    description: '',
    company: 'indigo',
    status: 'active',
    prdPath: '/x/prd.json',
    storiesTotal: 0,
    storiesComplete: 0,
    ...overrides,
  });

  it('prefers name, then title, then id', () => {
    expect(projectDisplayName(proj({ name: 'Name', title: 'Title' }))).toBe('Name');
    expect(projectDisplayName(proj({ title: 'Title' }))).toBe('Title');
    expect(projectDisplayName(proj({}))).toBe('proj-x');
  });
});

describe('project recency ordering', () => {
  const proj = (overrides: Partial<Project>): Project => ({
    id: 'proj-x',
    description: '',
    company: 'indigo',
    status: 'active',
    prdPath: '/x/prd.json',
    storiesTotal: 0,
    storiesComplete: 0,
    ...overrides,
  });

  it('prefers updatedAt, falling back to createdAt', () => {
    expect(
      projectRecencyTime(
        proj({
          createdAt: '2026-06-10T00:00:00Z',
          updatedAt: '2026-06-12T00:00:00Z',
        }),
      ),
    ).toBe(Date.parse('2026-06-12T00:00:00Z'));

    expect(projectRecencyTime(proj({ createdAt: '2026-06-10T00:00:00Z' }))).toBe(
      Date.parse('2026-06-10T00:00:00Z'),
    );
  });

  it('sorts newest projects first before status/name tie breakers', () => {
    const sorted = [
      proj({ id: 'a', title: 'Alpha', updatedAt: '2026-06-10T00:00:00Z' }),
      proj({ id: 'b', title: 'Beta', updatedAt: '2026-06-12T00:00:00Z' }),
      proj({ id: 'c', title: 'Charlie', createdAt: '2026-06-11T00:00:00Z' }),
    ].sort(compareProjectsByRecency);

    expect(sorted.map((project) => project.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('projectListStatus board-status mapping', () => {
  const base = { storiesComplete: 0, storiesTotal: 0 };

  it('treats HQ board status "in_progress" as In Progress even with no completed stories', () => {
    // Regression: HQ board.json uses `in_progress`, which was previously absent
    // from the recognized board statuses, so manually-started projects fell
    // into "Planned" instead of "In Progress".
    expect(projectListStatus({ ...base, status: 'in_progress' })).toBe('in-progress');
    expect(projectListStatus({ ...base, status: 'in-progress' })).toBe('in-progress');
  });

  it('keeps live/active/running board statuses on the emphasised "live" state', () => {
    expect(projectListStatus({ ...base, status: 'active' })).toBe('live');
    expect(projectListStatus({ ...base, status: 'running' })).toBe('live');
    expect(projectListStatus({ ...base, status: 'live' })).toBe('live');
  });

  it('leaves planned-style statuses as pending (Planned group)', () => {
    expect(projectListStatus({ ...base, status: 'prd_created' })).toBe('pending');
    expect(projectListStatus({ ...base, status: 'exploring' })).toBe('pending');
    expect(projectListStatus({ ...base, status: '' })).toBe('pending');
  });

  it('an in_progress project surfaces under both the Active and In Progress filters', () => {
    const status = projectListStatus({ ...base, status: 'in_progress' });
    expect(matchesStatusFilter(status, 'active')).toBe(true);
    expect(matchesStatusFilter(status, 'in-progress')).toBe(true);
    expect(matchesStatusFilter(status, 'complete')).toBe(false);
  });

  it('archived stays terminal regardless of in-progress aliases', () => {
    expect(projectListStatus({ status: 'archived', storiesComplete: 0, storiesTotal: 5 })).toBe(
      'archived',
    );
  });
});

describe('DESKTOP-004 portfolio Kanban columns', () => {
  const proj = (overrides: Partial<Project> = {}): Project => ({
    id: 'hq-desktop-app',
    name: 'HQ Desktop app',
    description: 'Native shell',
    company: 'indigo',
    status: 'planned',
    prdPath: '/hq/companies/indigo/projects/hq-desktop-app/prd.json',
    storiesTotal: 4,
    storiesComplete: 0,
    ...overrides,
  });

  const session = (overrides: Partial<PortfolioSessionRef> = {}): PortfolioSessionRef => ({
    project: 'hq-desktop-app',
    company: 'indigo',
    cwd: '/Users/x/HQ/companies/indigo/projects/hq-desktop-app',
    status: 'running',
    startedAt: '2026-07-18T12:00:00Z',
    lastActivityAt: '2026-07-18T12:05:00Z',
    ...overrides,
  });

  it('exposes exactly four columns with the shared labels', () => {
    expect([...PORTFOLIO_COLUMNS]).toEqual([
      'not-started',
      'in-progress',
      'active',
      'complete',
    ]);
    expect(PORTFOLIO_COLUMN_LABEL['not-started']).toBe('Not started');
    expect(PORTFOLIO_COLUMN_LABEL['in-progress']).toBe('In progress');
    expect(PORTFOLIO_COLUMN_LABEL.active).toBe('Active');
    expect(PORTFOLIO_COLUMN_LABEL.complete).toBe('Complete');
  });

  it('maps complete only from true completion status/progress', () => {
    expect(portfolioColumn(proj({ storiesComplete: 4, storiesTotal: 4 }), false)).toBe(
      'complete',
    );
    expect(portfolioColumn(proj({ status: 'completed', storiesComplete: 0, storiesTotal: 4 }), false)).toBe(
      'complete',
    );
    // Partial progress is never Complete.
    expect(portfolioColumn(proj({ storiesComplete: 2, storiesTotal: 4 }), false)).toBe(
      'in-progress',
    );
  });

  it('puts Active only when a live execution signal is present', () => {
    // Board status active/live/running alone is In progress without a signal.
    expect(portfolioColumn(proj({ status: 'active' }), false)).toBe('in-progress');
    expect(portfolioColumn(proj({ status: 'live' }), false)).toBe('in-progress');
    expect(portfolioColumn(proj({ status: 'running' }), false)).toBe('in-progress');
    // Live signal → Active even if stories are still pending.
    expect(portfolioColumn(proj({ status: 'planned' }), true)).toBe('active');
    // Live signal never overrides true completion.
    expect(portfolioColumn(proj({ storiesComplete: 4, storiesTotal: 4 }), true)).toBe(
      'complete',
    );
  });

  it('returns unfinished work to In progress when the live signal ends', () => {
    const started = proj({ status: 'in_progress', storiesComplete: 1, storiesTotal: 4 });
    expect(portfolioColumn(started, true)).toBe('active');
    expect(portfolioColumn(started, false)).toBe('in-progress');
  });

  it('keeps planned work with no progress in Not started', () => {
    expect(portfolioColumn(proj({ status: 'planned' }), false)).toBe('not-started');
    expect(portfolioColumn(proj({ status: 'prd_created' }), false)).toBe('not-started');
  });

  it('matches sessions to projects by identity tokens and company', () => {
    const p = proj();
    expect(sessionMatchesProject(session(), p)).toBe(true);
    expect(sessionMatchesProject(session({ project: 'other-thing', cwd: '/tmp' }), p)).toBe(
      false,
    );
    expect(
      sessionMatchesProject(session({ company: 'other-co' }), p),
    ).toBe(false);
    // Empty session company does not exclude.
    expect(sessionMatchesProject(session({ company: '' }), p)).toBe(true);
  });

  it('counts only running/awaiting_input as live signals', () => {
    const p = proj();
    const sessions = [
      session({ status: 'running' }),
      session({ status: 'idle' }),
      session({ status: 'ended' }),
      session({ status: 'awaiting_input', project: 'hq-desktop-app' }),
    ];
    const live = liveSessionsForProject(p, sessions);
    expect(live).toHaveLength(2);
    expect(projectHasLiveSignal(p, sessions)).toBe(true);
    expect(projectHasLiveSignal(p, [session({ status: 'idle' })])).toBe(false);
  });

  it('builds live run views from real session fields only (no synthetic telemetry)', () => {
    const now = Date.parse('2026-07-18T12:10:00Z');
    const view = projectLiveRunView(
      proj({ storiesComplete: 1, storiesTotal: 4 }),
      [session({ status: 'running', startedAt: '2026-07-18T12:00:00Z' })],
      now,
    );
    expect(view).not.toBeNull();
    expect(view!.phase).toBe('Running');
    expect(view!.elapsed).toBe('10:00');
    expect(view!.workers).toBe(1);
    // Subagent count is not on the session contract → null (never invented 0).
    expect(view!.subagents).toBeNull();
    expect(view!.progressPercent).toBe(25);
    expect(view!.lastSignalAt).toBe('2026-07-18T12:05:00Z');

    // No live sessions → null view (do not fabricate a run block).
    expect(projectLiveRunView(proj(), [session({ status: 'ended' })], now)).toBeNull();
  });

  it('formats elapsed only from real startedAt timestamps', () => {
    const now = Date.parse('2026-07-18T13:00:00Z');
    expect(formatLiveElapsed('2026-07-18T12:00:00Z', now)).toBe('1:00:00');
    expect(formatLiveElapsed(null, now)).toBeNull();
    expect(formatLiveElapsed('not-a-date', now)).toBeNull();
  });

  it('groups projects into all four portfolio columns', () => {
    const projects = [
      proj({ id: 'a', name: 'A', status: 'planned', storiesComplete: 0, storiesTotal: 3 }),
      proj({
        id: 'b',
        name: 'B',
        status: 'in_progress',
        storiesComplete: 1,
        storiesTotal: 3,
        prdPath: '/hq/companies/indigo/projects/b/prd.json',
      }),
      proj({
        id: 'c',
        name: 'C',
        status: 'active',
        storiesComplete: 1,
        storiesTotal: 3,
        prdPath: '/hq/companies/indigo/projects/c/prd.json',
      }),
      proj({
        id: 'd',
        name: 'D',
        status: 'completed',
        storiesComplete: 3,
        storiesTotal: 3,
        prdPath: '/hq/companies/indigo/projects/d/prd.json',
      }),
    ];
    const sessions = [
      session({
        project: 'c',
        cwd: '/hq/companies/indigo/projects/c',
        status: 'running',
      }),
    ];
    const groups = groupProjectsByPortfolioColumn(projects, sessions);
    expect(groups['not-started'].map((p) => p.id)).toEqual(['a']);
    expect(groups['in-progress'].map((p) => p.id)).toEqual(['b']);
    expect(groups.active.map((p) => p.id)).toEqual(['c']);
    expect(groups.complete.map((p) => p.id)).toEqual(['d']);
  });

  it('filters portfolio columns without conflating Active and In progress', () => {
    expect(matchesPortfolioStateFilter('active', 'active')).toBe(true);
    expect(matchesPortfolioStateFilter('in-progress', 'active')).toBe(false);
    expect(matchesPortfolioStateFilter('active', 'in-progress')).toBe(false);
    expect(matchesPortfolioStateFilter('not-started', 'all')).toBe(true);
  });

  it('renders calm non-live state context without fake worker telemetry', () => {
    expect(portfolioStateContext('not-started', proj())).toContain('No run expected');
    expect(
      portfolioStateContext('in-progress', proj({ storiesComplete: 2, storiesTotal: 4 })),
    ).toContain('no active worker');
    expect(
      portfolioStateContext('complete', proj({ storiesComplete: 4, storiesTotal: 4 })),
    ).toBe('All tasks passed');
  });
});

describe('DESKTOP-005 task columns + live match', () => {
  it('exposes the four task columns with shared labels', () => {
    expect([...TASK_COLUMNS]).toEqual([
      'not-started',
      'in-progress',
      'active',
      'complete',
    ]);
    expect(TASK_COLUMN_LABEL.active).toBe('Active');
  });

  it('matches sessions to stories by id token only (no invented fields)', () => {
    const s = portfolioSession({
      project: 'hq-desktop-app',
      source: 'execute-task DESKTOP-005',
      cwd: '/hq/companies/indigo/projects/hq-desktop-app',
    });
    expect(sessionMatchesStory(s, story('DESKTOP-005'))).toBe(true);
    expect(sessionMatchesStory(s, story('DESKTOP-009'))).toBe(false);
  });

  it('places Active only with live signal; ended signal returns started work to In progress', () => {
    const stories = [
      story('A', { passes: true }),
      story('B', { notes: 'mid-run' }),
      story('C'),
    ];
    expect(taskColumn(stories[0], stories, false)).toBe('complete');
    expect(taskColumn(stories[1], stories, true)).toBe('active');
    expect(taskColumn(stories[1], stories, false)).toBe('in-progress');
    expect(taskIsStarted(stories[1], stories)).toBe(true);
    // First eligible without notes: A complete → B is first eligible among remaining,
    // but B already has notes. C has no notes and is not first eligible → not-started.
    expect(taskColumn(stories[2], stories, false)).toBe('not-started');
  });

  it('builds honest storyLiveRunView and never fabricates when no match', () => {
    const now = Date.parse('2026-07-18T12:10:00Z');
    const s = portfolioSession({
      source: 'run DESKTOP-005',
      startedAt: '2026-07-18T12:00:00Z',
      lastActivityAt: '2026-07-18T12:05:00Z',
    });
    const view = storyLiveRunView(
      story('DESKTOP-005', { acceptanceCriteria: ['a', 'b', 'c', 'd'] }),
      [s],
      now,
    );
    expect(view).not.toBeNull();
    expect(view!.phase).toBe('Running');
    expect(view!.elapsed).toBe('10:00');
    expect(view!.workers).toBe(1);
    expect(view!.subagents).toBeNull();
    expect(view!.progressPercent).toBe(0);
    expect(storyLiveRunView(story('OTHER'), [s], now)).toBeNull();
    expect(
      storyLiveRunView(
        story('DESKTOP-005'),
        [portfolioSession({ status: 'ended', source: 'DESKTOP-005' })],
        now,
      ),
    ).toBeNull();
  });

  it('groups classified tasks into four columns', () => {
    const stories = [
      story('done', { passes: true }),
      story('live', { notes: 'x' }),
      story('wait', { dependsOn: ['done'] }),
    ];
    const sessions = [portfolioSession({ source: 'working on live', status: 'running' })];
    const groups = groupByTaskColumn(classifyTasks(stories, sessions));
    expect(groups.complete.map((c) => c.story.id)).toEqual(['done']);
    expect(groups.active.map((c) => c.story.id)).toEqual(['live']);
  });

  it('derives project files root from prdPath without inventing paths', () => {
    expect(
      projectFilesRootFromPrdPath('/Users/x/HQ/companies/indigo/projects/hq-desktop-app/prd.json'),
    ).toBe('companies/indigo/projects/hq-desktop-app');
    expect(projectFilesRootFromPrdPath('companies/indigo/projects/foo/prd.json')).toBe(
      'companies/indigo/projects/foo',
    );
    expect(projectFilesRootFromPrdPath(null)).toBeNull();
    expect(projectFilesRootFromPrdPath('/tmp/elsewhere/prd.json')).toBeNull();
  });
});
