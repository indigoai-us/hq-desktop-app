import { describe, expect, it } from "vitest";

import { AGENT_PATHS, OUTPOST_PATHS } from "../adapter.js";
import { TauriPlatformAdapter } from "./index.js";
import { createSyncPlatformAdapter } from "./sync-adapter.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

function makeTauri() {
  const calls: Invocation[] = [];
  const adapter = new TauriPlatformAdapter({
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 200, body: JSON.stringify({ ok: true }) };
    },
  });
  return { adapter, calls };
}

describe("TauriPlatformAdapter agents", () => {
  it("routes agent reads and mutations through hq_pro_fetch", async () => {
    const { adapter, calls } = makeTauri();
    await adapter.agents.getProvisionOptions("cmp_1");
    await adapter.agents.getStatus("agt_1");
    await adapter.agents.updateProfile("agt_1", { displayName: "Izzy" });
    await adapter.agents.pauseJob("agt_1", "job_9");
    expect(calls).toEqual([
      {
        cmd: "hq_pro_fetch",
        args: {
          url: AGENT_PATHS.provisionOptions("cmp_1"),
          method: "GET",
          body: null,
        },
      },
      {
        cmd: "hq_pro_fetch",
        args: { url: AGENT_PATHS.status("agt_1"), method: "GET", body: null },
      },
      {
        cmd: "hq_pro_fetch",
        args: {
          url: AGENT_PATHS.profile("agt_1"),
          method: "PATCH",
          body: JSON.stringify({ displayName: "Izzy" }),
        },
      },
      {
        cmd: "hq_pro_fetch",
        args: {
          url: AGENT_PATHS.pauseJob("agt_1", "job_9"),
          method: "POST",
          body: null,
        },
      },
    ]);
  });
});

describe("createSyncPlatformAdapter agents", () => {
  it("uses the same hq_pro_fetch paths as TauriPlatformAdapter", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return { status: 200, body: JSON.stringify({ ok: true }) };
      },
    });
    await adapter.agents.getProvisionOptions("cmp_1");
    await adapter.agents.listJobs("agt_1");
    await adapter.agents.deprovision("agt_1");
    expect(calls).toEqual([
      {
        cmd: "hq_pro_fetch",
        args: {
          url: AGENT_PATHS.provisionOptions("cmp_1"),
          method: "GET",
          body: null,
        },
      },
      {
        cmd: "hq_pro_fetch",
        args: { url: AGENT_PATHS.jobs("agt_1"), method: "GET", body: null },
      },
      {
        cmd: "hq_pro_fetch",
        args: {
          url: AGENT_PATHS.deprovision("agt_1"),
          method: "DELETE",
          body: null,
        },
      },
    ]);
  });
});

describe("createSyncPlatformAdapter personal Outpost", () => {
  it("reads the caller's Outpost status and job rows through hq_pro_fetch", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return { status: 200, body: JSON.stringify({ statuses: [] }) };
      },
    });
    const jobs = await adapter.agents.listMyOutpostJobs?.();
    await adapter.agents.getMyOutpostStatus?.();
    expect(jobs).toEqual({ ok: true, value: { statuses: [] } });
    expect(calls).toEqual([
      { cmd: "hq_pro_fetch", args: { url: OUTPOST_PATHS.jobsStatus, method: "GET", body: null } },
      { cmd: "hq_pro_fetch", args: { url: OUTPOST_PATHS.status, method: "POST", body: "{}" } },
    ]);
  });

  it("surfaces a missing Outpost as an http-404 failure", async () => {
    const adapter = createSyncPlatformAdapter({
      invoke: async () => ({ status: 404, body: JSON.stringify({ error: true, message: "not found" }) }),
    });
    const res = await adapter.agents.getMyOutpostStatus?.();
    expect(res?.ok).toBe(false);
    expect(res && !res.ok ? res.code : "").toBe("http-404");
  });
});

describe("createSyncPlatformAdapter personal integrations", () => {
  it("reads Google and personal Slack accounts on the console's routes", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return { status: 200, body: JSON.stringify({ accounts: [] }) };
      },
    });
    await adapter.agents.listMyGoogleAccounts?.();
    await adapter.agents.listMySlackAccounts?.();
    expect("disconnectMyGoogleAccount" in adapter.agents).toBe(false);
    expect("disconnectMySlackAccount" in adapter.agents).toBe(false);
    expect(calls.map((c) => [c.args?.method, c.args?.url])).toEqual([
      ["GET", "/v1/google/accounts"],
      ["GET", "/v1/slack/personal/accounts"],
    ]);
  });
});
