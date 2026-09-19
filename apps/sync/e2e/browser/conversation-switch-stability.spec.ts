import { expect, test, type Page } from '@playwright/test';

/**
 * Switching conversations must not move anything.
 *
 * The reported symptom was "a bit of layout shift as things load; usually it
 * has to scroll down a bit at the end". Two separate defects produced it: the
 * thread was not anchored to the bottom on the frame its rows mounted, and
 * nothing re-anchored it when content grew afterwards (reactions, avatars,
 * late markdown), so the newest message walked off the bottom edge.
 *
 * The stage is `?view=switch-stability` — the real `ChannelConversation` in a
 * real browser with three conversations, a delayed first open and a late
 * growth on the newest row. See `dev-harness/SwitchStabilityHarness.svelte`.
 *
 * These assertions are frame-level on purpose. "It ends up in the right place"
 * is not the property under test; "it was never in the wrong place" is.
 */

const stage = '/switch-stability.html';
/** Matches the harness defaults; the spec waits past both. */
const GROWTH_MS = 250;
/** A scroller within this many px of the bottom is anchored. */
const ANCHOR_TOLERANCE_PX = 2;

interface Box { x: number; y: number; width: number; height: number }
interface Sample {
  rows: number;
  distance: number;
  scrollHeight: number;
  header: Box | null;
  composer: Box | null;
  lastRowBottom: number | null;
  threadBottom: number | null;
}

declare global {
  interface Window {
    __samples?: Sample[];
    __firstRowsSample?: Sample | null;
    __rafId?: number;
  }
}

/** Record one sample per animation frame until `stopSampling`. */
async function startSampling(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__samples = [];
    window.__firstRowsSample = null;
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    };
    const frame = () => {
      const thread = document.querySelector('[data-testid="conversation-thread"]');
      if (thread) {
        const rows = document.querySelectorAll('[data-testid="conversation-thread"] .dm-msg');
        const last = rows[rows.length - 1] ?? null;
        const sample: Sample = {
          rows: rows.length,
          distance: Math.round(thread.scrollHeight - thread.scrollTop - thread.clientHeight),
          scrollHeight: Math.round(thread.scrollHeight),
          header: box(document.querySelector('[data-testid="switch-header"]')),
          composer: box(document.querySelector('[data-testid="conversation-composer"]')),
          lastRowBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null,
          threadBottom: Math.round(thread.getBoundingClientRect().bottom),
        };
        window.__samples!.push(sample);
        if (!window.__firstRowsSample && sample.rows > 0) window.__firstRowsSample = sample;
      }
      window.__rafId = requestAnimationFrame(frame);
    };
    frame();
  });
}

async function stopSampling(page: Page): Promise<{ samples: Sample[]; first: Sample | null }> {
  return page.evaluate(() => {
    if (window.__rafId) cancelAnimationFrame(window.__rafId);
    return { samples: window.__samples ?? [], first: window.__firstRowsSample ?? null };
  });
}

/**
 * Frames that painted with the thread off the bottom.
 *
 * A frame whose content height differs from the previous frame's is excluded,
 * and the exclusion is not a fudge. The browser's frame order is: rAF
 * callbacks, then style, then layout, then ResizeObserver delivery, then
 * paint. This sampler runs in rAF, so on the frame where content grows it
 * reads the scroller BEFORE the component's ResizeObserver re-pins it — the
 * correction lands later in that same frame and the frame paints anchored.
 * `the switch scores no layout shift` is the independent check that no such
 * frame ever reaches the screen in the wrong place.
 */
function unanchoredFrames(samples: Sample[], tolerance: number): Sample[] {
  return samples.filter((sample, index) => {
    if (sample.rows === 0 || sample.distance <= tolerance) return false;
    const previous = samples[index - 1];
    return !previous || previous.scrollHeight === sample.scrollHeight;
  });
}

/**
 * Frames where the newest message hung below the bottom of the scroller.
 * Same rAF-versus-ResizeObserver caveat as `unanchoredFrames`: the frame in
 * which the content grows is read before the re-pin lands, so it is excluded.
 */
