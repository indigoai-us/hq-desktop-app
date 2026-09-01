// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ok, failure, type AdapterResult, type Json } from "@hq/platform";
import {
  botAttachmentState,
  rowButtonKind,
  type MeetingEvent,
  type ScheduledBot,
} from "./meetings-model";

const saveMeetingsCache = vi.hoisted(() => vi.fn());

vi.mock("./meetings-cache", () => ({
  loadMeetingsCache: vi.fn(() => null),
  saveMeetingsCache,
}));

import {
  configureMeetingsApi,
  meetingsStore,
  prefetchMeetings,
  startMeetingsStore,
  stopMeetingsStore,
} from "./meetings-store.svelte";
import { loadMeetingsCache } from "./meetings-cache";
import type { GoogleAccount } from "./meetings-model";
import {
  SETTINGS_PREFS_KEY,
  writeSettingsPrefs,
} from "../settings/settings-prefs";

// Fake-adapter dispatch: one mock, keyed by method name, so the assertions
// mirror the original invoke-keyed Tauri test.
const call =
  vi.fn<
    (method: string, payload?: unknown) => Promise<AdapterResult<unknown>>
  >();

function wireApi(options: { sessionGeneration?: number; storage?: Storage | null } = {}) {
  configureMeetingsApi({
    meetings: {
      listMemberships: () => call("listMemberships") as never,
      listUpcoming: () => call("listUpcoming") as never,
      listScheduledBots: () => call("listScheduledBots") as never,
      inviteBot: (payload: Json) => call("inviteBot", payload) as never,
      cancelBot: (id: string) => call("cancelBot", id) as never,
      joinBotNow: (payload: Json) => call("joinBotNow", payload) as never,
      listAccounts: () => call("listAccounts") as never,
      listCalendars: (account: string) =>
        call("listCalendars", account) as never,
      connectCalendar: () => call("connectCalendar") as never,
      disconnectCalendar: (accountId: string) =>
        call("disconnectCalendar", accountId) as never,
    },
    feedback: {
      submitBugReport: (title: string, body: string) =>
        call("submitBugReport", { title, body }) as never,
    },
    ...options,
  });
}

const planRequiredFailure = failure(
  "http-402",
  'bot/invite HTTP 402: {"requiredPlan":"agents-500","code":"MEETING_PLAN_REQUIRED"}',
);
const planRequiredToast = {
  kind: "warn" as const,
  text: "Meetings need the $500/mo Team plan—upgrade in HQ Console to record.",
};
const event: MeetingEvent = {
  id: "event-plan-required",
  summary: "Roadmap",
  status: "confirmed",
  start: { dateTime: "2026-07-29T17:00:00.000Z" },
  end: { dateTime: "2026-07-29T17:30:00.000Z" },
  meetingUrl: "https://meet.google.com/abc-defg-hij",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function expectPlanGateDoesNotCommitOrRefresh(
  action: () => Promise<unknown>,
  expectedMethod: string,
  expectedPayload: unknown,
) {
  const upcoming = deferred<AdapterResult<unknown>>();
  let upcomingCalls = 0;
  call.mockImplementation((method: string) => {
    if (method === "listUpcoming") {
      upcomingCalls += 1;
      return upcoming.promise;
    }
    if (
      method === "listMemberships" ||
      method === "listAccounts" ||
      method === "listScheduledBots"
    ) {
      return Promise.resolve(ok([]));
    }
    if (method === "inviteBot" || method === "joinBotNow") {
      return Promise.resolve(planRequiredFailure);
    }
    throw new Error(`Unexpected api call: ${method}`);
  });

  const poll = meetingsStore.refresh();
  expect(upcomingCalls).toBe(1);

  await expect(action()).resolves.toEqual(planRequiredToast);
  expect(call).toHaveBeenCalledWith(expectedMethod, expectedPayload);

  // The in-flight snapshot applies only if the denial did not call
  // markMutationCommitted(). A refresh would also queue a second poll.
  upcoming.resolve(ok([]));
  await poll;
  expect(upcomingCalls).toBe(1);
  expect(saveMeetingsCache).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  call.mockReset();
  saveMeetingsCache.mockReset();
  stopMeetingsStore();
  meetingsStore.stopCalendarConnectWatch();
  meetingsStore.clearConnectNotice();
  localStorage.removeItem(SETTINGS_PREFS_KEY);
  wireApi();
});

