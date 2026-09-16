import { expect, test } from '@playwright/test';

// The scroller this used to drive was the session transcript, which went with
// the in-app Sessions subsystem. The rule it guards is not about sessions: the
// desktop document must never scroll or rubber-band, no matter which inner
// region the wheel is over. Repointed at the conversation thread -- the live
// shell's primary scroller, and the one a user hits this behaviour on.
test('desktop document contains overscroll while a conversation scrolls', async ({ page }) => {
  await page.goto('/desktop-alt.html?window=desktop-alt&persona=indigo');
  await expect(page.locator('.desktop-shell')).toBeVisible();
  // Use the production entry point: the old design harness imports legacy CSS
  // that masks missing document containment in the current native host.
  const boundary = await page.evaluate(() => ({
    root: getComputedStyle(document.documentElement).overscrollBehaviorY,
    rootOverflow: getComputedStyle(document.documentElement).overflowY,
    bodyOverflow: getComputedStyle(document.body).overflowY,
  }));
  expect(boundary).toEqual({root: 'none', rootOverflow: 'hidden', bodyOverflow: 'hidden'});

  const thread = page.getByTestId('conversation-thread');
  await expect(thread).toBeVisible();
  await page.setViewportSize({ width: 960, height: 600 });
  // Only a thread with more content than room exercises the boundaries.
  await expect
    .poll(() => thread.evaluate(el => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(0);

  const shell = page.locator('.desktop-shell');
  const before = await shell.boundingBox();
  // Exercise real wheel scrolling, including both scroll boundaries.
  await thread.evaluate(el => { el.scrollTop = 0; });
  await thread.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => thread.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.mouse.wheel(0, 10000);
  await page.mouse.wheel(0, -20000);
  await expect.poll(() => thread.evaluate(el => el.scrollTop)).toBe(0);
  await page.mouse.wheel(0, -10000);
  expect(await shell.boundingBox()).toEqual(before);
  expect(await page.evaluate(() => ({x: scrollX, y: scrollY}))).toEqual({x: 0, y: 0});
});
