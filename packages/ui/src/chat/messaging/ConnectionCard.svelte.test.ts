// @vitest-environment happy-dom

// Connection cards: a `connect` block in a bot's message draws one card per
// target from views the host built. A press goes to the host, once.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { SLACK_MARK } from "./app-brand-marks.js";
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

  it("draws its icon in the same 28px box an integration card's logo takes, so header rows line up", () => {
    for (const which of ["slack", "tools"] as const) {
      const el = renderCard(connectionCardView(which, input()));
      const box = el.querySelector<HTMLElement>('[data-testid="connection-card-icon"]')!;
      expect(box).not.toBeNull();
      expect(box.parentElement?.classList.contains("connection-card-head")).toBe(true);
      expect(box.style.width).toBe("28px");
      expect(box.style.height).toBe("28px");
      expect(box.getAttribute("aria-hidden")).toBe("true");
      expect(box.dataset.icon).toBe(which);
      const svg = box.querySelector("svg")!;
      expect(svg.getAttribute("width")).toBe("18");
      // No words in the box: never a letter or two made from the name.
      expect(box.textContent?.trim()).toBe("");
      void unmount(component!);
      component = null;
      host?.remove();
    }
  });

  it("draws the real Slack mark, in Slack's colour, and the generic app glyph for the tools card", () => {
    const slack = renderCard(connectionCardView("slack", input()));
    const mark = slack.querySelector<SVGElement>('[data-testid="connection-card-icon-slack"]')!;
    expect(mark).not.toBeNull();
    expect(mark.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(mark.getAttribute("fill")).toBe(`#${SLACK_MARK.hex}`);
    expect(mark.querySelector("path")?.getAttribute("d")).toBe(SLACK_MARK.path);
    expect(slack.querySelector('[data-testid="connection-card-icon-generic"]')).toBeNull();
    void unmount(component!);
    component = null;
    host?.remove();
    const tools = renderCard(connectionCardView("tools", input()));
    const glyph = tools.querySelector<SVGElement>('[data-testid="connection-card-icon-generic"]')!;
    expect(glyph).not.toBeNull();
    expect(glyph.getAttribute("stroke")).toBe("currentColor");
    expect(tools.querySelector('[data-testid="connection-card-icon-slack"]')).toBeNull();
  });

  it("shows the note under the card", () => {
    const el = renderCard(connectionCardView("tools", input({ notes: { tools: "Could not share Linear. Try again." } })));
    expect(el.querySelector('[data-testid="connection-card-note"]')?.textContent).toBe("Could not share Linear. Try again.");
  });

  it("disables Connect at once and tells the host once, even on a double click", () => {
    const onaction = vi.fn(() => new Promise<void>(() => {}));
    // The tools card is the one that still connects at once.
    const el = renderCard(connectionCardView("tools", input()), onaction);
    const button = primary(el)!;
    expect(button.disabled).toBe(false);
    button.click();
    button.click();
    flushSync();
    expect(onaction).toHaveBeenCalledTimes(1);
    expect(onaction).toHaveBeenCalledWith({ target: "tools", action: "connect" });
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
    const el = renderCard(connectionCardView("tools", input({ record: markConnecting(null, "tools", NOW, []) })), onaction);
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

  it("a card that connects says nothing about a dialog", () => {
    const el = renderCard(connectionCardView("tools", input()));
    expect(primary(el)!.hasAttribute("aria-haspopup")).toBe(false);
    expect(primary(el)!.dataset.action).toBe("connect");
  });

  it("a main button that opens a modal says so and tells the host to open it, once", async () => {
    // The Slack card is switched over: its view says so by itself.
    const view = connectionCardView("slack", input());
    expect(view.primaryAction).toBe("open");
    const onaction = vi.fn();
    const el = renderCard(view, onaction);
    const button = primary(el)!;
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.dataset.action).toBe("open");
    expect(button.textContent?.trim()).toBe("Connect Slack");
    button.click();
    button.click();
    await tick();
    button.click();
    flushSync();
    expect(onaction).toHaveBeenCalledTimes(1);
    expect(onaction).toHaveBeenCalledWith({ target: "slack", action: "open" });
    // Never a connect: the host must not open the browser page as well.
    expect(onaction.mock.calls.some(([detail]) => (detail as ConnectionCardActionDetail).action === "connect")).toBe(false);
  });

  it("keeps the button that opened a modal focusable, with focus on it, so the dialog can give focus back", () => {
    const view = { ...connectionCardView("tools", input()), primaryAction: "open" as const };
    const el = renderCard(view, vi.fn(() => new Promise<void>(() => {})));
    const button = primary(el)!;
    button.click();
    flushSync();
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  it("can open its modal again once the host has handled the press", async () => {
    vi.useFakeTimers();
    const view = { ...connectionCardView("slack", input()), primaryAction: "open" as const };
    const onaction = vi.fn(async () => {});
    const el = renderCard(view, onaction);
    primary(el)!.click();
    await vi.advanceTimersByTimeAsync(700);
    flushSync();
    primary(el)!.click();
    expect(onaction).toHaveBeenCalledTimes(2);
  });

  it("holds the main button while the host says the open press is on its way", () => {
    const view = connectionCardView("slack", input({ modalTargets: new Set(["slack"] as const), inFlight: new Set(["slack:open"]) }));
    const el = renderCard(view);
    expect(primary(el)!.disabled).toBe(true);
    expect(decline(el)!.disabled).toBe(false);
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
    const el = renderCard(connectionCardView("tools", input({ inFlight: new Set(["tools:connect"]) })));
    expect(primary(el)!.disabled).toBe(true);
  });

  it("offers each waiting connection with its own allow button", () => {
    const facts = toolFacts(
      {
        viewer: { canManageIntegrations: true, personUid: "prs_me" },
        connections: [
          { id: "acct_linear", provider: "factory:linear", status: "connected", createdBy: "prs_me", createdAt: "2026-10-02T14:00:00.000Z", access: { mode: "private" }, installation: { displayName: "Linear" } },
          { id: "acct_notion", provider: "factory:notion", status: "connected", createdBy: "prs_me", createdAt: "2026-10-01T14:00:00.000Z", access: { mode: "shared" }, installation: null },
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

  it("a teammate's connection is never offered: no row and no allow button for it", () => {
    const facts = toolFacts(
      {
        viewer: { canManageIntegrations: true, personUid: "prs_me" },
        connections: [
          { id: "acct_gmail_theirs", provider: "factory:gmail", status: "connected", createdBy: "prs_teammate", createdAt: "2026-10-02T15:00:00.000Z", access: { mode: "private" }, installation: { displayName: "Gmail (Hassaan)" } },
          { id: "acct_gmail_mine", provider: "factory:gmail", status: "connected", createdBy: "prs_me", createdAt: "2026-10-02T14:00:00.000Z", access: { mode: "private" }, installation: { displayName: "Gmail (Corey)" } },
          { id: "acct_drive_theirs", provider: "factory:drive", status: "connected", createdBy: "prs_teammate", createdAt: "2026-10-01T14:00:00.000Z", access: { mode: "shared" }, installation: { displayName: "Drive (Hassaan)" } },
        ],
      },
      null,
    );
    const el = renderCard(connectionCardView("tools", input({ tools: facts })));
    const rows = [...el.querySelectorAll<HTMLElement>('[data-testid="connection-card-row"]')];
    expect(rows.map((row) => row.dataset.connectionId)).toEqual(["acct_gmail_mine"]);
    expect(el.querySelectorAll('[data-testid="connection-card-allow"]')).toHaveLength(1);
    expect(el.textContent).not.toContain("Hassaan");
    expect(el.querySelector('[data-testid="connection-card-more"]')).toBeNull();
  });
});

describe("a card that keeps one height", () => {
  function renderCard(view: ReturnType<typeof connectionCardView>): HTMLElement {
    const root = target();
    component = mount(ConnectionCard, { target: root, props: { view, onaction: vi.fn() } });
    flushSync();
    return root.querySelector<HTMLElement>('[data-testid="connection-card"]')!;
  }
  function waitingFacts(count: number, usable: string[] = []) {
    const at = (i: number): string => new Date(Date.parse("2026-09-01T00:00:00.000Z") + i * 3_600_000).toISOString();
    return toolFacts(
      {
        viewer: { canManageIntegrations: true, personUid: "prs_me" },
        connections: [
          ...usable.map((name, i) => ({
            id: `acct_open_${i}`,
            provider: `factory:${name.toLowerCase()}`,
            status: "connected",
            createdBy: "prs_me",
            createdAt: at(i),
            access: { mode: "everyone" },
            installation: { displayName: name },
          })),
          ...Array.from({ length: count }, (_, i) => ({
            id: `acct_${i}`,
            provider: "factory:app",
            status: "connected",
            createdBy: "prs_me",
            createdAt: at(i),
            access: { mode: "private" },
            installation: { displayName: `App ${i}` },
          })),
        ],
      },
      null,
    );
  }
  const scroller = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-testid="connection-card-scroll"]');

  it("puts every waiting row in one scroll area inside the glass, and the buttons outside it", () => {
    const el = renderCard(connectionCardView("tools", input({ tools: waitingFacts(17, ["Linear"]) })));
    const area = scroller(el)!;
    expect(area.querySelectorAll('[data-testid="connection-card-row"]')).toHaveLength(17);
    expect(area.closest(".connection-card-glass")).not.toBeNull();
    // The header and the line stay put: they are not in the scroll area.
    expect(area.querySelector(".connection-card-head")).toBeNull();
    expect(area.querySelector('[data-testid="connection-card-line"]')).toBeNull();
    // The button strip stays on the art, outside the glass and the scroll area.
    const strip = primary(el)!.parentElement!;
    expect(strip.closest(".connection-card-glass")).toBeNull();
    expect(strip.closest('[data-testid="connection-card-scroll"]')).toBeNull();
    expect(el.querySelector('[data-testid="connection-card-more"]')).toBeNull();
    // The card itself takes no inline size: the height is one constant in its style.
    expect(el.getAttribute("style")).toBeNull();
  });

  it("is 168px tall in every state, with the sentence on two rows at most, and the rows scroll inside", () => {
    // happy-dom does not lay out the component's stylesheet, so the rule is
    // read from the source: one constant, one clamp. Owner, 2026-10-03: the
    // 240px cards took too much room; about 168px, header, the sentence,
    // buttons. Owner, 2026-10-04: one row cut "Ask them to share it with
    // ..." off, so the sentence may take two rows. The card's height is the
    // same constant either way, so the cards of one row stay equal.
    // The stylesheet lives in connection-card.css, shared with the runtime repair card.
    const cardSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "connection-card.css"), "utf8");
    const heightRule = cardSource.match(/--cc-height:\s*(\d+)px/);
    expect(heightRule?.[1]).toBe("168");
    expect(cardSource).toMatch(/\.connection-card\s*\{[^}]*height:\s*var\(--cc-height\)/);
    // The height is set once, on the card, and no state changes it.
    expect(cardSource.match(/--cc-height:/g)).toHaveLength(1);
    expect(cardSource.match(/[^-]height:\s*var\(--cc-height\)/g)).toHaveLength(1);
    const line = cardSource.match(/\.connection-card-line\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(line).toMatch(/-webkit-line-clamp:\s*2\b/);
    expect(line).toMatch(/\bline-clamp:\s*2\b/);
    // The clamp only works with the shared box rule: the line, the reason and
    // the note together take the -webkit-box display, hidden overflow and
    // anywhere wrapping. (A rule once landed inside this selector list by
    // mistake and silently undid the clamp on every card.)
    const clampBlock =
      cardSource.match(/\.connection-card-line,\s*\.connection-card-reason,\s*\.connection-card-note\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(clampBlock).toMatch(/display:\s*-webkit-box/);
    expect(clampBlock).toMatch(/-webkit-box-orient:\s*vertical/);
    expect(clampBlock).toMatch(/overflow:\s*hidden/);
    expect(clampBlock).toMatch(/overflow-wrap:\s*anywhere/);
    expect(clampBlock).toMatch(/-webkit-line-clamp:\s*2\b/);
    // The bot's reason stays one row under it.
    const reason = cardSource.match(/\.connection-card-reason\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(reason).toMatch(/-webkit-line-clamp:\s*1\b/);
    // The scroll area keeps scrolling inside the shorter card.
    const scroll = cardSource.match(/\.connection-card-scroll\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(scroll).toMatch(/overflow-y:\s*auto/);
  });

  it("has no green edge in any state: a connected card keeps the neutral edge every other card has", () => {
    // Owner, 2026-10-05: "can we get rid of these green borders they're ugly".
    // happy-dom does not apply the component's stylesheet, so the rules are read from the source.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "connection-card.css"), "utf8");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
    for (const rule of rules) {
      if (!/border/.test(rule.body)) continue;
      // No border of a card or its glass is drawn in the green the "Connected" mark uses.
      expect(rule.body, rule.selector).not.toMatch(/border[^;]*(--cc-ok|#4ade80|#16a34a|74,\s*222,\s*128)/);
    }
    // No state sets a connected card's or its glass's edge at all.
    const connectedEdges = rules.filter(
      (rule) => /\[data-state="connected"\]/.test(rule.selector) && /border(-color)?\s*:/.test(rule.body),
    );
    expect(connectedEdges.map((rule) => rule.selector)).toEqual([]);
    // No left accent bar anywhere.
    expect(css).not.toMatch(/border-left\s*:/);
    // The "Connected" mark keeps its green.
    expect(css).toMatch(/\.connection-card\[data-state="connected"\] \.connection-card-icon\s*\{[^}]*var\(--cc-ok\)/);
  });

  it("makes the scroll area reachable from the keyboard, with a name", () => {
    const el = renderCard(connectionCardView("tools", input({ tools: waitingFacts(5) })));
    const area = scroller(el)!;
    expect(area.tabIndex).toBe(0);
    expect(area.getAttribute("role")).toBe("group");
    expect(area.getAttribute("aria-label")).toBe("Your connections");
  });

  it("has no scroll area when there are no rows", () => {
    const root = renderBlock({ views: views(), onaction: () => {} });
    expect(cards(root)).toHaveLength(2);
    expect(root.querySelector('[data-testid="connection-card-scroll"]')).toBeNull();
  });

  it("keeps the +N more line as the last line of the list, only beyond the cap", () => {
    const el = renderCard(connectionCardView("tools", input({ tools: waitingFacts(33) })));
    const area = scroller(el)!;
    expect(area.querySelectorAll('[data-testid="connection-card-row"]')).toHaveLength(30);
    const more = area.querySelector<HTMLElement>('[data-testid="connection-card-more"]')!;
    expect(more.textContent).toBe("+3 more in HQ Integrations");
    expect(area.lastElementChild).toBe(more);
  });

  it("fades the bottom edge of the list while more rows are below, and not at its end", () => {
    const el = renderCard(connectionCardView("tools", input({ tools: waitingFacts(17) })));
    const area = scroller(el)!;
    const fade = area.parentElement!;
    // No layout in this environment: nothing is below, so no fade.
    expect(fade.dataset.moreBelow).toBe("false");
    Object.defineProperty(area, "scrollHeight", { configurable: true, value: 680 });
    Object.defineProperty(area, "clientHeight", { configurable: true, value: 110 });
    area.scrollTop = 0;
    area.dispatchEvent(new Event("scroll"));
    flushSync();
    expect(fade.dataset.moreBelow).toBe("true");
    Object.defineProperty(area, "scrollTop", { configurable: true, value: 570 });
    area.dispatchEvent(new Event("scroll"));
    flushSync();
    expect(fade.dataset.moreBelow).toBe("false");
  });

  it("gives the full line and the full note as a title, for when they are cut at two lines", () => {
    const names = ["Gmail (Stefan)", "Firecrawl", "Granola API", "Zapier MCP", "Linear", "Notion", "Figma", "Stripe"];
    const el = renderCard(
      connectionCardView("tools", input({ tools: waitingFacts(2, names), notes: { tools: "Could not share Linear. Try again." } })),
    );
    const line = el.querySelector<HTMLElement>('[data-testid="connection-card-line"]')!;
    expect(line.textContent).toBe("Nova can use: Gmail (Stefan), Firecrawl, Granola API, Zapier MCP, Linear, Notion and 2 more.");
    expect(line.getAttribute("title")).toBe(line.textContent);
    const note = el.querySelector<HTMLElement>('[data-testid="connection-card-note"]')!;
    expect(note.getAttribute("title")).toBe("Could not share Linear. Try again.");
    // The note is on the glass, after the list, and never in the scroll area.
    expect(note.closest(".connection-card-glass")).not.toBeNull();
    expect(note.closest('[data-testid="connection-card-scroll"]')).toBeNull();
  });
});

describe("Not now", () => {
  it("leads to the declined card with no button", () => {
    // The host keeps the record; the card is redrawn from the model.
    let record: BotConnectionRecord | null = null;
    const seen: ConnectionCardActionDetail[] = [];
    const onaction = (detail: ConnectionCardActionDetail): void => {
      seen.push(detail);
      if (detail.action === "decline" && detail.target !== "integration") record = markDeclined(record, detail.target, NOW);
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

  /** The person's own message, with the same block in it: something they pasted or typed. */
  const MINE: ConversationMessageWire = {
    eventId: "evt_mine",
    direction: "out" as const,
    fromPersonUid: "prs_me",
    fromDisplayName: "Corey",
    body: 'Is this the block you mean?\n```hq-block\n{"v":1,"blocks":[{"kind":"connect","items":[{"app":"slack"},{"domain":"linear.app"}]}]}\n```',
    createdAt: "2026-10-02T14:12:00.000Z",
  };
  /** Someone who is neither the bot nor the person. */
  const OTHER: ConversationMessageWire = { ...MINE, eventId: "evt_other", direction: "in" as const, fromPersonUid: "prs_teammate", fromDisplayName: "Sam" };

  function mountConversation(props: Record<string, unknown>): HTMLElement {
    const root = target();
    // The host always says who is looking.
    component = mount(ChannelConversation, { target: root, props: { messages: [HELLO, OFFER], selfPersonUid: "prs_me", ...props } as never });
    flushSync();
    return root;
  }
  const message = (root: HTMLElement, eventId: string) =>
    root.querySelector<HTMLElement>(`[data-testid="conversation-message"][data-event-id="${eventId}"]`)!;

  it("attaches the host's extra blocks to a message that carried none", () => {
    const viewsFor = vi.fn((_message: { eventId: string }) => views());
    const root = mountConversation({
      connections: { cardsFor: (message: { eventId: string }) => ({ views: viewsFor(message), onaction: () => {} }) },
      extraBlocksByEventId: { evt_hello: [{ kind: "connect", items: [{ app: "slack" }, { app: "tools" }] }] },
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
        cardsFor: (msg: ConversationMessageWire) => ({
          views: views({ record, messageAt: Date.parse(msg.createdAt ?? "") }),
          onaction: () => {},
        }),
      },
      extraBlocksByEventId: { evt_hello: [{ kind: "connect", items: [{ app: "slack" }, { app: "tools" }] }] },
    });
    expect(card(message(root, "evt_hello"), "slack").dataset.state).toBe("declined");
    expect(card(message(root, "evt_offer"), "slack").dataset.state).toBe("offered");
  });

  it("draws no card without the host's cards: a channel or a conversation between people", () => {
    const root = mountConversation({
      extraBlocksByEventId: { evt_hello: [{ kind: "connect", items: [{ app: "slack" }, { app: "tools" }] }] },
    });
    expect(cards(root)).toEqual([]);
    expect(message(root, "evt_offer").textContent).toContain("I need Slack for that.");
    expect(root.textContent).not.toContain("hq-block");
  });

  it("draws no card under the person's own message, and never asks the host for one", () => {
    const hosts: Array<Record<string, unknown>> = [
      // The host names the bot on the cards, or as the one whose suggestions are drawn, or not at all.
      { botUid: "agt_nova" },
      {},
    ];
    for (const [index, named] of hosts.entries()) {
      for (const suggestionsFrom of index === 0 ? [null] : ["agt_nova", null]) {
        const cardsFor = vi.fn((_message: { eventId: string }) => ({ views: views(), integration: () => null, onaction: () => {} }));
        const root = mountConversation({ messages: [HELLO, OFFER, MINE], connections: { cardsFor, ...named }, suggestionsFrom });
        // The bot's own offer draws its card.
        expect(cards(message(root, "evt_offer")).map((el) => el.dataset.target)).toEqual(["slack"]);
        // The person's message is their words: no live Connect button under their name.
        const mine = message(root, "evt_mine");
        expect(cards(mine)).toEqual([]);
        expect(mine.querySelector("button[data-testid='connection-card-primary']")).toBeNull();
        expect(mine.textContent).toContain("Is this the block you mean?");
        expect(cardsFor.mock.calls.map(([msg]) => msg.eventId)).not.toContain("evt_mine");
        void unmount(component!);
        component = null;
        host?.remove();
      }
    }
  });

  it("draws cards only under the bot of this direct message when the host names it", () => {
    const cardsFor = vi.fn((_message: { eventId: string }) => ({ views: views(), onaction: () => {} }));
    const root = mountConversation({ messages: [HELLO, OFFER, OTHER], connections: { cardsFor, botUid: "agt_nova" } });
    expect(cards(message(root, "evt_offer")).map((el) => el.dataset.target)).toEqual(["slack"]);
    expect(cards(message(root, "evt_other"))).toEqual([]);
    expect(cardsFor.mock.calls.map(([msg]) => msg.eventId)).not.toContain("evt_other");
  });

  it("draws no card at all when nobody can say who sent a message", () => {
    const cardsFor = vi.fn((_message: { eventId: string }) => ({ views: views(), onaction: () => {} }));
    const root = mountConversation({ messages: [HELLO, OFFER, MINE], connections: { cardsFor }, selfPersonUid: null });
    expect(cards(root)).toEqual([]);
    expect(cardsFor).not.toHaveBeenCalled();
  });

  it("sends a press to the host", () => {
    const onaction = vi.fn();
    const root = mountConversation({ connections: { cardsFor: () => ({ views: views(), onaction }) } });
    primary(card(message(root, "evt_offer"), "slack"))!.click();
    // The Slack card's main button opens its modal.
    expect(onaction).toHaveBeenCalledWith({ target: "slack", action: "open" });
  });
});
