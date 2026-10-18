import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The message hover menu must sit just above its row (2–4px of overlap) and
 * must not cover the message text. These assertions describe the fixed
 * geometry; they fail while the toolbar is pinned over the line with
 * `top: -14px` / `top: -12px`.
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

function verticalOverlap(a: Box, b: Box): number {
  return Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
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

  test('one-line continuation: menu overlaps the row by 2–4px and the link stays clickable', async ({ page }) => {
    await parkInView(page, 'probe-link');
    const row = page.locator('[data-event-id="probe-link"]');
    const menu = await revealMenu(row);
    const rowBox = await boxOf(row);
    const menuBox = await boxOf(menu);
    const text = row.locator('.msg-body');
    const textBox = await boxOf(text);
    const link = row.locator('a[href="https://example.com/rescue"]');
    const linkBox = await boxOf(link);

    const overlap = verticalOverlap(menuBox, rowBox);
    expect(overlap, 'row overlap px').toBeGreaterThanOrEqual(2);
    expect(overlap, 'row overlap px').toBeLessThanOrEqual(4);
    expect(intersects(menuBox, textBox), 'menu intersects the text line').toBe(false);

    const linkCenterX = linkBox.x + linkBox.width / 2;
    expect(linkCenterX, 'fixture link must sit under the menu').toBeGreaterThan(menuBox.x);
    expect(linkCenterX).toBeLessThan(menuBox.x + menuBox.width);

    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const anchor = el?.closest('a');
      return anchor?.getAttribute('href') ?? null;
    }, { x: linkCenterX, y: linkBox.y + linkBox.height / 2 });
    expect(hit).toBe('https://example.com/rescue');

    await page.mouse.move(menuBox.x + menuBox.width / 2, menuBox.y + 4, { steps: 8 });
    await expect.poll(() => row.evaluate((el) => el.matches(':hover'))).toBe(true);
    await expect.poll(() => row.evaluate((el) => {
      let prev = el.previousElementSibling;
      while (prev && !(prev instanceof HTMLElement && prev.classList.contains('dm-msg'))) {
        prev = prev.previousElementSibling;
      }
      return prev instanceof HTMLElement ? prev.matches(':hover') : false;
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

  test('a row scrolled flush with the scrollport flips the menu off the text', async ({ page }) => {
    const thread = page.getByTestId('conversation-thread');
    const geom = await thread.evaluate((scroller) => {
      const row = scroller.querySelector('[data-event-id="probe-flush"]');
      if (!(row instanceof HTMLElement)) return null;
      const rowRect = row.getBoundingClientRect();
      const port = scroller.getBoundingClientRect();
      scroller.scrollTop += rowRect.top - port.top;
      const next = row.getBoundingClientRect();
      const menu = row.querySelector(':scope > .dm-msg-column > .dm-quick-react');
      const menuHeight = menu instanceof HTMLElement ? menu.offsetHeight : 0;
      const portTop = scroller.getBoundingClientRect().top;
      return {
        rowTop: next.top,
        portTop,
        menuHeight,
        maxScroll: scroller.scrollHeight - scroller.clientHeight,
        scrollTop: scroller.scrollTop,
        clipped: next.top - (menuHeight - 3) < portTop - 0.5,
      };
    });
    expect(geom, 'probe-flush is in the thread').not.toBeNull();
    expect(geom!.menuHeight, 'menu has layout height').toBeGreaterThan(10);
    expect(geom!.scrollTop, `flush scroll clamped: ${JSON.stringify(geom)}`).toBeGreaterThan(0);
    expect(Math.abs(geom!.rowTop - geom!.portTop), `row not flush: ${JSON.stringify(geom)}`).toBeLessThanOrEqual(1);
    expect(geom!.clipped, `menu would not clip: ${JSON.stringify(geom)}`).toBe(true);

    const row = page.locator('[data-event-id="probe-flush"]');
    const rowBox = await boxOf(row);
    // Move the pointer onto the row. locator.hover() would scroll a flush row
    // back down if a sticky layer covers its center, which skips the flip.
    await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
    await expect(row).toHaveAttribute('data-menu-flip', '');
    const menu = row.locator('.dm-quick-react');
    await expect(menu).toHaveCSS('opacity', '1');
    const threadBox = await boxOf(thread);
    const menuBox = await boxOf(menu);
    const textBox = await boxOf(row.locator('.msg-body'));

    expect(menuBox.y).toBeGreaterThanOrEqual(threadBox.y - 0.5);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(threadBox.y + threadBox.height + 0.5);
    expect(intersects(menuBox, textBox), 'flipped menu covers the text').toBe(false);
    await expect(row).toHaveAttribute('data-menu-flip', '');
  });

  test('reply panel: one-line reply overlaps 2–4px and the root menu stays inside the list', async ({ page }) => {
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

    const overlap = verticalOverlap(menuBox, replyBox);
    expect(overlap, 'reply row overlap px').toBeGreaterThanOrEqual(2);
    expect(overlap, 'reply row overlap px').toBeLessThanOrEqual(4);
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
