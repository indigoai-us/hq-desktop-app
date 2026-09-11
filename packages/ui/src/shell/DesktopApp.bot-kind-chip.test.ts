// @vitest-environment happy-dom

/**
 * Cloud / Local kind chip in the conversation header of a bot DM. The shell
 * derives the kind from the host's local-bot list (adapter.bots.list): one of
 * the user's own bots reads "Local · Claude Code", any other bot "Cloud", and
 * a human DM header carries no chip.
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

const LOCAL_UID = "agt_01SCOUT";
const CLOUD_UID = "agt_374A1JY3NE63KSYBN97PND4QGC";
const HUMAN_UID = "prs_marcus";

const scout: LocalBotRow = {
  name: "scout",
  agentUid: LOCAL_UID,
  ownerUid: "prs_test",
  runtime: "claude",
  state: "running",
  pid: 1,
  processAlive: true,
  online: true,
  lastHeartbeatAt: null,
  daemonInstalled: true,
  daemonLoaded: true,
  dir: "/tmp/scout",
};

function webAdapter(bots: LocalBotRow[]): PlatformAdapter {
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
      getStatus: async () => ok({ agent: null, setupState: null }),
      listMobileRoster: async () => ok({ agents: [] }),
      listJobs: async () => ok({ jobs: [] }),
      listOwners: async () => ok({ owners: [] }),
      getCompanyTelemetry: async () => ok({ perMember: [] }),
    },
    bots: {
      list: async () => ok({ bots }),
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

async function mountOpen(personUid: string, displayName: string, bots: LocalBotRow[]) {
  requestConversation({ personUid, email: "", displayName });
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: webAdapter(bots),
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

function headerChip(): HTMLElement | null {
  return host.querySelector<HTMLElement>(
    '[data-testid="channel-header-agent"] [data-testid="bot-kind-chip"]',
  );
}

describe("DesktopApp conversation header kind chip", () => {
  it("shows 'Local · Claude Code' for one of the user's local bots", async () => {
    await mountOpen(LOCAL_UID, "scout", [scout]);
    await vi.waitFor(() => {
      expect(headerChip()?.textContent?.trim()).toBe("Local · Claude Code");
    });
    expect(headerChip()?.dataset.kind).toBe("local");
  });

  it("shows 'Cloud' for a company-hosted bot", async () => {
    await mountOpen(CLOUD_UID, "Izzy", [scout]);
    await vi.waitFor(() => expect(headerChip()).not.toBeNull());
    expect(headerChip()?.textContent?.trim()).toBe("Cloud");
    expect(headerChip()?.dataset.kind).toBe("cloud");
  });

  it("puts no chip on a human DM header", async () => {
    await mountOpen(HUMAN_UID, "Marcus Chen", [scout]);
    expect(host.querySelector('[data-testid="bot-kind-chip"]')).toBeNull();
  });
});
