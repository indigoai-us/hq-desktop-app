import { test, expect } from '@playwright/test';

for (const width of [1180, 800]) {
test(`desktop detection exposes recording controls at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 760 });
  await page.goto('/desktop-alt.html?window=desktop-alt&persona=indigo');
  await page.getByRole('button', { name: 'Meetings', exact: true }).click();
  const card = page.getByTestId('meetings-live-now');
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Start recording', exact: true })).toBeVisible();
  await card.getByLabel('Record as').selectOption('');
  await card.getByRole('button', { name: 'Start recording', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect(card).toHaveCount(0);
});
}
