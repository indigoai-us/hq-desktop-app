/**
 * A repo-wide guard on the one way scroll containment bites.
 *
 * `content-visibility: auto` and `contain: content` are how a long list stops
 * paying style and layout for rows nobody can see — measured 6.5x less
 * main-thread work per scroll step at 600 rows, 8.2x at 2000. They are cheap
 * to add and tempting to sprinkle.
 *
 * Both imply PAINT containment, which clips anything the element draws outside
 * its own border box. The usual casualty is a focus ring: an `outline` defaults
 * to drawing outside the box, so containing a row can silently delete its
 * visible keyboard focus indicator. Nothing catches that — the ring only
 * appears on keyboard focus, so no screenshot of the default state differs, and
 * the person most affected is the one least likely to be writing the CSS.
 *
 * The rule enforced here: an element may be contained only if its own focus
 * ring is drawn INSIDE the box (negative `outline-offset`), or it declares no
 * focus ring at all.
 *
 * If this test fails on a rule you just contained, the fix is one of:
 *   - give the ring a negative `outline-offset` so it paints inside, or
 *   - drop `content-visibility` and use `contain: layout` alone, which keeps
 *     the layout isolation without the clipping, or
 *   - do not contain that element.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(svelte|css)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Selectors whose rule body opts into paint containment. */
function containedSelectors(css: string): string[] {
  const found: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(css))) {
    const body = m[2]!;
    const contained =
      /content-visibility:\s*auto/.test(body) ||
      /contain:\s*(content|strict|paint)/.test(body);
    if (!contained) continue;
    for (const sel of m[1]!.split(",")) {
      const trimmed = sel.trim().split(/\s+/).pop() ?? "";
      const cls = trimmed.match(/\.[\w-]+/)?.[0];
      if (cls) found.push(cls);
    }
  }
  return [...new Set(found)];
}

describe("contained elements keep a visible focus ring", () => {
  const files = walk(SRC);

  it("scans a meaningful number of files (guards against a vacuous pass)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const file of walk(SRC)) {
    const css = readFileSync(file, "utf8");
    const contained = containedSelectors(css);
    if (contained.length === 0) continue;

    it(`${file.slice(SRC.length)} — contained rows do not clip their focus ring`, () => {
      for (const cls of contained) {
        const focus = new RegExp(
          `\\${cls}[^{,]*:focus-visible[^{]*\\{([^}]*)\\}`,
        ).exec(css);
        if (!focus) continue; // no ring of its own — nothing to clip
        const body = focus[1]!;
        if (!/outline(?!-offset)/.test(body)) continue; // ring is not an outline
        const offset = body.match(/outline-offset:\s*(-?[\d.]+)px/);
        expect(
          offset,
          `${cls} is contained and draws an outline, so it must declare outline-offset`,
        ).not.toBeNull();
        expect(
          Number(offset![1]),
          `${cls} is contained, so its focus ring must be inset (negative outline-offset) or it will be clipped`,
        ).toBeLessThan(0);
      }
    });
  }
});
