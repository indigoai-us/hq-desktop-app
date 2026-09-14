import { expect, test, type Page } from '@playwright/test';

const url = '/desktop-alt.html?window=desktop-alt&persona=indigo&loadingTest=1';
const readyTimeout = 20_000;

async function openSession(page: Page) {
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  await page.getByTestId('sessions-drawer-toggle').click();
  await page.getByTestId('session-live-row').first().click();
}

function conversationTitles(page: Page) {
  return page.locator('[data-testid="chat-conversation-list"] .chat-row-title');
}

async function waitForConversationRail(page: Page) {
  await expect(conversationTitles(page).first()).toBeVisible({ timeout: readyTimeout });
}

test('cold sidebar paints conversation rows without waiting for project sessions', async ({ page }) => {
  await page.goto(url);
  await waitForConversationRail(page);
  await expect(page.getByTestId('sidebar-loading')).toHaveCount(0);
});

test('avatar thumbnail survives reload and is immediately available when reopening', async ({ page }) => {
  await page.goto(url);
  await waitForConversationRail(page);
  await openSession(page);
  const avatar = page.getByTestId('session-starter').locator('img');
  await expect(avatar).toBeVisible();
  await expect.poll(() => avatar.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('hq.session-avatars.v1:') && localStorage.getItem(key)?.includes('data:image/png;base64,')))).toBe(true);
  await page.reload();
  await waitForConversationRail(page);
  const profileReads = await page.evaluate(() => (window as { profileReads?: number }).profileReads ?? 0);
  await openSession(page);
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute('src', /^data:image\/png;base64,/);
  expect(await page.evaluate(() => (window as { profileReads?: number }).profileReads ?? 0)).toBe(profileReads);
});
