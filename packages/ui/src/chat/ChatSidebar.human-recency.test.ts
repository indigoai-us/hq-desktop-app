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

  it("channels: known by human time, unknown by activity, known-none last by creation time", async () => {
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
    await waitForRows(ids);
    expect(railOrder(ids)).toEqual([
      "ch:chn_known_new", // typed 40 minutes ago
      "ch:chn_unknown", // no fields: activity 100 minutes ago
      "ch:chn_known_old", // typed 200 minutes ago; its bot activity is ignored
      "ch:chn_none_new", // known none: created 2026-09
      "ch:chn_none_old", // known none: created 2026-06
    ]);
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

  it("a DM known to hold no human message sorts below, and moves up once a person types", async () => {
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
    expect(railOrder(ids)).toEqual(["dm:prs_notices", "dm:prs_ann"]);

    wakes.emit("dm:pair-unreads", {
      activity: [
        { personUid: "prs_notices", lastMessageAt: today(2), hasHumanMessage: false },
      ],
    });
    await vi.waitFor(() => {
      expect(railOrder(ids)).toEqual(["dm:prs_ann", "dm:prs_notices"]);
    });

    wakes.emit("dm:pair-unreads", {
      activity: [
        { personUid: "prs_notices", lastMessageAt: today(0), lastHumanMessageAt: today(0) },
      ],
    });
    await vi.waitFor(() => {
      expect(railOrder(ids)).toEqual(["dm:prs_notices", "dm:prs_ann"]);
    });
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
