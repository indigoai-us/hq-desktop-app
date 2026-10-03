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
  await expect(page.getByTestId('onboarding-company-field-slug')).toHaveCount(0);
  await expect(page.getByText('Company handle')).toHaveCount(0);
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

type HarnessWindow = Window & { __companyStepCalls?: Array<{ command: string; args?: Record<string, unknown> }> };

test('takes the suggested handle by itself when the name is taken', async ({ page }) => {
  await page.goto(base);
  await page.getByTestId('onboarding-company-field-name').fill('Acme');
  await expect(page.getByTestId('onboarding-company-create')).toBeEnabled();
  await page.getByTestId('onboarding-company-create').click();
  await expect(page.getByTestId('onboarding-plan-starter')).toBeVisible();
  const values = await page.evaluate(() =>
    (window as HarnessWindow).__companyStepCalls?.find(
      (call) => call.command === 'run_card_action' && call.args?.cardId === 'card_create_company',
    )?.args?.values,
  );
  expect(values).toMatchObject({ name: 'Acme', slug: 'acme-hq' });
});

test('centers the company form, plan cards and buttons under the heading', async ({ page }) => {
  await page.goto(base);
  const centerOf = async (selector: string) => {
    const box = await page.locator(selector).first().boundingBox();
    if (!box) throw new Error(`${selector} has no box`);
    return box.x + box.width / 2;
  };
  await page.getByTestId('onboarding-company-field-name').fill('Acme Studio');
  const heading = await centerOf('[data-scene-heading]');
  expect(Math.abs((await centerOf('form.company-form')) - heading)).toBeLessThanOrEqual(1);
  const actions = page.getByTestId('onboarding-company-actions');
  const first = await actions.locator('.btn').first().boundingBox();
  const last = await actions.locator('.btn').last().boundingBox();
  // The button pair is centered as a group.
  expect(Math.abs((first!.x + last!.x + last!.width) / 2 - heading)).toBeLessThanOrEqual(1);

  await page.getByTestId('onboarding-company-create').click();
  await expect(page.getByTestId('onboarding-plan-starter')).toBeVisible();
  const planHeading = await centerOf('[data-scene-heading]');
  const formWidth = (await page.locator('[data-testid="onboarding-plan-options"]').boundingBox())!.width;
  expect(formWidth).toBeLessThanOrEqual(360);
  expect(Math.abs((await centerOf('[data-testid="onboarding-plan-options"]')) - planHeading)).toBeLessThanOrEqual(1);
  expect(Math.abs((await centerOf('[data-testid="onboarding-plan-continue"]')) - planHeading)).toBeLessThanOrEqual(1);
});

test('skips "Choose a plan" when a plan was already picked on the website', async ({ page }) => {
  await page.goto(`${base}&plan=starter`);
  await page.getByTestId('onboarding-company-field-name').fill('Acme Studio');
  await page.getByTestId('onboarding-company-create').click();
  await expect(page.getByTestId('company-preview-result')).toContainText('"plan":"starter"');
  await expect(page.getByText('Choose a plan')).toHaveCount(0);
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

test('offers "Use <company>" by default to someone who already has one', async ({ page }) => {
  await page.goto(`${base}&scenario=existing`);
  await expect(page.getByTestId('onboarding-company-use-existing')).toHaveText('Use Preview Co');
  await expect(page.getByText('Name your company')).toHaveCount(0);
  await page.getByTestId('onboarding-company-use-existing').click();
  await expect(page.getByTestId('company-preview-result')).toContainText('"outcome":"used_existing"');
});

test('never shows "Name your company" to an invited person', async ({ page }) => {
  await page.goto(`${base}&scenario=join`);
  await expect(page.getByTestId('onboarding-company-join')).toHaveText('Join Northwind');
  await expect(page.getByText('Name your company')).toHaveCount(0);
  await expect(page.getByTestId('onboarding-company-create-instead')).toHaveCount(0);
});

test('says the invite went to another email and offers to switch', async ({ page }) => {
  await page.goto(`${base}&scenario=other-email`);
  await page.getByTestId('onboarding-company-join').click();
  await expect(page.getByTestId('onboarding-company-invite-other-email')).toContainText(
    'Your invite was sent to a different email.',
  );
  await expect(page.getByTestId('onboarding-company-switch-account')).toBeVisible();
});

test('asks the inviter to resend an expired invite', async ({ page }) => {
  await page.goto(`${base}&scenario=expired`);
  await expect(page.getByTestId('onboarding-company-invite-expired')).toContainText('Ask Pat to resend it');
});

test('shows "Setting up your company…" until provisioning is ready', async ({ page }) => {
  await page.goto(`${base}&scenario=slow`);
  await page.getByTestId('onboarding-company-field-name').fill('Acme Studio');
  await page.getByTestId('onboarding-company-create').click();
  await expect(page.getByRole('heading', { name: 'Setting up your company…' })).toBeVisible();
  await expect(page.getByTestId('onboarding-plan-starter')).toBeVisible();
});

test('retries provisioning, not create, after a failed step', async ({ page }) => {
  await page.goto(`${base}&scenario=provisioning-failed`);
  await page.getByTestId('onboarding-company-field-name').fill('Acme Studio');
  await page.getByTestId('onboarding-company-create').click();
  await expect(page.getByTestId('onboarding-company-provisioning-failed')).toContainText('step: kms-create');
  await page.getByTestId('onboarding-company-provisioning-retry').click();
  await expect(page.getByTestId('onboarding-plan-starter')).toBeVisible();
  const calls = await page.evaluate(
    () => (window as Window & { __companyStepCalls?: Array<{ command: string; args?: { cardId?: string; url?: string } }> }).__companyStepCalls ?? [],
  );
  expect(calls.filter((call) => call.command === 'run_card_action' && call.args?.cardId === 'card_create_company')).toHaveLength(1);
  expect(calls.filter((call) => call.command === 'activate_company_cloud')).toHaveLength(2);
});

test('resumes a half-finished company at "Setting up…"', async ({ page }) => {
  await page.goto(`${base}&scenario=resume`);
  await expect(page.getByRole('heading', { name: 'Setting up your company…' })).toBeVisible();
  await expect(page.getByTestId('onboarding-plan-starter')).toBeVisible();
});

test('points to the company on another account before offering create', async ({ page }) => {
  await page.goto(`${base}&scenario=other-account`);
  await expect(page.getByTestId('onboarding-company-other-account')).toContainText('Your company Acme is on c•••@acme.com.');
  await page.getByTestId('onboarding-company-create-here').click();
  await expect(page.getByTestId('onboarding-company-field-name')).toBeVisible();
});

test('shows the upgrade prompt inline at the free plan limit', async ({ page }) => {
  await page.goto(`${base}&scenario=plan-limit`);
  await page.getByTestId('onboarding-company-field-name').fill('Second Co');
  await page.getByTestId('onboarding-company-create').click();
  await expect(page.getByTestId('onboarding-company-plan-limit')).toContainText('Starter includes one company.');
  await expect(page.getByTestId('onboarding-company-plan-upgrade')).toBeVisible();
  await expect(page.getByTestId('onboarding-company-error')).toHaveCount(0);
});
