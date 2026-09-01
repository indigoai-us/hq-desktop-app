// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import { agentAvatarAssets, agentAvatarFor } from "./messaging/agent-avatars";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const now = () => new Date().toISOString();
const PHOTO_URL = "https://cdn.test/agent.png";

const seedRow: ChannelDirectoryRow = {
  channelId: "chn_proj",
  type: "project",
  scope: "project",
  companyUid: "cmp_1",
  name: "launch",
  lastActivityAt: new Date().toISOString(),
};

function stubApi(overrides: Partial<ChatSidebarApi> = {}): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_1",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: [seedRow],
    }),
    listContacts: async () => ({ contacts: [] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
    ...overrides,
  };
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

describe("ChatSidebar DM avatars", () => {
  it("renders photo, generated, and initials avatars on DM rows", async () => {
    const api = stubApi({
      listContacts: async () => ({
        contacts: [
          {
            personUid: "agt_photo",
            displayName: "Photo Agent",
            lastActivityAt: now(),
            lastDmAt: now(),
          },
          {
            personUid: "agt_plain",
            displayName: "Plain Agent",
            lastActivityAt: now(),
            lastDmAt: now(),
          },
          {
            personUid: "prs_h",
            displayName: "Ada Lovelace",
            lastActivityAt: now(),
            lastDmAt: now(),
          },
        ],
      }),
    });

    component = mount(ChatSidebar, {
      target: host,
      props: {
        api,
        seedDirectory: [seedRow],
        avatarByUid: { agt_photo: PHOTO_URL },
        self: { uid: "prs_stefan" },
      },
    });

    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-conversation-id="dm:agt_photo"]'),
      ).toBeTruthy();
      expect(
        host.querySelector('[data-conversation-id="dm:agt_plain"]'),
      ).toBeTruthy();
      expect(
        host.querySelector('[data-conversation-id="dm:prs_h"]'),
      ).toBeTruthy();
    });
    await tick();

    const photo = host.querySelector(
      '[data-testid="chat-dm-avatar"][data-avatar="photo"]',
    );
    expect(photo?.querySelector("img")?.getAttribute("src")).toBe(PHOTO_URL);

    const generated = host.querySelector(
      '[data-testid="chat-dm-avatar"][data-avatar="generated"]',
    );
    const generatedSrc = generated?.querySelector("img")?.getAttribute("src");
    expect(agentAvatarAssets).toContain(generatedSrc);
    expect(generatedSrc).toBe(agentAvatarFor("agt_plain"));

    const human = host.querySelector(
      '[data-conversation-id="dm:prs_h"] [data-testid="chat-dm-avatar"]',
    );
    expect(human?.getAttribute("data-avatar")).toBe("initials");
    expect(human?.querySelector("img")).toBeNull();
    expect(human?.textContent?.trim()).toBe("AL");
  });
});
