import { expect, test, type Page } from '@playwright/test';

/**
 * OWNER-R16: every raised surface paints the same neutral surface as the Core
 * and Launch menus, in dark and light. A surface is neutral when its red,
 * green and blue channels differ by no more than 2; it matches when it equals
 * the computed --overlay-bg of the shell. Deploy access was the proven blue
 * case (rgba(44,44,54) from the old --panel-bg).
 */

const SHOTS = process.env.R16_SHOTS_DIR ?? '';
const SHOT_TAG = process.env.R16_SHOTS_TAG ?? 'after';

const clickRow = async (page: Page, id: string) => {
  await page.waitForSelector(`[data-row-id="${id}"]`);
  await page.evaluate((rowId) => (document.querySelector(`[data-row-id="${rowId}"]`) as HTMLElement | null)?.click(), id);
};
const openCompany = async (page: Page) => {
  await page.evaluate(() => (document.querySelector('[data-testid="rail-company"]') as HTMLElement | null)?.click());
};
const createMenu = async (page: Page, item: 'message' | 'channel') => {
  await page.getByTestId('chat-new-message').click();
  await page.getByTestId(`chat-create-menu-${item}`).click();
};

const SURFACES: { name: string; root: string; open: (page: Page) => Promise<void> }[] = [
  {
    name: 'deploy-access',
    root: '[data-testid="sheet-access"], [data-testid="deploy-access-form"]',
    open: async (page) => {
      await openCompany(page);
      await clickRow(page, 'deployments');
      await page.getByTestId('deploy-access').first().click();
    },
  },
  {
    name: 'invite-teammate',
    root: '[role="dialog"][aria-label="Invite teammate"]',
    open: async (page) => {
      await openCompany(page);
      await clickRow(page, 'team');
      await page.getByTestId('invite-teammate').click();
    },
  },
  {
    name: 'new-project',
    root: '[data-testid="new-project-sheet"]',
    open: async (page) => {
      await openCompany(page);
      await clickRow(page, 'projects');
      await page.getByTestId('new-project-button').click();
    },
  },
  {
    name: 'new-policy',
    root: '[data-testid="brain-sheet"]',
    open: async (page) => {
      await openCompany(page);
      await clickRow(page, 'policies');
      await page.getByRole('button', { name: 'New policy' }).click();
    },
  },
  { name: 'new-channel', root: '[data-testid="new-channel-sheet"]', open: (page) => createMenu(page, 'channel') },
  { name: 'new-message', root: '[data-testid="new-message-sheet"]', open: (page) => createMenu(page, 'message') },
  {
    name: 'command-palette',
    root: '[data-testid="command-palette"]',
    open: async (page) => {
      const mac = await page.evaluate(() => /Mac OS X|Macintosh/i.test(navigator.userAgent));
      await page.getByTestId('rail-home').focus();
      await page.keyboard.press(mac ? 'Meta+k' : 'Control+k');
    },
  },
  {
    name: 'meetings-filter',
    root: '[data-testid="meetings-filter-popover"]',
    open: async (page) => {
      await page.getByTestId('rail-meetings').click();
      await page.getByTestId('meetings-filter-button').click();
    },
  },
  {
    name: 'invite-notetaker',
    root: '[data-testid="invite-notetaker-sheet"]',
    open: async (page) => {
      await page.getByTestId('rail-meetings').click();
      await page.getByTestId('meetings-invite-notetaker').click();
    },
  },
  {
    name: 'project-status-menu',
    root: '[data-testid="status-menu"]',
    open: async (page) => {
      await openCompany(page);
      await clickRow(page, 'projects');
      await page.getByTestId('project-row').first().click();
      await page.getByTestId('task-view-open-project').click();
      await page.getByTestId('status-trigger').click();
    },
  },
  {
    name: 'project-new-file',
    root: '[data-testid="sheet-new-file"] [role="dialog"], [data-testid^="sheet-"] [role="dialog"]',
    open: async (page) => {
      await openCompany(page);
      await clickRow(page, 'projects');
      await page.getByTestId('project-row').first().click();
      await page.getByTestId('task-view-open-project').click();
      await page.getByTestId('tab-files').click();
      await page.getByTestId('new-file-open').click();
    },
  },
];

/** Background of the first ancestor-or-self of the root that paints one, plus the shell's --overlay-bg. */
async function surfaceColors(page: Page, root: string) {
  return page.evaluate((selector) => {
    const parse = (v: string) => {
      const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/.exec(v);
      return m ? { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]), a: m[4] === undefined ? 1 : +m[4] } : null;
    };
    let el = document.querySelector(selector) as HTMLElement | null;
    let surface = null as ReturnType<typeof parse>;
    while (el) {
      const c = parse(getComputedStyle(el).backgroundColor);
      if (c && c.a > 0.3) {
        surface = c;
        break;
      }
      el = el.parentElement;
    }
    const probe = document.createElement('div');
    probe.style.background = 'var(--overlay-bg)';
    (el ?? document.body).appendChild(probe);
    const overlay = parse(getComputedStyle(probe).backgroundColor);
    probe.remove();
    return { surface, overlay };
  }, root);
}

for (const theme of ['dark', 'light'] as const) {
  for (const surface of SURFACES) {
    test(`${surface.name} paints the neutral Core menu surface in ${theme}`, async ({ page, browserName }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/desktop-alt.html?window=desktop-alt&theme=${theme}&persona=indigo`);
      await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
      await surface.open(page);
      await expect(page.locator(surface.root).first()).toBeVisible();
      if (SHOTS && browserName === 'chromium') {
        await page.screenshot({ path: `${SHOTS}/${SHOT_TAG}-${surface.name}-${theme}.png` });
      }
      const { surface: bg, overlay } = await surfaceColors(page, surface.root);
      expect(bg, 'surface paints a background').not.toBeNull();
      const spread = Math.max(bg!.r, bg!.g, bg!.b) - Math.min(bg!.r, bg!.g, bg!.b);
      expect(spread, `${surface.name} ${theme} rgb(${bg!.r}, ${bg!.g}, ${bg!.b}) is neutral`).toBeLessThanOrEqual(2);
      expect([bg!.r, bg!.g, bg!.b], `${surface.name} ${theme} equals --overlay-bg`).toEqual([overlay!.r, overlay!.g, overlay!.b]);
    });
  }
}

