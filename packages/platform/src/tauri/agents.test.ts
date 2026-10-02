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
