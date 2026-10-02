/**
 * The direct cloud create (desktop-agent-creation US-004) run against the WEB
 * adapter with a mocked hq-pro, so the path is proven to need nothing from
 * Tauri (US-010).
 */
import { describe, expect, it, vi } from "vitest";
import { WebPlatformAdapter, ok, failure } from "@hq/platform";
import {
  DESKTOP_NEW_BOT_SURFACE,
  createDirectCloudCreate,
  newWizardIdempotencyKey,
  runDirectCloudCreate,
  type DirectCloudDraft,
} from "./cloud-create.js";

const INDIGO = "cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG";

const DRAFT: DirectCloudDraft = {
  name: "Ada",
  handle: "ada",
  runtime: "grok",
  idempotencyKey: "desktop-new-bot-1",
  quote: { instanceType: "t3.medium", netMonthlyCents: 10000, catalogVersion: "catalog-7" },
};

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

function webAdapter(answer: (method: string, path: string) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const adapter = new WebPlatformAdapter({
    baseUrl: "https://api.test",
    headers: { Authorization: "Bearer t" },
    fetch: async (input, init) => {
      const path = String(input).replace("https://api.test", "");
      const method = init?.method ?? "GET";
      seen.push({ method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const res = answer(method, path);
      return new Response(JSON.stringify(res.body), { status: res.status });
    },
  });
  return { adapter, seen };
}

const CREATED = {
  agent: { uid: "agt_ada", name: "Ada", slug: "ada", companyUid: INDIGO },
  setupState: { version: 1, phase: "provisioning", idempotencyKey: "desktop-new-bot-1", steps: [], updatedAt: "t" },
};

function flags(on: boolean) {
  return { status: 200, body: { version: 1, flags: on ? { "agents.desktop-agent-creation": true } : {} } };
}

describe("createDirectCloudCreate", () => {
  it("is null without a REST transport, so the card path stays", () => {
    expect(
      createDirectCloudCreate({ identity: { hasFeature: async () => ok(true) }, agents: {} }),
    ).toBeNull();
  });

  it("reads the flag with the company's uid; absent is off", async () => {
    const { adapter, seen } = webAdapter((_m, path) => flags(path.includes(`companyUid=${INDIGO}`)));
    const seam = createDirectCloudCreate(adapter)!;
    await expect(seam.isEnabled(INDIGO)).resolves.toBe(true);
    await expect(seam.isEnabled(null)).resolves.toBe(false);
    await expect(seam.isEnabled("cmp_other")).resolves.toBe(false);
    await expect(seam.anyEnabled(["cmp_other", INDIGO])).resolves.toBe(true);
    await expect(seam.anyEnabled(["cmp_other"])).resolves.toBe(false);
    expect(seen[0]?.path).toBe(`/v1/flags/resolve?companyUid=${INDIGO}`);
  });

  it("is off when the flag read fails or throws", async () => {
    const fetch = async () => new Response("{}", { status: 200 });
    const failing = createDirectCloudCreate({
      identity: { hasFeature: async () => failure("network", "down") },
      agents: { fetch },
    })!;
    await expect(failing.isEnabled(INDIGO)).resolves.toBe(false);
    const throwing = createDirectCloudCreate({
      identity: {
        hasFeature: async () => {
          throw new Error("boom");
        },
      },
      agents: { fetch },
    })!;
    await expect(throwing.isEnabled(INDIGO)).resolves.toBe(false);
  });
});

describe("runDirectCloudCreate (web adapter, mocked API)", () => {
  it("POSTs /v1/agents once with deferChannels, the surface, the key and the quote", async () => {
    const { adapter, seen } = webAdapter(() => ({ status: 201, body: CREATED }));
    const seam = createDirectCloudCreate(adapter)!;
    await expect(runDirectCloudCreate(seam.client, INDIGO, DRAFT)).resolves.toEqual({
      ok: true,
      agentUid: "agt_ada",
      name: "Ada",
    });
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/v1/agents",
        body: {
          companyUid: INDIGO,
          name: "Ada",
          slug: "ada",
          provider: "agents-v2",
          codexModel: "grok-4.7",
          codexAuthMode: "subscription",
          deferChannels: true,
          idempotencyKey: "desktop-new-bot-1",
          surface: DESKTOP_NEW_BOT_SURFACE,
          desiredInstanceType: "t3.medium",
          quotedNetMonthlyCents: 10000,
          quoteCatalogVersion: "catalog-7",
        },
      },
    ]);
  });

  it("a double-click replays the same key and lands on the same bot", async () => {
    let calls = 0;
    const { adapter, seen } = webAdapter(() => ({ status: calls++ === 0 ? 201 : 200, body: CREATED }));
    const client = createDirectCloudCreate(adapter)!.client;
    const [a, b] = await Promise.all([
      runDirectCloudCreate(client, INDIGO, DRAFT),
      runDirectCloudCreate(client, INDIGO, DRAFT),
    ]);
    expect(a).toEqual(b);
    expect(new Set(seen.map((s) => (s.body as { idempotencyKey: string }).idempotencyKey))).toEqual(
      new Set(["desktop-new-bot-1"]),
    );
  });

  it("403 AGENT_PLAN_LIMIT: plain words, the price and the checkout", async () => {
    const { adapter } = webAdapter(() => ({
      status: 403,
      body: {
        error: "Your plan does not include agents.",
        code: "AGENT_PLAN_LIMIT",
        requiredPlan: "agents-500",
        amountMinor: 50000,
        currency: "usd",
        checkoutUrl: "https://checkout.test/agents",
      },
    }));
    const result = await runDirectCloudCreate(createDirectCloudCreate(adapter)!.client, INDIGO, DRAFT, {
      companyLabel: "Indigo",
    });
    expect(result).toEqual({
      ok: false,
      reason: "Cloud bots need the Agents plan ($500 a month). Indigo isn't on it yet.",
      blocked: true,
      fix: { kind: "checkout", url: "https://checkout.test/agents", label: "Upgrade plan" },
    });
  });

  it("403 createAgents capability: ask an admin", async () => {
    const { adapter } = webAdapter(() => ({ status: 403, body: { error: "Forbidden: owner or admin role required" } }));
    const result = await runDirectCloudCreate(createDirectCloudCreate(adapter)!.client, INDIGO, DRAFT, {
      companyLabel: "Indigo",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "Only admins of Indigo can add cloud bots. Ask a company admin to add it, or to give you access.",
      blocked: true,
      fix: { kind: "ask_admin" },
    });
  });

  it("409 stale quote: asks for the new price", async () => {
    const { adapter } = webAdapter(() => ({
      status: 409,
      body: { code: "AGENT_PROVISION_QUOTE_STALE", error: "The agent size or price has changed" },
    }));
    const result = await runDirectCloudCreate(createDirectCloudCreate(adapter)!.client, INDIGO, DRAFT);
    expect(result).toMatchObject({ ok: false, blocked: true, fix: { kind: "reload_quote" } });
    expect(result.ok ? "" : result.reason).toContain("price for this size changed");
  });

  it("409 handle taken names the handle", async () => {
    const { adapter } = webAdapter(() => ({ status: 409, body: { error: "slug taken" } }));
    const result = await runDirectCloudCreate(createDirectCloudCreate(adapter)!.client, INDIGO, DRAFT, {
      companyLabel: "Indigo",
    });
    expect(result).toMatchObject({ ok: false, reason: "@ada is already taken in Indigo. Pick another handle." });
  });

  it("a 5xx is not a refusal", async () => {
    const { adapter } = webAdapter(() => ({ status: 502, body: {} }));
    const result = await runDirectCloudCreate(createDirectCloudCreate(adapter)!.client, INDIGO, DRAFT);
    expect(result).toMatchObject({ ok: false, blocked: false, fix: { kind: "retry" } });
  });

  it("availability reads provision-options for the company", async () => {
    const { adapter, seen } = webAdapter(() => ({ status: 403, body: { error: "Forbidden: createAgents capability required" } }));
    await expect(createDirectCloudCreate(adapter)!.availability(INDIGO)).resolves.toEqual({ state: "role", admins: [] });
    expect(seen[0]?.path).toBe(`/v1/agents/provision-options?companyUid=${INDIGO}`);
  });
});

describe("newWizardIdempotencyKey", () => {
  it("is unique per session", () => {
    const keys = new Set(Array.from({ length: 20 }, () => newWizardIdempotencyKey()));
    expect(keys.size).toBe(20);
  });

  it("works without crypto.randomUUID", () => {
    const original = globalThis.crypto.randomUUID;
    vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: undefined });
    try {
      expect(newWizardIdempotencyKey()).toMatch(/^desktop-new-bot-/);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(globalThis.crypto.randomUUID).toBe(original);
  });
});
