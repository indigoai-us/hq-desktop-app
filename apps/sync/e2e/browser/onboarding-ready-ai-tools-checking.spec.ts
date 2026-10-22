import { expect, test } from '@playwright/test';

// Run 006 grid-0077: on a PC with no AI tools, the ready screen re-checks every
// few seconds and shows "Checking for AI tools on this PC" in the nav. The
// line under the nav was laid out for the shorter nav and the row drew over it.
// `toolsDelay` keeps each probe running long enough to see the row.
const flow =
  '/dev-harness/index.html?view=onboarding&step=2&scenario=tools-none&toolsDelay=2500';

test('the AI tools checking row never overlaps the line under it', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 686 });
  await page.goto(flow);
  await page.getByTestId('welcome-skip').click();
  const checking = page.getByTestId('onboarding-ai-tools-checking');
  await expect(checking).toBeVisible({ timeout: 20_000 });
  // Let the screen settle after the row arrives.
  await page.waitForTimeout(400);
  const row = await checking.boundingBox();
  const below = await page.locator('.scene.on .alt-block').boundingBox();
  if (!row || !below) throw new Error('no layout boxes');
  expect(row.y + row.height).toBeLessThanOrEqual(below.y + 1);
});
