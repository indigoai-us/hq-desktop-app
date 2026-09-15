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

test('title-bar Back/Forward sit next to the date on the real shell', async ({ page }) => {
  await page.goto('/desktop-alt.html?window=desktop-alt&persona=indigo');
  const date = page.getByTestId('titlebar-day-date');
  const history = page.getByTestId('titlebar-history');
  await expect(date).toBeVisible();
  await expect(history).toBeVisible();
  await expect(page.getByTestId('titlebar-back')).toHaveAttribute('aria-label', 'Back');
  await expect(page.getByTestId('titlebar-forward')).toHaveAttribute('aria-label', 'Forward');
  const dateBox = (await date.boundingBox())!;
  const historyBox = (await history.boundingBox())!;
  expect(historyBox.x).toBeGreaterThan(dateBox.x);
  expect(Math.abs(historyBox.y - dateBox.y)).toBeLessThan(16);
  expect(await history.getAttribute('data-tauri-drag-region')).toBe('false');
});

// Four session-navigation tests went with the in-app Sessions subsystem: the
// drawer slide, back/forward across sessions, the unsent-draft survival, and
// the keyboard channel -> session -> source retrace. The two tests kept here
// never touched a session -- they cover the sidebar resize and the title-bar
// history controls, which both still ship.
