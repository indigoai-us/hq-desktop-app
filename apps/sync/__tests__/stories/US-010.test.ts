import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePendingDesktopRoute } from '../../src/desktop-alt/route';
import { companyConsoleUrl } from '../../src/desktop-alt/lib/hq-console';

describe('US-010 company activity (US-021 console drop)', () => {
  it('removes ActivityPanel and remaps company activity deep links to the console', () => {
    expect(existsSync(resolve(process.cwd(), 'src/desktop-alt/panels/ActivityPanel.svelte'))).toBe(
      false,
    );
    expect(
      existsSync(resolve(process.cwd(), 'src/desktop-alt/panels/CompanyOperationsPanel.svelte')),
    ).toBe(false);
    expect(resolvePendingDesktopRoute('company:indigo:activity')).toEqual({
      mode: 'console',
      url: `${companyConsoleUrl('indigo')}/activity`,
      landOn: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });
  });
});
