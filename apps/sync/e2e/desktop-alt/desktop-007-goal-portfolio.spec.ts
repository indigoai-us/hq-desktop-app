import { describe, expect, it } from 'vitest';
import { V4_ROW_STACK_GAP_PX, V4_TYPE_SCALE } from '../../src/desktop-alt/v4/model';
import { readRepoFile } from './harness';

/**
 * DESKTOP-007 — Goal portfolio and drill-down.
 *
 * Source contracts for: scan-friendly list + stable selected-goal detail,
 * no card-grid dashboard / modal, KR current/target/unit/progress honesty,
 * linked projects → ProjectDetailView in place, at-risk Review proposal,
 * owner/quarter/status/notes/counts/empty-loading-error, naked hairline
 * list-detail canvas, five type roles + 3px stacks, keyboard selection,
 * focus-visible, responsive collapse, light/dark, reduced motion/transparency.
 */

describe('DESKTOP-007: goal portfolio and drill-down', () => {
  const page = readRepoFile('src/desktop-alt/pages/CompanyGoalsPage.svelte');
  const companyPage = readRepoFile('src/desktop-alt/pages/CompanyPage.svelte');
  const adapter = readRepoFile('src/desktop-alt/lib/local-projects.ts');
  const tokens = readRepoFile('src/desktop-alt/v4/tokens.css');
  const desktopCss = readRepoFile('src/desktop-alt/styles/desktop-alt.css');

  it('uses a scan-friendly list plus stable selected-goal detail (no card grid, no modal)', () => {
    expect(page).toContain('data-testid="goals-workspace"');
    expect(page).toContain('data-testid="goals-list"');
    expect(page).toContain('data-testid="goal-list-row"');
    expect(page).toContain('data-testid="goal-detail"');
    expect(page).toContain('data-testid="goal-detail-pane"');
    expect(page).toContain('class="list-detail goals-workspace"');
    expect(page).toContain('selectedGoalId');
    // Auto-select first goal for stable detail.
    expect(page).toContain('selectedGoalId = goalKey(goals.objectives[0])');
    // No card-grid dashboard chrome on the portfolio page.
    expect(page).not.toContain('class="goal-card"');
    expect(page).not.toContain('class="goal-stack"');
    expect(page).not.toContain('var(--v4-radius-card)');
    expect(page).not.toContain('var(--v4-shadow-card)');
    // No modal / backdrop.
    expect(page).not.toContain('aria-modal="true"');
    expect(page).not.toContain('goal-backdrop');
    expect(page).not.toContain('detail-backdrop');
    expect(page).not.toMatch(/class=["'][^"']*modal[^"']*["']/);
  });

  it('keeps company route wiring and goals commands intact', () => {
    expect(companyPage).toContain("import CompanyGoalsPage from './CompanyGoalsPage.svelte'");
    expect(companyPage).toContain("{:else if tab === 'goals'}");
    expect(companyPage).toContain('<CompanyGoalsPage slug={company.slug} />');
    expect(page).toContain('loadCompanyGoals(activeSlug)');
    expect(adapter).toContain("invoke<CompanyGoalsWire>('get_local_company_goals'");
    expect(page).toContain('onclick={newGoal}');
    expect(page).toContain("invoke('open_claude_code_link', { url })");
    expect(page).toContain("buildClaudeCodeUrl({ folder: config.hqFolderPath ?? '', prompt })");
  });

  it('renders KR current, target, unit, and honest computed progress in detail', () => {
    expect(page).toContain('data-testid="kr-table"');
    expect(page).toContain('data-testid="kr-row"');
    expect(page).toContain('Current → target');
    expect(page).toContain('{formatValue(kr.current, kr.unit)} → {formatValue(kr.target, kr.unit)}');
    expect(page).toContain('function krProgress(kr: KeyResult): number');
    expect(page).toContain('class="progress-track"');
    expect(page).toContain('style={`width: ${progress}%`}');
    expect(page).toContain('aria-label={`${progress}% progress`}');
    // Zero-progress when current/target missing — never invent.
    expect(page).toContain('if (current === null || target === null || target === 0) return 0;');
  });

  it('shows linked projects and opens ProjectDetailView in place', () => {
    expect(page).toContain('data-testid="linked-projects"');
    expect(page).toContain('data-testid="linked-project-chip"');
    expect(page).toContain("import ProjectDetailView from './ProjectDetailView.svelte'");
    expect(page).toContain('onclick={() => openProject(project)}');
    expect(page).toContain('loadLocalProjectStories(project.prdPath)');
    expect(page).toContain('<ProjectDetailView');
    expect(page).toContain('selectedStory={selectedStory}');
    expect(page).toContain('oncloseStory={closeStory}');
    expect(page).toContain('onback={backToGoals}');
  });

  it('preserves at-risk Review proposal and Claude/agent handoff', () => {
    expect(page).toContain('data-testid="at-risk-note"');
    expect(page).toContain('Review proposal');
    expect(page).toContain('function reviewProposal(objective: Objective)');
    expect(page).toContain('onclick={() => reviewProposal(selectedGoal)}');
    expect(page).toContain('data-testid="review-proposal-button"');
    expect(page).toContain("invoke('open_claude_code_link', { url })");
    expect(page).toContain('/goals ${slug}');
  });

  it('preserves owner, quarter, status, notes, counts, empty/loading/error honesty', () => {
    expect(page).toContain('owner: {ownerLabel(selectedGoal.owner)}');
    expect(page).toContain('target {quarterLabel(selectedGoal.timeframe)');
    expect(page).toContain('data-testid="goal-detail-status"');
    expect(page).toContain('data-testid="goal-detail-meta"');
    expect(page).toContain('data-testid="goal-detail-description"');
    expect(page).toContain('{#if selectedGoal.description}');
    expect(page).toContain('linked to {linkedProjectCount}');
    expect(page).toContain('data-testid="empty-goals-state"');
    expect(page).toContain('No goals yet');
    expect(page).toContain('data-testid="goals-loading"');
    expect(page).toContain('data-testid="goals-error"');
    expect(page).toContain('Goals unavailable. Try again after a sync.');
    // No fabricated proposal counts.
    expect(page).not.toContain('agent proposed');
    expect(page).toContain("return 'Unassigned'");
  });

  it('uses naked hairline list/detail; rounded only for controls, selection, progress', () => {
    expect(page).toContain('background: transparent');
    expect(page).toContain('border: 1px solid var(--v4-hairline)');
    expect(page).toContain('border-top: 1px solid var(--v4-hairline)');
    expect(page).toContain('border-radius: 0');
    // Selection / controls may round.
    expect(page).toMatch(/\.goal-list-row\s*\{[\s\S]*?border-radius:\s*6px;/);
    expect(page).toContain('border-radius: var(--v4-radius-button)');
    expect(page).toContain('border-radius: var(--v4-radius-pill)');
    // Shared list-detail collapse utility remains available.
    expect(desktopCss).toContain('.list-detail');
    expect(desktopCss).toContain(".list-detail[data-detail-open='true'] > .list-pane");
  });

  it('uses five type roles and 3px title/meta stacks', () => {
    expect(V4_TYPE_SCALE).toEqual({
      metadata: 10,
      secondary: 11,
      body: 12,
      section: 14,
      detail: 18,
    });
    expect(V4_ROW_STACK_GAP_PX).toBe(3);
    expect(tokens).toContain('--v4-row-stack-gap: 3px');
    expect(page).toContain('--type-detail');
    expect(page).toContain('--type-section');
    expect(page).toContain('--type-body');
    expect(page).toContain('--type-secondary');
    expect(page).toContain('--type-metadata');
    expect(page).toContain('var(--v4-row-stack-gap, 3px)');
    expect(page).toContain('title-stack');
  });

  it('supports keyboard selection, focus-visible, and responsive collapse', () => {
    expect(page).toContain('handleListKeydown');
    expect(page).toContain("event.key === 'ArrowDown'");
    expect(page).toContain("event.key === 'ArrowUp'");
    expect(page).toContain("event.key === 'Home'");
    expect(page).toContain("event.key === 'End'");
    expect(page).toContain('tabindex={isSelected ? 0 : -1}');
    expect(page).toContain('aria-selected={isSelected}');
    expect(page).toContain('role="listbox"');
    expect(page).toContain('role="option"');
    expect(page).toContain('.goal-list-row:focus-visible');
    expect(page).toContain('data-detail-open={selectedGoal != null ? \'true\' : \'false\'}');
    expect(page).toContain('data-testid="goal-detail-back"');
    expect(page).toContain('@media (max-width: 820px)');
    expect(page).toContain('@media (max-width: 720px)');
  });

  it('honors light/dark and reduced motion/transparency', () => {
    expect(tokens).toContain('--v4-text-1: #0a0c10');
    expect(tokens).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[\s\S]*?--v4-text-1:\s*#f4f6f8/,
    );
    expect(page).toContain('@media (prefers-reduced-motion: reduce)');
    expect(page).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(page).toContain('animation: none');
  });
});
