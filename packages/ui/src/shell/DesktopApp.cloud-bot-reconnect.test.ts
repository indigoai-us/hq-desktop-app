// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { ConversationRow } from "../chat/sidebar-model.js";


const SASHA = "agt_sasha";
const COMPANY = "cmp_latico";
const RECONNECT_URL = `https://hq.computer/resolve/agents/${SASHA}/reconnect`;

type Row = Record<string, unknown>;

const STEPS = [
  { name: "runtime", status: "done" },
  { name: "codex-auth", status: "done" },
  { name: "sync", status: "done" },
];

function statusOf(brains: Row, ownerUid = "prs_me", pairing: unknown = null): unknown {
  return {
    setupState: { phase: "ready", steps: STEPS },
    agent: {
      uid: SASHA,
      name: "sasha",
      companyUid: COMPANY,
      ownerUid,
      codexModel: "gpt-5.5",
      provider: "agents-v2",
      authorizedBrains: brains,
      runtime: { syncOkAt: "2026-10-01T00:00:00.000Z" },
      channels: null,
    },
    pairing,
  };
}

const PAIRING = { url: "https://auth.openai.com/codex/device", code: "ABCD-EFGH", capturedAt: new Date().toISOString() };

interface World {
  thread: Row[];
  status: () => unknown | null;
  getStatus: ReturnType<typeof vi.fn>;
  restartBrainApproval: ReturnType<typeof vi.fn>;
}

function world(over: Partial<World> = {}): World {
  const w: World = {
    thread: [
      { eventId: "e1", fromPersonUid: SASHA, fromDisplayName: "Sasha", body: "Hi, I am Sasha.", createdAt: "2026-10-01T13:54:20.000Z" },
    ],
    status: () => statusOf({ codex: "expired" }),
    getStatus: vi.fn(async () => {
      const value = w.status();
      return value === null
        ? { ok: false as const, reason: "error" as const, code: "http-403", status: 403, message: "Only owners and admins can read this." }
        : ok(value);
    }),
    restartBrainApproval: vi.fn(async () => {
      w.status = () => statusOf({ codex: "pending" }, "prs_me", PAIRING);
      return ok(statusOf({ codex: "pending" }, "prs_me", PAIRING));
    }),
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
      sendDm: vi.fn(async () => ok({ eventId: "sent_1" })),
    },
    agents: {
      getStatus: w.getStatus,
      restartBrainApproval: w.restartBrainApproval,
      retryProvisioning: vi.fn(async () => ok({})),
    },
    integrations: {
      listConnections: async () =>
        ok({ companyUid: COMPANY, viewer: { personUid: "prs_me", canManageIntegrations: true }, connections: [] }),
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
  document.querySelectorAll('[data-testid="brain-reconnect-shell"]').forEach((el) => el.remove());
  window.localStorage.clear();
  vi.useRealTimers();
});

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const DM_ROW = (peerUid: string, title: string): ConversationRow =>
  ({ id: `dm:${peerUid}`, kind: "dm", title, personUid: peerUid, companyUid: null }) as ConversationRow;

async function mountRow(
  w: World,
  row: ConversationRow,
  waitForText: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(w),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Ben Owner", email: "me@example.com" },
      initialRow: row,
      wakes: createChatWakeBus(),
      coreFixtures: false,
      ...extra,
    },
  });
  await vi.waitFor(() => expect(threadText()).toContain(waitForText));
  await settle();
}

const threadText = (): string =>
  host.querySelector<HTMLElement>('[data-testid="conversation-thread"]')?.textContent ?? "";
