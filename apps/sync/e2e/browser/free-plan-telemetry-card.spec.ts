import { expect, test, type Page } from '@playwright/test';

// Free-plan usage data card: the primary action must be inside the window at
// 390 wide and at desktop width, on the launch card (reprompt run, person
// opted out earlier) and on the first-run Ready screen. Screenshots go to the
// FREE_CARD_SHOTS directory when it is set, for the PR record.

const SHOTS = process.env.FREE_CARD_SHOTS;

const SCREENS = [
  {
    name: 'launch-card',
    url: '/dev-harness/index.html?view=onboarding&mode=reprompt&step=6&notice=pending&optedout=1',
    ready: 'disclosure-summary',
    button: 'disclosure-continue',
  },
  {
    name: 'ready',
    url: '/dev-harness/index.html?view=onboarding&step=8&notice=pending',
    ready: 'ready-consent',
    button: 'disclosure-continue',
  },
] as const;

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

async function expectInsideViewport(page: Page, testId: string, height: number) {
  const button = page.getByTestId(testId).first();
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box, `${testId} has a box`).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `${testId} bottom inside ${height}px`).toBeLessThanOrEqual(height);
}

for (const screen of SCREENS) {
  for (const vp of VIEWPORTS) {
    test(`${screen.name}: primary action visible without scrolling at ${vp.width}px`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize(vp);
      await page.goto(screen.url);
      await expect(page.getByTestId(screen.ready).first()).toBeVisible();
      await page.waitForTimeout(600);
      if (screen.name === 'launch-card') {
        await expect(page.getByTestId('disclosure-opted-out')).toBeVisible();
        await expect(page.getByTestId('disclosure-add-card')).toHaveText('Upgrade to turn it off');
      }
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/${screen.name}-${vp.width}.png` });
      await expectInsideViewport(page, screen.button, vp.height);
    });
  }
}
