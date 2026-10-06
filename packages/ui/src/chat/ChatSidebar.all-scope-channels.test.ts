// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import type { Workspace } from "./workspaces.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const memoryStorage = installMemoryLocalStorage();


let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const now = () => new Date().toISOString();

const INDIGO: Workspace = {
  slug: "indigo",
  displayName: "Indigo",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_indigo",
  bucketName: null,
  hasLocalFolder: true,
  localPath: null,
  membershipStatus: "active",
  role: "member",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

const ACME: Workspace = {
  ...INDIGO,
  slug: "acme",
  displayName: "Acme",
  cloudUid: "cmp_acme",
};

const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

// Two companies' channels plus a project channel and a DM-capable roster.
const seedDirectory: ChannelDirectoryRow[] = [
  { channelId: "chn_hq_sentry", type: "chat", scope: "company", companyUid: "cmp_indigo", name: "hq-sentry", lastActivityAt: iso(30), notifyLevel: "muted" },
  { channelId: "chn_hq_dev", type: "chat", scope: "company", companyUid: "cmp_indigo", name: "hq-dev", lastActivityAt: iso(5), unreadCount: 3 },
  { channelId: "chn_acme_general", type: "chat", scope: "company", companyUid: "cmp_acme", name: "acme-general", lastActivityAt: iso(60) },
  { channelId: "chn_project", type: "project", scope: "project", companyUid: "cmp_indigo", name: "hq-desktop", lastActivityAt: iso(2) },
];

function stubApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_all_scope_channels_000000000000000",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: seedDirectory,
    }),
    listContacts: async () => ({
      contacts: [{ personUid: "prs_amy", displayName: "Amy", lastMessageAt: iso(1) }],
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
  } as unknown as ChatSidebarApi;
}

function mountSidebar(extras: Record<string, unknown> = {}) {
  return mount(ChatSidebar, {
    target: host,
    props: {
      api: stubApi(),
      seedDirectory,
      companies: [INDIGO, ACME],
      self: { uid: "prs_stefan", displayName: "Stefan" },
      selectedId: "ch:chn_hq_dev",
      tenantAccountId: "acct_test",
      ...extras,
    },
  });
}

const groups = () =>
  [...host.querySelectorAll<HTMLElement>('[data-testid="company-channel-group"]')];
const groupRowIds = (uid: string) => {
  const header = host.querySelector(`[data-testid="company-channel-group"][data-company-uid="${uid}"]`);
  const list = header?.nextElementSibling;
  if (!list || list.getAttribute("data-testid") !== "company-channel-group-rows") return [];
  return [...list.querySelectorAll("[data-conversation-id]")].map((el) => el.getAttribute("data-conversation-id"));
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
});

describe("ChatSidebar All scope — company channels", () => {
  it("lists every company's channels grouped by company, newest company first", async () => {
    component = mountSidebar();
    await vi.waitFor(() => expect(groups().length).toBe(2));
    expect(groups().map((g) => g.getAttribute("data-company-uid"))).toEqual(["cmp_indigo", "cmp_acme"]);
    expect(groups()[0]?.textContent).toContain("Indigo");
    expect(groupRowIds("cmp_indigo")).toEqual(["ch:chn_hq_dev", "ch:chn_hq_sentry"]);
    expect(groupRowIds("cmp_acme")).toEqual(["ch:chn_acme_general"]);
    // The single-company Activity section stays out of All.
    expect(host.querySelector('[data-testid="company-activity-channels"]')).toBeNull();
  });

  it("keeps muted and unread state on grouped rows", async () => {
    component = mountSidebar();
    await vi.waitFor(() => expect(groupRowIds("cmp_indigo").length).toBe(2));
    expect(host.querySelector('[data-conversation-id="ch:chn_hq_sentry"] [data-testid="chat-row-muted"]')).toBeTruthy();
    expect(host.querySelector('[data-conversation-id="ch:chn_hq_dev"]')?.textContent).toContain("3");
  });

  it("remembers a collapsed company group across remounts", async () => {
    component = mountSidebar();
    await vi.waitFor(() => expect(groups().length).toBe(2));
    groups()[0]!.click();
    await vi.waitFor(() => expect(groupRowIds("cmp_indigo")).toEqual([]));
    expect(groups()[0]?.getAttribute("aria-expanded")).toBe("false");
    // Collapsed with unread: the header carries the count.
    expect(groups()[0]?.querySelector('[data-testid="company-channel-group-unread"]')?.textContent).toBe("3");
    await unmount(component);
    host.innerHTML = "";
    component = mountSidebar();
    await vi.waitFor(() => expect(groups().length).toBe(2));
    expect(groups()[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(groupRowIds("cmp_acme")).toEqual(["ch:chn_acme_general"]);
  });

  it("leaves the single-company scope on its Activity section", async () => {
    component = mountSidebar({ scopeUid: "cmp_indigo" });
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="company-activity-channels"]')).toBeTruthy(),
    );
    const ids = [...host.querySelectorAll('[data-testid="company-activity-channels"] [data-conversation-id]')].map((el) => el.getAttribute("data-conversation-id"));
    expect(ids).toEqual(["ch:chn_hq_dev", "ch:chn_hq_sentry"]);
    expect(groups()).toEqual([]);
  });
});
