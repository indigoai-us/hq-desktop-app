import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The first view is the Daily Brief page itself, drawn from Core's welcome
 * output on the design harness (?view=first-view). The owner's frame rules,
 * at three window sizes in both app themes: the sunrise and the Connect card
 * are on screen, row 3 can be scrolled to, nothing reads "0 companies" or
 * "Nothing is owed today", an imported HQ never asks to bring past work in,
 * a harness found on this Mac is never offered Connect, and the Connect rows
 * show their status words in full.
 */

const SIZES = [
  { width: 1024, height: 640 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;
const THEMES = ['dark', 'light'] as const;

async function openFirstView(page: Page, size: { width: number; height: number }, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize(size);
  await page.goto(`/dev-harness/index.html?view=first-view&${query}`);
  await expect(page.getByTestId('first-view-grid')).toBeVisible({ timeout: 30_000 });
  return errors;
}

const slot = (page: Page, widget: string): Locator => page.locator(`[data-testid="first-view-grid"] > [data-widget="${widget}"]`);

/** Scrolls the page's own frame until the element's bottom edge is in the window, then reports whether it is. */
async function bottomReachable(page: Page, el: Locator): Promise<boolean> {
  await el.evaluate((node) => node.scrollIntoView({ block: 'end' }));
  const box = await el.boundingBox();
  const vh = page.viewportSize()!.height;
  return !!box && box.y + box.height <= vh + 1 && box.y + box.height > 0;
}

for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`first view at ${size.width}x${size.height}, ${theme} theme, keeps the owner frame rules`, async ({ page }) => {
      const errors = await openFirstView(page, size, `theme=${theme}`);
      const grid = page.getByTestId('first-view-grid');

      // The Connect card starts above the fold, before any scrolling.
      const connect = slot(page, 'connect');
      await expect(connect).toBeVisible();
      const connectTop = (await connect.boundingBox())!.y;
      expect(connectTop).toBeLessThan(size.height);

      // The sunrise's bottom edge is on screen or a scroll away.
      expect(await bottomReachable(page, slot(page, 'sunrise'))).toBe(true);

      // Row 3 (the last row of the grid) can be scrolled to.
      const slots = grid.locator(':scope > .fv-slot');
      const last = slots.nth((await slots.count()) - 1);
      expect(await bottomReachable(page, last)).toBe(true);
      expect(await slots.count()).toBeGreaterThanOrEqual(3);

      // Copy that must never show on the first view.
      const scroller = page.getByTestId('first-view-scroller');
      await expect(scroller.getByText('Bring in your past work')).toHaveCount(0);
      await expect(scroller.getByText('Nothing is owed today')).toHaveCount(0);
      await expect(scroller.getByText(/\b0 companies\b/)).toHaveCount(0);

      // A harness found on this Mac shows Open or Connected, never Connect.
      const found = page.locator('[data-testid="first-view-connect-row"][data-found="true"]');
      expect(await found.count()).toBeGreaterThan(0);
      for (const row of await found.all()) {
        await expect(row.getByRole('button', { name: 'Connect' })).toHaveCount(0);
        await expect(row.getByText('Found on this Mac', { exact: true })).toBeVisible();
      }

      // Every Connect row's status reads in full, without an ellipsis or clipping.
      const notes = page.locator('[data-testid="first-view-connect-row"] .fv-note');
      expect(await notes.count()).toBeGreaterThan(0);
      for (const note of await notes.all()) {
        const text = (await note.textContent())?.trim();
        expect(['Found on this Mac', 'Not connected yet']).toContain(text);
        const clipped = await note.evaluate((n) => n.scrollWidth > n.clientWidth + 1);
        expect(clipped, `"${text}" is clipped`).toBe(false);
      }

      // No card is stretched far past its content (the quiet-day min-height once made every card a screen tall).
      for (const widget of ['connect', 'oneThing', 'focus', 'risk']) {
        const empty = await slot(page, widget).locator('.w').first().evaluate((card) => {
          const leaves = [...card.querySelectorAll('*')].filter((n) => n.childElementCount === 0 && n.getBoundingClientRect().height > 0);
          const contentBottom = Math.max(...leaves.map((n) => n.getBoundingClientRect().bottom));
          const padding = parseFloat(getComputedStyle(card).paddingBottom) || 0;
          return card.getBoundingClientRect().bottom - padding - contentBottom;
        });
        expect(empty, `${widget} has ${Math.round(empty)}px empty below its content`).toBeLessThan(120);
      }

      expect(errors).toEqual([]);
    });
  }
}

test('the page scrolls in a window shorter than 560px', async ({ page }) => {
  const errors = await openFirstView(page, { width: 1024, height: 500 }, 'theme=dark');
  const scroller = page.getByTestId('first-view-scroller');
  const overflow = await scroller.evaluate((n) => n.scrollHeight - n.clientHeight);
  expect(overflow).toBeGreaterThan(0);
  expect(await bottomReachable(page, slot(page, 'sunrise'))).toBe(true);
  expect(errors).toEqual([]);
});

test('the loading rise keeps the sunrise on screen at 1024x640', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.goto('/dev-harness/index.html?view=first-view&theme=light&rise=2');
  const rise = page.getByTestId('brief-rise');
  await expect(rise).toBeVisible({ timeout: 30_000 });
  expect(await bottomReachable(page, rise)).toBe(true);
  await expect(page.getByText('Nothing is owed today')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Connect opens the existing Settings page instead of a new panel', async ({ page }) => {
  const errors = await openFirstView(page, { width: 1440, height: 900 }, 'theme=dark');
  await expect(page.getByTestId('first-view-grid')).toHaveAttribute('data-connect-mode', 'settings');
  const connectButton = page.locator('[data-testid="first-view-connect-row"]').getByRole('button', { name: 'Connect' }).first();
  await connectButton.click();
  await expect(page.locator('body')).toHaveAttribute('data-first-view-opened', /^(integrations|ai-apps)$/);
  expect(errors).toEqual([]);
});
