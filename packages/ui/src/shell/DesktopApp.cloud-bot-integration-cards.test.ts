// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { buildAgentHelloRequest } from "../chat/agent-channel.js";
import { brandMarkFor } from "../chat/messaging/app-brand-marks.js";
import { BOT_CONNECTION_CARDS_STORAGE_KEY, CONNECTING_TIMEOUT_MS } from "../chat/messaging/connection-card-model.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";

/**
 * One card per app the bot names: a bot's message with `items` draws a card
 * for each domain the app can resolve (a company connection, or a catalog
 * match), with the app's logo, and connects from the card by auth class.
 */

const NOVA = "agt_nova";
const COMPANY = "cmp_acme";
const NEW_BOTS_KEY = "hq.chat.newCloudBots.v1";

const ACME = {
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "synced",
  cloudUid: COMPANY,
  bucketName: null,
  hasLocalFolder: true,
  localPath: null,
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
} as unknown as Workspace;

const fence = (blocks: unknown[]): string => `\n\`\`\`hq-block\n${JSON.stringify({ v: 1, blocks })}\n\`\`\``;

type Row = Record<string, unknown>;

/** The bot's own connect block: Slack, an OAuth app, a connected app, a no-auth app, a key app, and one nobody knows. */
const ITEMS = [
  { app: "slack" },
  { domain: "linear.app", why: "Your team's issues live here" },
  { domain: "notion.so" },
  { domain: "deepwiki.com" },
  { domain: "example.com" },
  { domain: "unknown-app.io" },
];

/**
 * One message draws three cards at most, however many blocks it carries, so
 * the six go in two messages from the bot: a row of cards under each, in the
 * bot's order.
 */
const ITEM_BLOCKS = [
  { kind: "connect", items: ITEMS.slice(0, 3) },
  { kind: "connect", items: ITEMS.slice(3) },
];

/**
 * Newest first, as the server returns a direct-message page. `blocks` go
 * under the bot's hello; `more`, when there are any, under its next message.
 */
function thread(own?: unknown[], next?: unknown[]): Row[] {
  const blocks = own ?? ITEM_BLOCKS.slice(0, 1);
  const more = next ?? (own ? [] : ITEM_BLOCKS.slice(1));
  return [
    ...(more.length > 0
      ? [{ eventId: "e3", fromPersonUid: NOVA, fromDisplayName: "Nova", body: `A few more you might want.${fence(more)}`, createdAt: "2026-10-02T13:54:40.000Z", rootEventId: "e1" }]
      : []),
    { eventId: "e2", fromPersonUid: NOVA, fromDisplayName: "Nova", body: `Hi Corey, I am Nova.${fence(blocks)}`, createdAt: "2026-10-02T13:54:20.000Z", rootEventId: "e1" },
    {
      eventId: "e1",
      fromPersonUid: "prs_me",
      fromDisplayName: "Corey",
      body: buildAgentHelloRequest({ personName: "Corey", filesStillDownloading: false }),
      createdAt: "2026-10-02T13:53:50.000Z",
      audience: "agent",
      replyCount: more.length > 0 ? 2 : 1,
    },
  ];
}

function connection(over: Row = {}): Row {
  return {
    id: "acct_notion",
    provider: "factory:notion",
    status: "connected",
    createdBy: "prs_me",
    createdAt: "2026-10-02T14:10:00.000Z",
    updatedAt: "2026-10-02T14:10:00.000Z",
    access: { mode: "private", grantCount: 0 },
    installation: { displayName: "Notion", domain: "notion.so" },
    ...over,
  };
}

/**
 * The Linear connection the person makes in the browser after pressing
 * Connect on its card: the list dates it after the press.
 */
function connectedAfterPress(over: Row = {}): Row {
  return connection({
    id: "acct_linear",
    provider: "factory:linear",
    createdAt: new Date(Date.now() + 1_000).toISOString(),
    installation: { displayName: "Linear", domain: "linear.app" },
    ...over,
  });
}

const CATALOG: Record<string, Row> = {
  "linear.app": { name: "Linear", domain: "linear.app", mcpReady: true, authClass: "oauth", source: "integrations.sh" },
  "deepwiki.com": { name: "DeepWiki", domain: "deepwiki.com", mcpReady: true, authClass: "none", source: "integrations.sh" },
  "example.com": { name: "Example", domain: "example.com", mcpReady: true, authClass: "key", source: "community", entryId: "cat_example" },
};

