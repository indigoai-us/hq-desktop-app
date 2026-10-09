// @vitest-environment happy-dom

/**
 * Regression: a company pane painted its company channels in a separate
 * "ACTIVITY" block above the date buckets, so channels with week-old or no
 * activity sat above today's DMs. Every entry path must paint one
 * chronological list.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import type { Workspace } from "./workspaces.js";
import { railInboxRows } from "./sidebar-model";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const memoryStorage = installMemoryLocalStorage();

const FIXED_NOW = new Date(2026, 9, 8, 12, 0, 0);
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(FIXED_NOW);

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

const DAY = 24 * 60;
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

// Company channels: one stale, one undated with a creation time, one with no
// time at all. A project channel from yesterday. A DM from a minute ago.
const seedDirectory = [
  { channelId: "chn_sentry", type: "chat", scope: "company", companyUid: "cmp_indigo", name: "hq-sentry", lastActivityAt: iso(3 * DAY) },
  { channelId: "chn_dev", type: "chat", scope: "company", companyUid: "cmp_indigo", name: "hq-dev", lastActivityAt: iso(30) },
  { channelId: "chn_news", type: "chat", scope: "company", companyUid: "cmp_indigo", name: "hq-newsletters", lastActivityAt: null, createdAt: iso(2 * DAY) },
  { channelId: "chn_crew", type: "chat", scope: "company", companyUid: "cmp_indigo", name: "crew", lastActivityAt: null },
  { channelId: "chn_project", type: "project", scope: "project", companyUid: "cmp_indigo", name: "hq-core-staging-repo", lastActivityAt: iso(DAY) },
] as ChannelDirectoryRow[];

function stubApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_rail_chronological_0000000000000",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: seedDirectory,
    }),
    listContacts: async () => ({
      contacts: [{ personUid: "prs_hassaan", displayName: "Hassaan Saleem", lastMessageAt: iso(1) }],
    }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
    logToFile: async () => {},
    ensureCompanyHomeChannel: async () => ({ homeChannelId: "chn_dev" }),
  } as unknown as ChatSidebarApi;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function mountSidebar(extras: Record<string, unknown> = {}) {
  component = mount(ChatSidebar, {
    target: host,
    props: {
      api: stubApi(),
      seedDirectory,
      companies: [INDIGO],
      self: { uid: "prs_corey", displayName: "Corey" },
      tenantAccountId: "acct_test",
      ...extras,
    },
  });
}

/** Painted rows in order, with the section each sits in. */
const painted = () =>
  [...host.querySelectorAll<HTMLElement>(".chat-list")].flatMap((list) =>
    [...list.querySelectorAll("[data-conversation-id]")].map((el) => ({
      section: list.getAttribute("aria-labelledby") ?? list.getAttribute("data-testid") ?? "",
      id: el.getAttribute("data-conversation-id") ?? "",
    })),
  );
const ids = () =>
  painted()
    .filter((r) => r.section !== "chat-pinned-label")
    .map((r) => r.id);

const EXPECTED_ORDER = [
  "dm:prs_hassaan",
  "ch:chn_dev",
  "ch:chn_project",
  "ch:chn_sentry",
];

async function settled(): Promise<void> {
  await vi.waitFor(() => {
    for (const id of [...EXPECTED_ORDER, "ch:chn_news", "ch:chn_crew"]) expect(ids()).toContain(id);
  });
  await tick();
}

function assertOneChronologicalList(): void {
  expect(host.querySelector('[data-testid="company-activity-channels"]')).toBeNull();
  expect(host.querySelector("#chat-activity-label")).toBeNull();
  // Only the app's own pinned row (#setup) may sit above the date buckets;
  // every seeded conversation is in a date (or "No messages yet") section.
  const rows = painted().filter((row) => row.section !== "chat-pinned-label");
  for (const row of rows) expect(row.section).toMatch(/^chat-sec-/);
  // Dated rows run newest first, DMs and channels interleaved.
  const dated = ids().filter((id) => EXPECTED_ORDER.includes(id));
  expect(dated).toEqual(EXPECTED_ORDER);
  // The newest row heads the list; undated channels never jump above it.
  expect(rows[0]!.id).toBe("dm:prs_hassaan");
  const crew = ids().indexOf("ch:chn_crew");
  const sentry = ids().indexOf("ch:chn_sentry");
  expect(crew).toBeGreaterThan(sentry);
}

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

describe("Messages rail is one chronological list on every entry path", () => {
  it("cold start in a company pane", async () => {
    mountSidebar({ scopeUid: "cmp_indigo" });
    await settled();
    assertOneChronologicalList();
  });

  it("cold start in All", async () => {
    mountSidebar();
    await settled();
    assertOneChronologicalList();
  });

  it("switching to the company with the company picker", async () => {
    mountSidebar();
    await settled();
    (host.querySelector('[data-testid="chat-scope-pill"]') as HTMLElement).click();
    await tick();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="chat-scope-option"][data-scope="cmp_indigo"]')).not.toBeNull(),
    );
    (document.querySelector('[data-testid="chat-scope-option"][data-scope="cmp_indigo"]') as HTMLElement).click();
    await tick();
    await settled();
    assertOneChronologicalList();
  });

  it("opening a project channel (board or drawer)", async () => {
    mountSidebar({ scopeUid: "cmp_indigo", selectedId: "ch:chn_project" });
    await settled();
    assertOneChronologicalList();
  });

  it("deep link to a stale company channel", async () => {
    mountSidebar({ scopeUid: "cmp_indigo", selectedId: "ch:chn_sentry" });
    await settled();
    assertOneChronologicalList();
  });
});

describe("railInboxRows", () => {
  const row = (id: string, scope: string) =>
    ({ id, kind: "channel", channelScope: scope, lastActivityAt: 0 }) as never;
  const rows = [row("a", "company"), row("b", "project")];

  it("keeps company channels in a company pane and in All", () => {
    expect(railInboxRows(rows, "cmp_indigo").map((r: { id: string }) => r.id)).toEqual(["a", "b"]);
    expect(railInboxRows(rows, "all").map((r: { id: string }) => r.id)).toEqual(["a", "b"]);
  });

  it("leaves company channels out of Personal", () => {
    expect(railInboxRows(rows, "personal").map((r: { id: string }) => r.id)).toEqual(["b"]);
  });
});
