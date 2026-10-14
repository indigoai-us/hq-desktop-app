import { describe, expect, it, vi } from "vitest";
import {
  classifyAgentsError,
  createAgentBody,
  createAgentsClient,
  type AgentsFetch,
  type CreateAgentInput,
} from "./client.js";
import { cloudUnavailableCopy, createErrorCopy, formatPlanPrice } from "./messages.js";

const INPUT: CreateAgentInput = {
  companyUid: "cmp_1",
  name: "Ada",
  slug: "ada",
  brain: "codex",
  idempotencyKey: "wiz-1",
  quote: { instanceType: "t3.medium", netMonthlyCents: 10000, catalogVersion: "v7" },
  surface: "desktop_new_bot",
};

const CREATED = {
  agent: { uid: "agt_1", name: "Ada", slug: "ada", companyUid: "cmp_1" },
  setupState: { version: 1, phase: "provisioning", idempotencyKey: "wiz-1", steps: [], updatedAt: "t" },
};

function fakeFetch(status: number, body: unknown): AgentsFetch & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  })) as unknown as AgentsFetch & ReturnType<typeof vi.fn>;
}

describe("createAgentBody", () => {
  it("sends subscription auth, deferChannels, surface, the key and the quote, and no API key", () => {
    const body = createAgentBody(INPUT);
    expect(body).toEqual({
      companyUid: "cmp_1",
      name: "Ada",
      slug: "ada",
      provider: "agents-v2",
      codexAuthMode: "subscription",
      deferChannels: true,
      idempotencyKey: "wiz-1",
      surface: "desktop_new_bot",
      desiredInstanceType: "t3.medium",
      quotedNetMonthlyCents: 10000,
      quoteCatalogVersion: "v7",
    });
    expect(Object.keys(body)).not.toContain("codexApiKey");
  });

  it("picks the brain through the model fields the create_agent card used", () => {
    expect(createAgentBody({ ...INPUT, brain: "grok" })).toMatchObject({ codexModel: "grok-4.7" });
    expect(createAgentBody({ ...INPUT, brain: "claude" })).toMatchObject({
      codexModel: "claude-opus-5-5",
      codexReasoningEffort: "low",
    });
    expect(createAgentBody(INPUT)).not.toHaveProperty("codexModel");
  });
});

describe("createAgentsClient", () => {
  it("POSTs /v1/agents with a JSON body and returns the created bot", async () => {
    const fetch = fakeFetch(201, CREATED);
    const result = await createAgentsClient(fetch).createAgent(INPUT);
    expect(result).toEqual({ ok: true, status: 201, value: CREATED });
    const [path, init] = fetch.mock.calls[0]!;
    expect(path).toBe("/v1/agents");
    expect(init).toMatchObject({ method: "POST", headers: { "content-type": "application/json" } });
    expect(JSON.parse(init.body)).toEqual(createAgentBody(INPUT));
  });

  it("treats an idempotent replay (200) as success", async () => {
    const result = await createAgentsClient(fakeFetch(200, CREATED)).createAgent(INPUT);
    expect(result.ok && result.status).toBe(200);
  });

  it("refuses a success that names no bot", async () => {
    const result = await createAgentsClient(fakeFetch(201, { setupState: CREATED.setupState })).createAgent(INPUT);
    expect(result).toMatchObject({ ok: false, error: { kind: "server" } });
  });

  it("reports a transport failure as network", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await createAgentsClient(fetch).createAgent(INPUT);
    expect(result).toEqual({ ok: false, error: { kind: "network", status: 0, serverMessage: "offline" } });
  });

  it("reads status, scoped to a brain when asked", async () => {
    const fetch = fakeFetch(200, { ...CREATED, pairing: null });
    await createAgentsClient(fetch).getStatus("agt_1", { brain: "grok" });
    expect(fetch.mock.calls[0]![0]).toBe("/v1/agents/agt_1/status?brain=grok");
    expect(fetch.mock.calls[0]![1]).toEqual({ method: "GET" });
  });

  it("runs login-code, retry and brain authorize against their routes", async () => {
    const fetch = fakeFetch(200, { ok: true });
    const client = createAgentsClient(fetch);
    await client.runAction("agt_1", { kind: "login-code", code: "  abc#def  " });
    await client.runAction("agt_1", { kind: "retry" });
    await client.runAction("agt_1", { kind: "authorize-brain", brain: "claude" });
    expect(fetch.mock.calls.map((c) => [c[0], c[1].method, c[1].body])).toEqual([
      ["/v1/agents/agt_1/login-code", "POST", JSON.stringify({ code: "abc#def" })],
      ["/v1/agents/agt_1/retry", "POST", "{}"],
      ["/v1/agents/agt_1/brains/claude/authorize", "POST", "{}"],
    ]);
  });
});

