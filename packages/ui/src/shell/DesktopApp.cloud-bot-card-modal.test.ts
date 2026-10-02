// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import CardModalProbe from "./CardModalProbe.test.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { buildAgentHelloRequest } from "../chat/agent-channel.js";
import { MESSAGE_PERSON_EVENT } from "../chat/pending-conversation.js";
import { OPEN_SETTINGS_EVENT } from "../chat/open-target.js";
import { CARD_MODAL_BACKDROP_GUARD_MS } from "../chat/messaging/card-modal.js";
import {
  cardModalContentFor,
  cardModalTargets,
  registerCardModalContentForTest,
} from "../chat/messaging/card-modal-registry.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

/**
 * A connection card can open a modal. The shell owns which one is open: the
 * card's button opens it at the shell, over the whole window; closing it
 * gives focus back to the button; leaving the conversation closes it.
 *
 * No card has a modal yet, so the content here is a probe registered through
 * the registry's test seam.
 */

const NOVA = "agt_nova";
const COMPANY = "cmp_acme";
const NEW_BOTS_KEY = "hq.chat.newCloudBots.v1";

type Row = Record<string, unknown>;

/** Newest first, as the server returns a direct-message page. */
function thread(peerUid: string): Row[] {
  return [
    { eventId: "e2", fromPersonUid: peerUid, fromDisplayName: "Nova", body: "Hi Corey, I am Nova.", createdAt: "2026-10-02T13:54:20.000Z", rootEventId: "e1" },
    {
      eventId: "e1",
      fromPersonUid: "prs_me",
      fromDisplayName: "Corey",
      body: buildAgentHelloRequest({ personName: "Corey", filesStillDownloading: false }),
      createdAt: "2026-10-02T13:53:50.000Z",
      audience: "agent",
      replyCount: 1,
    },
  ];
}

interface World {
  getStatus: ReturnType<typeof vi.fn>;
  listConnections: ReturnType<typeof vi.fn>;
  openUrl: Mock<(url: string) => void>;
}

function world(): World {
  return {
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
        viewer: { personUid: "prs_me", role: "owner", canManageGovernance: true, canManageIntegrations: true },
        factoryEnabled: true,
        connections: [],
        audit: [],
      }),
    ),
    openUrl: vi.fn<(url: string) => void>(),
  };
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
      fetchDmThread: async () => ok({ messages: thread(NOVA) }),
      sendDm: vi.fn(async () => ok({ eventId: "sent_1" })),
    },
    agents: { getStatus: w.getStatus },
    integrations: { listConnections: w.listConnections, grantConnectionAccess: vi.fn() },
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
let unregister: Array<() => void> = [];
let clock = 0;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  for (const undo of unregister) undo();
  unregister = [];
  window.localStorage.clear();
  vi.restoreAllMocks();
});

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const DM_ROW: ConversationRow = { id: `dm:${NOVA}`, kind: "dm", title: "Nova", personUid: NOVA, companyUid: null } as ConversationRow;

/** A bot made in the New bot flow on this device, with its direct message open. */
async function mountNewBotDm(w: World): Promise<void> {
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
      initialRow: DM_ROW,
      onopenurl: w.openUrl,
      wakes: createChatWakeBus(),
      coreFixtures: false,
    },
  });
  await vi.waitFor(() => expect(cards()).toHaveLength(2));
  await vi.waitFor(() => expect(w.listConnections).toHaveBeenCalled());
  await settle();
}

