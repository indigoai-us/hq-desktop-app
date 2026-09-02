import { describe, expect, it } from "vitest";

import { WebPlatformAdapter } from "./index.js";
import { DELETE_CHANNEL_UNSUPPORTED_MESSAGE } from "../adapter.js";

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function makeAdapter(responseBody: unknown = { ok: true }, status = 200) {
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
    return new Response(JSON.stringify(responseBody), { status });
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

  it("maps API Gateway's generic 404 to an honest unsupported message", async () => {
    const { adapter } = makeAdapter({ message: "Not Found" }, 404);
    const res = await adapter.messaging.deleteChannel("chn_1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("http-404");
      expect(res.message).toBe(DELETE_CHANNEL_UNSUPPORTED_MESSAGE);
    }
  });

  it("keeps the server's coded 404 and a code-less 404 with an error string", async () => {
    const coded = makeAdapter(
      { error: "Channel not found", code: "CHANNEL_NOT_FOUND" },
      404,
    );
    const codedRes = await coded.adapter.messaging.deleteChannel("chn_1");
    expect(codedRes.ok).toBe(false);
    if (!codedRes.ok) {
      expect(codedRes.code).toBe("CHANNEL_NOT_FOUND");
      expect(codedRes.message).toBe("Channel not found");
    }
    const bare = makeAdapter({ error: "Channel was already removed" }, 404);
    const bareRes = await bare.adapter.messaging.deleteChannel("chn_1");
    expect(bareRes.ok).toBe(false);
    if (!bareRes.ok) {
      expect(bareRes.code).toBe("http-404");
      expect(bareRes.message).toBe("Channel was already removed");
    }
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

  it("PATCHes /v1/agents/{uid}/profile", async () => {
    const { adapter, calls } = makeAdapter({
      uid: "agt_scout",
      profile: { avatarBase64: "QUJD" },
      slackUpdated: false,
    });
    const res = await adapter.identity.updateAgentProfile("agt_scout", {
      avatarBase64: "QUJD",
    });
    expect(res.ok).toBe(true);
    expect(calls[0]).toEqual({
      method: "PATCH",
      path: "/v1/agents/agt_scout/profile",
      body: { avatarBase64: "QUJD" },
    });
  });
});
