import { describe, expect, it } from "vitest";

import {
  cutoffDate,
  isBandSelected,
  pruneRequests,
  selectedBytes,
  storageErrorCopy,
  toggleBand,
  type StorageBand,
} from "./storage-model";

const BANDS: StorageBand[] = [
  { id: "7d", label: "Last 7 days", count: 10, bytes: 100 },
  { id: "30d", label: "7 to 30 days ago", count: 20, bytes: 200 },
  { id: "90d", label: "1 to 3 months ago", count: 30, bytes: 300 },
  { id: "365d", label: "3 to 12 months ago", count: 40, bytes: 400 },
  { id: "older", label: "Older than a year", count: 50, bytes: 500 },
];

function selectedIds(cutoff: number | null): string[] {
  return BANDS.filter((_, i) => isBandSelected(cutoff, i)).map((b) => b.id);
}

describe("storage band selection (cutoff cascade)", () => {
  it("checking a band also checks every older band", () => {
    expect(selectedIds(toggleBand(BANDS, null, 2))).toEqual(["90d", "365d", "older"]);
  });

  it("unchecking a band also unchecks every newer band and keeps older ones", () => {
    const all = toggleBand(BANDS, null, 1);
    expect(selectedIds(toggleBand(BANDS, all, 3))).toEqual(["older"]);
  });

  it("unchecking the oldest band clears the selection", () => {
    const oldest = toggleBand(BANDS, null, 4);
    expect(toggleBand(BANDS, oldest, 4)).toBeNull();
  });

  it("checking a newer band extends an existing selection", () => {
    const oldest = toggleBand(BANDS, null, 4);
    expect(selectedIds(toggleBand(BANDS, oldest, 1))).toEqual(["30d", "90d", "365d", "older"]);
  });

  it("never selects the Last 7 days band", () => {
    expect(toggleBand(BANDS, null, 0)).toBeNull();
    const cutoff = toggleBand(BANDS, null, 1);
    expect(toggleBand(BANDS, cutoff, 0)).toBe(cutoff);
  });

  it("sums the selected bands for Free up", () => {
    expect(selectedBytes(BANDS, null)).toBe(0);
    expect(selectedBytes(BANDS, 3)).toBe(900);
  });
});

describe("storage prune cutoff dates", () => {
  const now = new Date("2026-10-09T12:00:00Z");

  it("uses the band's reported newest edge when present", () => {
    const bands = BANDS.map((b) => (b.id === "90d" ? { ...b, to: "2026-09-09T08:00:00Z" } : b));
    expect(cutoffDate(bands, 2, now)).toBe("2026-09-09");
  });

  it("falls back to the band age", () => {
    expect(cutoffDate(BANDS, 1, now)).toBe("2026-10-02");
    expect(cutoffDate(BANDS, 4, now)).toBe("2025-10-09");
    expect(cutoffDate(BANDS, null, now)).toBeNull();
  });

  it("builds one request for local and one per company", () => {
    expect(
      pruneRequests(
        { bands: BANDS, cutoff: 4 },
        [
          { company: "indigo", bands: BANDS, cutoff: 2 },
          { company: "acme", bands: BANDS, cutoff: null },
        ],
        now,
      ),
    ).toEqual([
      { localBefore: "2025-10-09" },
      { cloudBefore: "2026-09-09", company: "indigo" },
    ]);
  });
});

describe("storage error copy", () => {
  it("asks for an HQ update when the CLI is missing or old", () => {
    expect(storageErrorCopy("update-hq")).toBe("Update HQ to manage storage.");
  });

  it("never shows raw CLI text", () => {
    expect(storageErrorCopy("hq storage failed: EACCES /Users/x")).not.toContain("EACCES");
  });
});
