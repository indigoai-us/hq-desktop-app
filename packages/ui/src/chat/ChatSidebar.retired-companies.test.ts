// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import type { RetiredEntities, RetiredEntitiesResult } from "./retired-entities.js";
import type { Workspace } from "./workspaces.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

const LIVE: Workspace = {
  slug: "live-co",
  displayName: "Live Co",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_live",
  bucketName: null,
  hasLocalFolder: true,
  localPath: null,
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

// The server keeps listing a retired company's channels with no retired
// marker; a brand-new company's channel can arrive before the company list
// refreshes. Neither is in `companies`.
const directory: ChannelDirectoryRow[] = [
  { channelId: "chn_live", type: "chat", scope: "company", companyUid: "cmp_live", companyName: "Live Co", name: "live-co", lastActivityAt: iso(5) },
  { channelId: "chn_retired", type: "chat", scope: "company", companyUid: "cmp_retired", companyName: "testco123", name: "testco123", lastActivityAt: iso(6) },
  { channelId: "chn_new", type: "chat", scope: "company", companyUid: "cmp_new", companyName: "Brand New", name: "brand-new", lastActivityAt: iso(7) },
] as ChannelDirectoryRow[];

const ANSWERS: Record<string, "gone" | "live"> = {
  cmp_retired: "gone",
  cmp_new: "live",
  agt_lychee: "live",
  agt_scout: "live",
  agt_parsnip: "gone",
};
const BOT_COMPANIES: Record<string, string[]> = {
  agt_lychee: ["cmp_retired"],
  agt_scout: ["cmp_retired", "cmp_live"],
};

function resolver() {
  return vi.fn(async (uids: string[]): Promise<RetiredEntitiesResult> => {
    const out: Required<RetiredEntitiesResult> = {
      retiredCompanyUids: [],
      goneAgentUids: [],
      liveUids: [],
      agentCompanyUids: {},
    };
    const all = new Set(uids);
    for (const uid of uids) for (const c of BOT_COMPANIES[uid] ?? []) all.add(c);
    for (const uid of all) {
      const answer = ANSWERS[uid] ?? "live";
      if (answer === "gone") {
        (uid.startsWith("cmp_") ? out.retiredCompanyUids : out.goneAgentUids).push(uid);
      } else {
        out.liveUids.push(uid);
        if (uid.startsWith("agt_")) out.agentCompanyUids[uid] = BOT_COMPANIES[uid] ?? [];
      }
    }
    return out;
  });
}

function stubApi(resolveRetiredEntities?: ChatSidebarApi["resolveRetiredEntities"]): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_retired_companies_00000000000000000",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: directory,
    }),
    listContacts: async () => ({
      contacts: [
        { personUid: "prs_amy", displayName: "Amy", lastMessageAt: iso(1) },
        { personUid: "agt_lychee", displayName: "Lychee", lastMessageAt: iso(2) },
        { personUid: "agt_scout", displayName: "scout", lastMessageAt: iso(3) },
        { personUid: "agt_parsnip", displayName: "Parsnip", lastMessageAt: iso(4) },
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
    ...(resolveRetiredEntities ? { resolveRetiredEntities } : {}),
  } as unknown as ChatSidebarApi;
}

function mountSidebar(api: ChatSidebarApi, extras: Record<string, unknown> = {}) {
  return mount(ChatSidebar, {
    target: host,
    props: {
      api,
      seedDirectory: directory,
      companies: [LIVE],
      self: { uid: "prs_me", displayName: "Me" },
      tenantAccountId: "acct_test",
      ...extras,
    },
  });
}

const ids = () =>
  [...host.querySelectorAll("[data-conversation-id]")].map((el) => el.getAttribute("data-conversation-id"));

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

describe("ChatSidebar hides what a retired company left behind", () => {
  it("drops the retired company's channel and its bots, keeps live and new companies", async () => {
    const resolve = resolver();
    let emitted: RetiredEntities | null = null;
    let lastRows: string[] = [];
    component = mountSidebar(stubApi(resolve), {
      onretired: (retired: RetiredEntities) => (emitted = retired),
      onrows: (rows: Array<{ id: string }>) => (lastRows = rows.map((r) => r.id)),
    });

    await vi.waitFor(() => expect(ids()).toContain("dm:agt_scout"));
    await vi.waitFor(() => expect(ids()).not.toContain("ch:chn_retired"));
    await vi.waitFor(() => expect(ids()).not.toContain("dm:agt_lychee"));

    expect(ids()).toContain("ch:chn_live");
    // New company: its channel beat the company list; the server says live.
    expect(ids()).toContain("ch:chn_new");
    // Bot that is also in a live company stays; half-deleted bot goes.
    expect(ids()).toContain("dm:agt_scout");
    expect(ids()).not.toContain("dm:agt_parsnip");
    // People stay.
    expect(ids()).toContain("dm:prs_amy");

    // The rows the shell (and the palette) receive are filtered too.
    expect(lastRows).not.toContain("ch:chn_retired");
    expect(lastRows).not.toContain("dm:agt_lychee");
    expect(lastRows).toContain("ch:chn_new");

    // Only uids it cannot place are asked about; the live company never is.
    const asked = resolve.mock.calls.flatMap(([uids]) => uids);
    expect(asked).toContain("cmp_retired");
    expect(asked).toContain("cmp_new");
    expect(asked).not.toContain("cmp_live");
    expect(emitted).not.toBeNull();
    expect([...(emitted as unknown as RetiredEntities).retiredCompanyUids]).toEqual(["cmp_retired"]);
  });

  it("hides nothing when the read fails", async () => {
    const failing = vi.fn(async () => {
      throw new Error("HTTP 503");
    });
    component = mountSidebar(stubApi(failing));
    await vi.waitFor(() => expect(failing).toHaveBeenCalled());
    await vi.waitFor(() => expect(ids()).toContain("ch:chn_retired"));
    expect(ids()).toContain("dm:agt_lychee");
    expect(ids()).toContain("ch:chn_new");
  });

  it("hides nothing on a host without the seam", async () => {
    component = mountSidebar(stubApi());
    await vi.waitFor(() => expect(ids()).toContain("ch:chn_retired"));
    expect(ids()).toContain("ch:chn_live");
  });
});
