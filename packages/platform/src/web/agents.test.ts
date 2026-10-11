import { describe, expect, it } from "vitest";

import { AGENT_PATHS } from "../adapter.js";
import { WebPlatformAdapter } from "./index.js";

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function makeAdapter() {
  const calls: RecordedCall[] = [];
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const path = url.replace("https://api.test", "");
    const method = init?.method ?? "GET";
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    calls.push({ method, path, body });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return {
    adapter: new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: fetchMock,
    }),
    calls,
  };
}

describe("WebPlatformAdapter agents", () => {
  it("GETs status, jobs, roster, owners, and telemetry", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.agents.getProvisionOptions("cmp_1");
    await adapter.agents.getStatus("agt_1", "grok");
    await adapter.agents.listJobs("agt_1");
    await adapter.agents.listMobileRoster("cmp_1");
    await adapter.agents.listOwners("cmp_1", "agt_1");
    await adapter.agents.getCompanyTelemetry("cmp_1", "2026-08-01", "2026-09-01", "America/Denver");
    await adapter.agents.getMyTelemetry?.("2026-08-01", "2026-09-01");
    await adapter.agents.getMyTelemetry?.("2026-08-01", "2026-09-01", "America/Denver");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${AGENT_PATHS.provisionOptions("cmp_1")}`,
      `GET ${AGENT_PATHS.status("agt_1", "grok")}`,
      `GET ${AGENT_PATHS.jobs("agt_1")}`,
      `GET ${AGENT_PATHS.mobileRoster("cmp_1")}`,
      `GET ${AGENT_PATHS.owners("cmp_1", "agt_1")}`,
      "GET /v1/telemetry/company?companyUid=cmp_1&from=2026-08-01&to=2026-09-01&tz=America%2FDenver",
      "GET /v1/telemetry/me?from=2026-08-01&to=2026-09-01",
      "GET /v1/telemetry/me?from=2026-08-01&to=2026-09-01&tz=America%2FDenver",
    ]);
  });

  it("sends this machine's zone as tz on company telemetry when the caller passes none", async () => {
    const { adapter, calls } = makeAdapter();
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await adapter.agents.getCompanyTelemetry("cmp_1", "2026-08-01", "2026-09-01");
    expect(calls.map((c) => c.path)).toEqual([
      AGENT_PATHS.companyTelemetry("cmp_1", "2026-08-01", "2026-09-01", zone),
    ]);
    expect(calls[0].path).toContain(`&tz=${encodeURIComponent(zone)}`);
  });

  it("POSTs pause/stop/start/retry and PATCHes profile", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.agents.pauseJob("agt_1", "job_9");
    await adapter.agents.updateProfile("agt_1", {
      displayName: "Izzy",
      description: "Fleet",
    });
    await adapter.agents.stop("agt_1");
    await adapter.agents.start("agt_1");
    await adapter.agents.retryProvisioning("agt_1");
    await adapter.agents.restartBrainApproval!("agt_1", "grok");
    await adapter.agents.submitClaudeLoginCode!("agt_1", "returned-code");
    await adapter.agents.deprovision("agt_1");
    expect(calls).toEqual([
      {
        method: "POST",
        path: AGENT_PATHS.pauseJob("agt_1", "job_9"),
        body: undefined,
      },
      {
        method: "PATCH",
        path: AGENT_PATHS.profile("agt_1"),
        body: { displayName: "Izzy", description: "Fleet" },
      },
      { method: "POST", path: AGENT_PATHS.stop("agt_1"), body: undefined },
      { method: "POST", path: AGENT_PATHS.start("agt_1"), body: undefined },
      { method: "POST", path: "/v1/agents/agt_1/retry", body: undefined },
      { method: "POST", path: "/v1/agents/agt_1/reauth", body: { brain: "grok" } },
      { method: "POST", path: "/v1/agents/agt_1/login-code", body: { code: "returned-code" } },
      {
        method: "DELETE",
        path: AGENT_PATHS.deprovision("agt_1"),
        body: undefined,
      },
    ]);
  });

  it("names the running machine when a bot removal is confirmed", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.agents.deprovision("agt_1", {
      confirmDestroyInstanceId: "i-0abc1234def567890",
    });
    expect(calls).toEqual([
      {
        method: "DELETE",
        path: "/v1/agents/agt_1?confirmDestroyAgentsV2=i-0abc1234def567890",
        body: undefined,
      },
    ]);
  });

  it("hands back the machine a refused bot removal names", async () => {
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: "Nova is already on HQ Agents v2 (live box i-0abc1234def567890). Refused.",
            code: "AGENTS_V2_BOX_PROTECTED",
            agentUid: "agt_1",
            instanceId: "i-0abc1234def567890",
          }),
          { status: 409 },
        ),
    });
    const result = await adapter.agents.deprovision("agt_1");
    expect(result).toMatchObject({
      ok: false,
      code: "AGENTS_V2_BOX_PROTECTED",
      instanceId: "i-0abc1234def567890",
    });
  });
});
