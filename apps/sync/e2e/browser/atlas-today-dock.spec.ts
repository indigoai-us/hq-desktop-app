import { expect, test } from '@playwright/test';

/**
 * Atlas Today panel and Not on the map dock, measured in a real engine on the
 * atlas-stage page (the real AtlasView with a /brainstorm run's five files and
 * a dock of people and bots). Set ATLAS_SHOT_DIR to also save screenshots.
 */
const SHOT_DIR = process.env.ATLAS_SHOT_DIR;

for (const theme of ['dark', 'light'] as const) {
  test(`Atlas Today groups a brainstorm run under its project (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/atlas-stage.html?theme=${theme}`);
    const today = page.getByTestId('atlas-today-changed');
    await expect(today).toBeVisible({ timeout: 30_000 });

    const first = page.getByTestId('atlas-today-group').first();
    await expect(first.getByTestId('atlas-today-group-title')).toHaveText('HQ explorer');
    await expect(first.getByTestId('atlas-today-stories')).toContainText('7 of 11 stories');
    await expect(first.getByTestId('atlas-today-state')).toHaveAttribute('data-column', 'in-progress');
    await expect(first.getByTestId('atlas-today-row')).toHaveCount(3);
    await first.getByTestId('atlas-today-group-more').click();
    const rows = first.getByTestId('atlas-today-row');
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(4)).toContainText('References');
    await expect(rows.nth(4)).toContainText('projects/hq-explorer/');

    // Rows are indented under their group header, and their icons differ by kind.
    const indent = await page.evaluate(() => {
      const head = document.querySelector('[data-testid="atlas-today-group-head"] .ticon')!.getBoundingClientRect();
      const row = document.querySelector('[data-testid="atlas-today-row"] .ticon')!.getBoundingClientRect();
      return row.left - head.left;
    });
    expect(indent).toBeGreaterThanOrEqual(20);
    const kinds = await page.$$eval('[data-testid="atlas-today-row"]', (els) => [...new Set(els.map((e) => e.getAttribute('data-kind')))]);
    expect(kinds).toEqual(expect.arrayContaining(['brainstorm', 'knowledge']));

    if (SHOT_DIR) {
      await page.mouse.move(0, 0);
      await page.getByTestId('atlas-inspector').screenshot({ path: `${SHOT_DIR}/today-after-${theme}.png` });
    }
  });

  test(`Atlas Not on the map dock: one circle for everyone (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/atlas-stage.html?theme=${theme}`);
    const dock = page.getByTestId('atlas-unplaced');
    await expect(dock).toBeVisible({ timeout: 30_000 });
    await expect(dock.getByTestId('atlas-unplaced-count')).toHaveText('35');

    const chips = await dock.evaluate((el) =>
      [...el.querySelectorAll<HTMLElement>('.away')].map((c) => {
        const s = getComputedStyle(c);
        const box = c.getBoundingClientRect();
        return {
          kind: c.getAttribute('data-kind') ?? 'more',
          w: Math.round(box.width),
          h: Math.round(box.height),
          radius: s.borderTopLeftRadius,
          border: s.borderTopWidth,
          ring: s.boxShadow,
          idle: c.classList.contains('idle'),
        };
      }),
    );
    expect(chips.length).toBe(13);
    expect(new Set(chips.map((c) => `${c.w}x${c.h}`))).toEqual(new Set(['22x22']));
    expect(new Set(chips.map((c) => c.radius))).toEqual(new Set(['50%']));
    expect(new Set(chips.map((c) => c.border))).toEqual(new Set(['1px']));
    expect(chips.filter((c) => c.kind === 'bot').length).toBeGreaterThan(0);
    // Ring on live chips only; idle chips and +N have none.
    for (const c of chips) expect(c.ring === 'none', JSON.stringify(c)).toBe(c.idle || c.kind === 'more');
    const cap = dock.locator('.unplaced-cap');
    await expect(cap).toHaveCSS('text-transform', 'none');

    // Keyboard: focus shows the name and kind.
    await dock.locator('.away').first().focus();
    await expect(page.getByTestId('atlas-hover-card')).toContainText('Person');

    if (SHOT_DIR) {
      await page.mouse.move(0, 0);
      await dock.locator('.away').first().blur();
      await dock.screenshot({ path: `${SHOT_DIR}/dock-after-${theme}.png` });
    }
  });
}
