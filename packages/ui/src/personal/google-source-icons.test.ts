import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sourceIconUrl, sourceNames } from "./google-source-icons.js";

describe("Google source icons", () => {
  it("maps each Google source to a bundled official SVG, case-insensitively", () => {
    const urls = new Set<string | null>();
    for (const key of ["calendar", "contacts", "docs", "drive", "gmail", "sheets"]) {
      const url = sourceIconUrl(key.toUpperCase());
      const file = readFileSync(fileURLToPath(new URL(`./google-icons/${key}.svg`, import.meta.url)), "utf8");
      expect(file.startsWith("<svg")).toBe(true);
      // Vite inlines small assets as data URIs; larger ones keep the file path.
      expect(url?.startsWith("data:image/svg+xml") || url?.endsWith(`google-icons/${key}.svg`)).toBe(true);
      urls.add(url);
    }
    expect(urls.size).toBe(6);
  });

  it("returns null for unknown or non-string names", () => {
    expect(sourceIconUrl("Photos")).toBeNull();
    expect(sourceIconUrl(undefined)).toBeNull();
    expect(sourceIconUrl(7)).toBeNull();
  });

  it("coerces non-array and mixed input without throwing", () => {
    expect(sourceNames("gmail")).toEqual([]);
    expect(sourceNames(null)).toEqual([]);
    expect(sourceNames(["Gmail", 7, " ", " Drive "])).toEqual(["Gmail", "Drive"]);
  });
});
