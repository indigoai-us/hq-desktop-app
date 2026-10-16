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

// Owner, 2026-10-16: the update card "shoul dbe equidistant from bottom as from right".
for (const [width, height] of [[1440, 900], [1000, 700]] as const) {
  test(`the toast stack sits as far from the bottom as from the right at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/dev-harness/index.html?view=shell&persona=indigo&theme=dark&toast=update');
    await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
    await expect(visibleToasts(page).first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);
    const gaps = await page.getByTestId('toast-stack').evaluate((el) => {
      const r = el.getBoundingClientRect();
      const toasts = [...el.querySelectorAll('[data-toast-id]')].map((t) => t.getBoundingClientRect());
      const composers = [...document.querySelectorAll('[data-testid="conversation-composer"], [data-testid="composer-send"]')]
        .map((c) => c.getBoundingClientRect())
        .filter((c) => c.width > 0 && c.height > 0);
      const covers = composers.some((c) => toasts.some((t) => Math.min(c.right, t.right) > Math.max(c.left, t.left) && Math.min(c.bottom, t.bottom) > Math.max(c.top, t.top)));
      return {
        right: Math.round(window.innerWidth - r.right),
        bottom: Math.round(window.innerHeight - r.bottom),
        lifted: el.hasAttribute('data-composer-lift'),
        covers,
      };
    });
    expect(gaps.right).toBe(16);
    expect(gaps.covers).toBe(false);
    // Equal gaps unless the conversation's composer is in the way (at 1000x700
    // it is, and the stack sits just above it instead).
    if (!gaps.lifted) expect(gaps.bottom).toBe(gaps.right);
    else expect(gaps.bottom).toBeGreaterThan(16);
    expect(gaps.lifted).toBe(width < 1440);
  });
}

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

// Shawon's review, 2026-10-16: on Messages a sticky update notice could cover
// the composer's Send button at the 16px inset. The stack lifts just clear of
// a composer it would cover, and drops back once it is gone.
test('the toast stack lifts clear of a message composer it would cover, and drops back after', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dev-harness/index.html?view=shell&persona=indigo&theme=dark&toast=update');
  await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
  await expect(visibleToasts(page).first()).toBeVisible({ timeout: 10_000 });
  const stackBottomGap = () =>
    page.getByTestId('toast-stack').evaluate((el) => Math.round(window.innerHeight - el.getBoundingClientRect().bottom));
  await expect.poll(stackBottomGap).toBe(16);

  // A composer docked at the bottom right, where a conversation puts it.
  await page.evaluate(() => {
    const send = document.createElement('button');
    send.dataset.testid = 'composer-send';
    send.id = 'fake-composer-send';
    Object.assign(send.style, { position: 'fixed', right: '40px', bottom: '28px', width: '28px', height: '32px' });
    document.body.appendChild(send);
  });
  await expect.poll(async () => {
    return page.evaluate(() => {
      const send = document.getElementById('fake-composer-send')!.getBoundingClientRect();
      const toasts = [...document.querySelectorAll('[data-testid="toast-stack"] [data-toast-id]')].map((t) => t.getBoundingClientRect());
      return toasts.every((t) => t.bottom <= send.top);
    });
  }).toBe(true);
  expect(await stackBottomGap()).toBeGreaterThan(16);

  await page.evaluate(() => document.getElementById('fake-composer-send')?.remove());
  await expect.poll(stackBottomGap).toBe(16);
});
