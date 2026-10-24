// @vitest-environment happy-dom

/**
 * hq-message-visibility US-006: the Activity column beside the conversation.
 *
 * The header pill counts the hidden agent and system rows and opens the
 * column in the thread-panel slot; the column streams those rows with an
 * Agents / System switch, grows live on a wake, hands Reply to the thread
 * panel and comes back when it closes. Below 1000px a "People ▾" lens menu
 * replaces the column. The full timeline is always read (Part 0), so with the
 * default preference hidden rows fold in place.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ConversationView from "./ConversationView.svelte";
import { createChatWakeBus, type ConversationApi, type ConversationMessageWire } from "./chat-api";
import type { ConversationRow } from "./sidebar-model";
import { activitySession } from "./activity-session.svelte.js";
import { ACTIVITY_NARROW_QUERY } from "./activity-column.js";

const OFF = { agents: false, system: false };

function channelRow(channelId: string): ConversationRow {
  return {
    id: `ch:${channelId}`,
    kind: "channel",
    title: channelId,
    companyUid: "cmp_1",
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    channelId,
  };
}

function dmRow(personUid: string): ConversationRow {
  return {
    id: `dm:${personUid}`,
    kind: "dm",
    title: "Ada",
    companyUid: "cmp_1",
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    personUid,
  };
}

let t = 0;
const at = () => new Date(Date.UTC(2026, 9, 23, 1, 0, t++)).toISOString();
const human = (id: string): ConversationMessageWire => ({
  eventId: id, body: `body-${id}`, createdAt: at(), fromPersonUid: "prs_ada", fromDisplayName: "Ada", audience: "human",
});
const agent = (id: string): ConversationMessageWire => ({
  eventId: id, body: `body-${id}`, createdAt: at(), fromPersonUid: "agt_scout", fromDisplayName: "Scout", audience: "agent",
});
const system = (id: string): ConversationMessageWire => ({
  eventId: id, body: `body-${id}`, createdAt: at(), fromDisplayName: "HQ", isSystemEvent: true,
});

interface Calls {
  channel: Array<Record<string, unknown>>;
  dm: Array<Record<string, unknown>>;
  replies: string[];
}

/** `pages()` returns the timeline oldest-first; the api serves newest-first. */
function api(pages: () => ConversationMessageWire[], calls: Calls): ConversationApi {
  return {
    fetchChannel: async (args) => {
      calls.channel.push({ ...args });
      return { messages: [...pages()].reverse(), nextCursor: null };
    },
    sendChannelMessage: async () => {},
    fetchDmThread: async (args) => {
      calls.dm.push({ ...args });
      return { messages: [...pages()].reverse(), nextCursor: null };
    },
    sendDm: async () => {},
    fetchReplyThread: async (args) => {
      calls.replies.push(args.rootEventId);
      return { scope: "channel", root: null, replies: [], replyCount: 0 };
    },
    sendReply: async () => {},
    runCardAction: async () => ({ cardId: "", actionId: "", state: "pending" }),
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let narrow = false;
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  narrow = false;
  activitySession.reset();
  window.matchMedia = ((query: string) => ({
    matches: query === ACTIVITY_NARROW_QUERY ? narrow : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.matchMedia = realMatchMedia;
  activitySession.reset();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const mainRows = () =>
  qa("conversation-message").filter((n) => !n.closest('[data-testid="message-fold-body"]'));
const columnIds = () => qa("activity-row").map((n) => n.dataset.eventId);

async function mountView(
  props: Record<string, unknown>,
): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ConversationView, { target: host, props: props as never });
  await settle();
}

describe("ConversationView Activity column", () => {
  it("Part 0: a DM with 4 human messages and 30 agent updates reads the full timeline once and shows 4 rows plus folds", async () => {
    const timeline: ConversationMessageWire[] = [];
    let h = 0;
    for (let i = 0; i < 30; i += 1) {
      if (i % 8 === 0) timeline.push(human(`h${++h}`));
      timeline.push(agent(`a${i}`));
    }
    expect(h).toBe(4);
    const calls: Calls = { channel: [], dm: [], replies: [] };
    await mountView({ api: api(() => timeline, calls), row: dmRow("prs_ada"), messageTypes: OFF });

    expect(calls.dm).toHaveLength(1);
    expect("view" in calls.dm[0]).toBe(false);
    expect(mainRows()).toHaveLength(4);
    const folds = qa("message-fold");
    expect(folds.length).toBeGreaterThan(0);
    const folded = folds.reduce((n, f) => n + Number(f.dataset.foldCount), 0);
    expect(folded).toBe(30);
    expect(q("activity-toggle")?.textContent).toContain("Activity · 30");
  });

  it("opens and closes the column in the thread-panel slot, and remembers it per conversation", async () => {
    const timeline = [human("h1"), agent("a1"), system("s1"), agent("a2"), human("h2")];
    const calls: Calls = { channel: [], dm: [], replies: [] };
    const props = $state({ api: api(() => timeline, calls), row: channelRow("ops"), messageTypes: OFF });
    await mountView(props);

    expect(q("activity-column")).toBeNull();
    const toggle = q("activity-toggle")!;
    expect(toggle.textContent).toContain("Activity · 3");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    toggle.click();
    await settle();
    const column = q("activity-column")!;
    expect(column).not.toBeNull();
    expect(column.closest('[data-testid="activity-slot"]')?.classList.contains("reply-column")).toBe(true);
    expect(column.textContent).toContain("Activity");
    expect(q("activity-live")).not.toBeNull();
    expect(q("activity-toggle")!.getAttribute("aria-pressed")).toBe("true");
    // Folds in the main column still render while the column is open.
    expect(qa("message-fold").length).toBeGreaterThan(0);
    expect(mainRows().map((n) => n.dataset.eventId)).toEqual(["h1", "h2"]);

    // Another conversation starts closed; coming back finds it open.
    props.row = channelRow("design");
    await settle();
    expect(q("activity-column")).toBeNull();
    props.row = channelRow("ops");
    await settle();
    expect(q("activity-column")).not.toBeNull();

    q("activity-close")!.click();
    await settle();
    expect(q("activity-column")).toBeNull();
    expect(activitySession.get("ch:ops").open).toBe(false);
  });

  it("filters by type: Agents by default, System on the second segment", async () => {
    const timeline = [human("h1"), agent("a1"), system("s1"), agent("a2"), system("s2")];
    const calls: Calls = { channel: [], dm: [], replies: [] };
    await mountView({ api: api(() => timeline, calls), row: channelRow("ops"), messageTypes: OFF });
    q("activity-toggle")!.click();
    await settle();

    expect(q("activity-column")!.dataset.segment).toBe("agents");
    expect(q("activity-segment-agents")!.getAttribute("aria-selected")).toBe("true");
    expect(columnIds()).toEqual(["a1", "a2"]);

    q("activity-segment-system")!.click();
    await settle();
    expect(columnIds()).toEqual(["s1", "s2"]);
    expect(q("activity-column")!.textContent).not.toContain("body-h1");
  });

  it("appends live on a wake without a reload of the view", async () => {
    const timeline = [human("h1"), agent("a1")];
    const calls: Calls = { channel: [], dm: [], replies: [] };
    const wakes = createChatWakeBus();
    await mountView({ api: api(() => timeline, calls), wakes, row: channelRow("ops"), messageTypes: OFF });
    q("activity-toggle")!.click();
    await settle();
    expect(columnIds()).toEqual(["a1"]);
    const column = q("activity-column");

    timeline.push(agent("a2"));
    wakes.emit("channel:new-message", { channelId: "ops", eventId: "a2" } as never);
    await settle();

    expect(columnIds()).toEqual(["a1", "a2"]);
    // Same column element: it grew in place.
    expect(q("activity-column")).toBe(column);
    expect(q("activity-toggle")!.textContent).toContain("Activity · 2");
    for (const call of calls.channel) expect("view" in call).toBe(false);
  });

  it("Reply on a column row opens the thread panel in its place; closing it returns to the column", async () => {
    const timeline = [human("h1"), agent("a1"), agent("a2")];
    const calls: Calls = { channel: [], dm: [], replies: [] };
    await mountView({ api: api(() => timeline, calls), row: channelRow("ops"), messageTypes: OFF });
    q("activity-toggle")!.click();
    await settle();

    const row = qa("activity-row").find((n) => n.dataset.eventId === "a2")!;
    row.querySelector<HTMLButtonElement>('[data-testid="activity-reply"]')!.click();
    await settle();

    expect(q("activity-column")).toBeNull();
    expect(q("reply-column")).not.toBeNull();
    expect(calls.replies).toContain("a2");

    const close = host.querySelector<HTMLButtonElement>(
      '[data-testid="reply-column"] [data-testid="reply-panel-close"]',
    );
    expect(close, "thread panel has a close control").not.toBeNull();
    close!.click();
    await settle();

    expect(q("reply-column")).toBeNull();
    expect(q("activity-column")).not.toBeNull();
    expect(columnIds()).toEqual(["a1", "a2"]);
  });

  it("below 1000px: no third column, a People lens menu instead, chosen per conversation", async () => {
    narrow = true;
    const timeline = [human("h1"), agent("a1"), system("s1")];
    const calls: Calls = { channel: [], dm: [], replies: [] };
    const props = $state({ api: api(() => timeline, calls), row: channelRow("ops"), messageTypes: OFF });
    activitySession.update("ch:ops", { open: true });
    await mountView(props);

    expect(q("activity-toggle")).toBeNull();
    expect(q("activity-column")).toBeNull();
    const lens = q("activity-lens")!;
    expect(lens.textContent).toContain("People ▾");
    lens.click();
    await settle();
    const items = qa("activity-lens-menu")[0]
      .querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    expect([...items].map((b) => b.textContent?.trim())).toEqual(["People", "Agents", "System", "All"]);

    q("activity-lens-agents")!.click();
    await settle();
    expect(q("activity-lens")!.textContent).toContain("Agents ▾");
    expect(mainRows().map((n) => n.dataset.eventId)).toEqual(["h1", "a1"]);
    expect(q("activity-column")).toBeNull();

    // Per conversation: another one keeps the preference.
    props.row = channelRow("design");
    await settle();
    expect(q("activity-lens")!.textContent).toContain("People ▾");
    props.row = channelRow("ops");
    await settle();
    expect(q("activity-lens")!.textContent).toContain("Agents ▾");
    // Session memory only.
    expect(window.localStorage.getItem("hq:messages:activity")).toBeNull();
  });
});
