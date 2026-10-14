import { expect, test, type Page } from '@playwright/test';

/**
 * Team member detail panel: the header never overlaps the access summary,
 * an owner gets one line of truth instead of a grant list, and other members
 * get grants rolled up by source and folder, collapsed, with a search.
 */

const SHELL = '/desktop-alt.html?window=desktop-alt&persona=indigo';

async function openMember(page: Page, uid: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(SHELL);
  await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-testid="rail-company"]').first().click();
  await page.locator('[data-row-id="team"]').first().click();
  await page.getByTestId(`team-open-${uid}`).click();
  await expect(page.getByTestId('member-access')).toBeVisible();
}

test('owner: one line of truth, a Why, and no per-path list', async ({ page }) => {
  await openMember(page, 'prs_corey');
  await expect(page.getByTestId('member-access-everything')).toHaveText(/^Owner: every file and secret in /);
  await expect(page.getByTestId('member-access-group')).toHaveCount(0);
  await expect(page.getByTestId('member-access')).not.toContainText('agents/');
  await page.getByTestId('member-access-why').locator('summary').click();
  await expect(page.getByTestId('member-access-why')).toContainText('core');
});

test('the profile header and the access summary never overlap, even fully expanded', async ({ page }) => {
  await openMember(page, 'prs_maya');
  const summaries = page.locator('[data-testid="member-access-group"] > summary');
  for (let i = 0; i < (await summaries.count()); i += 1) await summaries.nth(i).click();
  const pane = page.getByTestId('team-profile-pane');
  const name = pane.locator('[data-testid="user-profile-pane"] .nm').first();
  const access = page.getByTestId('member-access');
  const [n, a] = await Promise.all([name.boundingBox(), access.boundingBox()]);
  expect(n && a).toBeTruthy();
  expect(a!.y, `access top ${a!.y} vs name bottom ${n!.y + n!.height}`).toBeGreaterThanOrEqual(n!.y + n!.height);
});

test('member: grants roll up by source and folder, collapsed, with a search in long groups', async ({ page }) => {
  await openMember(page, 'prs_maya');
  const groups = page.getByTestId('member-access-group');
  await expect(groups.first()).toBeVisible();
  const projects = groups.filter({ hasText: 'projects/' });
  await expect(projects).toContainText('12 prefixes');
  await expect(projects).toContainText('via Dev Test');
  await expect(projects.locator('ul.rows')).toBeHidden();
  await projects.locator('summary').click();
  const search = projects.getByTestId('member-access-search');
  await search.fill('project-1');
  await expect(projects.locator('ul.rows li')).toHaveCount(4); // 1, 10, 11, 12
  await expect(page.getByTestId('member-access-secrets')).toContainText('stripe/');
});
