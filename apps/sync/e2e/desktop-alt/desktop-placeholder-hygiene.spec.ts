import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

describe('desktop placeholder hygiene', () => {
  it('omits absent goal metadata and names missing key-result values', () => {
    const goals = readRepoFile('src/desktop-alt/pages/CompanyGoalsPage.svelte');
    const projectDetail = readRepoFile('src/desktop-alt/pages/ProjectDetailView.svelte');

    expect(goals).not.toContain("return 'Unassigned'");
    expect(goals).not.toContain("quarterLabel(objective.timeframe) ?? '—'");
    expect(goals).not.toContain("quarterLabel(selectedGoal.timeframe) ?? '—'");
    expect(goals).toContain("return 'Not set'");
    expect(projectDetail).toContain("return 'Not set'");
  });

  it('does not paint dash-only meeting placeholders', () => {
    const page = readRepoFile('src/desktop-alt/pages/MeetingsPage.svelte');
    const agenda = readRepoFile('src/desktop-alt/components/MeetingsAgenda.svelte');

    expect(page).not.toContain("upNext ? timeLabel(upNext) : '—'");
    expect(agenda).not.toContain('>—</span>');
  });

  it('no longer ships fleet LiveSessionsPanel placeholders (US-021)', () => {
    expect(
      existsSync(join(process.cwd(), 'src/desktop-alt/panels/LiveSessionsPanel.svelte')),
    ).toBe(false);
  });

  it('distinguishes desktop-version loading from failure in every settings row', () => {
    const settings = readRepoFile('src/desktop-alt/pages/SettingsPage.svelte');

    expect(settings).toContain('appVersionLoadFailed');
    expect(settings).toContain("'Unavailable'");
    expect(settings).not.toContain("appVersion ? `v${appVersion}` : '—'");
  });

  it('keeps auxiliary CRM, meeting, and moderation states explicit (deployments panel gone)', () => {
    const crm = readRepoFile('src/lib/crm/AccountView.svelte');
    const crmModel = readRepoFile('src/lib/crm/account-view-model.ts');
    const meetings = readRepoFile('src/components/MeetingsWindow.svelte');
    const moderation = readRepoFile('src/desktop-alt/panels/ModerationPanel.svelte');

    expect(crm).toContain('>Not connected</');
    expect(crm).not.toContain('>—</');
    expect(crmModel).toContain("export const NOT_RECORDED = 'Not recorded'");
    expect(
      existsSync(join(process.cwd(), 'src/desktop-alt/panels/DeploymentsPanel.svelte')),
    ).toBe(false);
    expect(meetings).not.toContain('>—</span>');
    expect(moderation).toContain("'No listing selected'");
    expect(moderation).not.toContain("return '—'");
  });
});
