// @vitest-environment happy-dom

// Integration cards: one card per app the bot named, drawn from views the
// app built. The logo is the app's bundled brand mark, else the generic app
// glyph: never a badge made from the name, and never an image from another
// host.
// A row is a grid, with a quiet browse-all link under it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import ConnectionCard from "./ConnectionCard.svelte";
import ConnectionCardLogo from "./ConnectionCardLogo.svelte";
import RichMessageContent from "./RichMessageContent.svelte";
import { siGmail, siIntercom, siLinear } from "simple-icons";
import {
  connectionCardView,
  markAppConnecting,
  markAppDeclined,
  recordGrant,
  type ConnectionCardLogo as CardLogo,
  type ConnectionCards,
  type ConnectionCardView,
} from "./connection-card-model.js";
import { appLogo, integrationCardView, readCompanyConnections, slackFirst, type CatalogLookup, type IntegrationCardInput } from "./integration-cards-model.js";
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
    // The app's own sentence is the line; the bot's reason sits under it with the bot's name on it.
    expect(el.querySelector('[data-testid="connection-card-line"]')?.textContent).toBe("Connect Linear so Nova can use it.");
    const reason = el.querySelector<HTMLElement>('[data-testid="connection-card-reason"]')!;
    expect(reason.textContent).toBe("Nova says: Your issues live here");
    expect(reason.getAttribute("title")).toBe("Nova says: Your issues live here");
    expect(reason.previousElementSibling?.getAttribute("data-testid")).toBe("connection-card-line");
    expect(primary(el)?.textContent?.trim()).toBe("Connect Linear");
    expect(primary(el)?.dataset.action).toBe("connect");
    expect(decline(el)?.textContent?.trim()).toBe("Not now");
    expect(el.getAttribute("style")).toBeNull();
  });

  it("draws no reason line when the bot gave none, and binds a reason as text", () => {
    const plain = renderCard(view("linear.app", { lookup: LINEAR }));
    expect(plain.querySelector('[data-testid="connection-card-reason"]')).toBeNull();
    void unmount(component!);
    component = null;
    host?.remove();
    const markup = renderCard(view("linear.app", { lookup: LINEAR }, '<img src=x onerror=alert(1)> <b>bold</b>'));
    const reason = markup.querySelector<HTMLElement>('[data-testid="connection-card-reason"]')!;
    expect(reason.textContent).toBe('Nova says: <img src=x onerror=alert(1)> <b>bold</b>');
    expect(reason.querySelector("img, b")).toBeNull();
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
    expect(el.textContent).toContain("Let Nova use it?");
    expect(primary(el)?.textContent?.trim()).toBe("Let Nova use it");
    expect(decline(el)).toBeNull();
    primary(el)!.click();
    expect(onaction.mock.calls[0]![0]).toEqual({ target: "integration", action: "allow", connectionId: "acct_linear", domain: "linear.app" });
  });

  it("a connected app the bot can use, and a teammate's, have no button", () => {
    const usable = renderCard(view("linear.app", { facts: facts([connection()]), record: recordGrant(null, "acct_linear", "Linear", NOW) }));
    expect(usable.textContent).toContain("Nova can use it.");
    expect(usable.querySelectorAll("button")).toHaveLength(0);
    void unmount(component!);
    component = null;
    host?.remove();
    const theirs = renderCard(view("linear.app", { facts: facts([connection({ createdBy: "prs_other" })]) }));
    expect(theirs.textContent).toContain("A teammate connected this. Ask them to share it with Nova.");
    expect(theirs.querySelectorAll("button")).toHaveLength(0);
    // The mark says Connected once; the line under it does not say it again,
    // and its title holds the whole sentence.
    const line = theirs.querySelector<HTMLElement>('[data-testid="connection-card-line"]')!;
    expect(theirs.querySelector('[data-testid="connection-card-mark"]')?.textContent?.trim()).toBe("Connected");
    expect(line.textContent).toBe("A teammate connected this. Ask them to share it with Nova.");
    expect(line.getAttribute("title")).toBe(line.textContent);
    expect(theirs.textContent?.match(/Connected/g)).toHaveLength(1);
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
  /** An app with no bundled mark: the generic glyph. */
  const NO_MARK: CardLogo = { mark: null };
  const logoMark = (el: ParentNode) => el.querySelector<SVGElement>('[data-testid="connection-card-logo-mark"]');
  const generic = (el: ParentNode) => el.querySelector<HTMLElement>('[data-testid="connection-card-logo-generic"]');

  function renderLogo(logo: CardLogo = NO_MARK, size = 28): HTMLElement {
    const root = target();
    component = mount(ConnectionCardLogo, { target: root, props: { logo, size } });
    flushSync();
    return logoBox(root);
  }

  it("draws a bundled brand mark at once, in the brand's colour, with no image and no letters", () => {
    const box = renderLogo(appLogo("linear.app"));
    expect(box.dataset.logo).toBe("mark");
    expect(box.dataset.tile).toBe("light");
    expect(box.style.width).toBe("28px");
    expect(box.style.height).toBe("28px");
    expect(box.getAttribute("aria-hidden")).toBe("true");
    const mark = logoMark(box)!;
    expect(mark.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(mark.getAttribute("width")).toBe("18");
    expect(mark.getAttribute("fill")).toBe(`#${siLinear.hex}`);
    expect(mark.querySelector("path")?.getAttribute("d")).toBe(siLinear.path);
    expect(logoImg(box)).toBeNull();
    expect(generic(box)).toBeNull();
    expect(box.textContent?.trim()).toBe("");
  });

  it("puts a light-coloured mark on a dark tile", () => {
    const box = renderLogo(appLogo("intercom.com"));
    expect(box.dataset.logo).toBe("mark");
    expect(box.dataset.tile).toBe("dark");
    expect(logoMark(box)?.getAttribute("fill")).toBe(`#${siIntercom.hex}`);
  });

  it("shows the generic glyph for an app with no bundled mark, and asks no other host for an image", () => {
    const box = renderLogo(appLogo("example.com"));
    expect(box.dataset.logo).toBe("generic");
    expect(box.dataset.tile).toBe("glass");
    expect(generic(box)?.querySelector('[data-testid="connection-card-icon-generic"]')).not.toBeNull();
    expect(logoMark(box)).toBeNull();
    expect(box.textContent?.trim()).toBe("");
    // The app's image policy names one remote origin. A logo fetched by
    // domain would let a domain a bot writes make the webview call a third
    // party with no click, so the box holds no image at all.
    expect(box.querySelector("img")).toBeNull();
    expect(box.innerHTML).not.toContain("http");
  });

  it("ignores image sources on a logo it is handed: only the mark is read", () => {
    const stale = { mark: null, sources: ["https://t0.gstatic.com/faviconV2?x=1", "https://icons.duckduckgo.com/ip3/example.com.ico"] } as CardLogo;
    const box = renderLogo(stale);
    expect(box.dataset.logo).toBe("generic");
    expect(box.querySelector("img")).toBeNull();
    expect(box.innerHTML).not.toContain("gstatic");
    expect(box.innerHTML).not.toContain("duckduckgo");
  });

  it("keeps the same box when the card is drawn again with the same logo, and swaps for a new one", () => {
    // The host rebuilds every card view on its clock, so the logo arrives as
    // a new object with the same mark.
    const root = target();
    const props = $state({ logo: appLogo("linear.app") as CardLogo, size: 28 });
    component = mount(ConnectionCardLogo, { target: root, props });
    flushSync();
    const box = logoBox(root);
    const first = logoMark(box)!;
    props.logo = appLogo("linear.app");
    flushSync();
    expect(logoMark(box)).toBe(first);
    props.logo = appLogo("example.com");
    flushSync();
    expect(logoMark(box)).toBeNull();
    expect(generic(box)).not.toBeNull();
    expect(box.dataset.logo).toBe("generic");
  });

  it("sizes the mark and the glyph from the box, so the modal's larger box gets a larger logo", () => {
    const mark = renderLogo(appLogo("github.com"), 34);
    expect(logoMark(mark)?.getAttribute("width")).toBe("24");
    void unmount(component!);
    component = null;
    host?.remove();
    const glyph = renderLogo(NO_MARK, 34);
    expect(glyph.style.width).toBe("34px");
    expect(generic(glyph)).not.toBeNull();
  });

  it("is in the card's header: a bundled mark for Linear, the generic glyph for an app without one, and Slack's own mark", () => {
    const linear = renderCard(view("linear.app", { lookup: LINEAR }));
    expect(logoMark(logoBox(linear))).not.toBeNull();
    expect(logoImg(linear)).toBeNull();
    expect(linear.querySelector(".connection-card-icon")).toBeNull();
    void unmount(component!);
    component = null;
    host?.remove();
    const example = renderCard(view("example.com", { lookup: EXAMPLE }));
    expect(logoMark(logoBox(example))).toBeNull();
    expect(generic(logoBox(example))).not.toBeNull();
    expect(example.querySelector("img")).toBeNull();
    void unmount(component!);
    component = null;
    host?.remove();
    const slack = renderCard(connectionCardView("slack", { botName: "Nova", now: NOW }));
    expect(slack.querySelector('[data-testid="connection-card-logo"]')).toBeNull();
    expect(slack.querySelector('.connection-card-icon [data-testid="connection-card-icon-slack"]')).not.toBeNull();
  });

  it("gives a connected card of the person's own the same logo path as a catalog card", () => {
    const own = renderCard(view("linear.app", { facts: facts([connection()]) }));
    expect(own.dataset.state).toBe("connected");
    expect(logoMark(logoBox(own))?.querySelector("path")?.getAttribute("d")).toBe(siLinear.path);
    void unmount(component!);
    component = null;
    host?.remove();
    // A connection the list gives no domain for: the app's own pick names it by id, under "{provider}.com".
    const bare = facts([connection({ id: "acct_gmail", provider: "factory:gmail", installation: { displayName: "Gmail (Stefan)" } })]);
    const gmail = renderCard(
      integrationCardView({ domain: "gmail.com", connectionId: "acct_gmail" }, { botName: "Nova", now: NOW, lookup: "unknown", facts: bare })!,
    );
    expect(gmail.dataset.state).toBe("connected");
    expect(logoMark(logoBox(gmail))?.querySelector("path")?.getAttribute("d")).toBe(siGmail.path);
    expect(gmail.textContent).not.toContain("G(");
  });
});

describe("a row of integration cards in a message", () => {
  // A connect block keeps three items at most (owner: never four cards).
  const BLOCK = parseRichContent({
    v: 1,
    blocks: [
      {
        kind: "connect",
        items: [{ app: "slack" }, { domain: "linear.app", why: "Your issues live here" }, { domain: "notion.so" }],
      },
    ],
  })!;
  /** A second block: a no-auth app, a key app, and one nobody knows. */
  const MORE = parseRichContent({
    v: 1,
    blocks: [{ kind: "connect", items: [{ domain: "asana.com" }, { domain: "example.com" }, { domain: "unknown-app.io" }] }],
  })!;

  const lookups: Record<string, CatalogLookup> = {
    "linear.app": LINEAR,
    "example.com": EXAMPLE,
    "asana.com": { domain: "asana.com", name: "Asana", authClass: "none" },
    "unknown-app.io": "not-found",
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
    ]);
    expect(cards(root).every((el) => el.parentElement === row)).toBe(true);
    // Neighbours do not share a wallpaper.
    const arts = cards(root).map((el) => el.querySelector<HTMLElement>(".connection-card-art")!.style.backgroundImage);
    for (let i = 1; i < arts.length; i += 1) expect(arts[i]).not.toBe(arts[i - 1]);
    void unmount(component!);
    component = null;
    host?.remove();
    // A no-auth app and a key app each get a card; a domain nobody knows gets none.
    const more = renderBlock(cardsFor(), MORE);
    expect(cards(more).map((el) => [el.dataset.target, el.dataset.domain ?? null, el.dataset.state])).toEqual([
      ["integration", "asana.com", "offered"],
      ["integration", "example.com", "offered"],
    ]);
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
    expect(cards(noLink)).toHaveLength(3);
    expect(noLink.querySelector('[data-testid="rich-connect-browse"]')).toBeNull();
  });

  it("draws nothing while the host says the row is not ready (the company's list is unknown), and the row once it is", () => {
    const root = renderBlock(cardsFor({ rowReady: () => false }));
    expect(cards(root)).toHaveLength(0);
    expect(root.querySelector('[data-testid="rich-connect"]')).toBeNull();
    void unmount(component!);
    component = null;
    host?.remove();
    const ready = renderBlock(cardsFor({ rowReady: () => true }));
    expect(cards(ready)).toHaveLength(3);
  });

  it("draws the cards it knows at once, and adds an app at the end when its lookup answers: no card on screen moves", () => {
    // The block names Linear first. Its catalog lookup is still out, so it
    // has no card yet; Slack and the connected Notion draw without it.
    const first = parseRichContent({ v: 1, blocks: [{ kind: "connect", items: [{ domain: "linear.app" }, { app: "slack" }, { domain: "notion.so" }] }] })!;
    const known = $state<{ lookups: Record<string, CatalogLookup> }>({ lookups: {} });
    const props = $state({
      content: first,
      connections: {
        ...cardsFor(),
        integration: (item: { domain: string; why?: string }) =>
          integrationCardView(item, { botName: "Nova", now: NOW, facts: COMPANY, lookup: known.lookups[item.domain] ?? "unknown" }),
      } as ConnectionCards,
    });
    const root = target();
    component = mount(RichMessageContent, { target: root, props });
    flushSync();
    const ids = () => cards(root).map((el) => el.dataset.domain ?? el.dataset.target);
    expect(ids()).toEqual(["slack", "notion.so"]);
    const [slackEl, notionEl] = cards(root);
    const artOf = (el: HTMLElement) => el.querySelector<HTMLElement>(".connection-card-art")!.style.backgroundImage;
    const artBefore = [artOf(slackEl!), artOf(notionEl!)];

    // The lookup answers: Linear's card joins after the two already there.
    known.lookups = { "linear.app": LINEAR };
    flushSync();
    expect(ids()).toEqual(["slack", "notion.so", "linear.app"]);
    // The same two elements, in the same places, with the same wallpaper.
    expect(cards(root)[0]).toBe(slackEl);
    expect(cards(root)[1]).toBe(notionEl);
    expect([artOf(slackEl!), artOf(notionEl!)]).toEqual(artBefore);

    // An answer of "not found" adds nothing and moves nothing.
    known.lookups = { "linear.app": LINEAR, "asana.com": "not-found" };
    flushSync();
    expect(ids()).toEqual(["slack", "notion.so", "linear.app"]);
  });

  it("with the cloud bot's order, draws the bot's own Slack card first from the first frame, and a late app joins after it", () => {
    // Owner, 2026-10-05: "make sure that Slack is the first card every time".
    // The block names no Slack; Linear's lookup is still out at first.
    const first = parseRichContent({ v: 1, blocks: [{ kind: "connect", items: [{ domain: "linear.app" }, { domain: "notion.so" }] }] })!;
    const known = $state<{ lookups: Record<string, CatalogLookup> }>({ lookups: {} });
    const props = $state({
      content: first,
      connections: {
        ...cardsFor({ arrange: slackFirst }),
        integration: (item: { domain: string; why?: string }) =>
          integrationCardView(item, { botName: "Nova", now: NOW, facts: COMPANY, lookup: known.lookups[item.domain] ?? "unknown" }),
      } as ConnectionCards,
    });
    const root = target();
    component = mount(RichMessageContent, { target: root, props });
    flushSync();
    const ids = () => cards(root).map((el) => el.dataset.domain ?? el.dataset.target);
    expect(ids()).toEqual(["slack", "notion.so"]);
    const slackEl = cards(root)[0];
    known.lookups = { "linear.app": LINEAR };
    flushSync();
    expect(ids()).toEqual(["slack", "notion.so", "linear.app"]);
    expect(cards(root)[0]).toBe(slackEl);
  });

  it("with the cloud bot's order, moves Slack named third to the front and draws it once", () => {
    const block = parseRichContent({ v: 1, blocks: [{ kind: "connect", items: [{ domain: "linear.app" }, { domain: "notion.so" }, { domain: "slack.com" }] }] })!;
    const root = renderBlock(cardsFor({ arrange: slackFirst }), block);
    expect(cards(root).map((el) => el.dataset.domain ?? el.dataset.target)).toEqual(["slack", "linear.app", "notion.so"]);
  });

  it("draws at most three cards when the host's order adds Slack", () => {
    const block = parseRichContent({ v: 1, blocks: [{ kind: "connect", items: [{ domain: "linear.app" }, { domain: "notion.so" }, { domain: "asana.com" }] }] })!;
    const root = renderBlock(
      cardsFor({
        arrange: slackFirst,
        integration: (item) => integrationCardView(item, { botName: "Nova", now: NOW, facts: COMPANY, lookup: { domain: item.domain, name: item.domain, authClass: "oauth" } }),
      }),
      block,
    );
    expect(cards(root).map((el) => el.dataset.domain ?? el.dataset.target)).toEqual(["slack", "linear.app", "notion.so"]);
  });

  it("draws a row whose apps were all known from the start in the block's order", () => {
    const block = parseRichContent({ v: 1, blocks: [{ kind: "connect", items: [{ domain: "linear.app" }, { app: "slack" }, { domain: "notion.so" }] }] })!;
    const root = renderBlock(cardsFor(), block);
    expect(cards(root).map((el) => el.dataset.domain ?? el.dataset.target)).toEqual(["linear.app", "slack", "notion.so"]);
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
    // The logo is the app's bundled Linear mark, not the bot's picture.
    expect(root.querySelector('[data-testid="connection-card-logo-mark"] path')?.getAttribute("d")).toBe(siLinear.path);
    expect(logoImg(root)).toBeNull();
  });
});
