import { expect, test, type Page } from '@playwright/test';

/**
 * Toasts never cover an open overlay. With a sheet, picker or the command
 * palette open and toasts showing, no visible toast box intersects the
 * overlay's box; once the overlay closes the toasts are back and reachable.
 */

const OVERLAYS = '[role="dialog"], [aria-modal="true"]';

async function coveredOverlays(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    const toasts = Array.from(document.querySelectorAll('[data-testid="toast-stack"] > *')).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
    const overlays = Array.from(document.querySelectorAll(selector)).filter(
      (el) => !el.closest('[data-testid="toast-stack"]') && el.getBoundingClientRect().width > 0,
    );
    const out: string[] = [];
    for (const o of overlays) {
      const a = o.getBoundingClientRect();
      for (const t of toasts) {
        const b = t.getBoundingClientRect();
        if (Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)) {
          out.push(`${o.getAttribute('aria-label') ?? o.getAttribute('data-testid')} covered by ${t.textContent?.trim().slice(0, 40)}`);
        }
      }
    }
    return out;
  }, OVERLAYS);
}

const visibleToasts = (page: Page) =>
  page.locator('[data-testid="toast-stack"] > [data-testid]:not([data-testid="toast-overflow"])').filter({ visible: true });

for (const [width, height] of [[1440, 900], [1000, 700]] as const) {
  test(`toasts stay off the New project sheet at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/dev-harness/index.html?view=shell&persona=indigo&theme=dark&toast=update');
    await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
    await expect(visibleToasts(page).first()).toBeVisible({ timeout: 10_000 });
    await page.evaluate(() => (document.querySelector('[data-testid="rail-company"]') as HTMLElement | null)?.click());
    await page.waitForSelector('[data-row-id="projects"]');
    await page.evaluate(() => (document.querySelector('[data-row-id="projects"]') as HTMLElement | null)?.click());
    await page.getByTestId('new-project-button').click();
    await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
    await expect.poll(() => coveredOverlays(page)).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'New project' })).toHaveCount(0);
    // The toast that needs action is back and its buttons can be reached.
    await expect(visibleToasts(page).first()).toBeVisible();
    await expect(visibleToasts(page).first().getByRole('button').first()).toBeEnabled();
  });

  test(`toasts stay off the command palette at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/dev-harness/index.html?view=shell&persona=indigo&theme=dark&toast=stack');
    await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
    await expect(visibleToasts(page).first()).toBeVisible({ timeout: 10_000 });
    const mac = await page.evaluate(() => /Mac OS X|Macintosh/i.test(navigator.userAgent));
    await page.getByTestId('rail-home').focus();
    await page.keyboard.press(mac ? 'Meta+k' : 'Control+k');
    await expect(page.getByTestId('command-palette')).toBeVisible();
    await expect.poll(() => coveredOverlays(page)).toEqual([]);
  });
}
