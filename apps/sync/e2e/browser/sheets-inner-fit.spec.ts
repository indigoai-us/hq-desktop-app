import { expect, test, type Page } from '@playwright/test';
import { innerFitViolations } from './sheet-inner-fit';

/**
 * QA-107 sweep: every sheet and modal in the console-rail shell keeps its inputs
 * and controls inside their containers, with no sideways scroll, at 1440x900
 * and 1000x700. The New objective sheet has its own spec.
 */

const clickRow = async (page: Page, id: string) => {
  await page.waitForSelector(`[data-row-id="${id}"]`);
  await page.evaluate((rowId) => (document.querySelector(`[data-row-id="${rowId}"]`) as HTMLElement | null)?.click(), id);
};

const openCompany = async (page: Page) => {
  await page.evaluate(() => (document.querySelector('[data-testid="rail-company"]') as HTMLElement | null)?.click());
};

const createMenu = async (page: Page, item: 'message' | 'channel' | 'agent') => {
  await page.getByTestId('chat-new-message').click();
  await page.getByTestId(`chat-create-menu-${item}`).click();
};

const SHEETS: { name: string; root: string; open: (page: Page) => Promise<void>; next?: ((page: Page) => Promise<void>)[] }[] = [
  {
    name: 'New project',
    root: '[data-testid="new-project-sheet"]',
    open: async (page) => {
      await openCompany(page);
      await clickRow(page, 'projects');
      await page.getByTestId('new-project-button').click();
    },
  },
  {
    name: 'New policy',
    root: '[data-testid="brain-sheet"]',
    open: async (page) => {
      await openCompany(page);
      await clickRow(page, 'policies');
      await page.getByRole('button', { name: 'New policy' }).click();
    },
  },
  {
    name: 'New worker',
    root: '[data-testid="brain-sheet"]',
    open: async (page) => {
      await openCompany(page);
      await clickRow(page, 'workers');
      await page.getByRole('button', { name: 'New worker' }).click();
    },
  },
  { name: 'New channel', root: '[data-testid="new-channel-sheet"]', open: (page) => createMenu(page, 'channel') },
  { name: 'New message', root: '[data-testid="new-message-sheet"]', open: (page) => createMenu(page, 'message') },
  {
    name: 'New bot steps',
    root: '[data-testid="chat-create-bot-step"]',
    open: async (page) => {
      await createMenu(page, 'agent');
      // New bot asks the name, then "Where should it live?"; Local opens the
      // step flow on the coding tool.
      await page.getByTestId('new-bot-name').fill('Scout');
      await page.getByTestId('new-bot-continue-name').click();
      await page.getByTestId('new-bot-choice-local').click();
      await expect(page.getByTestId('chat-create-bot-step')).toHaveAttribute('data-step', 'home');
      await expect(page.getByTestId('create-bot-runtime-section')).toBeVisible();
    },
    // The optional steps, one per screen: who it's for, then fine-tune
    // (handle, permissions and memory). This persona has no templates, so
    // there is no Start from step.
    next: [
      async (page) => {
        await page.getByTestId('create-bot-next').click();
        await expect(page.getByTestId('chat-create-bot-step')).toHaveAttribute('data-step', 'scope');
      },
      async (page) => {
        await page.getByTestId('create-bot-next').click();
        await expect(page.getByTestId('chat-create-bot-step')).toHaveAttribute('data-step', 'tune');
        await expect(page.getByTestId('chat-bot-advanced')).toBeVisible();
      },
    ],
  },
  {
    name: 'Invite',
    root: '[role="dialog"][aria-label="Invite teammate"]',
    open: async (page) => {
      await openCompany(page);
      await clickRow(page, 'team');
      await page.getByTestId('invite-teammate').click();
    },
  },
  {
    name: 'Deployments Access',
    root: '[data-testid="sheet-access"], [data-testid="deploy-access-form"]',
    open: async (page) => {
      await openCompany(page);
      await clickRow(page, 'deployments');
      await page.getByTestId('deploy-access').first().click();
    },
  },
  {
    name: 'Command palette',
    root: '[data-testid="command-palette"]',
    open: async (page) => {
      // The shell resolves Mod from the user agent, which differs per browser project.
      const mac = await page.evaluate(() => /Mac OS X|Macintosh/i.test(navigator.userAgent));
      await page.getByTestId('rail-home').focus();
      await page.keyboard.press(mac ? 'Meta+k' : 'Control+k');
    },
  },
];

for (const [width, height] of [[1440, 900], [1000, 700]] as const) {
  for (const sheet of SHEETS) {
    test(`${sheet.name} inputs fit their containers at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/desktop-alt.html?window=desktop-alt&theme=dark&persona=indigo');
      await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
      await sheet.open(page);
      await expect(page.locator(sheet.root).first()).toBeVisible();
      expect(await innerFitViolations(page, sheet.root), `${sheet.name} inner boxes`).toEqual([]);
      for (const [index, step] of (sheet.next ?? []).entries()) {
        await step(page);
        expect(await innerFitViolations(page, sheet.root), `${sheet.name} step ${index + 2} inner boxes`).toEqual([]);
      }
    });
  }
}
