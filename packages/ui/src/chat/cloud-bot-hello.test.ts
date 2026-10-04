import { describe, expect, it, vi } from "vitest";
import { ok, type PlatformAdapter } from "@hq/platform";

import { composeCloudBotHello } from "./cloud-bot-hello.js";
import { recordGrant } from "./messaging/connection-card-model.js";

const NOVA = "agt_nova";
const COMPANY = "cmp_acme";

const status = (over: Record<string, unknown> = {}, capability = "unknown") => ({
  setupState: { phase: "ready" },
  agent: {
    companyUid: COMPANY,
    runtime: { syncOkAt: "2026-10-02T14:20:00.000Z" },
    channels: capability === "ok" ? { slack: { appId: "A1" } } : null,
    channelDiagnostics: { slack: { inboundCapability: capability } },
    ...over,
  },
});

const LIST = {
  companyUid: COMPANY,
  viewer: { personUid: "prs_me", role: "owner", canManageIntegrations: true },
  connections: [
    {
      id: "acct_linear",
      provider: "factory:linear",
      status: "connected",
      createdBy: "prs_me",
      createdAt: "2026-10-02T14:10:00.000Z",
      access: { mode: "private" },
      installation: { displayName: "Linear", domain: "linear.app" },
    },
    {
      id: "acct_notion",
      provider: "factory:notion",
      status: "connected",
      createdBy: "prs_teammate",
      createdAt: "2026-10-02T14:30:00.000Z",
      access: { mode: "everyone" },
      installation: { displayName: "Notion", domain: "notion.so" },
    },
  ],
  audit: [{ provider: "factory:linear", connectionId: "acct_linear" }, { provider: "factory:linear", connectionId: "acct_linear" }],
};

function adapter(over: { getStatus?: unknown; listConnections?: unknown } = {}) {
  const getStatus = vi.fn(async () => ok(status()));
  const listConnections = vi.fn(async () => ok(LIST));
  return {
    getStatus,
    listConnections,
    adapter: {
      agents: { getStatus: over.getStatus ?? getStatus },
      integrations: { listConnections: over.listConnections ?? listConnections },
    } as unknown as Pick<PlatformAdapter, "agents" | "integrations">,
  };
}

describe("composeCloudBotHello: the hello request with the company's apps", () => {
  it("reads the status and the list once, and writes the apps brief into the request", async () => {
    const a = adapter();
    const hello = await composeCloudBotHello(a.adapter, { agentUid: NOVA, personName: "Corey" });
    expect(a.getStatus).toHaveBeenCalledTimes(1);
    expect(a.listConnections).toHaveBeenCalledTimes(1);
    expect(a.listConnections).toHaveBeenCalledWith(COMPANY);
    expect(hello.companyUid).toBe(COMPANY);
    expect(hello.companyApps).toBe(
      "- Linear (linear.app): connected, not shared with you, 2 recent calls\n- Notion (notion.so): connected, you can use it",
    );
    expect(hello.body).toContain(`The company's connected apps:\n${hello.companyApps}\n`);
    expect(hello.body).toContain("Corey cannot see this message");
    expect(hello.body).not.toContain("still downloading");
    expect(hello.body.length).toBeLessThan(4000);
  });

  it("says what was granted from here as usable, and says Slack first when the bot is in Slack", async () => {
    const a = adapter({ getStatus: vi.fn(async () => ok(status({}, "ok"))) });
    const hello = await composeCloudBotHello(a.adapter, {
      agentUid: NOVA,
      personName: "Corey",
      record: recordGrant(null, "acct_linear", "Linear", Date.now()),
    });
    expect(hello.companyApps?.split("\n")).toEqual([
      "- Slack: connected, you can use it",
      "- Linear (linear.app): connected, you can use it, 2 recent calls",
      "- Notion (notion.so): connected, you can use it",
    ]);
  });

  it("writes no apps section when the list fails, and still sends the hello", async () => {
    const a = adapter({ listConnections: vi.fn(async () => ({ ok: false, reason: "error", code: "http-500", message: "boom" })) });
    const hello = await composeCloudBotHello(a.adapter, { agentUid: NOVA, personName: "Corey" });
    expect(hello.companyApps).toBeNull();
    expect(hello.body).not.toContain("connected apps:");
    expect(hello.body).not.toContain("no connected apps");
    expect(hello.body).toContain("say hello and offer what Corey could connect");
    const thrown = adapter({ listConnections: vi.fn(async () => Promise.reject(new Error("offline"))) });
    expect((await composeCloudBotHello(thrown.adapter, { agentUid: NOVA, personName: "Corey" })).companyApps).toBeNull();
  });

  it("says the company has no connected apps when the list is empty", async () => {
    const a = adapter({ listConnections: vi.fn(async () => ok({ ...LIST, connections: [], audit: [] })) });
    const hello = await composeCloudBotHello(a.adapter, { agentUid: NOVA, personName: "Corey" });
    expect(hello.companyApps).toBe("");
    expect(hello.body).toContain("The company has no connected apps yet.");
  });

  it("makes no list call when the status fails and no company is known, and says the files are still downloading", async () => {
    const a = adapter({ getStatus: vi.fn(async () => ({ ok: false, reason: "error", code: "http-403" })) });
    const hello = await composeCloudBotHello(a.adapter, { agentUid: NOVA, personName: "Corey" });
    expect(a.listConnections).not.toHaveBeenCalled();
    expect(hello.companyUid).toBeNull();
    expect(hello.companyApps).toBeNull();
    expect(hello.body).toContain("still downloading");
  });

  it("falls back to the row's company when the status does not name one", async () => {
    const a = adapter({ getStatus: vi.fn(async () => ok({ setupState: { phase: "ready" }, agent: { runtime: { syncOkAt: "x" } } })) });
    const hello = await composeCloudBotHello(a.adapter, { agentUid: NOVA, personName: "Corey", companyUidHint: COMPANY });
    expect(a.listConnections).toHaveBeenCalledWith(COMPANY);
    expect(hello.companyApps).toContain("Linear (linear.app)");
  });
});
