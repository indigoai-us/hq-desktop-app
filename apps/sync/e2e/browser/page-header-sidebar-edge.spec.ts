import { expect, test, type Page } from '@playwright/test';

/**
 * Page titles start on the same left edge as the page sidebar's item content
 * (--page-edge-inset). Marketplace used to inset its title by the 96px macOS
 * traffic-light gutter, although pages sit right of the rail under the top
 * bar, so the title landed ~76px right of Browse / Installed / Submit.
 */

const SHELL = '/desktop-alt.html?window=desktop-alt&persona=indigo';

async function click(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().click();
}

async function left(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => el.getBoundingClientRect().left);
}

/** Left edge of a row's content: border box plus its own left padding. */
async function contentLeft(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => {
    const box = el.getBoundingClientRect();
    return box.left + parseFloat(getComputedStyle(el).paddingLeft);
  });
}

async function openShell(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(SHELL);
  await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
}

async function pageEdge(page: Page, host: string): Promise<number> {
  const hostLeft = await left(page, host);
  const inset = await page
    .locator(host)
    .evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--page-edge-inset')));
  return hostLeft + inset;
}

test.describe('page headers align with the sidebar item edge', () => {
  test('Marketplace title starts on the Browse row content edge', async ({ page }) => {
    await openShell(page);
    await click(page, '[data-testid="rail-marketplace"]');
    await expect(page.getByTestId('library-overlay-title')).toBeVisible();
    const title = await left(page, '[data-testid="library-overlay-title"]');
    const row = await contentLeft(page, '.lo-nav-row');
    expect(Math.abs(title - row), `title ${title} vs row ${row}`).toBeLessThanOrEqual(1);
    expect(Math.abs(title - (await pageEdge(page, '[data-testid="marketplace-host"]')))).toBeLessThanOrEqual(1);
  });

  // Settings leads with the Back pill, so the header's first item is the one
  // that sits on the edge; the title follows it.
  test('Settings header starts on the nav item content edge', async ({ page }) => {
    await openShell(page);
    await click(page, '[data-testid="rail-you"]');
    await click(page, '[data-testid="account-settings"]');
    await expect(page.getByTestId('settings-host')).toBeVisible();
    const title = await left(page, '[data-testid="settings-host"] [data-testid="page-header"] > :first-child');
    const row = await contentLeft(page, '.ss-nav-item');
    expect(Math.abs(title - row), `title ${title} vs row ${row}`).toBeLessThanOrEqual(1);
  });

  test('Deployments title starts on the shared page edge', async ({ page }) => {
    await openShell(page);
    await click(page, '[data-testid="rail-deployments"]');
    await expect(page.getByTestId('personal-deployments')).toBeVisible();
    const title = await left(page, '[data-testid="personal-deployments"] h1');
    const host = page.getByTestId('personal-deployments');
    const edge =
      (await host.evaluate((el) => el.getBoundingClientRect().left)) +
      (await host.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--page-edge-inset'))));
    expect(Math.abs(title - edge), `title ${title} vs page edge ${edge}`).toBeLessThanOrEqual(1);
  });
});
