import { expect, test } from '@playwright/test';

/**
 * Atlas Today panel and Not on the map dock, measured in a real engine on the
 * atlas-stage page (the real AtlasView with a /brainstorm run's five files, a
 * person working in a repo, and a dock of people and bots). Set ATLAS_SHOT_DIR to also save screenshots.
 */
const SHOT_DIR = process.env.ATLAS_SHOT_DIR;

for (const theme of ['dark', 'light'] as const) {
  test(`Atlas Today lists projects worked on today with a story counter (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/atlas-stage.html?theme=${theme}`);
    const today = page.getByTestId('atlas-today-projects');
    await expect(today).toBeVisible({ timeout: 30_000 });

    const first = page.getByTestId('atlas-today-project').first();
    await expect(first.getByTestId('atlas-today-project-title')).toHaveText('HQ explorer');
    await expect(first.getByTestId('atlas-today-stories')).toContainText('12/31 stories');
    await expect(first).toContainText('34 min ago');
    // Projects only: no nested file rows, and no Company block above the list.
    await expect(page.getByTestId('atlas-today-row')).toHaveCount(0);
    await expect(page.getByTestId('atlas-inspector-rollup')).toHaveCount(0);
    await expect(page.getByTestId('atlas-inspector').locator('h2')).toHaveCount(0);
    const bar = await first.locator('.track').boundingBox();
    expect(bar!.height).toBeLessThanOrEqual(3);

    if (SHOT_DIR) {
      await page.mouse.move(0, 0);
      await page.getByTestId('atlas-inspector').screenshot({ path: `${SHOT_DIR}/today-after-${theme}.png` });
    }
  });

  test(`Atlas places a person with only a repo next to that repo (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/atlas-stage.html?theme=${theme}`);
    const chip = page.getByTestId('atlas-chip-u_st');
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toHaveAttribute('data-node', 'repo:repos/private/hq-desktop-app/');
    await expect(page.getByTestId('atlas-unplaced-u_st')).toHaveCount(0);
    // The live chip pulses, so it never settles for a pointer hover.
    await chip.dispatchEvent('pointerenter');
    const card = page.getByTestId('atlas-hover-card');
    await expect(card).toContainText('Stefan Johnson');
    await expect(card).toContainText('Working in hq-desktop-app · corey/map');

    if (SHOT_DIR) {
      await page.screenshot({ path: `${SHOT_DIR}/repo-person-${theme}.png` });
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