const STARTED = {
  ok: true,
  companyUid: COMPANY,
  provider: "linear",
  displayName: "Linear",
  authorizationUrl: "https://linear.app/oauth/authorize?state=st_1",
  state: "st_1",
  expiresAt: "2026-10-02T15:10:00.000Z",
};

interface World {
  thread: Row[];
  connections: Row[];
  canManage: boolean;
  companies: Workspace[];
  getStatus: ReturnType<typeof vi.fn>;
  listConnections: ReturnType<typeof vi.fn>;
  grantConnectionAccess: ReturnType<typeof vi.fn>;
  catalogSearch: ReturnType<typeof vi.fn>;
  startOAuth: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  blueprint: ReturnType<typeof vi.fn>;
  sendDm: ReturnType<typeof vi.fn>;
  openUrl: Mock<(url: string) => void>;
}

function world(over: Partial<World> = {}): World {
  const w: World = {
    thread: thread(),
    connections: [connection()],
    canManage: true,
    companies: [ACME],
    getStatus: vi.fn(async () =>
      ok({
        setupState: { phase: "ready" },
        agent: {
          companyUid: COMPANY,
          runtime: { syncOkAt: "2026-10-02T14:20:00.000Z" },
          channels: null,
          channelDiagnostics: { slack: { inboundCapability: "unknown" } },
        },
      }),
    ),
    listConnections: vi.fn(async () =>
      ok({
        companyUid: COMPANY,
        viewer: { personUid: "prs_me", role: w.canManage ? "owner" : "member", canManageGovernance: w.canManage, canManageIntegrations: w.canManage },
        connections: w.connections,
        audit: [],
      }),
    ),
    grantConnectionAccess: vi.fn(async () => ok({ connectionId: "acct_x" })),
    catalogSearch: vi.fn(async (_company: string, query: string) =>
      ok({ ok: true, companyUid: COMPANY, entries: CATALOG[query] ? [CATALOG[query]] : [] }),
    ),
    startOAuth: vi.fn(async () => ok(STARTED)),
    install: vi.fn(async (input: { domain?: string }) => {
      // The server connects it: the next list shows it, as the person's own.
      w.connections = [
        ...w.connections,
        connection({
          id: "acct_deepwiki",
          provider: "factory:deepwiki",
          access: { mode: "private", grantCount: 0 },
          installation: { displayName: "DeepWiki", domain: input.domain ?? "deepwiki.com" },
        }),
      ];
      return ok({
        connection: { id: "acct_deepwiki", provider: "factory:deepwiki", status: "connected" },
        installation: { id: "inst_1", displayName: "DeepWiki", domain: "deepwiki.com", status: "installed" },
      });
    }),
    blueprint: vi.fn(async () =>
      ok({
        ok: true,
        companyUid: COMPANY,
        blueprint: {
          provider: "example",
          displayName: "Example",
          domain: "example.com",
          credentials: [{ id: "api_key", type: "api_key", label: "API key", generateUrl: "https://example.com/settings/api" }],
          surfaces: [{ kind: "mcp", slug: "mcp", name: "MCP", url: "https://mcp.example.com/mcp", authStatus: "required", credentialIds: ["api_key"] }],
          warnings: [],
        },
      }),
    ),
    sendDm: vi.fn(async () => ok({ eventId: `sent_${Math.random().toString(36).slice(2)}` })),
    openUrl: vi.fn<(url: string) => void>(),
    ...over,
  };
  return w;
}

function adapter(w: World): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: w.thread }),
      sendDm: w.sendDm,
    },
    agents: { getStatus: w.getStatus },
    integrations: {
      listConnections: w.listConnections,
      grantConnectionAccess: w.grantConnectionAccess,
      catalogSearch: w.catalogSearch,
      startOAuth: w.startOAuth,
      install: w.install,
      blueprint: w.blueprint,
    },
    settings: {
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage.clear();
});

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const DM_ROW: ConversationRow = { id: `dm:${NOVA}`, kind: "dm", title: "Nova", personUid: NOVA, companyUid: null } as ConversationRow;

