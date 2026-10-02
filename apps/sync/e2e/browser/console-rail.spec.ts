import { expect, test, type Page } from '@playwright/test';

/**
 * Console rail end-to-end path (US-039). Runs against the desktop preview
 * harness (mocked Tauri, indigo persona), which is the only host where
 * company folders exist on "this Mac", so the project board, task pane, and
 * Files tab are reachable. Sign-in itself is covered on the web host by
 * apps/work/e2e/console-rail.test.ts.
 */

const SHELL = '/desktop-alt.html?window=desktop-alt&persona=indigo';

async function openShell(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(SHELL);
  await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
  return errors;
}

/** The destination frame paints within one animation frame of the click. */
async function clickPaints(page: Page, trigger: string, destination: string): Promise<void> {
  const painted = await page.evaluate(
    ([t, d]) =>
      new Promise<boolean>((resolve) => {
        (document.querySelector(t) as HTMLElement).click();
        requestAnimationFrame(() => resolve(document.querySelector(d) !== null));
      }),
    [trigger, destination],
  );
  expect(painted, `${destination} after ${trigger}`).toBe(true);
}

test.describe('console rail: full user path', () => {
  test('rail switch, company Atlas, projects, task pane, Files tab', async ({ page }) => {
    const errors = await openShell(page);
    const rail = page.getByTestId('app-rail');
    await expect(rail.locator('[data-testid^="rail-"]')).toHaveCount(12);

    await clickPaints(page, '[data-testid="rail-company"]', '[data-testid="atlas-landing"]');
    await expect(page.getByTestId('rail-company')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('atlas-inspector')).toBeVisible();

    await clickPaints(page, '[data-row-id="projects"]', '[data-testid="projects-host"]');
    await expect(page.getByTestId('rail-placeholder')).toHaveCount(0);
    await page.getByTestId('project-row').first().click();
    await expect(page.getByTestId('task-view-pane')).toBeVisible();
    await page.getByTestId('task-view-open-project').click();
    await expect(page.getByTestId('project-detail-view')).toBeVisible();
    await page.getByTestId('tab-files').click();
    await expect(page.getByTestId('tab-files')).toHaveAttribute('aria-current', 'page');

    // Meetings opens its own sidepane in place of the Messages list, with the
    // classic agenda mounted under the canvas.
    await clickPaints(page, '[data-testid="rail-meetings"]', '[data-testid="desktop-alt-meetings"]');
    await expect(page.getByTestId('meetings-sidepane-header')).toBeVisible();
    await expect(page.getByTestId('chat-sidebar')).toBeHidden();
    await expect(page.getByTestId('meetings-row').first()).toBeVisible();

    await clickPaints(page, '[data-testid="rail-home"]', '[data-testid="chat-sidebar"]');
    await page.locator('[data-conversation-id]').first().click();
    await expect(page.getByRole('main', { name: 'Channel' })).toBeVisible();

    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('pin and unpin a company from More companies', async ({ page }) => {
    await openShell(page);
    await expect(page.getByTestId('rail-company')).toHaveCount(1);
    await page.getByTestId('rail-more-companies').click();
    const popover = page.getByTestId('more-companies-popover');
    await expect(popover).toBeVisible();
    await popover.getByRole('button', { name: 'Unpin Indigo' }).click();
    await expect(page.getByTestId('rail-company')).toHaveCount(0);
    await popover.getByRole('button', { name: 'Pin Indigo' }).click();
    await expect(page.getByTestId('rail-company')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(page.getByTestId('rail-more-companies')).toBeFocused();
  });

  test('Team Add agent opens the New agent stepper and reaches Verify', async ({ page }) => {
    await openShell(page);
    await page.getByTestId('rail-company').click();
    await page.locator('[data-row-id="team"]').click();
    await page.getByTestId('team-add-agent').click();
    const stepper = page.getByTestId('new-agent-stepper');
    await expect(stepper).toBeVisible();
    // Walk Runtime → Identity → Membership → Access → Capabilities → Verify.
    for (let step = 1; step < 6; step += 1) {
      await expect(stepper).toContainText(`step ${step} of 6`);
      const name = page.getByTestId('new-agent-name');
      if ((await name.count()) > 0 && !(await name.inputValue())) await name.fill('Scout');
      await page.getByTestId('new-agent-next').click();
    }
    await expect(stepper).toContainText('step 6 of 6');
    await expect(stepper).toContainText('Verify');
  });

  test('avatar menu signs out', async ({ page }) => {
    await openShell(page);
    await page.getByTestId('rail-you').click();
    const menu = page.getByTestId('account-menu');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('account-profile')).toBeFocused();
    for (const id of ['account-profile', 'account-billing', 'account-settings', 'account-sign-out']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByTestId('account-sign-out').click();
    await expect(menu).toHaveCount(0);
  });
});

test.describe('console rail: keyboard and accessible names', () => {
  test('every rail item and sidepane row has a name and a visible focus ring', async ({ page }) => {
    await openShell(page);
    await page.getByTestId('rail-company').click();
    await expect(page.getByTestId('company-sidepane-header')).toBeVisible();
    const controls = page.locator(
      '[data-testid="app-rail"] button, [data-testid="sidepane"] button',
    );
    const count = await controls.count();
    expect(count).toBeGreaterThan(20);
    for (let i = 0; i < count; i += 1) {
      const control = controls.nth(i);
      if (!(await control.isVisible())) continue;
      const name = await control.evaluate(
        (el) => el.getAttribute('aria-label') || el.textContent?.trim() || '',
      );
      expect(name, await control.evaluate((el) => el.outerHTML.slice(0, 120))).not.toBe('');
      // Keyboard modality, so :focus-visible applies as it does for Tab.
      await page.keyboard.press('Shift');
      await control.focus();
      const ring = await control.evaluate((el) => {
        const style = getComputedStyle(el);
        return style.outlineStyle !== 'none' || style.boxShadow !== 'none';
      });
      expect(ring, `focus ring on ${name}`).toBe(true);
    }
  });

  test('Cmd+1..9 select rail items and Escape closes popovers', async ({ page }) => {
    await openShell(page);
    // Start from a rail button so no text field owns the keystroke.
    await page.getByTestId('rail-home').focus();
    // The shell maps Mod to Cmd on a Mac user agent and Ctrl elsewhere; the
    // Desktop Chrome device reports Windows.
    const mod = (await page.evaluate(() => /Mac OS X|Macintosh/i.test(navigator.userAgent)))
      ? 'Meta'
      : 'Control';
    await page.keyboard.press(`${mod}+2`);
    await expect(page.getByTestId('rail-meetings')).toHaveAttribute('aria-current', 'page');
    await page.keyboard.press(`${mod}+1`);
    await expect(page.getByTestId('rail-home')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('rail-you').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('account-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('account-menu')).toHaveCount(0);
    await expect(page.getByTestId('rail-you')).toBeFocused();
  });

  test('reduced motion stops rail pulses', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openShell(page);
    const animated = await page
      .locator('[data-testid="app-rail"] *')
      .evaluateAll((els) =>
        els.filter((el) => {
          const s = getComputedStyle(el);
          return s.animationName !== 'none' && s.animationPlayState === 'running' && parseFloat(s.animationDuration) > 0.01;
        }).length,
      );
    expect(animated).toBe(0);
  });
});
