import { describe, expect, it } from 'vitest';
import {
  COMPANY_SECTIONS,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';
import { readRepoFile } from './harness';

/**
 * company-detail-desktop-ia — company secondary IA + Team/Knowledge contracts.
 */
describe('company-detail-desktop-ia: company secondary IA', () => {
  it('declares target COMPANY_SECTIONS without Accounts/Tasks/Library', () => {
    const ids = COMPANY_SECTIONS.map((s) => s.id);
    expect(ids).toEqual([
      'overview',
      'goals',
      'projects',
      'skills',
      'workers',
      'knowledge',
      'team',
      'activity',
      'deployments',
      'secrets',
      'settings',
    ]);
    expect(ids).not.toContain('accounts');
    expect(ids).not.toContain('tasks');
    expect(ids).not.toContain('library');
  });

  it('redirects legacy company deep-links', () => {
    expect(resolvePendingDesktopRoute('company:indigo:accounts')?.kind).toBe('company');
    expect(
      resolvePendingDesktopRoute('company:indigo:accounts') &&
        'tab' in (resolvePendingDesktopRoute('company:indigo:accounts') as object)
        ? (resolvePendingDesktopRoute('company:indigo:accounts') as { tab?: string }).tab
        : undefined,
    ).toBe('overview');
    expect(resolvePendingDesktopRoute('company:indigo:tasks')).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'projects',
    });
    expect(resolvePendingDesktopRoute('company:indigo:library')).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'skills',
    });
  });

  it('maps Knowledge deep-link to inline company knowledge tab', () => {
    expect(resolvePendingDesktopRoute('company:indigo:knowledge')).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'knowledge',
    });
  });

  it('CompanyPage mounts Skills/Workers/Team panels (source contract)', () => {
    const page = readRepoFile('src/desktop-alt/pages/CompanyPage.svelte');
    expect(page).toContain('forcedFilter="skills"');
    expect(page).toContain('forcedFilter="workers"');
    expect(page).toContain('TeamPanel');
    expect(page).not.toContain("tab === 'accounts'");
    expect(page).not.toContain("tab === 'tasks'");
    expect(page).not.toContain("tab === 'library'");
  });

  it('DesktopApp routes Knowledge as a company tab (inline panel; DESKTOP-001 primary children)', () => {
    const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    // Knowledge is a primary company child + deep-link tab; secondary company
    // column is gone (DESKTOP-001). Secondary select still handles library/settings.
    expect(app).not.toContain("id === 'knowledge'");
    expect(app).toContain("navigate({ kind: 'company', slug: route.slug, tab: id as CompanyTab })");
    const page = readRepoFile('src/desktop-alt/pages/CompanyPage.svelte');
    expect(page).toContain('<CompanyKnowledgePanel slug={company.slug} />');
    expect(page).not.toContain('company-knowledge-placeholder');
    const sidebar = readRepoFile('src/desktop-alt/v4/V4Sidebar.svelte');
    expect(sidebar).toContain('goCompanySection');
    expect(sidebar).toContain('v4-company-children');
  });

  it('CompanyKnowledgePanel is tenant-scoped to the company knowledge subtree (source contract)', () => {
    const panel = readRepoFile('src/desktop-alt/panels/CompanyKnowledgePanel.svelte');
    expect(panel).toContain('`companies/${slug}/knowledge`');
    expect(panel).toContain('CompanyFileTree');
    expect(panel).toContain('FilePreviewPane');
    expect(panel).toContain('inKnowledgeScope');
    expect(panel).toContain('data-testid="company-knowledge-empty"');
  });

  it('Team telemetry adapter + mixed list/detail panel exist (DESKTOP-009)', () => {
    const adapter = readRepoFile('src/desktop-alt/lib/team-telemetry.ts');
    const panel = readRepoFile('src/desktop-alt/panels/TeamPanel.svelte');
    expect(adapter).toContain('normalizeCompanyTeamTelemetry');
    expect(adapter).toContain('memberKindFromUid');
    expect(adapter).toContain('members: TeamMember[]');
    expect(panel).toContain('get_company_team_telemetry');
    expect(panel).toContain('data-testid="team-workspace"');
    expect(panel).toContain('data-testid="team-list"');
    expect(panel).toContain('data-testid="team-invite"');
    // One mixed list — not separate Humans/Agents sections.
    expect(panel).not.toContain('data-testid="team-humans"');
    expect(panel).not.toContain('data-testid="team-agents"');
  });

  it('Projects list exposes search and no Tasks dependency in header copy', () => {
    const projects = readRepoFile('src/desktop-alt/pages/CompanyProjectsPage.svelte');
    expect(projects).toContain('data-testid="project-search"');
    expect(projects).toContain('no separate Tasks tab');
  });
});
