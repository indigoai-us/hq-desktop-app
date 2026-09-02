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
});
