/**
 * Owner feedback (2026-10-08): "the icon Doesn't look horizontally aligned
 * with the text" (company channel header). The title row aligns on the text
 * baseline, so the company mark gets its own centred wrapper at the `#` size.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "DesktopApp.svelte"), "utf8");

describe("company channel header mark", () => {
  it("wraps the company mark at 17px instead of a bare 22px icon", () => {
    expect(src).toMatch(/<span class="channel-title-mark">\s*<CompanyIcon iconUrl=\{selectedCompanyIcon\} size=\{17\} \/>/);
    expect(src).not.toMatch(/<CompanyIcon iconUrl=\{selectedCompanyIcon\} size=\{22\} \/>/);
  });

  it("centres the mark on the title line rather than its baseline", () => {
    expect(src).toMatch(/\.channel-title-mark \{[^}]*align-self: center;[^}]*line-height: 0;/);
  });
});
