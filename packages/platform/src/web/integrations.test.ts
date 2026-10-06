import { describe, expect, it } from "vitest";

import { INTEGRATION_PATHS, REDACTED_SECRET, connectionGrantBody, integrationAppRefBody } from "../adapter.js";
import { WebPlatformAdapter } from "./index.js";

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function makeAdapter(
  respond: (path: string) => { status: number; body?: unknown },
) {
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
    const { status, body: resBody } = respond(path);
    return new Response(
      resBody === undefined ? null : JSON.stringify(resBody),
      { status },
    );
  };
  return {
    adapter: new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: fetchMock,
    }),
    calls,
  };
}

const LIST = {
  companyUid: "cmp_acme",
  viewer: { personUid: "prs_me", role: "owner", canManageGovernance: true, canManageIntegrations: true },
  factoryEnabled: true,
  connections: [
    {
      id: "acct_linear",
      provider: "factory:linear",
      status: "connected",
      access: { mode: "private", grantCount: 0 },
      installation: { displayName: "Linear" },
    },
  ],
  audit: [],
};

describe("integration paths", () => {
  it("names the routes and encodes the company", () => {
    expect(INTEGRATION_PATHS.connections("cmp_acme")).toBe("/v1/integrations/admin?companyUid=cmp_acme&view=summary");
    expect(INTEGRATION_PATHS.connections("a b&c")).toBe("/v1/integrations/admin?companyUid=a%20b%26c&view=summary");
    expect(INTEGRATION_PATHS.grantAccess).toBe("/v1/integrations/factory/access/grant");
    expect(INTEGRATION_PATHS.oauthStart).toBe("/v1/integrations/factory/oauth/start");
    expect(INTEGRATION_PATHS.install).toBe("/v1/integrations/factory/install");
    expect(INTEGRATION_PATHS.blueprint).toBe("/v1/integrations/factory/blueprint");
  });

  it("names the catalog with the query encoded and the limit only when given", () => {
    expect(INTEGRATION_PATHS.catalog("cmp_acme", "linear.app", 20)).toBe(
      "/v1/integrations/factory/catalog?companyUid=cmp_acme&query=linear.app&limit=20",
    );
    expect(INTEGRATION_PATHS.catalog("cmp_acme", "a b&c")).toBe(
      "/v1/integrations/factory/catalog?companyUid=cmp_acme&query=a%20b%26c",
    );
    expect(INTEGRATION_PATHS.catalog("cmp_acme", "x", 7.9)).toContain("&limit=7");
    expect(INTEGRATION_PATHS.catalog("cmp_acme", "x", Number.NaN)).not.toContain("limit");
  });

  it("names an app for OAuth and a blueprint by entry when there is one, else by domain, never with a redirect", () => {
    expect(integrationAppRefBody({ companyUid: "cmp_acme", domain: "linear.app" })).toEqual({
      companyUid: "cmp_acme",
      domain: "linear.app",
    });
    expect(integrationAppRefBody({ companyUid: "cmp_acme", domain: "linear.app", catalogEntryId: "cat_1" })).toEqual({
      companyUid: "cmp_acme",
      catalogEntryId: "cat_1",
    });
    expect("redirectUri" in integrationAppRefBody({ companyUid: "cmp_acme", domain: "linear.app" })).toBe(false);
  });

  it("grants a bot as a person and leaves the permission to the server", () => {
    const body = connectionGrantBody({ companyUid: "cmp_acme", connectionId: "acct_linear", granteeUid: "agt_nova" });
    expect(body).toEqual({
      companyUid: "cmp_acme",
      connectionId: "acct_linear",
      granteeType: "person",
      granteeId: "agt_nova",
    });
    expect("permission" in body).toBe(false);
  });
});

