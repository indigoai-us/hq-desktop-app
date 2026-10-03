import { expect, test } from '@playwright/test';

/**
 * OWNER-D 4 (AUDIT-3-19): Atlas labels stay readable and never overlap. With
 * the populated fixture at 1440x900 and 1000x700, every visible label is at
 * least 13px and no two visible labels intersect. Hidden names come back on
 * hover.
 */
const MIN_LABEL_PX = 13;

for (const [width, height] of [[1440, 900], [1000, 700]] as const) {
  test(`Atlas labels at ${width}x${height}: readable, no overlaps`, async ({ page }) => {
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
  test(`Atlas sections are shaded and their names stay uncovered (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(`/desktop-alt.html?window=desktop-alt&theme=${theme}&persona=member&atlas=populated`);
    await expect(page.getByTestId('app-rail')).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => (document.querySelector('[data-testid="rail-company"]') as HTMLElement | null)?.click());
    await expect(page.locator('[data-testid^="atlas-node-"]')).toHaveCount(25, { timeout: 20_000 });

    const result = await page.evaluate(() => {
      const kinds = new Set([...document.querySelectorAll('[data-atlas-node]')].map((el) => el.getAttribute('data-kind')));
      const shapes = [...document.querySelectorAll<SVGCircleElement>('circle.district')];
      const problems: string[] = [];
      for (const kind of kinds) {
        const mine = shapes.filter((s) => s.getAttribute('data-district') === kind);
        if (mine.length !== 1) { problems.push(`${kind}: ${mine.length} regions`); continue; }
        const c = mine[0]!;
        const cx = Number(c.getAttribute('cx')); const cy = Number(c.getAttribute('cy')); const r = Number(c.getAttribute('r'));
        const style = getComputedStyle(c);
        if (Number(style.fillOpacity) <= 0 || style.fill === 'none') problems.push(`${kind}: not shaded`);
        for (const node of document.querySelectorAll(`[data-atlas-node][data-kind="${kind}"] circle.dot`)) {
          const nx = Number(node.getAttribute('cx')); const ny = Number(node.getAttribute('cy')); const nr = Number(node.getAttribute('r'));
          if (Math.hypot(nx - cx, ny - cy) + nr > r + 0.5) problems.push(`${kind}: node outside`);
        }
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
