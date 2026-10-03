import { describe, expect, it } from "vitest";

import {
  AGENT_PATHS,
  REDACTED_SECRET,
  SLACK_ATTACH_BODY,
  failure,
  ok,
  withHttpStatus,
  withoutSecret,
} from "../adapter.js";
import { WebPlatformAdapter } from "./index.js";

/** An obviously fake app-level token. Never a real one. */
const TOKEN = "xapp-test-0000";

interface RecordedCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  rawBody: string | null;
  body: unknown;
}

type Respond = (path: string) => { status: number; body?: unknown } | Error;

function makeAdapter(respond: Respond) {
  const calls: RecordedCall[] = [];
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const path = url.replace("https://api.test", "");
    const rawBody = init?.body ? String(init.body) : null;
    calls.push({
      method: init?.method ?? "GET",
      url,
      path,
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      rawBody,
      body: rawBody ? JSON.parse(rawBody) : undefined,
    });
    const answer = respond(path);
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
  };
  return {
    adapter: new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: fetchMock,
      // A refused request is answered once in these tests: no waiting.
      requestPolicy: { maxAttempts: 1 },
    }),
    calls,
  };
}

const ATTACHED = {
  config: {
    workspace: "pending-install",
    installUrl: "https://slack.com/oauth/v2/authorize?client_id=1.2",
    appId: "A0TEST",
    connectionMode: "socket",
    appTokenPendingUrl: "https://api.slack.com/apps/A0TEST",
  },
  followUpUrl: "https://slack.com/oauth/v2/authorize?client_id=1.2",
};

describe("the Slack channel paths", () => {
  it("names the two routes and encodes the bot", () => {
    expect(AGENT_PATHS.slackChannel("agt_nova")).toBe("/v1/agents/agt_nova/channels/slack");
    expect(AGENT_PATHS.slackAppToken("agt_nova")).toBe("/v1/agents/agt_nova/channels/slack/app-token");
    expect(AGENT_PATHS.slackChannel("a b/c")).toBe("/v1/agents/a%20b%2Fc/channels/slack");
    expect(AGENT_PATHS.slackAppToken("a b/c")).toBe("/v1/agents/a%20b%2Fc/channels/slack/app-token");
  });
});

describe("withHttpStatus", () => {
  it("puts the status on a failure and leaves everything else alone", () => {
    expect(withHttpStatus(failure("http-404", "Not found"), 404)).toEqual({
      ok: false,
      reason: "error",
      code: "http-404",
      message: "Not found",
      status: 404,
    });
    const good = ok({ a: 1 });
    expect(withHttpStatus(good, 200)).toBe(good);
    const offline = failure("network", "offline");
    expect(withHttpStatus(offline, null)).toBe(offline);
  });
});

