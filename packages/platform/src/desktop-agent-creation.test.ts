/**
 * desktop-agent-creation: the company-scoped `agents.desktop-agent-creation`
 * flag read and the `agents.fetch` REST transport `@hq/agents` runs on, in
 * all three adapters.
 */
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_AGENT_CREATION_FLAG, createHqProRestFetch, registryKeyFor } from "./flags.js";
import { TauriPlatformAdapter } from "./tauri/index.js";
import { createSyncPlatformAdapter } from "./tauri/sync-adapter.js";
import { WebPlatformAdapter } from "./web/index.js";

const INDIGO = "cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

/** hq-flags answers on for the flag only when the request names Indigo. */
function desktopInvoke(calls: Invocation[]) {
  return async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd !== "hq_pro_fetch") throw new Error(`unexpected ${cmd}`);
    const url = String(args?.url ?? "");
    if (url.startsWith("/v1/flags/resolve")) {
      const companyScoped = url.includes(`companyUid=${INDIGO}`);
      return {
        status: 200,
        body: JSON.stringify({
          version: 1,
          flags: companyScoped ? { [DESKTOP_AGENT_CREATION_FLAG]: true } : {},
        }),
      };
    }
    if (url === "/v1/agents") {
      return { status: 403, body: JSON.stringify({ code: "AGENT_PLAN_LIMIT" }) };
    }
    throw new Error(`unexpected path ${url}`);
  };
}

describe("agents.desktop-agent-creation flag", () => {
  it("is registered under its own key", () => {
    expect(registryKeyFor(DESKTOP_AGENT_CREATION_FLAG)).toBe("agents.desktop-agent-creation");
  });

  type DesktopInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  for (const [label, build] of [
    ["sync adapter", (invoke: DesktopInvoke) => createSyncPlatformAdapter({ invoke })],
    ["tauri adapter", (invoke: DesktopInvoke) => new TauriPlatformAdapter({ invoke })],
  ] as const) {
    const make = (calls: Invocation[]) => build(desktopInvoke(calls));
    it(`${label}: a company-targeted value is read with that company's uid`, async () => {
      const calls: Invocation[] = [];
      const adapter = make(calls);
      await expect(
        adapter.identity.hasFeature(DESKTOP_AGENT_CREATION_FLAG, { companyUid: INDIGO }),
      ).resolves.toEqual({ ok: true, value: true });
      expect(calls.map((c) => c.args?.url)).toEqual([
        `/v1/flags/resolve?companyUid=${INDIGO}`,
      ]);
    });

    it(`${label}: person-only and other companies read as off (absent = off)`, async () => {
      const calls: Invocation[] = [];
      const adapter = make(calls);
      await expect(adapter.identity.hasFeature(DESKTOP_AGENT_CREATION_FLAG)).resolves.toEqual({ ok: true, value: false });
      await expect(
        adapter.identity.hasFeature(DESKTOP_AGENT_CREATION_FLAG, { companyUid: "cmp_OTHER" }),
      ).resolves.toEqual({ ok: true, value: false });
      // Never falls through to a legacy Rust command.
      expect(calls.every((c) => c.cmd === "hq_pro_fetch")).toBe(true);
    });

    it(`${label}: off when the registry is down`, async () => {
      const down = build(async () => ({ status: 503, body: "down" }));
      await expect(
        down.identity.hasFeature(DESKTOP_AGENT_CREATION_FLAG, { companyUid: INDIGO }),
      ).resolves.toEqual({ ok: true, value: false });
    });

    it(`${label}: agents.fetch forwards method and body over hq_pro_fetch and keeps refusals`, async () => {
      const calls: Invocation[] = [];
      const adapter = make(calls);
      const res = await adapter.agents.fetch!("/v1/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{\"a\":1}",
      });
      expect(res.status).toBe(403);
      await expect(res.text()).resolves.toBe(JSON.stringify({ code: "AGENT_PLAN_LIMIT" }));
      expect(calls).toEqual([
        { cmd: "hq_pro_fetch", args: { url: "/v1/agents", method: "POST", body: "{\"a\":1}" } },
      ]);
    });
  }

  it("web adapter: company scope reaches /v1/flags/resolve, person-only stays off", async () => {
    const paths: string[] = [];
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      headers: { Authorization: "Bearer t" },
      fetch: async (input) => {
        const path = String(input).replace("https://api.test", "");
        paths.push(path);
        const on = path === `/v1/flags/resolve?companyUid=${INDIGO}`;
        return new Response(
          JSON.stringify({ version: 1, flags: on ? { [DESKTOP_AGENT_CREATION_FLAG]: true } : {} }),
          { status: 200 },
        );
      },
    });
    await expect(
      adapter.identity.hasFeature(DESKTOP_AGENT_CREATION_FLAG, { companyUid: INDIGO }),
    ).resolves.toEqual({ ok: true, value: true });
    await expect(adapter.identity.hasFeature(DESKTOP_AGENT_CREATION_FLAG)).resolves.toEqual({ ok: true, value: false });
    expect(paths).toEqual([`/v1/flags/resolve?companyUid=${INDIGO}`, "/v1/flags/resolve"]);
  });

  it("web adapter: agents.fetch adds the session headers and the base URL", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test/",
      headers: { Authorization: "Bearer t" },
      fetch: async (input, init) => {
        seen.push({ url: String(input), init });
        return new Response("{\"code\":\"AGENT_PROVISION_QUOTE_STALE\"}", { status: 409 });
      },
    });
    const res = await adapter.agents.fetch!("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
    expect(seen[0]?.url).toBe("https://api.test/v1/agents");
    expect(seen[0]?.init).toMatchObject({
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json", Authorization: "Bearer t" },
    });
  });
});

describe("createHqProRestFetch", () => {
  it("defaults an absent body to null and passes the host's status and body through", async () => {
    const calls: Invocation[] = [];
    const f = createHqProRestFetch(async (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 201, body: "{\"ok\":true}" };
    });
    const res = await f("/v1/agents/agt_1/status", { method: "GET" });
    expect(res.status).toBe(201);
    await expect(res.text()).resolves.toBe("{\"ok\":true}");
    expect(calls[0]?.args).toEqual({ url: "/v1/agents/agt_1/status", method: "GET", body: null });
  });

  it("treats a response without a status as an error, not a 200", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const f = createHqProRestFetch(async () => ({ ok: true }));
      const res = await f("/v1/agents", { method: "POST", body: "{}" });
      expect(res.status).toBe(502);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