function belowTheFold(samples: Sample[]): Sample[] {
  return samples.filter((sample, index) => {
    if (sample.rows === 0 || sample.lastRowBottom === null) return false;
    if (sample.threadBottom === null) return false;
    if (sample.lastRowBottom <= sample.threadBottom) return false;
    const previous = samples[index - 1];
    return !previous || previous.scrollHeight === sample.scrollHeight;
  });
}

/** Distinct values of one field across every frame that had rows. */
function distinct<T>(samples: Sample[], pick: (s: Sample) => T): string[] {
  const seen = new Set<string>();
  for (const sample of samples) {
    if (sample.rows === 0) continue;
    const value = pick(sample);
    if (value === null || value === undefined) continue;
    seen.add(JSON.stringify(value));
  }
  return [...seen];
}

async function openStage(page: Page): Promise<void> {
  await page.goto(stage);
  await expect(page.getByTestId('switch-stage')).toBeVisible();
  // Alpha opens on mount and answers after the fetch delay.
  await expect.poll(() => page.locator('[data-testid="conversation-thread"] .dm-msg').count())
    .toBeGreaterThan(0);
  await page.waitForTimeout(GROWTH_MS + 250);
}

test('a conversation switch lands anchored, and nothing moves while late content resolves', async ({ page }) => {
  await openStage(page);

  await startSampling(page);
  await page.getByTestId('switch-to-bravo').click();
  // Past the fetch AND past the late growth, so the whole settle is sampled.
  await page.waitForTimeout(GROWTH_MS + 600);
  const { samples, first } = await stopSampling(page);

  expect(samples.length).toBeGreaterThan(5);
  expect(first).not.toBeNull();

  // 1. Anchored on the very first frame the rows exist — no settle animation,
  //    no "scroll again later" correction.
  expect(first!.distance).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);

  // 2. Anchored on EVERY frame after that. A single frame off the bottom is
  //    the jump the reader sees.
  const offBottom = unanchoredFrames(samples, ANCHOR_TOLERANCE_PX);
  expect(offBottom, `frames not anchored: ${JSON.stringify(offBottom.slice(0, 3))}`).toEqual([]);

  // 3. The header and the composer are fixed shells: one box each, all frames.
  expect(distinct(samples, s => s.header)).toHaveLength(1);
  expect(distinct(samples, s => s.composer)).toHaveLength(1);

  // 4. The newest message stays fully on screen the whole time. When it grows
  //    a reaction bar it gets taller; without the bottom pin the new height
  //    hangs below the fold and the reader has to scroll down to see it.
  expect(belowTheFold(samples)).toEqual([]);
});

test('reopening a conversation paints its rows already anchored', async ({ page }) => {
  await openStage(page);
  await page.getByTestId('switch-to-bravo').click();
  await expect.poll(() => page.locator('[data-testid="conversation-thread"] .dm-msg').count())
    .toBeGreaterThan(0);
  await page.waitForTimeout(GROWTH_MS + 250);

  // Back to alpha, which the harness now serves from its cache with no delay —
  // the shell's cached-switch path. The first frame with rows must already be
  // the finished frame.
  await startSampling(page);
  await page.getByTestId('switch-to-alpha').click();
  await page.waitForTimeout(GROWTH_MS + 600);
  const { samples, first } = await stopSampling(page);

  expect(first).not.toBeNull();
  expect(first!.distance).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);
  expect(unanchoredFrames(samples, ANCHOR_TOLERANCE_PX)).toEqual([]);
  expect(belowTheFold(samples)).toEqual([]);
});

test('clicking through three conversations quickly ends on the last one, anchored', async ({ page }) => {
  await openStage(page);

  const thread = page.getByTestId('conversation-thread');
  await page.getByTestId('switch-to-alpha').click();
  await page.getByTestId('switch-to-bravo').click();
  await page.getByTestId('switch-to-charlie').click();

  await expect(page.getByTestId('switch-header')).toHaveText('charlie');
  await expect.poll(() => thread.locator('.dm-msg').count()).toBeGreaterThan(0);
  await page.waitForTimeout(GROWTH_MS + 600);

  // No stale conversation painted into the newer one.
  const bodies = await thread.locator('.dm-msg').allTextContents();
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.some(text => text.includes('alpha message'))).toBe(false);
  expect(bodies.some(text => text.includes('bravo message'))).toBe(false);
  expect(bodies.some(text => text.includes('charlie message'))).toBe(true);

  // And it is anchored, not left wherever the interrupted switches put it.
  const distance = await thread.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
  expect(distance).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);
});

