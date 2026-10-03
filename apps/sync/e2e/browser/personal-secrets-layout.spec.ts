import { expect, test } from '@playwright/test';

/**
 * QA-099: Personal Secrets at narrow content widths. Before the fix, a
 * 1000 px content column left the Name column ~30 px wide, so names
 * vanished, Name and Scope sat on the same left edge, and the New secret
 * button ran past the right edge. Real layout, real engine: the stage mounts
 * the shipped page with 19 rows at a fixed width.
 */

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const width of [1000, 700]) {
  test(`names stay readable and New secret fits at ${width} px`, async ({ page }) => {
    // First visit compiles the stage on a cold vite server.
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/personal-secrets-layout.html?w=${width}`);
    const rows = page.locator('[data-testid="personal-secrets-list"] .srow');
    await expect(rows).toHaveCount(19, { timeout: 90_000 });

    for (const i of [0, 9, 18]) {
      const row = rows.nth(i);
      const name = row.locator('.nm');
      const scope = row.locator('> span').nth(1);
      await expect(name).toHaveText(new RegExp(`^PERSONAL_SERVICE_${String(i + 1).padStart(2, '0')}_`));
      await expect(scope).toHaveText('Personal');
      const nameBox = (await name.boundingBox())!;
      const scopeBox = (await scope.boundingBox())!;
      // A usable slice of the name is on screen, left of Scope, not on top of it.
      expect(nameBox.width).toBeGreaterThan(80);
      expect(overlaps(nameBox, scopeBox)).toBe(false);
      expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(scopeBox.x);
      // Long names are cut with an ellipsis, not wrapped or spilled.
      const truncated = await name.evaluate((el) => {
        const style = getComputedStyle(el);
        return style.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth;
      });
      expect(truncated).toBe(true);
    }

    const button = page.getByTestId('new-secret');
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    // The label is not clipped inside the button.
    const clipped = await button.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped).toBe(false);
  });
}
