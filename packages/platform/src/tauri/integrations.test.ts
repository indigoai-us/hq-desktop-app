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

async function callAccessPair(adapter: PlatformAdapter): Promise<void> {
  await adapter.integrations.getConnectionAccess({
    companyUid: "cmp_acme",
    connectionId: "acct_linear",
  });
  await adapter.integrations.revokeConnectionAccess(GRANT);
}

const EXPECTED_ACCESS_PAIR: Invocation[] = [
  {
    cmd: "hq_pro_fetch",
    args: {
      url: INTEGRATION_PATHS.readAccess("cmp_acme", "acct_linear"),
      method: "GET",
      body: null,
    },
  },
  {
    cmd: "hq_pro_fetch",
    args: {
      url: INTEGRATION_PATHS.revokeAccess,
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

/** The four calls a card makes to connect an app, in order. */
async function callConnectFlow(adapter: PlatformAdapter): Promise<void> {
  await adapter.integrations.catalogSearch("cmp_acme", "linear.app", 20);
  await adapter.integrations.startOAuth({ companyUid: "cmp_acme", domain: "linear.app" });
  await adapter.integrations.blueprint({ companyUid: "cmp_acme", catalogEntryId: "cat_1" });
  await adapter.integrations.install({
    companyUid: "cmp_acme",
    mcpUrl: "https://mcp.example.com/mcp",
    authMode: "bearer",
    bearerToken: "fake-key-3",
  });
}

const EXPECTED_CONNECT_FLOW: Invocation[] = [
  {
    cmd: "hq_pro_fetch",
    args: { url: INTEGRATION_PATHS.catalog("cmp_acme", "linear.app", 20), method: "GET", body: null },
  },
  {
    cmd: "hq_pro_fetch",
    args: { url: INTEGRATION_PATHS.oauthStart, method: "POST", body: JSON.stringify({ companyUid: "cmp_acme", domain: "linear.app" }) },
  },
  {
    cmd: "hq_pro_fetch",
    args: { url: INTEGRATION_PATHS.blueprint, method: "POST", body: JSON.stringify({ companyUid: "cmp_acme", catalogEntryId: "cat_1" }) },
  },
  {
    cmd: "hq_pro_fetch",
    args: {
      url: INTEGRATION_PATHS.install,
      method: "POST",
      body: JSON.stringify({ companyUid: "cmp_acme", mcpUrl: "https://mcp.example.com/mcp", authMode: "bearer", bearerToken: "fake-key-3" }),
    },
  },
];

const KEY_REFUSED: Respond = () => ({
  status: 409,
  body: JSON.stringify({ error: "Install already running for fake-key-3", code: "INTEGRATION_FACTORY_INSTALL_IN_PROGRESS" }),
});

async function expectKeyStripped(adapter: PlatformAdapter): Promise<void> {
  const result = await adapter.integrations.install({
    companyUid: "cmp_acme",
    mcpUrl: "https://mcp.example.com/mcp",
    authMode: "bearer",
    bearerToken: "fake-key-3",
  });
  expect(result).toMatchObject({ ok: false, status: 409, code: "INTEGRATION_FACTORY_INSTALL_IN_PROGRESS" });
  expect(JSON.stringify(result)).not.toContain("fake-key-3");
}

describe("TauriPlatformAdapter integrations", () => {
  it("routes the list and the grant through hq_pro_fetch, like agent status", async () => {
    const { adapter, calls } = makeTauri();
    await callBoth(adapter);
    expect(calls).toEqual(EXPECTED);
  });

  it("routes the catalog, OAuth start, blueprint and install through hq_pro_fetch, the key in the body only", async () => {
    const { adapter, calls } = makeTauri();
    await callConnectFlow(adapter);
    expect(calls).toEqual(EXPECTED_CONNECT_FLOW);
  });

  it("carries the status and code of a refused install, with the key taken out of the text", async () => {
    const { adapter } = makeTauri(KEY_REFUSED);
    await expectKeyStripped(adapter);
  });

  it("carries the 403 of a catalog search a member may not make", async () => {
    const { adapter } = makeTauri(() => ({
      status: 403,
      body: JSON.stringify({ error: "Only a company owner or admin can browse the integration catalog", code: "INTEGRATION_FACTORY_FORBIDDEN" }),
    }));
    expect(await adapter.integrations.catalogSearch("cmp_acme", "linear.app")).toMatchObject({
      ok: false,
      status: 403,
      code: "INTEGRATION_FACTORY_FORBIDDEN",
    });
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

  it("routes the per-connection access read and the revoke through hq_pro_fetch, with the same body shape as grant", async () => {
    const { adapter, calls } = makeTauri();
    await callAccessPair(adapter);
    expect(calls).toEqual(EXPECTED_ACCESS_PAIR);
  });

  it("returns a refused revoke as a failure that names the 403", async () => {
    const { adapter } = makeTauri(() => ({
      status: 403,
      body: JSON.stringify({ error: "Only the connection owner or a company admin can manage access" }),
    }));
    const result = await adapter.integrations.revokeConnectionAccess(GRANT);
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

  it("routes the connect flow the same way, the key in the body only", async () => {
    const { adapter, calls } = makeSync();
    await callConnectFlow(adapter);
    expect(calls).toEqual(EXPECTED_CONNECT_FLOW);
  });

  it("carries the status and code of a refused install, with the key taken out of the text", async () => {
    const { adapter } = makeSync(KEY_REFUSED);
    await expectKeyStripped(adapter);
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

  it("routes the per-connection access read and the revoke through hq_pro_fetch, with the same body shape as grant", async () => {
    const { adapter, calls } = makeSync();
    await callAccessPair(adapter);
    expect(calls).toEqual(EXPECTED_ACCESS_PAIR);
  });

  it("returns a refused revoke as a failure that names the 403", async () => {
    const { adapter } = makeSync(() => ({
      status: 403,
      body: JSON.stringify({ error: "Only the connection owner or a company admin can manage access" }),
    }));
    const result = await adapter.integrations.revokeConnectionAccess(GRANT);
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
    await callConnectFlow(adapter);
    expect(invoked).toEqual([]);
    expect(seen).toEqual([
      { url: "https://api.test/v1/integrations/admin?companyUid=cmp_acme&view=summary", method: "GET", body: undefined },
      {
        url: "https://api.test/v1/integrations/factory/access/grant",
        method: "POST",
        body: { companyUid: "cmp_acme", connectionId: "acct_linear", granteeType: "person", granteeId: "agt_nova" },
      },
      { url: "https://api.test/v1/integrations/factory/catalog?companyUid=cmp_acme&query=linear.app&limit=20", method: "GET", body: undefined },
      { url: "https://api.test/v1/integrations/factory/oauth/start", method: "POST", body: { companyUid: "cmp_acme", domain: "linear.app" } },
      { url: "https://api.test/v1/integrations/factory/blueprint", method: "POST", body: { companyUid: "cmp_acme", catalogEntryId: "cat_1" } },
      {
        url: "https://api.test/v1/integrations/factory/install",
        method: "POST",
        body: { companyUid: "cmp_acme", mcpUrl: "https://mcp.example.com/mcp", authMode: "bearer", bearerToken: "fake-key-3" },
      },
    ]);
  });
});

describe("catalog lookup (first-run Your apps)", () => {
  const DOMAINS = ["linear.app", "zoom.us"] as const;
  const EXPECTED_LOOKUP: Invocation[] = [
    {
      cmd: "hq_pro_fetch",
      args: {
        url: INTEGRATION_PATHS.catalogLookup,
        method: "POST",
        body: JSON.stringify({ companyUid: "cmp_acme", domains: ["linear.app", "zoom.us"] }),
      },
    },
  ];

  it("posts the whole fixed list through hq_pro_fetch on both Tauri adapters", async () => {
    for (const make of [makeTauri, makeSync]) {
      const { adapter, calls } = make();
      const result = await adapter.integrations.catalogLookup!("cmp_acme", DOMAINS);
      expect(calls).toEqual(EXPECTED_LOOKUP);
      expect(result.ok).toBe(true);
    }
  });

  it("names the hq-pro route", () => {
    expect(INTEGRATION_PATHS.catalogLookup).toBe("/v1/integrations/factory/catalog/lookup");
  });
});

describe("docs discovery and uninstall (first-run Your apps)", () => {
  it("posts only the company and the docs URL, and only the installation id, on both Tauri adapters", async () => {
    for (const make of [makeTauri, makeSync]) {
      const { adapter, calls } = make();
      await adapter.integrations.discoverDocs!({ companyUid: "cmp_acme", docsUrl: "https://docs.example.com/mcp" });
      await adapter.integrations.uninstall!({ companyUid: "cmp_acme", installationId: "inst_1" });
      expect(calls).toEqual([
        { cmd: "hq_pro_fetch", args: { url: INTEGRATION_PATHS.discoverDocs, method: "POST", body: JSON.stringify({ companyUid: "cmp_acme", docsUrl: "https://docs.example.com/mcp" }) } },
        { cmd: "hq_pro_fetch", args: { url: INTEGRATION_PATHS.uninstall, method: "POST", body: JSON.stringify({ companyUid: "cmp_acme", installationId: "inst_1" }) } },
      ]);
    }
  });

  it("passes the install origin and a discovery receipt through in the body", async () => {
    const { adapter, calls } = makeSync();
    await adapter.integrations.install({ companyUid: "cmp_acme", catalogEntryId: "cat_aws", origin: "first-run-auto" });
    await adapter.integrations.install({ companyUid: "cmp_acme", discoveryReceiptId: "rcpt_1" });
    expect(calls.map((c) => c.args?.body)).toEqual([
      JSON.stringify({ companyUid: "cmp_acme", catalogEntryId: "cat_aws", origin: "first-run-auto" }),
      JSON.stringify({ companyUid: "cmp_acme", discoveryReceiptId: "rcpt_1" }),
    ]);
  });

  it("names the hq-pro routes", () => {
    expect(INTEGRATION_PATHS.discoverDocs).toBe("/v1/integrations/factory/discover-docs");
    expect(INTEGRATION_PATHS.uninstall).toBe("/v1/integrations/factory/uninstall");
  });
});
