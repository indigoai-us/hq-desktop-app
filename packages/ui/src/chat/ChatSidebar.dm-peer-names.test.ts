// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import type { Workspace } from "./workspaces.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const WILL = "prs_01M3T6YYR2GTRVXB19DK8N5P3F";
const SEAN = "prs_01M2413XHZEH2RY2MHH97EWB9T";
const NIMA = "prs_01M3WE3C4K6Q3NWWVF9AG20KAZ";
const now = () => new Date().toISOString();

const seedRow: ChannelDirectoryRow = {
  channelId: "chn_proj",
  type: "project",
  scope: "project",
  companyUid: "cmp_1",
  name: "launch",
  lastActivityAt: now(),
};

const COMPANY: Workspace = {
  slug: "capital",
  displayName: "Capital",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_capital",
  bucketName: null,
  hasLocalFolder: true,
  localPath: null,
  membershipStatus: "active",
  role: "member",
} as Workspace;

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
    logToFile: async () => {},
    ensureCompanyHomeChannel: async (companyUid: string) => ({
      homeChannelId: `chn_home_${companyUid}`,
    }),
    ...overrides,
  };
}

function rowText(uid: string): string {
  return (
    host.querySelector(`[data-conversation-id="dm:${uid}"]`)?.textContent ?? ""
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

describe("ChatSidebar DM rows show names, not person ids", () => {
  it("names a uid-only peer from another company's roster, shows the email or Unknown person otherwise", async () => {
    // The global contacts read lists these pairs by uid only (as the DM thread
    // index does when only the caller has written).
    const listContacts = vi.fn(async () => ({
      contacts: [
        { personUid: WILL, lastMessageAt: now() },
        { personUid: SEAN, email: "sean@example.com", lastMessageAt: now() },
        { personUid: NIMA, lastMessageAt: now() },
      ],
    }));
    // The thread holds only the caller's own message: nothing names them.
    const fetchDmThread = vi.fn(async () => ({
      messages: [
        {
          eventId: "e1",
          fromPersonUid: "prs_self",
          fromDisplayName: "Me",
          body: "hi",
          createdAt: now(),
        },
      ],
    }));
    const listCompanyMembers = vi.fn(async (companyUid: string) => ({
      contacts:
        companyUid === "cmp_capital"
          ? [{ personUid: WILL, displayName: "Will McLeod", email: "will@example.com" }]
          : [],
    }));

    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi({
          listContacts,
          fetchDmThread,
          listCompanyMembers,
        } as Partial<ChatSidebarApi>),
        companies: [COMPANY],
        seedDirectory: [seedRow],
        self: { uid: "prs_self" },
      },
    });

    await vi.waitFor(() => {
      expect(rowText(WILL)).toContain("Will McLeod");
    });
    expect(listCompanyMembers).toHaveBeenCalledWith("cmp_capital");
    expect(rowText(SEAN)).toContain("sean@example.com");
    expect(rowText(NIMA)).toContain("Unknown person");
    for (const uid of [WILL, SEAN, NIMA]) {
      expect(rowText(uid)).not.toContain("prs_");
    }
    expect(host.textContent ?? "").not.toMatch(/prs_01M/);
  });
});
