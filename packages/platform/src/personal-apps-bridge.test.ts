import { describe, expect, it, vi } from "vitest";
import { createPersonalAppsBridge } from "./personal-apps-bridge.js";

const respond = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

describe("personal apps bridge", () => {
  it("lists a bot's apps from the bridge", async () => {
    const fetcher = vi.fn(() => respond(200, { apps: [{ name: "notion", url: "https://mcp.notion.com/mcp", auth: "oauth", enabled: true, connected: true, tools: 61 }] }));
    const api = createPersonalAppsBridge("http://127.0.0.1:8765", fetcher as unknown as typeof fetch);
    const result = await api.list("agt_1");
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:8765/api/bots/agt_1/apps", expect.anything());
    expect(result).toEqual({ ok: true, value: { apps: [expect.objectContaining({ name: "notion", connected: true, tools: 61 })] } });
  });

  it("encodes the app name and bot uid in paths", async () => {
    const fetcher = vi.fn(() => respond(200, { removed: "a b" }));
    const api = createPersonalAppsBridge("http://127.0.0.1:8765", fetcher as unknown as typeof fetch);
    await api.remove("agt/1", "a b");
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:8765/api/bots/agt%2F1/apps/a%20b", expect.objectContaining({ method: "DELETE" }));
  });

  it("returns a failure with the HTTP status and bridge message", async () => {
    const fetcher = vi.fn(() => respond(409, { error: "exists" }));
    const api = createPersonalAppsBridge("http://127.0.0.1:8765", fetcher as unknown as typeof fetch);
    const result = await api.add("agt_1", { name: "notion", url: "https://mcp.notion.com/mcp" });
    expect(result).toMatchObject({ ok: false, reason: "error", status: 409, message: "exists" });
  });

  it("reports an unreachable bridge as a failure, not a throw", async () => {
    const fetcher = vi.fn(() => Promise.reject(new Error("connection refused")));
    const api = createPersonalAppsBridge("http://127.0.0.1:8765", fetcher as unknown as typeof fetch);
    await expect(api.startSignIn("agt_1", "notion")).resolves.toMatchObject({ ok: false, code: "network" });
  });
});
