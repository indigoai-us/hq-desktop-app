import { expect, test, type Page } from '@playwright/test';

/**
 * OWNER-R33: the top bar's raised surfaces (Launch menu, Core menu, the
 * notification panel and the account menu) open above every full-page view.
 * For each page, each surface is opened and hit-tested: the topmost element
 * at the menu's centre and at points just inside each corner must belong to
 * the menu, so no page content (header, search field, card grid) covers it.
 */

type Opener = { name: string; trigger: string; surface: string };

const MENUS: Opener[] = [
  { name: 'Launch menu', trigger: 'titlebar-launch', surface: 'titlebar-launch-menu' },
  { name: 'Core menu', trigger: 'titlebar-core-pill', surface: 'core-popover' },
  { name: 'notification panel', trigger: 'titlebar-notifications', surface: 'notifications-popover' },
  { name: 'account menu', trigger: 'rail-you', surface: 'account-menu' },
];

type PageCase = { name: string; open: (page: Page) => Promise<void>; ready: string };

const click = (page: Page, selector: string) =>
  page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.click(), selector);

async function companyRow(page: Page, row: string): Promise<void> {
  await click(page, '[data-testid="rail-company"]');
  await page.waitForSelector(`[data-row-id="${row}"]`);
  await click(page, `[data-row-id="${row}"]`);
}

const PAGES: PageCase[] = [
  { name: 'Home and Messages', open: (p) => click(p, '[data-testid="rail-home"]'), ready: '[data-testid="rail-home"][aria-current="page"]' },
  { name: 'Marketplace', open: (p) => click(p, '[data-testid="rail-marketplace"]'), ready: '[data-testid="library-overlay"]' },
  { name: 'Files', open: (p) => click(p, '[data-testid="rail-library"]'), ready: '[data-testid="rail-files-host"]' },
  { name: 'Meetings', open: (p) => click(p, '[data-testid="rail-meetings"]'), ready: '[data-testid="rail-meetings"][aria-current="page"]' },
  { name: 'Settings', open: (p) => click(p, '[data-testid="rail-you"]').then(() => click(p, '[data-testid="account-settings"]')), ready: '[data-testid="settings-host"]' },
  { name: 'Atlas', open: (p) => click(p, '[data-testid="rail-company"]'), ready: '[data-row-id="atlas"][aria-current="page"]' },
  { name: 'company Projects pane', open: (p) => companyRow(p, 'projects'), ready: '[data-row-id="projects"][aria-current="page"]' },
  { name: 'My Telemetry', open: (p) => click(p, '[data-testid="rail-telemetry"]'), ready: '[data-testid="rail-telemetry"][aria-current="page"]' },
  { name: 'Outpost', open: (p) => click(p, '[data-testid="rail-outpost"]'), ready: '[data-testid="rail-outpost"][aria-current="page"]' },
];

/** Test ids of whatever is topmost at the menu's centre and inset corners. */
async function coverers(page: Page, surface: string): Promise<string[]> {
  return page.evaluate((testid) => {
    const menu = document.querySelector(`[data-testid="${testid}"]`);
    if (!menu) return [`${testid} missing`];
    const r = menu.getBoundingClientRect();
    const pts: Array<[number, number]> = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 8, r.top + 8],
      [r.right - 8, r.top + 8],
      [r.left + 8, Math.min(r.bottom, innerHeight) - 8],
      [r.right - 8, Math.min(r.bottom, innerHeight) - 8],
    ];
    const out: string[] = [];
    for (const [x, y] of pts) {
      const hit = document.elementFromPoint(x, y);
      if (hit && !menu.contains(hit)) {
        const owner = hit.closest('[data-testid]');
        out.push(`(${Math.round(x)},${Math.round(y)}) ${owner?.getAttribute('data-testid') ?? hit.tagName}`);
      }
    }
    return out;
  }, surface);
}

for (const pageCase of PAGES) {
  test(`top bar menus open above ${pageCase.name}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/dev-harness/index.html?view=shell&persona=indigo&theme=dark');
    await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
    await pageCase.open(page);
    await page.keyboard.press('Escape');
    await expect(page.locator(pageCase.ready).first()).toBeVisible({ timeout: 15_000 });
    for (const menu of MENUS) {
      await page.getByTestId(menu.trigger).click();
      await expect(page.getByTestId(menu.surface)).toBeVisible({ timeout: 10_000 });
      await expect.poll(() => coverers(page, menu.surface), { message: `${menu.name} on ${pageCase.name}` }).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId(menu.surface)).toHaveCount(0, { timeout: 5_000 });
    }
  });
}
