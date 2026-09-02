import { describe, expect, it } from "vitest";

import {
  buildCompanyDisplayMap,
  workspacesFromMembershipRows,
} from "./company-display-map.js";

describe("workspacesFromMembershipRows", () => {
  it("synthesizes an active synced company from a bare membership row", () => {
    const out = workspacesFromMembershipRows([
      {
        companyUid: "cmp_indigo",
        companySlug: "indigo",
        companyName: "Indigo",
        status: "active",
        role: "owner",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      slug: "indigo",
      displayName: "Indigo",
      kind: "company",
      state: "synced",
      cloudUid: "cmp_indigo",
      membershipStatus: "active",
      role: "owner",
    });
  });

  it("keeps a real personal workspace row as kind=personal (the reported bug)", () => {
    // `list_syncable_workspaces` puts the personal vault first, labelled with
    // the person's own name. Flattened to an active company it became the
    // default "In" target of the create modal and the server refused it.
    const out = workspacesFromMembershipRows({
      workspaces: [
        {
          slug: "personal",
          displayName: "Stefan Johnson",
          kind: "personal",
          state: "personal",
          cloudUid: "prs_01SELF",
          bucketName: "hq-personal-bucket",
          hasLocalFolder: true,
          localPath: "/Users/me/hq",
          membershipStatus: null,
          role: null,
          syncEnabled: true,
          lastSyncedAt: "2026-09-01T00:00:00Z",
          brokenReason: null,
          invitedBy: null,
          invitedAt: null,
        },
        {
          slug: "indigo",
          displayName: "Indigo",
          kind: "company",
          state: "synced",
          cloudUid: "cmp_indigo",
          bucketName: null,
          hasLocalFolder: true,
          localPath: "/Users/me/hq/companies/indigo",
          membershipStatus: "active",
          role: "owner",
          lastSyncedAt: null,
          brokenReason: null,
          invitedBy: null,
          invitedAt: null,
        },
      ],
    });
    expect(out.map((w) => [w.slug, w.kind, w.state])).toEqual([
      ["personal", "personal", "personal"],
      ["indigo", "company", "synced"],
    ]);
    expect(out[0]).toMatchObject({
      displayName: "Stefan Johnson",
      cloudUid: "prs_01SELF",
      hasLocalFolder: true,
      localPath: "/Users/me/hq",
      syncEnabled: true,
      lastSyncedAt: "2026-09-01T00:00:00Z",
    });
    // Unknown stays unknown — never laundered into "active".
    expect(out[0].membershipStatus).toBeNull();
    expect(out[1].membershipStatus).toBe("active");
  });

  it("preserves non-active states and statuses on real workspace rows", () => {
    const out = workspacesFromMembershipRows([
      {
        slug: "stale-co",
        displayName: "Stale Co",
        kind: "company",
        state: "broken",
        cloudUid: "cmp_stale",
        membershipStatus: "revoked",
        brokenReason: "cloud_uid mismatch",
        invitedBy: "prs_x",
        invitedAt: "2026-08-01T00:00:00Z",
      },
      {
        slug: "invited-co",
        displayName: "Invited Co",
        kind: "company",
        state: "cloud-only",
        cloudUid: "cmp_invited",
        membershipStatus: "pending",
      },
    ]);
    expect(out[0]).toMatchObject({
      state: "broken",
      membershipStatus: "revoked",
      brokenReason: "cloud_uid mismatch",
      invitedBy: "prs_x",
      invitedAt: "2026-08-01T00:00:00Z",
      hasLocalFolder: false,
    });
    expect(out[1]).toMatchObject({
      state: "cloud-only",
      membershipStatus: "pending",
    });
  });

  it("falls back sanely when a workspace row has an unknown state", () => {
    const out = workspacesFromMembershipRows([
      { slug: "p", displayName: "Me", kind: "personal", state: "???", cloudUid: "prs_1" },
      { slug: "c", displayName: "Co", kind: "company", state: "", cloudUid: "cmp_1" },
    ]);
    expect(out[0].state).toBe("personal");
    expect(out[1].state).toBe("synced");
  });

  it("dedupes by uid, drops rows without one, and never labels with a raw uid", () => {
    const out = workspacesFromMembershipRows([
      { companyUid: "cmp_a", companyName: "A" },
      { companyUid: "cmp_a", companyName: "A again" },
      { companySlug: "no-uid" },
      { companyUid: "cmp_b", companyName: "cmp_b", companySlug: "bee" },
    ]);
    expect(out.map((w) => [w.cloudUid, w.displayName])).toEqual([
      ["cmp_a", "A"],
      ["cmp_b", "bee"],
    ]);
  });
});

describe("buildCompanyDisplayMap", () => {
  it("maps uid and slug to the readable name and skips raw uids", () => {
    const names = buildCompanyDisplayMap([
      { companyUid: "cmp_a", companySlug: "acme", companyName: "Acme" },
      { companyUid: "cmp_b", companySlug: "bee", companyName: "cmp_b" },
    ]);
    expect(names.get("cmp_a")).toBe("Acme");
    expect(names.get("acme")).toBe("Acme");
    expect(names.get("cmp_b")).toBe("bee");
  });
});
