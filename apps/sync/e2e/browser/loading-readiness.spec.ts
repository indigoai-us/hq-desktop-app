import { expect, test, type Page } from '@playwright/test';

const url = '/desktop-alt.html?window=desktop-alt&persona=indigo&loadingTest=1';
const readyTimeout = 20_000;

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

// The session-avatar readiness test went with the in-app Sessions subsystem:
// it opened a live session and asserted its starter avatar was cached. There
// is no session surface left to reopen, and the avatar cache it guarded
// (hq.session-avatars.v1) went with it.
