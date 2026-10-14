import { describe, expect, it } from "vitest";
import { createSyncPlatformAdapter } from "./sync-adapter.js";

/**
 * Company telemetry reads carry this machine's IANA zone as `tz`, so hq-pro can
 * report which zone it cut the days in (`bucketTz`) and the charts can label
 * days that are not local. A caller-supplied zone wins over the machine's.
 */
describe("company telemetry sends the local zone", () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function adapterWith(record: Array<{ cmd: string; args: unknown }>) {
    return createSyncPlatformAdapter({
      fetch: (() => {
        throw new Error("the adapter must not use window.fetch");
      }) as unknown as typeof globalThis.fetch,
      invoke: async (cmd, args) => {
        record.push({ cmd, args });
        if (cmd === "hq_pro_fetch") return { status: 200, body: "{}" };
        return {};
      },
    });
  }

  it("getTeamTelemetry passes tz to the Tauri command, with or without a range", async () => {
    const record: Array<{ cmd: string; args: unknown }> = [];
    const adapter = adapterWith(record);
    await adapter.company.getTeamTelemetry("acme");
    await adapter.company.getTeamTelemetry("acme", { from: "2026-10-01", to: "2026-10-07" });
    await adapter.company.getTeamTelemetry("acme", {
      from: "2026-10-01",
      to: "2026-10-07",
      tz: "Asia/Tokyo",
    });
    const calls = record.filter((r) => r.cmd === "get_company_team_telemetry").map((r) => r.args);
    expect(calls).toEqual([
      { slug: "acme", tz: zone },
      { slug: "acme", from: "2026-10-01", to: "2026-10-07", tz: zone },
      { slug: "acme", from: "2026-10-01", to: "2026-10-07", tz: "Asia/Tokyo" },
    ]);
  });

  it("agents.getCompanyTelemetry appends tz to the hq-pro URL", async () => {
    const record: Array<{ cmd: string; args: unknown }> = [];
    const adapter = adapterWith(record);
    await adapter.agents!.getCompanyTelemetry("cmp_1", "2026-10-01", "2026-10-07");
    await adapter.agents!.getCompanyTelemetry("cmp_1", "2026-10-01", "2026-10-07", "Asia/Tokyo");
    const urls = record
      .filter((r) => r.cmd === "hq_pro_fetch")
      .map((r) => String((r.args as { url?: unknown }).url));
    expect(urls).toEqual([
      `/v1/telemetry/company?companyUid=cmp_1&from=2026-10-01&to=2026-10-07&tz=${encodeURIComponent(zone)}`,
      "/v1/telemetry/company?companyUid=cmp_1&from=2026-10-01&to=2026-10-07&tz=Asia%2FTokyo",
    ]);
  });
});
