import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePendingDesktopRoute } from '../../src/desktop-alt/route';
import { HQ_CONSOLE_BASE } from '../../src/desktop-alt/lib/hq-console';

describe('US-011 company deployments (US-021 console drop)', () => {
  it('removes DeploymentsPanel and remaps deployments deep links to the console', () => {
    expect(
      existsSync(resolve(process.cwd(), 'src/desktop-alt/panels/DeploymentsPanel.svelte')),
    ).toBe(false);
    expect(resolvePendingDesktopRoute('company:indigo:deployments')).toEqual({
      mode: 'console',
      url: `${HQ_CONSOLE_BASE}/deployments`,
      landOn: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });
  });
});
