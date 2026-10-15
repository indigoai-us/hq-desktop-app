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

for (const size of ['large', 'compact'] as const) {
  test(`fits the window at the ${size} interface size, buttons included`, async ({ page }) => {
    // Owner, 2026-10-15: "cut off at bottom". The shell zooms with Interface
    // size; the announcement must not inherit that zoom.
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.goto('/dev-harness/index.html?view=shell&persona=indigo&theme=dark&launch');
    await page.evaluate((s) => document.documentElement.setAttribute('data-ui-size', s), size);
    const layer = page.getByTestId('badge-launch');
    await expect(layer).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2500);
    const box = await layer.boundingBox();
    const open = await page.getByTestId('badge-launch-open').boundingBox();
    // WebKit (the app's webview) sizes a fixed layer inside a zoomed ancestor
    // by the zoom; Chromium does not, so also check that no ancestor zooms.
    const ancestorZoom = await layer.evaluate((el) => {
      let z = 1;
      for (let n = el.parentElement; n; n = n.parentElement) z *= Number(getComputedStyle(n).zoom || '1');
      return z;
    });
    expect(ancestorZoom).toBe(1);
    expect(box && Math.round(box.height)).toBe(760);
    expect(open && open.y + open.height).toBeLessThanOrEqual(760);
  });
}