describe("withoutSecret", () => {
  it("takes the secret out of a failure's text", () => {
    const result = withoutSecret(failure("http-400", `bad token ${TOKEN} (${TOKEN})`), TOKEN);
    expect(result).toEqual({
      ok: false,
      reason: "error",
      code: "http-400",
      message: `bad token ${REDACTED_SECRET} (${REDACTED_SECRET})`,
    });
  });

  it("also takes out the secret without the spaces around it", () => {
    const result = withoutSecret(failure("http-400", `bad token ${TOKEN}`), `  ${TOKEN} `);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("takes it out of the codes too", () => {
    const result = withoutSecret({ ...failure(TOKEN, "no"), upstreamCode: TOKEN }, TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("returns the same failure when the secret is not in it, and never touches a success", () => {
    const plain = failure("http-502", "Slack did not answer");
    expect(withoutSecret(plain, TOKEN)).toBe(plain);
    expect(withoutSecret(plain, "")).toBe(plain);
    const good = ok({ echoed: TOKEN });
    expect(withoutSecret(good, TOKEN)).toBe(good);
  });
});

describe("WebPlatformAdapter agents.attachSlack", () => {
  it("POSTs to the bot's Slack channel route, saying the attach comes from the desktop", async () => {
    const { adapter, calls } = makeAdapter(() => ({ status: 200, body: ATTACHED }));
    const result = await adapter.agents.attachSlack("agt_nova");
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/v1/agents/agt_nova/channels/slack", { returnTo: "desktop" }],
    ]);
    expect(result).toEqual({ ok: true, value: ATTACHED });
  });

  it("carries returnTo desktop in the body and nothing else, so the callback can send the person back here", async () => {
    const { adapter, calls } = makeAdapter(() => ({ status: 200, body: ATTACHED }));
    await adapter.agents.attachSlack("agt_nova");
    expect(calls[0]!.body).toEqual(SLACK_ATTACH_BODY);
    expect(SLACK_ATTACH_BODY).toEqual({ returnTo: "desktop" });
    // The bot is named in the path only.
    expect(JSON.stringify(calls[0]!.body)).not.toContain("agt_nova");
  });

  it("returns a refusal with the server's code and the HTTP status", async () => {
    const { adapter } = makeAdapter(() => ({
      status: 409,
      body: { error: "Slack is already connected", code: "SLACK_ATTACH_ALREADY_CONNECTED" },
    }));
    expect(await adapter.agents.attachSlack("agt_nova")).toEqual({
      ok: false,
      reason: "error",
      code: "SLACK_ATTACH_ALREADY_CONNECTED",
      message: "Slack is already connected",
      status: 409,
    });
  });

  it("keeps the upstream code of a failed attach", async () => {
    const { adapter } = makeAdapter(() => ({
      status: 502,
      body: { error: "Slack attach failed", code: "CHANNEL_ATTACH_FAILED", upstreamCode: "invalid_auth" },
    }));
    expect(await adapter.agents.attachSlack("agt_nova")).toEqual({
      ok: false,
      reason: "error",
      code: "CHANNEL_ATTACH_FAILED",
      message: "Slack attach failed",
      status: 502,
      upstreamCode: "invalid_auth",
    });
  });

  it("drops an upstream code that is a sentence", async () => {
    const { adapter } = makeAdapter(() => ({
      status: 502,
      body: { error: "Slack attach failed", code: "CHANNEL_ATTACH_FAILED", upstreamCode: "Slack said no, sorry" },
    }));
    const result = await adapter.agents.attachSlack("agt_nova");
    expect(result.ok).toBe(false);
    if (!result.ok) expect("upstreamCode" in result).toBe(false);
  });

  it("names the 404 a caller who is not an owner or admin gets", async () => {
    const { adapter } = makeAdapter(() => ({ status: 404, body: { error: "Not found" } }));
    expect(await adapter.agents.attachSlack("agt_nova")).toEqual({
      ok: false,
      reason: "error",
      code: "http-404",
      message: "Not found",
      status: 404,
    });
  });

  it("returns a request that never got an answer as a failure with no status, never a throw", async () => {
    const { adapter } = makeAdapter(() => new Error("offline"));
    expect(await adapter.agents.attachSlack("agt_nova")).toEqual({
      ok: false,
      reason: "error",
      code: "network",
      message: "offline",
    });
  });
});

describe("WebPlatformAdapter agents.submitSlackAppToken", () => {
  it("sends the token in the request body and nowhere else", async () => {
    const { adapter, calls } = makeAdapter(() => ({ status: 200, body: { ok: true } }));
    const result = await adapter.agents.submitSlackAppToken("agt_nova", TOKEN);
    expect(result).toEqual({ ok: true, value: { ok: true } });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/v1/agents/agt_nova/channels/slack/app-token");
    expect(call.body).toEqual({ appToken: TOKEN });
    // Not in the address, not in a header.
    expect(call.url).not.toContain(TOKEN);
    expect(JSON.stringify(call.headers)).not.toContain(TOKEN);
    // In the body exactly once.
    expect(call.rawBody!.split(TOKEN)).toHaveLength(2);
  });

  it("returns a rejected token with the server's code and status, and no token in it", async () => {
    const { adapter } = makeAdapter(() => ({
      status: 400,
      body: { error: "Slack rejected the app-level token", code: "SLACK_APP_TOKEN_REJECTED" },
    }));
    const result = await adapter.agents.submitSlackAppToken("agt_nova", TOKEN);
    expect(result).toEqual({
      ok: false,
      reason: "error",
      code: "SLACK_APP_TOKEN_REJECTED",
      message: "Slack rejected the app-level token",
      status: 400,
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("takes the token out of a failure when the server repeats it", async () => {
    const { adapter } = makeAdapter(() => ({
      status: 400,
      body: { error: `Token ${TOKEN} is not valid`, code: "SLACK_APP_TOKEN_INVALID", upstreamCode: TOKEN },
    }));
    const result = await adapter.agents.submitSlackAppToken("agt_nova", TOKEN);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    if (!result.ok) {
      expect(result.code).toBe("SLACK_APP_TOKEN_INVALID");
      expect(result.message).toBe(`Token ${REDACTED_SECRET} is not valid`);
    }
  });

  it("takes the token out of a transport error that repeats the request", async () => {
    const { adapter } = makeAdapter(() => new Error(`could not send {"appToken":"${TOKEN}"}`));
    const result = await adapter.agents.submitSlackAppToken("agt_nova", TOKEN);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    if (!result.ok) expect(result.code).toBe("network");
  });

  it("names the route in a failure with no body, and the route has no token in it", async () => {
    const { adapter } = makeAdapter(() => ({ status: 502 }));
    const result = await adapter.agents.submitSlackAppToken("agt_nova", TOKEN);
    expect(result).toEqual({
      ok: false,
      reason: "error",
      code: "http-502",
      message: "POST /v1/agents/agt_nova/channels/slack/app-token failed",
      status: 502,
    });
  });
});
