import { describe, expect, it } from "vitest";

import { WebPlatformAdapter } from "./index.js";

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function makeAdapter(
  respond: (path: string) => { status: number; body?: unknown },
) {
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
    const { status, body: resBody } = respond(path);
    return new Response(
      resBody === undefined ? null : JSON.stringify(resBody),
      { status },
    );
  };
  return {
    adapter: new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: fetchMock,
    }),
    calls,
  };
}

describe("WebPlatformAdapter sendDmToEmail", () => {
  it("POSTs /v1/notify/dm with toEmail only and maps 200 to delivered", async () => {
    const { adapter, calls } = makeAdapter(() => ({
      status: 200,
      body: { delivered: true },
    }));
    const result = await adapter.messaging.sendDmToEmail!({
      toEmail: " kai@acme.test ",
      body: " hello ",
    });
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/notify/dm",
        body: { toEmail: "kai@acme.test", body: "hello" },
      },
    ]);
    expect(result).toEqual({
      ok: true,
      value: { delivered: true, state: "delivered" },
    });
  });

  it("maps the 202 connection_requested envelope to connectionRequested", async () => {
    const { adapter } = makeAdapter(() => ({
      status: 202,
      body: { state: "connection_requested" },
    }));
    const result = await adapter.messaging.sendDmToEmail!({
      toEmail: "kai@acme.test",
      body: "hello",
    });
    expect(result).toEqual({
      ok: true,
      value: { state: "connectionRequested" },
    });
  });

  it("sends exactly one recipient key — personUid wins when both are given", async () => {
    const { adapter, calls } = makeAdapter(() => ({ status: 200 }));
    const result = await adapter.messaging.sendDmToEmail!({
      toEmail: "kai@acme.test",
      toPersonUid: "prs_kai",
      body: "hello",
    });
    expect(calls[0]?.body).toEqual({ toPersonUid: "prs_kai", body: "hello" });
    // A bare 200 with no JSON is delivered, like the Rust command.
    expect(result).toEqual({ ok: true, value: { state: "delivered" } });
  });

  it("refuses an empty body or a missing recipient without calling the server", async () => {
    const { adapter, calls } = makeAdapter(() => ({ status: 200 }));
    await expect(
      adapter.messaging.sendDmToEmail!({ toEmail: "kai@acme.test", body: "  " }),
    ).resolves.toMatchObject({ ok: false, code: "invalid" });
    await expect(
      adapter.messaging.sendDmToEmail!({ body: "hello" }),
    ).resolves.toMatchObject({ ok: false, code: "invalid" });
    expect(calls).toHaveLength(0);
  });

  it("surfaces server refusals (blocked recipient, caps) as failures with the server message", async () => {
    const { adapter } = makeAdapter(() => ({
      status: 404,
      body: { code: "RECIPIENT_NOT_FOUND", error: "No one at that address" },
    }));
    const result = await adapter.messaging.sendDmToEmail!({
      toEmail: "kai@acme.test",
      body: "hello",
    });
    expect(result).toMatchObject({
      ok: false,
      code: "RECIPIENT_NOT_FOUND",
      message: "No one at that address",
    });
  });
});
