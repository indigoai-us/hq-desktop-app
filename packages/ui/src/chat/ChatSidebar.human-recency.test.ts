// @vitest-environment happy-dom

/**
 * Human-only sidebar order, end to end through the rail.
 *
 * The rail orders by the last message a person typed. That value has three
 * states (known time, known none, unknown), and only the server computes it.
 * These tests cover what the rail does with each state, with the DM thread
 * listing's fields, and with a new-message wake that may have changed the
 * value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import { createChatWakeBus, type ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

/** A time today, `minutesAgo` before now, so every row lands under TODAY. */
function today(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function channelRow(
  channelId: string,
  name: string,
  extra: Partial<ChannelDirectoryRow> = {},
): ChannelDirectoryRow {
  return {
    channelId,
    type: "chat",
    scope: "company",
    companyUid: "cmp_1",
    name,
    lastActivityAt: today(30),
    ...extra,
  };
}

interface Stub {
  api: ChatSidebarApi;
  directoryCalls: () => number;
  setRows: (rows: ChannelDirectoryRow[]) => void;
}

function stubApi(
  rows: ChannelDirectoryRow[],
  contacts: Array<Record<string, unknown>> = [],
): Stub {
  let current = rows;
  let calls = 0;
  const api = {
    fetchChannelDirectory: async () => {
      calls += 1;
      return {
        snapshot: true,
        cursor: "cursor00000000000000000000000000000000000",
        cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        rows: current,
      };
    },
    listContacts: async () => ({ contacts }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
    logToFile: async () => {},
    ensureCompanyHomeChannel: async (companyUid: string) => ({
      homeChannelId: `chn_home_${companyUid}`,
    }),
  } as unknown as ChatSidebarApi;
  return {
    api,
    directoryCalls: () => calls,
    setRows: (next) => {
      current = next;
    },
  };
}

beforeEach(() => {
  window.localStorage?.clear?.();
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage?.clear?.();
});

/** Conversation ids in painted order, limited to the ids under test. */
function railOrder(idsOfInterest: string[]): string[] {
  return [...host.querySelectorAll<HTMLElement>("[data-conversation-id]")]
    .map((el) => el.dataset.conversationId ?? "")
    .filter((id) => idsOfInterest.includes(id));
}

async function waitForRows(idsOfInterest: string[]): Promise<void> {
  await vi.waitFor(() => {
    expect(railOrder(idsOfInterest).sort()).toEqual([...idsOfInterest].sort());
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The collapsed fold at the bottom of the rail (the last section). */
function lastSectionToggle(): HTMLElement | null {
  return host.querySelector<HTMLElement>('[data-testid="chat-last-week"]');
}

/** Open the last section, so the rows it holds are painted. */
async function expandLastSection(): Promise<void> {
  await vi.waitFor(() => expect(lastSectionToggle()).not.toBeNull());
  const toggle = lastSectionToggle();
  if (toggle?.getAttribute("aria-expanded") !== "true") toggle?.click();
  await tick();
}

/**
 * The section a painted row sits in: the first word of its day header
 * ("TODAY", "YESTERDAY", a weekday), or "LAST" for the last section.
 */
function sectionOf(id: string): string | null {
  const row = host.querySelector<HTMLElement>(
    `[data-conversation-id="${id}"]`,
  );
  const list = row?.closest<HTMLElement>(".chat-list");
  if (!list) return null;
  if (list.getAttribute("aria-label") === "Last week") return "LAST";
  const labelId = list.getAttribute("aria-labelledby");
  const label = labelId ? document.getElementById(labelId) : null;
  return label?.querySelector("span")?.textContent?.trim() ?? null;
}

/** A time `days` whole days before now. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

describe("ChatSidebar human-only order: the three states on the rail", () => {
  it("1:1 DMs with no human fields keep their activity order (not title order)", async () => {
    // Today's server sends no human fields for any 1:1 DM. Titles are chosen
    // so that title order is the reverse of activity order.
    const stub = stubApi([], [
      { personUid: "prs_a", displayName: "Aaron", lastMessageAt: today(50) },
      { personUid: "prs_m", displayName: "Maya", lastMessageAt: today(20) },
      { personUid: "prs_z", displayName: "Zed", lastMessageAt: today(5) },
    ]);
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stub.api, humanOnly: true },
    });
    const ids = ["dm:prs_a", "dm:prs_m", "dm:prs_z"];
    await waitForRows(ids);
    expect(railOrder(ids)).toEqual(["dm:prs_z", "dm:prs_m", "dm:prs_a"]);
  });

  it("channels: known by human time, unknown by activity, known-none by creation time", async () => {
    const rows = [
      channelRow("chn_none_old", "none-old", {
        hasHumanMessage: false,
        createdAt: "2026-06-01T00:00:00.000Z",
        lastActivityAt: today(1), // bot activity a minute ago
      }),
      channelRow("chn_known_old", "known-old", {
        lastHumanMessageAt: today(200),
        lastActivityAt: today(2), // bot activity two minutes ago
      }),
      channelRow("chn_unknown", "unknown", { lastActivityAt: today(100) }),
      channelRow("chn_none_new", "none-new", {
        hasHumanMessage: false,
        createdAt: "2026-09-01T00:00:00.000Z",
        lastActivityAt: today(3),
      }),
      channelRow("chn_known_new", "known-new", {
        lastHumanMessageAt: today(40),
        lastActivityAt: today(40),
      }),
    ];
    const stub = stubApi(rows);
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stub.api, humanOnly: true },
    });
    const ids = rows.map((row) => `ch:${row.channelId}`);
    // The two known-none rows were created months ago, so they sit in the
    // collapsed last section.
    await expandLastSection();
    await waitForRows(ids);
    expect(railOrder(ids)).toEqual([
      "ch:chn_known_new", // typed 40 minutes ago
      "ch:chn_unknown", // no fields: activity 100 minutes ago
      "ch:chn_known_old", // typed 200 minutes ago; its bot activity is ignored
      "ch:chn_none_new", // known none: created 2026-09
      "ch:chn_none_old", // known none: created 2026-06
    ]);
    expect(sectionOf("ch:chn_none_new")).toBe("LAST");
    expect(sectionOf("ch:chn_none_old")).toBe("LAST");
  });

  it("flag off: the same rows order by activity", async () => {
    const rows = [
      channelRow("chn_none", "none", { hasHumanMessage: false, lastActivityAt: today(1) }),
      channelRow("chn_known", "known", {
        lastHumanMessageAt: today(200),
        lastActivityAt: today(2),
      }),
      channelRow("chn_unknown", "unknown", { lastActivityAt: today(100) }),
    ];
    const stub = stubApi(rows);
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stub.api, humanOnly: false },
    });
    const ids = rows.map((row) => `ch:${row.channelId}`);
    await waitForRows(ids);
    expect(railOrder(ids)).toEqual(["ch:chn_none", "ch:chn_known", "ch:chn_unknown"]);
  });
});

describe("ChatSidebar human-only order: 1:1 DM fields from the DM thread listing", () => {
  it("a listing that reports human times reorders the DM rows; one that omits them changes nothing", async () => {
    const wakes = createChatWakeBus();
    const stub = stubApi([], [
      { personUid: "prs_ann", displayName: "Ann", lastMessageAt: today(5) },
      { personUid: "prs_bob", displayName: "Bob", lastMessageAt: today(30) },
    ]);
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stub.api, wakes, humanOnly: true, self: { uid: "prs_me" } },
    });
    const ids = ["dm:prs_ann", "dm:prs_bob"];
    await waitForRows(ids);
    // Unknown for both: activity order.
    expect(railOrder(ids)).toEqual(["dm:prs_ann", "dm:prs_bob"]);

    // Ann's newest activity is a bot; her last typed message is older than Bob's.
    wakes.emit("dm:pair-unreads", {
      activity: [
        { personUid: "prs_ann", lastMessageAt: today(5), lastHumanMessageAt: today(300) },
        { personUid: "prs_bob", lastMessageAt: today(30), lastHumanMessageAt: today(30) },
      ],
    });
    await tick();
    await vi.waitFor(() => {
      expect(railOrder(ids)).toEqual(["dm:prs_bob", "dm:prs_ann"]);
    });

    // A later payload without the fields (an inbox-derived stamp) keeps them.
    wakes.emit("dm:pair-unreads", {
      activity: [{ personUid: "prs_ann", lastMessageAt: today(1) }],
    });
    await tick();
    await wait(20);
    expect(railOrder(ids)).toEqual(["dm:prs_bob", "dm:prs_ann"]);
  });
});

describe("ChatSidebar human-only order: a 1:1 DM known to hold no human message", () => {
  // The DM thread listing carries no creation time, so such a DM is placed
  // by its latest activity, like a DM the server has not reported on.
  beforeEach(() => {
    // Local noon, so "minutes ago" is always today. Only `Date` is faked:
    // timers stay real for the rail's async work.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 16, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("with activity today it sits under TODAY in activity order, and unread breaks a tie as for an unknown row", async () => {
    const wakes = createChatWakeBus();
    const tie = today(20);
    const stub = stubApi([], [
      { personUid: "prs_ann", displayName: "Ann", lastMessageAt: today(60) },
      { personUid: "prs_newbie", displayName: "Newbie", lastMessageAt: today(2) },
      { personUid: "prs_abe", displayName: "Abe", lastMessageAt: tie },
      { personUid: "prs_zed", displayName: "Zed", lastMessageAt: tie },
    ]);
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stub.api, wakes, humanOnly: true, self: { uid: "prs_me" } },
    });
    const ids = ["dm:prs_ann", "dm:prs_newbie", "dm:prs_abe", "dm:prs_zed"];
    await waitForRows(ids);
    // Unknown for all four: activity order, the tie by title.
    expect(railOrder(ids)).toEqual([
      "dm:prs_newbie",
      "dm:prs_abe",
      "dm:prs_zed",
      "dm:prs_ann",
    ]);

    // The listing reports that Newbie and Zed hold no typed message (a new
    // teammate's join notice, an agent's first DM). Zed has two unread.
    wakes.emit("dm:pair-unreads", {
      pairUnreads: [{ withPersonUid: "prs_zed", unreadCount: 2 }],
      activity: [
        { personUid: "prs_newbie", lastMessageAt: today(2), hasHumanMessage: false },
        { personUid: "prs_zed", lastMessageAt: tie, hasHumanMessage: false },
      ],
    });
    await tick();
    await vi.waitFor(() => {
      expect(railOrder(ids)).toEqual([
        "dm:prs_newbie", // known none: activity two minutes ago
        "dm:prs_zed", // known none: same activity as Abe, unread wins the tie
        "dm:prs_abe", // unknown
        "dm:prs_ann", // unknown: activity an hour ago
      ]);
    });
    for (const id of ids) expect(sectionOf(id)).toBe("TODAY");

    // Abe's unread now exceeds Zed's: the unknown row wins the same tie.
    wakes.emit("dm:pair-unreads", {
      pairUnreads: [{ withPersonUid: "prs_abe", unreadCount: 5 }],
    });
    await vi.waitFor(() => {
      expect(railOrder(ids)).toEqual([
        "dm:prs_newbie",
        "dm:prs_abe",
        "dm:prs_zed",
        "dm:prs_ann",
      ]);
    });
  });

  it("with old activity it sits in the last section, in activity order with the rows around it", async () => {
    const wakes = createChatWakeBus();
    const stub = stubApi([], [
      { personUid: "prs_ann", displayName: "Ann", lastMessageAt: daysAgo(20) },
      { personUid: "prs_notices", displayName: "Notices", lastMessageAt: daysAgo(15) },
      { personUid: "prs_bob", displayName: "Bob", lastMessageAt: today(5) },
    ]);
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stub.api, wakes, humanOnly: true, self: { uid: "prs_me" } },
    });
    const ids = ["dm:prs_ann", "dm:prs_notices", "dm:prs_bob"];
    await expandLastSection();
    await waitForRows(ids);

    wakes.emit("dm:pair-unreads", {
      activity: [
        { personUid: "prs_notices", lastMessageAt: daysAgo(15), hasHumanMessage: false },
      ],
    });
    await tick();
    await wait(20);
    expect(railOrder(ids)).toEqual(["dm:prs_bob", "dm:prs_notices", "dm:prs_ann"]);
    expect(sectionOf("dm:prs_bob")).toBe("TODAY");
    expect(sectionOf("dm:prs_notices")).toBe("LAST");
    expect(sectionOf("dm:prs_ann")).toBe("LAST");
  });

  it("once a person types, the row follows the human time and no longer its activity", async () => {
    const wakes = createChatWakeBus();
    const stub = stubApi([], [
      { personUid: "prs_ann", displayName: "Ann", lastMessageAt: today(60) },
      { personUid: "prs_notices", displayName: "Notices", lastMessageAt: today(2) },
    ]);
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stub.api, wakes, humanOnly: true, self: { uid: "prs_me" } },
    });
    const ids = ["dm:prs_ann", "dm:prs_notices"];
    await waitForRows(ids);

    wakes.emit("dm:pair-unreads", {
      activity: [
        { personUid: "prs_notices", lastMessageAt: today(2), hasHumanMessage: false },
      ],
    });
    await tick();
    await wait(20);
    // Known none, no creation time: still first, by its activity.
    expect(railOrder(ids)).toEqual(["dm:prs_notices", "dm:prs_ann"]);
    expect(sectionOf("dm:prs_notices")).toBe("TODAY");

    // The server now reports a typed message from five hours ago, older than
    // Ann's activity. The bot activity two minutes ago no longer places it.
    wakes.emit("dm:pair-unreads", {
      activity: [
        { personUid: "prs_notices", lastMessageAt: today(2), lastHumanMessageAt: today(300) },
      ],
    });
    await vi.waitFor(() => {
      expect(railOrder(ids)).toEqual(["dm:prs_ann", "dm:prs_notices"]);
    });
    expect(sectionOf("dm:prs_notices")).toBe("TODAY");
  });
});

describe("ChatSidebar human-only day sections follow the same key as the order", () => {
  let rows: ChannelDirectoryRow[] = [];
  let ids: string[] = [];

  beforeEach(() => {
    // Local noon on Wednesday 16 September 2026, so "a few minutes ago" is
    // always today and the weekday sections are known. Only `Date` is faked:
    // timers stay real for the rail's async work.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 16, 12, 0, 0));
    rows = [
      channelRow("chn_mesh_busy", "mesh-busy", {
        lastHumanMessageAt: daysAgo(3),
        lastActivityAt: today(1), // a work session posted a minute ago
      }),
      channelRow("chn_bot_only_old", "bot-only-old", {
        hasHumanMessage: false,
        createdAt: "2026-06-01T00:00:00.000Z",
        lastActivityAt: today(2), // a bot posted two minutes ago
      }),
      channelRow("chn_unknown", "unknown", { lastActivityAt: today(5) }),
      channelRow("chn_typed_today", "typed-today", {
        lastHumanMessageAt: today(10),
        lastActivityAt: today(10),
      }),
      channelRow("chn_new_empty", "new-empty", {
        hasHumanMessage: false,
        createdAt: today(30), // created half an hour ago, nothing typed yet
        lastActivityAt: null,
      }),
      channelRow("chn_typed_yesterday", "typed-yesterday", {
        lastHumanMessageAt: daysAgo(1),
        lastActivityAt: daysAgo(1),
      }),
      channelRow("chn_old_human", "old-human", {
        lastHumanMessageAt: daysAgo(20),
        lastActivityAt: today(3), // a bot posted three minutes ago
      }),
    ];
    ids = rows.map((row) => `ch:${row.channelId}`);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rows on different days: each sits under the day of its own key, and the rail reads top to bottom in sort order", async () => {
    const stub = stubApi(rows);
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stub.api, humanOnly: true },
    });
    await expandLastSection();
    await waitForRows(ids);

    expect(sectionOf("ch:chn_unknown")).toBe("TODAY");
    expect(sectionOf("ch:chn_typed_today")).toBe("TODAY");
    expect(sectionOf("ch:chn_typed_yesterday")).toBe("YESTERDAY");
    // Typed three days ago (Sunday 13 September 2026): that day's section,
    // despite activity a minute ago.
    expect(sectionOf("ch:chn_mesh_busy")).toBe("SUNDAY");
    // Typed twenty days ago: the last section, despite activity today.
    expect(sectionOf("ch:chn_old_human")).toBe("LAST");

    expect(railOrder(ids)).toEqual([
      "ch:chn_unknown", // TODAY: activity five minutes ago
      "ch:chn_typed_today", // TODAY: typed ten minutes ago
      "ch:chn_new_empty", // TODAY: created thirty minutes ago
      "ch:chn_typed_yesterday", // YESTERDAY
      "ch:chn_mesh_busy", // SUNDAY
      "ch:chn_old_human", // last section: typed 27 August
      "ch:chn_bot_only_old", // last section: created 1 June
    ]);
  });

  it("a channel created today with nothing typed sits under TODAY, above older human rows; an old bot-only channel does not", async () => {
    const stub = stubApi(rows);
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stub.api, humanOnly: true },
    });
    await expandLastSection();
    await waitForRows(ids);

    expect(sectionOf("ch:chn_new_empty")).toBe("TODAY");
    const order = railOrder(ids);
    expect(order.indexOf("ch:chn_new_empty")).toBeLessThan(
      order.indexOf("ch:chn_typed_yesterday"),
    );
    expect(order.indexOf("ch:chn_new_empty")).toBeLessThan(
      order.indexOf("ch:chn_mesh_busy"),
    );
    // Created in June, a bot posted two minutes ago: not under TODAY, and
    // below every row a person typed in.
    expect(sectionOf("ch:chn_bot_only_old")).toBe("LAST");
    expect(order.at(-1)).toBe("ch:chn_bot_only_old");
  });

  it("flag off: the same rows sit under the day of their activity", async () => {
    const stub = stubApi(rows);
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stub.api, humanOnly: false },
    });
    const withActivity = ids.filter((id) => id !== "ch:chn_new_empty");
    await waitForRows(withActivity);
    for (const id of [
      "ch:chn_mesh_busy",
      "ch:chn_bot_only_old",
      "ch:chn_old_human",
      "ch:chn_unknown",
      "ch:chn_typed_today",
    ]) {
      expect(sectionOf(id)).toBe("TODAY");
    }
    expect(sectionOf("ch:chn_typed_yesterday")).toBe("YESTERDAY");
    expect(railOrder(withActivity)).toEqual([
      "ch:chn_mesh_busy", // activity one minute ago
      "ch:chn_bot_only_old", // two
      "ch:chn_old_human", // three
      "ch:chn_unknown", // five
      "ch:chn_typed_today", // ten
      "ch:chn_typed_yesterday",
    ]);
  });
});

describe("ChatSidebar human-only order: a new-message wake re-reads the directory when it may matter", () => {
  const known = channelRow("chn_known", "known", {
    lastHumanMessageAt: today(200),
    lastActivityAt: today(200),
  });
  const other = channelRow("chn_other", "other", {
    lastHumanMessageAt: today(60),
    lastActivityAt: today(60),
  });
  const unknown = channelRow("chn_unknown", "unknown", { lastActivityAt: today(90) });
  const ids = ["ch:chn_known", "ch:chn_other", "ch:chn_unknown"];

  async function mountRail(props: Record<string, unknown> = {}) {
    const wakes = createChatWakeBus();
    const stub = stubApi([known, other, unknown]);
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stub.api, wakes, humanOnly: true, self: { uid: "prs_me" }, ...props },
    });
    await waitForRows(ids);
    // Let the boot reconcile settle before counting.
    await wait(50);
    return { wakes, stub, bootCalls: stub.directoryCalls() };
  }

  it("a person's message in a row with a known human time: the directory is read again and the row moves up", async () => {
    const { wakes, stub, bootCalls } = await mountRail();
    expect(railOrder(ids)).toEqual(["ch:chn_other", "ch:chn_unknown", "ch:chn_known"]);

    // The server now reports the new typed message.
    const at = new Date().toISOString();
    stub.setRows([{ ...known, lastHumanMessageAt: at, lastActivityAt: at }, other, unknown]);
    wakes.emit("channel:new-message", {
      channelId: "chn_known",
      eventId: "evt_1",
      createdAt: at,
      fromPersonUid: "prs_ada",
    });

    await vi.waitFor(
      () => expect(stub.directoryCalls()).toBe(bootCalls + 1),
      { timeout: 3000 },
    );
    await vi.waitFor(() => {
      expect(railOrder(ids)).toEqual(["ch:chn_known", "ch:chn_other", "ch:chn_unknown"]);
    });
  });

  it("the person's own send from the composer is read again without the interval wait, one read per send", async () => {
    const { wakes, stub, bootCalls } = await mountRail({ selectedId: "ch:chn_known" });
    const send = (eventId: string, at: string) => {
      // What the shell emits for a composer send: the timeline's activity
      // wake first, then the own-send signal.
      wakes.emit("channel:new-message", {
        channelId: "chn_known",
        eventId,
        createdAt: at,
        fromPersonUid: "prs_me",
      });
      wakes.emit("channel:own-send", { channelId: "chn_known" });
    };
    send("evt_1", new Date().toISOString());
    await vi.waitFor(
      () => expect(stub.directoryCalls()).toBe(bootCalls + 1),
      { timeout: 3000 },
    );
    // A second send moments later is not held back by the interval.
    send("evt_2", new Date(Date.now() + 1000).toISOString());
    await vi.waitFor(
      () => expect(stub.directoryCalls()).toBe(bootCalls + 2),
      { timeout: 3000 },
    );
    // And neither send cost a second, throttled read.
    await wait(900);
    expect(stub.directoryCalls()).toBe(bootCalls + 2);
  });

  it("an own send in a row the server has not reported on needs no read", async () => {
    const { wakes, stub, bootCalls } = await mountRail({ selectedId: "ch:chn_unknown" });
    wakes.emit("channel:new-message", {
      channelId: "chn_unknown",
      eventId: "evt_1",
      createdAt: new Date().toISOString(),
      fromPersonUid: "prs_me",
    });
    wakes.emit("channel:own-send", { channelId: "chn_unknown" });
    await wait(900);
    expect(stub.directoryCalls()).toBe(bootCalls);
    expect(railOrder(ids)[0]).toBe("ch:chn_unknown");
  });

  it("other people's messages share one read per interval", async () => {
    const { wakes, stub, bootCalls } = await mountRail();
    for (let i = 0; i < 4; i += 1) {
      wakes.emit("channel:new-message", {
        channelId: "chn_known",
        eventId: `evt_${i}`,
        createdAt: new Date(Date.now() + i).toISOString(),
        fromPersonUid: "prs_ada",
      });
    }
    await vi.waitFor(
      () => expect(stub.directoryCalls()).toBe(bootCalls + 1),
      { timeout: 3000 },
    );
    // The next one, inside the interval, waits for it.
    wakes.emit("channel:new-message", {
      channelId: "chn_known",
      eventId: "evt_late",
      createdAt: new Date(Date.now() + 5000).toISOString(),
      fromPersonUid: "prs_ada",
    });
    await wait(900);
    expect(stub.directoryCalls()).toBe(bootCalls + 1);
  });

  it("no read for a row in the unknown state, for an agent's post, or with the flag off", async () => {
    const { wakes, stub, bootCalls } = await mountRail();
    const at = new Date().toISOString();
    // Unknown row: ordered by activity, which the wake stamps itself.
    wakes.emit("channel:new-message", {
      channelId: "chn_unknown",
      eventId: "evt_1",
      createdAt: at,
      fromPersonUid: "prs_ada",
    });
    // An agent's post is never a typed message.
    wakes.emit("channel:new-message", {
      channelId: "chn_known",
      eventId: "evt_2",
      createdAt: at,
      fromPersonUid: "agt_izzy",
    });
    await wait(900);
    expect(stub.directoryCalls()).toBe(bootCalls);
    // The unknown row still moved up, from its activity stamp.
    expect(railOrder(ids)[0]).toBe("ch:chn_unknown");
  });

  it("flag off: neither a wake nor an own send triggers the read", async () => {
    const { wakes, stub, bootCalls } = await mountRail({ humanOnly: false });
    wakes.emit("channel:new-message", {
      channelId: "chn_known",
      eventId: "evt_1",
      createdAt: new Date().toISOString(),
      fromPersonUid: "prs_ada",
    });
    wakes.emit("channel:own-send", { channelId: "chn_known" });
    await wait(900);
    expect(stub.directoryCalls()).toBe(bootCalls);
  });
});
