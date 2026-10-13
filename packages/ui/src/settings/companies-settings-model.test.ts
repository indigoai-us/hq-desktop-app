import { describe, expect, it, vi } from "vitest";
import { companySettingsRows, withRetry } from "./companies-settings-model.js";

const ws = (over: Record<string, unknown>) =>
  ({ slug: "a", displayName: "A", kind: "company", state: "synced", cloudUid: "cmp_a", role: "member", membershipStatus: "active", ...over }) as never;

describe("companySettingsRows", () => {
  it("maps workspace state to storage and only cloud rows get a mode choice", () => {
    const rows = companySettingsRows([
      ws({ slug: "c", state: "synced" }),
      ws({ slug: "l", state: "local-only", cloudUid: null }),
      ws({ slug: "b", state: "broken" }),
      ws({ slug: "o", state: "cloud-only" }),
      ws({ slug: "i", state: "cloud-only", membershipStatus: "pending" }),
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.slug, r]));
    expect(by.c!.storage).toBe("cloud");
    expect(by.o!.storage).toBe("cloud");
    expect(by.l!.storage).toBe("local");
    expect(by.b!.storage).toBe("reconnect");
    expect(by.i!.storage).toBe("invite");
    expect(rows.filter((r) => r.canChooseSyncMode).map((r) => r.slug).sort()).toEqual(["c", "o"]);
    expect(rows.filter((r) => r.canConvert).map((r) => r.slug).sort()).toEqual(["b", "l"]);
  });

  it("skips personal, dedupes by slug, prefers roster roles and sorts owners first", () => {
    const rows = companySettingsRows(
      [
        ws({ slug: "personal", kind: "personal" }),
        ws({ slug: "z", displayName: "Zed", cloudUid: "cmp_z", role: "member" }),
        ws({ slug: "z", displayName: "Zed dup" }),
        ws({ slug: "b", displayName: "Bee", cloudUid: "cmp_b", role: "member" }),
        ws({ slug: "gone", displayName: "Gone", membershipStatus: "revoked" }),
      ],
      [{ uid: "cmp_z", label: "Zed", role: "Owner" }],
    );
    expect(rows.map((r) => [r.slug, r.role])).toEqual([["z", "Owner"], ["b", "Member"]]);
    expect(rows[0]!.isOwnerOrAdmin).toBe(true);
  });
});

describe("withRetry", () => {
  it("stops on the first success and backs off between tries", async () => {
    const sleep = vi.fn(async () => {});
    const run = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    const result = await withRetry(run, { sleep, baseDelayMs: 100 });
    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("returns the last failure after three tries, including thrown errors", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi.fn().mockRejectedValue(new Error("boom"));
    const result = await withRetry(run, { sleep: async () => {} });
    expect(result.ok).toBe(false);
    expect(run).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});
