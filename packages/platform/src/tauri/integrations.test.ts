import { describe, expect, it } from "vitest";

import { INTEGRATION_PATHS, type PlatformAdapter } from "../adapter.js";
import { createDesktopAdapter } from "../desktop/index.js";
import { TauriPlatformAdapter } from "./index.js";
import { createSyncPlatformAdapter } from "./sync-adapter.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

type Respond = () => { status: number; body: string };

const OK: Respond = () => ({ status: 200, body: JSON.stringify({ ok: true }) });

function makeTauri(respond: Respond = OK) {
  const calls: Invocation[] = [];
  const adapter = new TauriPlatformAdapter({
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      return respond();
    },
  });
  return { adapter, calls };
}

function makeSync(respond: Respond = OK) {
  const calls: Invocation[] = [];
  const adapter = createSyncPlatformAdapter({
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      return respond();
    },
  });
  return { adapter, calls };
}

const GRANT = { companyUid: "cmp_acme", connectionId: "acct_linear", granteeUid: "agt_nova" };

const EXPECTED: Invocation[] = [
  {
    cmd: "hq_pro_fetch",
    args: { url: INTEGRATION_PATHS.connections("cmp_acme"), method: "GET", body: null },
  },
  {
    cmd: "hq_pro_fetch",
    args: {
      url: INTEGRATION_PATHS.grantAccess,
      method: "POST",
      body: JSON.stringify({
        companyUid: "cmp_acme",
        connectionId: "acct_linear",
        granteeType: "person",
        granteeId: "agt_nova",
      }),
    },
  },
];

async function callBoth(adapter: PlatformAdapter): Promise<void> {
  await adapter.integrations.listConnections("cmp_acme");
  await adapter.integrations.grantConnectionAccess(GRANT);
}

describe("TauriPlatformAdapter integrations", () => {
  it("routes the list and the grant through hq_pro_fetch, like agent status", async () => {
    const { adapter, calls } = makeTauri();
    await callBoth(adapter);
    expect(calls).toEqual(EXPECTED);
  });

  it("returns a refused grant as a failure that names the 403", async () => {
    const { adapter } = makeTauri(() => ({
      status: 403,
      body: JSON.stringify({ error: "Only the connection owner or a company admin can manage access" }),
    }));
    const result = await adapter.integrations.grantConnectionAccess(GRANT);
    expect(result).toEqual({
      ok: false,
      reason: "error",
      code: "http-403",
      message: "Only the connection owner or a company admin can manage access",
    });
  });
});

describe("createSyncPlatformAdapter integrations", () => {
  it("uses the same hq_pro_fetch paths as TauriPlatformAdapter", async () => {
    const { adapter, calls } = makeSync();
    await callBoth(adapter);
    expect(calls).toEqual(EXPECTED);
  });

  it("returns the list the server sent", async () => {
    const list = { companyUid: "cmp_acme", viewer: { canManageIntegrations: true }, connections: [] };
    const { adapter } = makeSync(() => ({ status: 200, body: JSON.stringify(list) }));
    expect(await adapter.integrations.listConnections("cmp_acme")).toEqual({ ok: true, value: list });
  });

  it("returns a refused grant as a failure that names the 403", async () => {
    const { adapter } = makeSync(() => ({
      status: 403,
      body: JSON.stringify({ error: "Only the connection owner or a company admin can manage access" }),
    }));
    const result = await adapter.integrations.grantConnectionAccess(GRANT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("http-403");
  });
});

describe("createDesktopAdapter integrations", () => {
  it("sends the list and the grant to the cloud base, not to Tauri", async () => {
    const seen: Array<{ url: string; method: string; body: unknown }> = [];
    const invoked: string[] = [];
    const adapter = createDesktopAdapter({
      invoke: async (cmd) => {
        invoked.push(cmd);
        return null;
      },
      baseUrl: "https://api.test",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as unknown as typeof globalThis.fetch,
    });
    await callBoth(adapter);
    expect(invoked).toEqual([]);
    expect(seen).toEqual([
      { url: "https://api.test/v1/integrations/admin?companyUid=cmp_acme", method: "GET", body: undefined },
      {
        url: "https://api.test/v1/integrations/factory/access/grant",
        method: "POST",
        body: { companyUid: "cmp_acme", connectionId: "acct_linear", granteeType: "person", granteeId: "agt_nova" },
      },
    ]);
  });
});
