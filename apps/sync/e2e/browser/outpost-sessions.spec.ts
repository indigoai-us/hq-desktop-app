import { expect, test, type Page } from '@playwright/test';

// Preview harness with two sessions reported by the user's outpost
// (`?scenario=outpost-sessions`): "open PRs" is under Remote Control,
// "nightly backfill" is not.
const HARNESS = '/desktop-alt.html?window=desktop-alt&persona=indigo&scenario=outpost-sessions';
const OPEN_PRS_URL = 'https://claude.ai/code/session_01Ws49UWqv58e8poUSC6E4tu';

type HarnessWindow = Window & {
  __harnessShellOpens?: string[];
  __hqInvokeCounts?: Record<string, number>;
};

async function openSessionsDrawer(page: Page) {
  await page.goto(HARNESS);
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  await page.getByTestId('sessions-drawer-toggle').click();
  const drawer = page.getByRole('complementary', { name: 'Sessions', exact: true });
  await expect(drawer).toBeVisible();
  return drawer;
}

function shellOpens(page: Page) {
  return page.evaluate(() => (window as HarnessWindow).__harnessShellOpens ?? []);
}

function historyPageLoads(page: Page) {
  return page.evaluate(
    () => (window as HarnessWindow).__hqInvokeCounts?.agent_session_history_page ?? 0,
  );
}

test('an outpost Remote Control session is listed by its title and opens on claude.ai', async ({ page }) => {
  const drawer = await openSessionsDrawer(page);
  const row = drawer.getByTestId('session-resume').filter({ hasText: 'open PRs' });
  await expect(row).toBeVisible();
  const loadsBefore = await historyPageLoads(page);

  await row.click();

  await expect.poll(() => shellOpens(page)).toEqual([OPEN_PRS_URL]);
  // Its transcript lives on the box, so the app must not try to load it here.
  expect(await historyPageLoads(page)).toBe(loadsBefore);
  await expect(page.getByTestId('session-list-panel')).toHaveCount(0);
});

test('an outpost session without a Remote Control link is listed but never opens the browser', async ({ page }) => {
  const drawer = await openSessionsDrawer(page);
  const row = drawer.getByTestId('session-resume').filter({ hasText: 'nightly backfill' });
  await expect(row).toBeVisible();

  await row.click();

  // Give a wrongly-wired click-through the same chance to fire as the positive case.
  await expect.poll(() => historyPageLoads(page)).toBeGreaterThan(0);
  expect(await shellOpens(page)).toEqual([]);
});