test('a reader who has scrolled up is not yanked when late content lands', async ({ page }) => {
  await openStage(page);

  await startSampling(page);
  await page.getByTestId('switch-to-bravo').click();
  await expect.poll(() => page.locator('[data-testid="conversation-thread"] .dm-msg').count())
    .toBeGreaterThan(0);

  // Park mid-thread, not at the very top: the top edge is the "load earlier
  // messages" trigger, and that prepend legitimately moves the offset.
  const thread = page.getByTestId('conversation-thread');
  await thread.evaluate(el => { el.scrollTop = Math.round(el.scrollHeight / 2); });
  const parked = await thread.evaluate(el => el.scrollTop);
  expect(parked).toBeGreaterThan(0);
  // Past the late growth, which is what would drag them down.
  await page.waitForTimeout(GROWTH_MS + 600);
  await stopSampling(page);

  expect(await thread.evaluate(el => el.scrollTop)).toBe(parked);
});

/**
 * The short-thread case, which the 40-message tests cannot cover.
 *
 * A thread taller than its pane is anchored by the scroll offset, so
 * `justify-content` on the content box is inert there — flipping it to
 * `flex-start` leaves every test above passing. A thread SHORTER than the pane
 * has no scroll offset to set, and is held against the composer purely by the
 * content box being at least as tall as the scroller and packing its rows at
 * the end. That is the structural half of the anchoring, and this is the only
 * test that fails if it is removed.
 */
test('a thread shorter than the pane still sits against the composer', async ({ page }) => {
  await page.goto(`${stage}?messages=3`);
  await expect(page.getByTestId('switch-stage')).toBeVisible();
  const thread = page.getByTestId('conversation-thread');
  await expect.poll(() => thread.locator('.dm-msg').count()).toBe(3);
  await page.waitForTimeout(GROWTH_MS + 400);

  const geometry = await thread.evaluate(el => {
    const rows = el.querySelectorAll('.dm-msg');
    const last = rows[rows.length - 1]!;
    return {
      overflows: el.scrollHeight > el.clientHeight + 1,
      scrollTop: Math.round(el.scrollTop),
      // Gap between the newest row and the bottom of the pane. The thread's
      // own bottom padding lives in here, so this is a band, not zero.
      gap: Math.round(el.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom),
      paneHeight: Math.round(el.clientHeight),
    };
  });

  // Precondition: three rows cannot fill the pane. If they somehow do, the
  // assertion below would be testing the overflow case by accident.
  expect(geometry.overflows).toBe(false);
  expect(geometry.scrollTop).toBe(0);
  // Bottom-packed, not top-packed. Top-packed would leave most of the pane
  // below the rows; the ceiling here is generous but far under that.
  expect(geometry.gap).toBeLessThan(40);
  expect(geometry.gap).toBeLessThan(geometry.paneHeight / 3);
});

test('the switch scores no layout shift', async ({ page, browserName }) => {
  // PerformanceObserver('layout-shift') is Chromium-only; the bounding-box
  // assertions above are the cross-browser form of the same claim.
  test.skip(browserName !== 'chromium', 'layout-shift entries are Chromium-only');
  await openStage(page);

  await page.evaluate(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver(list => {
      for (const entry of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) {
        if (!entry.hadRecentInput) (window as unknown as { __cls: number }).__cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: false });
  });

  await page.getByTestId('switch-to-bravo').click();
  await page.waitForTimeout(GROWTH_MS + 600);
  await page.getByTestId('switch-to-charlie').click();
  await page.waitForTimeout(GROWTH_MS + 600);

  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  expect(cls).toBe(0);
});
