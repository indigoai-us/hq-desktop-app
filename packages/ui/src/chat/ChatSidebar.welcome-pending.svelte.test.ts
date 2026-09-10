// @vitest-environment happy-dom

/**
 * Boot pick while the host has not yet said whether the welcome channel's
 * guided setup is owed on this machine. Opening either #welcome or a company
 * channel before the answer would be a guess the person sees (an existing
 * user greeted with Run Setup, or a new user dropped into a bare channel), so
 * the pick waits — and then follows the answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import { SETUP_ROW_ID } from "./setup-channel";
import type { Workspace } from "./workspaces";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const liveRow: ChannelDirectoryRow = {
  channelId: "chn_proj",
  type: "project",
  scope: "project",
  companyUid: "cmp_1",
  name: "launch",
  lastActivityAt: new Date().toISOString(),
};

const ACME: Workspace = {
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "cloud-only",
  cloudUid: "cmp_acme",
  bucketName: null,
  hasLocalFolder: false,
  localPath: null,
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

function stubApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_1",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: [liveRow],
    }),
    listContacts: async () => ({ contacts: [] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
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

async function mountPending() {
  const onselect = vi.fn();
  const props = $state({
    api: stubApi(),
    seedDirectory: [liveRow],
    companies: [ACME],
    welcomeFirst: "pending" as boolean | "pending",
    onselect,
    bootTimeoutMs: 5_000,
  });
  component = mount(ChatSidebar, { target: host, props });
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Neither #welcome nor the live channel: no guess is shown.
  expect(onselect).not.toHaveBeenCalled();
  return { props, onselect };
}

describe("ChatSidebar boot pick while setup-owed is pending", () => {
  it("waits, then opens the live channel when the host says setup is not owed", async () => {
    const { props, onselect } = await mountPending();
    props.welcomeFirst = false;
    await vi.waitFor(() => {
      expect(onselect).toHaveBeenCalled();
    });
    expect(onselect.mock.calls[0]?.[0]?.id).toBe(`ch:${liveRow.channelId}`);
  });

  it("waits, then lands on #welcome when the host says setup is owed", async () => {
    const { props, onselect } = await mountPending();
    props.welcomeFirst = true;
    await vi.waitFor(() => {
      expect(onselect).toHaveBeenCalled();
    });
    expect(onselect.mock.calls[0]?.[0]?.id).toBe(SETUP_ROW_ID);
  });
});
