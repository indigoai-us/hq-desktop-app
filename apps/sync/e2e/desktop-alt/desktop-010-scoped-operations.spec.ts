import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';
import {
  COMPANY_PRIMARY_SECTIONS,
  COMPANY_SECTIONS,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';
import { companyConsoleUrl, companySettingsUrl, HQ_CONSOLE_BASE } from '../../src/desktop-alt/lib/hq-console';

/**
 * US-021: company Operations workspace (Activity / Deployments / Secrets /
 * Settings under More) is removed. Legacy deep links open the HQ web console
 * and land on company overview. This suite locks the removal + remap.
 */
describe('DESKTOP-010 scoped operations → console remaps (US-021)', () => {
  const root = process.cwd();

  it('deletes operations panels and the More primary section', () => {
    for (const rel of [
      'src/desktop-alt/panels/CompanyOperationsPanel.svelte',
      'src/desktop-alt/panels/ActivityPanel.svelte',
      'src/desktop-alt/panels/DeploymentsPanel.svelte',
      'src/desktop-alt/panels/SecretsPanel.svelte',
      'src/desktop-alt/components/SecretEnvRow.svelte',
      'src/desktop-alt/components/DeploymentRow.svelte',
    ]) {
      expect(existsSync(join(root, rel)), rel).toBe(false);
    }

    expect(COMPANY_PRIMARY_SECTIONS.map((s) => s.id)).not.toContain('more');
    expect(COMPANY_SECTIONS.map((s) => s.id)).toEqual([
      'overview',
      'goals',
      'projects',
      'skills',
      'workers',
      'knowledge',
      'team',
    ]);

    const page = readRepoFile('src/desktop-alt/pages/CompanyPage.svelte');
    expect(page).not.toContain('CompanyOperationsPanel');
    expect(page).toContain('Open in HQ Console');
  });

  it('remaps legacy operations deep links to console URLs + overview', () => {
    expect(resolvePendingDesktopRoute('company:indigo:deployments')).toEqual({
      mode: 'console',
      url: `${HQ_CONSOLE_BASE}/deployments`,
      landOn: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });
    expect(resolvePendingDesktopRoute('company:indigo:secrets')).toEqual({
      mode: 'console',
      url: `${companyConsoleUrl('indigo')}/secrets`,
      landOn: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });
    expect(resolvePendingDesktopRoute('company:indigo:activity')).toEqual({
      mode: 'console',
      url: `${companyConsoleUrl('indigo')}/activity`,
      landOn: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });
    expect(resolvePendingDesktopRoute('company:indigo:settings')).toEqual({
      mode: 'console',
      url: companySettingsUrl('indigo'),
      landOn: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });
    expect(resolvePendingDesktopRoute('company:indigo:more')).toEqual({
      mode: 'internal',
      route: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });
  });
});
