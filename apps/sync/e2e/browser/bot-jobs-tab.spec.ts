import { expect, test, type Page } from '@playwright/test';

/**
 * Bot profile pane Profile | Jobs: the Jobs tab lists the bot's scheduled
 * jobs failing-first, the chips filter them, and a row opens the detail
 * with the full prompt and schedule. The pane is the same one the bot DM
 * shows on the right.
 */

const SHELL = '/desktop-alt.html?window=desktop-alt&persona=indigo';

async function openJobs(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(SHELL);
  await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-testid="rail-company"]').first().click();
  await page.locator('[data-row-id="bots"]').first().click();
  await expect(page.getByTestId('bot-pane-tab-jobs')).toContainText('Jobs5');
  await page.getByTestId('bot-pane-tab-jobs').click();
  await expect(page.getByTestId('bot-job-row').first()).toBeVisible();
}

test('Jobs lists failing first, then by next run, paused last', async ({ page }) => {
  await openJobs(page);
  const names = await page.locator('[data-testid="bot-job-row"] .t').allTextContents();
  expect(names[0]).toBe('Post the standup notes to #team');
  expect(names[names.length - 1]).toBe('Write the weekly metrics recap');
  await expect(page.getByTestId('bot-job-row').first()).toContainText('Weekdays at 9:00 AM');
  await expect(page.getByTestId('bot-job-row').first()).toContainText('failed');
});

test('chips filter to one-off and failed jobs', async ({ page }) => {
  await openJobs(page);
  await page.getByTestId('bot-jobs-filter-one-off').click();
  await expect(page.locator('[data-testid="bot-job-row"] .t')).toHaveText(['Launch review']);
  await page.getByTestId('bot-jobs-filter-failed').click();
  await expect(page.locator('[data-testid="bot-job-row"] .t')).toHaveText(['Post the standup notes to #team']);
});

test('a row opens the detail; nothing in the pane spills past its edge', async ({ page }) => {
  await openJobs(page);
  await page.getByTestId('bot-job-row').first().click();
  const detail = page.getByTestId('bot-job-detail');
  await expect(detail).toBeVisible();
  await expect(page.getByTestId('bot-job-prompt')).toContainText("Pull blockers from yesterday's threads");
  await expect(page.getByTestId('bot-job-detail-schedule')).toContainText('Weekdays at 9:00 AM');
  await expect(page.getByTestId('bot-job-pause')).toBeVisible();
  const spill = await page.getByTestId('bot-profile-pane').evaluate((pane) => {
    const edge = pane.getBoundingClientRect().right + 0.5;
    return [...pane.querySelectorAll('*')].some((el) => (el as HTMLElement).getBoundingClientRect().right > edge);
  });
  expect(spill).toBe(false);
  await page.getByTestId('bot-job-back').click();
  await expect(page.getByTestId('bot-job-row')).toHaveCount(5);
});
