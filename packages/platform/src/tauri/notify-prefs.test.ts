import { describe, expect, it } from "vitest";
import { TauriPlatformAdapter } from "./index.js";
import { createSyncPlatformAdapter } from "./sync-adapter.js";
import { WebPlatformAdapter } from "../web/index.js";

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

const PREFS = {
  prefs: {
    pausedUntil: null,
    dmsDuringPause: false,
    dms: true,
    mentions: true,
    files: true,
    allActivity: true,
    addedToChannel: true,
    updatedAt: "2026-09-23T19:19:03.904Z",
  },
  paused: false,
};

function recordingInvoke(responseBody: unknown, status = 200) {
  const calls: Invocation[] = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "hq_pro_fetch") {
      return { status, body: JSON.stringify(responseBody) };
    }
    return null;
  };
  return { calls, invoke };
}

describe("sync adapter notification prefs", () => {
  it("GETs /v1/notify/prefs through hq_pro_fetch", async () => {
    const { calls, invoke } = recordingInvoke(PREFS);
    const adapter = createSyncPlatformAdapter({ invoke });
    const res = await adapter.messaging.getNotifyPrefs!();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.prefs.dms).toBe(true);
    expect(calls[0]).toEqual({
      cmd: "hq_pro_fetch",
      args: { url: "/v1/notify/prefs", method: "GET", body: null },
    });
  });

  it("PUTs a partial body and then drops the native prefs cache", async () => {
    const { calls, invoke } = recordingInvoke(PREFS);
    const adapter = createSyncPlatformAdapter({ invoke });
    const res = await adapter.messaging.updateNotifyPrefs!({
      pausedUntil: "forever",
    });
    expect(res.ok).toBe(true);
    expect(calls[0]).toEqual({
      cmd: "hq_pro_fetch",
      args: {
        url: "/v1/notify/prefs",
        method: "PUT",
        body: JSON.stringify({ pausedUntil: "forever" }),
      },
    });
    expect(calls[1]?.cmd).toBe("invalidate_notify_prefs_cache");
  });

  it("returns the saved prefs even when the cache drop throws", async () => {
    const calls: string[] = [];
    const invoke = async (cmd: string) => {
      calls.push(cmd);
      if (cmd === "hq_pro_fetch") return { status: 200, body: JSON.stringify(PREFS) };
      throw new Error("command invalidate_notify_prefs_cache not found");
    };
    const adapter = createSyncPlatformAdapter({ invoke });
    const res = await adapter.messaging.updateNotifyPrefs!({ dms: false });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.prefs.dms).toBe(true);
    expect(calls).toEqual(["hq_pro_fetch", "invalidate_notify_prefs_cache"]);
  });

  it("does not drop the cache when the PUT fails", async () => {
    const { calls, invoke } = recordingInvoke(
      { error: "bad", code: "INVALID_NOTIFY_PREFS" },
      400,
    );
    const adapter = createSyncPlatformAdapter({ invoke });
    const res = await adapter.messaging.updateNotifyPrefs!({ dms: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("INVALID_NOTIFY_PREFS");
    expect(calls.map((c) => c.cmd)).toEqual(["hq_pro_fetch"]);
  });

  it("PUTs the channel level and keeps coded errors", async () => {
    const { calls, invoke } = recordingInvoke(
      { error: "Join the channel first", code: "CHANNEL_NOT_JOINED" },
      403,
    );
    const adapter = createSyncPlatformAdapter({ invoke });
    const res = await adapter.messaging.setChannelNotifyLevel!(
      "chn_1",
      "muted",
    );
    expect(calls[0]).toEqual({
      cmd: "hq_pro_fetch",
      args: {
        url: "/v1/notify/channels/chn_1/notify-level",
        method: "PUT",
        body: JSON.stringify({ level: "muted" }),
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("CHANNEL_NOT_JOINED");
  });

  it("surfaces a pre-rollout 404 as http-404", async () => {
    const { invoke } = recordingInvoke({ message: "Not Found" }, 404);
    const adapter = createSyncPlatformAdapter({ invoke });
    const res = await adapter.messaging.getNotifyPrefs!();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("http-404");
  });
});

describe("TauriPlatformAdapter notification prefs", () => {
  it("routes the three calls through hq_pro_fetch", async () => {
    const { calls, invoke } = recordingInvoke(PREFS);
    const adapter = new TauriPlatformAdapter({ invoke });
    await adapter.messaging.getNotifyPrefs!();
    await adapter.messaging.updateNotifyPrefs!({ mentions: false });
    await adapter.messaging.setChannelNotifyLevel!("chn_2", "files");
    expect(calls.map((c) => [c.args?.method, c.args?.url])).toEqual([
      ["GET", "/v1/notify/prefs"],
      ["PUT", "/v1/notify/prefs"],
      ["PUT", "/v1/notify/channels/chn_2/notify-level"],
    ]);
  });
});

describe("WebPlatformAdapter notification prefs", () => {
  it("uses the same REST paths", async () => {
    const seen: Array<[string, string, unknown]> = [];
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async (input, init) => {
        seen.push([
          init?.method ?? "GET",
          String(input).replace("https://api.test", ""),
          init?.body ? JSON.parse(String(init.body)) : undefined,
        ]);
        return new Response(JSON.stringify(PREFS), { status: 200 });
      },
    });
    await adapter.messaging.getNotifyPrefs!();
    await adapter.messaging.updateNotifyPrefs!({ pausedUntil: null });
    await adapter.messaging.setChannelNotifyLevel!("chn 3", "all");
    expect(seen).toEqual([
      ["GET", "/v1/notify/prefs", undefined],
      ["PUT", "/v1/notify/prefs", { pausedUntil: null }],
      ["PUT", "/v1/notify/channels/chn%203/notify-level", { level: "all" }],
    ]);
  });
});