async function mountDm(w: World, row: ConversationRow = DM_ROW): Promise<void> {
  window.localStorage.setItem(NEW_BOTS_KEY, JSON.stringify([NOVA]));
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(w),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey Epstein", email: "me@example.com" },
      initialRow: row,
      companies: w.companies,
      onopenurl: w.openUrl,
      wakes: createChatWakeBus(),
      coreFixtures: false,
    },
  });
  await vi.waitFor(() => expect(threadText()).toContain("Hi Corey, I am Nova."));
  await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalled());
  await settle(20);
}

const threadText = (): string => host.querySelector('[data-testid="conversation-thread"]')?.textContent ?? "";
const cards = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-testid="connection-card"]')];
const cardIds = (): string[] => cards().map((el) => el.dataset.domain ?? el.dataset.target ?? "");
const appCard = (domain: string): HTMLElement | null =>
  host.querySelector<HTMLElement>(`[data-testid="connection-card"][data-domain="${domain}"]`);
const appPrimary = (domain: string) => appCard(domain)?.querySelector<HTMLButtonElement>('[data-testid="connection-card-primary"]') ?? null;
const appLine = (domain: string): string => appCard(domain)?.querySelector('[data-testid="connection-card-line"]')?.textContent ?? "";
const appNote = (domain: string): string => appCard(domain)?.querySelector('[data-testid="connection-card-note"]')?.textContent ?? "";
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="card-modal"]');
const hidden = (w: World) =>
  w.sendDm.mock.calls.filter(([, , extras]) => (extras as { audience?: string } | undefined)?.audience === "agent");

async function refocus(): Promise<void> {
  window.dispatchEvent(new Event("focus"));
  await settle(20);
}

async function mountResolved(w: World): Promise<void> {
  await mountDm(w);
  await vi.waitFor(() => expect(cards().length).toBeGreaterThan(1));
  await settle(20);
}

