import { describe, expect, it } from "vitest";

import { WebPlatformAdapter } from "./index.js";
import { createSyncPlatformAdapter } from "../tauri/sync-adapter.js";

/**
 * The Groups pane creates a group with hq-pro POST /secrets/{co}/groups
 * (handleGroupCreate): body { groupId, name, description? }, 201 { group }.
 * A refusal keeps its HTTP status so the pane can tell a duplicate (409)
 * from a permission refusal (403). These tests never reach a live server.
 */
const BODY = { groupId: "grp_design-team", name: "Design Team", description: "Brand" };

function webAdapter(answer: { status: number; body: unknown }) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      method: init?.method ?? "GET",
      path: String(input).replace("https://api.test", ""),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  const adapter = new WebPlatformAdapter({ baseUrl: "https://api.test", fetch: fetchMock, requestPolicy: { maxAttempts: 1 } });
  return { adapter, calls };
}

describe("files.createAccessGroup (web)", () => {
  it("posts the group to /secrets/{co}/groups and returns the created group", async () => {
    const { adapter, calls } = webAdapter({ status: 201, body: { group: { ...BODY, companyUid: "cmp_EXAMPLE" } } });
    const res = await adapter.files.createAccessGroup!("cmp_EXAMPLE", BODY);
    expect(calls).toEqual([{ method: "POST", path: "/secrets/cmp_EXAMPLE/groups", body: BODY }]);
    expect(res.ok).toBe(true);
    if (res.ok) expect((res.value as { group: { groupId: string } }).group.groupId).toBe("grp_design-team");
  });

  it("keeps the status on a duplicate and a permission refusal", async () => {
    for (const status of [409, 403]) {
      const { adapter } = webAdapter({ status, body: { error: "refused" } });
      const res = await adapter.files.createAccessGroup!("cmp_EXAMPLE", BODY);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(status);
        expect(res.code).toBe(`http-${status}`);
      }
    }
  });
});

describe("files.createAccessGroup (desktop sync adapter)", () => {
  it("posts through hq_pro_fetch and keeps the status on a refusal", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const adapter = createSyncPlatformAdapter({
      fetch: (() => {
        throw new Error("the adapter must not use window.fetch");
      }) as unknown as typeof globalThis.fetch,
      invoke: async (cmd, args) => {
        if (cmd === "hq_pro_fetch") {
          seen.push(args as Record<string, unknown>);
          return { status: 409, body: JSON.stringify({ error: "exists" }) };
        }
        throw new Error(`unexpected ${cmd}`);
      },
    });
    const res = await adapter.files!.createAccessGroup!("cmp_EXAMPLE", BODY);
    expect(seen[0]?.url).toBe("/secrets/cmp_EXAMPLE/groups");
    expect(seen[0]?.method).toBe("POST");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(409);
  });
});
