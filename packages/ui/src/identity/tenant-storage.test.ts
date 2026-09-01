import { describe, expect, it } from "vitest";
import { createTenantStorage, tenantStorageKey } from "./tenant-storage.js";

function memoryStorage(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

describe("tenant storage", () => {
  it("partitions the same renderer cache by account and company", () => {
    const storage = memoryStorage();
    const adaIndigo = createTenantStorage(storage, {
      accountId: "acct_ada",
      companyId: "cmp_indigo",
    });
    const graceIndigo = createTenantStorage(storage, {
      accountId: "acct_grace",
      companyId: "cmp_indigo",
    });
    const adaOther = createTenantStorage(storage, {
      accountId: "acct_ada",
      companyId: "cmp_other",
    });

    adaIndigo.setItem("hq.chat.channel-directory-cursor", "cursor-a");

    expect(adaIndigo.getItem("hq.chat.channel-directory-cursor")).toBe("cursor-a");
    expect(graceIndigo.getItem("hq.chat.channel-directory-cursor")).toBeNull();
    expect(adaOther.getItem("hq.chat.channel-directory-cursor")).toBeNull();
    expect(tenantStorageKey({ accountId: "acct_ada", companyId: "cmp_indigo" }, "hq.chat.dm-inbox-since"))
      .toContain("acct_ada");
  });

  it("ignores legacy global keys rather than showing them to a new tenant", () => {
    const storage = memoryStorage({
      "hq.chat.conversation-cache": JSON.stringify({ channels: [{ name: "A private" }] }),
      "hq-work-settings-prefs": JSON.stringify({ defaultCompanyId: "cmp_old" }),
    });
    const scoped = createTenantStorage(storage, {
      accountId: "acct_new",
      companyId: "cmp_new",
    });

    expect(scoped.getItem("hq.chat.conversation-cache")).toBeNull();
    expect(scoped.getItem("hq-work-settings-prefs")).toBeNull();
  });

  it("does not read or write until a stable account partition is known", () => {
    const storage = memoryStorage();
    const unknown = createTenantStorage(storage, { accountId: null, companyId: "cmp_indigo" });

    unknown.setItem("hq.chat.dm-inbox-since", "cursor");
    expect(unknown.getItem("hq.chat.dm-inbox-since")).toBeNull();
    expect(storage.values.size).toBe(0);
  });
});
