import { expect, test } from '@playwright/test';

// The first-run company step, previewed through the design harness
// (?view=onboarding-company). The harness answers for the server in-page.
const base = '/dev-harness/index.html?view=onboarding-company';

test.use({ viewport: { width: 800, height: 900 } });

test('names a company, shows the usage card, signs up free, and finishes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(base);

  await page.getByTestId('onboarding-company-field-name').fill('Acme Studio');
  await expect(page.getByTestId('onboarding-company-field-slug')).toHaveCount(0);
  await expect(page.getByText('Company handle')).toHaveCount(0);
  await page.getByTestId('onboarding-company-create').click();

  // One card: $10 included, the rates, the $5 vault, $100 to $800 boxes, the trial cap. No Workforce.
  const card = page.getByTestId('onboarding-plan-card-free');
  await expect(card).toContainText('$10');
  await expect(card).toContainText('$0.10 per sync');
  await expect(card).toContainText('$5 per vault a month');
  await expect(card).toContainText('$100 to $800 a month');
  await expect(card).toContainText('30-day trial, usage capped at $500');
  await expect(page.locator('.plan-card')).toHaveCount(1);
  await expect(page.getByText('Workforce')).toHaveCount(0);
  await expect(page.getByTestId('onboarding-plan-enterprise')).toHaveText('Request an enterprise demo');
  await expect(page.getByTestId('onboarding-plan-self-hosted')).toHaveText('Use HQ free, self-hosted or on-prem');

  await page.getByTestId('onboarding-plan-choose-free').click();
  await page.getByTestId('onboarding-company-invite-input').fill('pat@acme.com');
  await page.getByTestId('onboarding-company-invite-send').click();
  await expect(page.getByTestId('onboarding-company-invite-row')).toHaveText('pat@acme.com');
  await expect(page.getByTestId('onboarding-company-ready')).toHaveText('Acme Studio is ready.');
  await page.getByTestId('onboarding-company-ready-continue').click();
  await expect(page.getByTestId('company-preview-result')).toContainText('"plan":"free"');
  expect(errors).toEqual([]);
});

test('opens the enterprise demo and the self-hosted guide in the browser', async ({ page }) => {
  await page.goto(base);
  await page.getByTestId('onboarding-company-field-name').fill('Acme Studio');
  await page.getByTestId('onboarding-company-create').click();
  await page.getByTestId('onboarding-plan-enterprise').click();
  await page.getByTestId('onboarding-plan-self-hosted').click();
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __harnessShellOpens?: string[] }).__harnessShellOpens))
    .toEqual(['https://hqforwork.com/call#book', 'https://docs.hq.computer/hq/guide/use-hq-for-free/']);
});

test('shows the bundled card when GET /v1/pricing cannot be read', async ({ page }) => {
  await page.goto(`${base}&pricing=offline`);
  await page.getByTestId('onboarding-company-field-name').fill('Acme Studio');
  await page.getByTestId('onboarding-company-create').click();
  await expect(page.getByTestId('onboarding-plan-card-free')).toContainText('$800');
  await expect(page.getByTestId('onboarding-plan-choose-free')).toHaveText('Sign up free');
});

type HarnessWindow = Window & { __companyStepCalls?: Array<{ command: string; args?: Record<string, unknown> }> };

test('takes the suggested handle by itself when the name is taken', async ({ page }) => {
  await page.goto(base);
  await page.getByTestId('onboarding-company-field-name').fill('Acme');
  await expect(page.getByTestId('onboarding-company-create')).toBeEnabled();
  await page.getByTestId('onboarding-company-create').click();
  await expect(page.getByTestId('onboarding-plan-choose-free')).toBeVisible();
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
  expect(Math.abs((await centerOf('form.cs-form')) - heading)).toBeLessThanOrEqual(1);
  const actions = page.getByTestId('onboarding-company-actions');
  const first = await actions.locator('.btn').first().boundingBox();
  const last = await actions.locator('.btn').last().boundingBox();
  // "Skip for now" stacks under "Create company": each button sits on the heading's centre line.
  expect(Math.abs(first!.x + first!.width / 2 - heading)).toBeLessThanOrEqual(1);
  expect(Math.abs(last!.x + last!.width / 2 - heading)).toBeLessThanOrEqual(1);

  await page.getByTestId('onboarding-company-create').click();
  await expect(page.getByTestId('onboarding-plan-choose-free')).toBeVisible();
  const planHeading = await centerOf('[data-scene-heading]');
  // The usage card sits on the heading's centre line.
  expect(Math.abs((await centerOf('[data-testid="onboarding-plan-options"]')) - planHeading)).toBeLessThanOrEqual(1);
  expect(Math.abs((await centerOf('.plan-custom')) - planHeading)).toBeLessThanOrEqual(1);
});

test('skips "Choose a plan" when a plan was already picked on the website', async ({ page }) => {
  await page.goto(`${base}&plan=free`);
  await page.getByTestId('onboarding-company-field-name').fill('Acme Studio');
  await page.getByTestId('onboarding-company-create').click();
  // Straight from create to the invite screen, then the ready screen.
  await expect(page.getByTestId('onboarding-company-invite-input')).toBeVisible();
  await expect(page.getByText('Choose how your HQ runs.')).toHaveCount(0);
  await page.getByTestId('onboarding-company-invite-skip').click();
  await page.getByTestId('onboarding-company-ready-continue').click();
  await expect(page.getByTestId('company-preview-result')).toContainText('"plan":"free"');
  await expect(page.getByText('Choose how your HQ runs.')).toHaveCount(0);
});

test('lets an invited person join', async ({ page }) => {
  await page.goto(`${base}&scenario=join`);
  await page.getByTestId('onboarding-company-join').click();
  await expect(page.getByTestId('company-preview-result')).toContainText('"outcome":"joined"');
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
  await expect(page.getByRole('heading', { name: 'Setting up Acme Studio' })).toBeVisible();
  await expect(page.getByTestId('onboarding-plan-choose-free')).toBeVisible();
});

test('retries provisioning, not create, after a failed step', async ({ page }) => {
  await page.goto(`${base}&scenario=provisioning-failed`);
  await page.getByTestId('onboarding-company-field-name').fill('Acme Studio');
  await page.getByTestId('onboarding-company-create').click();
  await expect(page.getByTestId('onboarding-company-provisioning-failed')).toContainText(
    'Acme Studio is saved, but setting it up did not finish.',
  );
  await page.getByTestId('onboarding-company-provisioning-retry').click();
  await expect(page.getByTestId('onboarding-plan-choose-free')).toBeVisible();
  const calls = await page.evaluate(
    () => (window as Window & { __companyStepCalls?: Array<{ command: string; args?: { cardId?: string; url?: string } }> }).__companyStepCalls ?? [],
  );
  expect(calls.filter((call) => call.command === 'run_card_action' && call.args?.cardId === 'card_create_company')).toHaveLength(1);
  expect(calls.filter((call) => call.command === 'activate_company_cloud')).toHaveLength(2);
});

test('resumes a half-finished company at "Setting up…"', async ({ page }) => {
  await page.goto(`${base}&scenario=resume`);
  await expect(page.getByRole('heading', { name: 'Setting up Preview Co' })).toBeVisible();
  await expect(page.getByTestId('onboarding-plan-choose-free')).toBeVisible();
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
