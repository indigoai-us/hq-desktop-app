import { expect, test, type Page } from '@playwright/test';

/**
 * Core menu "Usage this month" panel. The harness answers hq-pro's billing
 * summary and month statement (dev-harness/mocks/core.ts); `?usage=` switches
 * to a non-owner, a failed lookup, or a company with a card on file.
 */

async function openCoreMenu(page: Page, query = ''): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/dev-harness/index.html?view=shell&persona=indigo&theme=dark${query}`);
  await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('titlebar-core-pill').click();
  await expect(page.getByTestId('core-popover')).toBeVisible({ timeout: 10_000 });
}

test('shows month-to-date usage under the sync row', async ({ page }) => {
  await openCoreMenu(page);
  const panel = page.getByTestId('core-usage');
  await expect(panel).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });

  // Sync row first, usage panel right under it.
  const order = await page.evaluate(() => {
    const pop = document.querySelector('[data-testid="core-popover"]')!;
    return [...pop.children].map((el) => el.getAttribute('data-testid'));
  });
  expect(order.slice(0, 2)).toEqual(['core-popover-sync-status', 'core-usage']);

  await expect(page.getByTestId('core-usage-plan')).toHaveText('Free plan');
  await expect(panel.getByText('Usage this month')).toBeVisible();
  await expect(page.getByTestId('core-usage-used')).toHaveText('$8.00 of $10.00 free');
  await expect(page.getByTestId('core-usage-reset')).toHaveText('Resets Nov 1');

  const rows = page.getByTestId('core-usage-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Assistant and bots');
  await expect(rows.nth(0)).toContainText('$5.10');
  // Storage is unreported in the fixture: the group shows the measured part.
  await expect(rows.nth(1)).toContainText('Storage and sync');
  await expect(rows.nth(1)).toContainText('$1.00');

  // The bar animates with transform scaleX, never width.
  const fill = await page.evaluate(() => {
    const el = document.querySelector('.core-usage-fill') as HTMLElement;
    const cs = getComputedStyle(el);
    return { transform: cs.transform, property: cs.transitionProperty, ratio: el.style.getPropertyValue('--fill').trim() };
  });
  expect(fill.ratio).toBe('0.8');
  expect(fill.property).toBe('transform');
  expect(fill.transform).toMatch(/^matrix\(0\.8, 0, 0, 1/);

  await expect(page.getByTestId('core-usage-billing')).toContainText('Set up billing');
  await expect(page.getByTestId('core-usage-compare')).toContainText('Compare plans');
});

test('a company with a card on file shows Manage billing', async ({ page }) => {
  await openCoreMenu(page, '&usage=paid');
  await expect(page.getByTestId('core-usage')).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
  await expect(page.getByTestId('core-usage-billing')).toContainText('Manage billing');
});

test('a non-owner sees a quiet note, not numbers', async ({ page }) => {
  await openCoreMenu(page, '&usage=forbidden');
  await expect(page.getByTestId('core-usage')).toHaveAttribute('data-state', 'owner-only', { timeout: 10_000 });
  await expect(page.getByTestId('core-usage-used')).toHaveCount(0);
  await expect(page.getByTestId('core-usage-billing')).toHaveCount(0);
});

test('a failed lookup says unavailable and never shows $0', async ({ page }) => {
  await openCoreMenu(page, '&usage=fail');
  const panel = page.getByTestId('core-usage');
  await expect(panel).toHaveAttribute('data-state', 'unavailable', { timeout: 10_000 });
  await expect(panel).not.toContainText('$0.00');
});
