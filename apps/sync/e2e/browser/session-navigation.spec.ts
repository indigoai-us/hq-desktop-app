import { expect, test } from '@playwright/test';

test('resizes and remembers the primary sidebar; keyboard and reset work', async ({ page }) => {
  await page.goto('/desktop-alt.html?window=desktop-alt&persona=indigo');
  const sidebar = page.locator('.chat-sidebar');
  const handle = page.getByRole('separator', { name: 'Resize sidebar' });
  await expect(handle).toBeVisible();
  const initial = (await sidebar.boundingBox())!.width;
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 80, box.y + 100); await page.mouse.up();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(initial + 80, 0);
  await page.reload();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeCloseTo(initial + 80, 0);
  await handle.focus(); await page.keyboard.press('Home');
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(220);
  await handle.dblclick();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(260);
});

test('drawer slides both ways and the reopened session retains context and provenance', async ({ page }) => {
  await page.goto('/desktop-alt.html?window=desktop-alt&persona=indigo');
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  await page.getByTestId('sessions-drawer-toggle').click();
  const drawer = page.getByRole('complementary', { name: 'Sessions', exact: true });
  await expect(drawer).toBeVisible();
  await expect.poll(() => drawer.evaluate(el => getComputedStyle(el).transform)).toBe('none');
  await page.getByRole('button', { name: 'Close sessions sidebar' }).click();
  await expect(page.getByTestId('session-list-panel')).toHaveCount(0);
  await page.getByTestId('sessions-drawer-toggle').click();
  await page.getByTestId('session-live-row').first().click();
  await expect(page.getByTestId('session-starter')).toHaveText('Started by alex@example.test');
  await expect(page.getByTestId('session-transcript')).toContainText('Inherited planning context');
  await expect(page.getByTestId('sessions-new')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  await page.getByTestId('sessions-drawer-toggle').click();
  await page.getByTestId('session-live-row').first().click();
  await expect(page.getByTestId('session-transcript')).toContainText('Inherited planning context');
  await expect(page.getByTestId('session-starter')).toHaveText('Started by alex@example.test');
  await page.getByTestId('session-source').click();
  await expect(page.getByTestId('session-transcript')).toContainText('Original planning session history');
});
