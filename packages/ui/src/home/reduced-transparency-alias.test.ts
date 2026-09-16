/**
 * The in-app "reduce transparency" setting must stay a pure ALIAS of the
 * OS-level `prefers-reduced-transparency` treatment — never a second visual
 * design that drifts from the first.
 *
 * The accessibility block was designed and reviewed. The attribute block exists
 * only so the same treatment is reachable without an OS setting, because
 * turning the glass off is the one lever that meaningfully changes scrolling
 * smoothness on the desktop app's WebKit view. If someone retunes one block's
 * greys and not the other, users land in a half-designed palette depending on
 * which switch they happened to use, and nothing else would catch it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

/** Extract `--token: value;` pairs from the body that follows a selector. */
function declarationsAfter(selector: string): Record<string, string> {
  const at = css.indexOf(selector);
  if (at === -1) return {};
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  const out: Record<string, string> = {};
  for (const line of css.slice(open + 1, close).split("\n")) {
    const m = line.match(/^\s*(--[\w-]+):\s*(.+?);\s*$/);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

describe("reduce-transparency setting aliases the accessibility treatment", () => {
  it("light values are identical in both blocks", () => {
    const media = declarationsAfter(
      "@media (prefers-reduced-transparency: reduce) {\n  :root,",
    );
    const attr = declarationsAfter(':root[data-reduce-transparency="true"],');
    expect(Object.keys(media).length).toBeGreaterThan(8);
    expect(attr).toEqual(media);
  });

  it("dark values are identical in both blocks", () => {
    const media = declarationsAfter("  .dark,\n  :root[data-force-theme=\"dark\"] {");
    const attr = declarationsAfter(
      ':root[data-reduce-transparency="true"].dark,',
    );
    expect(Object.keys(media).length).toBeGreaterThan(5);
    expect(attr).toEqual(media);
  });

  it("turns every glass filter off, which is the whole point of the setting", () => {
    const attr = declarationsAfter(':root[data-reduce-transparency="true"],');
    for (const token of [
      "--v4-canvas-filter",
      "--v4-glass-filter",
      "--v4-glass-filter-soft",
      "--v4-glass-filter-popover",
    ]) {
      expect(attr[token], `${token} must be disabled`).toBe("none");
    }
  });

  it("keeps the dark rule more specific than the bare one, so a forced-dark window cannot flip light", () => {
    // Bare `[data-reduce-transparency]` ties with `:root[data-force-theme="dark"]`
    // on specificity and would win on source order, painting a forced-dark
    // window with the light palette the moment the setting is enabled.
    expect(css).toContain(
      ':root[data-reduce-transparency="true"][data-force-theme="dark"]',
    );
  });
});
