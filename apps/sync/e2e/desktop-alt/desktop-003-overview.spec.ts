import { describe, expect, it } from 'vitest';
import { V4_ROW_STACK_GAP_PX, V4_TYPE_SCALE } from '../../src/desktop-alt/v4/model';
import { readRepoFile } from './harness';

/**
 * DESKTOP-003 — Actionable company overview.
 *
 * Source contracts for: section order (pulse → needs you → in flight → goals →
 * recent activity), naked canvas sections, honest zero-goal “No linked work”,
 * Invite/New project retained with ops under More, preserved real actions, and
 * five-role typography + 3px title/meta slots.
 */

describe('DESKTOP-003: actionable company overview', () => {
  const panel = readRepoFile('src/desktop-alt/panels/CompanyBoardPanel.svelte');
  const goalCard = readRepoFile('src/desktop-alt/v4/GoalCard.svelte');
  const digest = readRepoFile('src/desktop-alt/components/OverviewActivityDigest.svelte');
  const companyPage = readRepoFile('src/desktop-alt/pages/CompanyPage.svelte');
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const needsYou = readRepoFile('src/desktop-alt/v4/NeedsYouCard.svelte');
  const tokens = readRepoFile('src/desktop-alt/v4/tokens.css');

  it('orders pulse, Needs you, In flight, Goals, and Recent activity', () => {
    const pulse = panel.indexOf('data-testid="overview-pulse"');
    const needs = panel.indexOf('data-testid="overview-needs-you"');
    const inflight = panel.indexOf('data-testid="overview-in-flight"');
    const goals = panel.indexOf('data-testid="overview-goals"');
    const activity = panel.indexOf('data-testid="overview-activity-section"');

    expect(pulse).toBeGreaterThan(-1);
    expect(needs).toBeGreaterThan(pulse);
    expect(inflight).toBeGreaterThan(needs);
    expect(goals).toBeGreaterThan(inflight);
    expect(activity).toBeGreaterThan(goals);

    expect(panel).toContain('>Needs you<');
    expect(panel).toContain('>In flight<');
    expect(panel).toContain('>Goals<');
    expect(digest).toContain('>Recent activity<');
    // Compact pulse uses real counts only (no invented health beyond connected/error).
    expect(panel).toContain('stories moving');
    expect(panel).toContain('checks passing');
    expect(panel).toContain('cloud connected');
    expect(panel).toContain('local only');
    expect(panel).not.toContain('class="stat-strip"');
  });

  it('keeps main canvas naked: hairlines + whitespace, not rounded section boxes', () => {
    // Overview sections explicitly drop outer raised/rounded containers.
    expect(panel).toMatch(
      /\.overview-section\s*\{[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*transparent;/,
    );
    expect(panel).toMatch(/\.company-board\s*\{[\s\S]*?background:\s*transparent;/);
    // Goal rows are list separators, not card shells.
    expect(goalCard).toMatch(/\.goal-card\s*\{[\s\S]*?border-radius:\s*0;/);
    expect(goalCard).toMatch(/border-bottom:\s*1px solid var\(--v4-rowline\)/);
    // Activity digest is row-based, not a multi-card dashboard.
    expect(digest).toContain('data-testid="overview-recent-activity"');
    expect(digest).not.toContain('class="digest-stats"');
    expect(digest).not.toContain('class="digest-card"');
    // Discrete monitors/controls may keep radius (pulse strip, status pills, actions).
    expect(panel).toMatch(/\.pulse-row\s*\{[\s\S]*?border-radius:\s*var\(--v4-radius-field\)/);
    expect(panel).toMatch(/\.status-pill\s*\{[\s\S]*?border-radius:\s*var\(--v4-radius-pill\)/);
  });

  it('explains zero-progress goals as No linked work instead of empty decorative cards', () => {
    expect(goalCard).toContain("No linked work");
    expect(goalCard).toContain('noLinkedWork');
    expect(goalCard).toContain('data-testid="goal-linked-work"');
    expect(goalCard).toContain('projectCount === 0');
    // Still shows real project/story counts when linked work exists.
    expect(goalCard).toContain('projects');
    expect(goalCard).toContain('stories');
    expect(panel).toContain('projectCount={linkedProjects(objective).length}');
  });

  it('keeps Invite and New project visible; operational Settings moves under More', () => {
    expect(companyPage).toContain('<button type="button" onclick={openInvite}>Invite</button>');
    expect(companyPage).toContain("New project");
    expect(companyPage).toContain('onclick={() => void startNewProject()}');
    // Toolbar no longer surfaces Settings; ops live under sidebar More.
    expect(companyPage).not.toContain(
      '<button type="button" onclick={openCompanySettings}>Settings</button>',
    );
    expect(companyPage).toContain('DESKTOP-003');
    // Console settings helper remains available for deep links / future More.
    expect(companyPage).toContain('void openExternal(companySettingsUrl(company.slug));');
  });

  it('preserves real actions: review/inspect/connect, goal/project nav, sync honesty, invites, errors', () => {
    // Needs-you actions from real board/goals/cloud state.
    expect(panel).toContain("import NeedsYouCard from '../v4/NeedsYouCard.svelte'");
    expect(panel).toContain('handleNeedsYouAction');
    expect(panel).toContain("label: 'Review'");
    expect(panel).toContain("label: 'Inspect'");
    expect(panel).toContain("label: 'Connect'");
    expect(panel).toContain('boardState.board.review');
    expect(panel).toContain('unlinkedGoals');
    expect(panel).toContain('onopengoals?.()');
    expect(panel).toContain('onopenprojects?.()');
    expect(panel).toContain('boardState.retry()');
    // Project drill-in + in-workspace story panel preserved (DESKTOP-005).
    expect(panel).toContain('onclick={() => openProject(project)}');
    expect(panel).toContain('<ProjectDetailView');
    expect(panel).toContain('selectedStory={selectedStory}');
    // Company page still has connect/invite/error surfaces.
    expect(companyPage).toContain('data-testid="company-connect"');
    expect(companyPage).toContain('data-testid="company-accept-invite"');
    expect(companyPage).toContain('company-action-error');
    expect(panel).toContain('data-testid="board-error"');
    // Navigation wired from shell.
    expect(desktopApp).toContain("tab: 'projects'");
    expect(desktopApp).toContain("tab: 'goals'");
    expect(desktopApp).toContain("navigate({ kind: 'inbox' })");
    expect(digest).toContain('data-testid="overview-open-inbox"');
    expect(digest).toContain("invoke<Partial<CompanyActivity>>('get_company_activity'");
    // No fabricated live state.
    expect(panel).not.toContain('cloud healthy');
    expect(goalCard).not.toContain('agent proposed');
  });

  it('uses the five semantic type roles and explicit 3px title/meta slots', () => {
    expect(V4_TYPE_SCALE).toEqual({
      metadata: 10,
      secondary: 11,
      body: 12,
      section: 14,
      detail: 18,
    });
    expect(V4_ROW_STACK_GAP_PX).toBe(3);
    expect(tokens).toContain('--type-metadata: 10px');
    expect(tokens).toContain('--type-body: 12px');
    expect(tokens).toContain('--v4-row-stack-gap: 3px');

    for (const src of [panel, goalCard, digest, needsYou]) {
      expect(src).toMatch(/var\(--v4-row-stack-gap,\s*3px\)/);
      expect(src).toMatch(/var\(--type-body/);
      expect(src).toMatch(/var\(--type-metadata/);
    }
    expect(panel).toMatch(/var\(--type-secondary/);
  });
});