describe("DesktopApp integration cards named by a cloud bot", () => {
  it("draws one card per resolvable domain, in the bot's order, and none for an unknown domain", async () => {
    const w = world();
    await mountResolved(w);
    await vi.waitFor(() => expect(cardIds()).toEqual(["slack", "linear.app", "notion.so", "deepwiki.com", "example.com"]));
    // The catalog was asked once per app that is not connected, never for the connected one.
    const asked = w.catalogSearch.mock.calls.map(([, query]) => query).sort();
    expect(asked).toEqual(["deepwiki.com", "example.com", "linear.app", "unknown-app.io"]);
    expect(w.catalogSearch.mock.calls.every(([company, , limit]) => company === COMPANY && limit === 20)).toBe(true);
    // The app writes the names, the logos and the line that says the bot gets access; the bot's reason sits under it, named as the bot's.
    expect(appCard("linear.app")!.textContent).toContain("Linear");
    expect(appLine("linear.app")).toBe("Connect Linear so Nova can use it.");
    expect(appCard("linear.app")!.querySelector('[data-testid="connection-card-reason"]')?.textContent).toBe("Nova says: Your team's issues live here");
    expect(appLine("deepwiki.com")).toBe("Connect DeepWiki so Nova can use it.");
    expect(appCard("deepwiki.com")!.querySelector('[data-testid="connection-card-reason"]')).toBeNull();
    // Linear has a bundled mark, so no letters are drawn. DeepWiki has none: it shows the generic glyph. No card asks another host for an image.
    expect(appCard("linear.app")!.querySelector('[data-testid="connection-card-logo-mark"] path')?.getAttribute("d")).toBe(brandMarkFor("linear.app")?.path);
    expect(appCard("linear.app")!.querySelector('[data-testid="connection-card-logo-img"]')).toBeNull();
    expect(appCard("linear.app")!.querySelector('[data-testid="connection-card-logo"]')?.textContent?.trim()).toBe("");
    expect(appCard("deepwiki.com")!.querySelector('[data-testid="connection-card-logo-generic"]')).not.toBeNull();
    for (const card of cardIds()) {
      const logo = (card === "slack" ? null : appCard(card))?.querySelector('[data-testid="connection-card-logo"]');
      expect(logo?.querySelector("img") ?? null, card).toBeNull();
    }
    expect(appPrimary("linear.app")!.textContent?.trim()).toBe("Connect Linear");
    expect(appPrimary("example.com")!.getAttribute("aria-haspopup")).toBe("dialog");
    expect(threadText()).not.toContain("unknown-app.io");
    expect(threadText()).not.toContain("hq-block");
    // The quiet way to everything else.
    expect(host.querySelector('[data-testid="rich-connect-browse"]')?.textContent?.trim()).toBe("Browse all in HQ Integrations");
  });

  it("shows a connected app as usable, as allow-able, or as a teammate's, per the rules", async () => {
    const w = world({
      thread: thread([{ kind: "connect", items: [{ domain: "notion.so" }, { domain: "gmail.com" }, { domain: "asana.com" }] }]),
      connections: [
        connection(),
        connection({ id: "acct_gmail", provider: "gmail", createdBy: "prs_teammate", installation: { displayName: "Gmail (Hassaan)", domain: "gmail.com" } }),
        connection({ id: "acct_asana", provider: "factory:asana", access: { mode: "everyone", grantCount: 0 }, installation: { displayName: "Asana", domain: "asana.com" } }),
      ],
    });
    await mountResolved(w);
    expect(cardIds()).toEqual(["notion.so", "gmail.com", "asana.com"]);
    expect(appLine("notion.so")).toBe("Let Nova use it?");
    expect(appPrimary("notion.so")!.textContent?.trim()).toBe("Let Nova use it");
    expect(appLine("gmail.com")).toBe("A teammate connected this. Ask them to share it with Nova.");
    expect(appPrimary("gmail.com")).toBeNull();
    expect(appLine("asana.com")).toBe("Nova can use it.");
    expect(appPrimary("asana.com")).toBeNull();
    expect(cards().every((el) => el.dataset.state === "connected")).toBe(true);
    expect(w.catalogSearch).not.toHaveBeenCalled();
    expect(hidden(w)).toHaveLength(0);
  });

  it("Connect on an OAuth app starts the sign-in once, opens the page, waits, then grants and tells the bot once when the app appears", async () => {
    const w = world();
    await mountResolved(w);
    await vi.waitFor(() => expect(appPrimary("linear.app")).not.toBeNull());
    const connect = appPrimary("linear.app")!;
    connect.click();
    connect.click();
    await settle(20);
    expect(w.startOAuth).toHaveBeenCalledTimes(1);
    expect(w.startOAuth).toHaveBeenCalledWith({ companyUid: COMPANY, domain: "linear.app" });
    expect(w.openUrl).toHaveBeenCalledTimes(1);
    expect(w.openUrl).toHaveBeenCalledWith(STARTED.authorizationUrl);
    await vi.waitFor(() => expect(appCard("linear.app")!.dataset.state).toBe("connecting"));
    expect(appLine("linear.app")).toBe("Finish in your browser. This card updates when Linear is connected.");
    expect(appPrimary("linear.app")!.textContent?.trim()).toBe("Open again");
    expect(w.grantConnectionAccess).not.toHaveBeenCalled();
    expect(hidden(w)).toHaveLength(0);

    // The person signed in and came back: the list shows their new connection.
    w.connections = [...w.connections, connectedAfterPress()];
    await refocus();
    await vi.waitFor(() => expect(w.grantConnectionAccess).toHaveBeenCalledTimes(1));
    expect(w.grantConnectionAccess).toHaveBeenCalledWith({ companyUid: COMPANY, connectionId: "acct_linear", granteeUid: NOVA });
    await vi.waitFor(() => expect(hidden(w)).toHaveLength(1));
    const [to, body, extras] = hidden(w)[0]!;
    expect(to).toBe(NOVA);
    expect(body).toMatch(/^Automatic message from HQ: Corey just connected Linear/);
    expect(extras).toEqual({ audience: "agent", idempotencyKey: `new-bot-conn-${NOVA}-acct_linear` });
    await vi.waitFor(() => expect(appLine("linear.app")).toBe("Nova can use it."));
    expect(appCard("linear.app")!.dataset.state).toBe("connected");
    expect(appPrimary("linear.app")).toBeNull();
    // The list arriving again grants and tells nothing twice.
    await refocus();
    expect(w.grantConnectionAccess).toHaveBeenCalledTimes(1);
    expect(hidden(w)).toHaveLength(1);
  });

  it("falls back to Let the bot use it when the grant after an OAuth connect fails", async () => {
    const w = world();
    await mountResolved(w);
    await vi.waitFor(() => expect(appPrimary("linear.app")).not.toBeNull());
    appPrimary("linear.app")!.click();
    await vi.waitFor(() => expect(appCard("linear.app")!.dataset.state).toBe("connecting"));
    w.grantConnectionAccess.mockResolvedValueOnce({ ok: false, reason: "error", code: "http-500", message: "boom" });
    w.connections = [...w.connections, connectedAfterPress()];
    await refocus();
    await vi.waitFor(() => expect(appNote("linear.app")).toBe("Could not share Linear. Try again."));
    expect(appLine("linear.app")).toBe("Let Nova use it?");
    expect(appPrimary("linear.app")!.textContent?.trim()).toBe("Let Nova use it");
    expect(hidden(w)).toHaveLength(0);
  });

  it("tells the bot without a grant when the app the person connected is open to everyone", async () => {
    const w = world();
    await mountResolved(w);
    await vi.waitFor(() => expect(appPrimary("linear.app")).not.toBeNull());
    appPrimary("linear.app")!.click();
    await vi.waitFor(() => expect(appCard("linear.app")!.dataset.state).toBe("connecting"));
    w.connections = [
      ...w.connections,
      connectedAfterPress({ access: { mode: "everyone", grantCount: 0 } }),
    ];
    await refocus();
    await vi.waitFor(() => expect(hidden(w)).toHaveLength(1));
    expect(w.grantConnectionAccess).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(appLine("linear.app")).toBe("Nova can use it."));
  });

  it("says a refused OAuth start in one sentence, and opens nothing", async () => {
    const w = world();
    await mountResolved(w);
    await vi.waitFor(() => expect(appPrimary("linear.app")).not.toBeNull());
    w.startOAuth.mockResolvedValueOnce({ ok: false, reason: "error", status: 402, code: "PLAN_LIMIT_REACHED", message: "x" });
    appPrimary("linear.app")!.click();
    await vi.waitFor(() => expect(appNote("linear.app")).toBe("Your plan's integration limit is reached."));
    expect(w.openUrl).not.toHaveBeenCalled();
    expect(appCard("linear.app")!.dataset.state).toBe("offered");

    w.startOAuth.mockResolvedValueOnce({ ok: false, reason: "error", status: 502, code: "CLIENT_REGISTRATION_REFUSED", message: "x" });
    await vi.waitFor(() => expect(appPrimary("linear.app")!.disabled).toBe(false), { timeout: 3000 });
    appPrimary("linear.app")!.click();
    await vi.waitFor(() => expect(appNote("linear.app")).toBe("Linear could not be connected from here. Try it from HQ Integrations."));
    expect(w.openUrl).not.toHaveBeenCalled();
  });

  it("a no-auth app installs on click, is granted and the bot told, and the card turns connected", async () => {
    const w = world();
    await mountResolved(w);
    await vi.waitFor(() => expect(appPrimary("deepwiki.com")).not.toBeNull());
    expect(appPrimary("deepwiki.com")!.textContent?.trim()).toBe("Connect DeepWiki");
    appPrimary("deepwiki.com")!.click();
    appPrimary("deepwiki.com")!.click();
    await vi.waitFor(() => expect(w.install).toHaveBeenCalledTimes(1));
    expect(w.install).toHaveBeenCalledWith({ companyUid: COMPANY, domain: "deepwiki.com" });
    await vi.waitFor(() => expect(w.grantConnectionAccess).toHaveBeenCalledTimes(1));
    expect(w.grantConnectionAccess).toHaveBeenCalledWith({ companyUid: COMPANY, connectionId: "acct_deepwiki", granteeUid: NOVA });
    await vi.waitFor(() => expect(hidden(w)).toHaveLength(1));
    expect(hidden(w)[0]![1]).toMatch(/^Automatic message from HQ: Corey just connected DeepWiki/);
    await vi.waitFor(() => expect(appLine("deepwiki.com")).toBe("Nova can use it."));
    expect(appCard("deepwiki.com")!.dataset.state).toBe("connected");
    expect(w.openUrl).not.toHaveBeenCalled();
    expect(w.startOAuth).not.toHaveBeenCalled();
  });

  it("a key app opens its modal with the app's name and logo, and installs nothing until the key is sent", async () => {
    const w = world();
    await mountResolved(w);
    await vi.waitFor(() => expect(appPrimary("example.com")).not.toBeNull());
    appPrimary("example.com")!.click();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog()!.querySelector('[data-testid="card-modal-title"]')?.textContent).toBe("Example");
    // Example has no bundled mark: the generic glyph holds the box, never letters.
    expect(dialog()!.querySelector('[data-testid="connection-card-logo-generic"]')).not.toBeNull();
    expect(dialog()!.querySelector('[data-testid="connection-card-logo"]')?.textContent?.trim()).toBe("");
    expect(dialog()!.textContent).toContain("Example needs a key to connect.");
    await vi.waitFor(() => expect(w.blueprint).toHaveBeenCalledTimes(1));
    expect(w.blueprint).toHaveBeenCalledWith({ companyUid: COMPANY, catalogEntryId: "cat_example" });
    expect(w.install).not.toHaveBeenCalled();
    expect(w.openUrl).not.toHaveBeenCalled();
    expect(appCard("example.com")!.dataset.state).toBe("offered");
    // Close: nothing was sent, nothing is remembered as started.
    dialog()!.querySelector<HTMLButtonElement>('[data-testid="integration-connect-close"]')!.click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(appCard("example.com")!.dataset.state).toBe("offered");
  });

  it("a non-admin sees no Connect button: connected apps only, with no catalog call", async () => {
    const w = world({ canManage: false });
    await mountDm(w);
    await vi.waitFor(() => expect(cardIds()).toEqual(["slack", "notion.so"]));
    await settle(20);
    expect(w.catalogSearch).not.toHaveBeenCalled();
    // Their own connection they may still share.
    expect(appPrimary("notion.so")!.textContent?.trim()).toBe("Let Nova use it");
    expect(host.querySelectorAll('[data-testid="connection-card-primary"]')).toHaveLength(2);
  });

  it("Not now dims the card, and the row keeps its other cards", async () => {
    const w = world();
    await mountResolved(w);
    await vi.waitFor(() => expect(appPrimary("linear.app")).not.toBeNull());
    appCard("linear.app")!.querySelector<HTMLButtonElement>('[data-testid="connection-card-decline"]')!.click();
    await vi.waitFor(() => expect(appCard("linear.app")!.dataset.state).toBe("declined"));
    expect(appLine("linear.app")).toBe("Not connected. Ask Nova any time.");
    expect(appCard("linear.app")!.querySelectorAll("button")).toHaveLength(0);
    expect(cardIds()).toEqual(["slack", "linear.app", "notion.so", "deepwiki.com", "example.com"]);
  });

  it("the old targets form still draws the built-in cards", async () => {
    const w = world({ thread: thread([{ kind: "connect", targets: ["slack", "tools"] }]), connections: [] });
    await mountDm(w);
    await vi.waitFor(() => expect(cardIds()).toEqual(["slack", "tools"]));
    expect(host.querySelector('[data-target="tools"]')!.textContent).toContain("Connect your tools");
    expect(host.querySelector('[data-testid="rich-connect-browse"]')).toBeNull();
    expect(w.catalogSearch).not.toHaveBeenCalled();
  });
});

