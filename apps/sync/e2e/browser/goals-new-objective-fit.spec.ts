import { expect, test } from '@playwright/test';
import { innerFitViolations } from './sheet-inner-fit';

/**
 * QA-105: Goals > New objective > Link. The sheet and the nested project
 * picker fit the window at 1440x900 and 1000x700, header and footer stay
 * visible, Escape closes the picker first and then the sheet.
 * QA-107: every input and control inside the sheet and the picker sits inside
 * its parent's content box, sibling inputs do not intersect, and the sheet body
 * does not scroll sideways.
 */
for (const [width, height] of [[1440, 900], [1000, 700]] as const) {
  test(`New objective and its project picker fit ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/desktop-alt.html?window=desktop-alt&theme=dark&persona=indigo');
    await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => (document.querySelector('[data-testid="rail-company"]') as HTMLElement | null)?.click());
    await page.waitForSelector('[data-row-id="goals"]');
    await page.evaluate(() => (document.querySelector('[data-row-id="goals"]') as HTMLElement | null)?.click());
    await page.getByTestId('new-objective').click();
    const sheet = page.getByRole('dialog', { name: 'New objective' });
    await expect(sheet).toBeVisible();
    expect(await innerFitViolations(page, '[role="dialog"][aria-label="New objective"]'), 'sheet inner boxes').toEqual([]);
    const body = await page.evaluate(() => {
      const sb = document.querySelector('[role="dialog"][aria-label="New objective"] .sb') as HTMLElement;
      return { scrollWidth: sb.scrollWidth, clientWidth: sb.clientWidth };
    });
    expect(body.scrollWidth, 'sheet body scrollWidth').toBe(body.clientWidth);
    await page.getByTestId('new-goal-link').click();
    const picker = page.getByTestId('link-picker');
    await expect(picker).toBeVisible();

    const boxes = await page.evaluate(() => {
      const box = (el: Element | null) => {
        const r = el?.getBoundingClientRect();
        return r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right } : null;
      };
      const sheetEl = document.querySelector('[role="dialog"][aria-label="New objective"]');
      return {
        sheet: box(sheetEl),
        header: box(sheetEl?.querySelector('.sh') ?? null),
        footer: box(sheetEl?.querySelector('.sf') ?? null),
        picker: box(document.querySelector('[data-testid="link-picker"]')),
        vw: innerWidth,
        vh: innerHeight,
      };
    });
    for (const key of ['sheet', 'header', 'footer', 'picker'] as const) {
      const b = boxes[key]!;
      expect(b, key).not.toBeNull();
      expect(b.top, `${key} top`).toBeGreaterThanOrEqual(0);
      expect(b.left, `${key} left`).toBeGreaterThanOrEqual(0);
      expect(b.bottom, `${key} bottom`).toBeLessThanOrEqual(boxes.vh);
      expect(b.right, `${key} right`).toBeLessThanOrEqual(boxes.vw);
    }

    expect(await innerFitViolations(page, '[data-testid="link-picker"]'), 'picker inner boxes').toEqual([]);

    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  });
}
