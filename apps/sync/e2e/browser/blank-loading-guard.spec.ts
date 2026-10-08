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
 * BLANK-3 (owner, 2026-10-03): no timer turns a pending read into a failure.
 * Under hanging reads every surface that is waiting shows the shared loader
 * (ReadLoader) within 1 s, a rotating waiting line by LOADING_MESSAGE_AFTER_MS
 * (3 s) and a quiet Try again by LOADING_RETRY_AFTER_MS (60 s); it never shows
 * a failed line and is never blank. A surface may instead settle (nothing to
 * wait for), but it may not sit on bare loading placeholders without the
 * loader. Under slow reads (20 s) the data renders when it arrives.
 * packages/ui/src/common/read-deadline.ts holds the thresholds.
 */

const SHELL = '/desktop-alt.html?window=desktop-alt&theme=light';
const SETTLE_MS = 17_000;
const LOADER_MS = 1_000;
const MESSAGE_MS = 3_000 + 2_000;
const RETRY_MS = 60_000 + 5_000;
const SLOW_MS = 20_000;
/** A page may chain a few reads, each slowed by SLOW_MS (company lookup, listing, file reads). */
const SLOW_CHAIN_MS = SLOW_MS * 5 + 10_000;
/** Overlays and menus, not destinations. */
const NOT_DESTINATIONS = new Set(['rail-more-companies', 'rail-you', 'company:invite-teammate']);

const CONDITIONS = [
  'persona=member&reads=denied',
  'persona=member&reads=fail',
  'persona=member&reads=empty',
  'persona=member&reads=hang',
  `persona=member&reads=slow&loadingMs=${SLOW_MS}`,
  'persona=new-account',
];

