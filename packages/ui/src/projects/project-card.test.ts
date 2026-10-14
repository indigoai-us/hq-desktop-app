import { describe, expect, it } from "vitest";
import { projectUpdatedAt, repoChips, storiesLabel, updatedLabel } from "./project-card.js";
import {
  PORTFOLIO_COLUMNS,
  readShowComplete,
  SHOW_COMPLETE_STORAGE_KEY,
  visiblePortfolioColumns,
  writeShowComplete,
} from "./projects-model.js";

describe("repoChips", () => {
  it("shows two repos and folds the rest into +N, without duplicates", () => {
    expect(repoChips(["a", "b", "a", " ", "c", "d"])).toEqual({
      shown: ["a", "b"],
      more: 2,
      all: ["a", "b", "c", "d"],
    });
    expect(repoChips([])).toEqual({ shown: [], more: 0, all: [] });
  });
});

describe("storiesLabel", () => {
  it("reads as 'N of M stories' and drops out with no stories", () => {
    expect(storiesLabel(7, 15)).toBe("7 of 15 stories");
    expect(storiesLabel(1, 1)).toBe("1 of 1 story");
    expect(storiesLabel(0, 0)).toBeNull();
  });
});

describe("updated line", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");

  it("uses the newer of the PRD write and the declared update", () => {
    expect(
      projectUpdatedAt({ prdModifiedAt: "2026-10-06T11:57:00Z", updatedAt: "2026-06-01T00:00:00Z" }),
    ).toBe("2026-10-06T11:57:00Z");
    expect(projectUpdatedAt({ prdModifiedAt: null, updatedAt: "2026-06-01T00:00:00Z" })).toBe(
      "2026-06-01T00:00:00Z",
    );
    expect(projectUpdatedAt({ prdModifiedAt: null, updatedAt: null })).toBeNull();
  });

  it("is relative inside a month, then a date", () => {
    expect(updatedLabel("2026-10-06T11:57:00Z", now)).toBe("updated 3 min ago");
    expect(updatedLabel("2026-10-04T12:00:00Z", now)).toBe("updated 2d ago");
    expect(updatedLabel("2026-06-08T12:00:00Z", now)).toBe("updated Jun 8");
    expect(updatedLabel("2025-06-08T12:00:00Z", now)).toBe("updated Jun 8, 2025");
    expect(updatedLabel("not a date", now)).toBeNull();
  });
});

describe("Complete column visibility", () => {
  it("is hidden by default and shown when chosen or filtered to", () => {
    expect(visiblePortfolioColumns("all", false)).toEqual(["not-started", "in-progress", "active"]);
    expect(visiblePortfolioColumns("all", true)).toEqual(PORTFOLIO_COLUMNS);
    expect(visiblePortfolioColumns("complete", false)).toEqual(PORTFOLIO_COLUMNS);
  });

  it("reads and writes the per-machine setting", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(readShowComplete(storage)).toBe(false);
    writeShowComplete(storage, true);
    expect(store.get(SHOW_COMPLETE_STORAGE_KEY)).toBe("1");
    expect(readShowComplete(storage)).toBe(true);
    expect(readShowComplete(null)).toBe(false);
  });
});
