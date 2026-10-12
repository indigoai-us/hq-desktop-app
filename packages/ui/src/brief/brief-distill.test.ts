import { describe, expect, it } from "vitest";
import {
  isNamedShip,
  mergeMedianText,
  parsePr,
  releaseLine,
  rowMerged,
  shippedDigest,
  shippedStreak,
  shippedTiles,
  shortDay,
  streakTitle,
  whyHighlights,
} from "./brief-distill.js";
import type { BriefShipped } from "./brief-types.js";

describe("shippedDigest", () => {
  const lines = [
    "1220 chore(v16): remove /plan stub",
    "1217 feat(conduct): on by default in v16",
    "1215 docs(policies): retire the when:always recommendation",
    "1214 promote(overnight): add /overnight skill",
    "1204 fix(grok): cover the 1.0.40+ hook contract",
    "1173 Policies: keyword-trigger every core policy",
  ].map((label) => ({ label, state: "MERGED" }));

  it("summarizes the mix by kind in one line", () => {
    expect(shippedDigest(lines).mix).toBe("2 features · 1 fix · 1 change · 1 docs · 1 chore");
  });

  it("keeps three highlights, features first, without PR numbers or prefixes", () => {
    expect(shippedDigest(lines).highlights.map((h) => h.label)).toEqual([
      "On by default in v16",
      "Add /overnight skill",
      "Cover the 1.0.40+ hook contract",
    ]);
  });

  it("treats an unprefixed title as a plain change", () => {
    expect(parsePr("88 Bump the logo")).toEqual({ kind: "change", text: "Bump the logo" });
  });
});

const INDIGO = "cmp_indigo";
const merged = (label: string) => ({ label, state: "MERGED", tone: "ok" as const });
/** A sweep-shaped row: title is the repo, lines are "<n> <title>" PR labels. */
function sweepRow(repo: string, labels: string[], extra: Partial<BriefShipped> = {}): BriefShipped {
  return { id: `ship:${repo}`, title: repo, status: `${labels.length} merged`, note: "nothing open", origin: { companyUid: INDIGO, repo }, lines: labels.map(merged), ...extra };
}
/** A writer-shaped row from brief.json items.shipped: a product, a why, no PR lines. */
function writerRow(id: string, title: string, product: string, repo: string | null, extra: Partial<BriefShipped> = {}): BriefShipped {
  return { id, title, status: "", note: "", origin: { companyUid: INDIGO, repo, product }, lines: [], ...extra };
}

