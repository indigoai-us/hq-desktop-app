import { describe, expect, it } from "vitest";
import { TauriPlatformAdapter } from "./index.js";
import { createSyncPlatformAdapter } from "./sync-adapter.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

const REQUEST = {
  pairKey: "pk_ada_bob",
  fromPersonUid: "prs_ada",
  fromEmail: "ada@example.com",
  fromDisplayName: "Ada",
  createdAt: "2026-09-10T00:00:00.000Z",
};

describe("createSyncPlatformAdapter DM connection requests", () => {
  it("unwraps `{ requests: [...] }` from list_dm_requests", async () => {
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd) => {
        if (cmd === "list_dm_requests") return { requests: [REQUEST] };
        throw new Error(`unexpected ${cmd}`);
      },
    });
    await expect(adapter.messaging.listDmRequests()).resolves.toEqual({
      ok: true,
      value: [REQUEST],
    });
  });

  it("invokes respond_dm_request with camelCase { pairKey, action }", async () => {
    const calls: Invocation[] = [];
    const adapter = createSyncPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return { state: "accepted" };
      },
    });
    const result = await adapter.messaging.respondDmRequest!({
      pairKey: "pk_ada_bob",
      action: "accept",
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        cmd: "respond_dm_request",
        args: { pairKey: "pk_ada_bob", action: "accept" },
      },
    ]);
  });
});

describe("TauriPlatformAdapter DM connection requests", () => {
  it("invokes respond_dm_request with camelCase { pairKey, action }", async () => {
    const calls: Invocation[] = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (cmd, args) => {
        calls.push({ cmd, args });
        return {};
      },
    });
    await adapter.messaging.respondDmRequest!({ pairKey: "pk_1", action: "block" });
    expect(calls).toEqual([
      { cmd: "respond_dm_request", args: { pairKey: "pk_1", action: "block" } },
    ]);
  });
});
