import { describe, expect, it, vi } from "vitest";
import { fetchCloudRoster } from "./cloud-bots.js";

const ok = <T,>(value: T) => ({ ok: true as const, value });
const fail = (message: string) => ({ ok: false as const, reason: "error" as const, message });

describe("fetchCloudRoster (QA-080)", () => {
  it("asks each company separately and tags rows with their company", async () => {
    const list = vi.fn(async (uid?: string | null) =>
      ok({ companyUid: uid, agents: [{ agentUid: `agt_${uid}`, displayName: String(uid) }] }),
    );
    const out = await fetchCloudRoster(list, ["cmp_a", "cmp_b", "cmp_a", null]);
    expect(list.mock.calls.map((c) => c[0])).toEqual(["cmp_a", "cmp_b"]);
    expect(out.failure).toBeNull();
    expect(out.agents).toEqual([
      { agentUid: "agt_cmp_a", displayName: "cmp_a", companyUid: "cmp_a" },
      { agentUid: "agt_cmp_b", displayName: "cmp_b", companyUid: "cmp_b" },
    ]);
  });

  it("keeps companies that answered when one fails", async () => {
    const list = vi.fn(async (uid?: string | null) =>
      uid === "cmp_a" ? fail("Network error") : ok({ agents: [{ agentUid: "agt_1" }] }),
    );
    const out = await fetchCloudRoster(list, ["cmp_a", "cmp_b"]);
    expect(out.failure).toBeNull();
    expect(out.agents).toHaveLength(1);
  });

  it("reports a failure only when every company failed", async () => {
    const out = await fetchCloudRoster(async () => fail("Network error"), ["cmp_a"]);
    expect(out.failure).toMatchObject({ message: "Network error" });
  });

  it("falls back to the unscoped roster when no company uid is known", async () => {
    const list = vi.fn(async () => ok({ agents: [] }));
    await fetchCloudRoster(list, []);
    expect(list).toHaveBeenCalledWith(null);
  });
});
