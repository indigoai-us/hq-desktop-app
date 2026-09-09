import { expect, test } from '@playwright/test';
const url = '/desktop-alt.html?window=desktop-alt&persona=indigo&loadingTest=1';
async function openSession(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  await page.getByTestId('sessions-drawer-toggle').click();
  await page.getByTestId('session-live-row').first().click();
}
test('cold sidebar stays a skeleton until project sessions are ready', async ({ page }) => {
  await page.goto(url);
  await expect(page.getByTestId('sidebar-loading')).toBeVisible();
  await expect(page.locator('[data-testid="chat-conversation-list"] .chat-row-title')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-loading')).toHaveCount(0);
  await expect(page.locator('[data-testid="chat-conversation-list"] .chat-row-title').first()).toBeVisible();
});
test('avatar thumbnail survives reload and is immediately available when reopening', async ({ page }) => {
  await page.goto(url);
  await expect(page.getByTestId('sidebar-loading')).toHaveCount(0);
  await openSession(page);
  const avatar = page.getByTestId('session-starter').locator('img');
  await expect(avatar).toBeVisible();
  await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('hq.session-avatars.v1:') && localStorage.getItem(key)?.includes('data:image/png;base64,')))).toBe(true);
  await page.reload();
  await expect(page.getByTestId('sidebar-loading')).toHaveCount(0);
  await expect(page.locator('[data-testid="chat-conversation-list"] .chat-row-title').first()).toBeVisible();
  const profileReads = await page.evaluate(() => (window as any).profileReads ?? 0);
  await openSession(page);
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute('src', /^data:image\/png;base64,/);
  expect(await page.evaluate(() => (window as any).profileReads ?? 0)).toBe(profileReads);
});
