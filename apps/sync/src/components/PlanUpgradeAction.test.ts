// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Browser entry for mounted tests.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import PlanUpgradeAction from './PlanUpgradeAction.svelte';

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('PlanUpgradeAction', () => {
  it('opens only the URL passed from the server', () => {
    const upgradeUrl = 'https://hq.computer/companies/acme/billing?upgrade=team';
    const onUpgrade = vi.fn();
    component = mount(PlanUpgradeAction, {
      target: document.body,
      props: { upgradeUrl, onUpgrade },
    });
    flushSync();

    const button = document.querySelector<HTMLButtonElement>(
      '[data-testid="plan-upgrade-action"]',
    );
    expect(button?.textContent).toBe('Upgrade');
    button?.click();
    expect(onUpgrade).toHaveBeenCalledWith(upgradeUrl);
  });

  it('shows Open Billing for a usage pause (US-024)', () => {
    const billingUrl = 'https://hq.computer/companies/acme/billing';
    const onUpgrade = vi.fn();
    component = mount(PlanUpgradeAction, {
      target: document.body,
      props: { upgradeUrl: billingUrl, onUpgrade, label: 'Open Billing' },
    });
    flushSync();
    const button = document.querySelector<HTMLButtonElement>('[data-testid="plan-upgrade-action"]');
    expect(button?.textContent).toBe('Open Billing');
    expect(button?.getAttribute('aria-label')).toBe('Open Billing');
    button?.click();
    expect(onUpgrade).toHaveBeenCalledWith(billingUrl);
  });
});