describe("WebPlatformAdapter integrations", () => {
  it("GETs the company's connections on the same base as every other route", async () => {
    const { adapter, calls } = makeAdapter(() => ({ status: 200, body: LIST }));
    const result = await adapter.integrations.listConnections("cmp_acme");
    expect(calls).toEqual([
      { method: "GET", path: "/v1/integrations/admin?companyUid=cmp_acme&view=summary", body: undefined },
    ]);
    expect(result).toEqual({ ok: true, value: LIST });
  });

  it("POSTs a grant for the bot as a person grant, with no permission", async () => {
    const { adapter, calls } = makeAdapter(() => ({ status: 200, body: { connectionId: "acct_linear" } }));
    const result = await adapter.integrations.grantConnectionAccess({
      companyUid: "cmp_acme",
      connectionId: "acct_linear",
      granteeUid: "agt_nova",
    });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/integrations/factory/access/grant",
        body: { companyUid: "cmp_acme", connectionId: "acct_linear", granteeType: "person", granteeId: "agt_nova" },
      },
    ]);
    expect(result).toEqual({ ok: true, value: { connectionId: "acct_linear" } });
  });

  it("returns a refused grant as a failure that names the 403", async () => {
    const { adapter } = makeAdapter(() => ({
      status: 403,
      body: { error: "Only the connection owner or a company admin can manage access" },
    }));
    const result = await adapter.integrations.grantConnectionAccess({
      companyUid: "cmp_acme",
      connectionId: "acct_linear",
      granteeUid: "agt_nova",
    });
    expect(result).toEqual({
      ok: false,
      reason: "error",
      code: "http-403",
      message: "Only the connection owner or a company admin can manage access",
    });
  });

  it("returns a failed list as a failure, never a throw", async () => {
    const { adapter } = makeAdapter(() => ({ status: 500, body: { error: "boom" } }));
    const result = await adapter.integrations.listConnections("cmp_acme");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("http-500");
  });
});

