import { beforeEach, describe, expect, it } from "vitest";

import { companyPaneModel } from "./company-pane.js";
import {
  companyPageCounts,
  publishCompanyPageCount,
  resetCompanyPageCounts,
} from "./company-page-counts.svelte.js";
import { secretRowsFromSource } from "../company/files-connect/files-connect-model.js";

const company = { uid: "co_indigo", label: "Indigo", liveCount: 0 };
// The cached summary disagreed with the pages on the 10:45 build (QA-014).
const staleSummary = { board: 3, activity: { last7d: 99 }, deployments: 1, secrets: 28 };

function paneCount(rowId: string): number | undefined {
  const model = companyPaneModel(
    company,
    staleSummary,
    null,
    companyPageCounts("indigo", "co_indigo"),
  );
  return model.sections.flatMap((s) => s.rows).find((r) => r.id === rowId)?.count;
}

function list(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

describe("company sidepane counts match their pages (QA-014)", () => {
  beforeEach(() => {
    resetCompanyPageCounts();
  });

  it("Secrets shows the page total (444), not the summary's 28", () => {
    // 444 keys spread across env groups, the shape the Secrets page flattens.
    const source = Array.from({ length: 28 }, (_, g) => ({
      env: `env-${g}`,
      items: list(g < 24 ? 16 : 15).map((i) => ({ key: `KEY_${g}_${i}` })),
    }));
    const pageRows = secretRowsFromSource(source);
    expect(pageRows).toHaveLength(444);
    publishCompanyPageCount("indigo", "secrets", pageRows.length);
    expect(paneCount("secrets")).toBe(444);
  });

  const sections: Array<[row: string, key: string, total: number]> = [
    ["deployments", "indigo", 17],
    ["projects", "indigo", 42],
    ["knowledge", "indigo", 310],
    ["policies", "indigo", 121],
    ["skills", "indigo", 64],
    ["workers", "indigo", 25],
    ["activity", "indigo", 6],
    ["team", "indigo", 11],
    // The Bots page only knows the company uid.
    ["bots", "co_indigo", 4],
  ];

  for (const [row, key, total] of sections) {
    it(`${row} shows the same total as its page list`, () => {
      const pageList = list(total);
      publishCompanyPageCount(key, row, pageList.length);
      expect(paneCount(row)).toBe(pageList.length);
    });
  }

  it("an empty page clears a stale summary count", () => {
    publishCompanyPageCount("indigo", "deployments", 0);
    expect(paneCount("deployments")).toBeUndefined();
  });

  it("updates in place when the page refreshes", () => {
    publishCompanyPageCount("indigo", "secrets", 444);
    publishCompanyPageCount("indigo", "secrets", 445);
    expect(paneCount("secrets")).toBe(445);
  });

  it("keeps each company's totals separate", () => {
    publishCompanyPageCount("other-co", "secrets", 9);
    expect(companyPageCounts("indigo", "co_indigo")).toEqual({});
  });

  it("names the computer scope once the Projects page has counted", () => {
    publishCompanyPageCount("indigo", "projects", 42);
    const model = companyPaneModel(company, staleSummary, null, companyPageCounts("indigo"));
    const row = model.sections.flatMap((s) => s.rows).find((r) => r.id === "projects");
    expect(row?.countScope).toBe("42 on this computer");
  });
});
