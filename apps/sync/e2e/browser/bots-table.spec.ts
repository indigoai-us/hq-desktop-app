import { expect, test, type Page } from '@playwright/test';

/**
 * Bots table: header cells line up with row cells, every row carries one
 * status-ladder dot, columns drop as the window narrows, Last seen sorts,
 * and a row click opens that bot's profile.
 */

const SHELL = '/desktop-alt.html?window=desktop-alt&persona=indigo&bots=table';

async function openBots(page: Page, width = 1440): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(SHELL);
  await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-testid="rail-company"]').first().click();
  await page.locator('[data-row-id="bots"]').first().click();
  await expect(page.getByTestId('bot-row').first()).toBeVisible();
  await expect(page.getByTestId('bots-loader')).toHaveCount(0);
}

const headLabels = (page: Page) => page.locator('[data-testid="bots-head"] .th').allTextContents();

test('every row has one status from the ladder, ready first', async ({ page }) => {
  await openBots(page);
  const statuses = await page.getByTestId('bot-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-status')));
  expect(statuses.length).toBeGreaterThan(3);
  for (const s of statuses) expect(['ready', 'waiting', 'error', 'offline']).toContain(s);
  const rank = { ready: 0, waiting: 1, error: 2, offline: 3 } as Record<string, number>;
  const ranks = statuses.map((s) => rank[s!]!);
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  await expect(page.getByTestId('bot-row').first().getByTestId('bot-avatar')).toBeVisible();
});

test('header labels line up with their cells', async ({ page }) => {
  await openBots(page);
  const head = page.locator('[data-testid="bots-head"] .th');
  const cells = page.getByTestId('bot-row').first().locator(':scope > span');
  const n = await head.count();
  expect(await cells.count()).toBe(n);
  for (let i = 1; i < n; i += 1) {
    const [h, c] = await Promise.all([head.nth(i).boundingBox(), cells.nth(i).boundingBox()]);
    expect(Math.abs(h!.x - c!.x), `column ${i}`).toBeLessThanOrEqual(1);
  }
});

test('columns drop as the window narrows; name, last seen and status stay', async ({ page }) => {
  await openBots(page, 1440);
  const wide = await headLabels(page);
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect.poll(async () => (await headLabels(page)).length).toBeLessThan(wide.length);
  const narrow = await headLabels(page);
  expect(narrow).toContain('Name');
  expect(narrow.some((l) => l.startsWith('Status'))).toBe(true);
  expect(narrow.some((l) => l.startsWith('Last seen'))).toBe(true);
  // No cell text spills into the next column.
  const overflow = await page.getByTestId('bot-row').first().evaluate((row) =>
    [...row.children].some((c) => (c as HTMLElement).getBoundingClientRect().right > row.getBoundingClientRect().right + 0.5),
  );
  expect(overflow).toBe(false);
});

test('Last seen sorts most recent first; a row click opens that bot', async ({ page }) => {
  await openBots(page);
  await page.getByTestId('bots-sort-lastSeen').click();
  await expect(page.getByTestId('bots-sort-lastSeen')).toHaveAttribute('aria-sort', 'descending');
  const seen = await page.locator('[data-testid="bot-row"] [data-col="last-seen"]').allTextContents();
  expect(seen[0]).toMatch(/now|1 min ago/);
  const herald = page.getByTestId('bot-row').filter({ hasText: 'Herald' });
  await herald.click();
  await expect(herald).toHaveClass(/is-selected/);
  await expect(page.getByTestId('bot-inspector')).toContainText('Herald');
});
