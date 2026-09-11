import { expect, test } from '@playwright/test';

test('desktop document contains overscroll while the session transcript scrolls', async ({ page }) => {
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
  await page.getByRole('button', {name: 'New session', exact: true}).first().click();
  await page.getByTestId('sessions-drawer-toggle').click();
  await page.getByTestId('session-live-row').first().click();
  const transcript = page.getByTestId('session-transcript');
  await expect(transcript).toBeVisible();
  await page.setViewportSize({ width: 960, height: 600 });
  await page.getByRole('button', {name: /Ran 1 command/}).click();
  await expect.poll(() => transcript.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
  const shell = page.locator('.desktop-shell');
  const before = await shell.boundingBox();
  // Exercise real wheel scrolling, including both scroll boundaries.
  await transcript.evaluate(el => { el.scrollTop = 0; });
  await transcript.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => transcript.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.mouse.wheel(0, 10000);
  await page.mouse.wheel(0, -20000);
  await expect.poll(() => transcript.evaluate(el => el.scrollTop)).toBe(0);
  await page.mouse.wheel(0, -10000);
  expect(await shell.boundingBox()).toEqual(before);
  expect(await page.evaluate(() => ({x: scrollX, y: scrollY}))).toEqual({x: 0, y: 0});
});
