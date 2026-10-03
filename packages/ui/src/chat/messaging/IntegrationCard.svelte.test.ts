// @vitest-environment happy-dom

// Integration cards: one card per app the bot named, drawn from views the
// app built. The logo is a badge first and a favicon once one loads. A row
// is a grid, with a quiet browse-all link under it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import ConnectionCard from "./ConnectionCard.svelte";
import ConnectionCardLogo from "./ConnectionCardLogo.svelte";
import RichMessageContent from "./RichMessageContent.svelte";
import { connectionCardView, markAppConnecting, markAppDeclined, recordGrant, type ConnectionCards, type ConnectionCardView } from "./connection-card-model.js";
import { integrationCardView, readCompanyConnections, type CatalogLookup, type IntegrationCardInput } from "./integration-cards-model.js";
import { parseRichContent } from "./richMessageContent.js";

const NOW = Date.parse("2026-10-02T15:00:00.000Z");

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function target(): HTMLDivElement {
  host = document.createElement("div");
  host.className = "chat-shell";
  document.body.appendChild(host);
  return host;
}

const connection = (over: Record<string, unknown> = {}) => ({
  id: "acct_linear",
  provider: "factory:linear",
  status: "connected",
  createdBy: "prs_me",
  createdAt: "2026-10-02T14:10:00.000Z",
  access: { mode: "private", grantCount: 0 },
  installation: { displayName: "Linear", domain: "linear.app" },
  ...over,
});

const facts = (connections: Record<string, unknown>[] = []) =>
  readCompanyConnections({
    viewer: { personUid: "prs_me", canManageIntegrations: true },
    connections,
    audit: [],
  })!;

const LINEAR: CatalogLookup = { domain: "linear.app", name: "Linear", authClass: "oauth" };
const EXAMPLE: CatalogLookup = { domain: "example.com", name: "Example", authClass: "key" };

function view(domain: string, over: Partial<IntegrationCardInput> = {}, why?: string): ConnectionCardView {
  return integrationCardView({ domain, ...(why ? { why } : {}) }, { botName: "Nova", now: NOW, lookup: "unknown", facts: facts(), ...over })!;
}

const cards = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('[data-testid="connection-card"]')];
const primary = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-testid="connection-card-primary"]');
const decline = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-testid="connection-card-decline"]');
const logoBox = (el: ParentNode) => el.querySelector<HTMLElement>('[data-testid="connection-card-logo"]')!;
const logoImg = (el: ParentNode) => el.querySelector<HTMLImageElement>('[data-testid="connection-card-logo-img"]');

function renderCard(v: ConnectionCardView, onaction = vi.fn(), index = 0): HTMLElement {
  const root = target();
  component = mount(ConnectionCard, { target: root, props: { view: v, onaction, index } });
  flushSync();
  return cards(root)[0]!;
}