/**
 * In a bot's conversation "Slack" is the bot's own Slack. Live, 2026-10-04: a
 * new bot named `{"domain":"slack.com"}`. The company had a Slack integration
 * connection a teammate made, so the card read "Connected. Connected by a
 * teammate..." for a bot that had never been connected to Slack.
 */
describe("DesktopApp: a bot that names slack.com gets its own Slack card", () => {
  const TEAMMATE_SLACK = connection({
    id: "acct_slack",
    provider: "factory:slack",
    createdBy: "prs_teammate",
    installation: { displayName: "Slack", domain: "slack.com" },
  });
  /** The live hello's block: notion.com, slack.com, sentry.io. */
  const NAMES_SLACK = [{ kind: "connect", items: [{ domain: "notion.so", why: "Docs" }, { domain: "slack.com", why: "Team chat" }] }];
  const slackCard = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-testid="connection-card"][data-target="slack"]');
  const slackPrimary = () => slackCard()?.querySelector<HTMLButtonElement>('[data-testid="connection-card-primary"]') ?? null;
  const slackLine = (): string => slackCard()?.querySelector('[data-testid="connection-card-line"]')?.textContent ?? "";
  const statusWith = (agent: Row) =>
    vi.fn(async () =>
      ok({ setupState: { phase: "ready" }, agent: { companyUid: COMPANY, runtime: { syncOkAt: "2026-10-02T14:20:00.000Z" }, ...agent } }),
    );

  it("shows Connect Slack, not the teammate's company connection, and the button opens the Slack window", async () => {
    const w = world({ thread: thread(NAMES_SLACK), connections: [connection(), TEAMMATE_SLACK] });
    await mountResolved(w);
    expect(cardIds()).toEqual(["notion.so", "slack"]);
    // No integration card is drawn for Slack, and nothing says a teammate connected it.
    expect(appCard("slack.com")).toBeNull();
    expect(slackCard()!.dataset.state).toBe("offered");
    expect(slackCard()!.dataset.kind).toBeUndefined();
    expect(slackCard()!.querySelector('[data-testid="connection-card-mark"]')).toBeNull();
    expect(slackLine()).toBe("Talk to Nova in Slack and let it post there.");
    expect(slackCard()!.textContent).not.toMatch(/teammate|Connected/);
    expect(slackPrimary()!.textContent?.trim()).toBe("Connect Slack");
    expect(slackPrimary()!.getAttribute("aria-haspopup")).toBe("dialog");
    // The catalog is never asked about Slack: it is not an app to look up.
    expect(w.catalogSearch.mock.calls.map(([, query]) => query)).not.toContain("slack.com");
    slackPrimary()!.click();
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog()!.querySelector('[data-testid="card-modal-title"]')?.textContent).toBe("Connect Nova to Slack");
    expect(w.openUrl).not.toHaveBeenCalled();
    expect(w.startOAuth).not.toHaveBeenCalled();
  });

  it("names Slack both ways in one block and still draws one Slack card", async () => {
    const w = world({
      thread: thread([{ kind: "connect", items: [{ app: "slack" }, { domain: "https://www.slack.com/" }, { domain: "notion.so" }] }]),
      connections: [connection(), TEAMMATE_SLACK],
    });
    await mountResolved(w);
    expect(cardIds()).toEqual(["slack", "notion.so"]);
    expect(host.querySelectorAll('[data-testid="connection-card"][data-target="slack"]')).toHaveLength(1);
  });

  it("shows the bot as in Slack only when the bot's own status says so", async () => {
    const w = world({
      thread: thread(NAMES_SLACK),
      connections: [connection(), TEAMMATE_SLACK],
      getStatus: statusWith({ channels: { slack: { appId: "A1" } }, channelDiagnostics: { slack: { inboundCapability: "ok" } } }),
    });
    await mountResolved(w);
    await vi.waitFor(() => expect(slackCard()?.dataset.state).toBe("connected"));
    expect(slackLine()).toBe("Nova is in Slack.");
    expect(slackCard()!.querySelector('[data-testid="connection-card-mark"]')?.textContent?.trim()).toBe("Connected");
    expect(slackPrimary()).toBeNull();
    expect(slackCard()!.textContent).not.toContain("teammate");
    expect(appCard("slack.com")).toBeNull();
  });

  it("says to ask a company admin when this person may not read the bot's status, whatever the company has connected", async () => {
    const w = world({
      thread: thread(NAMES_SLACK),
      connections: [connection(), TEAMMATE_SLACK],
      getStatus: vi.fn(async () => ({ ok: false as const, reason: "error" as const, code: "http-403", message: "no" })),
    });
    // The row names the company, so the list is still read with the status refused.
    await mountDm(w, { ...DM_ROW, companyUid: COMPANY } as ConversationRow);
    await vi.waitFor(() => expect(slackLine()).toBe("Ask a company admin to connect Nova to Slack."));
    expect(cardIds()).toEqual(["notion.so", "slack"]);
    expect(slackPrimary()).toBeNull();
    expect(slackCard()!.querySelector('[data-testid="connection-card-mark"]')).toBeNull();
    expect(slackCard()!.textContent).not.toMatch(/teammate|Connected/);
    expect(appCard("slack.com")).toBeNull();
  });

  it("the app's own picks offer Slack once: the person's own Slack integration connection is not a second Slack card", async () => {
    // No connect block from the bot: the app chooses. The person's own Slack
    // integration connection would have been offered beside the Slack card.
    const w = world({
      thread: thread([]),
      connections: [connection(), connection({ id: "acct_my_slack", provider: "factory:slack", installation: { displayName: "Slack", domain: "slack.com" } })],
    });
    await mountResolved(w);
    expect(cardIds()).toEqual(["slack", "notion.so"]);
    expect([...host.querySelectorAll('[data-testid="connection-card"]')].filter((el) => el.getAttribute("aria-label") === "Slack")).toHaveLength(1);
    expect(appCard("slack.com")).toBeNull();
  });
});

