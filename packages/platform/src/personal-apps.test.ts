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

describe("sign-in that returns to this computer", () => {
  const LOCAL_URL = "https://vercel.com/oauth/authorize?client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A53689%2Fpersonal-apps%2Fcallback&state=STATE-L";

  function localHost(caught: unknown = { ok: true, value: { state: "STATE-L", code: "CODE-L", iss: "https://vercel.com" } }) {
    return {
      listen: vi.fn(async () => ({ ok: true as const, value: "http://localhost:53689/personal-apps/callback" })),
      wait: vi.fn(async () => caught as never),
      cancel: vi.fn(async () => {}),
    };
  }

  it("tells HQ it can catch a local return, listens before handing out the page, then completes", async () => {
    const replies: Record<string, unknown> = {
      "personalApps.signIn": { flowId: "flow-l", authorizationUrl: LOCAL_URL, returnTo: "local" },
      "personalApps.completeSignIn": { status: "connecting" },
    };
    const post = vi.fn<PersonalAppsPost>(async (_uid, input) => ok(replies[input.actionId] as Json));
    const local = localHost();
    const client = createPersonalAppsApi(post, local);

    const started = await client.startSignIn("agt_1", "vercel");
    expect(started).toEqual({ ok: true, value: { flowId: "flow-l", authorizationUrl: LOCAL_URL } });
    expect(post.mock.calls[0][1].body).toEqual({ name: "vercel", localReturn: true });
    expect(local.listen).toHaveBeenCalledWith("STATE-L");
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1]).toMatchObject({
      actionId: "personalApps.completeSignIn",
      body: { state: "STATE-L", code: "CODE-L", iss: "https://vercel.com" },
    });
  });

  it("cancels the bot's flow and explains when this computer's sign-in port is busy", async () => {
    const post = vi.fn<PersonalAppsPost>(async (_uid, input) =>
      ok((input.actionId === "personalApps.signIn" ? { flowId: "flow-l", authorizationUrl: LOCAL_URL, returnTo: "local" } : {}) as Json),
    );
    const local = localHost();
    local.listen.mockResolvedValueOnce({ ok: false, reason: "error", message: "PERSONAL_APP_SIGNIN_PORT_IN_USE" } as never);
    const client = createPersonalAppsApi(post, local);
    const started = await client.startSignIn("agt_1", "vercel");
    expect(started).toMatchObject({ ok: false, code: "local-port-in-use" });
    expect(post.mock.calls.map(([, input]) => input.actionId)).toEqual(["personalApps.signIn", "personalApps.cancelSignIn"]);
    expect(local.wait).not.toHaveBeenCalled();
  });

  it("does not complete when the listener ends without a redirect", async () => {
    const post = vi.fn<PersonalAppsPost>(async () => ok({ flowId: "flow-l", authorizationUrl: LOCAL_URL, returnTo: "local" } as Json));
    const local = localHost({ ok: false, reason: "error", message: "Sign-in was not finished in time." });
    const client = createPersonalAppsApi(post, local);
    await client.startSignIn("agt_1", "vercel");
    await vi.waitFor(() => expect(local.wait).toHaveBeenCalled());
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("keeps desktop-only catalog apps addable here and not on a host without a listener", async () => {
    const entries = { entries: [{ name: "vercel", url: "https://mcp.vercel.com", auth: "oauth", supported: true, signInReturn: "local" }] };
    const withLocal = createPersonalAppsApi(vi.fn<PersonalAppsPost>(async () => ok(entries as Json)), localHost());
    const without = createPersonalAppsApi(vi.fn<PersonalAppsPost>(async () => ok(entries as Json)));
    expect(await withLocal.catalog("agt_1")).toMatchObject({ value: { entries: [{ supported: true }] } });
    expect(await without.catalog("agt_1")).toMatchObject({ value: { entries: [{ supported: false }] } });
  });

  it("asks HQ for the local return when adding from the desktop", async () => {
    const post = vi.fn<PersonalAppsPost>(async () => ok({} as Json));
    await createPersonalAppsApi(post, localHost()).add("agt_1", { name: "vercel", url: "https://mcp.vercel.com" });
    expect(post.mock.calls[0][1].body).toEqual({ name: "vercel", url: "https://mcp.vercel.com", auth: "oauth", localReturn: true });
  });
});
