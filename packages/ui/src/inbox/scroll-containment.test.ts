/**
 * Scroll containment on long-list rows, and the invariant that makes it safe.
 *
 * `content-visibility: auto` + `contain: content` is what stops per-scroll
 * style/layout work scaling with list length — measured 6.5x less main-thread
 * layout work per scroll step on a 600-row list, 8.2x at 2000 rows.
 *
 * `contain: content` implies paint containment, which CLIPS anything a row
 * draws outside its own border box. A focus ring is the usual casualty: an
 * `outline` defaults to drawing outside the box, so a contained row silently
 * loses its visible keyboard focus indicator. That is an accessibility
 * regression that no visual diff of the default state would catch, because the
 * ring only appears on keyboard focus.
 *
 * So these two assertions belong together and must stay together: a row may
 * only be contained while its focus ring is inset.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./NotificationsView.svelte", import.meta.url),
  "utf8",
);

function ruleBody(css: string, selector: string): string {
  const i = css.indexOf(`${selector} {`);
  if (i === -1) return "";
  return css.slice(i, css.indexOf("}", i));
}

describe("notification feed scroll containment", () => {
  const row = ruleBody(source, ".notif-row");

  it("skips offscreen rows so scroll cost stops scaling with feed length", () => {
    expect(row).toContain("content-visibility: auto");
    expect(row).toContain("contain: content");
  });

  it("declares an intrinsic height, so skipped rows do not collapse the scrollbar", () => {
    expect(row).toMatch(/contain-intrinsic-size:\s*auto\s+\d+px/);
  });

  it("keeps the focus ring inset, which is what makes paint containment safe", () => {
    const focus = ruleBody(source, ".notif-row:focus-visible");
    expect(focus).toContain("outline");
    // A negative offset draws the ring inside the border box, where paint
    // containment cannot clip it. Zero or positive would be clipped.
    const offset = focus.match(/outline-offset:\s*(-?\d+)px/);
    expect(offset, "contained row must declare outline-offset").not.toBeNull();
    expect(Number(offset![1])).toBeLessThan(0);
  });
});
