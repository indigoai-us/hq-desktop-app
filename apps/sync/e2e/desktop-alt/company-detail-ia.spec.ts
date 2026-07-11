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

  it('maps Knowledge deep-link to files mode for the company', () => {
    expect(resolvePendingDesktopRoute('company:indigo:knowledge')).toEqual({
      kind: 'files',
      slug: 'indigo',
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

  it('DesktopApp routes Knowledge secondary select to files mode', () => {
    const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    expect(app).toContain("id === 'knowledge'");
    expect(app).toContain("kind: 'files'");
  });

  it('Team telemetry adapter + panel exist', () => {
    const adapter = readRepoFile('src/desktop-alt/lib/team-telemetry.ts');
    const panel = readRepoFile('src/desktop-alt/panels/TeamPanel.svelte');
    expect(adapter).toContain('normalizeCompanyTeamTelemetry');
    expect(adapter).toContain('memberKindFromUid');
    expect(panel).toContain('get_company_team_telemetry');
    expect(panel).toContain('data-testid="team-humans"');
    expect(panel).toContain('data-testid="team-agents"');
  });

  it('Projects list exposes search and no Tasks dependency in header copy', () => {
    const projects = readRepoFile('src/desktop-alt/pages/CompanyProjectsPage.svelte');
    expect(projects).toContain('data-testid="project-search"');
    expect(projects).toContain('no separate Tasks tab');
  });
});
