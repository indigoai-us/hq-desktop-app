import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readRepoFile } from './harness';
import {
  consoleUrlForLegacyRoute,
  landOnRouteForResolution,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';
import { companyConsoleUrl } from '../../src/desktop-alt/lib/hq-console';

/**
 * US-021: fleet Mission Control is no longer a desktop page. Legacy intents
 * open HQ Console Telescope (when a company slug is known) and land on the
 * nearest V2 screen. Keep coverage so the remap cannot regress silently.
 */
describe('Mission Control → console Telescope remap (US-021)', () => {
  it('removes MissionControlPage and fleet session panels from the tree', () => {
    const root = process.cwd();
    expect(existsSync(join(root, 'src/desktop-alt/pages/MissionControlPage.svelte'))).toBe(false);
    expect(existsSync(join(root, 'src/desktop-alt/panels/LiveSessionsPanel.svelte'))).toBe(false);
    expect(existsSync(join(root, 'src/desktop-alt/panels/SessionHistoryPanel.svelte'))).toBe(false);
    const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    expect(app).not.toContain('MissionControlPage');
    expect(app).toContain('Open Mission Control (Telescope) in HQ Console');
    // Local project sessions store remains for CompanyProjectsPage / ProjectDetailView.
    expect(readRepoFile('src/desktop-alt/lib/sessions-store.svelte.ts')).toContain(
      'export function startSessionsStore',
    );
    expect(readRepoFile('src/desktop-alt/pages/CompanyProjectsPage.svelte')).toContain(
      'sessions-store.svelte',
    );
  });

  it('resolves mission-control pending intents to Telescope + overview when slug known', () => {
    const resolved = resolvePendingDesktopRoute('mission-control', {
      activeCompanySlug: 'indigo',
    });
    expect(resolved).toEqual({
      mode: 'console',
      url: `${companyConsoleUrl('indigo')}/telescope`,
      landOn: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });
    expect(consoleUrlForLegacyRoute('mission-control', { activeCompanySlug: 'indigo' })).toBe(
      `${companyConsoleUrl('indigo')}/telescope`,
    );
    expect(landOnRouteForResolution(resolved)).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'overview',
    });
  });

  it('lands mission-control on Home when no company slug is known', () => {
    expect(resolvePendingDesktopRoute('mission-control')).toEqual({
      mode: 'internal',
      route: { kind: 'home' },
    });
  });
});
