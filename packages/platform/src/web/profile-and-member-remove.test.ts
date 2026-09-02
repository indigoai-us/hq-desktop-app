import { describe, expect, it } from "vitest";

import { WebPlatformAdapter } from "./index.js";

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function makeAdapter(responseBody: unknown = { ok: true }) {
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
    return new Response(JSON.stringify(responseBody), { status: 200 });
  };
  return {
    adapter: new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: fetchMock,
    }),
    calls,
  };
}

describe("WebPlatformAdapter member removal", () => {
  it("DELETEs the per-member path with an encoded personUid", async () => {
    const { adapter, calls } = makeAdapter({ removed: "prs bob" });
    const res = await adapter.messaging.removeChannelMember("chn_1", "prs bob");
    expect(res.ok).toBe(true);
    expect(calls[0]).toEqual({
      method: "DELETE",
      path: "/v1/notify/channels/chn_1/members/prs%20bob",
      body: undefined,
    });
  });
});

describe("WebPlatformAdapter channel delete", () => {
  it("DELETEs the channel path with an encoded channelId", async () => {
    const { adapter, calls } = makeAdapter({ deleted: "chn 1" });
    const res = await adapter.messaging.deleteChannel("chn 1");
    expect(res.ok).toBe(true);
    expect(calls[0]).toEqual({
      method: "DELETE",
      path: "/v1/notify/channels/chn%201",
      body: undefined,
    });
  });
});

describe("WebPlatformAdapter profile", () => {
  it("GETs /v1/profile", async () => {
    const { adapter, calls } = makeAdapter({
      profile: { displayName: "Ada" },
      entityName: "Ada Lovelace",
    });
    const res = await adapter.identity.getProfile();
    expect(res.ok).toBe(true);
    expect(calls[0]).toEqual({
      method: "GET",
      path: "/v1/profile",
      body: undefined,
    });
    if (res.ok) expect(res.value.profile?.displayName).toBe("Ada");
  });

  it("PUTs the editable fields to /v1/profile", async () => {
    const { adapter, calls } = makeAdapter({
      profile: { displayName: "Ada", description: "Founder" },
    });
    const res = await adapter.identity.updateProfile({
      displayName: "Ada",
      description: "Founder",
      avatarBase64: "QUJD",
    });
    expect(res.ok).toBe(true);
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/v1/profile",
      body: {
        displayName: "Ada",
        description: "Founder",
        avatarBase64: "QUJD",
      },
    });
  });
});