describe("classifyAgentsError", () => {
  it("403 AGENT_PLAN_LIMIT keeps the plan, price and checkout", () => {
    expect(
      classifyAgentsError(
        403,
        JSON.stringify({
          error: "Your plan does not include agents.",
          code: "AGENT_PLAN_LIMIT",
          requiredPlan: "agents-500",
          amountMinor: 50000,
          currency: "usd",
          checkoutUrl: "https://checkout.example/x",
        }),
      ),
    ).toEqual({
      kind: "plan_limit",
      status: 403,
      code: "AGENT_PLAN_LIMIT",
      serverMessage: "Your plan does not include agents.",
      requiredPlan: "agents-500",
      amountMinor: 50000,
      currency: "usd",
      checkoutUrl: "https://checkout.example/x",
    });
  });

  it("403 without a code is the createAgents capability", () => {
    expect(classifyAgentsError(403, JSON.stringify({ error: "Forbidden: owner or admin role required" })).kind).toBe("forbidden");
  });

  it("403 CLAUDE_PROVIDER_NOT_ENABLED", () => {
    expect(classifyAgentsError(403, JSON.stringify({ code: "CLAUDE_PROVIDER_NOT_ENABLED" })).kind).toBe("brain_not_enabled");
  });

  it("409 stale quote vs taken handle", () => {
    expect(classifyAgentsError(409, JSON.stringify({ code: "AGENT_PROVISION_QUOTE_STALE" })).kind).toBe("quote_stale");
    expect(classifyAgentsError(409, JSON.stringify({ error: "slug taken" })).kind).toBe("handle_taken");
  });

  it("other statuses and unreadable bodies", () => {
    expect(classifyAgentsError(404, "").kind).toBe("not_found");
    expect(classifyAgentsError(401, "").kind).toBe("unauthorized");
    expect(classifyAgentsError(400, "{\"error\":\"bad\"}")).toEqual({ kind: "invalid", status: 400, serverMessage: "bad" });
    expect(classifyAgentsError(502, "<html>")).toEqual({ kind: "server", status: 502 });
  });
});

describe("createErrorCopy", () => {
  it("plan limit with checkout names the price and offers the upgrade", () => {
    const copy = createErrorCopy(
      { kind: "plan_limit", status: 403, amountMinor: 50000, currency: "usd", checkoutUrl: "https://c/x" },
      { companyLabel: "Indigo" },
    );
    expect(copy.message).toBe("Cloud bots need the Agents plan ($500 a month). Indigo isn't on it yet.");
    expect(copy.fix).toEqual({ kind: "checkout", url: "https://c/x", label: "Upgrade plan" });
  });

  it("plan limit without checkout sends the person to an owner", () => {
    const copy = createErrorCopy({ kind: "plan_limit", status: 403 }, { companyLabel: "Indigo" });
    expect(copy.message).toBe("Cloud bots need the Agents plan. Indigo isn't on it yet. Ask a company owner to upgrade.");
    expect(copy.fix).toEqual({ kind: "ask_admin" });
  });

  it("capability refusal names the admin when known", () => {
    expect(createErrorCopy({ kind: "forbidden", status: 403 }, { companyLabel: "Indigo", adminName: "Corey" })).toEqual({
      message: "Only admins of Indigo can add cloud bots. Ask Corey to add it, or to give you access.",
      fix: { kind: "ask_admin", adminName: "Corey" },
    });
  });

  it("stale quote asks for a fresh price", () => {
    expect(createErrorCopy({ kind: "quote_stale", status: 409 }).fix).toEqual({ kind: "reload_quote" });
  });

  it("taken handle names it", () => {
    expect(createErrorCopy({ kind: "handle_taken", status: 409 }, { handle: "ada", companyLabel: "Indigo" }).message).toBe(
      "@ada is already taken in Indigo. Pick another handle.",
    );
  });

  it("every kind has a sentence", () => {
    for (const kind of ["brain_not_enabled", "not_found", "unauthorized", "invalid", "network", "server"] as const) {
      expect(createErrorCopy({ kind, status: 0 }).message.length).toBeGreaterThan(10);
    }
  });

  it("formats prices", () => {
    expect(formatPlanPrice(50000, "usd")).toBe("$500");
    expect(formatPlanPrice(1999, "usd")).toBe("$19.99");
    expect(formatPlanPrice(undefined, "usd")).toBeNull();
  });
});

