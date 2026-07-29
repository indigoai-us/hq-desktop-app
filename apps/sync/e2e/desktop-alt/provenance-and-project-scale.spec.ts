import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

describe('project and task provenance source contract', () => {
  const projects = readRepoFile('src/desktop-alt/pages/CompanyProjectsPage.svelte');
  const overview = readRepoFile('src/desktop-alt/panels/CompanyBoardPanel.svelte');
  const goals = readRepoFile('src/desktop-alt/pages/CompanyGoalsPage.svelte');
  const projectRow = readRepoFile('src/desktop-alt/components/ProjectRow.svelte');
  const projectDetail = readRepoFile('src/desktop-alt/pages/ProjectDetailView.svelte');
  const storyCard = readRepoFile('src/desktop-alt/components/StoryCard.svelte');
  const storyList = readRepoFile('src/desktop-alt/components/StoryList.svelte');
  const storyPanel = readRepoFile('src/desktop-alt/v4/StoryPanel.svelte');
  const provenanceLine = readRepoFile('src/desktop-alt/components/ProvenanceLine.svelte');

  it('uses one honest provenance renderer with explicit missing-data labels', () => {
    expect(provenanceLine).toContain('provenanceView,');
    expect(provenanceLine).toContain('Unassigned');
    expect(provenanceLine).toContain('Unknown source');
    expect(provenanceLine).toContain('view.people');
    expect(provenanceLine).toContain('view.origin');
    expect(provenanceLine).toContain('compactSummary');
    expect(provenanceLine).not.toContain('.person:not(:first-child)');
    expect(provenanceLine).toContain('unavailable');
    expect(provenanceLine).toContain('Attribution unavailable');
  });

  it('merges best-effort cloud attribution into local projects before every company surface', () => {
    for (const source of [projects, overview, goals]) {
      expect(source).toContain('loadCompanyProjectProvenance');
      expect(source).toContain('indexProjectProvenance');
      expect(source).toContain('applyProjectProvenance');
    }
    expect(projects).toContain('normalizeProvenance(project.provenance).owner');
    expect(projects).not.toContain('creatorByKey');
  });

  it('never promotes a creator into the project owner field', () => {
    expect(projects).toMatch(
      /function leadLabel[\s\S]*?normalizeProvenance\(project\.provenance\)\.owner/,
    );
    expect(projects).toContain('ownerLabel={leadLabel(project)}');
  });

  it('renders provenance on project cards, portfolio list rows, overview rows, and project header', () => {
    expect(projectRow).toContain('<ProvenanceLine');
    expect(projectRow).toContain('kind="project"');
    expect(projects).toContain('data-testid="project-list-provenance"');
    expect(overview).toContain('data-testid="inflight-provenance"');
    expect(projectDetail).toContain('data-testid="project-detail-provenance"');
    expect(projectDetail).toContain('detailProvenance');
    expect(projectDetail).toContain('prd?.provenance');
    expect(goals).toContain('testid="linked-project-provenance"');
  });

  it('renders provenance on board/list task cards, task rail, and task detail', () => {
    expect(storyCard).toContain('<ProvenanceLine');
    expect(storyCard).toContain('kind="story"');
    expect(storyList).toContain('data-testid="story-list-provenance"');
    expect(projectDetail).toContain('data-testid="task-rail-provenance"');
    expect(storyPanel).toContain('data-testid="task-detail-provenance"');
    expect(overview).toContain('provenance: current?.story.provenance');
    expect(overview).toContain('data-testid="inflight-story-provenance"');
  });

  it('keeps task provenance visible at narrow list widths', () => {
    expect(storyList).not.toMatch(
      /@container[^{]*\{[\s\S]*?\.story-provenance[\s\S]*?display:\s*none/,
    );
  });

  it('threads lookup failures to project attribution surfaces', () => {
    for (const source of [projects, overview, goals]) {
      expect(source).toContain('provenanceUnavailable');
      expect(source).toContain('unavailable={provenanceUnavailable}');
    }
  });
});

describe('large project collections stay complete without mounting every row', () => {
  const projects = readRepoFile('src/desktop-alt/pages/CompanyProjectsPage.svelte');
  const projectList = readRepoFile('src/desktop-alt/components/ProjectListView.svelte');
  const overview = readRepoFile('src/desktop-alt/panels/CompanyBoardPanel.svelte');

  it('caps only the overview preview at eight and sends the remainder to full Projects', () => {
    expect(overview).toContain('OVERVIEW_PROJECT_LIMIT');
    expect(overview).toContain('visibleInFlightProjects');
    expect(overview).toContain('inFlightRemaining');
    expect(overview).toContain('{#each visibleInFlightProjects as project');
    expect(overview).toContain('data-testid="overview-projects-remaining"');
    expect(overview).toContain('onopenprojects?.()');
    // Story-detail lookups must be bounded by the same preview, not all 364.
    expect(overview).toContain(
      'const targets = visibleInFlightProjects.filter((project) => project.prdPath)',
    );
  });

  it('progressively renders every full Projects board/list group with honest remaining counts', () => {
    expect(projects).toContain('PROJECT_RENDER_BATCH');
    expect(projects).toContain('progressiveWindow');
    expect(projects).toContain('visibleByColumn');
    expect(projects).toContain('data-testid={`show-more-projects-${column}`}');
    expect(projects).toContain('remaining');
    expect(projects).toContain('nextCount');
    // Filters and grouping still run over the complete project collection.
    expect(projects).toContain('groupProjectsByPortfolioColumn(filteredCompanyProjects');
  });

  it('also bounds the reusable ProjectListView sections without changing section totals', () => {
    expect(projectList).toContain('PROJECT_RENDER_BATCH');
    expect(projectList).toContain('progressiveWindow(section.projects');
    expect(projectList).toContain('section.projects.length');
    expect(projectList).toContain('data-testid="project-section-show-more"');
  });
});
