import { expect, test, type Page } from '@playwright/test';

/**
 * Team member rows: the presence badge sits outside the avatar and clear of
 * the name, bots show art instead of initials, and names are not cut short
 * when the profile pane narrows the list.
 */

const SHELL = '/desktop-alt.html?window=desktop-alt&persona=indigo';

type Box = { x: number; y: number; width: number; height: number };

async function openTeam(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(SHELL);
  await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-testid="rail-company"]').first().click();
  await page.locator('[data-row-id="team"]').first().click();
  await expect(page.getByTestId('team-row').first()).toBeVisible();
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test('presence badges sit outside the avatar and clear of the name', async ({ page }) => {
  await openTeam(page);
  const rows = page.getByTestId('team-row');
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    const avatar = row.getByTestId('team-avatar');
    const badge = avatar.getByTestId('avatar-presence');
    const name = row.locator('.nm');
    const [a, b, n] = await Promise.all([avatar.boundingBox(), badge.boundingBox(), name.boundingBox()]);
    expect(a && b && n).toBeTruthy();
    expect(overlaps(b!, n!), `badge overlaps name in row ${i}`).toBe(false);
    // The badge's centre lies beyond the avatar's inscribed circle.
    const cx = a!.x + a!.width / 2;
    const cy = a!.y + a!.height / 2;
    const bx = b!.x + b!.width / 2;
    const by = b!.y + b!.height / 2;
    const distance = Math.hypot(bx - cx, by - cy);
    expect(distance + b!.width / 2, `badge sits inside avatar in row ${i}`).toBeGreaterThan(a!.width / 2);
    expect(distance, `badge centre inside avatar in row ${i}`).toBeGreaterThanOrEqual(a!.width / 2);
  }
});

test('bots never show initials', async ({ page }) => {
  await openTeam(page);
  const botAvatars = page.locator('[data-testid="team-avatar"].bot');
  const count = await botAvatars.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i += 1) {
    await expect(botAvatars.nth(i)).not.toHaveAttribute('data-face', 'initials');
  }
});

test('names are not cut short when the profile pane narrows the list', async ({ page }) => {
  await openTeam(page);
  await page.getByTestId('team-row').first().locator('.row-main').click();
  await expect(page.getByTestId('team-profile-pane')).toBeVisible();
  const names = page.locator('[data-testid="team-row"] .nm');
  const count = await names.count();
  for (let i = 0; i < count; i += 1) {
    const clipped = await names.nth(i).evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped, `name ${i} is truncated`).toBe(false);
  }
});