describe("an integration card", () => {
  it("is marked as an integration with its domain, and keeps the card test ids", () => {
    const el = renderCard(view("linear.app", { lookup: LINEAR }, "Your issues live here"));
    expect(el.dataset.target).toBe("integration");
    expect(el.dataset.kind).toBe("integration");
    expect(el.dataset.domain).toBe("linear.app");
    expect(el.dataset.state).toBe("offered");
    expect(el.getAttribute("aria-label")).toBe("Linear");
    expect(el.querySelector('[data-testid="connection-card-line"]')?.textContent).toBe("Your issues live here");
    expect(primary(el)?.textContent?.trim()).toBe("Connect Linear");
    expect(primary(el)?.dataset.action).toBe("connect");
    expect(decline(el)?.textContent?.trim()).toBe("Not now");
    expect(el.getAttribute("style")).toBeNull();
  });

  it("shows each state as its own state", () => {
    const states: Array<[string, ConnectionCardView]> = [
      ["offered", view("linear.app", { lookup: LINEAR })],
      ["connecting", view("linear.app", { lookup: LINEAR, record: markAppConnecting(null, "linear.app", NOW) })],
      ["connected", view("linear.app", { facts: facts([connection({ access: { mode: "everyone" } })]) })],
      ["declined", view("linear.app", { lookup: LINEAR, record: markAppDeclined(null, "linear.app", NOW) })],
    ];
    for (const [state, v] of states) {
      const el = renderCard(v);
      expect(el.dataset.state).toBe(state);
      void unmount(component!);
      component = null;
      host?.remove();
    }
  });

  it("a key app's button opens a dialog, an OAuth app's connects", () => {
    expect(primary(renderCard(view("example.com", { lookup: EXAMPLE })))?.getAttribute("aria-haspopup")).toBe("dialog");
    void unmount(component!);
    component = null;
    host?.remove();
    expect(primary(renderCard(view("linear.app", { lookup: LINEAR })))?.getAttribute("aria-haspopup")).toBeNull();
  });

  it("sends the press to the host with the domain, once", async () => {
    const onaction = vi.fn();
    const el = renderCard(view("linear.app", { lookup: LINEAR }), onaction);
    primary(el)!.click();
    primary(el)!.click();
    await Promise.resolve();
    expect(onaction).toHaveBeenCalledTimes(1);
    expect(onaction.mock.calls[0]![0]).toEqual({ target: "integration", action: "connect", domain: "linear.app" });
    decline(el)!.click();
    expect(onaction.mock.calls[1]![0]).toEqual({ target: "integration", action: "decline", domain: "linear.app" });
  });

  it("a connected app of the person's own offers Let the bot use it, with the connection on the press", () => {
    const onaction = vi.fn();
    const el = renderCard(view("linear.app", { facts: facts([connection()]) }), onaction);
    expect(el.dataset.state).toBe("connected");
    expect(el.querySelector('[data-testid="connection-card-mark"]')?.textContent?.trim()).toBe("Connected");
    expect(el.textContent).toContain("Connected. Let Nova use it?");
    expect(primary(el)?.textContent?.trim()).toBe("Let Nova use it");
    expect(decline(el)).toBeNull();
    primary(el)!.click();
    expect(onaction.mock.calls[0]![0]).toEqual({ target: "integration", action: "allow", connectionId: "acct_linear", domain: "linear.app" });
  });

  it("a connected app the bot can use, and a teammate's, have no button", () => {
    const usable = renderCard(view("linear.app", { facts: facts([connection()]), record: recordGrant(null, "acct_linear", "Linear", NOW) }));
    expect(usable.textContent).toContain("Connected. Nova can use it.");
    expect(usable.querySelectorAll("button")).toHaveLength(0);
    void unmount(component!);
    component = null;
    host?.remove();
    const theirs = renderCard(view("linear.app", { facts: facts([connection({ createdBy: "prs_other" })]) }));
    expect(theirs.textContent).toContain("Connected by a teammate. Ask them to share it with Nova.");
    expect(theirs.querySelectorAll("button")).toHaveLength(0);
  });

  it("draws a declined card dimmed with no button, and a connecting card with Open again", () => {
    const declined = renderCard(view("linear.app", { lookup: LINEAR, record: markAppDeclined(null, "linear.app", NOW) }));
    expect(declined.textContent).toContain("Not connected. Ask Nova any time.");
    expect(declined.querySelectorAll("button")).toHaveLength(0);
    void unmount(component!);
    component = null;
    host?.remove();
    const connecting = renderCard(view("linear.app", { lookup: LINEAR, record: markAppConnecting(null, "linear.app", NOW) }));
    expect(connecting.textContent).toContain("Finish in your browser. This card updates when Linear is connected.");
    expect(primary(connecting)?.textContent?.trim()).toBe("Open again");
    expect(decline(connecting)?.textContent?.trim()).toBe("Not now");
  });

  it("rotates the wallpaper by place in the row, so neighbours differ", () => {
    const first = renderCard(view("linear.app", { lookup: LINEAR }), vi.fn(), 0);
    const art0 = first.querySelector<HTMLElement>(".connection-card-art")!.style.backgroundImage;
    void unmount(component!);
    component = null;
    host?.remove();
    const second = renderCard(view("linear.app", { lookup: LINEAR }), vi.fn(), 1);
    const art1 = second.querySelector<HTMLElement>(".connection-card-art")!.style.backgroundImage;
    expect(art0).not.toBe(art1);
    expect(art0).toContain("url(");
  });
});

