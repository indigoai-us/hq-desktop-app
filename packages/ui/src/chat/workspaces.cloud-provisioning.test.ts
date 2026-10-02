/**
 * Which companies the sync banner's Try again provisions before syncing: an
 * owned company with a cloud uid but no vault bucket was created without its
 * activate-cloud step, and syncing it can only fail with "not provisioned".
 */
import { describe, expect, it } from "vitest";

import { needsCloudProvisioning, type Workspace } from "./workspaces.js";

function company(overrides: Partial<Workspace> = {}): Workspace {
  return {
    slug: "testco",
    displayName: "Testco",
    kind: "company",
    state: "cloud-only",
    cloudUid: "cmp_testco",
    bucketName: null,
    hasLocalFolder: false,
    localPath: null,
    membershipStatus: "active",
    role: "owner",
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  } as Workspace;
}

describe("needsCloudProvisioning", () => {
  it("flags an owned company that has no vault bucket", () => {
    expect(needsCloudProvisioning(company())).toBe(true);
  });

  it("leaves a provisioned company alone", () => {
    expect(needsCloudProvisioning(company({ bucketName: "hq-vault-cmp-testco" }))).toBe(false);
  });

  it("leaves a member's company alone, because only owners can provision", () => {
    expect(needsCloudProvisioning(company({ role: "member" }))).toBe(false);
  });

  it("needs a cloud uid to provision", () => {
    expect(needsCloudProvisioning(company({ cloudUid: null }))).toBe(false);
  });

  it("never treats the personal vault as a company to provision", () => {
    expect(
      needsCloudProvisioning(company({ kind: "personal", slug: "personal", state: "personal" })),
    ).toBe(false);
  });
});
