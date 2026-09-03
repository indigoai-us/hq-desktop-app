import { describe, expect, it } from "vitest";
import { TauriPlatformAdapter } from "./index.js";
import { DELETE_CHANNEL_UNSUPPORTED_MESSAGE } from "../adapter.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

function makeAdapter(responseBody: unknown, status = 200) {
  const calls: Invocation[] = [];
  const adapter = new TauriPlatformAdapter({
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      // hq_pro_fetch returns { status, body } — the JSON tunnel shape.
      return { status, body: JSON.stringify(responseBody) };
    },
  });
  return { adapter, calls };
}

describe("TauriPlatformAdapter member removal", () => {
  it("routes removeChannelMember as a DELETE through hq_pro_fetch", async () => {
    const { adapter, calls } = makeAdapter({ removed: "prs_bob" });
    const res = await adapter.messaging.removeChannelMember("chn_1", "prs_bob");
    expect(res.ok).toBe(true);
    expect(calls[0]).toEqual({
      cmd: "hq_pro_fetch",
      args: {
        url: "/v1/notify/channels/chn_1/members/prs_bob",
        method: "DELETE",
        body: null,
      },
    });
  });
});

describe("TauriPlatformAdapter channel delete", () => {
  it("routes deleteChannel as a DELETE on the channel path through hq_pro_fetch", async () => {
    const { adapter, calls } = makeAdapter({ deleted: "chn_1" });
    const res = await adapter.messaging.deleteChannel("chn_1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ deleted: "chn_1" });
    expect(calls[0]).toEqual({
      cmd: "hq_pro_fetch",
      args: { url: "/v1/notify/channels/chn_1", method: "DELETE", body: null },
    });
  });

  it("keeps the server's coded errors (owner / not-found / group)", async () => {
    const { adapter } = makeAdapter(
      { error: "Only the owner can delete this channel", code: "CHANNEL_NOT_OWNER" },
      403,
    );
    const res = await adapter.messaging.deleteChannel("chn_1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("CHANNEL_NOT_OWNER");
      expect(res.message).toBe("Only the owner can delete this channel");
    }
    const gone = makeAdapter(
      { error: "Channel not found", code: "CHANNEL_NOT_FOUND" },
      404,
    );
    const goneRes = await gone.adapter.messaging.deleteChannel("chn_x");
    expect(goneRes.ok).toBe(false);
    if (!goneRes.ok) {
      expect(goneRes.code).toBe("CHANNEL_NOT_FOUND");
      expect(goneRes.message).toBe("Channel not found");
    }
  });

  it("maps API Gateway's generic 404 to an honest unsupported message", async () => {
    const { adapter } = makeAdapter({ message: "Not Found" }, 404);
    const res = await adapter.messaging.deleteChannel("chn_1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toBe(DELETE_CHANNEL_UNSUPPORTED_MESSAGE);
    }
  });

  it("keeps a code-less 404 that carries a server error string", async () => {
    const { adapter } = makeAdapter({ error: "Channel was already removed" }, 404);
    const res = await adapter.messaging.deleteChannel("chn_1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("http-404");
      expect(res.message).toBe("Channel was already removed");
    }
  });

  it("keeps the 409 group-DM refusal text", async () => {
    const { adapter } = makeAdapter(
      { error: "Group DMs cannot be deleted", code: "CHANNEL_GROUP_NOT_DELETABLE" },
      409,
    );
    const res = await adapter.messaging.deleteChannel("chn_1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("CHANNEL_GROUP_NOT_DELETABLE");
      expect(res.message).toBe("Group DMs cannot be deleted");
    }
  });

  it("passes through a coded 503 CHANNEL_DELETE_INCOMPLETE retryable text", async () => {
    const { adapter } = makeAdapter(
      {
        error: "Channel delete did not finish. Try again.",
        code: "CHANNEL_DELETE_INCOMPLETE",
      },
      503,
    );
    const res = await adapter.messaging.deleteChannel("chn_1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("CHANNEL_DELETE_INCOMPLETE");
      expect(res.message).toBe("Channel delete did not finish. Try again.");
    }
  });

  it("does not map a body-less 503 to the unsupported message", async () => {
    const { adapter } = makeAdapter(null, 503);
    const res = await adapter.messaging.deleteChannel("chn_1");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("http-503");
      expect(res.message).not.toBe(DELETE_CHANNEL_UNSUPPORTED_MESSAGE);
    }
  });
});

describe("TauriPlatformAdapter profile", () => {
  it("GETs the profile through hq_pro_fetch", async () => {
    const { adapter, calls } = makeAdapter({ profile: { displayName: "Ada" } });
    const res = await adapter.identity.getProfile();
    expect(res.ok).toBe(true);
    expect(calls[0]).toEqual({
      cmd: "hq_pro_fetch",
      args: { url: "/v1/profile", method: "GET", body: null },
    });
  });

  it("PUTs profile updates through hq_pro_fetch", async () => {
    const { adapter, calls } = makeAdapter({ profile: { displayName: "Ada" } });
    const res = await adapter.identity.updateProfile({ displayName: "Ada" });
    expect(res.ok).toBe(true);
    expect(calls[0]).toEqual({
      cmd: "hq_pro_fetch",
      args: {
        url: "/v1/profile",
        method: "PUT",
        body: JSON.stringify({ displayName: "Ada" }),
      },
    });
  });

  it("PATCHes agent profile through hq_pro_fetch", async () => {
    const { adapter, calls } = makeAdapter({
      uid: "agt_scout",
      profile: { avatarBase64: "QUJD" },
    });
    const res = await adapter.identity.updateAgentProfile("agt_scout", {
      avatarBase64: "QUJD",
    });
    expect(res.ok).toBe(true);
    expect(calls[0]).toEqual({
      cmd: "hq_pro_fetch",
      args: {
        url: "/v1/agents/agt_scout/profile",
        method: "PATCH",
        body: JSON.stringify({ avatarBase64: "QUJD" }),
      },
    });
  });

  it("loads avatar packs and selects through hq_pro_fetch", async () => {
    const { adapter, calls } = makeAdapter({ packs: [] });
    await adapter.identity.listAvatarPacks();
    await adapter.identity.selectAgentAvatar("agt_scout", {
      packId: "animals",
      itemId: "v2-dot",
    });
    expect(
      calls.map((row) => `${String(row.args?.method)} ${String(row.args?.url)}`),
    ).toEqual([
      "GET /v1/avatar-packs",
      "POST /v1/agents/agt_scout/avatar",
    ]);
  });
});
