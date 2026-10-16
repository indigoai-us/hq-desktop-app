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

// Owner, 2026-10-16: "the accomplishments announcement should allow me to view
// each card when i cliock on it, and go into card viewer where i can flip it".
test('clicking a dealt card opens it in the card viewer, where it flips, and closing returns to the announcement', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dev-harness/index.html?view=shell&persona=indigo&theme=dark&launch');
  const layer = page.getByTestId('badge-launch');
  await expect(layer).toBeVisible({ timeout: 30_000 });
  const card = page.getByTestId('badge-launch-card').nth(2);
  await expect(card).toBeEnabled({ timeout: 5_000 });
  const id = await card.getAttribute('data-badge-id');
  await card.click();

  const viewer = page.getByTestId('badge-card-modal');
  await expect(viewer).toBeVisible();
  // Drawn inside the announcement layer, above it and clickable.
  expect(await viewer.evaluate((el) => Boolean(el.closest('[data-testid="badge-launch"]')) && !el.closest('[inert]'))).toBe(true);
  const dialog = viewer.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(id).toBeTruthy();

  await viewer.getByRole('button', { name: /flip card/i }).click();
  await expect(viewer.getByTestId('badge-card-back')).toBeVisible();

  // Escape closes the viewer only; the announcement stays, live again.
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(layer).toBeVisible();
  await expect(page.locator('.la-stage')).not.toHaveAttribute('inert', '');
  await expect(card).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(layer).toHaveCount(0);
});

for (const size of ['large', 'compact'] as const) {
  test(`the "+N more" pill is whole and on top at the ${size} interface size`, async ({ page }) => {
    // Owner, 2026-10-16: the pill "is still getting cropped at bottom".
    await page.setViewportSize({ width: 1180, height: 700 });
    await page.goto('/dev-harness/index.html?view=shell&persona=indigo&theme=dark&launch');
    await page.evaluate((s) => document.documentElement.setAttribute('data-ui-size', s), size);
    const pill = page.getByTestId('badge-launch-more');
    await expect(pill).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2500);
    const geo = await pill.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const points = [
        [r.left + r.width / 2, r.top + 2],
        [r.left + r.width / 2, r.bottom - 2],
        [r.left + 6, r.bottom - 3],
        [r.right - 6, r.bottom - 3],
      ];
      return {
        bottom: r.bottom,
        vh: window.innerHeight,
        onTop: points.every(([x, y]) => document.elementFromPoint(x, y) === el),
        z: getComputedStyle(el).zIndex,
      };
    });
    expect(geo.bottom).toBeLessThanOrEqual(geo.vh);
    expect(geo.onTop).toBe(true);
    expect(Number(geo.z)).toBeGreaterThan(20);
  });
}
