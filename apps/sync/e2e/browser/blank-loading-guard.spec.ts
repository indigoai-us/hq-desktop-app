import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * BLANK-1 guard: no blank screens and no endless loading.
 *
 * Mounts every rail destination and every company tab in the preview harness
 * as a non-owner member (gates off) under denied, failed, hanging and empty
 * reads, and as a brand-new account with nothing yet. After the shared read
 * bound each content region must show text or a control, and no loading
 * placeholder may remain.
 *
 * Bound: pages fall to their failed state after READ_DEADLINE_MS (12 s,
 * packages/ui/src/common/read-deadline.ts); the company map has its own 15 s
 * refresh bound (ATLAS_REFRESH_TIMEOUT_MS). The poll allows a little more.
 */

const SHELL = '/desktop-alt.html?window=desktop-alt&theme=light';
const SETTLE_MS = 17_000;
/** Overlays and menus, not destinations. */
const NOT_DESTINATIONS = new Set(['rail-more-companies', 'rail-you', 'company:invite-teammate']);

const CONDITIONS = [
  'persona=member&reads=denied',
  'persona=member&reads=fail',
  'persona=member&reads=empty',
  'persona=member&reads=hang',
  'persona=new-account',
];

interface ContentState {
  text: number;
  controls: number;
  loading: string[];
  sample: string;
}

function measure(): ContentState {
  const main = document.querySelector('main.desktop-main') ?? document.body;
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const text = ((main as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim();
  const controls = [...main.querySelectorAll('button,a[href],input,select,textarea,[role=button]')].filter(visible).length;
  const loading = [
    ...main.querySelectorAll(
      '[aria-busy="true"],[data-testid*="loading" i],[data-testid*="skeleton" i],[data-testid*="shimmer" i],[class*="skeleton" i],[class*="shimmer" i],[class*="spinner" i],[aria-label^="Loading"]',
    ),
  ]
    .filter(visible)
    .map((el) => el.getAttribute('data-testid') || el.className.toString().slice(0, 40));
  if (/\bLoading\b|Reading [a-z]+…|Indexing…/.test(text)) loading.push(`text:${text.match(/\bLoading\b|Reading [a-z]+…|Indexing…/)![0]}`);
  return { text: text.length, controls, loading, sample: text.slice(0, 120) };
}

async function boot(page: Page, condition: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${SHELL}&${condition}`);
  await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
}

async function destinations(page: Page): Promise<string[]> {
  const rail = await page.$$eval('[data-testid="app-rail"] [data-testid^="rail-"]', (els) =>
    els.filter((e) => e.tagName === 'BUTTON' || e.tagName === 'A').map((e) => e.getAttribute('data-testid')!),
  );
  const out: string[] = [];
  for (const id of rail) {
    if (NOT_DESTINATIONS.has(id)) continue;
    out.push(id);
    if (id === 'rail-company') {
      await open(page, id);
      const tabs = await page.$$eval('[data-row-id]', (els) => els.map((e) => e.getAttribute('data-row-id')!));
      for (const tab of new Set(tabs)) if (!NOT_DESTINATIONS.has(`company:${tab}`)) out.push(`company:${tab}`);
    }
  }
  return out;
}

async function open(page: Page, dest: string): Promise<void> {
  await page.keyboard.press('Escape');
  if (dest.startsWith('company:')) {
    await page.evaluate(() => (document.querySelector('[data-testid="rail-company"]') as HTMLElement | null)?.click());
    await page.waitForSelector('[data-row-id]');
    await page.evaluate((tab) => (document.querySelector(`[data-row-id="${tab}"]`) as HTMLElement | null)?.click(), dest.slice(8));
  } else {
    await page.evaluate((id) => (document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null)?.click(), dest);
  }
}

async function expectSettled(page: Page, label: string): Promise<void> {
  let last: ContentState | null = null;
  await expect
    .poll(
      async () => {
        last = await page.evaluate(measure);
        const blank = last.text < 20 && last.controls === 0;
        return blank || last.loading.length > 0 ? 'unsettled' : 'settled';
      },
      { timeout: SETTLE_MS, intervals: [250, 500, 1000] },
    )
    .toBe('settled')
    .catch(() => {
      throw new Error(`${label} is blank or still loading after the bound: ${JSON.stringify(last)}`);
    });
}

async function checkOne(browser: Browser, condition: string, dest: string): Promise<void> {
  const page = await browser.newPage();
  try {
    await boot(page, condition);
    await open(page, dest);
    await expectSettled(page, `${dest} under ${condition}`);
  } finally {
    await page.close();
  }
}

test.describe('BLANK-1: no blank screens and no endless loading', () => {
  for (const condition of CONDITIONS) {
    test(condition, async ({ browser, page }) => {
      test.setTimeout(240_000);
      await boot(page, condition);
      const dests = await destinations(page);
      expect(dests.length, 'destinations found').toBeGreaterThan(3);
      // Hanging reads each wait out the bound, so they run side by side.
      const width = condition.includes('reads=hang') ? 6 : 1;
      const failures: string[] = [];
      for (let i = 0; i < dests.length; i += width) {
        const batch = dests.slice(i, i + width);
        const results = await Promise.allSettled(batch.map((dest) => checkOne(browser, condition, dest)));
        for (const r of results) if (r.status === 'rejected') failures.push(String(r.reason?.message ?? r.reason));
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });
  }
});
