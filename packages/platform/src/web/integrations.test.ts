import { describe, expect, it } from "vitest";

import { INTEGRATION_PATHS, connectionGrantBody } from "../adapter.js";
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
  it("names the two routes and encodes the company", () => {
    expect(INTEGRATION_PATHS.connections("cmp_acme")).toBe("/v1/integrations/admin?companyUid=cmp_acme");
    expect(INTEGRATION_PATHS.connections("a b&c")).toBe("/v1/integrations/admin?companyUid=a%20b%26c");
    expect(INTEGRATION_PATHS.grantAccess).toBe("/v1/integrations/factory/access/grant");
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
      { method: "GET", path: "/v1/integrations/admin?companyUid=cmp_acme", body: undefined },
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
