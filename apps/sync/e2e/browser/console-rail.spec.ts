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
    // OWNER-R22 added Marketplace beneath Connections.
    await expect(rail.locator('[data-testid^="rail-"]')).toHaveCount(13);
    await expect(page.getByTestId('rail-marketplace')).toHaveAttribute('aria-label', 'Marketplace');

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

  test('Team Add agent opens the New bot modal and lands in the bot thread', async ({ page }) => {
    const errors = await openShell(page);
    const shots = process.env.BOT_FLOW_SHOTS;
    await page.getByTestId('rail-company').click();
    await page.locator('[data-row-id="team"]').click();
    await page.getByTestId('team-add-agent').click();
    // New bot asks the name first, in the full-window takeover, then
    // "Where should <Name> live?".
    await expect(page.getByTestId('new-bot-name-screen')).toBeVisible();
    await page.getByTestId('new-bot-name').fill('Scout');
    await page.getByTestId('new-bot-continue-name').click();
    await expect(page.getByTestId('new-bot-kind-choice')).toBeVisible();
    await expect(page.locator('#new-bot-takeover-title')).toHaveText('Where should Scout live?');
    await page.getByTestId('new-bot-choice-local').click();
    // The local flow is the cloud flow's step screens, on its one step: the
    // coding tool, with the name carried in.
    const flow = page.getByTestId('chat-create-bot-step');
    await expect(flow).toBeVisible();
    // One layout: the takeover's step screens (step dots), no wizard crumbs.
    await expect(flow.getByTestId('new-bot-progress')).toBeVisible();
    await expect(page.locator('[data-testid^="create-bot-crumb-"]')).toHaveCount(0);
    await expect(page.getByTestId('new-agent-stepper')).toHaveCount(0);
    // Local was already picked, so "Where does it run?" is not asked again.
    await expect(flow).toHaveAttribute('data-step', 'home');
    await expect(flow.getByTestId('bot-identity-name')).toHaveText('Scout');
    await expect(page.getByTestId('chat-bot-where')).toHaveCount(0);
    await expect(page.getByTestId('create-bot-runtime-section')).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/modal.png` });
    await page.getByTestId('chat-bot-create').click();
    // Lands in the new bot's DM. A local bot runs with the person's own
    // access, so it greets and never asks for a grant.
    await expect(flow).toHaveCount(0);
    await expect(page.getByText("Hi, I'm Scout. I'll ask a few quick questions to finish my setup.")).toBeVisible();
    await expect(page.getByTestId('share-request-card')).toHaveCount(0);
    await expect(page.getByText('Pick my skills: open my profile')).toHaveCount(0);
    if (shots) {
      await page.screenshot({ path: `${shots}/bot-thread.png` });
      await page.locator('.dm-msg-author', { hasText: 'Scout' }).first().click().catch(() => {});
      const pane = page.getByTestId('bot-profile-pane');
      if (await pane.isVisible().catch(() => false)) await pane.screenshot({ path: `${shots}/bot-sidepane.png` });
    }
    expect(errors, errors.join('; ')).toEqual([]);
  });

  test('avatar menu signs out', async ({ page }) => {
    await openShell(page);
    await page.getByTestId('rail-you').click();
    const menu = page.getByTestId('account-menu');
    await expect(menu).toBeVisible();
    // OWNER-R21: the menu is the name block (opens Settings at Profile), one
    // Settings entry and Sign out; Profile and Billing rows moved into the
    // Settings list. Focus lands on the first item, the name block.
    await expect(page.getByTestId('account-identity')).toBeFocused();
    for (const id of ['account-identity', 'account-settings', 'account-sign-out']) {
      await expect(page.getByTestId(id)).toBeVisible();
    }
    await expect(menu.getByRole('menuitem')).toHaveCount(3);
    for (const id of ['account-profile', 'account-billing']) {
      await expect(page.getByTestId(id)).toHaveCount(0);
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
      // WebKit does not count a bare modifier press as keyboard input, so the
      // first control after the mouse click would never match :focus-visible;
      // a real Tab press sets the modality in every engine.
      await page.keyboard.press('Tab');
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
