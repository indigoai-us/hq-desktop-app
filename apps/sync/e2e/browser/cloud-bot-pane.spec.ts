import { expect, test, type Page } from '@playwright/test';

/**
 * Cloud bot pane on the Bots page: the header, the four tabs from the one tab
 * list, no Pause/Resume, Open session, Stop or 30-day usage, and a routine
 * pop-up that Esc closes. Data comes from the harness control fixture.
 */

const SHELL = '/desktop-alt.html?window=desktop-alt&persona=indigo';

async function openCloudPane(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(SHELL);
  await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-testid="rail-company"]').first().click();
  await page.locator('[data-row-id="bots"]').first().click();
  await expect(page.getByTestId('cloud-bot-pane')).toHaveAttribute('data-state', 'ready');
}

test('cloud bots open the tabbed pane without the removed controls', async ({ page }) => {
  await openCloudPane(page);
  const pane = page.getByTestId('cloud-bot-pane');
  await expect(page.getByTestId('cloud-bot-title')).toHaveText('Research analyst');
  await expect(page.getByTestId('bot-profile-runtime-chip')).toHaveText('Cloud');
  await expect(page.getByTestId('cloud-bot-presence')).toHaveText('Online');
  await expect(pane.getByRole('tab')).toHaveText(['Channels', 'Routines', 'Persona', 'Brain']);
  for (const gone of ['bot-profile-pause', 'bot-profile-session', 'bot-profile-stop', 'bot-profile-usage']) {
    await expect(page.getByTestId(gone)).toHaveCount(0);
  }
  await expect(pane).not.toContainText('30d usage');
  await expect(page.getByTestId('cloud-channel-row')).toHaveCount(4);
  const spill = await pane.evaluate((el) => {
    const edge = el.getBoundingClientRect().right + 0.5;
    return [...el.querySelectorAll('*')].some((child) => (child as HTMLElement).getBoundingClientRect().right > edge);
  });
  expect(spill).toBe(false);
});

test('routines read in plain words and open in a pop-up that Esc closes', async ({ page }) => {
  await openCloudPane(page);
  await page.getByTestId('cloud-bot-tab-routines').click();
  await expect(page.getByTestId('cloud-routine-schedule').first()).toHaveText('Weekdays at 9:00');
  await page.getByTestId('cloud-routine-open').first().click();
  const dialog = page.getByTestId('cloud-routine-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('cloud-routine-name')).toHaveValue('Morning brief');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