const card = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-testid="cloud-bot-sign-in-card"]');
const q = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("DesktopApp: signing a cloud bot back in to its model", () => {
  it("shows the owner a Signed out of ChatGPT card, and signs the bot back in from it", async () => {
    const w = world();
    await mountRow(w, DM_ROW(SASHA, "Sasha"), "Hi, I am Sasha.");
    await vi.waitFor(() => expect(card()).not.toBeNull());
    expect(card()!.textContent).toContain("Signed out of ChatGPT");
    expect(card()!.textContent).toContain("Sasha can't answer until you sign it back in.");

    card()!.querySelector<HTMLButtonElement>('[data-testid="runtime-repair-primary"]')!.click();
    await vi.waitFor(() => expect(q("brain-reconnect-screen")).not.toBeNull());
    await vi.waitFor(() => expect(w.restartBrainApproval).toHaveBeenCalledWith(SASHA, "codex"));
    await vi.waitFor(() => expect(q("new-bot-codex-code")?.textContent).toBe("ABCD-EFGH"));

    w.status = () => statusOf({ codex: "authorized" });
    await vi.waitFor(() => expect(q("brain-reconnect-screen")?.dataset.phase).toBe("done"), { timeout: 8_000 });
    expect(w.getStatus).toHaveBeenCalledWith(SASHA, "codex");
    expect(card()).toBeNull();

    q("brain-reconnect-close")!.click();
    await settle();
    expect(q("brain-reconnect-screen")).toBeNull();
  });

  it("tells someone who is not the owner who has to sign it back in, with no button", async () => {
    const w = world({ status: () => statusOf({ codex: "expired" }, "prs_ben") });
    await mountRow(w, DM_ROW(SASHA, "Sasha"), "Hi, I am Sasha.", { identities: { prs_ben: "Ben" } });
    await vi.waitFor(() => expect(card()).not.toBeNull());
    expect(card()!.textContent).toContain("Sasha can't answer until Ben signs it back in.");
    expect(card()!.querySelector('[data-testid="runtime-repair-primary"]')).toBeNull();
  });

  it("shows no card for a bot that is signed in", async () => {
    const w = world({ status: () => statusOf({ codex: "authorized" }) });
    await mountRow(w, DM_ROW(SASHA, "Sasha"), "Hi, I am Sasha.");
    await vi.waitFor(() => expect(w.getStatus).toHaveBeenCalled());
    await settle(20);
    expect(card()).toBeNull();
  });

  it("opens HQ's reconnect link in the app, and waits for the owner to press Sign back in", async () => {
    const onopenurl = vi.fn();
    const w = world({
      thread: [
        { eventId: "h1", fromPersonUid: "prs_hq", fromDisplayName: "HQ", body: `Sasha has been signed out. [Sign Sasha back in](${RECONNECT_URL})`, createdAt: "2026-10-13T10:00:00.000Z" },
      ],
    });
    await mountRow(w, DM_ROW("prs_hq", "HQ"), "Sasha has been signed out.", { onopenurl });
    const link = host.querySelector<HTMLAnchorElement>(`a[href="${RECONNECT_URL}"]`);
    expect(link).not.toBeNull();
    link!.click();
    await vi.waitFor(() => expect(q("brain-reconnect-screen")).not.toBeNull());
    expect(onopenurl).not.toHaveBeenCalled();
    expect(q("brain-reconnect-screen")!.textContent).toContain("Sign sasha back in");
    expect(w.restartBrainApproval).not.toHaveBeenCalled();
    q("brain-reconnect-start")!.click();
    await vi.waitFor(() => expect(w.restartBrainApproval).toHaveBeenCalledWith(SASHA, "codex"));
  });

  it("opens the link in the browser when this person may not read the bot's status", async () => {
    const onopenurl = vi.fn();
    const w = world({
      status: () => null,
      thread: [
        { eventId: "h1", fromPersonUid: "prs_hq", fromDisplayName: "HQ", body: `[Sign Sasha back in](${RECONNECT_URL})`, createdAt: "2026-10-13T10:00:00.000Z" },
      ],
    });
    await mountRow(w, DM_ROW("prs_hq", "HQ"), "Sign Sasha back in", { onopenurl });
    host.querySelector<HTMLAnchorElement>(`a[href="${RECONNECT_URL}"]`)!.click();
    await vi.waitFor(() => expect(onopenurl).toHaveBeenCalledWith(RECONNECT_URL));
    expect(q("brain-reconnect-screen")).toBeNull();
  });
});
