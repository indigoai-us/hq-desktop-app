import { describe, expect, it } from "vitest";

import {
  companyLiveCount,
  rememberCompanyId,
  reorderPinnedIds,
  seedPinnedCompanyIds,
} from "./pinned-companies.js";

const roster = [
  { uid: "co_default" },
  { uid: "co_recent" },
  { uid: "co_older" },
  { uid: "co_rest" },
];

describe("pinned companies (US-004)", () => {
  it("seeds the default company, then the next most recently used, up to six", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ uid: `co_${i}` }));
    expect(
      seedPinnedCompanyIds(roster, {
        defaultCompanyId: "co_default",
        recentIds: ["co_older", "co_recent"],
      }),
    ).toEqual(["co_default", "co_older", "co_recent", "co_rest"]);
    expect(seedPinnedCompanyIds(many, { defaultCompanyId: "co_3" })).toHaveLength(6);
    expect(seedPinnedCompanyIds(many, { defaultCompanyId: "co_3" })[0]).toBe("co_3");
  });

  it("falls back to list order when nothing has been used yet", () => {
    expect(seedPinnedCompanyIds(roster, {})).toEqual([
      "co_default",
      "co_recent",
      "co_older",
      "co_rest",
    ]);
  });

  it("reorders by drag and remembers a company switch", () => {
    expect(reorderPinnedIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(reorderPinnedIds(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(reorderPinnedIds(["a"], "missing", "a")).toEqual(["a"]);
    expect(rememberCompanyId(["b", "a"], "a")).toEqual(["a", "b"]);
  });

  it("counts only online actors already in the snapshot", () => {
    const snapshot = new Map([
      [
        "co_live",
        new Map([
          ["bot", { status: "online" }],
          ["human", { status: "offline" }],
        ]),
      ],
      ["co_quiet", new Map([["human", { status: "offline" }]])],
    ]);
    expect(companyLiveCount(snapshot, "co_live")).toBe(1);
    expect(companyLiveCount(snapshot, "co_quiet")).toBe(0);
    expect(companyLiveCount(snapshot, "co_missing")).toBe(0);
  });
});

describe("member companies (QA-050)", () => {
  it("keeps only cloud member companies in roster order", async () => {
    const { memberCompanies } = await import("./pinned-companies.js");
    const rows = memberCompanies([
      { kind: "company", slug: "b", cloudUid: "cmp_b" },
      { kind: "personal", slug: "personal", cloudUid: "prs_1" },
      { kind: "company", slug: "local-only", cloudUid: undefined },
      { kind: "company", slug: "a", cloudUid: "cmp_a" },
    ]);
    expect(rows.map((r) => r.slug)).toEqual(["b", "a"]);
    expect(memberCompanies(null)).toEqual([]);
  });
});
