// Contract: the console-rail canvas uses two type sizes, 20px/500 for the
// page title and 13px for everything else (docs/design-standard-console-rail.md).
// The old 14/15/17/24 ramp must stay retired so subpages cannot drift back.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

function tokenValue(css: string, name: string): string | undefined {
  return css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();
}

describe("console-rail type scale tokens", () => {
  for (const file of ["./tokens.css", "../chat/tokens.css"]) {
    it(`${file} defines the 20px/500 title and 13px body`, () => {
      const css = read(file);
      expect(tokenValue(css, "--type-title")).toBe("20px");
      expect(tokenValue(css, "--type-title-weight")).toBe("500");
      expect(tokenValue(css, "--type-ui")).toBe("13px");
    });

    it(`${file} keeps the inflated ramp retired`, () => {
      const css = read(file);
      for (const name of [
        "--type-metadata",
        "--type-secondary",
        "--type-body",
        "--type-section",
      ]) {
        expect(tokenValue(css, name)).toBe("var(--type-ui)");
      }
      expect(tokenValue(css, "--type-detail")).toBe("var(--type-title)");
      expect(css).not.toMatch(/--type-[a-z-]+:\s*(14|15|16|17|18|22|24)px/);
    });
  }

  it("native controls inherit the shell font", () => {
    expect(read("./tokens.css")).toMatch(
      /:where\(button, input, select, textarea\)\s*\{\s*font: inherit;/,
    );
  });

  it("Messages keeps its shipped 14px sidebar sizes", () => {
    expect(read("../chat/chat-tokens.css")).toMatch(
      /\.chat-sidebar\s*\{\s*--type-secondary: 14px;/,
    );
  });
});
