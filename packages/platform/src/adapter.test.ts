import { describe, expect, it } from "vitest";
import {
  buildSendReplyRequest,
  normalizeNotificationsFeed,
  type AdapterResult,
  type PlatformAdapter,
} from "./adapter.js";
import { WebPlatformAdapter } from "./web/index.js";
import { TauriPlatformAdapter } from "./tauri/index.js";

// ---------------------------------------------------------------------------
// Fixtures: a canned backend "state" served identically by a mocked fetch
// (web) and a mocked invoke (tauri).
// ---------------------------------------------------------------------------

const WHOAMI = { personUid: "prs_123", email: "a@b.c" };
const CHANNELS = [{ id: "ch1", name: "general", unreadCount: 2 }];
const NOTIFICATIONS = {
  notifications: [
    {
      id: "n1",
      title: "hello",
      status: "unread",
      actionRef: "story-7",
    },
  ],
  unreadCount: 7,
  nextCursor: "opaque-next-page",
};

interface RecordedCall {
  key: string;
  args?: Record<string, unknown>;
}

function makeWebAdapter() {
  const calls: RecordedCall[] = [];
  const acked = new Set<string>();
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const path = url.replace("https://api.test", "");
    const method = init?.method ?? "GET";
    calls.push({ key: `${method} ${path}` });
    const respond = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200 });
    if (path === "/v1/identity/whoami") return respond(WHOAMI);
    if (path === "/v1/notify/channels" && method === "GET")
      return respond(CHANNELS);
    if (path.startsWith("/v1/notify/notifications?")) return respond(NOTIFICATIONS);
    if (path === "/v1/notify/notifications/ack" && method === "POST") {
      let id = "";
      try {
        const raw = init?.body ? String(init.body) : "";
        id = raw ? String((JSON.parse(raw) as { id?: unknown }).id ?? "") : "";
      } catch {
        id = "";
      }
      if (id) acked.add(id);
      return respond({ ok: true });
    }
    if (path === "/v1/notify/inbox") return respond({ events: [] });
    if (path === "/v1/files/shared-with-me") return respond({ events: [] });
    return new Response("not found", { status: 404 });
  };
  const adapter = new WebPlatformAdapter({
    baseUrl: "https://api.test",
    fetch: fetchMock,
  });
  return { adapter, calls, acked };
}

function makeTauriAdapter() {
  const calls: RecordedCall[] = [];
  const acked = new Set<string>();
  const invoke = async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ key: cmd, args });
    switch (cmd) {
      case "whoami":
        return WHOAMI;
      case "list_channels":
        return CHANNELS;
      case "fetch_notifications":
        return NOTIFICATIONS;
      case "ack_notification":
        acked.add(String(args?.id));
        return { ok: true };
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  };
  const adapter = new TauriPlatformAdapter({ invoke });
  return { adapter, calls, acked };
}

/** Runs the same call sequence against any adapter and returns outcomes. */
async function runContractSequence(adapter: PlatformAdapter) {
  const whoami = await adapter.identity.whoami();
  const channels = await adapter.messaging.listChannels();
  const notifications = await adapter.notifications.fetchNotifications({
    limit: 25,
    cursor: "opaque-next-page",
    unreadOnly: true,
  });
  const ack = await adapter.notifications.ack("n1");
  return { whoami, channels, notifications, ack };
}

