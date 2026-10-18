import { expect, test } from '@playwright/test';

test('four tabs support keyboard navigation and retain bot details', async ({ page }) => {
  await page.goto('/?view=bot-management');
  const tabs = page.getByRole('tablist', { name: 'Bot management' }).getByRole('tab');
  await expect(tabs).toHaveText(['Channels', 'Routines', 'Apps', 'Brain']);
  await tabs.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(page.getByRole('button', { name: 'New routine', exact: true })).toBeVisible();
  await page.keyboard.press('End');
  await expect(tabs.last()).toBeFocused();
  await expect(page.getByRole('tabpanel')).toContainText('Current brain');
  await page.getByRole('button', { name: /Bot details/ }).click();
  await expect(page.getByRole('textbox', { name: 'Bot name', exact: true })).toHaveValue('Scout');
  await page.getByText('Activity, runtime & access', { exact: true }).click();
  await expect(page.getByTestId('bot-profile-copy-uid')).toBeVisible();
  await page.getByRole('button', { name: /Bot details/ }).click();
  await expect(page.getByTestId('bot-profile-copy-uid')).toBeHidden();
});

for (const width of [360, 1440]) {
  test(`tabs and content fit at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?view=bot-management');
    const detailsBox = await page.getByRole('button', { name: /Bot details/ }).boundingBox();
    const tabsBox = await page.getByRole('tablist', { name: 'Bot management' }).boundingBox();
    const paneBox = await page.getByTestId('bot-profile-pane').boundingBox();
    expect(detailsBox!.y + detailsBox!.height).toBeLessThan(tabsBox!.y);
    expect(detailsBox!.x).toBeGreaterThan(paneBox!.x + paneBox!.width / 2);
    for (const name of ['Channels', 'Routines', 'Apps', 'Brain']) {
      await page.getByRole('tab', { name, exact: true }).click();
      await expect(page.getByRole('tabpanel')).toBeVisible();
      const fits = await page.getByTestId('bot-profile-pane').evaluate(el =>
        el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= window.innerWidth);
      expect(fits).toBe(true);
    }
    await page.getByRole('tab', { name: 'Channels', exact: true }).click();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`bot-management-${width}.png`) });
  });
}

test('routine loading and failure do not pretend there are no routines', async ({ page }) => {
  await page.goto('/?view=bot-management&state=loading-routines');
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await expect(page.getByTestId('bot-jobs-loading')).toBeVisible();
  await expect(page.getByTestId('bot-jobs-empty')).toHaveCount(0);
  await page.goto('/?view=bot-management&state=error');
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await expect(page.getByTestId('bot-jobs-unavailable')).toContainText('Could not load routines');
  await expect(page.getByTestId('bot-jobs-empty')).toHaveCount(0);
});

test('details edit, validate, preserve drafts, and save the bot profile', async ({ page }, testInfo) => {
  await page.goto('/?view=bot-management');
  await expect(page.getByTestId('bot-profile-message')).toHaveCount(0);
  await expect(page.getByTestId('bot-profile-session')).toHaveCount(0);
  const details = page.getByRole('button', { name: /Bot details/ });
  await details.click();
  const name = page.getByRole('textbox', { name: 'Bot name', exact: true });
  await expect(name).toHaveValue('Scout');
  await expect(page.getByRole('textbox', { name: 'Role / title' })).toHaveValue('Research assistant');
  await name.fill('');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await name.fill('Atlas');
  await page.getByRole('textbox', { name: 'Purpose', exact: true }).fill('Research and write team briefs.');
  await details.click();
  await details.click();
  await expect(name).toHaveValue('Atlas');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Changes saved', { exact: true })).toBeVisible();
  await expect(page.locator('.identity .nm')).toHaveText('Atlas');
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('bot-details-editor.png') });
});

test('failed save keeps edits available to retry', async ({ page }) => {
  await page.goto('/?view=bot-management&state=save-error');
  await page.getByRole('button', { name: /Bot details/ }).click();
  const name = page.getByRole('textbox', { name: 'Bot name', exact: true });
  await expect(name).toHaveValue('Scout');
  await name.fill('Atlas');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not save changes');
  await expect(name).toHaveValue('Atlas');
  await expect(page.locator('.identity .nm')).toHaveText('Scout');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(name).toHaveValue('Scout');
});
