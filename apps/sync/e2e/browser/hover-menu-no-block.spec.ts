import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The message hover menu hangs 4px under everything that belongs to its
 * message (owner, #772, restored 2026-10-21) and must never cover the
 * message's own text or links. Where hanging below would clip at the bottom
 * of the scrollport, it opens above the message instead. The menu used to
 * be pinned over the line (`top: -14px`), which made a link in a one-line
 * message unclickable.
 */

const SHELL = '/desktop-alt.html?window=desktop-alt&persona=indigo&hoverMenuProbe=1';
const SHOT_DIR = process.env.HOVER_MENU_SHOTS_DIR;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function intersects(a: Box, b: Box): boolean {
  const overlapW = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapH = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlapW > 0.5 && overlapH > 0.5;
}

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, `${locator} has a box`).not.toBeNull();
  return box as Box;
}

async function openChannel(page: Page): Promise<void> {
  await page.goto(SHELL);
  await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-conversation-id="ch:chn_1"]').first().click();
  const thread = page.getByTestId('conversation-thread');
  await expect(thread).toBeVisible();
  await expect(page.locator('[data-event-id="probe-link"]')).toBeVisible({ timeout: 20_000 });
}

/** Park a row in the middle of the scrollport so its menu has room above. */
async function parkInView(page: Page, eventId: string): Promise<void> {
  await page.getByTestId('conversation-thread').evaluate((scroller, id) => {
    const row = scroller.querySelector(`[data-event-id="${id}"]`);
    if (!(row instanceof HTMLElement)) return;
    const rowRect = row.getBoundingClientRect();
    const port = scroller.getBoundingClientRect();
    scroller.scrollTop += rowRect.top - (port.top + port.height * 0.55);
  }, eventId);
}

async function revealMenu(row: Locator): Promise<Locator> {
  await row.hover();
  const menu = row.locator('.dm-quick-react');
  await expect(menu).toHaveCSS('opacity', '1');
  return menu;
}