describe("the logo", () => {
  const LOGO = { sources: ["https://t0.gstatic.com/faviconV2?x=1", "https://icons.duckduckgo.com/ip3/linear.app.ico"], monogram: "Li" };

  function renderLogo(logo = LOGO): HTMLElement {
    const root = target();
    component = mount(ConnectionCardLogo, { target: root, props: { logo, size: 28 } });
    flushSync();
    return logoBox(root);
  }

  it("shows the badge first, and a lazy image that tries the first source", () => {
    const box = renderLogo();
    expect(box.dataset.loaded).toBe("false");
    expect(box.querySelector('[data-testid="connection-card-logo-badge"]')?.textContent).toBe("Li");
    expect(box.style.width).toBe("28px");
    expect(box.style.height).toBe("28px");
    const img = logoImg(box)!;
    expect(img.getAttribute("src")).toBe(LOGO.sources[0]);
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
    expect(img.getAttribute("alt")).toBe("");
    expect(box.getAttribute("aria-hidden")).toBe("true");
  });

  it("replaces the badge once the image has loaded", () => {
    const box = renderLogo();
    logoImg(box)!.dispatchEvent(new Event("load"));
    flushSync();
    expect(box.dataset.loaded).toBe("true");
    // The badge stays in the box (hidden by style), so nothing moves.
    expect(box.querySelector('[data-testid="connection-card-logo-badge"]')).not.toBeNull();
    expect(box.style.width).toBe("28px");
  });

  it("falls through both sources on error and ends on the badge", () => {
    const box = renderLogo();
    logoImg(box)!.dispatchEvent(new Event("error"));
    flushSync();
    expect(logoImg(box)!.getAttribute("src")).toBe(LOGO.sources[1]);
    expect(box.dataset.loaded).toBe("false");
    logoImg(box)!.dispatchEvent(new Event("error"));
    flushSync();
    expect(logoImg(box)).toBeNull();
    expect(box.dataset.loaded).toBe("false");
    expect(box.textContent?.trim()).toBe("Li");
  });

  it("draws only the badge when there are no sources", () => {
    const box = renderLogo({ sources: [], monogram: "GD" });
    expect(logoImg(box)).toBeNull();
    expect(box.textContent?.trim()).toBe("GD");
  });

  it("is in the card's header, and Slack keeps its drawn icon", () => {
    const el = renderCard(view("linear.app", { lookup: LINEAR }));
    expect(logoBox(el)).not.toBeNull();
    expect(el.querySelector(".connection-card-icon")).toBeNull();
    void unmount(component!);
    component = null;
    host?.remove();
    const slack = renderCard(connectionCardView("slack", { botName: "Nova", now: NOW }));
    expect(slack.querySelector('[data-testid="connection-card-logo"]')).toBeNull();
    expect(slack.querySelector(".connection-card-icon svg")).not.toBeNull();
  });
});