describe("getCreateAvailability", () => {
  it("200 is available and probes provision-options for that company", async () => {
    const fetch = fakeFetch(200, { options: [] });
    await expect(createAgentsClient(fetch).getCreateAvailability("cmp_1")).resolves.toEqual({ state: "available" });
    expect(fetch.mock.calls[0]![0]).toBe("/v1/agents/provision-options?companyUid=cmp_1");
  });

  it("403 is the role refusal, naming admins when the server sends them", async () => {
    await expect(
      createAgentsClient(fakeFetch(403, { error: "Forbidden", admins: [{ displayName: "Corey" }, { displayName: "Corey" }, "Stefan"] })).getCreateAvailability("cmp_1"),
    ).resolves.toEqual({ state: "role", admins: ["Corey", "Stefan"] });
    await expect(createAgentsClient(fakeFetch(403, "nope")).getCreateAvailability("cmp_1")).resolves.toEqual({ state: "role", admins: [] });
    await expect(
      createAgentsClient(
        fakeFetch(403, {
          code: "CREATE_AGENTS_NOT_ALLOWED",
          admins: [{ personUid: "prs_1", displayName: "prs_1" }, { personUid: "prs_2", displayName: "Shawon" }],
        }),
      ).getCreateAvailability("cmp_1"),
    ).resolves.toEqual({ state: "role", admins: ["Shawon"] });
  });

  it("a plan block on the quote is the plan state", async () => {
    await expect(
      createAgentsClient(
        fakeFetch(200, { options: [], createBlock: { code: "AGENT_PLAN_LIMIT", requiredPlan: "agents-500", amountMinor: 50000, currency: "usd" } }),
      ).getCreateAvailability("cmp_1"),
    ).resolves.toEqual({ state: "plan", requiredPlan: "agents-500", amountMinor: 50000, currency: "usd" });
  });

  it("404 is not a member, other failures are unknown", async () => {
    await expect(createAgentsClient(fakeFetch(404, {})).getCreateAvailability("cmp_1")).resolves.toEqual({ state: "not_member" });
    await expect(createAgentsClient(fakeFetch(503, {})).getCreateAvailability("cmp_1")).resolves.toMatchObject({ state: "unknown" });
  });
});

describe("cloudUnavailableCopy", () => {
  it("no company wins", () => {
    expect(cloudUnavailableCopy({ state: "available" }, { companies: 0 })?.reason).toBe(
      "Cloud bots belong to a company. Create or join a company first.",
    );
  });

  it("available and unknown leave the card usable", () => {
    expect(cloudUnavailableCopy({ state: "available" }, { companies: 1 })).toBeNull();
    expect(cloudUnavailableCopy({ state: "unknown", error: { kind: "server", status: 503 } }, { companies: 1 })).toBeNull();
    expect(cloudUnavailableCopy(null, { companies: 1 })).toBeNull();
  });

  it("role names the admin to ask", () => {
    expect(cloudUnavailableCopy({ state: "role", admins: ["Corey"] }, { companies: 1, companyLabel: "Indigo" })).toEqual({
      reason: "Only admins of Indigo can add cloud bots. Ask Corey.",
      fix: { kind: "ask_admin", adminName: "Corey" },
    });
    expect(cloudUnavailableCopy({ state: "role", admins: [] }, { companies: 1, companyLabel: "Indigo" })?.reason).toBe(
      "Only admins of Indigo can add cloud bots. Ask a company admin.",
    );
  });

  it("plan names the plan and offers checkout", () => {
    expect(
      cloudUnavailableCopy(
        { state: "plan", amountMinor: 50000, currency: "usd", checkoutUrl: "https://c/x" },
        { companies: 1, companyLabel: "Indigo" },
      ),
    ).toEqual({
      reason: "Cloud bots need the Agents plan ($500 a month). Indigo isn't on it yet.",
      fix: { kind: "checkout", url: "https://c/x", label: "Upgrade plan" },
    });
  });
});
