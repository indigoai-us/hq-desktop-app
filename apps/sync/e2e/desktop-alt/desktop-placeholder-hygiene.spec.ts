import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

describe('desktop placeholder hygiene', () => {
  it('omits absent goal metadata and names missing key-result values', () => {
    const goals = readRepoFile('../../packages/ui/src/projects/CompanyGoalsPage.svelte');
    const projectDetail = readRepoFile('../../packages/ui/src/projects/ProjectDetailView.svelte');

    expect(goals).not.toContain("return 'Unassigned'");
    expect(goals).not.toContain("quarterLabel(objective.timeframe) ?? '—'");
    expect(goals).not.toContain("quarterLabel(selectedGoal.timeframe) ?? '—'");
    expect(goals).toMatch(/return ['"]Not set['"]/);
    expect(projectDetail).toMatch(/return ['"]Not set['"]/);
  });

  it('does not paint dash-only meeting placeholders', () => {
    const page = readRepoFile('../../packages/ui/src/meetings/MeetingsPage.svelte');
    const agenda = readRepoFile('../../packages/ui/src/meetings/MeetingsAgenda.svelte');

    expect(page).not.toContain("upNext ? timeLabel(upNext) : '—'");
    expect(agenda).not.toContain('>—</span>');
  });

  // The dense-session fallback case went with the in-app Sessions subsystem:
  // LiveSessionsPanel no longer ships, so there is no surface to hold to the
  // placeholder rule.

  it('distinguishes desktop-version loading from failure in every settings row', () => {
    const settings = readRepoFile('../../packages/ui/src/settings/SettingsPage.svelte');

    expect(settings).toContain('appVersionLoadFailed');
    expect(settings).toMatch(/['"]Unavailable['"]/);
    expect(settings).not.toContain("appVersion ? `v${appVersion}` : '—'");
  });

  it('keeps auxiliary deployment, meeting, and moderation states explicit', () => {
    const deployments = readRepoFile('../../packages/ui/src/company/DeploymentsPanel.svelte');
    const meetings = readRepoFile('src/components/MeetingsWindow.svelte');
    const moderation = readRepoFile('../../packages/ui/src/marketplace/ModerationPanel.svelte');

    // The CRM account view had no importers on origin/main — it was reachable
    // only from the dead shell — and went with it. No live CRM surface exists
    // to hold to the placeholder rule; the command that fed it is still
    // registered, so a future surface inherits the rule, not this assertion.
    expect(deployments).toContain('{#if !error}');
    expect(deployments).not.toContain("error ? '—'");
    expect(meetings).not.toContain('>—</span>');
    expect(moderation).toMatch(/['"]No listing selected['"]/);
    expect(moderation).not.toContain("return '—'");
  });
});
