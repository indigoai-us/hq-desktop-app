import { describe, expect, it } from "vitest";

import { WebPlatformAdapter } from "./index.js";

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function makeAdapter(respond: (path: string) => unknown) {
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
    return new Response(JSON.stringify(respond(path)), { status: 200 });
  };
  return {
    adapter: new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: fetchMock,
    }),
    calls,
  };
}

const REQUEST = {
  pairKey: "pk_ada_bob",
  fromPersonUid: "prs_ada",
  fromEmail: "ada@example.com",
  fromDisplayName: "Ada",
  message: "hi",
  createdAt: "2026-09-10T00:00:00.000Z",
};

describe("WebPlatformAdapter DM connection requests", () => {
  it("unwraps `{ requests: [...] }` into a bare array like the Tauri adapter", async () => {
    const { adapter, calls } = makeAdapter(() => ({ requests: [REQUEST] }));
    const result = await adapter.messaging.listDmRequests();
    expect(calls[0]).toEqual({
      method: "GET",
      path: "/v1/notify/connections/requests",
      body: undefined,
    });
    expect(result).toEqual({ ok: true, value: [REQUEST] });
  });

  it("accepts a bare-array response too", async () => {
    const { adapter } = makeAdapter(() => [REQUEST]);
    await expect(adapter.messaging.listDmRequests()).resolves.toEqual({
      ok: true,
      value: [REQUEST],
    });
  });

  it("POSTs accept / decline / block with the pairKey body", async () => {
    const { adapter, calls } = makeAdapter(() => ({ state: "accepted" }));
    for (const action of ["accept", "decline", "block"] as const) {
      const result = await adapter.messaging.respondDmRequest!({
        pairKey: "pk_ada_bob",
        action,
      });
      expect(result.ok).toBe(true);
    }
    expect(calls).toEqual([
      { method: "POST", path: "/v1/notify/connections/accept", body: { pairKey: "pk_ada_bob" } },
      { method: "POST", path: "/v1/notify/connections/decline", body: { pairKey: "pk_ada_bob" } },
      { method: "POST", path: "/v1/notify/connections/block", body: { pairKey: "pk_ada_bob" } },
    ]);
  });

  it("rejects a blank pairKey and an unknown action without calling the API", async () => {
    const { adapter, calls } = makeAdapter(() => ({}));
    const blank = await adapter.messaging.respondDmRequest!({
      pairKey: "  ",
      action: "accept",
    });
    expect(blank.ok).toBe(false);
    const bogus = await adapter.messaging.respondDmRequest!({
      pairKey: "pk_x",
      action: "delete" as never,
    });
    expect(bogus.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
