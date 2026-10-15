import { expect, test } from '@playwright/test';

/**
 * hq-accomplishment-badges US-016: the launch announcement opens only when
 * asked for (`?launch`, standing in for badges.api being on), closes with
 * Escape, and never opens over the ordinary harness views the rest of this
 * suite drives (toasts, menus, sheets).
 */

test('the shell never shows the launch announcement unless it is asked for', async ({ page }) => {
  await page.goto('/dev-harness/index.html?view=shell&persona=indigo&theme=dark');
  await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
  // Past the announcement's open delay.
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('badge-launch')).toHaveCount(0);
});

test('?launch opens it over the shell with the hand of cards, and Escape closes it', async ({ page }) => {
  await page.goto('/dev-harness/index.html?view=shell&persona=indigo&theme=dark&launch');
  const layer = page.getByTestId('badge-launch');
  await expect(layer).toBeVisible({ timeout: 30_000 });
  await expect(layer.getByRole('dialog', { name: 'Accomplishments' })).toBeVisible();
  await expect(layer.getByTestId('badge-card').first()).toBeVisible();
  await expect(page.getByTestId('badge-launch-open')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(layer).toHaveCount(0);
});
