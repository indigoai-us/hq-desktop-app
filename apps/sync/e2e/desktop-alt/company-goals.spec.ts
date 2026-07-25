import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

describe('desktop-alt company Goals view source contract (US-006 / DESKTOP-007)', () => {
  const page = readRepoFile('src/desktop-alt/pages/CompanyGoalsPage.svelte');
  const companyPage = readRepoFile('src/desktop-alt/pages/CompanyPage.svelte');
  const adapter = readRepoFile('src/desktop-alt/lib/local-projects.ts');

  it('wires the dedicated Goals section to get_local_company_goals', () => {
    expect(companyPage).toContain("import CompanyGoalsPage from './CompanyGoalsPage.svelte'");
    expect(companyPage).toContain("{:else if tab === 'goals'}");
    expect(companyPage).toContain('<CompanyGoalsPage slug={company.slug} />');
    expect(page).toContain('loadCompanyGoals(activeSlug)');
    expect(adapter).toContain("invoke<CompanyGoalsWire>('get_local_company_goals'");
  });

  it('renders KR rows with current-to-target values and progress bars', () => {
    expect(page).toContain('data-testid="kr-table"');
    expect(page).toContain('data-testid="kr-row"');
    expect(page).toContain('Current → target');
    expect(page).toContain('{formatValue(kr.current, kr.unit)} → {formatValue(kr.target, kr.unit)}');
    expect(page).toContain('class="progress-track"');
    expect(page).toContain('style={`width: ${progress}%`}');
    expect(page).toContain('aria-label={`${progress}% progress`}');
  });

  it('renders owner, target quarter, linked projects, and at-risk surfacing', () => {
    expect(page).toContain('owner: {ownerLabel(selectedGoal.owner)}');
    expect(page).toContain('target {quarterLabel(selectedGoal.timeframe)');
    expect(page).toContain('data-testid="linked-projects"');
    expect(page).toContain('data-testid="linked-project-chip"');
    expect(page).toContain('data-testid="at-risk-note"');
    expect(page).toContain('Review proposal');
    expect(page).toContain('onclick={() => reviewProposal(selectedGoal)}');
    expect(page).toContain('onclick={newGoal}');
    expect(page).toContain("invoke('open_claude_code_link', { url })");
    expect(page).toContain("buildClaudeCodeUrl({ folder: config.hqFolderPath ?? '', prompt })");
    // At-risk goals still surface via status tone / risk row (no card border chrome).
    expect(page).toContain("tone: 'warn'");
    expect(page).toContain('class:at-risk={selectedStatus.atRisk}');
  });

  it('linked project chips drill into the existing project detail view', () => {
    expect(page).toContain("import ProjectDetailView from './ProjectDetailView.svelte'");
    expect(page).toContain('onclick={() => openProject(project)}');
    expect(page).toContain('loadLocalProjectStories(project.prdPath)');
    expect(page).toContain('<ProjectDetailView');
    // DESKTOP-005: task detail docks inside ProjectDetailView (no modal sibling).
    expect(page).toContain('selectedStory={selectedStory}');
    expect(page).toContain('oncloseStory={closeStory}');
  });

  it('has the empty state for companies with no local goals file', () => {
    expect(page).toContain('data-testid="empty-goals-state"');
    expect(page).toContain('No goals yet');
  });

  it('DESKTOP-007: list + detail portfolio without card-grid dashboard', () => {
    expect(page).toContain('data-testid="goals-workspace"');
    expect(page).toContain('data-testid="goal-list-row"');
    expect(page).toContain('data-testid="goal-detail"');
    expect(page).not.toContain('class="goal-card"');
    expect(page).not.toContain('aria-modal="true"');
  });
});
