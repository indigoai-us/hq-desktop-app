// @vitest-environment happy-dom

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// The date buckets split at local midnight, and the project channel sits at
// "2 days + 30 min ago": run near midnight it fell into the day before. Pin
// the clock to local noon so every fixture time lands in its intended day.
const FIXED_NOW = new Date(2026, 9, 7, 12, 0, 0);
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(FIXED_NOW);

// Two companies' channels, a project channel, a DM, and an empty channel,
// spread over today, two days ago, and four days ago.
const DAY = 24 * 60;
const seedDirectory: ChannelDirectoryRow[] = [
  { channelId: "chn_hq_sentry", type: "chat", scope: "company", companyUid: "cmp_indigo", name: "hq-sentry", lastActivityAt: iso(2 * DAY), notifyLevel: "muted" },
  { channelId: "chn_hq_dev", type: "chat", scope: "company", companyUid: "cmp_indigo", name: "hq-dev", lastActivityAt: iso(5), unreadCount: 3 },
  { channelId: "chn_acme_general", type: "chat", scope: "company", companyUid: "cmp_acme", name: "acme-general", lastActivityAt: iso(4 * DAY) },
  { channelId: "chn_acme_quiet", type: "chat", scope: "company", companyUid: "cmp_acme", name: "acme-quiet", lastActivityAt: null, createdAt: iso(3) },
  { channelId: "chn_project", type: "project", scope: "project", companyUid: "cmp_indigo", name: "hq-desktop", lastActivityAt: iso(2 * DAY + 30) },
] as ChannelDirectoryRow[];

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

/** Painted sections in order: [section id, row ids]. */
const sections = () =>
  [...host.querySelectorAll<HTMLElement>('.chat-list[aria-labelledby^="chat-sec-"]')].map(
    (list) => [
      list.getAttribute("aria-labelledby") ?? "",
      [...list.querySelectorAll("[data-conversation-id]")].map((el) =>
        el.getAttribute("data-conversation-id"),
      ),
    ] as const,
  );
const allIds = () => sections().flatMap(([, ids]) => ids);
const companyTag = (id: string) =>
  host.querySelector(`[data-conversation-id="${id}"]`)?.closest('[data-testid="chat-row-group"]')
    ?.querySelector('[data-testid="chat-row-scope"][data-kind="company"]')?.textContent?.trim() ?? null;

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

afterAll(() => {
  vi.useRealTimers();
});

describe("ChatSidebar All scope — channels in the date buckets", () => {
  it("interleaves company channels with DMs by most recent message, empty channels last", async () => {
    component = mountSidebar();
    await vi.waitFor(() => expect(allIds()).toContain("ch:chn_acme_general"));
    await vi.waitFor(() => expect(allIds()).toContain("dm:prs_amy"));
    const secs = sections();
    // Today: Amy (1 min) before hq-dev (5 min), in one bucket.
    const today = secs[0]![1];
    expect(today.indexOf("dm:prs_amy")).toBeLessThan(today.indexOf("ch:chn_hq_dev"));
    // Two days ago: hq-sentry before the older project channel.
    const twoDays = secs.find(([, ids]) => ids.includes("ch:chn_hq_sentry"))![1];
    expect(twoDays).toEqual(["ch:chn_hq_sentry", "ch:chn_project"]);
    expect(secs.find(([, ids]) => ids.includes("ch:chn_acme_general"))![1]).toEqual([
      "ch:chn_acme_general",
    ]);
    // No company groups any more.
    expect(host.querySelector('[data-testid="company-channel-group"]')).toBeNull();
    // An empty channel sits in the final "No messages yet" section.
    expect(secs.at(-1)).toEqual(["chat-sec-no-messages", ["ch:chn_acme_quiet"]]);
    expect(allIds().filter((id) => id === "ch:chn_acme_quiet")).toHaveLength(1);
  });

  it("tags each company channel with its company, and keeps muted and unread", async () => {
    component = mountSidebar();
    await vi.waitFor(() => expect(allIds()).toContain("ch:chn_hq_sentry"));
    expect(companyTag("ch:chn_hq_dev")).toBe("Indigo");
    expect(companyTag("ch:chn_acme_general")).toBe("Acme");
    expect(host.querySelector('[data-conversation-id="ch:chn_hq_sentry"] [data-testid="chat-row-muted"]')).toBeTruthy();
    expect(host.querySelector('[data-conversation-id="ch:chn_hq_dev"]')?.textContent).toContain("3");
  });

  it("dates the single-company scope's channels in the same list, without company tags", async () => {
    component = mountSidebar({ scopeUid: "cmp_indigo" });
    await vi.waitFor(() => expect(allIds()).toContain("ch:chn_hq_sentry"));
    // No separate block above the date buckets.
    expect(host.querySelector('[data-testid="company-activity-channels"]')).toBeNull();
    expect(host.querySelector("#chat-activity-label")).toBeNull();
    const secs = sections();
    expect(secs[0]![1]).toContain("ch:chn_hq_dev");
    expect(secs.find(([, ids]) => ids.includes("ch:chn_hq_sentry"))![1]).toEqual([
      "ch:chn_hq_sentry",
      "ch:chn_project",
    ]);
    expect(allIds()).not.toContain("ch:chn_acme_general");
    expect(companyTag("ch:chn_hq_dev")).toBeNull();
  });
});
