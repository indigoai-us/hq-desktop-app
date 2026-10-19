import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { E2E_HQ_ROOT } from './hq-root';

/**
 * The first view is the Daily Brief page itself, drawn from Core's welcome
 * output on the design harness (?view=first-view). The owner's frame rules,
 * at three window sizes in both app themes: the sunrise and the Connect card
 * are on screen, row 3 can be scrolled to, nothing reads "0 companies" or
 * "Nothing is owed today", an imported HQ never asks to bring past work in,
 * a harness found on this Mac is never offered Connect, and the Connect rows
 * show their status words in full.
 */

const SIZES = [
  { width: 1024, height: 640 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;
const THEMES = ['dark', 'light'] as const;

async function openFirstView(page: Page, size: { width: number; height: number }, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize(size);
  await page.goto(`/dev-harness/index.html?view=first-view&${query}`);
  await expect(page.getByTestId('first-view-grid')).toBeVisible({ timeout: 30_000 });
  return errors;
}

/** The Daily Brief's background token (`--b-bg` in brief.css) per app theme, as computed. */
const BG = { dark: 'rgb(13, 13, 15)', light: 'rgb(235, 235, 238)' } as const;

/** Relative luminance (0 black to 1 white) of a computed `rgb()`/`rgba()` colour. */
function luminance(color: string): number {
  const [r, g, b] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((c) => {
    const v = Number(c) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const slot = (page: Page, widget: string): Locator => page.locator(`[data-testid="first-view-grid"] > [data-widget="${widget}"]`);

/** Scrolls the page's own frame until the element's bottom edge is in the window, then reports whether it is. */
async function bottomReachable(page: Page, el: Locator): Promise<boolean> {
  await el.evaluate((node) => node.scrollIntoView({ block: 'end' }));
  const box = await el.boundingBox();
  const vh = page.viewportSize()!.height;
  return !!box && box.y + box.height <= vh + 1 && box.y + box.height > 0;
}

for (const theme of THEMES) {
  for (const size of SIZES) {
    test(`first view at ${size.width}x${size.height}, ${theme} theme, keeps the owner frame rules`, async ({ page }) => {
      const errors = await openFirstView(page, size, `theme=${theme}`);
      const grid = page.getByTestId('first-view-grid');

      // The Connect card starts above the fold, before any scrolling.
      const connect = slot(page, 'connect');
      await expect(connect).toBeVisible();
      const connectTop = (await connect.boundingBox())!.y;
      expect(connectTop).toBeLessThan(size.height);

      // The sunrise's bottom edge is on screen or a scroll away.
      expect(await bottomReachable(page, slot(page, 'sunrise'))).toBe(true);

      // Row 3 (the last row of the grid) can be scrolled to.
      const slots = grid.locator(':scope > .fv-slot');
      const last = slots.nth((await slots.count()) - 1);
      expect(await bottomReachable(page, last)).toBe(true);
      expect(await slots.count()).toBeGreaterThanOrEqual(3);

      // Copy that must never show on the first view.
      const scroller = page.getByTestId('first-view-scroller');
      await expect(scroller.getByText('Bring in your past work')).toHaveCount(0);
      await expect(scroller.getByText('Nothing is owed today')).toHaveCount(0);
      await expect(scroller.getByText(/\b0 companies\b/)).toHaveCount(0);

      // A harness found on this Mac shows Open or Connected, never Connect.
      const found = page.locator('[data-testid="first-view-connect-row"][data-found="true"]');
      expect(await found.count()).toBeGreaterThan(0);
      for (const row of await found.all()) {
        await expect(row.getByRole('button', { name: 'Connect' })).toHaveCount(0);
        await expect(row.getByText('Found on this Mac', { exact: true })).toBeVisible();
      }

      // Every Connect row's status reads in full, without an ellipsis or clipping.
      const notes = page.locator('[data-testid="first-view-connect-row"] .fv-note');
      expect(await notes.count()).toBeGreaterThan(0);
      for (const note of await notes.all()) {
        const text = (await note.textContent())?.trim();
        expect(['Found on this Mac', 'Not connected yet']).toContain(text);
        const clipped = await note.evaluate((n) => n.scrollWidth > n.clientWidth + 1);
        expect(clipped, `"${text}" is clipped`).toBe(false);
      }

      // No card is stretched far past its content (the quiet-day min-height once made every card a screen tall).
      for (const widget of ['connect', 'oneThing', 'focus', 'risk']) {
        const empty = await slot(page, widget).locator('.w').first().evaluate((card) => {
          const leaves = [...card.querySelectorAll('*')].filter((n) => n.childElementCount === 0 && n.getBoundingClientRect().height > 0);
          const contentBottom = Math.max(...leaves.map((n) => n.getBoundingClientRect().bottom));
          const padding = parseFloat(getComputedStyle(card).paddingBottom) || 0;
          return card.getBoundingClientRect().bottom - padding - contentBottom;
        });
        expect(empty, `${widget} has ${Math.round(empty)}px empty below its content`).toBeLessThan(120);
      }

      // The report's ground is the brief's own background token, so no lighter frame shows around the brief.
      const grounds = await page.evaluate(() => {
        const bg = (sel: string) => getComputedStyle(document.querySelector(sel)!).backgroundColor;
        return { welcome: bg('.welcome'), brief: bg('.daily-brief') };
      });
      expect(grounds.welcome).toBe(BG[theme]);
      expect(grounds.brief).toBe(BG[theme]);
      // The sunrise card stays dark in both app themes.
      const sunrise = await slot(page, 'sunrise').locator('.w').first().evaluate((card) => getComputedStyle(card).backgroundColor);
      expect(luminance(sunrise), `sunrise card ${sunrise}`).toBeLessThan(0.2);
      // The where slot has no semicircle (the orbit that used to bleed off its corner).
      await expect(page.getByTestId('brief-next')).toBeVisible();
      await expect(page.locator('[data-testid="first-view-scroller"] svg.orbit')).toHaveCount(0);

      expect(errors).toEqual([]);
    });
  }
}

test('the page scrolls in a window shorter than 560px', async ({ page }) => {
  const errors = await openFirstView(page, { width: 1024, height: 500 }, 'theme=dark');
  const scroller = page.getByTestId('first-view-scroller');
  const overflow = await scroller.evaluate((n) => n.scrollHeight - n.clientHeight);
  expect(overflow).toBeGreaterThan(0);
  expect(await bottomReachable(page, slot(page, 'sunrise'))).toBe(true);
  expect(errors).toEqual([]);
});

test('the loading rise keeps the sunrise on screen at 1024x640', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.goto('/dev-harness/index.html?view=first-view&theme=light&rise=2');
  const rise = page.getByTestId('brief-rise');
  await expect(rise).toBeVisible({ timeout: 30_000 });
  expect(await bottomReachable(page, rise)).toBe(true);
  await expect(page.getByText('Nothing is owed today')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Connect opens the existing Settings page instead of a new panel', async ({ page }) => {
  const errors = await openFirstView(page, { width: 1440, height: 900 }, 'theme=dark');
  await expect(page.getByTestId('first-view-grid')).toHaveAttribute('data-connect-mode', 'settings');
  const connectButton = page.locator('[data-testid="first-view-connect-row"]').getByRole('button', { name: 'Connect' }).first();
  await connectButton.click();
  await expect(page.locator('body')).toHaveAttribute('data-first-view-opened', /^(integrations|ai-apps)$/);
  expect(errors).toEqual([]);
});

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/ui/src/brief/fixtures');
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

/** Writes a file whole: a reader (the preview server, or the other browser's run) never sees half of it. */
function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

test('the count line comes from the import report on disk, read through the app loader', async ({ page }) => {
  // The import report as the desktop's tree step writes it (#1719): a dashed
  // UTC stamp folder under workspace/imports holding report.json, 402 sessions over 37 days.
  const report = fixture('import-report-desktop.json').report;
  expect(report.sessions).toMatchObject({ total: 402, days_seen: 37 });
  put(join(E2E_HQ_ROOT, 'workspace/imports/2026-10-19T08-12-30/report.json'), JSON.stringify(report, null, 2));
  // An older report with a smaller count: the loader must pick the newest folder, not this one.
  put(
    join(E2E_HQ_ROOT, 'workspace/imports/20261001T080000Z/report.json'),
    JSON.stringify({ ...report, sessions: { ...report.sessions, total: 12, days_seen: 3 } }),
  );

  // The brief run holds only the 16.0.30 welcome row, which saw 1 session.
  const run = 'brief-20261019-090000';
  const welcome = { ...fixture('welcome-16030-legacy.json').welcome, sessions: { total: 1, claude: 1, codex: 0, days_seen: 1 } };
  put(join(E2E_HQ_ROOT, 'workspace/brief', run, 'brief.json'), JSON.stringify({ items: [], welcome }));
  put(join(E2E_HQ_ROOT, 'workspace/brief', run, 'brief-data.json'), '{}');
  put(
    join(E2E_HQ_ROOT, 'workspace/brief/index.jsonl'),
    `${JSON.stringify({ run_id: run, created_at: '2026-10-19T16:00:00Z', state: 'ready', catch_up: false, lead: 'decisions', counts: { decisions: 0, shipped: 0, incidents: 0 }, headline: 'Your first brief' })}\n`,
  );

  // ?hq=1: the runs page reads the run from that folder and the import report
  // through the `latest_import_report` loader; no first-view data is injected.
  const errors = await openFirstView(page, { width: 1440, height: 900 }, 'hq=1&theme=dark');
  const count = page.getByTestId('first-view-count-line');
  await expect(count).toContainText('402 sessions over 37 days');
  await expect(count).not.toContainText('1 session');

  // The suggested integrations (GitHub, Linear and Slack, found on this Mac) show as Connect rows.
  const rows = page.locator('[data-testid="first-view-connect-row"][data-integration]');
  await expect(rows).toHaveCount(3);
  for (const name of ['GitHub', 'Linear', 'Slack']) {
    await expect(page.getByRole('button', { name: `Connect ${name}` })).toBeVisible();
  }
  expect(errors).toEqual([]);
});