test.describe('message hover menu does not cover the message', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000);
    await openChannel(page);
  });

  test('one-line continuation: menu hangs 4px under the message and the link stays clickable', async ({ page }) => {
    await parkInView(page, 'probe-link');
    const row = page.locator('[data-event-id="probe-link"]');
    const menu = await revealMenu(row);
    const columnBox = await boxOf(row.locator(':scope > .dm-msg-column'));
    const menuBox = await boxOf(menu);
    const text = row.locator('.msg-body');
    const textBox = await boxOf(text);
    const link = row.locator('a[href="https://example.com/rescue"]');
    const linkBox = await boxOf(link);

    const gap = menuBox.y - (columnBox.y + columnBox.height);
    expect(gap, 'gap under the message px').toBeGreaterThanOrEqual(3);
    expect(gap, 'gap under the message px').toBeLessThanOrEqual(5);
    expect(intersects(menuBox, textBox), 'menu intersects the text').toBe(false);
    expect(intersects(menuBox, linkBox), 'menu intersects the link').toBe(false);

    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const anchor = el?.closest('a');
      return anchor?.getAttribute('href') ?? null;
    }, { x: linkBox.x + linkBox.width / 2, y: linkBox.y + linkBox.height / 2 });
    expect(hit).toBe('https://example.com/rescue');

    // Into the bar without the row losing hover or the next row taking it.
    await page.mouse.move(menuBox.x + menuBox.width / 2, menuBox.y + 4, { steps: 8 });
    await expect.poll(() => row.evaluate((el) => el.matches(':hover'))).toBe(true);
    await expect.poll(() => row.evaluate((el) => {
      let next = el.nextElementSibling;
      while (next && !(next instanceof HTMLElement && next.classList.contains('dm-msg'))) {
        next = next.nextElementSibling;
      }
      return next instanceof HTMLElement ? next.matches(':hover') : false;
    })).toBe(false);
    await expect(menu).toHaveCSS('opacity', '1');
  });

  test('top of the list keeps the first menu inside the scrollport and off the text', async ({ page }) => {
    const thread = page.getByTestId('conversation-thread');
    await thread.evaluate((el) => {
      el.scrollTop = 0;
    });
    const row = page.locator('[data-event-id="probe-top"]');
    const menu = await revealMenu(row);
    const threadBox = await boxOf(thread);
    const menuBox = await boxOf(menu);
    const textBox = await boxOf(row.locator('.msg-body'));

    expect(menuBox.y).toBeGreaterThanOrEqual(threadBox.y - 0.5);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(threadBox.y + threadBox.height + 0.5);
    expect(menuBox.x).toBeGreaterThanOrEqual(threadBox.x - 0.5);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(threadBox.x + threadBox.width + 0.5);
    expect(intersects(menuBox, textBox)).toBe(false);
  });

  test('a row flush with the bottom of the scrollport opens its menu above', async ({ page }) => {
    const thread = page.getByTestId('conversation-thread');
    const geom = await thread.evaluate((scroller) => {
      const row = scroller.querySelector('[data-event-id="probe-flush"]');
      if (!(row instanceof HTMLElement)) return null;
      const column = row.querySelector(':scope > .dm-msg-column');
      if (!(column instanceof HTMLElement)) return null;
      const port = scroller.getBoundingClientRect();
      scroller.scrollTop += column.getBoundingClientRect().bottom - port.bottom;
      const next = column.getBoundingClientRect();
      const menu = column.querySelector(':scope > .dm-quick-react');
      const menuHeight = menu instanceof HTMLElement ? menu.offsetHeight : 0;
      const portBottom = scroller.getBoundingClientRect().bottom;
      return {
        columnBottom: next.bottom,
        portBottom,
        menuHeight,
        clipped: next.bottom + 4 + menuHeight > portBottom + 0.5,
      };
    });
    expect(geom, 'probe-flush is in the thread').not.toBeNull();
    expect(geom!.menuHeight, 'menu has layout height').toBeGreaterThan(10);
    expect(Math.abs(geom!.columnBottom - geom!.portBottom), `row not flush: ${JSON.stringify(geom)}`).toBeLessThanOrEqual(1);
    expect(geom!.clipped, `menu would not clip: ${JSON.stringify(geom)}`).toBe(true);

    const row = page.locator('[data-event-id="probe-flush"]');
    const textBox0 = await boxOf(row.locator('.msg-body'));
    // Move the pointer onto the text. locator.hover() would scroll a flush
    // row back up if a sticky layer covers its center, which skips the flip.
    await page.mouse.move(textBox0.x + 8, textBox0.y + textBox0.height / 2);
    await expect(row).toHaveAttribute('data-menu-flip', '');
    const menu = row.locator('.dm-quick-react');
    await expect(menu).toHaveCSS('opacity', '1');
    const threadBox = await boxOf(thread);
    const menuBox = await boxOf(menu);
    const textBox = await boxOf(row.locator('.msg-body'));

    expect(menuBox.y).toBeGreaterThanOrEqual(threadBox.y - 0.5);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(threadBox.y + threadBox.height + 0.5);
    expect(intersects(menuBox, textBox), 'flipped menu covers the text').toBe(false);
  });

  test('reply panel: the last reply opens its menu above, off its text, and the root menu stays inside the list', async ({ page }) => {
    await page.locator('[data-event-id="probe-reply"] [data-testid="message-replies"]').click();
    const list = page.getByTestId('reply-panel-list');
    await expect(list).toBeVisible();
    const reply = page.locator('[data-event-id="probe-reply-line"]');
    await expect(reply).toBeVisible();
    await reply.hover();
    const menu = reply.locator('.reply-quick-react').first();
    await expect(menu).toHaveCSS('opacity', '1');
    const replyBox = await boxOf(reply);
    const menuBox = await boxOf(menu);
    const bodyBox = await boxOf(reply.locator('.msg-body'));
    const linkBox = await boxOf(reply.locator('a[href="https://example.com/reply-line"]'));

    // The only reply is the newest, which opens above: a menu hanging below
    // it would stretch the list's scroll height even at rest.
    const gap = replyBox.y - (menuBox.y + menuBox.height);
    expect(gap, 'gap above the last reply px').toBeGreaterThanOrEqual(3);
    expect(gap, 'gap above the last reply px').toBeLessThanOrEqual(5);
    expect(intersects(menuBox, bodyBox)).toBe(false);
    expect(intersects(menuBox, linkBox)).toBe(false);

    const root = page.getByTestId('reply-panel-root');
    await root.hover();
    const rootMenu = root.locator('.reply-quick-react-root');
    await expect(rootMenu).toHaveCSS('opacity', '1');
    const rootMenuBox = await boxOf(rootMenu);
    const rootBodyBox = await boxOf(root.locator('.reply-root-body'));
    const listBox = await boxOf(list);
    expect(rootMenuBox.y + rootMenuBox.height).toBeLessThanOrEqual(rootBodyBox.y + 0.5);
    expect(rootMenuBox.y).toBeGreaterThanOrEqual(listBox.y - 0.5);
    expect(rootMenuBox.y + rootMenuBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 0.5);
  });
});

test('hover menu screenshots', async ({ page }, testInfo) => {
  test.skip(!SHOT_DIR || testInfo.project.name !== 'chromium', 'screenshot pass only');
  test.setTimeout(60_000);
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript((colorTheme) => {
      localStorage.setItem(
        'hq-sync.appearance.v1',
        JSON.stringify({ colorTheme, windowTransparency: 0 }),
      );
    }, theme);
    await openChannel(page);
    await parkInView(page, 'probe-link');
    const row = page.locator('[data-event-id="probe-link"]');
    await revealMenu(row);
    await page.screenshot({
      path: `${SHOT_DIR}/${process.env.HOVER_MENU_SHOTS}-${theme}.png`,
    });
    await page.evaluate(() => localStorage.removeItem('hq-sync.appearance.v1'));
  }
});
