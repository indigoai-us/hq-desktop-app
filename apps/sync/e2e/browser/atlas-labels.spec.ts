import { expect, test } from '@playwright/test';

/**
 * OWNER-D 4 (AUDIT-3-19): Atlas labels stay readable and never overlap. With
 * the populated fixture at 1440x900 and 1000x700, every visible label is at
 * least 13px and no two visible labels intersect. Hidden names come back on
 * hover.
 */
const MIN_LABEL_PX = 13;
// The populated fixture stamps every object 2026-10-01T12:00Z
// (dev-harness/audit-switches.ts), and project dot size decays with that age
// over ATLAS_ACTIVITY_DAYS (14), so with the wall clock the layout shifted day
// by day. Pin the page clock a month later: every project is idle, packed
// small between section names, on every run.
const FIXTURE_NOW = new Date('2026-11-01T12:00:00.000Z');

for (const [width, height] of [[1440, 900], [1000, 700]] as const) {
  test(`Atlas labels at ${width}x${height}: readable, no overlaps`, async ({ page }) => {
    await page.clock.setFixedTime(FIXTURE_NOW);
    await page.setViewportSize({ width, height });
    await page.goto('/desktop-alt.html?window=desktop-alt&theme=light&persona=member&atlas=populated');
    await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => (document.querySelector('[data-testid="rail-company"]') as HTMLElement | null)?.click());
    await expect(page.locator('[data-testid^="atlas-node-"]')).toHaveCount(25, { timeout: 20_000 });
    await expect(page.locator('[data-testid^="atlas-label-"]').first()).toBeVisible();

    const result = await page.evaluate(() => {
      const labels = [...document.querySelectorAll<SVGTextElement>('[data-testid^="atlas-label-"]')]
        .map((el) => ({ id: el.textContent ?? '', box: el.getBoundingClientRect(), px: parseFloat(getComputedStyle(el).fontSize) }))
        .filter((l) => l.box.width > 0 && l.box.height > 0);
      const overlaps: string[] = [];
      for (let i = 0; i < labels.length; i += 1) {
        for (let j = i + 1; j < labels.length; j += 1) {
          const a = labels[i]!.box;
          const b = labels[j]!.box;
          if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
            overlaps.push(`${labels[i]!.id} × ${labels[j]!.id}`);
          }
        }
      }
      return { count: labels.length, overlaps, small: labels.filter((l) => l.px < 13).map((l) => l.id) };
    });
    expect(result.count).toBeGreaterThan(0);
    expect(result.overlaps).toEqual([]);
    expect(result.small, `labels under ${MIN_LABEL_PX}px`).toEqual([]);

    // A name hidden at this zoom appears while its object is hovered.
    const hidden = await page.evaluate(() => {
      const shown = new Set([...document.querySelectorAll('[data-testid^="atlas-label-"]')].map((el) => el.getAttribute('data-testid')!.slice('atlas-label-'.length)));
      const node = [...document.querySelectorAll('[data-atlas-node]')].find((el) => !shown.has(el.getAttribute('data-atlas-node')!));
      return node?.getAttribute('data-atlas-node') ?? null;
    });
    expect(hidden).not.toBeNull();
    await page.locator(`[data-atlas-node="${hidden}"] circle.dot`).hover({ force: true });
    await expect(page.getByTestId(`atlas-label-${hidden}`)).toBeVisible();
  });
}

for (const theme of ['light', 'dark'] as const) {
  // Owner 2026-10-04: sections are packed groups with no drawn circle; each
  // section keeps one name, and item labels never cover it.
  test(`Atlas sections are named once and their names stay uncovered (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`/desktop-alt.html?window=desktop-alt&theme=${theme}&persona=member&atlas=populated`);
    await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => (document.querySelector('[data-testid="rail-company"]') as HTMLElement | null)?.click());
    await expect(page.locator('[data-testid^="atlas-node-"]')).toHaveCount(25, { timeout: 20_000 });

    const result = await page.evaluate(() => {
      const kinds = new Set([...document.querySelectorAll('[data-atlas-node]')].map((el) => el.getAttribute('data-kind')));
      const problems: string[] = [];
      const shapes = document.querySelectorAll('circle.district').length;
      if (shapes !== 0) problems.push(`${shapes} section circles drawn`);
      for (const kind of kinds) {
        const named = document.querySelectorAll(`text.region[data-atlas-section="${kind}"]`).length;
        if (named !== 1) problems.push(`${kind}: ${named} names`);
      }
      const names = [...document.querySelectorAll('text.region')].map((el) => el.getBoundingClientRect());
      const items = [...document.querySelectorAll('[data-testid^="atlas-label-"]')].map((el) => el.getBoundingClientRect());
      for (const a of names) for (const b of items) {
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) problems.push('item label over a section name');
      }
      return { problems, sections: kinds.size, names: names.length };
    });
    expect(result.problems).toEqual([]);
    expect(result.names).toBe(result.sections);
  });
}

for (const [width, height] of [[1440, 900], [1000, 700]] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`QA-109 Atlas labels keep clear of the legend, help text and controls when zoomed in (${theme}, ${width}x${height})`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(`/desktop-alt.html?window=desktop-alt&theme=${theme}&persona=member&atlas=populated`);
      await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
      await page.evaluate(() => (document.querySelector('[data-testid="rail-company"]') as HTMLElement | null)?.click());
      await expect(page.locator('[data-testid^="atlas-node-"]')).toHaveCount(25, { timeout: 20_000 });
      await page.keyboard.press('0');
      const zoomIn = page.getByRole('button', { name: 'Zoom in' });
      const check = () =>
        page.evaluate(() => {
          const fixed = [...document.querySelectorAll('.atlas-map .legend, .atlas-map .legend > span, .atlas-map .map-tools, .atlas-map .map-tools button')]
            .map((el) => ({ name: (el.textContent ?? '').trim().slice(0, 30) || el.className, box: el.getBoundingClientRect() }))
            .filter((f) => f.box.width > 0);
          const labels = [...document.querySelectorAll('[data-testid^="atlas-label-"], text.region')]
            .map((el) => ({ id: el.textContent ?? '', box: el.getBoundingClientRect() }))
            .filter((l) => l.box.width > 0);
          const hits: string[] = [];
          for (const l of labels) for (const f of fixed) {
            const a = l.box; const b = f.box;
            if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) hits.push(`${l.id} over ${f.name}`);
          }
          return { hits, fixed: fixed.length, labels: labels.length };
        });
      for (let step = 0; step <= 2; step += 1) {
        if (step > 0) await zoomIn.click();
        await page.waitForTimeout(150);
        const result = await check();
        expect(result.fixed).toBeGreaterThan(0);
        expect(result.labels).toBeGreaterThan(0);
        expect(result.hits, `zoom step ${step}`).toEqual([]);
      }
      // The fixed text sits on an opaque backplate in the theme surface colour.
      const plate = await page.evaluate(() => getComputedStyle(document.querySelector('.atlas-map .legend')!).backgroundColor);
      expect(plate).not.toBe('rgba(0, 0, 0, 0)');
      expect(plate).not.toMatch(/rgba\([^)]*,\s*0(\.\d+)?\)$/);
    });
  }
}
