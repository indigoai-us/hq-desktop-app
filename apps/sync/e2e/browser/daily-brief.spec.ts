import { expect, test, type Page } from '@playwright/test';

/**
 * Daily Brief user path, on the design harness (mocked Tauri). Two runs:
 * the approved Oct 8 seed brief as the page renders it, and the simulated
 * Create brief run (?briefDemo=1) from the empty state to a ready brief.
 * The owner rules the page must hold: lists cap at five rows then "+N more",
 * no card narrower than 190px, review mode on Shift+A shows every card.
 */

const BRIEF = '/dev-harness/index.html?view=brief';
const MIN_CARD_PX = 190;

async function openBrief(page: Page, url: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(url);
  return errors;
}

/** Every grid card's rendered width, in CSS pixels. */
async function cardWidths(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('main.b-grid > .slot')].map((el) => el.getBoundingClientRect().width),
  );
}

test.describe('daily brief: user path', () => {
  test('the seed brief renders its priorities and cards within the owner rules', async ({ page }) => {
    const errors = await openBrief(page, BRIEF);
    await expect(page.getByTestId('brief-priorities')).toBeVisible({ timeout: 30_000 });

    // Today's priorities: at most five, each with a reason.
    const priorities = page.getByTestId('brief-priority');
    const count = await priorities.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(5);

    // The grid has cards and none is narrower than the floor.
    const widths = await cardWidths(page);
    expect(widths.length).toBeGreaterThanOrEqual(1);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(MIN_CARD_PX - 1);

    // Needs you shows at most five calls on its face; the rest fold into "+N more".
    const needs = page.getByTestId('brief-need');
    expect(await needs.count()).toBeLessThanOrEqual(5);

    // Review mode: Shift+A shows every card by group, Shift+A again returns.
    await page.keyboard.press('Shift+A');
    await expect(page.getByTestId('brief-review')).toBeVisible();
    expect(await page.getByTestId('brief-review-group').count()).toBeGreaterThan(1);
    await page.keyboard.press('Shift+A');
    await expect(page.getByTestId('brief-review')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('Create brief runs to a ready brief from the empty state', async ({ page }) => {
    // The simulated run takes about twenty seconds on a quiet machine; give
    // the whole test room beyond the default so the 60s wait below is real.
    test.setTimeout(120_000);
    const errors = await openBrief(page, `${BRIEF}&briefDemo=1`);
    const create = page.getByTestId('brief-create').first();
    await expect(create).toBeVisible({ timeout: 30_000 });
    await create.click();
    // Until the bot writes its first status, the sunrise says the brief is
    // getting started, and never names the bot.
    await expect(page.getByTestId('brief-dawn-step')).toContainText('Getting your brief started', { timeout: 2_000 });
    await expect(page.getByTestId('brief-dawn-step')).not.toContainText('demo');
    // The sunrise loader shows the run's progress while the simulated bot works.
    await expect(page.getByTestId('brief-loader')).toBeVisible({ timeout: 10_000 });
    // The simulated run takes about twenty seconds, then the brief renders.
    await expect(page.getByTestId('brief-priorities')).toBeVisible({ timeout: 60_000 });
    const widths = await cardWidths(page);
    expect(widths.length).toBeGreaterThanOrEqual(1);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(MIN_CARD_PX - 1);
    expect(errors).toEqual([]);
  });

  test('a run that fails shows the plain failed line, never the bot\'s raw error, and offers Try again', async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await openBrief(page, `${BRIEF}&briefDemo=fail`);
    const create = page.getByTestId('brief-create').first();
    await expect(create).toBeVisible({ timeout: 30_000 });
    await create.click();
    // The simulated bot fails partway through the sweep with a raw gh error; only the plain line shows.
    const step = page.getByTestId('brief-dawn-step');
    await expect(step).toContainText('The brief stopped before it finished.', { timeout: 30_000 });
    await expect(page.locator('body')).not.toContainText('gh auth login');
    await expect(step).not.toContainText('skill_not_found');
    await expect(page.getByTestId('brief-retry')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