describe("WebPlatformAdapter integrations: connecting an app from a card", () => {
  const CATALOG = {
    ok: true,
    companyUid: "cmp_acme",
    entries: [{ name: "Linear", domain: "linear.app", mcpReady: true, authClass: "oauth", source: "integrations.sh" }],
  };
  const STARTED = {
    ok: true,
    companyUid: "cmp_acme",
    provider: "linear",
    displayName: "Linear",
    authorizationUrl: "https://linear.app/oauth/authorize?state=st_1",
    state: "st_1",
    expiresAt: "2026-10-02T15:10:00.000Z",
  };

  it("GETs the catalog with the query and the limit, and carries the status on a refusal", async () => {
    const { adapter, calls } = makeAdapter(() => ({ status: 200, body: CATALOG }));
    expect(await adapter.integrations.catalogSearch("cmp_acme", "linear.app", 20)).toEqual({ ok: true, value: CATALOG });
    expect(calls).toEqual([
      { method: "GET", path: "/v1/integrations/factory/catalog?companyUid=cmp_acme&query=linear.app&limit=20", body: undefined },
    ]);
    const refused = makeAdapter(() => ({
      status: 403,
      body: { error: "Only a company owner or admin can browse the integration catalog", code: "INTEGRATION_FACTORY_FORBIDDEN" },
    }));
    const result = await refused.adapter.integrations.catalogSearch("cmp_acme", "linear.app");
    expect(result).toMatchObject({ ok: false, status: 403, code: "INTEGRATION_FACTORY_FORBIDDEN" });
    expect(refused.calls[0]!.path).toBe("/v1/integrations/factory/catalog?companyUid=cmp_acme&query=linear.app");
  });

  it("POSTs an OAuth start by domain with no redirect, and hands back the provider's page", async () => {
    const { adapter, calls } = makeAdapter(() => ({ status: 200, body: STARTED }));
    const result = await adapter.integrations.startOAuth({ companyUid: "cmp_acme", domain: "linear.app" });
    expect(calls).toEqual([
      { method: "POST", path: "/v1/integrations/factory/oauth/start", body: { companyUid: "cmp_acme", domain: "linear.app" } },
    ]);
    expect(result).toEqual({ ok: true, value: STARTED });
    expect(JSON.stringify(calls[0]!.body)).not.toContain("redirectUri");
  });

  it("POSTs an OAuth start by catalog entry when the lookup carried one", async () => {
    const { adapter, calls } = makeAdapter(() => ({ status: 200, body: STARTED }));
    await adapter.integrations.startOAuth({ companyUid: "cmp_acme", domain: "linear.app", catalogEntryId: "cat_linear" });
    expect(calls[0]!.body).toEqual({ companyUid: "cmp_acme", catalogEntryId: "cat_linear" });
  });

  it("returns a refused OAuth start with its status, code and upstream code", async () => {
    const { adapter } = makeAdapter(() => ({
      status: 502,
      body: { error: "Dynamic client registration was refused", code: "CLIENT_REGISTRATION_REFUSED", upstreamCode: "invalid_client_metadata" },
    }));
    const result = await adapter.integrations.startOAuth({ companyUid: "cmp_acme", domain: "linear.app" });
    expect(result).toMatchObject({ ok: false, status: 502, code: "CLIENT_REGISTRATION_REFUSED", upstreamCode: "invalid_client_metadata" });
  });

  it("POSTs an install with the body as given: by domain, by entry with a key, by MCP URL with a key", async () => {
    const { adapter, calls } = makeAdapter(() => ({ status: 200, body: { connection: { id: "acct_1" } } }));
    await adapter.integrations.install({ companyUid: "cmp_acme", domain: "deepwiki.com" });
    await adapter.integrations.install({ companyUid: "cmp_acme", catalogEntryId: "cat_1", bearerToken: "fake-key-1" });
    await adapter.integrations.install({
      companyUid: "cmp_acme",
      mcpUrl: "https://mcp.example.com/mcp",
      authMode: "bearer",
      bearerToken: "fake-key-2",
      provider: "example",
      displayName: "Example",
      domain: "example.com",
    });
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["POST", "/v1/integrations/factory/install"],
      ["POST", "/v1/integrations/factory/install"],
      ["POST", "/v1/integrations/factory/install"],
    ]);
    expect(calls[0]!.body).toEqual({ companyUid: "cmp_acme", domain: "deepwiki.com" });
    expect(calls[1]!.body).toEqual({ companyUid: "cmp_acme", catalogEntryId: "cat_1", bearerToken: "fake-key-1" });
    expect(calls[2]!.body).toEqual({
      companyUid: "cmp_acme",
      mcpUrl: "https://mcp.example.com/mcp",
      authMode: "bearer",
      bearerToken: "fake-key-2",
      provider: "example",
      displayName: "Example",
      domain: "example.com",
    });
  });

  it("takes the key out of a failed install's text, and keeps the status and code", async () => {
    const { adapter, calls } = makeAdapter(() => ({
      status: 409,
      body: { error: "Install already running for fake-key-9", code: "INTEGRATION_FACTORY_INSTALL_IN_PROGRESS" },
    }));
    const result = await adapter.integrations.install({
      companyUid: "cmp_acme",
      mcpUrl: "https://mcp.example.com/mcp",
      authMode: "bearer",
      bearerToken: "fake-key-9",
    });
    expect(result).toEqual({
      ok: false,
      reason: "error",
      status: 409,
      code: "INTEGRATION_FACTORY_INSTALL_IN_PROGRESS",
      message: `Install already running for ${REDACTED_SECRET}`,
    });
    expect(JSON.stringify(result)).not.toContain("fake-key-9");
    // The key went in the body, never in the path.
    expect(calls[0]!.path).toBe("/v1/integrations/factory/install");
  });

  it("returns a plan-limit refusal of an install with its 402", async () => {
    const { adapter } = makeAdapter(() => ({
      status: 402,
      body: { error: "Integration limit reached", code: "PLAN_LIMIT_REACHED", upgradeUrl: "https://hq.computer/billing" },
    }));
    const result = await adapter.integrations.install({ companyUid: "cmp_acme", domain: "deepwiki.com" });
    expect(result).toMatchObject({ ok: false, status: 402 });
  });

  it("POSTs a blueprint request by domain or by entry", async () => {
    const answer = { ok: true, companyUid: "cmp_acme", blueprint: { provider: "example", displayName: "Example", domain: "example.com", credentials: [], surfaces: [] } };
    const { adapter, calls } = makeAdapter(() => ({ status: 200, body: answer }));
    expect(await adapter.integrations.blueprint({ companyUid: "cmp_acme", domain: "example.com" })).toEqual({ ok: true, value: answer });
    await adapter.integrations.blueprint({ companyUid: "cmp_acme", catalogEntryId: "cat_1" });
    expect(calls).toEqual([
      { method: "POST", path: "/v1/integrations/factory/blueprint", body: { companyUid: "cmp_acme", domain: "example.com" } },
      { method: "POST", path: "/v1/integrations/factory/blueprint", body: { companyUid: "cmp_acme", catalogEntryId: "cat_1" } },
    ]);
  });
});
