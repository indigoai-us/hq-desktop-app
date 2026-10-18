import { expect, test } from '@playwright/test';

test('browse connect and explicitly grant or remove bot access', async ({ page }, info) => {
  await page.goto('/?view=bot-management');
  await page.getByRole('tab', { name: 'Apps', exact: true }).click();
  await expect(page.getByTestId('bot-app')).toHaveCount(4);
  await page.getByRole('button', { name: 'Browse apps', exact: true }).click();
  await expect(page.getByTestId('catalog-app')).toHaveCount(3);
  await page.getByRole('textbox', { name: 'Search supported apps' }).fill('Drive');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByTestId('catalog-app')).toHaveCount(1);
  await page.getByTestId('catalog-app').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Sign in securely');
  await dialog.getByRole('button', { name: 'Connect app', exact: true }).click();
  const drive = page.getByTestId('bot-app').filter({ hasText: 'Google Drive' });
  await expect(drive).toContainText('Company connection');
  await drive.click();
  await dialog.getByRole('button', { name: 'Add to bot', exact: true }).click();
  await expect(dialog).toContainText('Available to bot');
  await dialog.getByRole('button', { name: 'Remove bot access', exact: true }).click();
  await expect(drive).toContainText('Available to bot');
  await dialog.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect(dialog).toContainText('Company connection');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'App status: All statuses', exact: true }).click();
  await page.getByRole('option', { name: 'Needs attention', exact: true }).click();
  await expect(page.getByTestId('bot-app')).toHaveCount(1);
  await expect(page.getByTestId('bot-app')).toContainText('Figma');
  await page.getByRole('button', { name: 'App status: Needs attention', exact: true }).click();
  await page.getByRole('option', { name: 'All statuses', exact: true }).click();
  await page.getByRole('button', { name: 'Browse apps', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Browse apps', exact: true })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('apps-catalog.png') });
});

test('locked apps remain read-only and the narrow layout fits', async ({ page }, info) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto('/?view=bot-management');
  await page.getByRole('tab', { name: 'Apps', exact: true }).click();
  await page.getByTestId('bot-app').filter({ hasText: 'GitHub' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Shared with everyone');
  await expect(dialog.getByRole('button', { name: 'Remove bot access' })).toHaveCount(0);
  await page.screenshot({ animations: 'disabled', path: info.outputPath('app-details-narrow.png') });
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Browse apps', exact: true }).click();
  expect(await page.getByTestId('bot-profile-pane').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const browser = page.getByRole('dialog', { name: 'Browse apps', exact: true });
  expect(await browser.evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth)).toBe(true);
  await page.screenshot({ animations: 'disabled', path: info.outputPath('apps-browser-narrow.png') });
});

test('failed access change keeps the current access and can retry', async ({ page }) => {
  await page.goto('/?view=bot-management&state=app-error');
  await page.getByRole('tab', { name: 'Apps', exact: true }).click();
  await page.getByTestId('bot-app').filter({ hasText: 'Notion' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Add to bot' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not complete');
  await expect(dialog).toContainText('Company connection');
  await expect(dialog.getByRole('button', { name: 'Add to bot' })).toBeEnabled();
});

 test('switches compact views and returns from catalog details without losing search', async ({ page }, info) => {
  await page.goto('/?view=bot-management');
  await page.getByRole('tab', { name: 'Apps', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Grid view', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('apps-grid.png') });
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(page.locator('[data-view=list]')).toBeVisible();
  await expect(page.getByTestId('bot-app')).toHaveCount(4);
  await page.getByRole('button', { name: 'Browse apps', exact: true }).click();
  const browser = page.getByRole('dialog', { name: 'Browse apps', exact: true });
  await expect(browser.getByRole('textbox')).toBeFocused();
  await browser.getByRole('textbox').fill('Drive');
  await browser.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByTestId('catalog-app').click();
  await page.getByRole('button', { name: 'Back to apps', exact: true }).click();
  await expect(browser.getByRole('textbox')).toHaveValue('Drive');
  await page.keyboard.press('Escape');
  await expect(browser).toHaveCount(0);
  await expect(page.locator('[data-view=list]')).toBeVisible();
});

test('search focus, primary hover and modal stacking stay consistent', async ({ page }) => {
  await page.goto('/?view=bot-management');
  await page.getByRole('tab', { name: 'Apps', exact: true }).click();
  const search = page.getByRole('textbox', { name: 'Filter bot apps' });
  await search.focus();
  await expect(search).toHaveCSS('outline-style', 'none');
  const browse = page.getByRole('button', { name: 'Browse apps', exact: true });
  const before = await browse.evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
  await browse.hover();
  await expect(browse).toHaveCSS('background-color', before.bg);
  await expect(browse).toHaveCSS('color', before.fg);
  await page.getByTestId('bot-profile-pane').evaluate(el => { el.style.transform = 'translateZ(0)'; el.style.overflow = 'hidden'; el.style.zIndex = '1'; });
  await browse.click();
  const modal = page.getByRole('dialog', { name: 'Browse apps', exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('textbox')).toHaveCSS('outline-style', 'none');
  expect(await modal.evaluate(el => {
    const overlay = el.parentElement!;
    const bounds = overlay.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return !el.closest('[data-testid="bot-profile-pane"]') && bounds.left === 0 && bounds.top === 0 && bounds.width === innerWidth && bounds.height === innerHeight && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 24));
  })).toBe(true);
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
});
