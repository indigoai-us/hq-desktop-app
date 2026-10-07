import { expect, test } from '@playwright/test';

/**
 * OWNER-R8: clicking an objective opens the side pane beside the list. The
 * pane and the list fit the window at 1440x900 and 1000x700 with no sideways
 * scroll, the row reads as selected, and Escape closes the pane.
 */
for (const [width, height] of [[1440, 900], [1000, 700]] as const) {
  test(`objective side pane fits ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/desktop-alt.html?window=desktop-alt&theme=dark&persona=indigo');
    await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => (document.querySelector('[data-testid="rail-company"]') as HTMLElement | null)?.click());
    await page.waitForSelector('[data-row-id="goals"]');
    await page.evaluate(() => (document.querySelector('[data-row-id="goals"]') as HTMLElement | null)?.click());
    const row = page.getByTestId('goal-row').first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    const pane = page.getByTestId('goal-pane');
    await expect(pane).toBeVisible();
    await expect(row).toHaveAttribute('aria-pressed', 'true');

    const fit = await page.evaluate(() => {
      const box = (el: Element | null) => el?.getBoundingClientRect() ?? null;
      const view = document.querySelector('[data-testid="goals-view"]') as HTMLElement;
      const body = document.querySelector('[data-testid="goal-pane"] .pb') as HTMLElement;
      const p = box(document.querySelector('[data-testid="goal-pane"]'));
      return {
        pane: p && { top: p.top, bottom: p.bottom, left: p.left, right: p.right },
        viewScroll: [view.scrollWidth, view.clientWidth],
        bodyScroll: [body.scrollWidth, body.clientWidth],
        vw: innerWidth,
        vh: innerHeight,
      };
    });
    expect(fit.pane).not.toBeNull();
    expect(fit.pane!.right).toBeLessThanOrEqual(fit.vw);
    expect(fit.pane!.bottom).toBeLessThanOrEqual(fit.vh);
    expect(fit.viewScroll[0], 'goals view scrollWidth').toBe(fit.viewScroll[1]);
    expect(fit.bodyScroll[0], 'pane body scrollWidth').toBe(fit.bodyScroll[1]);

    if (process.env.R8_SHOT_DIR) {
      await page.screenshot({ path: `${process.env.R8_SHOT_DIR}/r8-after-pane-${width}x${height}.png` });
    }

    await page.keyboard.press('Escape');
    await expect(pane).toHaveCount(0);
    await expect(row).toBeFocused();
  });
}
