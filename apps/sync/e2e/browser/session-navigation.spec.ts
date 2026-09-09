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
  await expect(page.getByTestId('session-starter')).toHaveAttribute('aria-label', 'Started by alex@example.test');
  await expect(page.getByTestId('session-transcript')).toContainText('Inherited planning context');
  await expect(page.getByTestId('sessions-new')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  await page.getByTestId('sessions-drawer-toggle').click();
  await page.getByTestId('session-live-row').first().click();
  await expect(page.getByTestId('session-transcript')).toContainText('Inherited planning context');
  await expect(page.getByTestId('session-starter')).toHaveAttribute('aria-label', 'Started by alex@example.test');
  await page.getByTestId('session-starter').hover();
  await expect(page.getByRole('tooltip')).toContainText('alex@example.test');
  expect((await page.getByTestId('sessions-strip').boundingBox())!.height).toBeLessThanOrEqual(40);
  await page.getByTestId('session-source').click();
  await expect(page.getByTestId('session-transcript')).toContainText('Original planning session history');
});

test('back and forward restore sessions without start or send', async ({ page }) => {
  await page.goto('/desktop-alt.html?window=desktop-alt&persona=indigo');
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  await page.getByTestId('sessions-drawer-toggle').click();
  await page.getByTestId('session-live-row').first().click();
  await expect(page.getByTestId('session-transcript')).toContainText('Inherited planning context');
  await page.getByTestId('session-source').click();
  await expect(page.getByTestId('session-transcript')).toContainText('Original planning session history');

  const before = await page.evaluate(() => (window as Window & { __hqInvokeCounts?: Record<string, number> }).__hqInvokeCounts ?? {});
  await page.getByTestId('titlebar-back').click();
  await expect(page.getByTestId('session-transcript')).toContainText('Inherited planning context');
  await page.getByTestId('titlebar-forward').click();
  await expect(page.getByTestId('session-transcript')).toContainText('Original planning session history');
  const after = await page.evaluate(() => (window as Window & { __hqInvokeCounts?: Record<string, number> }).__hqInvokeCounts ?? {});
  expect(after.agent_session_start ?? 0).toBe(before.agent_session_start ?? 0);
  expect(after.agent_session_send ?? 0).toBe(before.agent_session_send ?? 0);
});

test('unsent draft text survives leaving and returning via Back', async ({ page }) => {
  await page.goto('/desktop-alt.html?window=desktop-alt&persona=indigo');
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  const composer = page.getByTestId('session-composer-input');
  await composer.fill('keep this draft through back');
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  await page.getByTestId('titlebar-back').click();
  await expect(page.getByTestId('session-composer-input')).toHaveValue('keep this draft through back');
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

test('keyboard retraces channel → session → source without send; editor keeps the chord', async ({ page }) => {
  await page.goto('/desktop-alt.html?window=desktop-alt&persona=indigo');
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  await page.getByTestId('sessions-drawer-toggle').click();
  await page.getByTestId('session-live-row').first().click();
  await expect(page.getByTestId('session-transcript')).toContainText('Inherited planning context');
  await page.getByTestId('session-source').click();
  await expect(page.getByTestId('session-transcript')).toContainText('Original planning session history');

  const before = await page.evaluate(() => (window as Window & { __hqInvokeCounts?: Record<string, number> }).__hqInvokeCounts ?? {});
  await page.getByTestId('titlebar-day-date').click();
  await page.evaluate(() => document.documentElement.setAttribute('data-platform', 'macos'));
  const backStarted = await page.evaluate(() => performance.now());
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: '[', code: 'BracketLeft', metaKey: true, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.getByTestId('session-transcript')).toContainText('Inherited planning context');
  const backMs = await page.evaluate((started) => performance.now() - started, backStarted);
  const forwardStarted = await page.evaluate(() => performance.now());
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: ']', code: 'BracketRight', metaKey: true, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.getByTestId('session-transcript')).toContainText('Original planning session history');
  const forwardMs = await page.evaluate((started) => performance.now() - started, forwardStarted);
  console.log(`NAV_LATENCY_BACK_MS=${backMs.toFixed(1)}`);
  console.log(`NAV_LATENCY_FORWARD_MS=${forwardMs.toFixed(1)}`);
  expect(backMs).toBeLessThan(2_000);
  expect(forwardMs).toBeLessThan(2_000);

  await page.evaluate(() => document.documentElement.setAttribute('data-platform', 'windows'));
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.getByTestId('session-transcript')).toContainText('Inherited planning context');
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.getByTestId('session-transcript')).toContainText('Original planning session history');

  const composer = page.getByTestId('session-composer-input');
  await composer.click();
  await composer.evaluate((el) => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: '[', code: 'BracketLeft', metaKey: true, bubbles: true, cancelable: true }),
    );
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.getByTestId('session-transcript')).toContainText('Original planning session history');

  const after = await page.evaluate(() => (window as Window & { __hqInvokeCounts?: Record<string, number> }).__hqInvokeCounts ?? {});
  expect(after.agent_session_start ?? 0).toBe(before.agent_session_start ?? 0);
  expect(after.agent_session_send ?? 0).toBe(before.agent_session_send ?? 0);
});
