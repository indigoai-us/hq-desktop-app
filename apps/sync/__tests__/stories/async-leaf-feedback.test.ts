import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('desktop leaf actions expose immediate pending feedback', () => {
  it('covers profile and submission pickers as well as their mutations', () => {
    const profile = source('../../src/desktop-alt/panels/ProfilePanel.svelte');
    const submit = source('../../src/desktop-alt/panels/SubmitPanel.svelte');

    expect(profile).toContain('let choosingAvatar = $state(false)');
    expect(profile).toContain('aria-busy={choosingAvatar}');
    expect(profile).toContain("? 'Choosing…'");
    expect(profile).toContain('aria-busy={claiming}');
    expect(profile).toContain('aria-busy={saving}');
    expect(profile).toContain('aria-busy={previewLoading}');

    expect(submit).toContain('let choosing = $state(false)');
    expect(submit).toContain('aria-busy={choosing}');
    expect(submit).toContain("choosing ? 'Choosing…'");
    expect(submit).toContain('aria-busy={submitting}');
    expect(submit).toContain('aria-busy={requesting}');
  });

  it('covers external console/workflow actions and force-refresh retries', () => {
    const team = source('../../src/desktop-alt/panels/TeamPanel.svelte');
    const company = source('../../src/desktop-alt/pages/CompanyPage.svelte');
    const operations = source('../../src/desktop-alt/panels/CompanyOperationsPanel.svelte');
    const activity = source('../../src/desktop-alt/panels/ActivityPanel.svelte');
    const deployments = source('../../src/desktop-alt/panels/DeploymentsPanel.svelte');
    const secrets = source('../../src/desktop-alt/panels/SecretsPanel.svelte');

    expect(team).toContain("externalActionBusy = $state<'invite' | 'console' | null>(null)");
    expect(team).toContain("aria-busy={externalActionBusy === 'invite'}");
    expect(team).toContain("aria-busy={externalActionBusy === 'console'}");
    expect(company).toContain('aria-busy={connectBusy}');
    expect(company).toContain('aria-busy={inviteBusy}');
    expect(company).toContain('aria-busy={inviteOpening}');
    expect(company).toContain('aria-busy={newProjectBusy}');
    expect(operations).toContain('aria-busy={settingsBusy}');
    expect(deployments).toContain('aria-busy={deployBusy}');
    expect(secrets).toContain("aria-busy={actionBusy === 'export'}");
    expect(secrets).toContain("aria-busy={actionBusy === 'new'}");

    for (const panel of [activity, deployments, secrets]) {
      expect(panel).toContain("loading = force");
      expect(panel).toContain("loading ? 'Retrying…' : 'Retry'");
      expect(panel).toContain('aria-busy={loading}');
    }
  });

  it('covers moderation decisions and detail-load recovery', () => {
    const moderation = source('../../src/desktop-alt/panels/ModerationPanel.svelte');
    const detail = source('../../src/desktop-alt/components/LibraryDetailPanel.svelte');
    const tree = source('../../src/desktop-alt/components/CompanyFileTree.svelte');

    expect(moderation).toContain('aria-busy={queueLoading}');
    expect(moderation).toContain('aria-busy={deciding}');
    expect(moderation).toContain('aria-busy={yanking}');
    expect(moderation).toContain('aria-busy={appDeciding === app.applicationId}');
    expect(detail).toContain('data-testid="library-detail-retry"');
    expect(detail).toContain('aria-busy={loading}');
    expect(tree).toContain('aria-busy={loadingPaths.has(node.path)}');
  });
});
