import { describe, expect, it } from "vitest";

import {
  isSelf,
  selfIsAdmin,
  toSelfIdentity,
  resolveShellCompanies,
  accountChromeFromSelf,
  settingsProfileFromSelf,
} from "./self.js";
import type { Workspace } from "../chat/workspaces.js";

function ws(partial: Partial<Workspace>): Workspace {
  return {
    slug: "acme",
    displayName: "Acme",
    kind: "company",
    state: "synced",
    cloudUid: "co_acme",
    bucketName: null,
    hasLocalFolder: false,
    localPath: null,
    membershipStatus: "active",
    role: "member",
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...partial,
  };
}

describe("isSelf", () => {
  it("matches the signed-in uid (trim-safe)", () => {
    const self = { uid: "prs_me" };
    expect(isSelf("prs_me", self)).toBe(true);
    expect(isSelf("  prs_me  ", self)).toBe(true);
    expect(isSelf("prs_other", self)).toBe(false);
  });

  it("is false for a non-matching uid", () => {
    expect(isSelf("prs_other", { uid: "prs_me" })).toBe(false);
  });

  it("never tags when self is absent (unauth / fixture path)", () => {
    expect(isSelf("prs_me", null)).toBe(false);
    expect(isSelf("prs_me", undefined)).toBe(false);
    expect(isSelf(null, { uid: "prs_me" })).toBe(false);
  });
});

describe("toSelfIdentity", () => {
  it("accepts uid or session sub, and collapses blanks to null", () => {
    expect(toSelfIdentity({ sub: "prs_x", email: "x@y.z" })).toEqual({
      uid: "prs_x",
      email: "x@y.z",
      displayName: null,
    });
    expect(toSelfIdentity({ uid: "prs_y" })?.uid).toBe("prs_y");
    expect(toSelfIdentity({ sub: "  " })).toBeNull();
    expect(toSelfIdentity(null)).toBeNull();
  });

  it("maps the JWT name claim onto displayName", () => {
    expect(
      toSelfIdentity({
        sub: "prs_s",
        email: "stefan@getindigo.ai",
        name: "Stefan Johnson",
      }),
    ).toEqual({
      uid: "prs_s",
      email: "stefan@getindigo.ai",
      displayName: "Stefan Johnson",
    });
  });
});

describe("accountChromeFromSelf / settingsProfileFromSelf", () => {
  it("prefers display name for the account chip and settings profile", () => {
    const self = {
      uid: "prs_s",
      email: "stefan@getindigo.ai",
      displayName: "Stefan Johnson",
    };
    expect(accountChromeFromSelf(self)).toEqual({
      label: "Stefan Johnson",
      initials: "SJ",
    });
    expect(settingsProfileFromSelf(self)).toEqual({
      initial: "S",
      fullName: "Stefan Johnson",
      displayName: "Stefan",
      email: "stefan@getindigo.ai",
      verified: true,
    });
  });

  it("falls back to email when the name claim is missing", () => {
    const self = { uid: "prs_s", email: "stefan@getindigo.ai" };
    expect(accountChromeFromSelf(self)).toEqual({
      label: "stefan@getindigo.ai",
      initials: "ST",
    });
    expect(settingsProfileFromSelf(self)?.displayName).toBe("stefan");
  });

  it("is null without a session so hosts show empty account chrome", () => {
    expect(accountChromeFromSelf(null)).toBeNull();
    expect(settingsProfileFromSelf(undefined)).toBeNull();
    expect(accountChromeFromSelf({ uid: "prs_x" })).toBeNull();
  });
});

describe("selfIsAdmin", () => {
  it("honors an explicit override before any derivation", () => {
    expect(selfIsAdmin([ws({ role: "member" })], true)).toBe(true);
    expect(selfIsAdmin([ws({ role: "owner" })], false)).toBe(false);
  });

  it("derives admin/owner from active membership roles", () => {
    expect(selfIsAdmin([ws({ role: "owner" })])).toBe(true);
    expect(selfIsAdmin([ws({ role: "admin" })])).toBe(true);
    expect(selfIsAdmin([ws({ role: "member" })])).toBe(false);
  });

  it("ignores personal workspaces and inactive memberships", () => {
    expect(selfIsAdmin([ws({ kind: "personal", role: "owner" })])).toBe(false);
    expect(
      selfIsAdmin([ws({ role: "owner", membershipStatus: "pending" })]),
    ).toBe(false);
  });

  it("defaults to false when unknown (empty / nullish)", () => {
    expect(selfIsAdmin(null)).toBe(false);
    expect(selfIsAdmin([])).toBe(false);
  });
});

describe("resolveShellCompanies — precedence memberships > overlay > empty", () => {
  const fixtures = [ws({ slug: "fixture", cloudUid: "co_fixture" })];
  const overlayCompanies = [ws({ slug: "overlay", cloudUid: "co_overlay" })];
  const membershipRows = [
    {
      companyUid: "co_real",
      companyName: "Real Co",
      role: "owner",
      status: "active",
    },
  ];

  it("uses real memberships when authenticated and present", () => {
    const out = resolveShellCompanies({
      authed: true,
      membershipRows,
      overlayCompanies,
      fixtures,
    });
    expect(out).toHaveLength(1);
    expect(out[0].cloudUid).toBe("co_real");
    expect(out[0].displayName).toBe("Real Co");
    expect(out[0].role).toBe("owner");
  });

  it("falls back to the local-mesh overlay when memberships are empty", () => {
    const out = resolveShellCompanies({
      authed: true,
      membershipRows: [],
      overlayCompanies,
      fixtures,
    });
    expect(out).toBe(overlayCompanies);
  });

  it("uses the overlay when unauthenticated (memberships ignored)", () => {
    const out = resolveShellCompanies({
      authed: false,
      membershipRows,
      overlayCompanies,
      fixtures,
    });
    expect(out).toBe(overlayCompanies);
  });

  it("stays empty when there is no overlay (no fixture fallback)", () => {
    expect(
      resolveShellCompanies({
        authed: false,
        overlayCompanies: null,
      }),
    ).toEqual([]);
    expect(
      resolveShellCompanies({
        authed: true,
        membershipRows: [],
        overlayCompanies: [],
      }),
    ).toEqual([]);
  });

  it("only uses fixtures when a caller still supplies them", () => {
    expect(
      resolveShellCompanies({
        authed: false,
        fixtures,
        overlayCompanies: null,
      }),
    ).toBe(fixtures);
  });

  it("degrades gracefully when the membership payload is unusable", () => {
    expect(
      resolveShellCompanies({
        authed: true,
        membershipRows: undefined,
        overlayCompanies,
      }),
    ).toBe(overlayCompanies);
    expect(
      resolveShellCompanies({
        authed: true,
        membershipRows: "boom" as unknown,
        overlayCompanies: null,
      }),
    ).toEqual([]);
  });
});
