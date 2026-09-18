// @vitest-environment happy-dom

/**
 * Bots must not clutter the rail. Creating an agent announces it to every
 * member of the company, so a day of fleet work put 31 never-used agent rows
 * — each with a "1" badge from the announcement alone — at the top of a
 * teammate's sidebar. An agent row appears only once there is a real
 * conversation, or the user pinned it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const now = () => new Date().toISOString();

const HUMAN_UID = "prs_marcus";
const TALKATIVE_AGENT = "agt_izzy";

const seedRow: ChannelDirectoryRow = {
  channelId: "chn_proj",
  type: "project",
  scope: "project",
  companyUid: "cmp_1",
  name: "launch",
  lastActivityAt: now(),
};

/** 31 agent stubs, exactly as the directory serves them after a fleet run. */
const stubs = Array.from({ length: 31 }, (_, i) => ({
  personUid: `agt_stub${i}`,
  displayName: `noticefixture-${i}`,
  lastActivityAt: now(),
  lastDmAt: now(),
  unreadCount: 1,
}));

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
        ...stubs,
        {
          personUid: HUMAN_UID,
          displayName: "Marcus Chen",
          email: "m@x.y",
          lastActivityAt: now(),
          lastDmAt: now(),
        },
        {
          personUid: TALKATIVE_AGENT,
          displayName: "Izzy",
          lastActivityAt: now(),
          lastDmAt: now(),
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

describe("ChatSidebar — agent stubs stay off the rail", () => {
  it("renders 2 rows from 31 agent stubs plus 2 real conversations", async () => {
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        seedDirectory: [seedRow],
        self: { uid: "prs_me" },
        engagedAgentUids: [TALKATIVE_AGENT],
      },
    });

    await vi.waitFor(() => {
      expect(
        host.querySelector(`[data-conversation-id="dm:${HUMAN_UID}"]`),
      ).not.toBeNull();
    });
    await vi.waitFor(() => {
      expect(
        host.querySelector(`[data-conversation-id="dm:${TALKATIVE_AGENT}"]`),
      ).not.toBeNull();
    });
    expect(dmRows()).toHaveLength(2);
    expect(
      host.querySelector('[data-conversation-id="dm:agt_stub0"]'),
    ).toBeNull();
  });

  it("emits a rail model with no stub rows in it", async () => {
    const seen: string[] = [];
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        seedDirectory: [seedRow],
        self: { uid: "prs_me" },
        engagedAgentUids: [TALKATIVE_AGENT],
        onrows: (rows) => seen.push(...rows.map((row) => row.id)),
      },
    });
    await vi.waitFor(() => {
      expect(seen).toContain(`dm:${HUMAN_UID}`);
    });
    // The rail model never carries the stubs. Directory reachability (the
    // "+" / typeahead path, which passes includeContactsWithoutConversation)
    // is covered in agent-stubs.test.ts.
    expect(seen).not.toContain("dm:agt_stub0");
    expect(seen).toContain(`dm:${TALKATIVE_AGENT}`);
  });
});
