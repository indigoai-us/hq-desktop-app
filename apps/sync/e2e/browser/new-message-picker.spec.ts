import { expect, test, type Page } from '@playwright/test';

/**
 * New message recipient picker: renders in the full window and at quick-window
 * width, in dark and light, with sections, avatars, and chips.
 */

const SHOTS = process.env.PICKER_SHOTS_DIR ?? 'test-results/new-message-picker';

const openNewMessage = async (page: Page, theme: 'dark' | 'light') => {
  // The shell follows the system appearance; the theme param alone does not flip it.
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`/desktop-alt.html?window=desktop-alt&theme=${theme}&persona=indigo`);
  await page.getByTestId('chat-new-message').click();
  await page.getByTestId('chat-create-menu-message').click();
  await expect(page.getByTestId('new-message-sheet')).toBeVisible();
};

for (const theme of ['dark', 'light'] as const) {
  for (const size of [
    { name: 'full', width: 1180, height: 760 },
    { name: 'quick', width: 440, height: 680 },
  ]) {
    test(`new message picker ${theme} ${size.name}`, async ({ page }, info) => {
      const shot = (step: string) => `${SHOTS}/${info.project.name}-${theme}-${size.name}-${step}.png`;
      // The sidebar "+" is hidden at quick-window width, so open the sheet at
      // full width, then narrow the window to the quick-window size.
      await openNewMessage(page, theme);
      await page.setViewportSize({ width: size.width, height: size.height });
      const sheet = page.getByTestId('new-message-sheet');
      await page.screenshot({ path: shot('empty') });

      const submit = page.getByTestId('new-message-send');
      await expect(submit).toBeDisabled();
      await expect(sheet.getByTestId('recipient-section').first()).toBeVisible();

      const field = sheet.getByRole('combobox');
      await field.fill('gr');
      await page.screenshot({ path: shot('query') });
      await field.press('Enter');
      await expect(sheet.getByTestId('recipient-chip')).toHaveCount(1);
      await expect(submit).toBeEnabled();
      await expect(submit).toHaveText('Start conversation');
      await page.screenshot({ path: shot('chips') });

      // Sheet stays inside the window at quick-window width.
      const box = await sheet.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.width);

      await field.press('Backspace');
      await expect(sheet.getByTestId('recipient-chip')).toHaveCount(0);
      await expect(submit).toBeDisabled();
    });
  }
}
