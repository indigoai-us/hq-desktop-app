import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';
import { resolvePendingDesktopRoute } from '../../src/desktop-alt/route';
import { HQ_CONSOLE_BASE } from '../../src/desktop-alt/lib/hq-console';
import { consoleDeepLinks } from '../../src/desktop-alt/lib/console-links';

/**
 * US-021: Deployments panel removed — actions live in HQ Console.
 */
describe('deployments actions → console deep link (US-021)', () => {
  it('removes the Deployments panel and routes legacy links to the console', () => {
    expect(existsSync(join(process.cwd(), 'src/desktop-alt/panels/DeploymentsPanel.svelte'))).toBe(
      false,
    );
    expect(resolvePendingDesktopRoute('company:indigo:deployments')).toEqual({
      mode: 'console',
      url: `${HQ_CONSOLE_BASE}/deployments`,
      landOn: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });
    const links = consoleDeepLinks('indigo');
    expect(links.some((l) => l.id === 'command-go-console-deployments')).toBe(true);
    expect(links.find((l) => l.id === 'command-go-console-deployments')?.url).toBe(
      `${HQ_CONSOLE_BASE}/deployments`,
    );
    // Palette still surfaces the console entry via consoleDeepLinks.
    const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    expect(app).toContain('consoleDeepLinks');
  });
});
