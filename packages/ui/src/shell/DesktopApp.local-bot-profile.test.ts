// @vitest-environment happy-dom

/**
 * Local bots get their own profile sheet. When the open DM belongs to one of
 * the user's local bots (adapter.bots.list), the Details / header opener
 * mounts LocalBotDetailPanel — not the cloud AgentDetailPanel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import {
  requestConversation,
  takePendingConversation,
} from "../chat/pending-conversation.js";

const LOCAL_UID = "agt_LOCAL000000000000000000001";
const CLOUD_UID = "agt_374A1JY3NE63KSYBN97PND4QGC";

const LOCAL_BOT: LocalBotRow = {
  name: "assistant",
  agentUid: LOCAL_UID,
  ownerUid: "prs_test",
  runtime: "codex",
  model: "gpt-5",
  state: "running",
  pid: 42,
  processAlive: true,
  online: true,
  lastHeartbeatAt: new Date().toISOString(),
  daemonInstalled: true,
  daemonLoaded: true,
  dir: "/tmp/HQ/personal/workers/assistant",
};

function adapter(bots: LocalBotRow[]): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    identity: {
      listAvatarPacks: async () => ok({ packs: [], expiresAt: Date.now() + 60_000 }),
    },
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
    },
    agents: {
      getStatus: async () => ({ ok: false as const, reason: "forbidden" }),
      listMobileRoster: async () => ok({ agents: [] }),
      listJobs: async () => ok({ jobs: [] }),
      pauseJob: async () => ok({}),
      updateProfile: async () => ok({}),
      stop: async () => ok({}),
      start: async () => ok({}),
      deprovision: async () => ok({}),
      listOwners: async () => ok({ owners: [] }),
      getCompanyTelemetry: async () => ok({ perMember: [] }),
    },
    meetings: {
      listUpcoming: async () => ok([]),
      listMemberships: async () => ok([]),
      listAccounts: async () => ok([]),
      listScheduledBots: async () => ok([]),
    },
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
    bots: {
      list: vi.fn(async () => ok({ bots })),
      create: async () => ok({}),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  window.localStorage?.clear?.();
  takePendingConversation();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("missing", { status: 404 })),
  );
});

afterEach(async () => {
  takePendingConversation();
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage?.clear?.();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountOpen(
  personUid: string,
  displayName: string,
  bots: LocalBotRow[],
) {
  requestConversation({ personUid, email: "", displayName });
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(bots),
      sidebarApi: {
        ...createFixtureChatSidebarApi(),
        listContacts: async () => ({
          contacts: [
            {
              personUid,
              email: "",
              displayName,
              lastMessageAt: new Date().toISOString(),
              lastActivityAt: new Date().toISOString(),
            },
          ],
        }),
      },
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Stefan", email: "s@x.y" },
      coreFixtures: false,
    },
  });
  await tick();
  await vi.waitFor(() => {
    expect(
      host.querySelector('[data-testid="channel-name"]')?.textContent?.trim(),
    ).toBe(displayName);
  });
}

async function openDetailsFromHeader(): Promise<void> {
  const opener = await vi.waitFor(() => {
    const el = host.querySelector<HTMLButtonElement>(
      '[data-testid="channel-header-agent"]',
    );
    expect(el).not.toBeNull();
    return el!;
  });
  opener.click();
  await tick();
}

describe("DesktopApp local bot profile sheet", () => {
  it("opens the local bot panel, not the cloud one, for a local bot's DM", async () => {
    await mountOpen(LOCAL_UID, "assistant", [LOCAL_BOT]);
    await openDetailsFromHeader();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="local-bot-detail"]')).not.toBeNull();
    });
    expect(host.querySelector('[data-testid="agent-detail-panel"]')).toBeNull();
    expect(host.querySelector('[data-testid="local-bot-detail-column"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="local-bot-detail-name"]')?.textContent,
    ).toContain("assistant");
    expect(
      host.querySelector('[data-testid="local-bot-detail"] [data-testid="bot-kind-chip"]')
        ?.textContent?.trim(),
    ).toBe("Local · Codex");
    expect(host.querySelector('[data-testid="local-bot-detail-memory"]')?.textContent).toBe(
      "personal/workers/assistant/memory",
    );

    // Close returns to the plain thread.
    host
      .querySelector<HTMLButtonElement>('[data-testid="local-bot-detail-close"]')!
      .click();
    await tick();
    expect(host.querySelector('[data-testid="local-bot-detail"]')).toBeNull();
  });

  it("still opens the cloud panel for a bot that is not one of the user's local bots", async () => {
    await mountOpen(CLOUD_UID, "Izzy", [LOCAL_BOT]);
    await openDetailsFromHeader();
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="agent-detail-panel"]')).not.toBeNull();
    });
    expect(host.querySelector('[data-testid="local-bot-detail"]')).toBeNull();
  });
});