describe("shippedTiles", () => {
  it("keys tiles by product name, never the repo, and adds up repos that share a product", () => {
    const tiles = shippedTiles([
      sweepRow("hq-desktop-app", ["1501 Wait for Apple dev tools", "1504 feat(cards): rich card icons"]),
      sweepRow("hq-core-staging", ["1173 Policies: keyword-trigger every core policy"]),
      sweepRow("hq-core", ["77 chore(release): 1.0.52"]),
    ]);
    expect(tiles.map((t) => [t.product, t.merged])).toEqual([
      ["Desktop app", 2],
      ["HQ core", 2],
    ]);
    expect(tiles[1]!.ids).toEqual(["ship:hq-core-staging", "ship:hq-core"]);
    for (const t of tiles) expect(t.product).not.toMatch(/^hq-/);
  });

  it("puts firsts ahead, then the most merged, then the name", () => {
    const tiles = shippedTiles([
      sweepRow("hq-pro", ["4890 feat(api): keys stay inside their company"], { first: true }),
      sweepRow("hq-desktop-app", ["1 a", "2 b", "3 c"]),
      sweepRow("hq-cloud", ["9 x"]),
      sweepRow("hq-cli", ["8 y"]),
    ]);
    expect(tiles.map((t) => t.product)).toEqual(["HQ Pro", "Desktop app", "CLI", "HQ Cloud"]);
    expect(tiles[0]!.first).toBe(true);
    expect(tiles[1]!.first).toBe(false);
  });

  it("headline is the merged count; highlights never carry a PR number or a conventional prefix", () => {
    const [t] = shippedTiles([
      sweepRow("hq-core-staging", ["1220 chore(v16): remove /plan stub", "1217 feat(conduct): on by default in v16", "1204 fix(grok): cover the 1.0.40+ hook contract"]),
    ]);
    expect(t!.headline).toBe("3 merged");
    expect(t!.highlights.map((h) => h.label)).toEqual(["On by default in v16", "Cover the 1.0.40+ hook contract", "Remove /plan stub"]);
    expect(t!.highlights.map((h) => h.state)).toEqual(["FEATURE", "FIX", "CHORE"]);
    for (const h of t!.highlights) expect(h.label).not.toMatch(/#?\d{3,}|\b(feat|fix|chore)\(/);
    expect(t!.mix).toBe("1 feature · 1 fix · 1 chore");
  });

  it("writer rows: named ships lead the highlights, a list-like why splits into plain lines, prose why becomes the status", () => {
    const tiles = shippedTiles([
      writerRow("s1", "Desktop 0.11.3 is out", "Desktop app", "hq-desktop-app", { why: "The release finished yesterday." }),
      writerRow("s2", "HQ Storage shipped", "Desktop app", null, { first: true, why: "Backups and cloud file history are merged." }),
      writerRow("s3", "Desktop app: 6 changes shipped", "Desktop app", "hq-desktop-app", {
        why: "Badges: load real badges from hq-pro (stage 1); Release 0.11.3; feat(settings): Storage page for HQ backups",
      }),
      writerRow("s4", "HQ Pro: 9 changes shipped", "HQ Pro", "hq-pro", { highlights: ["hq-pro #4890: feat(api): keys stay inside their company"], mergeHoursMedian: 3.33 }),
    ]);
    expect(tiles.map((t) => t.product)).toEqual(["Desktop app", "HQ Pro"]);
    const desk = tiles[0]!;
    expect(desk.merged).toBe(6);
    expect(desk.headline).toBe("6 merged");
    expect(desk.first).toBe(true);
    expect(desk.highlights.map((h) => h.label)).toEqual([
      "Desktop 0.11.3 is out",
      "HQ Storage shipped",
      "Load real badges from hq-pro (stage 1)",
      "Release 0.11.3",
      "Storage page for HQ backups",
    ]);
    expect(desk.why).toBe("The release finished yesterday.");
    expect(desk.release).toBe("Desktop 0.11.3 is out");
    const pro = tiles[1]!;
    expect(pro.highlights.map((h) => h.label)).toEqual(["Keys stay inside their company"]);
    expect(pro.mergeHoursMedian).toBe(3.33);
    expect(pro.why).toBeNull();
  });

  it("a named ship with no count keeps its own words as the headline", () => {
    const [t] = shippedTiles([writerRow("s1", "Finance dashboard is live", "Finance dashboard", "hq-finance", { first: true })]);
    expect(t!.merged).toBe(0);
    expect(t!.headline).toBe("Finance dashboard is live");
    expect(t!.highlights).toEqual([]);
  });

  it("caps highlights at five and drops duplicates", () => {
    const [t] = shippedTiles([
      sweepRow("hq-pro", Array.from({ length: 8 }, (_, i) => `${100 + i} feat(x): change ${i % 6}`)),
    ]);
    expect(t!.highlights).toHaveLength(5);
    expect(new Set(t!.highlights.map((h) => h.label)).size).toBe(5);
  });

  it("marks sample tiles and keeps an empty list empty", () => {
    expect(shippedTiles([])).toEqual([]);
    expect(shippedTiles([sweepRow("hq-cli", ["1 a"], { sample: true })])[0]!.sample).toBe(true);
  });
});

describe("shipped row helpers", () => {
  it("rowMerged reads PR lines, then the status, then the title", () => {
    expect(rowMerged(sweepRow("hq-cli", ["1 a", "2 b"]))).toBe(2);
    expect(rowMerged({ ...sweepRow("hq-cli", []), status: "4 merged" })).toBe(4);
    expect(rowMerged(writerRow("s", "HQ Pro: 9 changes shipped", "HQ Pro", "hq-pro"))).toBe(9);
    expect(rowMerged(writerRow("s", "HQ Storage shipped", "Desktop app", null))).toBe(0);
  });

  it("isNamedShip: a product's count line or the repo name is not a named ship", () => {
    expect(isNamedShip(sweepRow("hq-desktop-app", ["1 a"]))).toBe(false);
    expect(isNamedShip(writerRow("s", "HQ Pro: 9 changes shipped", "HQ Pro", "hq-pro"))).toBe(false);
    expect(isNamedShip(writerRow("s", "HQ Pro", "HQ Pro", "hq-pro"))).toBe(false);
    expect(isNamedShip(writerRow("s", "API keys now stay inside their company", "HQ Pro", "hq-pro"))).toBe(true);
  });

  it("whyHighlights splits a list of PR titles and leaves prose alone", () => {
    expect(whyHighlights("chore(deps): bump core to 1.128.0; feat(badges): awards ledger; feat(sts): owners may delete old versions")).toEqual([
      "Bump core to 1.128.0",
      "Awards ledger",
      "Owners may delete old versions",
    ]);
    expect(whyHighlights("A key can no longer fetch another company's data; the fix shipped in HQ Pro.")).toEqual([]);
    expect(whyHighlights(null)).toEqual([]);
  });

  it("releaseLine finds a release PR or a named release row", () => {
    expect(releaseLine([sweepRow("hq-desktop-app", ["1550 feat(x): y", "1553 Release 0.11.3"])])).toBe("Release 0.11.3");
    expect(releaseLine([sweepRow("hq-core", ["77 chore(release): 1.0.52"])])).toBe("Release 1.0.52");
    expect(releaseLine([writerRow("s", "Desktop 0.11.3 is out", "Desktop app", "hq-desktop-app")])).toBe("Desktop 0.11.3 is out");
    expect(releaseLine([sweepRow("hq-cli", ["1 feat(a): b"])])).toBeNull();
  });

  it("mergeMedianText says hours and minutes plainly", () => {
    expect(mergeMedianText(3.33)).toBe("Median 3h 20m from open to merge");
    expect(mergeMedianText(0.5)).toBe("Median 30m from open to merge");
    expect(mergeMedianText(2)).toBe("Median 2h from open to merge");
    expect(mergeMedianText(null)).toBeNull();
    expect(mergeMedianText(Number.NaN)).toBeNull();
  });
});

describe("shippedStreak", () => {
  it("counts the trailing run of consecutive days, at least two", () => {
    expect(shippedStreak(["2026-10-06", "2026-10-07", "2026-10-08"], "2026-10-09")).toEqual({ days: 3, from: "2026-10-06", to: "2026-10-08" });
    expect(shippedStreak(["2026-10-01", "2026-10-07", "2026-10-08"], "2026-10-09")).toEqual({ days: 2, from: "2026-10-07", to: "2026-10-08" });
    expect(shippedStreak(["2026-10-08"], "2026-10-09")).toBeNull();
    expect(shippedStreak(["2026-10-01", "2026-10-08"], "2026-10-09")).toBeNull();
    expect(shippedStreak([], "2026-10-09")).toBeNull();
    expect(shippedStreak(null)).toBeNull();
  });

  it("a run that ended before yesterday is not a streak; order and duplicates do not matter; month ends count", () => {
    expect(shippedStreak(["2026-10-05", "2026-10-06"], "2026-10-09")).toBeNull();
    expect(shippedStreak(["2026-10-08", "2026-10-07", "2026-10-07"], "2026-10-09")).toEqual({ days: 2, from: "2026-10-07", to: "2026-10-08" });
    expect(shippedStreak(["2026-09-30", "2026-10-01"], "2026-10-01")).toEqual({ days: 2, from: "2026-09-30", to: "2026-10-01" });
    expect(shippedStreak(["2026-10-06", "2026-10-07"])).toEqual({ days: 2, from: "2026-10-06", to: "2026-10-07" });
    expect(shippedStreak(["junk", "2026-10-07", "2026-10-08"], "2026-10-08")).toEqual({ days: 2, from: "2026-10-07", to: "2026-10-08" });
  });

  it("titles read as a person says them, without the machine timezone", () => {
    expect(shortDay("2026-10-06")).toBe("Oct 6");
    expect(streakTitle({ days: 3, from: "2026-10-06", to: "2026-10-08" })).toBe("Shipped Oct 6, 7 and 8");
    expect(streakTitle({ days: 2, from: "2026-09-30", to: "2026-10-01" })).toBe("Shipped Sep 30 and Oct 1");
    expect(streakTitle({ days: 7, from: "2026-10-06", to: "2026-10-12" })).toBe("Shipped every day from Oct 6 to Oct 12");
  });
});
