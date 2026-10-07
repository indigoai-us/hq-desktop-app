import { expect, test } from '@playwright/test';

/**
 * Activity is one team view: no Team/Tokens switch and no token chart. One
 * row per person with day bars, last active and team counts, sortable by
 * recent activity or name.
 */

const SHELL = '/desktop-alt.html?window=desktop-alt&persona=indigo';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(SHELL);
  await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-testid="rail-company"]').first().click();
  await page.locator('[data-row-id="activity"]').first().click();
  await expect(page.getByTestId('activity-team')).toBeVisible();
});

test('Activity has no Tokens view, keeps the range and Export', async ({ page }) => {
  const view = page.getByTestId('activity-view');
  await expect(view.getByRole('tab', { name: 'Tokens' })).toHaveCount(0);
  await expect(view.locator('[aria-label="Activity views"]')).toHaveCount(0);
  await expect(view).not.toContainText('attributed');
  await expect(view.locator('[aria-label="Range"] [role="tab"]')).toHaveText(['7d', '30d', '90d']);
  await expect(view.getByRole('button', { name: 'Export' })).toBeVisible();
});

test('each person row has bars for every day, last active and counts', async ({ page }) => {
  const rows = page.getByTestId('activity-member-row');
  await expect(rows.first()).toBeVisible();
  const first = rows.first();
  await expect(first.locator('[data-testid="activity-member-bars"] i')).toHaveCount(30);
  await expect(first.getByTestId('activity-member-last-active')).toHaveText('Today');
  await expect(first.getByTestId('activity-member-sessions')).toHaveText(/^\d+$/);
  await page.locator('[aria-label="Range"] [role="tab"]', { hasText: '7d' }).click();
  await expect(rows.first().locator('[data-testid="activity-member-bars"] i')).toHaveCount(7);
});

test('Name sorts the list A to Z; Recent puts the latest active first', async ({ page }) => {
  const names = () => page.locator('[data-testid="activity-member-row"] .who-name').allTextContents();
  const recent = (await names()).map((n) => n.trim());
  await page.getByTestId('activity-sort-name').click();
  const byName = (await names()).map((n) => n.trim());
  expect(byName).toEqual([...byName].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })));
  expect(new Set(byName)).toEqual(new Set(recent));
  await page.getByTestId('activity-sort-recent').click();
  expect((await names()).map((n) => n.trim())).toEqual(recent);
});
