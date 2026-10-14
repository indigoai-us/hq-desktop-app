import { describe, expect, it } from "vitest";

import { AGENT_PATHS, SLACK_ATTACH_BODY, type PlatformAdapter } from "../adapter.js";
import { createDesktopAdapter } from "../desktop/index.js";
import { TauriPlatformAdapter } from "./index.js";
import { createSyncPlatformAdapter } from "./sync-adapter.js";

/** An obviously fake app-level token. Never a real one. */
const TOKEN = "xapp-test-0000";

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
    // A refused request is answered once in these tests: no waiting.
    requestPolicy: { maxAttempts: 1 },
  });
  return { adapter, calls };
}

const EXPECTED: Invocation[] = [
  {
    cmd: "hq_pro_fetch",
    args: { url: AGENT_PATHS.slackChannel("agt_nova"), method: "POST", body: JSON.stringify({ returnTo: "desktop" }) },
  },
  {
    cmd: "hq_pro_fetch",
    args: {
      url: AGENT_PATHS.slackAppToken("agt_nova"),
      method: "POST",
      body: JSON.stringify({ appToken: TOKEN }),
    },
  },
];

async function callBoth(adapter: PlatformAdapter): Promise<void> {
  await adapter.agents.attachSlack("agt_nova");
  await adapter.agents.submitSlackAppToken("agt_nova", TOKEN);
}

/** The token is in the request body once, and in nothing else the bridge was handed. */
function expectTokenOnlyInBody(calls: Invocation[]): void {
  const submit = calls[calls.length - 1]!;
  const { body, ...rest } = submit.args ?? {};
  expect(String(body).split(TOKEN)).toHaveLength(2);
  expect(JSON.stringify(rest)).not.toContain(TOKEN);
  expect(submit.cmd).not.toContain(TOKEN);
  for (const other of calls.slice(0, -1)) expect(JSON.stringify(other)).not.toContain(TOKEN);
}

const REJECTED: Respond = () => ({
  status: 400,
  body: JSON.stringify({ error: "Slack rejected the app-level token", code: "SLACK_APP_TOKEN_REJECTED" }),
});
const ALREADY: Respond = () => ({
  status: 409,
  body: JSON.stringify({ error: "Slack is already connected", code: "SLACK_ATTACH_ALREADY_CONNECTED" }),
});
const NOT_FOUND: Respond = () => ({ status: 404, body: JSON.stringify({ error: "Not found" }) });
const UPSTREAM: Respond = () => ({
  status: 502,
  body: JSON.stringify({ error: "Slack attach failed", code: "CHANNEL_ATTACH_FAILED", upstreamCode: "invalid_auth" }),
});
const ECHO: Respond = () => ({
  status: 400,
  body: JSON.stringify({ error: `Token ${TOKEN} is not valid`, code: "SLACK_APP_TOKEN_INVALID" }),
});

for (const [name, make] of [
  ["TauriPlatformAdapter", makeTauri],
  ["createSyncPlatformAdapter", makeSync],
] as const) {
  describe(`${name} Slack channel calls`, () => {
    it("routes the attach and the token through hq_pro_fetch, like agent status", async () => {
      const { adapter, calls } = make();
      await callBoth(adapter);
      expect(calls).toEqual(EXPECTED);
    });

    it("sends the token in the request body and nowhere else", async () => {
      const { adapter, calls } = make();
      await callBoth(adapter);
      expectTokenOnlyInBody(calls);
    });

    it("says in the attach body that the attach comes from the desktop, so the callback can send the person back here", async () => {
      const { adapter, calls } = make();
      await adapter.agents.attachSlack("agt_nova");
      expect(JSON.parse(String(calls[0]!.args?.body))).toEqual({ returnTo: "desktop" });
      expect(SLACK_ATTACH_BODY).toEqual({ returnTo: "desktop" });
    });

    it("returns what the server answered to an attach", async () => {
      const config = { workspace: "pending-install", installUrl: "https://slack.com/oauth/v2/authorize?x=1" };
      const { adapter } = make(() => ({ status: 200, body: JSON.stringify({ config }) }));
      expect(await adapter.agents.attachSlack("agt_nova")).toEqual({ ok: true, value: { config } });
    });

    it("returns a refused attach with the server's code and the HTTP status", async () => {
      const { adapter } = make(ALREADY);
      expect(await adapter.agents.attachSlack("agt_nova")).toEqual({
        ok: false,
        reason: "error",
        code: "SLACK_ATTACH_ALREADY_CONNECTED",
        message: "Slack is already connected",
        status: 409,
      });
    });

    it("keeps the upstream code of a failed attach", async () => {
      const { adapter } = make(UPSTREAM);
      expect(await adapter.agents.attachSlack("agt_nova")).toEqual({
        ok: false,
        reason: "error",
        code: "CHANNEL_ATTACH_FAILED",
        message: "Slack attach failed",
        status: 502,
        upstreamCode: "invalid_auth",
      });
    });

    it("names the 404 a caller who is not an owner or admin gets", async () => {
      const { adapter } = make(NOT_FOUND);
      expect(await adapter.agents.attachSlack("agt_nova")).toEqual({
        ok: false,
        reason: "error",
        code: "http-404",
        message: "Not found",
        status: 404,
      });
    });

    it("returns a rejected token with the server's code and status, and no token in it", async () => {
      const { adapter } = make(REJECTED);
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
      const { adapter } = make(ECHO);
      const result = await adapter.agents.submitSlackAppToken("agt_nova", TOKEN);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });
  });
}

describe("a bridge that fails before the server answers", () => {
  it("TauriPlatformAdapter: a thrown invoke that repeats the request comes back with no token", async () => {
    const adapter = new TauriPlatformAdapter({
      invoke: async (_cmd, args) => {
        throw new Error(`hq_pro_fetch failed for ${JSON.stringify(args)}`);
      },
    });
    const result = await adapter.agents.submitSlackAppToken("agt_nova", TOKEN);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    if (!result.ok) {
      // The rail reports a bridge failure as a plain network failure.
      expect(result.code).toBe("network");
      expect("status" in result).toBe(false);
    }
  });

  it("createSyncPlatformAdapter: a thrown invoke that repeats the request comes back with no token", async () => {
    const adapter = createSyncPlatformAdapter({
      invoke: async (_cmd, args) => {
        throw new Error(`hq_pro_fetch failed for ${JSON.stringify(args)}`);
      },
      requestPolicy: { maxAttempts: 1 },
    });
    const result = await adapter.agents.submitSlackAppToken("agt_nova", TOKEN);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    if (!result.ok) {
      // The rail reports a bridge failure as a plain network failure.
      expect(result.code).toBe("network");
      expect("status" in result).toBe(false);
    }
  });
});

describe("createDesktopAdapter Slack channel calls", () => {
  it("sends the attach and the token to the cloud base, not to Tauri", async () => {
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
      { url: "https://api.test/v1/agents/agt_nova/channels/slack", method: "POST", body: { returnTo: "desktop" } },
      {
        url: "https://api.test/v1/agents/agt_nova/channels/slack/app-token",
        method: "POST",
        body: { appToken: TOKEN },
      },
    ]);
    for (const call of seen) expect(call.url).not.toContain(TOKEN);
  });
});
