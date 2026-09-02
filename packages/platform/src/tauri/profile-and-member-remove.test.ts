import { describe, expect, it } from "vitest";
import { TauriPlatformAdapter } from "./index.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

function makeAdapter(responseBody: unknown) {
  const calls: Invocation[] = [];
  const adapter = new TauriPlatformAdapter({
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      // hq_pro_fetch returns { status, body } — the JSON tunnel shape.
      return { status: 200, body: JSON.stringify(responseBody) };
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
});