describe("meetings store refresh coordination", () => {
  it("withdraws a deferred account A agenda before account B can mount", async () => {
    const accountA = new Map<string, string>();
    const accountB = new Map<string, string>();
    const storage = (values: Map<string, string>) => ({
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: () => null,
      get length() {
        return values.size;
      },
    }) as Storage;
    const staleUpcoming = deferred<AdapterResult<unknown>>();
    call.mockImplementation((method: string) => {
      if (method === "listUpcoming") return staleUpcoming.promise;
      if (
        method === "listMemberships" ||
        method === "listAccounts" ||
        method === "listScheduledBots"
      ) {
        return Promise.resolve(ok([]));
      }
      throw new Error(`Unexpected api call: ${method}`);
    });

    wireApi({ sessionGeneration: 1, storage: storage(accountA) });
    const inFlight = meetingsStore.refresh();
    wireApi({ sessionGeneration: 2, storage: storage(accountB) });

    staleUpcoming.resolve(
      ok([
        {
          id: "meeting-a",
          summary: "Account A private planning",
          start: { dateTime: "2026-08-01T10:00:00.000Z" },
          end: { dateTime: "2026-08-01T10:30:00.000Z" },
        },
      ]),
    );
    await inFlight;

    expect(meetingsStore.events).toEqual([]);
    expect(saveMeetingsCache).not.toHaveBeenCalled();
  });

  it("shares a poll and queues a post-mutation refresh without committing stale data", async () => {
    const evt: MeetingEvent = {
      id: "event-1",
      summary: "Roadmap",
      status: "confirmed",
      start: { dateTime: "2026-07-29T17:00:00.000Z" },
      end: { dateTime: "2026-07-29T17:30:00.000Z" },
      meetingUrl: "https://meet.google.com/abc-defg-hij",
    };
    const bot: ScheduledBot = {
      botId: "bot-1",
      meetingUrl: evt.meetingUrl!,
      platform: "google_meet",
      status: "scheduled",
      calendarEventId: evt.id,
      autoScheduled: false,
    };
    const staleUpcoming = deferred<AdapterResult<unknown>>();
    let upcomingCalls = 0;

    call.mockImplementation((method: string) => {
      if (method === "listUpcoming") {
        upcomingCalls += 1;
        return upcomingCalls === 1
          ? staleUpcoming.promise
          : Promise.resolve(ok([evt]));
      }
      if (method === "listMemberships" || method === "listAccounts") {
        return Promise.resolve(ok([]));
      }
      if (method === "listScheduledBots") {
        return Promise.resolve(ok(upcomingCalls >= 2 ? [bot] : []));
      }
      if (method === "inviteBot") return Promise.resolve(ok(bot));
      throw new Error(`Unexpected api call: ${method}`);
    });

    const poll = meetingsStore.refresh();
    expect(meetingsStore.refresh()).toBe(poll);

    let mutationSettled = false;
    const mutation = meetingsStore.inviteBot(evt).then((result) => {
      mutationSettled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(upcomingCalls).toBe(1);
    expect(mutationSettled).toBe(false);
    expect(saveMeetingsCache).not.toHaveBeenCalled();

    staleUpcoming.resolve(ok([]));
    await expect(mutation).resolves.toEqual({
      kind: "info",
      text: "Bot invited.",
    });
    await poll;

    expect(upcomingCalls).toBe(2);
    expect(meetingsStore.events).toEqual([evt]);
    expect(meetingsStore.botsByEventId.get(evt.id)).toEqual(bot);
    // The stale pass was discarded; only the authoritative trailing snapshot
    // reached the cache.
    expect(saveMeetingsCache).toHaveBeenCalledTimes(1);
  });
});

describe("meetings store recording-company attribution", () => {
  const memberUid = "co_mine";
  const foreignUid = "co_foreign";
  const baseEvent: MeetingEvent = {
    id: "event-attr",
    summary: "Standup",
    status: "confirmed",
    start: { dateTime: "2026-07-29T17:00:00.000Z" },
    end: { dateTime: "2026-07-29T17:30:00.000Z" },
    meetingUrl: "https://meet.google.com/abc-defg-hij",
  };

  async function seedMemberships(
    members: Array<{ companyUid: string; companyName: string; status: string }>,
  ) {
    call.mockImplementation((method: string) => {
      if (method === "listUpcoming") return Promise.resolve(ok([]));
      if (method === "listMemberships") return Promise.resolve(ok(members));
      if (method === "listAccounts") return Promise.resolve(ok([]));
      if (method === "listScheduledBots") return Promise.resolve(ok([]));
      if (method === "inviteBot" || method === "joinBotNow") {
        return Promise.resolve(ok({ botId: "bot-1" }));
      }
      throw new Error(`Unexpected api call: ${method}`);
    });
    await meetingsStore.refresh(true);
    expect(meetingsStore.companyNamesByUid.has(memberUid)).toBe(
      members.some((m) => m.companyUid === memberUid),
    );
  }

  it("attributes inviteBot to the settings recording company when the event has none", async () => {
    await seedMemberships([
      { companyUid: memberUid, companyName: "Mine", status: "active" },
    ]);
    writeSettingsPrefs({ recordingCompanyId: memberUid });

    await meetingsStore.inviteBot(baseEvent);

    expect(call).toHaveBeenCalledWith("inviteBot", {
      meetingUrl: baseEvent.meetingUrl,
      calendarEventId: baseEvent.id,
      calendarSeriesId: null,
      companyId: memberUid,
    });
  });

  it("lets the event sourceCompanyUid win over the settings default", async () => {
    await seedMemberships([
      { companyUid: memberUid, companyName: "Mine", status: "active" },
    ]);
    writeSettingsPrefs({ recordingCompanyId: memberUid });
    const withCompany: MeetingEvent = {
      ...baseEvent,
      sourceCompanyUid: "co_event",
    };

    await meetingsStore.inviteBot(withCompany);

    expect(call).toHaveBeenCalledWith("inviteBot", {
      meetingUrl: withCompany.meetingUrl,
      calendarEventId: withCompany.id,
      calendarSeriesId: null,
      companyId: "co_event",
    });
  });

  it("does not leak a foreign/stale recordingCompanyId into the invite payload", async () => {
    await seedMemberships([
      { companyUid: memberUid, companyName: "Mine", status: "active" },
    ]);
    writeSettingsPrefs({ recordingCompanyId: foreignUid });

    await meetingsStore.inviteBot(baseEvent);

    expect(call).toHaveBeenCalledWith("inviteBot", {
      meetingUrl: baseEvent.meetingUrl,
      calendarEventId: baseEvent.id,
      calendarSeriesId: null,
      companyId: null,
    });
  });

  it("applies the same attribution rules to joinBotNow", async () => {
    await seedMemberships([
      { companyUid: memberUid, companyName: "Mine", status: "active" },
    ]);
    writeSettingsPrefs({ recordingCompanyId: memberUid });

    await meetingsStore.joinBotNow(baseEvent);

    expect(call).toHaveBeenCalledWith("joinBotNow", {
      meetingUrl: baseEvent.meetingUrl,
      calendarEventId: baseEvent.id,
      calendarSeriesId: null,
      companyId: memberUid,
    });
  });
});

describe("meetings store bot dispatch (US-005)", () => {
  const companyId = "co_dispatch";
  const now = Date.now();
  const ongoingEvent: MeetingEvent = {
    id: "event-live-1",
    summary: "Live standup",
    status: "confirmed",
    start: { dateTime: new Date(now - 5 * 60_000).toISOString() },
    end: { dateTime: new Date(now + 25 * 60_000).toISOString() },
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    recurringEventId: "series-live-1",
    sourceCompanyUid: companyId,
  };

  function mockDispatchHappyPath(opts: {
    joinBot?: ScheduledBot;
    urlBot?: ScheduledBot;
  }) {
    call.mockImplementation((method: string) => {
      if (method === "listUpcoming") {
        return Promise.resolve(ok([ongoingEvent]));
      }
      if (method === "listMemberships") {
        return Promise.resolve(
          ok([
            {
              companyUid: companyId,
              companyName: "Dispatch Co",
              status: "active",
            },
          ]),
        );
      }
      if (method === "listAccounts") return Promise.resolve(ok([]));
      if (method === "listScheduledBots") {
        const bots = [opts.joinBot, opts.urlBot].filter(
          (b): b is ScheduledBot => b != null,
        );
        return Promise.resolve(ok(bots));
      }
      if (method === "joinBotNow" || method === "inviteBot") {
        return Promise.resolve(ok({ botId: "bot-dispatch-1" }));
      }
      throw new Error(`Unexpected api call: ${method}`);
    });
  }

  it("joinBotNow sends the hq-pro payload and transitions the row to joining", async () => {
    const joiningBot: ScheduledBot = {
      botId: "bot-join-now-1",
      meetingUrl: ongoingEvent.meetingUrl!,
      platform: "google_meet",
      status: "joining",
      calendarEventId: ongoingEvent.id,
      calendarSeriesId: "series-live-1",
      autoScheduled: false,
    };

    // First refresh: calendar connected, no bot yet.
    mockDispatchHappyPath({});
    await meetingsStore.refresh(true);
    expect(meetingsStore.events.some((e) => e.id === ongoingEvent.id)).toBe(
      true,
    );
    expect(meetingsStore.botsByEventId.get(ongoingEvent.id)).toBeUndefined();
    expect(rowButtonKind(undefined)).toBe("invite");

    // After join-now, the trailing refresh returns the joining bot.
    mockDispatchHappyPath({ joinBot: joiningBot });
    const toast = await meetingsStore.joinBotNow(ongoingEvent);

    expect(call).toHaveBeenCalledWith("joinBotNow", {
      meetingUrl: ongoingEvent.meetingUrl,
      calendarEventId: ongoingEvent.id,
      calendarSeriesId: "series-live-1",
      companyId,
    });
    expect(toast).toEqual({ kind: "info", text: "Bot's on the way." });

    const attached = meetingsStore.botsByEventId.get(ongoingEvent.id);
    expect(attached).toEqual(joiningBot);
    expect(rowButtonKind(attached)).toBe("joining");
    expect(botAttachmentState(attached)).toBe("joining");
  });

  it("inviteBotByUrl posts { meetingUrl, companyId } with null calendar ids and surfaces the bot", async () => {
    const adHocUrl = "https://meet.google.com/xyz-uvwx-rst";
    const invitedBot: ScheduledBot = {
      botId: "bot-adhoc-1",
      meetingUrl: adHocUrl,
      platform: "google_meet",
      status: "scheduled",
      calendarEventId: null,
      calendarSeriesId: null,
      autoScheduled: false,
    };

    mockDispatchHappyPath({});
    await meetingsStore.refresh(true);

    mockDispatchHappyPath({ urlBot: invitedBot });
    const toast = await meetingsStore.inviteBotByUrl(adHocUrl, companyId);

    expect(call).toHaveBeenCalledWith("inviteBot", {
      meetingUrl: adHocUrl,
      calendarEventId: null,
      calendarSeriesId: null,
      companyId,
    });
    expect(toast).toEqual({
      kind: "info",
      text: "Bot invited — meeting will save to Dispatch Co.",
    });

    const surfaced = meetingsStore.scheduledBots.find(
      (b) => b.botId === invitedBot.botId,
    );
    expect(surfaced).toEqual(invitedBot);
    expect(rowButtonKind(surfaced)).toBe("invited");
    expect(botAttachmentState(surfaced)).toBe("invited");
  });

  it("inviteBotByUrl accepts bare zoom.us URLs and surfaces a recording bot on refresh", async () => {
    // Regression: isPlausibleMeetingUrl used to require a region subdomain
    // (`*.zoom.us`), so a bare `https://zoom.us/j/…` paste silently no-op'd.
    const adHocUrl = "https://zoom.us/j/12345678901";
    const recordingBot: ScheduledBot = {
      botId: "bot-adhoc-rec",
      meetingUrl: adHocUrl,
      platform: "zoom",
      status: "recording",
      calendarEventId: null,
      calendarSeriesId: null,
      autoScheduled: false,
    };

    mockDispatchHappyPath({});
    await meetingsStore.refresh(true);

    mockDispatchHappyPath({ urlBot: recordingBot });
    const toast = await meetingsStore.inviteBotByUrl(adHocUrl, companyId);

    expect(call).toHaveBeenCalledWith("inviteBot", {
      meetingUrl: adHocUrl,
      calendarEventId: null,
      calendarSeriesId: null,
      companyId,
    });
    expect(toast?.kind).toBe("info");
    const surfaced = meetingsStore.scheduledBots.find(
      (b) => b.botId === recordingBot.botId,
    );
    expect(rowButtonKind(surfaced)).toBe("in-call");
    expect(botAttachmentState(surfaced)).toBe("recording");
  });
});

describe("meetings store Team-plan gate", () => {
  it("returns the plan warning without committing or refreshing for a row invite", async () => {
    await expectPlanGateDoesNotCommitOrRefresh(
      () => meetingsStore.inviteBot(event),
      "inviteBot",
      {
        meetingUrl: event.meetingUrl,
        calendarEventId: event.id,
        calendarSeriesId: null,
        companyId: null,
      },
    );
  });

  it("returns the plan warning without committing or refreshing for a URL invite", async () => {
    await expectPlanGateDoesNotCommitOrRefresh(
      () => meetingsStore.inviteBotByUrl(event.meetingUrl!, "company-1"),
      "inviteBot",
      {
        meetingUrl: event.meetingUrl,
        calendarEventId: null,
        calendarSeriesId: null,
        companyId: "company-1",
      },
    );
  });

  it("returns the plan warning without committing or refreshing for join now", async () => {
    await expectPlanGateDoesNotCommitOrRefresh(
      () => meetingsStore.joinBotNow(event),
      "joinBotNow",
      {
        meetingUrl: event.meetingUrl,
        calendarEventId: event.id,
        calendarSeriesId: null,
        companyId: null,
      },
    );
  });
});

describe("meetings store in-app calendar connect", () => {
  const consentUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?state=test-connect";
  const newAccount: GoogleAccount = {
    accountId: "acct-google-1",
    email: "you@example.com",
  };

  function mockConnectHappyPath(opts?: {
    accountsAfter?: GoogleAccount[];
    listAccountsImpl?: () => Promise<AdapterResult<unknown>>;
  }) {
    const accountsAfter = opts?.accountsAfter ?? [newAccount];
    call.mockImplementation((method: string) => {
      if (method === "connectCalendar") {
        return Promise.resolve(ok({ url: consentUrl }));
      }
      if (method === "listAccounts") {
        if (opts?.listAccountsImpl) return opts.listAccountsImpl();
        return Promise.resolve(ok(accountsAfter));
      }
      if (
        method === "listMemberships" ||
        method === "listUpcoming" ||
        method === "listScheduledBots"
      ) {
        return Promise.resolve(ok([]));
      }
      if (method === "listCalendars") {
        return Promise.resolve(
          ok({
            calendars: [{ id: "cal-1", summary: "Primary", primary: true }],
            selectedCalendarIds: ["cal-1"],
          }),
        );
      }
      throw new Error(`Unexpected api call: ${method}`);
    });
  }

  it("calls connectCalendar and returns the consent url when no calendar is connected", async () => {
    mockConnectHappyPath({
      listAccountsImpl: () => Promise.resolve(ok([])),
    });

    const result = await meetingsStore.beginCalendarConnect();

    expect(call).toHaveBeenCalledWith("connectCalendar");
    expect(result).toEqual({
      url: consentUrl,
      toast: {
        kind: "info",
        text: "Finish connecting in your browser…",
      },
    });
    expect(meetingsStore.connectPending).toBe(true);

    meetingsStore.stopCalendarConnectWatch();
  });

  it("surfaces a warn toast and stays re-connectable when connectCalendar fails", async () => {
    call.mockImplementation((method: string) => {
      if (method === "connectCalendar") {
        return Promise.resolve(failure("http-401", "Unauthorized"));
      }
      throw new Error(`Unexpected api call: ${method}`);
    });

    const result = await meetingsStore.beginCalendarConnect();

    expect(result.url).toBeNull();
    expect(result.toast?.kind).toBe("warn");
    expect(meetingsStore.connectPending).toBe(false);
  });

  it("adds the new Google account after consent when the connect poll fires", async () => {
    vi.useFakeTimers();
    try {
      let accountPolls = 0;
      mockConnectHappyPath({
        listAccountsImpl: () => {
          accountPolls += 1;
          // Call 1 = live baseline in beginCalendarConnect; early polls stay
          // empty; later polls return the newly linked account.
          if (accountPolls < 3) return Promise.resolve(ok([]));
          return Promise.resolve(ok([newAccount]));
        },
      });

      const started = await meetingsStore.beginCalendarConnect();
      expect(started.url).toBe(consentUrl);
      expect(meetingsStore.connectPending).toBe(true);
      expect(meetingsStore.accounts).toEqual([]);

      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(3_000);
      // Allow the refresh kicked off on success to settle.
      await Promise.resolve();
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();

      expect(meetingsStore.connectPending).toBe(false);
      expect(meetingsStore.accounts).toEqual([newAccount]);
      expect(meetingsStore.connectNotice).toEqual({
        kind: "info",
        text: "Calendar connected.",
      });
      expect(accountPolls).toBeGreaterThanOrEqual(3);
    } finally {
      meetingsStore.stopCalendarConnectWatch();
      vi.useRealTimers();
    }
  });

  it("baselines connect watch from live listAccounts when store accounts are empty", async () => {
    vi.useFakeTimers();
    try {
      // Clear any accounts left by prior tests — Settings-before-Meetings path
      // has an empty store while the backend already has a linked account.
      mockConnectHappyPath({
        listAccountsImpl: () => Promise.resolve(ok([])),
      });
      await meetingsStore.refresh(true);
      expect(meetingsStore.accounts).toEqual([]);

      const existing: GoogleAccount = {
        accountId: "acct-already-linked",
        email: "existing@example.com",
      };
      let listCalls = 0;
      mockConnectHappyPath({
        listAccountsImpl: () => {
          listCalls += 1;
          // Baseline + early polls: only the pre-existing account.
          if (listCalls < 4) return Promise.resolve(ok([existing]));
          return Promise.resolve(ok([existing, newAccount]));
        },
      });

      const started = await meetingsStore.beginCalendarConnect();
      expect(started.url).toBe(consentUrl);
      expect(meetingsStore.connectPending).toBe(true);
      // Baseline fetch must have happened (not the stale empty store).
      expect(listCalls).toBeGreaterThanOrEqual(1);

      // First poll(s) still only see the pre-existing account — must NOT
      // falsely report connected.
      await vi.advanceTimersByTimeAsync(3_000);
      await Promise.resolve();
      await Promise.resolve();
      expect(meetingsStore.connectPending).toBe(true);
      expect(meetingsStore.connectNotice).toBeNull();
      expect(meetingsStore.accounts).toEqual([]);

      // A genuinely new account id on a later poll completes the watch.
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.advanceTimersByTimeAsync(3_000);
      await Promise.resolve();
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();

      expect(meetingsStore.connectPending).toBe(false);
      expect(meetingsStore.connectNotice).toEqual({
        kind: "info",
        text: "Calendar connected.",
      });
      expect(meetingsStore.accounts.map((a) => a.accountId)).toContain(
        newAccount.accountId,
      );
    } finally {
      meetingsStore.stopCalendarConnectWatch();
      vi.useRealTimers();
    }
  });

  it("discards connect polls that resolve after the watch has ended", async () => {
    vi.useFakeTimers();
    try {
      mockConnectHappyPath({
        listAccountsImpl: () => Promise.resolve(ok([])),
      });
      await meetingsStore.refresh(true);
      expect(meetingsStore.accounts).toEqual([]);

      const pendingList = deferred<AdapterResult<unknown>>();
      let listCalls = 0;
      mockConnectHappyPath({
        listAccountsImpl: () => {
          listCalls += 1;
          // Live baseline is empty; the first poll hangs until we resolve it
          // after the watch finishes.
          if (listCalls === 1) return Promise.resolve(ok([]));
          return pendingList.promise;
        },
      });

      await meetingsStore.beginCalendarConnect();
      expect(meetingsStore.connectPending).toBe(true);

      // Kick a poll, then end the watch (deadline / open-failed / replaced).
      await vi.advanceTimersByTimeAsync(3_000);
      meetingsStore.stopCalendarConnectWatch();
      expect(meetingsStore.connectPending).toBe(false);
      meetingsStore.clearConnectNotice();
      expect(meetingsStore.connectNotice).toBeNull();

      // Late resolution must not fire "Calendar connected" or restart a watch.
      pendingList.resolve(ok([newAccount]));
      await Promise.resolve();
      await Promise.resolve();
      await vi.runOnlyPendingTimersAsync();

      expect(meetingsStore.connectPending).toBe(false);
      expect(meetingsStore.connectNotice).toBeNull();
      expect(meetingsStore.accounts).toEqual([]);
    } finally {
      meetingsStore.stopCalendarConnectWatch();
      vi.useRealTimers();
    }
  });

  it("stops the connect watch when the page aborts after a blocked/failed open", async () => {
    // Fix 4 (web popup blocked): page catch calls stopCalendarConnectWatch so
    // we do not keep polling with a misleading "finish in browser" notice.
    // Manual check: allow-popups off → Connect calendar → warn, re-connectable.
    mockConnectHappyPath({
      listAccountsImpl: () => Promise.resolve(ok([])),
    });

    const started = await meetingsStore.beginCalendarConnect();
    expect(started.url).toBe(consentUrl);
    expect(meetingsStore.connectPending).toBe(true);

    meetingsStore.stopCalendarConnectWatch();
    expect(meetingsStore.connectPending).toBe(false);
    expect(meetingsStore.connectNotice).toBeNull();

    const again = await meetingsStore.beginCalendarConnect();
    expect(again.url).toBe(consentUrl);
    expect(meetingsStore.connectPending).toBe(true);
    meetingsStore.stopCalendarConnectWatch();
  });

  it("stops the connect poll at the 2-minute bound with a re-connectable warn", async () => {
    vi.useFakeTimers();
    try {
      mockConnectHappyPath({
        listAccountsImpl: () => Promise.resolve(ok([])),
      });

      await meetingsStore.beginCalendarConnect();
      expect(meetingsStore.connectPending).toBe(true);

      await vi.advanceTimersByTimeAsync(120_000);

      expect(meetingsStore.connectPending).toBe(false);
      expect(meetingsStore.connectNotice).toEqual({
        kind: "warn",
        text: "No new calendar connected — try again if you cancelled.",
      });
      // Re-connectable: a second beginCalendarConnect is allowed.
      call.mockClear();
      mockConnectHappyPath({
        listAccountsImpl: () => Promise.resolve(ok([])),
      });
      const again = await meetingsStore.beginCalendarConnect();
      expect(again.url).toBe(consentUrl);
      expect(meetingsStore.connectPending).toBe(true);
    } finally {
      meetingsStore.stopCalendarConnectWatch();
      vi.useRealTimers();
    }
  });

  it("clears a queued calendar-connect notice when the tenant session changes", async () => {
    vi.useFakeTimers();
    try {
      mockConnectHappyPath({
        listAccountsImpl: () => Promise.resolve(ok([])),
      });
      await meetingsStore.beginCalendarConnect();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(meetingsStore.connectNotice).toEqual({
        kind: "warn",
        text: "No new calendar connected — try again if you cancelled.",
      });

      wireApi({
        sessionGeneration: 2,
        storage: localStorage,
      });

      expect(meetingsStore.connectNotice).toBeNull();
    } finally {
      meetingsStore.stopCalendarConnectWatch();
      vi.useRealTimers();
    }
  });
});

describe("meetings store per-account calendar disconnect", () => {
  const account: GoogleAccount = {
    accountId: "acct-google-1",
    email: "you@example.com",
  };
  const otherAccount: GoogleAccount = {
    accountId: "acct-google-2",
    email: "other@example.com",
  };

  function mockConnectedAccounts(accountsNow: GoogleAccount[]) {
    call.mockImplementation((method: string, payload?: unknown) => {
      if (method === "disconnectCalendar") {
        return Promise.resolve(ok({ deleted: true, accountId: payload }));
      }
      if (method === "listAccounts") {
        return Promise.resolve(ok(accountsNow));
      }
      if (
        method === "listMemberships" ||
        method === "listUpcoming" ||
        method === "listScheduledBots"
      ) {
        return Promise.resolve(ok([]));
      }
      if (method === "listCalendars") {
        return Promise.resolve(
          ok({
            calendars: [{ id: "cal-1", summary: "Primary", primary: true }],
            selectedCalendarIds: ["cal-1"],
          }),
        );
      }
      throw new Error(`Unexpected api call: ${method}`);
    });
  }

  async function seedAccounts(initial: GoogleAccount[]) {
    mockConnectedAccounts(initial);
    await meetingsStore.refresh(true);
    expect(meetingsStore.accounts).toEqual(initial);
  }

  it("calls disconnectCalendar and removes the account after refresh when confirmed", async () => {
    await seedAccounts([account, otherAccount]);
    mockConnectedAccounts([otherAccount]);

    const result = await meetingsStore.disconnectCalendar(account.accountId);

    expect(call).toHaveBeenCalledWith("disconnectCalendar", account.accountId);
    expect(result).toEqual({
      kind: "info",
      text: "Calendar disconnected.",
    });
    expect(meetingsStore.accounts).toEqual([otherAccount]);
    expect(meetingsStore.calendarsByAccount.has(account.accountId)).toBe(false);
  });

  it("optimistically drops the account row before disconnectCalendar resolves", async () => {
    await seedAccounts([account, otherAccount]);
    const disconnect = deferred<AdapterResult<unknown>>();
    call.mockImplementation((method: string) => {
      if (method === "disconnectCalendar") return disconnect.promise;
      if (method === "listAccounts") {
        return Promise.resolve(ok([otherAccount]));
      }
      if (
        method === "listMemberships" ||
        method === "listUpcoming" ||
        method === "listScheduledBots"
      ) {
        return Promise.resolve(ok([]));
      }
      if (method === "listCalendars") {
        return Promise.resolve(
          ok({
            calendars: [{ id: "cal-1", summary: "Primary", primary: true }],
            selectedCalendarIds: ["cal-1"],
          }),
        );
      }
      throw new Error(`Unexpected api call: ${method}`);
    });

    const pending = meetingsStore.disconnectCalendar(account.accountId);
    await Promise.resolve();

    expect(meetingsStore.accounts).toEqual([otherAccount]);
    expect(meetingsStore.calendarsByAccount.has(account.accountId)).toBe(false);
    expect(
      meetingsStore.disconnectPendingByAccountId.has(account.accountId),
    ).toBe(true);

    disconnect.resolve(ok({ deleted: true, accountId: account.accountId }));
    await expect(pending).resolves.toEqual({
      kind: "info",
      text: "Calendar disconnected.",
    });
    expect(
      meetingsStore.disconnectPendingByAccountId.has(account.accountId),
    ).toBe(false);
  });

  it("rolls back the account row and returns a warn toast when disconnect fails", async () => {
    await seedAccounts([account]);
    call.mockImplementation((method: string) => {
      if (method === "disconnectCalendar") {
        return Promise.resolve(failure("http-500", "revoke failed"));
      }
      if (
        method === "listMemberships" ||
        method === "listUpcoming" ||
        method === "listScheduledBots" ||
        method === "listAccounts"
      ) {
        return Promise.resolve(ok(method === "listAccounts" ? [account] : []));
      }
      if (method === "listCalendars") {
        return Promise.resolve(
          ok({
            calendars: [{ id: "cal-1", summary: "Primary", primary: true }],
            selectedCalendarIds: ["cal-1"],
          }),
        );
      }
      throw new Error(`Unexpected api call: ${method}`);
    });

    // Re-seed after remock so calendars exist for rollback comparison.
    await meetingsStore.refresh(true);
    expect(meetingsStore.accounts).toEqual([account]);
    expect(
      meetingsStore.calendarsByAccount.get(account.accountId)?.length,
    ).toBe(1);

    const result = await meetingsStore.disconnectCalendar(account.accountId);

    expect(call).toHaveBeenCalledWith("disconnectCalendar", account.accountId);
    expect(result?.kind).toBe("warn");
    expect(result?.text.length).toBeGreaterThan(0);
    expect(meetingsStore.accounts).toEqual([account]);
    expect(
      meetingsStore.calendarsByAccount.get(account.accountId)?.length,
    ).toBe(1);
  });

  it("returns the empty not-connected state after disconnecting the last account", async () => {
    await seedAccounts([account]);
    mockConnectedAccounts([]);

    const result = await meetingsStore.disconnectCalendar(account.accountId);

    expect(result?.kind).toBe("info");
    expect(meetingsStore.accounts).toEqual([]);
    expect(meetingsStore.calendarsByAccount.size).toBe(0);
  });

  it("rolls back only the failed disconnect without resurrecting a peer that already succeeded", async () => {
    await seedAccounts([account, otherAccount]);

    const disconnectA = deferred<AdapterResult<unknown>>();
    const disconnectB = deferred<AdapterResult<unknown>>();
    call.mockImplementation((method: string, payload?: unknown) => {
      if (method === "disconnectCalendar") {
        if (payload === account.accountId) return disconnectA.promise;
        if (payload === otherAccount.accountId) return disconnectB.promise;
        throw new Error(`Unexpected disconnect: ${String(payload)}`);
      }
      if (method === "listAccounts") {
        // After B succeeds, server no longer has B (or A — A is mid-flight).
        return Promise.resolve(ok([]));
      }
      if (
        method === "listMemberships" ||
        method === "listUpcoming" ||
        method === "listScheduledBots"
      ) {
        return Promise.resolve(ok([]));
      }
      if (method === "listCalendars") {
        return Promise.resolve(
          ok({
            calendars: [{ id: "cal-1", summary: "Primary", primary: true }],
            selectedCalendarIds: ["cal-1"],
          }),
        );
      }
      throw new Error(`Unexpected api call: ${method}`);
    });

    const pendingA = meetingsStore.disconnectCalendar(account.accountId);
    const pendingB = meetingsStore.disconnectCalendar(otherAccount.accountId);
    await Promise.resolve();
    expect(meetingsStore.accounts).toEqual([]);

    // B succeeds and refreshes first.
    disconnectB.resolve(
      ok({ deleted: true, accountId: otherAccount.accountId }),
    );
    await expect(pendingB).resolves.toEqual({
      kind: "info",
      text: "Calendar disconnected.",
    });
    expect(meetingsStore.accounts).toEqual([]);
    expect(meetingsStore.calendarsByAccount.has(otherAccount.accountId)).toBe(
      false,
    );

    // A then fails — surgical rollback must restore A only, not resurrect B.
    disconnectA.resolve(failure("http-500", "revoke failed"));
    const resultA = await pendingA;
    expect(resultA?.kind).toBe("warn");
    expect(meetingsStore.accounts.map((a) => a.accountId)).toEqual([
      account.accountId,
    ]);
    expect(meetingsStore.calendarsByAccount.has(otherAccount.accountId)).toBe(
      false,
    );
    expect(meetingsStore.calendarsByAccount.has(account.accountId)).toBe(true);
  });
});

describe("meetings store launch prefetch + first-paint provenance (US-010)", () => {
  const okLists = () => {
    call.mockImplementation((method: string) => {
      if (
        method === "listUpcoming" ||
        method === "listMemberships" ||
        method === "listAccounts" ||
        method === "listScheduledBots"
      ) {
        return Promise.resolve(ok([]));
      }
      throw new Error(`Unexpected api call: ${method}`);
    });
  };

  it("prefetchMeetings runs a refresh and settles initialLoadPending", async () => {
    okLists();
    expect(meetingsStore.initialLoadPending).toBe(true);
    expect(meetingsStore.hasLiveSnapshot).toBe(false);

    await prefetchMeetings();

    expect(call).toHaveBeenCalledWith("listUpcoming");
    expect(meetingsStore.initialLoadPending).toBe(false);
    expect(meetingsStore.hasLiveSnapshot).toBe(true);
  });

  it("prefetchMeetings skips the network when a refresh just ran", async () => {
    okLists();
    await prefetchMeetings();
    const upcomingCalls = call.mock.calls.filter(
      ([m]) => m === "listUpcoming",
    ).length;

    await prefetchMeetings();

    expect(call.mock.calls.filter(([m]) => m === "listUpcoming").length).toBe(
      upcomingCalls,
    );
  });

  it("a cache snapshot alone settles initialLoadPending (stale-while-revalidate paint)", () => {
    vi.mocked(loadMeetingsCache).mockReturnValueOnce({
      events: [],
      botsByEventId: [],
      scheduledBots: [],
      companyNamesByUid: [],
      accounts: [],
      accountEmailById: [],
      calendarsByAccount: [],
      calendarSummaryByKey: [],
      enabledCalIdsByAccount: [],
    } as never);

    startMeetingsStore();

    expect(meetingsStore.initialLoadPending).toBe(false);
    // Cache paint is not a live answer — connect-empty gating stays closed.
    expect(meetingsStore.hasLiveSnapshot).toBe(false);
  });

  it("a failed first refresh settles loading but never claims a live snapshot", async () => {
    call.mockImplementation((method: string) => {
      if (method === "listUpcoming") {
        return Promise.resolve(failure("http-500", "listUpcoming HTTP 500"));
      }
      return Promise.resolve(ok([]));
    });

    await prefetchMeetings();

    expect(meetingsStore.initialLoadPending).toBe(false);
    expect(meetingsStore.hasLiveSnapshot).toBe(false);
  });
});
