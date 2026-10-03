import { expect, test, type Page } from '@playwright/test';

// The first-run company step inside the REAL welcome flow (OnboardingWizard,
// its .hq-welcome root, scenes, panel engine and welcome.css), not the
// standalone preview. `company=create` answers as a brand-new person;
// `companyDelay` makes the create-company card arrive late, as on a real
// network, so the step first shows "Getting things ready…" and then grows.
// step=2 starts on the first setup explainer with the install held running.
const flow = '/dev-harness/index.html?view=onboarding&step=2&company=create&companyDelay=700';

// 1024x686 is the test VM's work area (the welcome window fills it); the
// others are a common laptop size and a small display.
const SIZES = [
  { width: 1024, height: 686 },
  { width: 1440, height: 875 },
  { width: 800, height: 600 },
];

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} has no box`);
  return { left: found.x, right: found.x + found.width, top: found.y, bottom: found.y + found.height, width: found.width };
}

const centre = (b: Box) => (b.left + b.right) / 2;

async function next(page: Page): Promise<void> {
  // A real click: Playwright scrolls its target into view first, as keyboard
  // focus and the text caret do. That must not move the screen.
  await page.locator('.scene.on button.btn-primary', { hasText: 'Next' }).first().click();
}

async function rootScroll(page: Page): Promise<{ top: number; left: number }> {
  return page.evaluate(() => {
    const root = document.querySelector('.hq-welcome')!;
    return { top: root.scrollTop, left: root.scrollLeft };
  });
}

/** Everything on the screen shares the window's centre line, and the block fits, centred. */
async function expectCentred(page: Page, parts: string[], bottomSelector: string): Promise<void> {
  const viewport = page.viewportSize()!;
  expect(await rootScroll(page)).toEqual({ top: 0, left: 0 });
  const axis = viewport.width / 2;
  for (const selector of parts) {
    expect(Math.abs(centre(await box(page, selector)) - axis), selector).toBeLessThanOrEqual(1);
  }
  const panel = await box(page, '.scene.on .panel-block');
  const last = await box(page, bottomSelector);
  expect(panel.top).toBeGreaterThanOrEqual(0);
  expect(last.bottom).toBeLessThanOrEqual(viewport.height);
  // Vertically centred too (the panel is shorter than every size here).
  expect(Math.abs(panel.top - (viewport.height - panel.bottom))).toBeLessThanOrEqual(2);
}

async function buttonGroupCentre(page: Page, actions: string): Promise<number> {
  const buttons = page.locator(`${actions} .btn`);
  const first = (await buttons.first().boundingBox())!;
  const last = (await buttons.last().boundingBox())!;
  return (first.x + last.x + last.width) / 2;
}

test('the company step comes after the setup explainers and before "Open HQ Desktop"', async ({ page }) => {
  await page.setViewportSize(SIZES[0]!);
  await page.goto(flow);
  await expect(page.locator('.scene[data-scene="cloud"]')).toHaveClass(/\bon\b/);
  await next(page);
  await expect(page.locator('.scene[data-scene="shortcut"]')).toHaveClass(/\bon\b/);
  await next(page);
  await expect(page.getByRole('heading', { name: 'Name your company' })).toBeVisible();
  await expect(page.locator('.scene[data-scene="company"]')).toHaveClass(/\bon\b/);
  await expect(page.locator('.scene[data-scene="ready"]')).not.toHaveClass(/\bon\b/);
  await expect(page.getByRole('button', { name: 'Open HQ Desktop' })).toBeHidden();

  await page.getByTestId('onboarding-company-field-name').fill('Acme Studio');
  await page.getByTestId('onboarding-company-create').click();
  await page.getByTestId('onboarding-plan-continue').click();
  // Then the ready screen, with the install still running.
  await expect(page.locator('.scene[data-scene="ready"]')).toHaveClass(/\bon\b/);
});

for (const size of SIZES) {
  test(`centres "Name your company" and "Choose a plan" in the welcome window at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto(flow);
    await next(page);
    await next(page);
    await page.getByTestId('onboarding-company-field-name').waitFor();

    await expectCentred(
      page,
      ['.scene.on [data-scene-heading]', '.scene.on .follow-on > .body', 'form.company-form'],
      '[data-testid="onboarding-company-actions"]',
    );
    expect(Math.abs((await buttonGroupCentre(page, '[data-testid="onboarding-company-actions"]')) - size.width / 2)).toBeLessThanOrEqual(1);
    // The line under the heading is no wider than the form column.
    expect((await box(page, '.scene.on .follow-on > .body')).width).toBeLessThanOrEqual(
      (await box(page, 'form.company-form')).width,
    );

    // Typing and moving through the fields (focus, caret) leaves it in place.
    await page.getByTestId('onboarding-company-field-name').fill('Acme Studio');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expectCentred(
      page,
      ['.scene.on [data-scene-heading]', 'form.company-form'],
      '[data-testid="onboarding-company-actions"]',
    );

    await page.getByTestId('onboarding-company-create').click();
    await page.getByTestId('onboarding-plan-continue').waitFor();
    await expectCentred(
      page,
      [
        '.scene.on [data-scene-heading]',
        '.scene.on .follow-on > .body',
        '[data-testid="onboarding-plan-options"]',
        '[data-testid="onboarding-plan-continue"]',
      ],
      '[data-testid="onboarding-plan-continue"]',
    );
  });
}

test('stays centred when the welcome window is resized on the company step', async ({ page }) => {
  await page.setViewportSize(SIZES[0]!);
  await page.goto(flow);
  await next(page);
  await next(page);
  await page.getByTestId('onboarding-company-field-name').waitFor();
  for (const size of [SIZES[1]!, SIZES[2]!, SIZES[0]!]) {
    await page.setViewportSize(size);
    await expect
      .poll(async () => Math.abs(centre(await box(page, 'form.company-form')) - size.width / 2))
      .toBeLessThanOrEqual(1);
    await expectCentred(
      page,
      ['.scene.on [data-scene-heading]', '.scene.on .follow-on > .body', 'form.company-form'],
      '[data-testid="onboarding-company-actions"]',
    );
  }
});
