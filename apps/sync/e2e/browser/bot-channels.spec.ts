import { expect, test } from '@playwright/test';

test('default channels connect, browse and disconnect with confirmation', async ({ page }, testInfo) => {
  await page.goto('/?view=bot-management');
  for (const id of ['slack', 'telegram']) await expect(page.getByTestId(`channel-${id}`)).toBeVisible();
  await expect(page.getByTestId('channel-slack')).toContainText('Connected');
  await page.getByTestId('channel-telegram').getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Connect Telegram' }).click();
  await expect(page.getByTestId('channel-telegram').getByRole('button', { name: 'Manage' })).toBeVisible();
  await page.getByRole('button', { name: 'Browse channels' }).click();
  await page.getByRole('textbox', { name: 'Search supported channels' }).fill('Discord');
  await page.getByRole('region', { name: 'Supported channels' }).getByRole('button', { name: /Discord/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Connect Discord' }).click();
  await expect(page.getByTestId('channel-discord')).toContainText('Connected');
  await page.getByTestId('channel-telegram').getByRole('button', { name: 'Manage' }).click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByTestId('channel-telegram')).toContainText('Connected');
  await page.getByRole('button', { name: 'Confirm disconnect' }).click();
  await expect(page.getByRole('dialog')).toContainText('Not connected');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search supported channels' }).fill('no-such-channel');
  await expect(page.getByText(/No channels match/)).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('channel-browser.png') });
});

test('failed connection stays disconnected and can retry', async ({ page }) => {
  await page.goto('/?view=bot-management&state=channel-error');
  await page.getByTestId('channel-telegram').getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('button', { name: 'Connect Telegram' }).click();
  await expect(page.getByRole('alert')).toContainText('Could not start');
  await expect(page.getByTestId('channel-telegram')).toContainText('Not connected');
  await expect(page.getByRole('button', { name: 'Connect Telegram' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
