import { describe, expect, it, vi } from "vitest";
import {
  HQ_STORAGE_FLAG,
  STORAGE_FEATURE_DISABLED_CODE,
  isStorageFeatureDisabled,
  resolveStorageFeature,
} from "./storage-feature.js";

const ok = (value: unknown) => async () => ({ ok: true, value });

describe("resolveStorageFeature (hq-storage allowlist, fails closed)", () => {
  it("uses the key shared with hq-cli", () => {
    expect(HQ_STORAGE_FLAG).toBe("hq-storage");
  });

  it("is off without an identity or a company flag reader", async () => {
    await expect(resolveStorageFeature(null)).resolves.toBe(false);
    await expect(resolveStorageFeature({ listWorkspaces: ok([]) })).resolves.toBe(false);
  });

  it("reads the flag per active company and is on when any says true", async () => {
    const hasCompanyFeature = vi.fn(async (_f: string, uid: string) => uid === "cmp_indigo01");
    await expect(
      resolveStorageFeature({
        listWorkspaces: ok([
          { cloudUid: "cmp_acme0001", membershipStatus: "active" },
          { companyUid: "cmp_indigo01", status: "active" },
        ]),
        hasCompanyFeature,
      }),
    ).resolves.toBe(true);
    expect(hasCompanyFeature).toHaveBeenCalledWith("hq-storage", "cmp_acme0001");
  });

  it("is off when every company says false, the read rejects, or memberships fail", async () => {
    const rows = ok([{ cloudUid: "cmp_indigo01", membershipStatus: "active" }]);
    await expect(resolveStorageFeature({ listWorkspaces: rows, hasCompanyFeature: async () => false })).resolves.toBe(false);
    await expect(
      resolveStorageFeature({
        listWorkspaces: rows,
        hasCompanyFeature: async () => {
          throw new Error("down");
        },
      }),
    ).resolves.toBe(false);
    await expect(
      resolveStorageFeature({ listWorkspaces: async () => ({ ok: false }), hasCompanyFeature: async () => true }),
    ).resolves.toBe(false);
    await expect(
      resolveStorageFeature({
        listWorkspaces: async () => {
          throw new Error("ipc");
        },
        hasCompanyFeature: async () => true,
      }),
    ).resolves.toBe(false);
  });

  it("skips pending invites and rows without a cloud uid", async () => {
    const hasCompanyFeature = vi.fn(async () => true);
    await expect(
      resolveStorageFeature({
        listWorkspaces: ok([
          { cloudUid: "cmp_indigo01", membershipStatus: "pending" },
          { cloudUid: null },
          { companyUid: "not-a-uid", status: "active" },
        ]),
        hasCompanyFeature,
      }),
    ).resolves.toBe(false);
    expect(hasCompanyFeature).not.toHaveBeenCalled();
  });
});

describe("isStorageFeatureDisabled", () => {
  it("matches only the bridge's feature-disabled code", () => {
    expect(isStorageFeatureDisabled(STORAGE_FEATURE_DISABLED_CODE)).toBe(true);
    expect(isStorageFeatureDisabled("update-hq")).toBe(false);
    expect(isStorageFeatureDisabled(null)).toBe(false);
  });
});
