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
    await adapter.agents.getStatus("agt_1");
    await adapter.agents.listJobs("agt_1");
    await adapter.agents.listMobileRoster("cmp_1");
    await adapter.agents.listOwners("cmp_1", "agt_1");
    await adapter.agents.getCompanyTelemetry("cmp_1", "2026-08-01", "2026-09-01");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${AGENT_PATHS.status("agt_1")}`,
      `GET ${AGENT_PATHS.jobs("agt_1")}`,
      `GET ${AGENT_PATHS.mobileRoster("cmp_1")}`,
      `GET ${AGENT_PATHS.owners("cmp_1", "agt_1")}`,
      `GET ${AGENT_PATHS.companyTelemetry("cmp_1", "2026-08-01", "2026-09-01")}`,
    ]);
  });

  it("POSTs pause/stop/start and PATCHes profile", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.agents.pauseJob("agt_1", "job_9");
    await adapter.agents.updateProfile("agt_1", {
      displayName: "Izzy",
      description: "Fleet",
    });
    await adapter.agents.stop("agt_1");
    await adapter.agents.start("agt_1");
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
      {
        method: "DELETE",
        path: AGENT_PATHS.deprovision("agt_1"),
        body: undefined,
      },
    ]);
  });
});
