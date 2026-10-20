import { expect, test, type Page } from '@playwright/test';

// A returning account on a new Mac (US-023), previewed through the design
// harness. The harness answers /membership/me with two active companies and
// reports each scoped pull as finished, so the real welcome flow runs end to
// end against a fake network.
const returning = '/dev-harness/index.html?view=onboarding&step=2&account=returning';
const brandNew = '/dev-harness/index.html?view=onboarding&step=2&company=create';

test.use({ viewport: { width: 800, height: 900 } });

type HarnessWindow = Window & { __hqStartSyncSlugs?: Array<string | null> };

/** Next, Next from the cloud screen: past the shortcut screen to whatever comes after it. */
async function walkPastShortcut(page: Page): Promise<void> {
  await page.getByTestId('welcome-cloud').getByRole('button', { name: 'Next' }).click();
  await page.getByTestId('welcome-shortcut').getByRole('button', { name: 'Next' }).click();
}

function startedPulls(page: Page): Promise<Array<string | null>> {
  return page.evaluate(() => (window as HarnessWindow).__hqStartSyncSlugs ?? []);
}

test('brings both companies to this Mac with returning wording and no create prompt', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(returning);
  await walkPastShortcut(page);

  const pull = page.getByTestId('company-pull');
  await expect(pull).toContainText('Bringing your companies to this Mac');
  const rows = pull.getByTestId('company-pull-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-company', 'acme');
  await expect(rows.nth(1)).toHaveAttribute('data-company', 'globex');

  await expect(rows.nth(0)).toHaveAttribute('data-status', 'done');
  await expect(rows.nth(1)).toHaveAttribute('data-status', 'done');
  await expect(rows.nth(0)).toContainText('Ready');
  await expect(rows.nth(1)).toContainText('Ready');
  await expect(page.locator('#onboarding-title-ready')).toHaveText('Welcome back. Acme and Globex are on this Mac.');
  expect(await startedPulls(page)).toEqual(['acme', 'globex']);

  await expect(page.getByTestId('onboarding-company-field-name')).toHaveCount(0);
  await expect(page.getByText('Name your company')).toHaveCount(0);
  await expect(page.getByText('Name your assistant')).toHaveCount(0);
  await expect(page.getByText('Bring in your context')).toHaveCount(0);
  await expect(page.getByTestId('company-pull-retry')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a failed company pull offers Try again and Ready is not shown as done until it lands', async ({ page }) => {
  await page.goto(`${returning}&pullFail=globex`);
  await page.getByTestId('welcome-skip').click();

  const rows = page.getByTestId('company-pull-row');
  await expect(rows.nth(1)).toHaveAttribute('data-status', 'failed');
  await expect(rows.nth(1)).toContainText("Couldn't pull Globex");
  await expect(rows.nth(0)).toHaveAttribute('data-status', 'done');
  const heading = page.locator('#onboarding-title-ready');
  await expect(heading).not.toHaveText(/are on this Mac|is on this Mac|HQ is ready/);

  await page.getByTestId('company-pull-retry').click();
  await expect(rows.nth(1)).toHaveAttribute('data-status', 'done');
  await expect(heading).toHaveText('Welcome back. Acme and Globex are on this Mac.');
  expect(await startedPulls(page)).toEqual(['acme', 'globex', 'globex']);
});

// The welcome window mounts no company step; a brand-new person is offered
// a company on the desktop afterwards, as before this change.
test('a brand-new account sees the unchanged ready screen with no pull and no returning wording', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(brandNew);
  await walkPastShortcut(page);

  await expect(page.locator('#onboarding-title-ready')).toHaveText('HQ is ready.');
  await expect(page.getByTestId('account-lookup-error')).toHaveCount(0);
  await expect(page.getByTestId('company-pull')).toHaveCount(0);
  await expect(page.getByText('Welcome back')).toHaveCount(0);
  expect(await startedPulls(page)).toEqual([]);
  expect(errors).toEqual([]);
});
