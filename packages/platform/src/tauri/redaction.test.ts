import { describe, expect, it } from "vitest";
import { createSyncPlatformAdapter } from "./sync-adapter.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

const ANSWER = {
  companyUid: "cmp_EXAMPLE",
  connectionId: "conn_EXAMPLE",
  presets: ["personal-ids", "hr-pay", "financial"],
  availablePresets: ["personal-ids", "hr-pay", "legal", "financial"],
  isDefault: false,
  updatedAt: "2026-10-12T00:00:00Z",
  updatedBy: "prs_EXAMPLE",
  canEdit: true,
};

function adapterAnswering(status: number, body: unknown, calls: Invocation[]) {
  return createSyncPlatformAdapter({
    fetch: (() => {
      throw new Error("the adapter must not use window.fetch");
    }) as unknown as typeof globalThis.fetch,
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "hq_pro_fetch") return { status, body: JSON.stringify(body) };
      throw new Error(`unexpected ${cmd}`);
    },
  });
}

describe("US-004 redaction presets client", () => {
  it("reads one connection through hq_pro_fetch", async () => {
    const calls: Invocation[] = [];
    const adapter = adapterAnswering(200, ANSWER, calls);
    const res = await adapter.company!.getRedaction!("cmp_EXAMPLE", "conn_EXAMPLE");
    expect(res).toEqual({ ok: true, value: ANSWER });
    const fetch = calls.find((c) => c.cmd === "hq_pro_fetch");
    expect(fetch?.args?.method).toBe("GET");
    expect(fetch?.args?.url).toBe(
      "/v1/integrations/admin/redaction?companyUid=cmp_EXAMPLE&connectionId=conn_EXAMPLE",
    );
    expect(fetch?.args?.body).toBeNull();
  });

  it("PUTs the whole list of presets that are on", async () => {
    const calls: Invocation[] = [];
    const adapter = adapterAnswering(200, { ...ANSWER, presets: [] }, calls);
    const res = await adapter.company!.putRedaction!("cmp_EXAMPLE", "conn_EXAMPLE", []);
    expect(res.ok).toBe(true);
    const fetch = calls.find((c) => c.cmd === "hq_pro_fetch");
    expect(fetch?.args?.method).toBe("PUT");
    expect(fetch?.args?.url).toBe("/v1/integrations/admin/redaction");
    expect(JSON.parse(String(fetch?.args?.body))).toEqual({
      companyUid: "cmp_EXAMPLE",
      connectionId: "conn_EXAMPLE",
      presets: [],
    });
  });

  it("keeps the status and server code of a 403", async () => {
    const calls: Invocation[] = [];
    const adapter = adapterAnswering(
      403,
      { error: "Only owners and admins can change this", code: "REDACTION_ADMIN_REQUIRED" },
      calls,
    );
    const res = await adapter.company!.putRedaction!("cmp_EXAMPLE", "conn_EXAMPLE", ["legal"]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(403);
    expect(res.code).toBe("REDACTION_ADMIN_REQUIRED");
  });
});
