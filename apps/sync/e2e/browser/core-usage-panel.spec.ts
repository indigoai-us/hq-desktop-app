import { expect, test, type Page } from '@playwright/test';

/**
 * Core menu "Usage this month" panel (usage-only-pricing US-018). The harness
 * answers hq-pro's billing summary, month statement, spend limit and price
 * list (dev-harness/mocks/core.ts); `?usage=` switches to a non-owner, a
 * failed lookup, a company with a card on file, or a running trial.
 */

/**
 * Open the Core menu. The harness shell starts with no company open, so the
 * panel defaults to the personal account (owner decision 2026-10-19); the
 * company cases pick Indigo in the account switcher first.
 */
async function openCoreMenu(page: Page, query = '', account: 'indigo' | 'personal' = 'indigo'): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/dev-harness/index.html?view=shell&persona=indigo&theme=dark${query}`);
  await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('titlebar-core-pill').click();
  await expect(page.getByTestId('core-popover')).toBeVisible({ timeout: 10_000 });
  if (account === 'indigo') {
    await page.locator('[data-testid="core-usage-account"][data-key="cmp_indigo"]').click();
    await expect(page.getByTestId('core-usage-company')).toContainText('Indigo');
  }
}

test('with no company open the meter shows the personal account, with Personal and the top companies listed', async ({ page }) => {
  await openCoreMenu(page, '', 'personal');
  const panel = page.getByTestId('core-usage');
  await expect(panel).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
  await expect(page.getByTestId('core-usage-company')).toHaveText('Personal');
  await expect(page.getByTestId('core-usage-used')).toHaveText('$3.40 of $10.00 free');
  await expect(page.getByTestId('core-usage-top-label')).toHaveText('Top 5 companies by usage this month');
  const rows = page.getByTestId('core-usage-account');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Personal');
  await expect(rows.nth(0)).toContainText('$3.40');
  await expect(rows.nth(1)).toContainText('Indigo');
  await expect(rows.nth(1)).toContainText('Owner');
  await expect(rows.nth(1)).toContainText('$8.00', { timeout: 10_000 });
  await page.getByTestId('core-usage-all').click();
  await expect(page.getByTestId('settings-usage-pane')).toBeVisible({ timeout: 10_000 });
});

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

  await expect(page.getByTestId('core-popover-sync-state')).toContainText('HQ is synced');
  await expect(page.getByTestId('core-usage-plan')).toHaveText('Usage plan');
  await expect(panel.getByText('Usage this month', { exact: true })).toBeVisible();
  await expect(page.getByTestId('core-usage-used')).toHaveText('$8.00 of $10.00 free');
  await expect(page.getByTestId('core-usage-reset')).toHaveText('Resets Nov 1');

  const rows = page.getByTestId('core-usage-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Agents and AI');
  await expect(rows.nth(0)).toContainText('$5.10');
  await expect(rows.nth(1)).toContainText('Sync');
  await expect(rows.nth(1)).toContainText('$1.90');
  await expect(rows.nth(2)).toContainText('Storage and vaults');
  await expect(rows.nth(2)).toContainText('$1.00');
  await expect(page.getByTestId('core-usage-bar')).toHaveAttribute('data-tone', 'near');

  // The bar is one coloured part per group against the $10 included. A total
  // change grows the reveal (clip-path), never the parts' widths.
  const bar = page.getByTestId('core-usage-bar');
  await expect(bar.locator('[data-segment]')).toHaveCount(3);
  const fill = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="core-usage-bar"] .fill') as HTMLElement;
    return { property: getComputedStyle(el).transitionProperty, reveal: el.dataset.reveal };
  });
  expect(fill.reveal).toBe('80');
  expect(fill.property).toContain('clip-path');
  // Switching from the personal account grows the bar; wait for it to settle at 80%.
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="core-usage-bar"] .fill') as HTMLElement).clipPath))
    .toMatch(/inset\(0(px)? 20%/);

  await expect(page.getByTestId('core-usage-billing')).toContainText('Set up billing');
  await expect(page.getByTestId('core-usage-details')).toContainText('Usage details');
  await expect(page.getByTestId('core-usage-sync-off')).toHaveText('Turn off sync');
});

test('during the trial the meter shows days left and trial usage against the cap', async ({ page }) => {
  await openCoreMenu(page, '&usage=trial');
  await expect(page.getByTestId('core-usage')).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
  await expect(page.getByTestId('core-usage-plan')).toHaveText('Trial, 12 days left');
  await expect(page.getByTestId('core-usage-used')).toHaveText('$420.00 of $500.00 trial usage');
  await expect(page.getByTestId('core-usage-bar')).toHaveAttribute('data-mode', 'trial');
});

test('Usage details opens Settings > Usage with the same numbers', async ({ page }) => {
  await openCoreMenu(page);
  await expect(page.getByTestId('core-usage')).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
  await page.getByTestId('core-usage-details').click();
  await expect(page.getByTestId('settings-usage-pane')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('settings-nav-usage')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('settings-usage-pane')).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
  await expect(page.getByTestId('usage-total')).toHaveText('$8.00');
  await expect(page.getByTestId('usage-allowance-left')).toHaveText('$2.00 of free usage left');
  await expect(page.getByTestId('usage-projected')).toHaveText('$6.00');
  await expect(page.getByTestId('usage-spend-limit')).toHaveText('$100.00 a month (default)');
  await expect(page.getByTestId('usage-line')).toHaveCount(7);
  // The account the menu showed is the open line.
  await expect(page.locator('[data-testid="usage-account"][data-key="cmp_indigo"]')).toHaveAttribute('aria-expanded', 'true');
});

test('Settings > Usage lists one line per account and opens one at a time, and a free company can switch', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dev-harness/index.html?view=shell&persona=usage-owner&theme=dark');
  await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('titlebar-core-pill').click();
  await expect(page.getByTestId('core-popover')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('core-usage-details').click();
  await expect(page.getByTestId('settings-usage-pane')).toBeVisible({ timeout: 10_000 });
  const lines = page.getByTestId('usage-account');
  await expect(lines).toHaveCount(9);
  await expect(lines.nth(0)).toContainText('Personal');
  await expect(lines.nth(0)).toContainText('Starter (free)');
  const line = (uid: string) => page.locator(`[data-testid="usage-account"][data-key="${uid}"]`);
  await expect(line('cmp_ux_aspen')).toContainText('Owner only');
  await expect(line('cmp_ux_birch')).toContainText('Trial, 12 days left', { timeout: 10_000 });
  await expect(line('cmp_ux_cedar')).toContainText('Legacy plan');
  await expect(line('cmp_ux_northwind')).toContainText('$8.00');
  // Near the included usage with no card: amber. Paused: red, with a badge.
  await expect(line('cmp_ux_elm').getByTestId('usage-account-bar')).toHaveAttribute('data-tone', 'near');
  await expect(line('cmp_ux_hazel').getByTestId('usage-account-bar')).toHaveAttribute('data-tone', 'at');
  await expect(line('cmp_ux_hazel').getByTestId('usage-account-paused')).toHaveText('Sync paused');
  await line('cmp_ux_northwind').click();
  await expect(line('cmp_ux_northwind')).toHaveAttribute('aria-expanded', 'true');
  await expect(line('personal')).toHaveAttribute('aria-expanded', 'false');
  const detail = page.getByTestId('usage-account-detail');
  await expect(detail).toHaveCount(1);
  await expect(detail.getByTestId('usage-spend-limit')).toHaveText('$250.00 a month');
  await expect(detail.getByTestId('usage-group')).toHaveCount(3);
  await line('cmp_ux_dogwood').focus();
  await page.keyboard.press('Enter');
  await expect(line('cmp_ux_dogwood')).toHaveAttribute('aria-expanded', 'true');
  await expect(line('cmp_ux_northwind')).toHaveAttribute('aria-expanded', 'false');
  await detail.getByTestId('usage-switch-start').click();
  await expect(detail.getByTestId('usage-switch-confirm')).toBeVisible();
  await detail.getByTestId('usage-switch-now').click();
  await expect(detail.getByTestId('usage-switch-result')).toHaveText('Switched to usage pricing.', { timeout: 10_000 });
  await expect(line('cmp_ux_dogwood')).toContainText('Usage plan');
});

test('Turn off sync opens the Sync section of Settings', async ({ page }) => {
  await openCoreMenu(page);
  await expect(page.getByTestId('core-usage')).toHaveAttribute('data-state', 'ready', { timeout: 10_000 });
  await page.getByTestId('core-usage-sync-off').click();
  await expect(page.getByTestId('settings-nav-sync')).toHaveAttribute('aria-current', 'page', { timeout: 10_000 });
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
  await expect(panel).toHaveAttribute('data-state', 'unavailable', { timeout: 15_000 });
  await expect(panel).not.toContainText('$0.00');
  await expect(panel).not.toContainText('Internal Server Error');
  await expect(page.getByTestId('core-usage-retry')).toBeVisible();
});
