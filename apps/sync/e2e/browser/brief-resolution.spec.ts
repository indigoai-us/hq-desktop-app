import { expect, test, type Page } from '@playwright/test';

/**
 * Daily Brief: the way to a brief when the assistant is not running, on the
 * design harness (mocked Tauri, `?state=blocked` = the simulated stopped
 * assistant in brief-demo.ts). The owner's rule (2026-10-23): "there should be
 * a clear resolution path to get assistant running or even alternative backup
 * method". Start it starts the assistant and runs the brief in one press; Run
 * in Claude instead runs the same job in a coding tool.
 */

const BLOCKED = '/dev-harness/index.html?view=brief-design&state=blocked';
const SHOTS = process.env.BRIEF_SHOTS ?? '';

async function openBlocked(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(BLOCKED);
  await expect(page.getByTestId('brief-dawn')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('brief-create').click();
  await expect(page.getByTestId('brief-blocked')).toHaveText('demo is not running.');
  return errors;
}

/** Screenshots for review only (BRIEF_SHOTS=<dir>): wait out the scene's entrance motion first. */
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test.describe('daily brief: assistant not running', () => {
  test('Start it starts the assistant and runs the brief in the same press', async ({ page }) => {
    const errors = await openBlocked(page);
    await expect(page.getByTestId('brief-fix')).toHaveText(/Start it/);
    await expect(page.getByTestId('brief-fallback')).toHaveText(/Run in Claude instead/);
    await shot(page, 'brief-blocked');

    await page.getByTestId('brief-fix').click();
    const step = page.getByTestId('brief-dawn-step');
    await expect(step).toContainText('Starting demo', { timeout: 2_000 });
    await shot(page, 'brief-starting');
    // The demo assistant comes up after a moment; the job goes out without another press.
    await expect(step).toContainText('Sent to demo, waiting for it to start', { timeout: 10_000 });
    await expect(step).toContainText('Sweeping your day', { timeout: 15_000 });
    await expect(page.getByTestId('brief-dawn')).toHaveAttribute('data-phase', 'running');
    await shot(page, 'brief-running-after-start');
    expect(errors).toEqual([]);
  });

  test('Run in Claude instead opens the job in the tool and follows the same run', async ({ page }) => {
    const errors = await openBlocked(page);
    await page.getByTestId('brief-fallback').click();
    const step = page.getByTestId('brief-dawn-step');
    // The simulated tool opens at once, so "Opening Claude…" may already have given way to the wait.
    await expect(step).toContainText(/Opening Claude|Sent to Claude, waiting for it to start/, { timeout: 2_000 });
    await expect(step).toContainText('Sent to Claude, waiting for it to start', { timeout: 5_000 });
    await shot(page, 'brief-fallback-claude');
    await expect(step).toContainText('Sweeping your day', { timeout: 15_000 });
    expect(errors).toEqual([]);
  });
});
