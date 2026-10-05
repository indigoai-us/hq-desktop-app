// @vitest-environment happy-dom

/** Regression: bot conversations use the same activity rule as human DMs. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const now = () => new Date().toISOString();

const BOT_UID = "agt_izzy";
const DIRECTORY_ONLY_AGENT_UID = "agt_directory_only";

const seedRow: ChannelDirectoryRow = {
  channelId: "chn_proj",
  type: "project",
  scope: "project",
  companyUid: "cmp_1",
  name: "launch",
  lastActivityAt: now(),
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
        {
          personUid: BOT_UID,
          displayName: "Izzy",
          lastActivityAt: now(),
          lastDmAt: now(),
        },
        {
          personUid: DIRECTORY_ONLY_AGENT_UID,
          displayName: "Directory only",
        },
      ],
    }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
    logToFile: async () => {},
    ensureCompanyHomeChannel: async (companyUid: string) => ({ homeChannelId: `chn_home_${companyUid}` }),
  };
}

function dmRows(): HTMLElement[] {
  return [
    ...host.querySelectorAll<HTMLElement>('[data-conversation-id^="dm:"]'),
  ];
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

describe("ChatSidebar — bot conversations survive a fresh-install remount", () => {
  it("shows a bot DM with activity with empty local storage and after remount", async () => {
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        seedDirectory: [seedRow],
        self: { uid: "prs_me" },
      },
    });

    await vi.waitFor(() => {
      expect(
        host.querySelector(`[data-conversation-id="dm:${BOT_UID}"]`),
      ).not.toBeNull();
    });
    expect(
      host.querySelector(`[data-conversation-id="dm:${DIRECTORY_ONLY_AGENT_UID}"]`),
    ).toBeNull();
    expect(window.localStorage?.getItem("hq.chat.agent-engaged")).toBeNull();

    await unmount(component);
    component = null;
    host.remove();
    host = document.createElement("div");
    host.className = "desktop-shell chat-shell";
    document.body.appendChild(host);
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        seedDirectory: [seedRow],
        self: { uid: "prs_me" },
      },
    });
    await vi.waitFor(() => {
      expect(
        host.querySelector(`[data-conversation-id="dm:${BOT_UID}"]`),
      ).not.toBeNull();
    });
    expect(dmRows()).toHaveLength(1);
  });
});