describe("a row of integration cards in a message", () => {
  const BLOCK = parseRichContent({
    v: 1,
    blocks: [
      {
        kind: "connect",
        items: [
          { app: "slack" },
          { domain: "linear.app", why: "Your issues live here" },
          { domain: "notion.so" },
          { domain: "asana.com" },
          { domain: "example.com" },
          { domain: "unknown.example" },
        ],
      },
    ],
  })!;

  const lookups: Record<string, CatalogLookup> = {
    "linear.app": LINEAR,
    "example.com": EXAMPLE,
    "asana.com": { domain: "asana.com", name: "Asana", authClass: "none" },
    "unknown.example": "not-found",
  };
  const COMPANY = facts([connection({ id: "acct_notion", provider: "factory:notion", installation: { displayName: "Notion", domain: "notion.so" } })]);

  function cardsFor(over: Partial<ConnectionCards> = {}): ConnectionCards {
    return {
      views: { slack: connectionCardView("slack", { botName: "Nova", now: NOW }) },
      integration: (item) => integrationCardView(item, { botName: "Nova", now: NOW, facts: COMPANY, lookup: lookups[item.domain] ?? "unknown" }),
      browseAll: { url: "https://hq.computer/companies/acme/integrations", open: vi.fn() },
      onaction: () => {},
      ...over,
    };
  }

  function renderBlock(connections: ConnectionCards | null, content = BLOCK): HTMLElement {
    const root = target();
    component = mount(RichMessageContent, { target: root, props: { content, connections } });
    flushSync();
    return root;
  }

  it("draws one card per item that resolves, in the block's order, in a grid", () => {
    const root = renderBlock(cardsFor());
    const row = root.querySelector<HTMLElement>('[data-testid="rich-connect"]')!;
    expect(row).not.toBeNull();
    expect(cards(root).map((el) => [el.dataset.target, el.dataset.domain ?? null, el.dataset.state])).toEqual([
      ["slack", null, "offered"],
      ["integration", "linear.app", "offered"],
      ["integration", "notion.so", "connected"],
      ["integration", "asana.com", "offered"],
      ["integration", "example.com", "offered"],
    ]);
    expect(cards(root).every((el) => el.parentElement === row)).toBe(true);
    // Neighbours do not share a wallpaper.
    const arts = cards(root).map((el) => el.querySelector<HTMLElement>(".connection-card-art")!.style.backgroundImage);
    for (let i = 1; i < arts.length; i += 1) expect(arts[i]).not.toBe(arts[i - 1]);
  });

  it("offers the browse-all link under a row with an integration card, through the host", () => {
    const open = vi.fn();
    const root = renderBlock(cardsFor({ browseAll: { url: "https://hq.computer/companies/acme/integrations", open } }));
    const link = root.querySelector<HTMLAnchorElement>('[data-testid="rich-connect-browse"]')!;
    expect(link.textContent?.trim()).toBe("Browse all in HQ Integrations");
    expect(link.getAttribute("href")).toBe("https://hq.computer/companies/acme/integrations");
    link.click();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("offers no browse-all link under Slack alone, or without a link from the host", () => {
    const slackOnly = parseRichContent({ v: 1, blocks: [{ kind: "connect", items: [{ app: "slack" }] }] })!;
    const root = renderBlock(cardsFor(), slackOnly);
    expect(cards(root)).toHaveLength(1);
    expect(root.querySelector('[data-testid="rich-connect-browse"]')).toBeNull();
    void unmount(component!);
    component = null;
    host?.remove();
    const noLink = renderBlock(cardsFor({ browseAll: null }));
    expect(cards(noLink)).toHaveLength(5);
    expect(noLink.querySelector('[data-testid="rich-connect-browse"]')).toBeNull();
  });

  it("draws nothing while the host says the row is not ready, and the whole row once it is", () => {
    const root = renderBlock(cardsFor({ rowReady: () => false }));
    expect(cards(root)).toHaveLength(0);
    expect(root.querySelector('[data-testid="rich-connect"]')).toBeNull();
    void unmount(component!);
    component = null;
    host?.remove();
    const ready = renderBlock(cardsFor({ rowReady: () => true }));
    expect(cards(ready)).toHaveLength(5);
  });

  it("draws only the built-in cards when the host has no integration views", () => {
    const root = renderBlock(cardsFor({ integration: null }));
    expect(cards(root).map((el) => el.dataset.target)).toEqual(["slack"]);
  });

  it("uses no logo, link, label or style the bot put in the block", () => {
    const hostile = parseRichContent({
      v: 1,
      blocks: [{ kind: "connect", items: [{ domain: "linear.app", logo: "https://evil.example/l.png", url: "https://evil.example", label: "Free tokens" }] }],
    })!;
    const root = renderBlock(cardsFor(), hostile);
    expect(root.innerHTML).not.toContain("evil");
    expect(root.textContent).not.toContain("Free tokens");
    expect(logoImg(root)!.getAttribute("src")).toContain("t0.gstatic.com");
  });
});
