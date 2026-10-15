import { expect, test } from '@playwright/test';

test('browse all routines without filters and search', async ({ page }, info) => {
  await page.goto('/?view=bot-management');
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await expect(page.getByTestId('routine-card')).toHaveCount(5);
  await expect(page.getByLabel('Routine schedule type')).toHaveCount(0);
  await expect(page.getByLabel('Routine status')).toHaveCount(0);
  await page.getByLabel('Search routines').fill('missing');
  await expect(page.getByText('No routines match your search.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('region', { name: 'Manage routines' }).scrollIntoViewIfNeeded();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('routines-desktop.png') });
});

test('create edit pause resume run and delete at narrow width', async ({ page }, info) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto('/?view=bot-management');
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await page.getByRole('button', { name: 'New routine', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Create routine' })).toBeDisabled();
  await dialog.getByLabel('Name', { exact: true }).fill('Review my tasks');
  await dialog.getByLabel('Instructions', { exact: true }).fill('Review tasks and summarize next steps.');
  await dialog.getByRole('button', { name: /^Schedule type:/ }).click();
  await dialog.getByRole('option', { name: 'Weekly', exact: true }).click();
  await dialog.getByRole('button', { name: /^Day:/ }).click();
  await dialog.getByRole('option', { name: 'Friday', exact: true }).click();
  await dialog.getByLabel('Time', { exact: true }).fill('15:30');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('routine-editor-narrow.png') });
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: 'Create routine' }).click();
  const row = page.getByTestId('routine-card').filter({ hasText: 'Review my tasks' });
  await expect(row).toBeVisible(); await row.click();
  await dialog.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Resume', exact: true }).click();
  await dialog.getByRole('button', { name: 'Run now', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm run' }).click();
  await expect(dialog.getByRole('status')).toContainText('Run requested');
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Review tasks weekly');
  await dialog.getByRole('button', { name: 'Save routine' }).click();
  await page.getByTestId('routine-card').filter({ hasText: 'Review tasks weekly' }).click();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('routine-card').filter({ hasText: 'Review tasks weekly' })).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(page.getByTestId('routine-card').filter({ hasText: 'Review tasks weekly' })).toHaveCount(0);
});

test('failed save keeps draft and failed pause keeps state', async ({ page }) => {
  await page.goto('/?view=bot-management&state=routine-error');
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await page.getByTestId('routine-card').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not complete');
  await expect(dialog.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Keep this draft');
  await dialog.getByRole('button', { name: 'Save routine' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not complete');
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Keep this draft');
});

test('interval and one-time editors preserve their schedule types', async ({ page }) => {
  await page.goto('/?view=bot-management');
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await page.getByTestId('routine-card').filter({ hasText: 'Check support inbox' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(dialog.getByRole('button', { name: /^Schedule type:/ })).toHaveAttribute('data-value', 'interval');
  await expect(dialog.getByLabel('Repeat every (minutes)')).toHaveValue('60');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByTestId('routine-card').filter({ hasText: 'Launch reminder' }).click();
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(dialog.getByRole('button', { name: /^Schedule type:/ })).toHaveAttribute('data-value', 'once');
  await expect(dialog.getByLabel('Run at')).not.toBeEmpty();
});


test('custom schedules stay intact without exposing technical fields', async ({ page }) => {
  await page.goto('/?view=bot-management');
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await page.getByTestId('routine-card').filter({ hasText: 'Weekday wrap-up' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Weekdays at 5:00 PM');
  await expect(dialog).not.toContainText('Expression');
  await expect(dialog).not.toContainText('0 17 * * 1-5');
  await expect(dialog).not.toContainText('API');
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Schedule type: Keep existing schedule' })).toBeVisible();
  await expect(dialog.getByLabel('Schedule expression')).toHaveCount(0);
  await dialog.getByLabel('Name', { exact: true }).fill('Evening wrap-up');
  await dialog.getByRole('button', { name: 'Save routine' }).click();
  await page.getByTestId('routine-card').filter({ hasText: 'Evening wrap-up' }).click();
  await dialog.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Schedule type: Keep existing schedule' })).toBeVisible();
});
