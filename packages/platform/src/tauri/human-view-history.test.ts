import { describe, expect, it } from "vitest";

import { TauriPlatformAdapter } from "./index.js";
import { createSyncPlatformAdapter } from "./sync-adapter.js";
import { WebPlatformAdapter } from "../web/index.js";

/**
 * `view: "human"` on the two message history routes
 * (GET /v1/notify/channels/{id}/messages and GET /v1/notify/thread).
 *
 * The caller has to read the echoed `view` (and `viewScanTruncated`) to tell
 * a server-filtered page from the ordinary page an older server returns, so
 * every adapter must pass the option on and hand those fields back. A request
 * without `view` is unchanged and never carries the parameter.
 *
 * The Sync adapter keeps the native `fetch_channel` / `fetch_dm_thread`
 * commands for a history page with or without `view`, so the transport and
 * the row shape are the same against an older server as before. The Rust
 * side appends `view=human` and carries the echo (see `ChannelDetail` and
 * `ThreadResponse` in crates/hq-desktop-core).
 */

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

const HUMAN_PAGE = {
  messages: [],
  view: "human",
  nextCursor: "eyJwayI6IngifQ==",
  viewScanTruncated: true,
};

function recordingInvoke(responseBody: unknown = HUMAN_PAGE) {
  const calls: Invocation[] = [];
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "hq_pro_fetch") {
      return { status: 200, body: JSON.stringify(responseBody) };
    }
    return { messages: [] };
  };
  return { calls, invoke };
}

