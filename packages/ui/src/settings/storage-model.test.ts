import { describe, expect, it } from "vitest";

import {
  cutoffDate,
  bookmarksCopy,
  canDeleteCloud,
  isPermissionError,
  refsToRemove,
  rolesFromMemberships,
  isBandSelected,
  pruneRequests,
  prunedBytes,
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
    expect(storageErrorCopy("storage-timeout")).toBe("Reading your backup sizes took too long. Try again.");
  });

  it("never shows raw CLI text", () => {
    expect(storageErrorCopy("hq storage failed: EACCES /Users/x")).not.toContain("EACCES");
  });
});

describe("prunedBytes / hasRetainedRefs (hq storage prune --json)", () => {
  const local = {
    available: true,
    would_remove_commits: 0,
    est_bytes: 0,
    removed_commits: 0,
    total_commits_before: 0,
    flattened_merges: 0,
    retained_refs: 0,
  };

  it("uses the estimate on a dry run plus cloud deleted_bytes", () => {
    expect(
      prunedBytes({
        local: { ...local, would_remove_commits: 9, est_bytes: 1000 },
        cloud: [{ company: "indigo", deleted_count: 2, deleted_bytes: 50, errors: [] }],
        dry_run: true,
      }),
    ).toBe(1050);
  });

  it("uses git dir before minus after on a real run", () => {
    expect(
      prunedBytes({
        local: { ...local, removed_commits: 9, before: { git_dir_bytes: 900 }, after: { git_dir_bytes: 300 } },
        cloud: [],
        dry_run: false,
      }),
    ).toBe(600);
  });

  it("counts nothing for an unavailable or absent local result", () => {
    expect(prunedBytes({ local: { ...local, available: false, est_bytes: 5 }, cloud: [], dry_run: true })).toBe(0);
    expect(prunedBytes({ local: null, cloud: [], dry_run: true })).toBe(0);
  });

  it("reads refs_to_remove and words the bookmarks note", () => {
    expect(refsToRemove({ local: { ...local, refs_to_remove: 3 }, cloud: [], dry_run: true })).toBe(3);
    expect(refsToRemove({ local: null, cloud: [], dry_run: true })).toBe(0);
    expect(bookmarksCopy(0)).toBe("");
    expect(bookmarksCopy(1)).toBe("1 old bookmark other tools left behind will also be cleared.");
    expect(bookmarksCopy(3)).toBe("3 old bookmarks other tools left behind will also be cleared.");
  });
});

describe("cloud delete permission", () => {
  it("allows owners and admins; blocks members and unknown roles", () => {
    const roles = rolesFromMemberships([
      { companySlug: "indigo", role: "owner" },
      { companySlug: "acme", role: "Admin" },
      { companySlug: "beta", role: "member" },
    ]);
    expect(canDeleteCloud(roles, "indigo")).toBe(true);
    expect(canDeleteCloud(roles, "acme")).toBe(true);
    expect(canDeleteCloud(roles, "beta")).toBe(false);
    // Fails closed: no membership row (or the lookup failed) means no.
    expect(canDeleteCloud(roles, "unknown")).toBe(false);
    expect(canDeleteCloud(new Map(), "indigo")).toBe(false);
  });

  it("uses the CLI's can_delete when it reports one", () => {
    const roles = rolesFromMemberships([{ companySlug: "indigo", role: "owner" }]);
    expect(canDeleteCloud(roles, "indigo", false)).toBe(false);
    expect(canDeleteCloud(new Map(), "indigo", true)).toBe(true);
    expect(canDeleteCloud(roles, "indigo", null)).toBe(true);
  });

  it("recognises the CLI access-denied message", () => {
    expect(isPermissionError("Access denied deleting old versions (needs s3:DeleteObjectVersion on the vault bucket).")).toBe(true);
    expect(isPermissionError("NoSuchBucket")).toBe(false);
  });
});
