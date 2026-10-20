import { expect, test } from '@playwright/test';

// The ready screen after a required setup step failed, previewed through the
// design harness. The harness fails the workspace step once, so Try again
// recovers it.
const base = '/dev-harness/index.html?view=onboarding&step=2&scenario=ready-required-failure';

test('names the failed step, offers Try again, and recovers to HQ is ready', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(base);

  await page.getByTestId('welcome-skip').click();
  const ready = page.locator('[data-scene="ready"]');
  const heading = ready.locator('[data-scene-heading]');
  await expect(heading).toHaveText('Setting up your workspace did not finish.');
  await expect(page.getByTestId('ready-required-retry')).toHaveText('Try again');
  await expect(ready).not.toContainText('keeps everything in sync');
  await expect(ready).not.toContainText('permission denied');

  await page.getByTestId('ready-required-retry').click();
  await expect(heading).toHaveText('HQ is ready.');
  await expect(page.getByTestId('ready-required-retry')).toHaveCount(0);
  await expect(ready).toContainText('keeps everything in sync');
  expect(errors).toEqual([]);
});
