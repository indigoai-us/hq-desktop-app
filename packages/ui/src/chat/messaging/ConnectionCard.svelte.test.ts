// @vitest-environment happy-dom

// Connection cards: a `connect` block in a bot's message draws one card per
// target from views the host built. A press goes to the host, once.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import ConnectionCard from "./ConnectionCard.svelte";
import RichMessageContent from "./RichMessageContent.svelte";
import {
  connectionCardView,
  markConnecting,
  markDeclined,
  toolFacts,
  type BotConnectionRecord,
  type ConnectionCardActionDetail,
  type ConnectionCardInput,
  type ConnectionCards,
} from "./connection-card-model.js";
import { parseRichContent, type ConnectTarget } from "./richMessageContent.js";
import type { ConversationMessageWire } from "../chat-api";

const NOW = Date.parse("2026-10-02T15:00:00.000Z");

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

function target(): HTMLDivElement {
  host = document.createElement("div");
  host.className = "chat-shell";
  document.body.appendChild(host);
  return host;
}

function input(over: Partial<ConnectionCardInput> = {}): ConnectionCardInput {
  return { botName: "Nova", now: NOW, ...over };
}

function views(over: Partial<ConnectionCardInput> = {}): ConnectionCards["views"] {
  return { slack: connectionCardView("slack", input(over)), tools: connectionCardView("tools", input(over)) };
}

const BLOCK = parseRichContent({ v: 1, blocks: [{ kind: "connect", targets: ["slack", "tools"] }] })!;

const cards = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-testid="connection-card"]')];
const card = (root: HTMLElement, which: ConnectTarget) =>
  root.querySelector<HTMLElement>(`[data-testid="connection-card"][data-target="${which}"]`)!;
const primary = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-testid="connection-card-primary"]');
const decline = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-testid="connection-card-decline"]');

function renderBlock(connections: ConnectionCards | null, content = BLOCK): HTMLElement {
  const root = target();
  component = mount(RichMessageContent, { target: root, props: { content, connections } });
  flushSync();
  return root;
}

describe("a connect block in a message", () => {
  it("draws both cards side by side from one block", () => {
    const root = renderBlock({ views: views(), onaction: () => {} });
    const row = root.querySelector('[data-testid="rich-connect"]');
    expect(row).not.toBeNull();
    expect(cards(root).map((el) => el.dataset.target)).toEqual(["slack", "tools"]);
    expect(cards(root).every((el) => el.parentElement === row)).toBe(true);
    expect(card(root, "slack").textContent).toContain("Talk to Nova in Slack and let it post there.");
    expect(primary(card(root, "slack"))?.textContent?.trim()).toBe("Connect Slack");
    expect(card(root, "tools").textContent).toContain("Connect your tools");
    expect(primary(card(root, "tools"))?.textContent?.trim()).toBe("Connect a tool");
  });

  it("draws only the targets the block names, in its order", () => {
    const only = parseRichContent({ v: 1, blocks: [{ kind: "connect", targets: ["tools"] }] })!;
    const root = renderBlock({ views: views(), onaction: () => {} }, only);
    expect(cards(root).map((el) => el.dataset.target)).toEqual(["tools"]);
  });

  it("draws nothing when the host passes no cards", () => {
    const root = renderBlock(null);
    expect(cards(root)).toEqual([]);
    expect(root.querySelector('[data-testid="rich-connect"]')).toBeNull();
    // A message whose only block is the offer leaves no empty box behind.
    expect(root.querySelector('[data-testid="rich-message-content"]')).toBeNull();
  });

  it("uses no link, label or style the bot put in the block", () => {
    const hostile = parseRichContent({
      v: 1,
      blocks: [
        {
          kind: "connect",
          targets: ["slack"],
          url: "https://evil.example/login",
          label: "Free tokens",
          title: "Click me",
          style: "position:fixed",
        },
      ],
    })!;
    const root = renderBlock({ views: views(), onaction: () => {} }, hostile);
    expect(root.querySelector("a")).toBeNull();
    expect(root.innerHTML).not.toContain("evil");
    expect(root.textContent).not.toContain("Free tokens");
    expect(root.textContent).not.toContain("Click me");
    expect(card(root, "slack").getAttribute("style")).toBeNull();
  });
});

