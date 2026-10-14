import { describe, expect, it } from "vitest";
import { COMPANY_INTEGRATIONS_TIMEOUT_SECS, createSyncPlatformAdapter } from "./sync-adapter.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

/**
 * OWNER-R15: company Integrations showed "Could not load connected apps." in
 * the real app. GET /v1/integrations/admin answered 200 in 7-10 s warm for
 * Indigo (135 connections and 50 audit rows), next to the native client's
 * shared 15 s bound, so a cold read timed out. The read goes through the
 * native hq_pro_fetch (never the webview fetch) with a longer bound.
 */
describe("company integrations read", () => {
  it("goes through hq_pro_fetch with a bound well past the 15 s default", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      fetch: (() => {
        throw new Error("the adapter must not use window.fetch");
      }) as unknown as typeof globalThis.fetch,
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        if (cmd === "hq_pro_fetch") {
          // Redacted production shape.
          return {
            status: 200,
            body: JSON.stringify({
              companyUid: "cmp_EXAMPLE",
              viewer: { personUid: "prs_EXAMPLE", role: "owner", canManageGovernance: true, canManageIntegrations: true },
              connections: Array.from({ length: 135 }, (_, i) => ({ id: `conn_${i}`, provider: "linear", status: "connected", scopes: ["factory:auth:required"] })),
              audit: Array.from({ length: 50 }, (_, i) => ({ id: `audit_${i}` })),
            }),
          };
        }
        throw new Error(`unexpected ${cmd}`);
      },
    });
    const res = await adapter.company!.listIntegrations!("cmp_EXAMPLE");
    expect(res.ok).toBe(true);
    const fetch = calls.find((c) => c.cmd === "hq_pro_fetch");
    expect(fetch?.args?.url).toBe("/v1/integrations/admin?companyUid=cmp_EXAMPLE");
    expect(fetch?.args?.timeoutSecs).toBe(COMPANY_INTEGRATIONS_TIMEOUT_SECS);
    expect(COMPANY_INTEGRATIONS_TIMEOUT_SECS).toBeGreaterThanOrEqual(30);
  });
});