const shell = (): HTMLElement => host.querySelector<HTMLElement>('[data-testid="desktop-shell"]')!;
const cards = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[data-testid="connection-card"]')];
const card = (target: "slack" | "tools"): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-testid="connection-card"][data-target="${target}"]`)!;
const primary = (target: "slack" | "tools") =>
  card(target).querySelector<HTMLButtonElement>('[data-testid="connection-card-primary"]')!;
const layers = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="card-modal-layer"]')];
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="card-modal"]');
const probe = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-testid="card-modal-probe"]');
const inModal = <T extends HTMLElement = HTMLElement>(id: string): T =>
  dialog()!.querySelector<T>(`[data-testid="${id}"]`)!;

/** Give a card a modal for this test, with time under the test's control. */
function giveModal(target: "slack" | "tools"): void {
  unregister.push(registerCardModalContentForTest(target, CardModalProbe));
  clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
}

async function open(target: "slack" | "tools"): Promise<void> {
  primary(target).click();
  await settle();
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
}

describe("the registry of card modals", () => {
  it("gives no card a modal yet", () => {
    expect(cardModalContentFor("slack")).toBeNull();
    expect(cardModalContentFor("tools")).toBeNull();
    expect([...cardModalTargets()]).toEqual([]);
  });

  it("gives a card a modal for the length of a test, and takes it back", () => {
    const undo = registerCardModalContentForTest("slack", CardModalProbe);
    expect(cardModalContentFor("slack")).toBe(CardModalProbe);
    expect([...cardModalTargets()]).toEqual(["slack"]);
    expect(cardModalContentFor("tools")).toBeNull();
    undo();
    expect(cardModalContentFor("slack")).toBeNull();
    expect([...cardModalTargets()]).toEqual([]);
  });
});

describe("DesktopApp: a connection card that opens a modal", () => {
  it("leaves both cards as they are while no card has a modal", async () => {
    const w = world();
    await mountNewBotDm(w);
    for (const target of ["slack", "tools"] as const) {
      expect(primary(target).hasAttribute("aria-haspopup")).toBe(false);
      expect(primary(target).dataset.action).toBe("connect");
    }
    primary("slack").click();
    await settle();
    expect(dialog()).toBeNull();
    expect(w.openUrl).toHaveBeenCalledTimes(1);
    expect(card("slack").dataset.state).toBe("connecting");
  });

  it("opens the card's modal at the shell from the card's button, and opens no page", async () => {
    giveModal("slack");
    const w = world();
    await mountNewBotDm(w);
    expect(primary("slack").getAttribute("aria-haspopup")).toBe("dialog");
    expect(primary("slack").textContent?.trim()).toBe("Connect Slack");
    // The other card still connects.
    expect(primary("tools").hasAttribute("aria-haspopup")).toBe(false);
    expect(dialog()).toBeNull();

    await open("slack");
    expect(layers()).toHaveLength(1);
    // At the shell, over the window: not inside the message, the thread or the conversation.
    expect(layers()[0]!.parentElement).toBe(shell());
    expect(host.querySelector('[data-testid="conversation-thread"]')!.contains(dialog())).toBe(false);
    expect(card("slack").contains(dialog())).toBe(false);
    // The card's own title, icon and art.
    expect(dialog()!.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog()!.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Slack");
    expect(dialog()!.dataset.icon).toBe("slack");
    const cardArt = card("slack").querySelector<HTMLElement>(".connection-card-art")!.style.backgroundImage;
    expect(dialog()!.querySelector<HTMLElement>(".card-modal-art")!.style.backgroundImage).toBe(cardArt);
    // The content knows whose card it is.
    expect(probe()!.dataset.agentUid).toBe(NOVA);
    expect(probe()!.dataset.target).toBe("slack");
    expect(probe()!.dataset.botName).toBe("Nova");
    expect(probe()!.dataset.companyUid).toBe(COMPANY);
    // Opening the modal is not connecting: no page opens and the card does not start waiting.
    expect(w.openUrl).not.toHaveBeenCalled();
    expect(card("slack").dataset.state).toBe("offered");
    // The app behind is out of reach while it is open.
    const behind = [...shell().children].filter((el) => el !== layers()[0]);
    expect(behind.length).toBeGreaterThan(0);
    expect(behind.every((el) => el.hasAttribute("inert"))).toBe(true);
  });

  it("gives focus to the dialog, and back to the card's button on close", async () => {
    giveModal("slack");
    await mountNewBotDm(world());
    await open("slack");
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    delete document.body.dataset.cardModalProbeLast;
    inModal<HTMLButtonElement>("card-modal-close").click();
    await settle();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(primary("slack"));
    expect(document.body.dataset.cardModalProbeLast).toBe(`Slack:Nova:${NOVA}`);
    expect([...shell().children].some((el) => el.hasAttribute("inert"))).toBe(false);
    // And it opens again.
    clock += 1_000;
    await vi.waitFor(async () => {
      primary("slack").click();
      await settle();
      expect(dialog()).not.toBeNull();
    });
  });

  it("closes on Escape and from its own content", async () => {
    giveModal("tools");
    await mountNewBotDm(world());
    await open("tools");
    expect(document.getElementById(dialog()!.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Connect your tools");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(primary("tools"));

    clock += 1_000;
    await vi.waitFor(async () => {
      primary("tools").click();
      await settle();
      expect(dialog()).not.toBeNull();
    });
    inModal<HTMLButtonElement>("card-modal-probe-done").click();
    await settle();
    expect(dialog()).toBeNull();
  });

  it("stays open while its content is busy", async () => {
    giveModal("slack");
    await mountNewBotDm(world());
    await open("slack");
    clock += CARD_MODAL_BACKDROP_GUARD_MS + 1;
    inModal<HTMLButtonElement>("card-modal-probe-busy").click();
    await settle();
    expect(inModal<HTMLButtonElement>("card-modal-close").disabled).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    layers()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(dialog()).not.toBeNull();
    inModal<HTMLButtonElement>("card-modal-probe-busy").click();
    await settle();
    layers()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle();
    expect(dialog()).toBeNull();
  });

  it("hands the content a way to open a page and to ask the server again", async () => {
    giveModal("slack");
    const w = world();
    await mountNewBotDm(w);
    await open("slack");
    inModal<HTMLButtonElement>("card-modal-probe-link").click();
    expect(w.openUrl).toHaveBeenCalledWith("https://example.com/slack");
    const asked = w.getStatus.mock.calls.length;
    inModal<HTMLButtonElement>("card-modal-probe-refresh").click();
    await settle();
    expect(w.getStatus.mock.calls.length).toBe(asked + 1);
    // The same dialog is still there: asking again does not remount it.
    expect(layers()).toHaveLength(1);
  });

  it("closes when the person leaves the conversation", async () => {
    giveModal("slack");
    await mountNewBotDm(world());
    await open("slack");
    delete document.body.dataset.cardModalProbeLast;
    window.dispatchEvent(new CustomEvent(MESSAGE_PERSON_EVENT, { detail: { personUid: "prs_teammate" } }));
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await settle();
    expect(layers()).toHaveLength(0);
    // The content could still read what it was handed while it was taken down.
    expect(document.body.dataset.cardModalProbeLast).toBe(`Slack:Nova:${NOVA}`);
    // Nothing is left inert behind a dialog that is gone.
    expect([...shell().children].some((el) => el.hasAttribute("inert"))).toBe(false);
  });

  it("closes when the person goes to another page of the app", async () => {
    giveModal("slack");
    await mountNewBotDm(world());
    await open("slack");
    window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT));
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect([...shell().children].some((el) => el.hasAttribute("inert"))).toBe(false);
  });
});