describe("a connection card", () => {
  function renderCard(view: ReturnType<typeof connectionCardView>, onaction = vi.fn()): HTMLElement {
    const root = target();
    component = mount(ConnectionCard, { target: root, props: { view, onaction } });
    flushSync();
    return root.querySelector<HTMLElement>('[data-testid="connection-card"]')!;
  }

  it("shows each of the four states as its own state", async () => {
    const states: Array<[string, ConnectionCardInput]> = [
      ["offered", input()],
      ["connecting", input({ record: markConnecting(null, "slack", NOW) })],
      ["connected", input({ slack: { state: "connected" } })],
      ["declined", input({ record: markDeclined(null, "slack", NOW) })],
    ];
    const seen: string[] = [];
    for (const [state, cardInput] of states) {
      const el = renderCard(connectionCardView("slack", cardInput));
      expect(el.dataset.state).toBe(state);
      seen.push(`${el.dataset.state}|${el.textContent?.replace(/\s+/g, " ").trim()}`);
      await unmount(component!);
      component = null;
      host?.remove();
    }
    // No two states read the same.
    expect(new Set(seen).size).toBe(4);
  });

  it("shows the connected mark and no buttons once connected", () => {
    const el = renderCard(connectionCardView("slack", input({ slack: { state: "connected" } })));
    expect(el.querySelector('[data-testid="connection-card-mark"]')?.textContent?.trim()).toBe("Connected");
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });

  it("shows the note under the card", () => {
    const el = renderCard(connectionCardView("tools", input({ notes: { tools: "Could not share Linear. Try again." } })));
    expect(el.querySelector('[data-testid="connection-card-note"]')?.textContent).toBe("Could not share Linear. Try again.");
  });

  it("disables Connect at once and tells the host once, even on a double click", () => {
    const onaction = vi.fn(() => new Promise<void>(() => {}));
    const el = renderCard(connectionCardView("slack", input()), onaction);
    const button = primary(el)!;
    expect(button.disabled).toBe(false);
    button.click();
    button.click();
    flushSync();
    expect(onaction).toHaveBeenCalledTimes(1);
    expect(onaction).toHaveBeenCalledWith({ target: "slack", action: "connect" });
    expect(button.disabled).toBe(true);
  });

  it("acts once on a double click even when the host answers at once", async () => {
    const onaction = vi.fn();
    const el = renderCard(connectionCardView("tools", input()), onaction);
    primary(el)!.click();
    await tick();
    primary(el)!.click();
    flushSync();
    expect(onaction).toHaveBeenCalledTimes(1);
    expect(primary(el)!.disabled).toBe(true);
  });

  it("can be pressed again once the host has handled the press", async () => {
    vi.useFakeTimers();
    const onaction = vi.fn(async () => {});
    const el = renderCard(connectionCardView("slack", input({ record: markConnecting(null, "slack", NOW) })), onaction);
    primary(el)!.click();
    flushSync();
    expect(primary(el)!.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    flushSync();
    expect(primary(el)!.disabled).toBe(false);
    primary(el)!.click();
    expect(onaction).toHaveBeenCalledTimes(2);
  });

  it("stays usable when the host's handler throws", async () => {
    vi.useFakeTimers();
    const onaction = vi.fn(() => {
      throw new Error("boom");
    });
    const el = renderCard(connectionCardView("slack", input()), onaction);
    expect(() => primary(el)!.click()).not.toThrow();
    await vi.advanceTimersByTimeAsync(700);
    flushSync();
    expect(primary(el)!.disabled).toBe(false);
  });

  it("draws each card on its own brand wallpaper, as a layer a screen reader skips", () => {
    const root = renderBlock({ views: views(), onaction: () => {} });
    const art = (which: ConnectTarget) => card(root, which).querySelector<HTMLElement>(".connection-card-art")!;
    expect(art("slack").getAttribute("aria-hidden")).toBe("true");
    expect(art("slack").style.backgroundImage).toContain("aurora");
    expect(art("tools").style.backgroundImage).toContain("node-constellation");
    // The words and the buttons are not inside the art layer.
    expect(art("slack").children).toHaveLength(0);
    expect(card(root, "slack").querySelector(".connection-card-glass")?.textContent).toContain("Slack");
  });

  it("shows the host's in-flight press as a disabled button", () => {
    const el = renderCard(connectionCardView("slack", input({ inFlight: new Set(["slack:connect"]) })));
    expect(primary(el)!.disabled).toBe(true);
  });

  it("offers each waiting connection with its own allow button", () => {
    const facts = toolFacts(
      {
        viewer: { canManageIntegrations: true },
        connections: [
          { id: "acct_linear", provider: "factory:linear", status: "connected", createdAt: "2026-10-02T14:00:00.000Z", access: { mode: "private" }, installation: { displayName: "Linear" } },
          { id: "acct_notion", provider: "factory:notion", status: "connected", createdAt: "2026-10-01T14:00:00.000Z", access: { mode: "shared" }, installation: null },
        ],
      },
      null,
    );
    const onaction = vi.fn(() => new Promise<void>(() => {}));
    const el = renderCard(connectionCardView("tools", input({ tools: facts })), onaction);
    const rows = [...el.querySelectorAll<HTMLElement>('[data-testid="connection-card-row"]')];
    expect(rows.map((row) => row.querySelector(".connection-card-row-name")?.textContent)).toEqual(["Linear", "Notion"]);
    const allow = rows.map((row) => row.querySelector<HTMLButtonElement>('[data-testid="connection-card-allow"]')!);
    expect(allow[0].textContent?.trim()).toBe("Let Nova use it");
    allow[0].click();
    allow[0].click();
    flushSync();
    expect(onaction).toHaveBeenCalledTimes(1);
    expect(onaction).toHaveBeenCalledWith({ target: "tools", action: "allow", connectionId: "acct_linear" });
    expect(allow[0].disabled).toBe(true);
    // The other row is its own press.
    expect(allow[1].disabled).toBe(false);
  });
});

describe("Not now", () => {
  it("leads to the declined card with no button", () => {
    // The host keeps the record; the card is redrawn from the model.
    let record: BotConnectionRecord | null = null;
    const seen: ConnectionCardActionDetail[] = [];
    const onaction = (detail: ConnectionCardActionDetail): void => {
      seen.push(detail);
      if (detail.action === "decline") record = markDeclined(record, detail.target, NOW);
      props.connections = { views: views({ record }), onaction };
    };
    const props = $state<{ content: typeof BLOCK; connections: ConnectionCards }>({
      content: BLOCK,
      connections: { views: views(), onaction },
    });
    const root = target();
    component = mount(RichMessageContent, { target: root, props });
    flushSync();
    expect(card(root, "slack").dataset.state).toBe("offered");
    decline(card(root, "slack"))!.click();
    flushSync();
    expect(seen).toEqual([{ target: "slack", action: "decline" }]);
    expect(card(root, "slack").dataset.state).toBe("declined");
    expect(card(root, "slack").querySelectorAll("button")).toHaveLength(0);
    expect(card(root, "slack").textContent).toContain("Not connected. Ask Nova about Slack any time.");
    // The other card is its own decision.
    expect(card(root, "tools").dataset.state).toBe("offered");
    decline(card(root, "tools"))!.click();
    flushSync();
    expect(card(root, "tools").dataset.state).toBe("declined");
    expect(card(root, "tools").querySelectorAll("button")).toHaveLength(0);
  });
});

describe("ChannelConversation with connection cards", () => {
  const HELLO: ConversationMessageWire = {
    eventId: "evt_hello",
    direction: "in" as const,
    fromPersonUid: "agt_nova",
    fromDisplayName: "Nova",
    body: "Hi Corey, I am Nova. What can I help with first?",
    createdAt: "2026-10-02T14:00:00.000Z",
  };
  const OFFER: ConversationMessageWire = {
    eventId: "evt_offer",
    direction: "in" as const,
    fromPersonUid: "agt_nova",
    fromDisplayName: "Nova",
    body: 'I need Slack for that.\n```hq-block\n{"v":1,"blocks":[{"kind":"connect","targets":["slack"]}]}\n```',
    createdAt: "2026-10-02T14:10:00.000Z",
  };

  function mountConversation(props: Record<string, unknown>): HTMLElement {
    const root = target();
    component = mount(ChannelConversation, { target: root, props: { messages: [HELLO, OFFER], ...props } as never });
    flushSync();
    return root;
  }
  const message = (root: HTMLElement, eventId: string) =>
    root.querySelector<HTMLElement>(`[data-testid="conversation-message"][data-event-id="${eventId}"]`)!;

  it("attaches the host's extra blocks to a message that carried none", () => {
    const viewsFor = vi.fn((_message: { eventId: string }) => views());
    const root = mountConversation({
      connections: { viewsFor, onaction: () => {} },
      extraBlocksByEventId: { evt_hello: [{ kind: "connect", targets: ["slack", "tools"] }] },
    });
    const hello = message(root, "evt_hello");
    expect(hello.textContent).toContain("Hi Corey, I am Nova.");
    expect(cards(hello).map((el) => el.dataset.target)).toEqual(["slack", "tools"]);
    // A block the bot wrote itself draws the same way.
    expect(cards(message(root, "evt_offer")).map((el) => el.dataset.target)).toEqual(["slack"]);
    // The host builds the views per message.
    expect(viewsFor.mock.calls.map(([msg]) => msg.eventId)).toEqual(
      expect.arrayContaining(["evt_hello", "evt_offer"]),
    );
  });

  it("shows a card in a message newer than a Not now as offered again", () => {
    const record = markDeclined(null, "slack", Date.parse("2026-10-02T14:05:00.000Z"));
    const root = mountConversation({
      connections: {
        viewsFor: (msg: ConversationMessageWire) => views({ record, messageAt: Date.parse(msg.createdAt ?? "") }),
        onaction: () => {},
      },
      extraBlocksByEventId: { evt_hello: [{ kind: "connect", targets: ["slack", "tools"] }] },
    });
    expect(card(message(root, "evt_hello"), "slack").dataset.state).toBe("declined");
    expect(card(message(root, "evt_offer"), "slack").dataset.state).toBe("offered");
  });

  it("draws no card without the host's cards: a channel or a conversation between people", () => {
    const root = mountConversation({
      extraBlocksByEventId: { evt_hello: [{ kind: "connect", targets: ["slack", "tools"] }] },
    });
    expect(cards(root)).toEqual([]);
    expect(message(root, "evt_offer").textContent).toContain("I need Slack for that.");
    expect(root.textContent).not.toContain("hq-block");
  });

  it("sends a press to the host", () => {
    const onaction = vi.fn();
    const root = mountConversation({ connections: { viewsFor: () => views(), onaction } });
    primary(card(message(root, "evt_offer"), "slack"))!.click();
    expect(onaction).toHaveBeenCalledWith({ target: "slack", action: "connect" });
  });
});
