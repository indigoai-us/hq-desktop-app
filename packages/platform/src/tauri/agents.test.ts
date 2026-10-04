import { describe, expect, it } from "vitest";

import { AGENT_PATHS } from "../adapter.js";
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
    await adapter.agents.getStatus("agt_1", "codex");
    await adapter.agents.restartBrainApproval!("agt_1", "codex");
    await adapter.agents.submitClaudeLoginCode!("agt_1", "returned-code");
    await adapter.agents.updateProfile("agt_1", { displayName: "Izzy" });
    await adapter.agents.pauseJob("agt_1", "job_9");
    await adapter.agents.retryProvisioning("agt_1");
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
        args: { url: AGENT_PATHS.status("agt_1", "codex"), method: "GET", body: null },
      },
      {
        cmd: "hq_pro_fetch",
        args: { url: AGENT_PATHS.reauth("agt_1"), method: "POST", body: JSON.stringify({ brain: "codex" }) },
      },
      {
        cmd: "hq_pro_fetch",
        args: { url: AGENT_PATHS.loginCode("agt_1"), method: "POST", body: JSON.stringify({ code: "returned-code" }) },
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
      {
        cmd: "hq_pro_fetch",
        args: {
          url: AGENT_PATHS.retryProvisioning("agt_1"),
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
    await adapter.agents.retryProvisioning("agt_1");
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
        args: { url: AGENT_PATHS.retryProvisioning("agt_1"), method: "POST", body: null },
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

describe("bot removal that names the running machine", () => {
  const CONFIRMED = {
    cmd: "hq_pro_fetch",
    args: {
      url: "/v1/agents/agt_1?confirmDestroyAgentsV2=i-0abc1234def567890",
      method: "DELETE",
      body: null,
    },
  };

  it("TauriPlatformAdapter sends the machine id on the DELETE", async () => {
    const { adapter, calls } = makeTauri();
    await adapter.agents.deprovision("agt_1", {
      confirmDestroyInstanceId: "i-0abc1234def567890",
    });
    expect(calls).toEqual([CONFIRMED]);
  });

  it("createSyncPlatformAdapter sends the machine id on the DELETE", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return { status: 200, body: JSON.stringify({ terminal: true }) };
      },
    });
    await adapter.agents.deprovision("agt_1", {
      confirmDestroyInstanceId: "i-0abc1234def567890",
    });
    expect(calls).toEqual([CONFIRMED]);
  });

  it("createSyncPlatformAdapter hands back the machine a refusal names", async () => {
    const adapter = createSyncPlatformAdapter({
      invoke: async () => ({
        status: 409,
        body: JSON.stringify({
          error: "Refused.",
          code: "AGENTS_V2_BOX_PROTECTED",
          agentUid: "agt_1",
          instanceId: "i-0abc1234def567890",
        }),
      }),
    });
    const result = await adapter.agents.deprovision("agt_1");
    expect(result).toMatchObject({
      ok: false,
      code: "AGENTS_V2_BOX_PROTECTED",
      instanceId: "i-0abc1234def567890",
    });
  });
});

describe("a refused agent status read keeps its HTTP status (review A-I4)", () => {
  // The New Bot waiting screen tells a bot that is gone (404) or out of
  // reach (403, 401) from a read that merely failed. Without the status a
  // deleted bot read as "Reconnecting" for as long as the screen stayed open.
  const refused = (status: number, body: string) => async (cmd: string) => {
    if (cmd === "hq_pro_fetch") return { status, body };
    throw new Error(`unexpected command ${cmd}`);
  };

  it.each([
    [404, '{"error":"Not found"}', "http-404"],
    [403, '{"error":"Forbidden"}', "http-403"],
    [401, '{"message":"Unauthorized"}', "http-401"],
    [404, '{"error":"Agent not found","code":"AGENT_NOT_FOUND"}', "AGENT_NOT_FOUND"],
  ])("on %i with body %s", async (status, body, code) => {
    const sync = createSyncPlatformAdapter({ invoke: refused(status, body), requestPolicy: { throttle: null } });
    await expect(sync.agents.getStatus("agt_1", "codex")).resolves.toMatchObject({ ok: false, status, code });
    const tauri = new TauriPlatformAdapter({ invoke: refused(status, body) });
    await expect(tauri.agents.getStatus("agt_1", "codex")).resolves.toMatchObject({ ok: false, status, code });
  });

  it("answers a good read unchanged", async () => {
    const invoke = async () => ({ status: 200, body: '{"setupState":{"phase":"ready"}}' });
    const sync = createSyncPlatformAdapter({ invoke, requestPolicy: { throttle: null } });
    await expect(sync.agents.getStatus("agt_1")).resolves.toEqual({ ok: true, value: { setupState: { phase: "ready" } } });
  });
});
