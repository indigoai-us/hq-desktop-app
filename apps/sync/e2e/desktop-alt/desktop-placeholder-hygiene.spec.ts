import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

describe('desktop placeholder hygiene', () => {
  it('omits absent goal metadata and names missing key-result values', () => {
    const goals = readRepoFile('../../packages/ui/src/projects/CompanyGoalsPage.svelte');
    const projectDetail = readRepoFile('../../packages/ui/src/projects/ProjectDetailView.svelte');

    expect(goals).not.toContain("return 'Unassigned'");
    expect(goals).not.toContain("quarterLabel(objective.timeframe) ?? '—'");
    expect(goals).not.toContain("quarterLabel(selectedGoal.timeframe) ?? '—'");
    expect(goals).toContain("return 'Not set'");
    expect(projectDetail).toContain("return 'Not set'");
  });

  it('does not paint dash-only meeting placeholders', () => {
    const page = readRepoFile('../../packages/ui/src/meetings/MeetingsPage.svelte');
    const agenda = readRepoFile('../../packages/ui/src/meetings/MeetingsAgenda.svelte');

    expect(page).not.toContain("upNext ? timeLabel(upNext) : '—'");
    expect(agenda).not.toContain('>—</span>');
  });

  it('uses explicit dense-session fallback copy', () => {
    const panel = readRepoFile('src/desktop-alt/panels/LiveSessionsPanel.svelte');

    expect(panel).toContain("session.company || 'No company'");
    expect(panel).toContain("session.model || 'Unknown model'");
    expect(panel).not.toContain("session.company || '—'");
    expect(panel).not.toContain("session.model || '—'");
  });

  it('distinguishes desktop-version loading from failure in every settings row', () => {
    const settings = readRepoFile('../../packages/ui/src/settings/SettingsPage.svelte');

    expect(settings).toContain('appVersionLoadFailed');
    expect(settings).toContain("'Unavailable'");
    expect(settings).not.toContain("appVersion ? `v${appVersion}` : '—'");
  });

  it('keeps auxiliary CRM, deployment, meeting, and moderation states explicit', () => {
    const crm = readRepoFile('src/lib/crm/AccountView.svelte');
    const crmModel = readRepoFile('src/lib/crm/account-view-model.ts');
    const deployments = readRepoFile('../../packages/ui/src/company/DeploymentsPanel.svelte');
    const meetings = readRepoFile('src/components/MeetingsWindow.svelte');
    const moderation = readRepoFile('../../packages/ui/src/marketplace/ModerationPanel.svelte');

    expect(crm).toContain('>Not connected</');
    expect(crm).not.toContain('>—</');
    expect(crmModel).toContain("export const NOT_RECORDED = 'Not recorded'");
    expect(deployments).toContain('{#if !error}');
    expect(deployments).not.toContain("error ? '—'");
    expect(meetings).not.toContain('>—</span>');
    expect(moderation).toContain("'No listing selected'");
    expect(moderation).not.toContain("return '—'");
  });
});
