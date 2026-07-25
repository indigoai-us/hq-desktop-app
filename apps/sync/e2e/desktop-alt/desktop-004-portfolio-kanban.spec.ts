import { describe, expect, it } from 'vitest';
import {
  PORTFOLIO_COLUMNS,
  PORTFOLIO_COLUMN_LABEL,
  portfolioColumn,
  projectLiveRunView,
  type Project,
  type PortfolioSessionRef,
} from '../../src/desktop-alt/lib/projects-model';
import { V4_ROW_STACK_GAP_PX, V4_TYPE_SCALE } from '../../src/desktop-alt/v4/model';
import { readRepoFile } from './harness';

/**
 * DESKTOP-004 — Project portfolio Kanban.
 *
 * Source contracts for: four operational columns, Board/List + filters, real
 * Active live-signal mapping (not board.json "active"), no synthetic run
 * telemetry, naked board canvas with rounded cards only, five type roles +
 * 3px title/meta stack, and preserved project open / status / goal-link /
 * Claude Code / error surfaces.
 */

describe('DESKTOP-004: project portfolio Kanban', () => {
  const page = readRepoFile('src/desktop-alt/pages/CompanyProjectsPage.svelte');
  const row = readRepoFile('src/desktop-alt/components/ProjectRow.svelte');
  const model = readRepoFile('src/desktop-alt/lib/projects-model.ts');
  const companyPage = readRepoFile('src/desktop-alt/pages/CompanyPage.svelte');

  const baseProject = (overrides: Partial<Project> = {}): Project => ({
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

  it('defaults Company Projects to a Kanban with exactly four shared columns', () => {
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

    expect(page).toContain("viewMode = $state<PortfolioViewMode>('board')");
    expect(page).toContain('data-testid="portfolio-kanban"');
    expect(page).toContain('data-testid={`portfolio-column-${column}`}');
    expect(page).toContain('PORTFOLIO_COLUMNS');
    expect(page).toContain('PORTFOLIO_COLUMN_LABEL');
    // Exactly the four labels appear as column titles (no Planned/Running/Archived headers).
    expect(page).not.toContain("'{PORTFOLIO_COLUMN_LABEL[column]}'");
    expect(model).toContain("export type PortfolioColumn = 'not-started' | 'in-progress' | 'active' | 'complete'");
  });

  it('keeps Board/List beside search, state filter, and owner filter; New project is primary', () => {
    expect(page).toContain('data-testid="portfolio-tools"');
    expect(page).toContain('data-testid="project-search"');
    expect(page).toContain('data-testid="portfolio-state-filter"');
    expect(page).toContain('data-testid="portfolio-owner-filter"');
    expect(page).toContain('data-testid="view-toggle-board"');
    expect(page).toContain('data-testid="view-toggle-list"');
    expect(page).toContain('Owner · Anyone');
    expect(page).toContain('New project');
    expect(page).toContain('onclick={() => void onnewproject?.()}');
    expect(page).toContain('class="primary-action"');
    // Control order: search → state → owner → (legacy) → Board/List.
    const tools = page.indexOf('data-testid="portfolio-tools"');
    const search = page.indexOf('data-testid="project-search"');
    const state = page.indexOf('data-testid="portfolio-state-filter"');
    const owner = page.indexOf('data-testid="portfolio-owner-filter"');
    const board = page.indexOf('data-testid="view-toggle-board"');
    expect(tools).toBeGreaterThan(-1);
    expect(search).toBeGreaterThan(tools);
    expect(state).toBeGreaterThan(search);
    expect(owner).toBeGreaterThan(state);
    expect(board).toBeGreaterThan(owner);
  });

  it('maps Active only from live execution signals; In progress is not interchangeable', () => {
    // Board status alone is not Active.
    expect(portfolioColumn(baseProject({ status: 'active' }), false)).toBe('in-progress');
    expect(portfolioColumn(baseProject({ status: 'live' }), false)).toBe('in-progress');
    expect(portfolioColumn(baseProject({ status: 'running' }), false)).toBe('in-progress');
    // Live signal is Active.
    expect(portfolioColumn(baseProject({ status: 'planned' }), true)).toBe('active');
    // Signal end + unfinished → In progress.
    expect(
      portfolioColumn(baseProject({ status: 'in_progress', storiesComplete: 1, storiesTotal: 4 }), false),
    ).toBe('in-progress');
    // Complete only when true completion.
    expect(
      portfolioColumn(baseProject({ storiesComplete: 4, storiesTotal: 4 }), true),
    ).toBe('complete');

    expect(page).toContain('projectLiveRunView(project, sessions, now)');
    expect(page).toContain('portfolioColumn(project,');
    expect(page).toContain("startSessionsStore()");
    expect(page).toContain('sessionsStore.sessions');
    expect(model).toContain('isPortfolioLiveStatus');
    expect(model).toContain("raw === 'running' || raw === 'awaiting_input'");
  });

  it('Active cards show only real live fields and never synthesize telemetry', () => {
    const now = Date.parse('2026-07-18T12:10:00Z');
    const view = projectLiveRunView(
      baseProject({ storiesComplete: 1, storiesTotal: 4 }),
      [session()],
      now,
    );
    expect(view).not.toBeNull();
    expect(view!.phase).toBe('Running');
    expect(view!.elapsed).toBe('10:00');
    expect(view!.workers).toBe(1);
    expect(view!.subagents).toBeNull();
    expect(view!.progressPercent).toBe(25);
    expect(view!.lastSignalAt).toBe('2026-07-18T12:05:00Z');
    // No live sessions → no fabricated run block.
    expect(projectLiveRunView(baseProject(), [session({ status: 'ended' })], now)).toBeNull();

    expect(row).toContain('data-testid="project-live-run"');
    expect(row).toContain('liveRun.phase');
    expect(row).toContain('liveRun.elapsed');
    expect(row).toContain('liveRun.workers');
    expect(row).toContain('subagents unavailable');
    expect(row).toContain('signal unavailable');
    expect(row).toContain('relativeActivity(liveRun.lastSignalAt, now)');
    // Never invent worker/subagent counts as literals on the card.
    expect(row).not.toContain('1 worker · 0 subagents');
    expect(model).toContain('AgentSession has no subagent count');
    expect(model).toContain('subagents: null');
  });

  it('project cards expose name, description, goal, owner, progress, and state context', () => {
    expect(row).toContain('projectDisplayName(project)');
    expect(row).toContain('project.description');
    expect(row).toContain('goalLabel');
    expect(row).toContain('ownerLabel');
    expect(row).toContain('projectProgress');
    expect(row).toContain('stateContext');
    expect(page).toContain('goalLabel={goal}');
    expect(page).toContain('ownerLabel={leadLabel(project)}');
    expect(page).toContain('portfolioStateContext(column, project)');
    expect(page).toContain("liveRun={column === 'active' ? liveRun : null}");
  });

  it('keeps the board canvas naked: rounded cards, not rounded column wells', () => {
    expect(page).toMatch(/\.kanban-board\s*\{[\s\S]*?background:\s*transparent;/);
    expect(page).toMatch(/\.kanban-column\s*\{[\s\S]*?border-radius:\s*0;/);
    expect(page).toMatch(/\.kanban-column\s*\{[\s\S]*?background:\s*transparent;/);
    expect(page).toContain('border-bottom: 1px solid var(--v4-hairline)');
    // Cards remain rounded movable work objects.
    expect(row).toMatch(/\.project-card\s*\{[\s\S]*?border-radius:\s*6px;/);
    // No giant Active column well.
    expect(page).not.toContain('active-column');
    expect(page).not.toContain('linear-gradient(180deg');
  });

  it('uses five type roles and title/meta 3px stack', () => {
    expect(V4_TYPE_SCALE).toEqual({
      metadata: 10,
      secondary: 11,
      body: 12,
      section: 14,
      detail: 18,
    });
    expect(V4_ROW_STACK_GAP_PX).toBe(3);
    expect(page).toContain('--type-detail');
    expect(page).toContain('--type-body');
    expect(page).toContain('--type-secondary');
    expect(page).toContain('--type-metadata');
    expect(page).toContain('--type-section');
    expect(page).toContain('var(--v4-row-stack-gap, 3px)');
    expect(row).toContain('var(--v4-row-stack-gap, 3px)');
    expect(row).toContain('title-stack');
  });

  it('preserves project open, status writes, goal-link, Claude Code, errors, and loading', () => {
    expect(page).toContain('void openProject(project)');
    expect(page).toContain('onselect={(p) => void openProject(p)}');
    expect(page).toContain('<ProjectDetailView');
    expect(page).toContain('onStatusChange={onProjectStatusChange}');
    expect(page).toContain('void requestLinkProject(project)');
    expect(page).toContain("invoke('open_claude_code_link', { url })");
    expect(page).toContain('buildClaudeCodeUrl');
    expect(page).toContain("error = 'Projects unavailable. Try again after a sync.'");
    expect(page).toContain('data-testid="empty-projects-state"');
    expect(page).toContain('data-testid="filtered-projects-empty-state"');
    expect(page).toContain('aria-busy={loading}');
    expect(page).toContain('get_company_project_creators');
    expect(page).toContain("'Unassigned'");
    // New project remains wired from the company page shell.
    expect(companyPage).toContain('onnewproject={startNewProject}');
    expect(companyPage).toContain('<CompanyProjectsPage');
  });

  it('allows the board to horizontal-scroll while primary controls stay visible', () => {
    expect(page).toMatch(/\.kanban-board\s*\{[\s\S]*?overflow-x:\s*auto;/);
    expect(page).toContain('flex-shrink: 0');
    expect(page).toContain('portfolio-tools');
    expect(page).toContain('@container company-projects (max-width: 760px)');
    expect(page).toContain('prefers-reduced-motion: reduce');
  });
});