interface ContentState {
  text: number;
  /** Shared loaders (ReadLoader) visible, with message and Try again state. */
  loaders: number;
  messages: number;
  retries: number;
  failedLine: boolean;
  /** Failed-read copy in the text ("Could not read", "took too long"), not an availability note. */
  failedText: boolean;
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
  const loaders = [...main.querySelectorAll('.read-loader')].filter(visible);
  return {
    text: text.length,
    loaders: loaders.length,
    messages: loaders.filter((l) => l.querySelector('[data-testid$="-message"]')).length,
    retries: loaders.filter((l) => l.querySelector('button')).length,
    failedLine,
    failedText: /\b(Couldn't|Could not|could not) (read|load|reach)\b|didn't load|took too long/.test(text),
    controls,
    loading,
    sample: text.slice(0, 120),
    emptyBesideError,
  };
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

/** Poll until `ok` holds, or fail with the last state. */
async function expectState(page: Page, label: string, timeout: number, ok: (s: ContentState) => boolean): Promise<ContentState> {
  let last: ContentState | null = null;
  await expect
    .poll(async () => {
      last = await page.evaluate(measure);
      return ok(last);
    }, { timeout, intervals: [100, 250, 500, 1000] })
    .toBe(true)
    .catch(() => {
      throw new Error(`${label}: ${JSON.stringify(last)}`);
    });
  return last!;
}

/**
 * BLANK-3 slow contract: the late answer renders, and a surface that loads
 * cleanly at full speed (`baselineFailed` false) does not show a failed line
 * when the same answers come late.
 */
async function checkSlow(browser: Browser, condition: string, dest: string, baselineFailed: boolean): Promise<void> {
  const page = await browser.newPage();
  const label = `${dest} under ${condition}`;
  try {
    await boot(page, condition);
    await open(page, dest);
    const end = await expectState(page, `${label} did not render its data after the slow reads`, SLOW_CHAIN_MS, (s) =>
      s.loaders === 0 && s.loading.length === 0 && !(s.text < 20 && s.controls === 0),
    );
    if (!baselineFailed) expect(end.failedText, `${label} reported a slow read as failed: ${end.sample}`).toBe(false);
  } finally {
    await page.close();
  }
}

/**
 * BLANK-3 hanging contract for one destination: either it settles (nothing
 * to wait for) or it shows the loader at once, a waiting line by the message
 * threshold and Try again by the long limit, never a failed line.
 */
async function checkHanging(browser: Browser, condition: string, dest: string): Promise<void> {
  const page = await browser.newPage();
  const label = `${dest} under ${condition}`;
  try {
    await boot(page, condition);
    await open(page, dest);
    const first = await expectState(page, `${label} shows neither the loader nor content within ${LOADER_MS} ms`, LOADER_MS + 1_500, (s) =>
      s.loaders > 0 || (s.loading.length === 0 && !(s.text < 20 && s.controls === 0)),
    );
    if (first.loaders === 0) {
      // Nothing pending on this surface: it must stay settled, not start a bare placeholder.
      await expectSettled(page, label);
      return;
    }
    // Still waiting: a waiting line by the message threshold and Try again by
    // the long limit. A surface that finishes on its own meanwhile (the setup
    // conversation opens) must land on content, never on a failed line.
    const settled = (s: ContentState) => s.loaders === 0 && s.loading.length === 0 && !(s.text < 20 && s.controls === 0);
    const mid = await expectState(page, `${label} has no waiting line after ${MESSAGE_MS} ms`, MESSAGE_MS, (s) => s.messages > 0 || settled(s));
    const end = settled(mid)
      ? mid
      : await expectState(page, `${label} has no Try again after ${RETRY_MS} ms`, RETRY_MS, (s) => s.retries > 0 || settled(s));
    expect(end.failedText, `${label} turned a pending read into a failure: ${end.sample}`).toBe(false);
  } finally {
    await page.close();
  }
}

test.describe('BLANK-1/2/3: no blank screens, a loader while waiting, no empty copy beside a failed read', () => {
  for (const condition of CONDITIONS) {
    const hanging = condition.includes('reads=hang');
    const slow = condition.includes('reads=slow');
    test(condition, async ({ browser, page, browserName }) => {
      // Hanging and slow reads wait on product timers, not engine behavior,
      // so one browser covers them.
      test.skip((hanging || slow) && browserName !== 'chromium', 'timed reads are checked in Chromium');
      test.setTimeout(hanging || slow ? 600_000 : 240_000);
      await boot(page, condition);
      const dests = await destinations(page);
      expect(dests.length, 'destinations found').toBeGreaterThan(3);
      const failures: string[] = [];
      if (slow) {
        // Baseline: the same persona with reads at full speed. The harness has no
        // answer for some reads (the member Atlas listing), which fail at any speed.
        const failsAtFullSpeed = new Set<string>();
        const fast = await browser.newPage();
        await boot(fast, 'persona=member');
        // Wait for the shared loader to clear too: expectSettled counts a
        // surface with a visible ReadLoader as settled, so measuring then can
        // miss a failure that lands a moment later on a busy machine.
        for (const dest of dests) {
          await open(fast, dest);
          const end = await expectState(fast, `${dest} at full speed`, SETTLE_MS, (s) =>
            s.loaders === 0 && s.loading.length === 0 && !(s.text < 20 && s.controls === 0),
          ).catch(() => null);
          if ((end ?? (await fast.evaluate(measure))).failedText) failsAtFullSpeed.add(dest);
        }
        await fast.close();
        // A read that answers after 20 s renders its data: settled, no failed line.
        const width = 8;
        for (let i = 0; i < dests.length; i += width) {
          const batch = dests.slice(i, i + width);
          const results = await Promise.allSettled(batch.map((dest) => checkSlow(browser, condition, dest, failsAtFullSpeed.has(dest))));
          for (const r of results) if (r.status === 'rejected') failures.push(String(r.reason?.message ?? r.reason));
        }
        expect(failures, failures.join('\n')).toEqual([]);
        return;
      }
      if (!hanging) {
        // Settled reads answer at once, so one page walks every destination.
        for (const dest of dests) {
          await open(page, dest);
          await expectSettled(page, `${dest} under ${condition}`).catch((err) => failures.push(String(err?.message ?? err)));
        }
        expect(failures, failures.join('\n')).toEqual([]);
        return;
      }
      // Hanging reads each wait out the long limit from a fresh page, side by side.
      const width = 8;
      for (let i = 0; i < dests.length; i += width) {
        const batch = dests.slice(i, i + width);
        const results = await Promise.allSettled(batch.map((dest) => checkHanging(browser, condition, dest)));
        for (const r of results) if (r.status === 'rejected') failures.push(String(r.reason?.message ?? r.reason));
      }
      expect(failures, failures.join('\n')).toEqual([]);
    });
  }
});

/**
 * QA-106: a filter or search that matches nothing must say so. Walks every
 * destination as the default (data-rich) persona, clicks each filter tab and
 * types a query no row can match into each search field, and fails when the
 * result shows a zero count or no rows without a no-match line.
 */
const NO_MATCH = 'zzqx-no-such-row';
const NO_MATCH_LINE = /No [a-z ]*match|No matches|No results|Nothing matches|Nothing (here|yet)|No [a-z ]+ yet/i;

async function zeroWithoutLine(page: Page): Promise<string | null> {
  return page.evaluate((src) => {
    const main = document.querySelector('main.desktop-main') as HTMLElement | null;
    if (!main) return null;
    // List counts live in the header meta lines ("0 bots", "0 of 35 bots",
    // "Secrets · 0"); presence counters such as "0 live" are not list counts.
    const zero = [...main.querySelectorAll('[data-meta-line]')]
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .find((t) => /^0( of \d[\d,]*)? (?!live\b|online\b|unread\b)[a-z]+\b|· 0$/.test(t));
    if (!zero) return null;
    const text = (main.innerText || '').replace(/\s+/g, ' ');
    return new RegExp(src, 'i').test(text) ? null : `${zero} | ${text.slice(0, 160)}`;
  }, NO_MATCH_LINE.source);
}

test('QA-106: no zero-result filter or search leaves a blank list', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one browser covers the copy check');
  test.setTimeout(300_000);
  await boot(page, '');
  const dests = await destinations(page);
  const failures: string[] = [];
  for (const dest of dests) {
    await open(page, dest);
    await expectSettled(page, dest).catch(() => {});
    const tabs = await page.$$eval('main.desktop-main [role="tab"]', (els) =>
      els.map((e, i) => ({ i, label: (e.textContent || '').trim() })).filter((t) => t.label),
    );
    for (const tab of tabs) {
      await page.evaluate((i) => (document.querySelectorAll('main.desktop-main [role="tab"]')[i] as HTMLElement | undefined)?.click(), tab.i);
      await page.waitForTimeout(150);
      const bad = await zeroWithoutLine(page);
      if (bad) failures.push(`${dest} filter "${tab.label}": ${bad}`);
    }
    if (tabs.length) await page.evaluate(() => (document.querySelector('main.desktop-main [role="tab"]') as HTMLElement | null)?.click());
    const searches = await page.$$('main.desktop-main input[type="search"], main.desktop-main input[placeholder*="Search" i], main.desktop-main input[placeholder*="Filter" i]');
    for (const input of searches) {
      if (!(await input.isVisible())) continue;
      await input.fill(NO_MATCH);
      await page.waitForTimeout(250);
      const bad = await zeroWithoutLine(page);
      if (bad) failures.push(`${dest} search: ${bad}`);
      await input.fill('');
    }
  }
  expect(failures, failures.join('\n')).toEqual([]);
});
