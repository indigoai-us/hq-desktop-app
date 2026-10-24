// @vitest-environment happy-dom

/**
 * Folds in the desktop shell's main column (hq-message-visibility US-007).
 * ChannelConversation folds runs of hidden messages in place instead of
 * dropping them, with the same rules as ConversationView (US-005).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import type { ConversationMessageWire } from "../chat-api";
import { activityHiddenCount } from "../activity-column";
import { timelineMessageType } from "./timeline-type";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

let minute = 0;
function at(): string {
  minute += 1;
  return new Date(Date.UTC(2026, 9, 23, 9, minute)).toISOString();
}

function human(id: string, body = `human ${id}`): ConversationMessageWire {
  return {
    eventId: id,
    direction: "in",
    fromPersonUid: "prs_ada",
    fromDisplayName: "Ada",
    body,
    createdAt: at(),
  } as ConversationMessageWire;
}

function agent(id: string): ConversationMessageWire {
  return {
    eventId: id,
    direction: "in",
    fromPersonUid: "agt_izzy",
    fromDisplayName: "Izzy",
    audience: "bot",
    body: `agent ${id}`,
    createdAt: at(),
  } as ConversationMessageWire;
}

function system(id: string): ConversationMessageWire {
  return {
    eventId: id,
    direction: "in",
    fromDisplayName: "System",
    isSystemEvent: true,
    body: `system ${id}`,
    createdAt: at(),
  } as ConversationMessageWire;
}

function mountWith(
  messages: ConversationMessageWire[],
  extra: Record<string, unknown> = {},
): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: { messages, messageTypes: { agents: false, system: false }, ...extra },
  });
  return host;
}

const folds = () => Array.from(host.querySelectorAll('[data-testid="message-fold"]'));
const shownIds = () =>
  Array.from(host.querySelectorAll("[data-event-id]"))
    .filter((el) => !el.closest('[data-testid="message-fold"]'))
    .map((el) => el.getAttribute("data-event-id"));

describe("ChannelConversation folds", () => {
  it("H,A,A,S,H renders two human rows and one fold of three", async () => {
    mountWith([human("h1"), agent("a1"), agent("a2"), system("s1"), human("h2")]);
    await tick();
    expect(shownIds()).toEqual(["h1", "h2"]);
    expect(folds()).toHaveLength(1);
    expect(folds()[0].getAttribute("data-fold-count")).toBe("3");
    expect(folds()[0].textContent).toContain("2 agent updates · 1 system");
    // The fold sits between the two people rows, in timeline order.
    const order = Array.from(
      host.querySelectorAll('[data-event-id], [data-testid="message-fold"]'),
    ).map((el) => el.getAttribute("data-event-id") ?? "fold");
    expect(order).toEqual(["h1", "fold", "h2"]);
  });

  it("a trailing hidden run folds", async () => {
    mountWith([human("h1"), agent("a1"), system("s1")]);
    await tick();
    expect(shownIds()).toEqual(["h1"]);
    expect(folds()).toHaveLength(1);
    expect(folds()[0].getAttribute("data-fold-count")).toBe("2");
  });

  it("a DM with 4 people rows and 30 agent rows shows the 4 rows plus folds", async () => {
    const rows: ConversationMessageWire[] = [];
    const runs = [8, 8, 7, 7];
    for (let i = 0; i < 4; i += 1) {
      rows.push(human(`h${i}`));
      for (let j = 0; j < runs[i]; j += 1) rows.push(agent(`a${i}_${j}`));
    }
    const agentRows = rows.filter((r) => r.eventId.startsWith("a")).length;
    expect(agentRows).toBe(30);
    mountWith(rows);
    await tick();
    expect(shownIds()).toEqual(["h0", "h1", "h2", "h3"]);
    const total = folds().reduce((n, f) => n + Number(f.getAttribute("data-fold-count")), 0);
    expect(total).toBe(30);
    // The Activity · N pill and the folds agree on what is hidden.
    expect(
      activityHiddenCount(rows, { agents: false, system: false }, timelineMessageType),
    ).toBe(total);
  });

  it("clicking a fold opens its rows inline and clicking again closes it", async () => {
    mountWith([human("h1"), agent("a1"), agent("a2"), human("h2")]);
    await tick();
    const toggle = host.querySelector('[data-testid="message-fold-toggle"]') as HTMLButtonElement;
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain("agent a1");
    toggle.click();
    await tick();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const body = host.querySelector('[data-testid="message-fold-body"]')!;
    expect(toggle.getAttribute("aria-controls")).toBe(body.id);
    expect(
      Array.from(body.querySelectorAll("[data-event-id]")).map((el) => el.getAttribute("data-event-id")),
    ).toEqual(["a1", "a2"]);
    toggle.click();
    await tick();
    expect(host.querySelector('[data-testid="message-fold-body"]')).toBeNull();
  });

  it("opening a fold has no read effect", async () => {
    const onseen = vi.fn(async () => {});
    mountWith([human("h1"), agent("a1")], { onseen });
    await tick();
    const before = onseen.mock.calls.length;
    (host.querySelector('[data-testid="message-fold-toggle"]') as HTMLButtonElement).click();
    await tick();
    expect(onseen.mock.calls.length).toBe(before);
  });

  it("no type filter: nothing folds", async () => {
    mountWith([human("h1"), agent("a1"), system("s1")], { messageTypes: { agents: true, system: true } });
    await tick();
    expect(folds()).toHaveLength(0);
    expect(shownIds()).toEqual(["h1", "a1", "s1"]);
  });
});