/**
 * C-2: the record of a Connect press lives in localStorage. One left there
 * from an earlier day must never give the bot a private connection: only a
 * connection that answers a press made just now is shared with no press.
 */
describe("DesktopApp integration cards: a 'connecting' record left in storage", () => {
  /** What this device remembers about Nova's cards before the app starts. */
  function seedPress(domain: string, since: unknown): void {
    window.localStorage.setItem(
      BOT_CONNECTION_CARDS_STORAGE_KEY,
      JSON.stringify({ [NOVA]: { apps: { [domain]: { state: "connecting", since } } } }),
    );
  }
  const storedApps = (): Record<string, unknown> => {
    const parsed = JSON.parse(window.localStorage.getItem(BOT_CONNECTION_CARDS_STORAGE_KEY) ?? "{}") as Record<string, { apps?: Record<string, unknown> }>;
    return parsed[NOVA]?.apps ?? {};
  };
  const linear = (over: Row = {}): Row =>
    connection({ id: "acct_linear", provider: "factory:linear", installation: { displayName: "Linear", domain: "linear.app" }, ...over });

  /** Mount, let the list arrive more than once, and wait for the record to be dropped. */
  async function mountAndSettle(w: World): Promise<void> {
    await mountResolved(w);
    await refocus();
    await vi.waitFor(() => expect(storedApps()).not.toHaveProperty("linear.app"));
    await refocus();
  }

  function expectExplicitButtonOnly(w: World): void {
    expect(w.grantConnectionAccess).not.toHaveBeenCalled();
    expect(hidden(w)).toHaveLength(0);
    expect(appCard("linear.app")!.dataset.state).toBe("connected");
    expect(appLine("linear.app")).toBe("Let Nova use it?");
    expect(appPrimary("linear.app")!.textContent?.trim()).toBe("Let Nova use it");
  }

  it("a press from days ago shares nothing, is forgotten, and leaves the explicit button", async () => {
    const since = Date.now() - 3 * 86_400_000;
    seedPress("linear.app", since);
    // The person connected Linear yesterday, somewhere else: after that press.
    const w = world({ connections: [connection(), linear({ createdAt: new Date(Date.now() - 86_400_000).toISOString() })] });
    await mountAndSettle(w);
    expectExplicitButtonOnly(w);

    // The explicit press still shares it, once, and tells the bot.
    appPrimary("linear.app")!.click();
    await vi.waitFor(() => expect(w.grantConnectionAccess).toHaveBeenCalledTimes(1));
    expect(w.grantConnectionAccess).toHaveBeenCalledWith({ companyUid: COMPANY, connectionId: "acct_linear", granteeUid: NOVA });
    await vi.waitFor(() => expect(hidden(w)).toHaveLength(1));
    await vi.waitFor(() => expect(appLine("linear.app")).toBe("Nova can use it."));
  });

  it("a press just past the wait shares nothing, even for a connection made after it", async () => {
    const since = Date.now() - CONNECTING_TIMEOUT_MS - 5_000;
    seedPress("linear.app", since);
    const w = world({ connections: [connection(), linear({ createdAt: new Date(since + 60_000).toISOString() })] });
    await mountAndSettle(w);
    expectExplicitButtonOnly(w);
  });

  it("a recent press shares nothing when the connection was already there", async () => {
    seedPress("linear.app", Date.now() - 60_000);
    // Made two days before the press.
    const w = world({ connections: [connection(), linear({ createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString() })] });
    await mountAndSettle(w);
    expectExplicitButtonOnly(w);
  });

  it("a recent press shares nothing when the connection's domain is not exactly the card's", async () => {
    const since = Date.now() - 60_000;
    seedPress("linear.app", since);
    const w = world({
      connections: [
        connection(),
        linear({ createdAt: new Date(since + 30_000).toISOString(), installation: { displayName: "Linear", domain: "api.linear.app" } }),
      ],
    });
    await mountAndSettle(w);
    expectExplicitButtonOnly(w);
  });

  it("a record with no usable press time is dropped when it is read and shares nothing", async () => {
    for (const since of [null, "yesterday", undefined]) {
      window.localStorage.clear();
      seedPress("linear.app", since);
      const w = world({ connections: [connection(), linear({ createdAt: new Date(Date.now() - 1_000).toISOString() })] });
      await mountResolved(w);
      await refocus();
      await refocus();
      expectExplicitButtonOnly(w);
      if (component) await unmount(component);
      component = null;
      host.remove();
    }
  });
});
