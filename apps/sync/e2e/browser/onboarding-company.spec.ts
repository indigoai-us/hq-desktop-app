import { expect, test } from '@playwright/test';

// The first-run company step, previewed through the design harness
// (?view=onboarding-company). The harness answers for the server in-page.
const base = '/dev-harness/index.html?view=onboarding-company';

test.use({ viewport: { width: 800, height: 900 } });

test('names a company, picks Workforce, opens checkout, and finishes on the return', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(base);

  await page.getByTestId('onboarding-company-field-name').fill('Acme Studio');
  await expect(page.getByTestId('onboarding-company-field-slug')).toHaveValue('acme-studio');
  await expect(page.getByText('acme-studio is available.')).toBeVisible();
  await page.getByTestId('onboarding-company-invites').fill('pat@acme.com');
  await page.getByTestId('onboarding-company-create').click();

  await page.getByTestId('onboarding-plan-workforce').check();
  await page.getByTestId('onboarding-plan-continue').click();
  await expect(page.getByRole('heading', { name: 'Finish checkout in your browser' })).toBeVisible();
  expect(await page.evaluate(() => (window as Window & { __harnessShellOpens?: string[] }).__harnessShellOpens)).toEqual([
    'https://checkout.stripe.com/c/pay/cs_preview',
  ]);

  await page.getByTestId('company-preview-return').click();
  await expect(page.getByTestId('company-preview-result')).toContainText('"paid":true');
  expect(errors).toEqual([]);
});

test('offers a suggestion when the handle is taken', async ({ page }) => {
  await page.goto(base);
  await page.getByTestId('onboarding-company-field-name').fill('Acme');
  await expect(page.getByRole('button', { name: 'Use acme-hq' })).toBeVisible();
  await page.getByRole('button', { name: 'Use acme-hq' }).click();
  await expect(page.getByTestId('onboarding-company-field-slug')).toHaveValue('acme-hq');
});

test('lets an invited person join', async ({ page }) => {
  await page.goto(`${base}&scenario=join`);
  await page.getByTestId('onboarding-company-join').click();
  await expect(page.getByTestId('company-preview-result')).toContainText('"outcome":"joined"');
});

test('explains a paused Workforce checkout in plain words', async ({ page }) => {
  await page.goto(`${base}&scenario=paused`);
  await page.getByTestId('onboarding-company-field-name').fill('Acme Studio');
  await page.getByTestId('onboarding-company-create').click();
  await page.getByTestId('onboarding-plan-workforce').check();
  await page.getByTestId('onboarding-plan-continue').click();
  await expect(page.getByTestId('onboarding-company-error')).toContainText('Workforce sign-up is paused');
});
