import { describe, expect, it } from 'vitest';
import {
  COMPANY_OPERATIONS_SECTIONS,
  COMPANY_SECTIONS,
  companyPrimarySectionForTab,
  companyTabForPrimarySection,
  getDesktopSecondarySidebar,
  isCompanyOperationsTab,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';
import {
  V4_ROW_STACK_GAP_PX,
  V4_TYPE_SCALE,
  v4CompanyPrimaryForTab,
} from '../../src/desktop-alt/v4/model';
import { readRepoFile } from './harness';

/**
 * DESKTOP-010 — Scoped company operations.
 *
 * Source contracts for: More opens one company-scoped operations workspace
 * with compact internal destinations Activity / Deployments / Secrets /
 * Settings; destinations stay under company context (no permanent secondary
 * sidebar); preserved actions/errors/empty/deploy/activity/settings; metadata-
 * only secrets; naked hairline canvas; five type roles + 3px stacks; keyboard
 * internal nav + focus-visible + responsive collapse; light/dark + reduced
 * motion/transparency; More stays active for all four destinations; tenant
 * slug + backend commands preserved.
 */

describe('DESKTOP-010: scoped company operations', () => {
  const ops = readRepoFile('src/desktop-alt/panels/CompanyOperationsPanel.svelte');
  const activity = readRepoFile('src/desktop-alt/panels/ActivityPanel.svelte');
  const deployments = readRepoFile('src/desktop-alt/panels/DeploymentsPanel.svelte');
  const secrets = readRepoFile('src/desktop-alt/panels/SecretsPanel.svelte');
  const secretRow = readRepoFile('src/desktop-alt/components/SecretEnvRow.svelte');
  const deploymentRow = readRepoFile('src/desktop-alt/components/DeploymentRow.svelte');
  const companyPage = readRepoFile('src/desktop-alt/pages/CompanyPage.svelte');
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const route = readRepoFile('src/desktop-alt/route.ts');
  const tokens = readRepoFile('src/desktop-alt/v4/tokens.css');
  const desktopCss = readRepoFile('src/desktop-alt/styles/desktop-alt.css');
  const consoleLib = readRepoFile('src/desktop-alt/lib/hq-console.ts');

  it('groups Activity, Deployments, Secrets, and Settings under one operations workspace', () => {
    expect(COMPANY_OPERATIONS_SECTIONS.map((s) => s.id)).toEqual([
      'activity',
      'deployments',
      'secrets',
      'settings',
    ]);
    expect(ops).toContain('data-testid="company-operations-panel"');
    expect(ops).toContain('data-testid="operations-workspace"');
    expect(ops).toContain('data-testid="operations-nav"');
    expect(ops).toContain('data-testid="operations-nav-item"');
    expect(ops).toContain('data-testid="operations-content"');
    expect(ops).toContain('COMPANY_OPERATIONS_SECTIONS');
    expect(ops).toContain('<ActivityPanel {slug} {cloudBacked} />');
    expect(ops).toContain('<DeploymentsPanel {slug} {cloudBacked} />');
    expect(ops).toContain('<SecretsPanel {slug} {cloudBacked} />');
    expect(ops).toContain('data-testid="operations-settings"');
    expect(companyPage).toContain('CompanyOperationsPanel');
    expect(companyPage).toContain('isCompanyOperationsTab(tab)');
    expect(companyPage).toContain('destination={operationsDestination}');
    expect(desktopApp).toContain('onopenoperations={(destination) =>');
    expect(desktopApp).toContain("tab: destination");
  });

  it('keeps More as the active primary child for all four operations destinations', () => {
    for (const tab of ['activity', 'deployments', 'secrets', 'settings'] as const) {
      expect(isCompanyOperationsTab(tab)).toBe(true);
      expect(companyPrimarySectionForTab(tab)).toBe('more');
      expect(v4CompanyPrimaryForTab(tab)).toBe('more');
      expect(resolvePendingDesktopRoute(`company:indigo:${tab}`)).toEqual({
        kind: 'company',
        slug: 'indigo',
        tab,
      });
    }
    expect(companyTabForPrimarySection('more')).toBe('activity');
    expect(COMPANY_SECTIONS.some((s) => s.id === 'settings')).toBe(true);
    expect(route).toContain("case 'settings':");
    expect(route).toContain("return 'more'");
  });

  it('does not restore a permanent company secondary sidebar', () => {
    expect(
      getDesktopSecondarySidebar({ kind: 'company', slug: 'indigo', tab: 'activity' }, []),
    ).toBeNull();
    expect(
      getDesktopSecondarySidebar({ kind: 'company', slug: 'indigo', tab: 'settings' }, []),
    ).toBeNull();
    expect(getDesktopSecondarySidebar({ kind: 'library' }, [])?.surface).toBe('library');
    expect(getDesktopSecondarySidebar({ kind: 'settings' }, [])?.surface).toBe('settings');
    // Operations nav is internal, not a permanent secondary column.
    expect(ops).toContain('operations-nav');
    expect(ops).not.toContain('V4SecondarySidebar');
    expect(companyPage).not.toContain('getDesktopSecondarySidebar');
  });

  it('preserves activity, deployments, secrets, and settings actions and states', () => {
    // Activity: direction, date chips, open-in-claude, load/error/retry.
    expect(activity).toContain("let activityDirection = $state<ActivityDirection>('all')");
    expect(activity).toContain('dateChip(entry.when)');
    expect(activity).toContain("invoke<Partial<CompanyActivity>>('get_company_activity', { slug })");
    expect(activity).toContain('function retry()');
    expect(activity).toContain('Activity unavailable');
    expect(activity).toContain('No activity yet');
    expect(activity).toContain('OpenFileInClaudeCode');

    // Deployments: open, deploy workflow, search, counts, error/empty.
    expect(deployments).toContain("invoke<Partial<DeploymentEntry>[]>('get_company_deployments', { slug })");
    expect(deployments).toContain("openAgentWorkflow(prompt, 'deploy workflow')");
    expect(deployments).toContain('bind:value={deploymentQuery}');
    expect(deployments).toContain('Deployments unavailable');
    expect(deployments).toContain('No provisioned subdomains for this company.');
    expect(deploymentRow).toContain("import { open } from '@tauri-apps/plugin-shell'");
    expect(deploymentRow).toContain('async function openDeployment()');
    expect(deploymentRow).toContain('title="Open in browser"');
    // Honesty: no fake rollback confirm that reverts nothing.
    expect(deploymentRow).not.toContain('rollbackConfirm');

    // Secrets: export / new key workflows, empty, error.
    expect(secrets).toContain("invoke<Partial<SecretEnv>[]>('get_company_secrets', { slug })");
    expect(secrets).toContain("onclick={() => void openSecretsPrompt('export')}");
    expect(secrets).toContain("onclick={() => void openSecretsPrompt('new')}");
    expect(secrets).toContain('Secrets unavailable');
    expect(secrets).toContain('No secrets yet');

    // Settings: open console settings (identity / sync / members).
    expect(ops).toContain('companySettingsUrl(slug)');
    expect(ops).toContain('data-testid="operations-open-console-settings"');
    expect(ops).toContain('data-testid="operations-settings-identity"');
    expect(ops).toContain('data-testid="operations-settings-sync"');
    expect(ops).toContain('data-testid="operations-settings-members"');
    expect(consoleLib).toContain("return `${companyConsoleUrl(slug)}/settings`");
    expect(companyPage).toContain('void openExternal(companySettingsUrl(company.slug));');
  });

  it('keeps secrets metadata-only with no reveal, copy-value, or credential fields', () => {
    expect(secrets).toContain(
      'Read-only metadata. Values are never sent to the client — use /hq-secrets to fetch a value.',
    );
    expect(secretRow).toContain('key: string');
    expect(secretRow).toContain('upd: string');
    expect(secretRow).toContain('rot: string');
    expect(secretRow).not.toMatch(/\bvalue\b.*secret|secret.*\bvalue\b/i);
    expect(secretRow).not.toContain('item.value');
    expect(secretRow).not.toContain('type="password"');
    expect(secretRow).not.toContain('Reveal');
    expect(secretRow).not.toContain('copy-secret');
    expect(secretRow).not.toContain('clipboard.writeText(item');
    expect(ops).not.toContain('type="password"');
    expect(ops).not.toContain('Reveal secret');
    expect(route).toContain("meta: 'Metadata only'");
    expect(ops).toContain('{dest.meta}');
  });

  it('uses a naked hairline operations canvas; rounded only for controls and selection', () => {
    expect(ops).toContain('border: 1px solid var(--v4-hairline)');
    expect(ops).toContain('border-right: 1px solid var(--v4-hairline)');
    expect(ops).toContain('border-radius: 0');
    expect(ops).toContain('background: transparent');
    expect(ops).toMatch(/\.ops-nav-item\.is-selected\s*\{[\s\S]*?border-radius:\s*6px;/);
    expect(ops).toContain('border-radius: var(--v4-radius-button)');
    expect(ops).not.toContain('var(--v4-radius-card');
    expect(ops).not.toContain('var(--v4-shadow-card)');
    expect(activity).toContain('border-radius: 0');
    expect(deployments).toContain('border-radius: 0');
    expect(secrets).toContain('border-radius: 0');
    expect(desktopCss).toContain('.list-detail');
  });

  it('uses five semantic type roles and 3px title/meta stacks', () => {
    expect(V4_TYPE_SCALE).toEqual({
      metadata: 10,
      secondary: 11,
      body: 12,
      section: 14,
      detail: 18,
    });
    expect(V4_ROW_STACK_GAP_PX).toBe(3);
    expect(tokens).toContain('--v4-row-stack-gap: 3px');
    expect(ops).toContain('--type-detail');
    expect(ops).toContain('--type-section');
    expect(ops).toContain('--type-body');
    expect(ops).toContain('--type-secondary');
    expect(ops).toContain('--type-metadata');
    expect(ops).toContain('var(--v4-row-stack-gap, 3px)');
    expect(ops).toContain('title-stack');
    expect(activity).toContain('title-stack');
    expect(activity).toContain('var(--v4-row-stack-gap, 3px)');
    expect(deployments).toContain('title-stack');
    expect(secrets).toContain('title-stack');
  });

  it('supports keyboard internal navigation, focus-visible, and responsive collapse', () => {
    expect(ops).toContain('handleNavKeydown');
    expect(ops).toContain("event.key === 'ArrowDown'");
    expect(ops).toContain("event.key === 'ArrowUp'");
    expect(ops).toContain("event.key === 'Home'");
    expect(ops).toContain("event.key === 'End'");
    expect(ops).toContain('tabindex={isSelected ? 0 : -1}');
    expect(ops).toContain('aria-selected={isSelected}');
    expect(ops).toContain('role="listbox"');
    expect(ops).toContain('role="option"');
    expect(ops).toContain('.ops-nav-item:focus-visible');
    expect(ops).toContain('.ops-settings-button:focus-visible');
    expect(ops).toContain('@media (max-width: 820px)');
    expect(ops).toContain('@media (max-width: 720px)');
    // Primary actions stay mounted (deploy / secrets / settings open-console).
    expect(deployments).toContain('detail-primary-actions primary-actions');
    expect(secrets).toContain('detail-primary-actions primary-actions');
    expect(ops).toContain('detail-primary-actions primary-actions');
    expect(desktopCss).toMatch(
      /\.list-detail\s+\.detail-primary-actions,[\s\S]*?flex:\s*0\s+0\s+auto/,
    );
  });

  it('honors light/dark and reduced motion/transparency', () => {
    expect(tokens).toContain('--v4-text-1: #0a0c10');
    expect(tokens).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[\s\S]*?--v4-text-1:\s*#f4f6f8/,
    );
    expect(ops).toContain('@media (prefers-reduced-motion: reduce)');
    expect(ops).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(ops).toContain('transition: none');
    expect(activity).toContain('@media (prefers-reduced-motion: reduce)');
    expect(activity).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(deployments).toContain('@media (prefers-reduced-motion: reduce)');
    expect(secrets).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('preserves tenant slug scoping and backend commands', () => {
    expect(ops).toContain('slug: string');
    expect(activity).toContain('let { slug, cloudBacked = true }: Props = $props()');
    expect(activity).toContain("'get_company_activity'");
    expect(deployments).toContain("'get_company_deployments'");
    expect(secrets).toContain("'get_company_secrets'");
    expect(activity).toContain('if (!slug || !cloudBacked)');
    expect(deployments).toContain('if (!slug || !cloudBacked)');
    expect(secrets).toContain('if (!slug || !cloudBacked)');
    expect(companyPage).toContain('slug={company.slug}');
    expect(companyPage).toContain('{cloudBacked}');
  });
});
