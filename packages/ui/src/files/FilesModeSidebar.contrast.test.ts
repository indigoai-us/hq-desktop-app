/**
 * Contrast compensation for the Files sidebar.
 *
 * The perf pass removed this panel's `backdrop-filter` (the native glass view
 * behind the transparent window already blurs). The chat rail got the same
 * treatment AND an alpha bump to pay for the lost contrast (--side-bg
 * 0.18→0.30 light, 0.12→0.20 dark, commit fa4807c1); this panel did not, so at
 * max transparency in light mode its --v4-sidebar token floors near 0.12 alpha
 * and the sidebar washes out.
 *
 * Asserted against the source because the compensation is pure CSS on a token
 * the component does not own.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  fileURLToPath(new URL("./FilesModeSidebar.svelte", import.meta.url)),
  "utf8",
);

/** The style block only — never match the markup or the script. */
const STYLE = SOURCE.slice(SOURCE.lastIndexOf("<style>"));

describe("FilesModeSidebar background", () => {
  it("still has no backdrop-filter on the panel itself", () => {
    const panel = STYLE.slice(
      STYLE.indexOf("  .files-sidebar {"),
      STYLE.indexOf("  /* Header:"),
    );
    expect(panel).not.toMatch(/^\s*(-webkit-)?backdrop-filter:(?!\s*none)/m);
  });

  it("layers a wash over --v4-sidebar so the lost blur is paid for", () => {
    expect(STYLE).toMatch(
      /background:\s*linear-gradient\(\s*var\(--fs-panel-wash\),\s*var\(--fs-panel-wash\)\s*\),\s*var\(--v4-sidebar/,
    );
  });

  it("defines the wash for light and dark, at the chat rail's magnitude", () => {
    const alphas = [...STYLE.matchAll(/--fs-panel-wash:\s*rgb\([^)]*\/\s*([\d.]+)\)/g)].map(
      (m) => Number(m[1]),
    );
    expect(alphas.length).toBeGreaterThanOrEqual(3);
    // The chat rail's bump was +0.12 light / +0.08 dark; stay in that band.
    for (const alpha of alphas) {
      expect(alpha).toBeGreaterThanOrEqual(0.08);
      expect(alpha).toBeLessThanOrEqual(0.14);
    }
    expect(STYLE).toMatch(/prefers-color-scheme:\s*dark[\s\S]*?--fs-panel-wash/);
    expect(STYLE).toMatch(/data-force-theme="light"[\s\S]*?--fs-panel-wash/);
    expect(STYLE).toMatch(/data-force-theme="dark"[\s\S]*?--fs-panel-wash/);
  });
});
