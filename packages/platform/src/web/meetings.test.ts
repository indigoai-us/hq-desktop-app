import { describe, expect, it } from "vitest";

import { WebPlatformAdapter } from "./index.js";

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function makeAdapter(routes: Record<string, unknown>) {
  const calls: RecordedCall[] = [];
  const fetchMock: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const path = url.replace("https://api.test", "");
    const method = init?.method ?? "GET";
    let body: unknown = undefined;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    calls.push({ method, path, body });
    const key = `${method} ${path.split("?")[0]}`;
    if (!(key in routes)) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  };
  return {
    adapter: new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: fetchMock,
    }),
    calls,
  };
}

describe("WebPlatformAdapter meetings — V1 hq-pro routes", () => {
  it("unwraps calendar events, accounts, bots, and calendars", async () => {
    const { adapter, calls } = makeAdapter({
      "GET /v1/calendar/events": {
        events: [{ id: "evt-1", summary: "Standup", status: "confirmed" }],
      },
      "GET /v1/google/accounts": {
        accounts: [{ accountId: "acct_1", email: "a@b.c" }],
      },
      "GET /v1/bot/list": {
        bots: [{ botId: "bot-1", meetingUrl: "https://meet.google.com/x" }],
      },
      "GET /v1/calendar/calendars": {
        calendars: [{ id: "cal-1", summary: "Work" }],
        selectedCalendars: [{ id: "cal-1" }],
      },
      "GET /membership/me": {
        memberships: [
          {
            companyUid: "cmp_1",
            companyName: "Indigo",
            role: "owner",
            status: "active",
          },
        ],
      },
    });

    const upcoming = await adapter.meetings.listUpcoming();
    const accounts = await adapter.meetings.listAccounts();
    const bots = await adapter.meetings.listScheduledBots();
    const calendars = await adapter.meetings.listCalendars("acct_1");
    const members = await adapter.meetings.listMemberships();

    expect(upcoming.ok && upcoming.value).toEqual([
      { id: "evt-1", summary: "Standup", status: "confirmed" },
    ]);
    expect(accounts.ok && accounts.value).toEqual([
      { accountId: "acct_1", email: "a@b.c" },
    ]);
    expect(bots.ok && bots.value).toEqual([
      { botId: "bot-1", meetingUrl: "https://meet.google.com/x" },
    ]);
    expect(calendars.ok && calendars.value).toEqual({
      calendars: [{ id: "cal-1", summary: "Work" }],
      selectedCalendarIds: ["cal-1"],
    });
    expect(members.ok && members.value).toEqual([
      {
        companyUid: "cmp_1",
        companyName: "Indigo",
        role: "owner",
        status: "active",
      },
    ]);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /v1/calendar/events",
      "GET /v1/google/accounts",
      "GET /v1/bot/list",
      "GET /v1/calendar/calendars?accountId=acct_1",
      "GET /membership/me",
    ]);
  });

  it("invites and joins through /v1/bot/* with companyId on the query", async () => {
    const { adapter, calls } = makeAdapter({
      "POST /v1/bot/invite": { botId: "bot-1" },
      "POST /v1/bot/join-now": { botId: "bot-1", status: "joining" },
      "POST /v1/bot/bot-1/cancel": { cancelled: true },
    });

    const payload = {
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      calendarEventId: "evt-1",
      calendarSeriesId: null,
      companyId: "cmp_indigo",
    };
    await adapter.meetings.inviteBot(payload);
    await adapter.meetings.joinBotNow(payload);
    await adapter.meetings.cancelBot("bot-1");

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/bot/invite?companyId=cmp_indigo",
        body: {
          meetingUrl: "https://meet.google.com/abc-defg-hij",
          calendarEventId: "evt-1",
        },
      },
      {
        method: "POST",
        path: "/v1/bot/join-now?companyId=cmp_indigo",
        body: {
          meetingUrl: "https://meet.google.com/abc-defg-hij",
          calendarEventId: "evt-1",
        },
      },
      {
        method: "POST",
        path: "/v1/bot/bot-1/cancel",
        body: undefined,
      },
    ]);
  });

  it("does not invent a /v1/meetings/* facade", async () => {
    const { adapter, calls } = makeAdapter({});
    await adapter.meetings.listUpcoming();
    expect(calls[0]?.path).toBe("/v1/calendar/events");
    expect(calls[0]?.path.includes("/v1/meetings/")).toBe(false);
  });

  it("connectCalendar POSTs /v1/google/connect and returns the consent URL", async () => {
    const { adapter, calls } = makeAdapter({
      "POST /v1/google/connect": {
        url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
      },
    });

    const result = await adapter.meetings.connectCalendar();

    expect(result.ok && result.value).toEqual({
      url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
    });
    expect(calls).toEqual([
      { method: "POST", path: "/v1/google/connect", body: undefined },
    ]);
  });

  it("disconnectCalendar DELETEs /v1/google/accounts/{accountId}", async () => {
    const { adapter, calls } = makeAdapter({
      "DELETE /v1/google/accounts/acc_123": {
        deleted: true,
        accountId: "acc_123",
      },
    });

    const result = await adapter.meetings.disconnectCalendar("acc_123");

    expect(result.ok && result.value).toEqual({
      deleted: true,
      accountId: "acc_123",
    });
    expect(calls).toEqual([
      {
        method: "DELETE",
        path: "/v1/google/accounts/acc_123",
        body: undefined,
      },
    ]);
  });

  it("connectCalendar surfaces structured errors instead of throwing", async () => {
    const fetchMock: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "Unauthorized", code: "auth" }), {
        status: 401,
      });
    let unauthorized = 0;
    const adapter = new WebPlatformAdapter({
      baseUrl: "https://api.test",
      fetch: fetchMock,
      onUnauthorized: () => {
        unauthorized += 1;
      },
    });

    const result = await adapter.meetings.connectCalendar();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("error");
    expect(result.code).toBe("auth");
    expect(result.message).toBe("Unauthorized");
    expect(unauthorized).toBe(1);
  });
});