function expectOk<T>(result: AdapterResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

describe("PlatformAdapter contract", () => {
  it("canonicalizes legacy read markers into the status consumed by the inbox", () => {
    const feed = normalizeNotificationsFeed([
      { id: "legacy-read", title: "already seen", readAt: "2026-09-01T00:00:00.000Z" },
      { id: "legacy-unread", title: "still new" },
    ]);

    expect(feed.unreadCount).toBe(1);
    expect(feed.notifications).toEqual([
      expect.objectContaining({ id: "legacy-read", read: true, status: "read" }),
      expect.objectContaining({ id: "legacy-unread", read: false, status: "unread" }),
    ]);
  });

  it("same call sequence produces equivalent state on web and tauri", async () => {
    const web = makeWebAdapter();
    const tauri = makeTauriAdapter();

    const webOut = await runContractSequence(web.adapter);
    const tauriOut = await runContractSequence(tauri.adapter);

    expect(expectOk(webOut.whoami)).toEqual(expectOk(tauriOut.whoami));
    expect(expectOk(webOut.channels)).toEqual(expectOk(tauriOut.channels));
    expect(expectOk(webOut.notifications)).toEqual(
      expectOk(tauriOut.notifications),
    );
    expect(webOut.ack.ok).toBe(true);
    expect(tauriOut.ack.ok).toBe(true);

    // Equivalent side-effect state on both backends.
    expect(web.acked).toEqual(tauri.acked);
    expect(web.acked.has("n1")).toBe(true);
    expect(expectOk(webOut.notifications)).toEqual({
      notifications: [
        expect.objectContaining({ id: "n1", actionRef: "story-7", read: false }),
      ],
      unreadCount: 7,
      nextCursor: "opaque-next-page",
    });
    expect(web.calls.map(({ key }) => key)).toContain(
      "GET /v1/notify/notifications?limit=25&cursor=opaque-next-page&unreadOnly=true",
    );
    expect(tauri.calls.find(({ key }) => key === "fetch_notifications")?.args).toEqual({
      limit: 25,
      cursor: "opaque-next-page",
      unreadOnly: true,
    });
  });

  it("desktop-only capabilities on web return the unavailable state, not a throw", async () => {
    const { adapter } = makeWebAdapter();

    const results = await Promise.all([
      adapter.sync.startDaemon(),
      adapter.sync.getSyncStatus(),
      adapter.shell.openInEditor("/tmp/x"),
      adapter.files.revealInFinder("/tmp/x"),
      adapter.marketplace.installPack({ id: "p1" }),
      adapter.updates.checkForUpdates(),
      adapter.updates.getVersions(),
      adapter.updates.checkCoreState(),
      adapter.packages.listPackages(),
      adapter.packages.listPackagesCached(),
      adapter.sessions.listAgentSessions(),
    ]);

    for (const r of results) {
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.reason).toBe("unavailable");
      expect(r.code).toBe("desktop-only");
    }
  });

  it("needs-new-API methods on web return unavailable with a distinguishing code", async () => {
    const { adapter } = makeWebAdapter();
    const r = await adapter.projects.listProjects();
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.reason).toBe("unavailable");
    expect(r.code).toBe("not-yet-implemented-api");
  });

  it("web adapter maps HTTP failures to the error state", async () => {
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async () => new Response("boom", { status: 500 }),
    });
    const r = await adapter.identity.whoami();
    expect(r).toMatchObject({ ok: false, reason: "error", code: "http-500" });
  });

  it("preserves owner-scoped project listing options in both web and Tauri adapters", async () => {
    const webRequests: string[] = [];
    const web = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async (input) => {
        webRequests.push(String(input));
        return new Response(JSON.stringify([]), { status: 200 });
      },
    });
    const tauriCalls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const tauri = new TauriPlatformAdapter({
      invoke: async (cmd, args) => {
        tauriCalls.push({ cmd, args });
        return [];
      },
    });

    const options = {
      companyUid: "cmp_indigo",
      includeCompanyProjects: true,
    };
    expectOk(await web.messaging.listChannels(options));
    expectOk(await tauri.messaging.listChannels(options));

    expect(webRequests).toEqual([
      "https://api.test/v1/notify/channels?companyUid=cmp_indigo&includeCompanyProjects=1",
    ]);
    expect(tauriCalls).toEqual([
      { cmd: "list_channels", args: options },
    ]);
  });

  it("uses the canonical channel-directory endpoint for unscoped web listings", async () => {
    const requests: string[] = [];
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify([]), { status: 200 });
      },
    });

    expectOk(await adapter.messaging.listChannels());
    expect(requests).toEqual(["https://api.test/v1/notify/channels"]);
  });

  it("web adapter notifies onUnauthorized on HTTP 401 so the host can re-login", async () => {
    const seen: number[] = [];
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async () =>
        new Response(JSON.stringify({ error: "Unauthenticated" }), {
          status: 401,
        }),
      onUnauthorized: () => {
        seen.push(1);
      },
    });
    const r = await adapter.identity.whoami();
    expect(seen).toEqual([1]);
    expect(r).toMatchObject({
      ok: false,
      reason: "error",
      code: "http-401",
      message: "Unauthenticated",
    });
  });

  it("tauri adapter maps invoke rejections to the error state", async () => {
    const adapter = new TauriPlatformAdapter({
      invoke: async () => {
        throw new Error("command failed");
      },
    });
    const r = await adapter.identity.whoami();
    expect(r).toMatchObject({
      ok: false,
      reason: "error",
      code: "invoke",
      message: "command failed",
    });
  });

  it("merges an authoritative desktop settings patch instead of replacing native preferences", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "get_settings") {
          return { hqPath: "/custom/HQ", autoUpdate: false, untouched: true };
        }
        if (command === "save_settings") return undefined;
        throw new Error(`unexpected command: ${command}`);
      },
    });

    expect((await adapter.settings.updateSettings({ autoUpdate: true })).ok).toBe(true);
    expect(calls).toEqual([
      { command: "get_settings", args: undefined },
      {
        command: "save_settings",
        args: {
          prefs: { hqPath: "/custom/HQ", autoUpdate: true, untouched: true },
        },
      },
    ]);
  });

  it("serializes concurrent native settings patches so neither field is lost", async () => {
    let persisted: Record<string, unknown> = {
      notifications: true,
      autoUpdate: true,
    };
    const adapter = new TauriPlatformAdapter({
      invoke: async (command, args) => {
        if (command === "get_settings") return { ...persisted };
        if (command === "save_settings") {
          await Promise.resolve();
          persisted = { ...((args?.prefs ?? {}) as Record<string, unknown>) };
          return undefined;
        }
        throw new Error(`unexpected command: ${command}`);
      },
    });

    const [notifications, updates] = await Promise.all([
      adapter.settings.updateSettings({ notifications: false }),
      adapter.settings.updateSettings({ autoUpdate: false }),
    ]);

    expect(notifications.ok).toBe(true);
    expect(updates.ok).toBe(true);
    expect(persisted).toMatchObject({ notifications: false, autoUpdate: false });
  });

  it("uses the Sync host command names and persists dock/widget preferences before applying them", async () => {
    let prefs: Record<string, unknown> = { dockIcon: true, widgetEnabled: true };
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "get_settings") return { ...prefs };
        if (command === "save_settings") {
          prefs = { ...((args?.prefs ?? {}) as Record<string, unknown>) };
          return undefined;
        }
        if (
          command === "apply_dock_icon" ||
          command === "apply_widget_settings" ||
          command === "set_autostart_enabled" ||
          command === "notification_request_permission" ||
          command === "set_hq_cli_update_dismissed"
        ) {
          return command === "notification_request_permission" ? "denied" : undefined;
        }
        if (command === "check_hq_cli_update") return { latest: "1.2.3" };
        throw new Error(`unknown Sync command: ${command}`);
      },
    });

    expect((await adapter.appShell.setDockVisible(false)).ok).toBe(true);
    expect((await adapter.appShell.setDesktopWidget(false)).ok).toBe(true);
    expect((await adapter.appShell.setAutostart(false)).ok).toBe(true);
    expect(await adapter.appShell.requestNotificationPermission()).toMatchObject({
      ok: true,
      value: "denied",
    });
    expect((await adapter.updates.dismissCliUpdate()).ok).toBe(true);
    expect(prefs).toMatchObject({ dockIcon: false, widgetEnabled: false });
    expect(calls).toContainEqual({ command: "apply_dock_icon", args: undefined });
    expect(calls).toContainEqual({ command: "apply_widget_settings", args: undefined });
    expect(calls).toContainEqual({ command: "set_autostart_enabled", args: { enabled: false } });
    expect(calls).toContainEqual({ command: "notification_request_permission", args: undefined });
    expect(calls).toContainEqual({
      command: "set_hq_cli_update_dismissed",
      args: { version: "1.2.3" },
    });
  });

  it("desktop toggleReaction routes through hq_pro_fetch (POST add / DELETE remove), never a toggle_reaction command", async () => {
    // Regression: the desktop adapter used to invoke a `toggle_reaction`
    // command that was never registered in Rust, so every toggle threw and the
    // optimistic reaction was reverted — you could not add or remove a reaction.
    // It now mirrors the web adapter against /v1/notify/reactions.
    const seen: { method: unknown; url: unknown; body: unknown }[] = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (cmd, args) => {
        if (cmd !== "hq_pro_fetch") {
          throw new Error(`unexpected command: ${cmd}`);
        }
        seen.push({ method: args?.method, url: args?.url, body: args?.body });
        return { status: 200, body: JSON.stringify({ ok: true }) };
      },
    });

    const add = await adapter.messaging.toggleReaction({
      messageScope: "dm:prs_jacob",
      messageId: "evt_1",
      emoji: "🎉",
      add: true,
    });
    const remove = await adapter.messaging.toggleReaction({
      messageScope: "dm:prs_jacob",
      messageId: "evt_1",
      emoji: "🎉",
      add: false,
    });

    expect(add.ok).toBe(true);
    expect(remove.ok).toBe(true);
    const body = JSON.stringify({
      messageScope: "dm:prs_jacob",
      messageId: "evt_1",
      emoji: "🎉",
    });
    expect(seen).toEqual([
      { method: "POST", url: "/v1/notify/reactions", body },
      { method: "DELETE", url: "/v1/notify/reactions", body },
    ]);
  });

  it("desktop fetchReactions GETs /v1/notify/reactions (regression: the old empty stub wiped optimistic reactions on the post-toggle reconcile)", async () => {
    const seen: { method: unknown; url: unknown }[] = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (cmd, args) => {
        if (cmd !== "hq_pro_fetch") {
          throw new Error(`unexpected command: ${cmd}`);
        }
        seen.push({ method: args?.method, url: args?.url });
        return {
          status: 200,
          body: JSON.stringify({
            reactions: [{ emoji: "🎉", count: 2, reactedByMe: true }],
          }),
        };
      },
    });

    const r = await adapter.messaging.fetchReactions("dm:prs_jacob", "evt_1");
    expect(expectOk(r)).toMatchObject({
      reactions: [{ emoji: "🎉", count: 2, reactedByMe: true }],
    });
    expect(seen).toEqual([
      {
        method: "GET",
        url: "/v1/notify/reactions?messageScope=dm%3Aprs_jacob&messageId=evt_1",
      },
    ]);
  });

  it("exposes capability flags with isAvailable helper", () => {
    const { adapter: web } = makeWebAdapter();
    const { adapter: tauri } = makeTauriAdapter();

    expect(web.kind).toBe("web");
    expect(tauri.kind).toBe("desktop");
    expect(web.isAvailable("canSync")).toBe(false);
    expect(web.isAvailable("localFiles")).toBe(false);
    expect(web.isAvailable("osNotifications")).toBe(true);
    expect(tauri.isAvailable("canSync")).toBe(true);
    expect(tauri.isAvailable("localFiles")).toBe(true);
    expect(tauri.isAvailable("agentLaunch")).toBe(true);
  });

  it("desktop adapter routes desktop-only methods through invoke", async () => {
    const invoked: string[] = [];
    const adapter = new TauriPlatformAdapter({
      invoke: async (cmd) => {
        invoked.push(cmd);
        return { running: true };
      },
    });
    const r = await adapter.sync.getSyncStatus();
    expect(expectOk(r)).toEqual({ running: true });
    expect(invoked).toEqual(["get_sync_status"]);
  });

  it("web sendDm POSTs /v1/notify/dm with toPersonUid, never /v1/notify/dm/{uid}", async () => {
    const seen: { method: string; path: string; body: unknown }[] = [];
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: async (input, init) => {
        const path = String(input).replace("https://api.test", "");
        seen.push({
          method: (init?.method ?? "GET").toUpperCase(),
          path,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(JSON.stringify({ eventId: "evt_1" }), {
          status: 200,
        });
      },
    });
    const person = await adapter.messaging.sendDm("prs_ada", "hi");
    const agent = await adapter.messaging.sendDm(
      "agt_01KTX6WQ6SYH3TZGF3DSDRPGD",
      "hello deacon",
    );
    expect(person.ok).toBe(true);
    expect(agent.ok).toBe(true);
    expect(seen).toEqual([
      {
        method: "POST",
        path: "/v1/notify/dm",
        body: { toPersonUid: "prs_ada", body: "hi" },
      },
      {
        method: "POST",
        path: "/v1/notify/dm",
        body: {
          toPersonUid: "agt_01KTX6WQ6SYH3TZGF3DSDRPGD",
          body: "hello deacon",
        },
      },
    ]);
  });

  it("buildSendReplyRequest includes mentions in the channel-scope body", () => {
    const mentions = [
      {
        participantUid: "prs_stefan",
        participantType: "human" as const,
        displayName: "Stefan Johnson",
        email: "stefan@getindigo.ai",
      },
    ];
    const req = buildSendReplyRequest({
      scope: "channel",
      rootEventId: "evt_root",
      body: "hey @Stefan Johnson",
      channelId: "chn_1",
      mentions,
    });
    expect(req.path).toBe("/v1/notify/channels/chn_1/messages");
    expect(req.body).toEqual({
      body: "hey @Stefan Johnson",
      rootEventId: "evt_root",
      mentions,
    });
  });
});
