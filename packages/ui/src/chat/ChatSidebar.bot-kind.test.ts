// @vitest-environment happy-dom

/**
 * Cloud / Local kind chip on the sidebar's DM rows. Every AI teammate is a
 * bot; the chip is the one place a row says which kind — "Cloud" for a
 * company-hosted bot, "Local · Claude Code" for one of the user's own local
 * bots. Humans never get a chip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";
import type { LocalBotRow } from "@hq/platform";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const now = () => new Date().toISOString();

const LOCAL_UID = "agt_01SCOUT";
const CLOUD_UID = "agt_01IZZY";
const HUMAN_UID = "prs_marcus";

const seedRow: ChannelDirectoryRow = {
  channelId: "chn_proj",
  type: "project",
  scope: "project",
  companyUid: "cmp_1",
  name: "launch",
  lastActivityAt: now(),
};

const scout: LocalBotRow = {
  name: "scout",
  agentUid: LOCAL_UID,
  ownerUid: "prs_me",
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

function stubApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_1",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: [seedRow],
    }),
    listContacts: async () => ({
      contacts: [
        { personUid: LOCAL_UID, displayName: "scout", lastActivityAt: now(), lastDmAt: now() },
        { personUid: CLOUD_UID, displayName: "Izzy", lastActivityAt: now(), lastDmAt: now() },
        { personUid: HUMAN_UID, displayName: "Marcus Chen", email: "m@x.y", lastActivityAt: now(), lastDmAt: now() },
      ],
    }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
  };
}

function chipFor(uid: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(
    `[data-conversation-id="dm:${uid}"] [data-testid="bot-kind-chip"]`,
  );
}

beforeEach(() => {
  window.localStorage?.clear?.();
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage?.clear?.();
});

describe("ChatSidebar Cloud / Local kind chip", () => {
  it("marks a local bot DM row 'Local · Claude Code', a cloud bot 'Cloud', and humans nothing", async () => {
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        seedDirectory: [seedRow],
        self: { uid: "prs_me" },
        localBots: [scout],
      },
    });

    await vi.waitFor(() => {
      expect(chipFor(LOCAL_UID)).not.toBeNull();
      expect(chipFor(CLOUD_UID)).not.toBeNull();
    });
    expect(chipFor(LOCAL_UID)?.getAttribute("aria-label")).toBe("Local · Claude Code");
    expect(chipFor(LOCAL_UID)?.dataset.kind).toBe("local");
    expect(chipFor(CLOUD_UID)?.getAttribute("aria-label")).toBe("Cloud");
    expect(chipFor(CLOUD_UID)?.dataset.kind).toBe("cloud");
    expect(host.querySelector(`[data-conversation-id="dm:${HUMAN_UID}"]`)).not.toBeNull();
    expect(chipFor(HUMAN_UID)).toBeNull();
  });

  it("reads every bot as Cloud when the host reports no local bots", async () => {
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        seedDirectory: [seedRow],
        self: { uid: "prs_me" },
        localBots: null,
      },
    });
    await vi.waitFor(() => expect(chipFor(LOCAL_UID)).not.toBeNull());
    expect(chipFor(LOCAL_UID)?.getAttribute("aria-label")).toBe("Cloud");
  });
});