describe("sync adapter: history requests with view=human", () => {
  /** What the native command returns for a server-filtered page. */
  function nativeInvoke(page: unknown = HUMAN_PAGE) {
    const calls: Invocation[] = [];
    const invoke = async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "hq_pro_fetch") {
        return { status: 200, body: JSON.stringify(page) };
      }
      return page;
    };
    return { calls, invoke };
  }

  it("channel first page: the native command gets view, and the echo fields come back", async () => {
    const { calls, invoke } = nativeInvoke();
    const adapter = createSyncPlatformAdapter({ invoke });
    const res = await adapter.messaging.fetchChannel({
      channelId: "chn_ops",
      limit: 50,
      view: "human",
    });
    expect(calls).toEqual([
      {
        cmd: "fetch_channel",
        args: { channelId: "chn_ops", limit: 50, cursor: null, view: "human" },
      },
    ]);
    expect(res.ok).toBe(true);
    // The echo and the truncation flag reach the caller.
    if (res.ok) expect(res.value).toEqual(HUMAN_PAGE);
  });

  it("channel earlier page: the cursor goes back with view", async () => {
    const { calls, invoke } = nativeInvoke();
    const adapter = createSyncPlatformAdapter({ invoke });
    await adapter.messaging.fetchChannel({
      channelId: "chn_ops",
      limit: 50,
      cursor: "eyJwayI6IngifQ==",
      view: "human",
    });
    expect(calls).toEqual([
      {
        cmd: "fetch_channel",
        args: {
          channelId: "chn_ops",
          limit: 50,
          cursor: "eyJwayI6IngifQ==",
          view: "human",
        },
      },
    ]);
  });

  it("channel without view: the native command, unchanged, and no view key", async () => {
    const { calls, invoke } = nativeInvoke({ messages: [] });
    const adapter = createSyncPlatformAdapter({ invoke });
    await adapter.messaging.fetchChannel({ channelId: "chn_ops", limit: 50 });
    expect(calls).toEqual([
      {
        cmd: "fetch_channel",
        args: { channelId: "chn_ops", limit: 50, cursor: null },
      },
    ]);
  });

  it("channel since catch-up without view: unchanged, no view in the URL", async () => {
    const { calls, invoke } = nativeInvoke({ messages: [] });
    const adapter = createSyncPlatformAdapter({ invoke });
    await adapter.messaging.fetchChannel({
      channelId: "chn_ops",
      limit: 20,
      since: "2026-10-01T10:00:00.000Z",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("hq_pro_fetch");
    expect(String(calls[0].args?.url)).toBe(
      "/v1/notify/channels/chn_ops/messages?limit=20&since=2026-10-01T10%3A00%3A00.000Z",
    );
  });

  it("DM thread first page: the native command gets view, and the echo fields come back", async () => {
    const { calls, invoke } = nativeInvoke();
    const adapter = createSyncPlatformAdapter({ invoke });
    const res = await adapter.messaging.fetchDmThread({
      withPersonUid: "prs_ada",
      limit: 50,
      view: "human",
    });
    expect(calls).toEqual([
      {
        cmd: "fetch_dm_thread",
        args: { withPersonUid: "prs_ada", limit: 50, view: "human" },
      },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(HUMAN_PAGE);
  });

  it("DM thread earlier page: the cursor goes back with view", async () => {
    const { calls, invoke } = nativeInvoke();
    const adapter = createSyncPlatformAdapter({ invoke });
    await adapter.messaging.fetchDmThread({
      withPersonUid: "prs_ada",
      limit: 50,
      cursor: "eyJwayI6IngifQ==",
      view: "human",
    });
    expect(calls).toEqual([
      {
        cmd: "fetch_dm_thread",
        args: {
          withPersonUid: "prs_ada",
          limit: 50,
          cursor: "eyJwayI6IngifQ==",
          view: "human",
        },
      },
    ]);
  });

  it("DM thread without view: the native command, unchanged", async () => {
    const { calls, invoke } = nativeInvoke({ messages: [] });
    const adapter = createSyncPlatformAdapter({ invoke });
    await adapter.messaging.fetchDmThread({ withPersonUid: "prs_ada", limit: 50 });
    expect(calls).toEqual([
      { cmd: "fetch_dm_thread", args: { withPersonUid: "prs_ada", limit: 50 } },
    ]);
  });
});

describe("TauriPlatformAdapter: history requests with view=human", () => {
  it("channel and DM view requests pass view (and the DM cursor) to the native commands", async () => {
    const { calls, invoke } = recordingInvoke();
    const adapter = new TauriPlatformAdapter({ invoke });
    await adapter.messaging.fetchChannel({
      channelId: "chn_ops",
      limit: 50,
      view: "human",
    });
    await adapter.messaging.fetchDmThread({
      withPersonUid: "prs_ada",
      limit: 50,
      cursor: "abc",
      view: "human",
    });
    expect(calls).toEqual([
      {
        cmd: "fetch_channel",
        args: { channelId: "chn_ops", limit: 50, cursor: null, since: null, view: "human" },
      },
      {
        cmd: "fetch_dm_thread",
        args: {
          withPersonUid: "prs_ada",
          limit: 50,
          since: null,
          cursor: "abc",
          view: "human",
        },
      },
    ]);
  });

  it("requests without view are unchanged and carry no view key", async () => {
    const { calls, invoke } = recordingInvoke();
    const adapter = new TauriPlatformAdapter({ invoke });
    await adapter.messaging.fetchChannel({ channelId: "chn_ops", limit: 50 });
    await adapter.messaging.fetchDmThread({ withPersonUid: "prs_ada", limit: 50 });
    expect(calls).toEqual([
      {
        cmd: "fetch_channel",
        args: { channelId: "chn_ops", limit: 50, cursor: null, since: null },
      },
      {
        cmd: "fetch_dm_thread",
        args: { withPersonUid: "prs_ada", limit: 50, since: null },
      },
    ]);
  });
});

describe("WebPlatformAdapter: history requests with view=human", () => {
  function makeAdapter() {
    const paths: string[] = [];
    const fetchMock: typeof globalThis.fetch = async (input) => {
      paths.push(String(input).replace("https://api.test", ""));
      return new Response(JSON.stringify(HUMAN_PAGE), { status: 200 });
    };
    return {
      adapter: new WebPlatformAdapter({ baseUrl: "https://api.test", fetch: fetchMock }),
      paths,
    };
  }

  it("adds view=human to the channel and DM history URLs and returns the page as sent", async () => {
    const { adapter, paths } = makeAdapter();
    const channel = await adapter.messaging.fetchChannel({
      channelId: "chn_ops",
      limit: 50,
      cursor: "abc",
      view: "human",
    });
    await adapter.messaging.fetchDmThread({
      withPersonUid: "prs_ada",
      limit: 50,
      cursor: "abc",
      view: "human",
    });
    expect(paths).toEqual([
      "/v1/notify/channels/chn_ops/messages?limit=50&cursor=abc&view=human",
      "/v1/notify/thread?withPersonUid=prs_ada&limit=50&cursor=abc&view=human",
    ]);
    if (channel.ok) expect(channel.value).toEqual(HUMAN_PAGE);
  });

  it("sends no view parameter when the option is absent", async () => {
    const { adapter, paths } = makeAdapter();
    await adapter.messaging.fetchChannel({ channelId: "chn_ops", limit: 50 });
    await adapter.messaging.fetchDmThread({ withPersonUid: "prs_ada", limit: 50 });
    expect(paths).toEqual([
      "/v1/notify/channels/chn_ops/messages?limit=50",
      "/v1/notify/thread?withPersonUid=prs_ada&limit=50",
    ]);
  });
});
