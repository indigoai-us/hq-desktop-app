// @vitest-environment happy-dom

/**
 * hq-message-visibility US-005: hidden runs collapse into fold lines in place.
 * A pill toggles the run open and closed; leaving the conversation closes it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ConversationView from "./ConversationView.svelte";
import type { ConversationApi, ConversationMessageWire } from "./chat-api";
import type { ConversationRow } from "./sidebar-model";

const OFF = { agents: false, system: false };

function rowFor(channelId: string): ConversationRow {
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

let t = 0;
const at = () => new Date(Date.UTC(2026, 9, 23, 1, t++)).toISOString();
const human = (id: string, body: string): ConversationMessageWire => ({
  eventId: id, body, createdAt: at(), fromPersonUid: "prs_ada", fromDisplayName: "Ada", audience: "human",
});
const agent = (id: string, body: string): ConversationMessageWire => ({
  eventId: id, body, createdAt: at(), fromPersonUid: "agt_scout", fromDisplayName: "Scout", audience: "agent",
});
const system = (id: string, body: string): ConversationMessageWire => ({
  eventId: id, body, createdAt: at(), fromDisplayName: "HQ", isSystemEvent: true,
});

// Server returns newest-first.
const wire = [
  human("h1", "hello there"),
  agent("a1", "agent one"),
  agent("a2", "agent two"),
  system("s1", "system one"),
  human("h2", "second human"),
  agent("a3", "trailing agent"),
].reverse();

function api(): ConversationApi {
  return {
    fetchChannel: async () => ({ messages: wire, nextCursor: null }),
    sendChannelMessage: async () => {},
    fetchDmThread: async () => ({ messages: [], nextCursor: null }),
    sendDm: async () => {},
    fetchReplyThread: async () => ({ scope: "channel", root: null, replies: [], replyCount: 0 }),
    sendReply: async () => {},
    runCardAction: async () => ({ cardId: "", actionId: "", state: "pending" }),
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const bodies = () =>
  [...host.querySelectorAll('[data-testid="conversation-message"]')].map((n) => n.textContent ?? "").join("|");
const folds = () => [...host.querySelectorAll<HTMLElement>('[data-testid="message-fold"]')];
const toggle = (fold: HTMLElement) => fold.querySelector<HTMLButtonElement>('[data-testid="message-fold-toggle"]')!;
const label = (fold: HTMLElement) => fold.querySelector('[data-testid="message-fold-label"]')!.textContent?.trim();

describe("ConversationView folds", () => {
  it("collapses hidden runs, including a trailing run, and toggles one open and closed", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const props = $state({ api: api(), row: rowFor("chn_a"), messageTypes: OFF });
    component = mount(ConversationView, { target: host, props });

    await vi.waitFor(() => expect(bodies()).toContain("second human"));
    expect(bodies()).not.toContain("agent one");
    expect(bodies()).not.toContain("trailing agent");
    expect(folds()).toHaveLength(2);
    const [mid, tail] = folds();
    expect(label(mid)).toBe("2 agent updates · 1 system");
    expect(label(tail)).toBe("1 agent update");

    const pill = toggle(mid);
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.getAttribute("type")).toBe("button");
    expect(pill.getAttribute("aria-expanded")).toBe("false");

    pill.click();
    await tick();
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    expect(label(mid)).toBe("hide 2 agent updates · 1 system");
    const opened = mid.querySelector('[data-testid="message-fold-body"]')!.textContent ?? "";
    expect(opened.indexOf("agent one")).toBeLessThan(opened.indexOf("agent two"));
    expect(opened.indexOf("agent two")).toBeLessThan(opened.indexOf("system one"));
    expect(bodies()).not.toContain("trailing agent");

    pill.click();
    await tick();
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(mid.querySelector('[data-testid="message-fold-body"]')).toBeNull();
    expect(bodies()).not.toContain("agent one");

    // Open again, then leave the conversation: the fold comes back closed.
    toggle(folds()[0]).click();
    await tick();
    expect(bodies()).toContain("agent one");
    props.row = rowFor("chn_b");
    await vi.waitFor(() => {
      expect(folds()).toHaveLength(2);
      expect(toggle(folds()[0]).getAttribute("aria-expanded")).toBe("false");
    });
    expect(bodies()).not.toContain("agent one");
  });

  it("shows hidden types as rows when their switch is on", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ConversationView, {
      target: host,
      props: { api: api(), row: rowFor("chn_a"), messageTypes: { agents: true, system: false } },
    });
    await vi.waitFor(() => expect(bodies()).toContain("trailing agent"));
    expect(folds()).toHaveLength(1);
    expect(label(folds()[0])).toBe("1 system");
  });
});
