import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Company data pages follow the shipped Messages type scale: one 20px/500
// page title, 13px everywhere else, weight never above 500, no inflated
// --type-* tokens, no floating corner cards, no backdrop-filter.
const FILES = [
  "./FilesConnectPage.svelte",
  "./DeployAccessForm.svelte",
  "../../files/CompanyFileTree.svelte",
];

function style(path: string): string {
  const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  return source.slice(source.indexOf("<style"));
}

describe("company data pages design contract", () => {
  for (const file of FILES) {
    it(`${file} keeps the Messages type scale`, () => {
      const css = style(file);
      const weights = [...css.matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1]));
      expect(weights.every((w) => w <= 500)).toBe(true);
      const sizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
      expect(sizes.filter((size) => size > 13 && size !== 20)).toEqual([]);
      expect(css).not.toMatch(/--type-(section|detail|body|secondary)/);
      expect(css).not.toMatch(/backdrop-filter/);
      expect(css).not.toMatch(/text-transform:\s*uppercase/);
    });
  }

  it("opens sheets centered over a scrim, not as a bottom-right card", () => {
    const css = style("./FilesConnectPage.svelte");
    expect(css).toMatch(/\.sheet\s*\{[^}]*left:\s*50%/);
    expect(css).not.toMatch(/right:\s*16px;\s*bottom:\s*16px/);
  });
});
