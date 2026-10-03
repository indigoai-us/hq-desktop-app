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
 * BLANK-2: under denied, failed and hanging reads, a surface that shows its
 * failed-read line must not also show its true-empty copy or a zero count
 * ("No people yet", "0 objectives", "Connect your calendar"), which would
 * make a failed read look like an empty company.
 *
 * Time: settled conditions reuse one page per condition and walk the
 * destinations on it; only the hanging case needs a fresh page per
 * destination (each waits out the bound), and it runs in one browser.
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
  /** Failed-read line shown together with true-empty copy or a zero count. */
  emptyBesideError: string | null;
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
  const failedLine = [...main.querySelectorAll('[role="alert"]')].some(visible)
    || /\b(Couldn't|Could not|could not) (read|load|reach)\b|didn't load/.test(text);
  // True-empty copy and zero counts: "No people yet", "0 objectives",
  // "Secrets · 0", "Personal 0", "Nothing yet", "Connect your calendar".
  const empty = text.match(
    /\bNo (?!report\b)[a-z ]{2,40}\byet\b|\bNo calendar\b|\b0 (?!of\b)[a-z]+\b|· 0\b|\b[A-Z][a-z]+ 0\b|\bNothing (yet|live|deployed yet|scheduled)\b|Nobody is working|Connect your calendar/,
  );
  const emptyBesideError = failedLine && empty ? empty[0] : null;
  return { text: text.length, controls, loading, sample: text.slice(0, 120), emptyBesideError };
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
        return blank || last.loading.length > 0 || last.emptyBesideError ? 'unsettled' : 'settled';
      },
      { timeout: SETTLE_MS, intervals: [250, 500, 1000] },
    )
    .toBe('settled')
    .catch(() => {
      const why = last?.emptyBesideError
        ? `shows "${last.emptyBesideError}" next to its failed-read line`
        : 'is blank or still loading after the bound';
      throw new Error(`${label} ${why}: ${JSON.stringify(last)}`);
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

test.describe('BLANK-1/2: no blank screens, no endless loading, no empty copy beside a failed read', () => {
  for (const condition of CONDITIONS) {
    const hanging = condition.includes('reads=hang');
    test(condition, async ({ browser, page, browserName }) => {
      // The hanging case waits out the bound per destination; the bound is a
      // product timer, not an engine behavior, so one browser covers it.
      test.skip(hanging && browserName !== 'chromium', 'hanging reads are checked in Chromium');
      test.setTimeout(240_000);
      await boot(page, condition);
      const dests = await destinations(page);
      expect(dests.length, 'destinations found').toBeGreaterThan(3);
      const failures: string[] = [];
      if (!hanging) {
        // Settled reads answer at once, so one page walks every destination.
        for (const dest of dests) {
          await open(page, dest);
          await expectSettled(page, `${dest} under ${condition}`).catch((err) => failures.push(String(err?.message ?? err)));
        }
        expect(failures, failures.join('\n')).toEqual([]);
        return;
      }
      // Hanging reads each wait out the bound from a fresh page, side by side.
      const width = 6;
      for (let i = 0; i < dests.length; i += width) {
        const batch = dests.slice(i, i + width);
        const results = await Promise.allSettled(batch.map((dest) => checkOne(browser, condition, dest)));
        for (const r of results) if (r.status === 'rejected') failures.push(String(r.reason?.message ?? r.reason));
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });
  }
});
