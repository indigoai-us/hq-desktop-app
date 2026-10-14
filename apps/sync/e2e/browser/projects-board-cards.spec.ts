import { expect, test, type Page } from '@playwright/test';

/**
 * Projects page: Complete is hidden by default and comes back from the rail
 * where its column was; cards carry repo chips and a stories line; the title
 * sits on the same line as the Activity title.
 */

const SHELL = '/desktop-alt.html?window=desktop-alt&persona=indigo';

async function openCompanyPage(page: Page, row: string): Promise<void> {
  await page.locator('[data-testid="rail-company"]').first().click();
  await page.locator(`[data-row-id="${row}"]`).first().click();
}

async function titleTop(page: Page, selector: string): Promise<number> {
  const el = page.locator(selector).first();
  await expect(el).toBeVisible();
  return el.evaluate((node) => node.getBoundingClientRect().top);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(SHELL);
  await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => localStorage.removeItem('hq.projects.showComplete'));
});

test('Complete is hidden by default and Show N complete brings it back', async ({ page }) => {
  await openCompanyPage(page, 'projects');
  await expect(page.getByTestId('portfolio-kanban')).toBeVisible();
  await expect(page.getByTestId('portfolio-column-complete')).toHaveCount(0);
  const show = page.getByTestId('show-complete');
  await expect(show).toHaveText(/^Show \d+ complete$/);
  await show.click();
  await expect(page.getByTestId('portfolio-column-complete')).toBeVisible();
  await page.getByTestId('hide-complete').click();
  await expect(page.getByTestId('portfolio-column-complete')).toHaveCount(0);
});

test('cards show repo chips and an N of M stories line', async ({ page }) => {
  await openCompanyPage(page, 'projects');
  const card = page.getByTestId('project-row').filter({ hasText: 'Event-driven HQ-Cloud sync' });
  await expect(card.getByTestId('project-repo-chips')).toContainText('hq-pro');
  await expect(card.getByTestId('project-branch')).toContainText('feature/iot-push');
  await expect(card.getByTestId('project-stories')).toHaveText('3 of 8 stories');
  await expect(card.getByTestId('project-updated')).toHaveText(/^updated /);
});

test('the Projects title sits on the same line as the Activity title', async ({ page }) => {
  await openCompanyPage(page, 'activity');
  const activity = await titleTop(page, '[data-testid="activity-view"] h1');
  await openCompanyPage(page, 'projects');
  const projects = await titleTop(page, '#company-projects-title');
  expect(Math.abs(projects - activity), `projects ${projects} vs activity ${activity}`).toBeLessThanOrEqual(1.5);
});
