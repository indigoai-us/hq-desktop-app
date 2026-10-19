import { expect, test } from '@playwright/test';

test('connect a provider then choose and activate a model explicitly', async ({ page }, info) => {
  await page.goto('/?view=bot-management');
  await page.getByRole('tab', { name: 'Brain', exact: true }).click();
  for (const id of ['codex','claude','grok']) {
    await expect(page.getByTestId(`brain-${id}`)).toBeVisible();
    await expect(page.getByTestId(`brain-${id}`).locator('[data-rail-icon="' + (id === 'claude' ? 'claude-code' : id) + '"]')).toBeVisible();
  }
  await page.getByTestId('brain-codex').getByRole('button').click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Activate model' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Connect OpenAI' }).click();
  await expect(page.getByTestId('brain-codex')).toContainText('Connected');
  await expect(page.getByTestId('brain-claude')).toContainText('Current');
  await page.getByTestId('brain-codex').getByRole('button').click();
  await dialog.getByRole('button', { name: /^Model:/ }).click();
  await dialog.locator('[role=option][data-value="gpt-6-astra"]').click();
  await dialog.getByRole('button', { name: /^Thinking level:/ }).click();
  await dialog.locator('[role=option][data-value="high"]').click();
  await dialog.getByRole('button', { name: 'Activate model' }).click();
  await expect(page.getByTestId('brain-codex')).toContainText('Current');
  await expect(page.getByTestId('brain-claude')).not.toContainText('Current');
  await page.getByRole('region', { name: 'Manage brain' }).scrollIntoViewIfNeeded();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('brain-providers.png') });
});

test('failed changes preserve selection and narrow editor fits', async ({ page }, info) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto('/?view=bot-management&state=brain-error');
  await page.getByRole('tab', { name: 'Brain', exact: true }).click();
  await page.getByTestId('brain-claude').getByRole('button').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /^Model:/ }).click();
  await dialog.locator('[role=option][data-value="claude-opus-5"]').click();
  await dialog.getByRole('button', { name: 'Save configuration' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not save');
  await expect(dialog.getByRole('button', { name: /^Model:/ })).toHaveAttribute('data-value', 'claude-opus-5');
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await page.screenshot({ animations: 'disabled', path: info.outputPath('brain-settings-narrow.png') });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
});

for (const height of [600, 900]) test(`dropdowns stay inside the dialog at height ${height}`, async ({ page }) => {
  await page.setViewportSize({ width: 720, height });
  await page.goto('/?view=bot-management');
  await page.getByRole('tab', { name: 'Brain', exact: true }).click();
  await page.getByTestId('brain-claude').getByRole('button').click();
  const dialog = page.getByRole('dialog');
  for (const label of ['Model', 'Thinking level']) {
    const trigger = dialog.getByRole('button', { name: new RegExp('^' + label + ':') });
    await trigger.scrollIntoViewIfNeeded();
    const scroll = await dialog.evaluate(el => el.scrollTop);
    await trigger.click();
    const list = dialog.getByRole('listbox', { name: label, exact: true });
    await expect(list).toBeVisible();
    expect(await list.evaluate(el => {
      const r = el.getBoundingClientRect(), d = el.closest('[role=dialog]')!.getBoundingClientRect();
      return r.top >= d.top && r.bottom <= d.bottom && r.left >= d.left && r.right <= d.right;
    })).toBe(true);
    await page.keyboard.press('End');
    expect(await dialog.evaluate(el => el.scrollTop)).toBe(scroll);
    await page.keyboard.press('Enter');
    await expect(list).toHaveCount(0);
    await expect(dialog).toBeVisible();
  }
});
