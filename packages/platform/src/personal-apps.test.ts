import { describe, expect, it, vi } from "vitest";
import { failure, ok, type AdapterFailure, type AdapterResult, type Json } from "./adapter.js";
import { createPersonalAppsApi, type PersonalAppsPost } from "./personal-apps.js";

function isFailure(reply: unknown): reply is AdapterFailure {
  return typeof reply === "object" && reply !== null && (reply as { ok?: unknown }).ok === false;
}

function api(reply: unknown) {
  const result: AdapterResult<Json> = isFailure(reply) ? reply : ok(reply as Json);
  const post = vi.fn<PersonalAppsPost>(async () => result);
  return { post, client: createPersonalAppsApi(post) };
}

describe("personal apps over HQ runtime actions", () => {
  it("sends each operation as personalApps.<op> with its input in body", async () => {
    const { post, client } = api({ removed: "notion" });
    await client.remove("agt_1", "notion");
    expect(post).toHaveBeenCalledWith("agt_1", {
      actionId: "personalApps.remove",
      idempotencyKey: expect.stringMatching(/^personal-apps-/),
      body: { name: "notion" },
    });
  });

  it("defaults a new app to browser sign-in", async () => {
    const { post, client } = api({ app: {} });
    await client.add("agt_1", { name: "notion", url: "https://mcp.notion.com/mcp" });
    expect(post.mock.calls[0][1].body).toEqual({ name: "notion", url: "https://mcp.notion.com/mcp", auth: "oauth" });
  });

  it("maps the server's app list onto the section's shape", async () => {
    const { client } = api({
      gatewayStatus: "ok",
      apps: [
        { name: "notion", host: "mcp.notion.com", auth: "oauth", enabled: true, signedIn: true, connected: true, toolCount: 12 },
        { name: "figma", host: "mcp.figma.com", auth: "oauth", enabled: true, signedIn: false, connected: null, toolCount: null },
        { name: "docs", host: "docs.example", auth: "none", enabled: false, signedIn: null, connected: null, toolCount: null },
      ],
    });
    expect(await client.list("agt_1")).toEqual({
      ok: true,
      value: {
        apps: [
          { name: "notion", url: "https://mcp.notion.com", auth: "oauth", enabled: true, connected: true, tools: 12 },
          { name: "figma", url: "https://mcp.figma.com", auth: "oauth", enabled: true, connected: false, tools: null },
          { name: "docs", url: "https://docs.example", auth: "none", enabled: false, connected: true, tools: null },
        ],
      },
    });
  });

  it("keeps the HTTP status of a refusal so the section can hide on 404", async () => {
    const { client } = api({ ...failure("http-404", "Not found"), status: 404 });
    expect(await client.list("agt_1")).toMatchObject({ ok: false, status: 404 });
  });

  it("maps catalog entries", async () => {
    const { client } = api({
      entries: [{ name: "linear", description: "Issues", url: "https://mcp.linear.app/sse", auth: "oauth", supported: true }],
    });
    expect(await client.catalog("agt_1")).toEqual({
      ok: true,
      value: {
        entries: [
          { name: "linear", description: "Issues", url: "https://mcp.linear.app/sse", transport: "http", auth: "oauth", installed: false, supported: true },
        ],
      },
    });
  });

  it("returns the provider page from a started sign-in", async () => {
    const { client } = api({ flowId: "flow-1", authorizationUrl: "https://idp.example/authorize?state=s" });
    expect(await client.startSignIn("agt_1", "notion")).toEqual({
      ok: true,
      value: { flowId: "flow-1", authorizationUrl: "https://idp.example/authorize?state=s" },
    });
  });

  it("refuses a sign-in reply without a provider page", async () => {
    const { client } = api({ flowId: "flow-1" });
    expect(await client.startSignIn("agt_1", "notion")).toMatchObject({ ok: false, code: "invalid-response" });
  });

  it.each([
    [{ status: "waiting" }, { status: "authorization_required", error: null, tools: 0 }],
    [{ status: "connecting" }, { status: "authorization_required", error: null, tools: 0 }],
    [{ status: "connected", toolCount: 61 }, { status: "approved", error: null, tools: 61 }],
    [{ status: "failed", message: "Sign-in didn't finish." }, { status: "error", error: "Sign-in didn't finish.", tools: 0 }],
  ])("maps sign-in status %j", async (server, expected) => {
    const { client } = api(server);
    expect(await client.signInStatus("agt_1", "flow-1")).toEqual({ ok: true, value: expected });
  });
});
