import { describe, expect, it, vi } from "vitest";
import type { MeshShellOverlay } from "@hq/core";
import type { ConversationRow } from "../chat/sidebar-model.js";
import {
  applyChannelRoster,
  createCacheSidebarApi,
  createHybridSidebarApi,
  dmBundleFromRawSnapshot,
  identitiesFromContacts,
  liveAgentsFromWorkThreads,
  membersFromMeshMessages,
  parseChannelMembers,
  resolveEntityDisplayName,
  searchRowsFromOverlay,
  statusForRow,
} from "./mesh-overlay.js";
import type { ChatSidebarApi } from "../chat/chat-api.js";

const row: ConversationRow = {
  id: "ch:work-mesh-testing",
  kind: "channel",
  title: "work-mesh-testing",
  companyUid: "cmp_indigo",
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
  channelId: "work-mesh-testing",
  channelScope: "project",
};

const overlay: MeshShellOverlay = {
  rows: [],
  messagesByChannelId: {},
  boardByChannelId: {},
  filesByChannelId: {},
  statusByChannelId: {
    "work-mesh-testing": {
      companyLabel: "Indigo",
      description: "Live board for HQ Work mesh.",
      storiesTotal: 9,
      storiesComplete: 8,
      repos: [
        {
          path: "repos/private/hq-core-staging",
          branch: "feature/work-mesh-testing",
        },
        {
          path: "repos/private/hq-pro",
          branch: "feature/work-mesh-project-view",
        },
        {
          path: "repos/public/hq-desktop-app",
          branch: "feature/work-mesh-project-view",
        },
      ],
      liveAgents: [],
    },
  },
};

describe("statusForRow mesh repos", () => {
  it("passes the full repos[] through to the shared popover model", () => {
    const model = statusForRow(row, overlay, () => null);
    expect(model?.project.repos).toEqual([
      {
        path: "repos/private/hq-core-staging",
        branch: "feature/work-mesh-testing",
      },
      {
        path: "repos/private/hq-pro",
        branch: "feature/work-mesh-project-view",
      },
      {
        path: "repos/public/hq-desktop-app",
        branch: "feature/work-mesh-project-view",
      },
    ]);
    expect(model?.project.repo).toBe("repos/private/hq-core-staging");
    expect(model?.project.branch).toBe("feature/work-mesh-testing");
    expect(model?.project.description).toBe("Live board for HQ Work mesh.");
  });

  it("uses the fallback when a live directory row has no PROJECT_VIEW yet", () => {
    const fill = {
      liveAgents: [
        {
          id: "a1",
          label: "Agent running · US-002 · 62%",
          storyId: "US-002",
          progressPercent: 62,
          status: "running" as const,
          tool: null,
          displayName: "Desktop Agent",
        },
      ],
      activeSessions: [],
      stories: { complete: 7, total: 12, label: "stories 7/12", percent: 58 },
      project: { branch: null, repo: null, repos: [], previewUrl: null },
      members: [
        {
          personUid: "prs_corey",
          displayName: "Corey",
          role: "owner",
          email: null,
          avatarUrl: null,
          description: null,
          statusIcon: "idle" as const,
        },
      ],
      agents: [],
      memberCount: 1,
      companyLabel: "Indigo",
    };
    const liveRow: ConversationRow = {
      ...row,
      channelId: "chn_01NOVIEW",
    };
    const liveOverlay: MeshShellOverlay = {
      ...overlay,
      messagesByChannelId: { chn_01NOVIEW: [] },
      statusByChannelId: {},
    };
    const model = statusForRow(liveRow, liveOverlay, () => fill);
    expect(model?.members.map((m) => m.displayName)).toEqual(["Corey"]);
    expect(model?.liveAgents[0]?.progressPercent).toBe(62);
    expect(model?.stories.total).toBe(12);
  });

  it("does not backfill Corey fixtures when a PROJECT_VIEW exists", () => {
    const model = statusForRow(row, overlay, () => ({
      liveAgents: [
        {
          id: "a1",
          label: "Agent running · US-002 · 62%",
          storyId: "US-002",
          progressPercent: 62,
          status: "running",
          tool: null,
          displayName: "Desktop Agent",
        },
      ],
      activeSessions: [],
      stories: { complete: 0, total: 0, label: "stories 0/0", percent: 0 },
      project: { branch: null, repo: null, repos: [], previewUrl: null },
      members: [
        {
          personUid: "prs_corey",
          displayName: "Corey",
          role: "owner",
          email: null,
          avatarUrl: null,
          description: null,
          statusIcon: "idle",
        },
      ],
      agents: [
        {
          personUid: "agt_desktop",
          displayName: "Desktop Agent",
          role: "agent",
          email: null,
          avatarUrl: null,
          description: null,
          statusIcon: "running",
        },
      ],
      memberCount: 1,
      companyLabel: "Indigo",
    }));
    expect(model?.members).toEqual([]);
    expect(model?.agents).toEqual([]);
    expect(model?.liveAgents).toEqual([]);
    expect(model?.stories).toEqual({
      complete: 8,
      total: 9,
      label: "stories 8/9",
      percent: 89,
    });
  });

  it("does not treat PROJECT_VIEW.updatedBy as the project creator", () => {
    const liveOverlay: MeshShellOverlay = {
      ...overlay,
      statusByChannelId: {
        "work-mesh-testing": {
          ...overlay.statusByChannelId["work-mesh-testing"]!,
          projectId: "work-mesh-testing",
          updatedBy: "prs_01KQ2RY9VB1S105X2GZ2EPHKWY",
        },
      },
    };
    const model = statusForRow(row, liveOverlay, () => null);
    expect(model?.members).toEqual([]);
    expect(model?.agents).toEqual([]);
  });

  it("renders the channel owner/creator entity, person or agent", () => {
    const liveOverlay: MeshShellOverlay = {
      ...overlay,
      statusByChannelId: {
        "work-mesh-testing": {
          ...overlay.statusByChannelId["work-mesh-testing"]!,
          projectId: "work-mesh-testing",
          updatedBy: "prs_someone_else",
        },
      },
    };
    const person = statusForRow(row, liveOverlay, () => null, {
      channelMembers: [
        {
          personUid: "prs_stefan",
          displayName: "Stefan Johnson",
          role: "owner",
        },
      ],
    });
    expect(person?.members.map((m) => m.displayName)).toEqual([
      "Stefan Johnson",
    ]);
    expect(person?.agents).toEqual([]);

    const agent = statusForRow(row, liveOverlay, () => null, {
      channelMembers: [
        {
          personUid: "agt_01KVH90TQ07PB1Z8CR6GG3HBAE",
          role: "owner",
          isAgent: true,
        },
      ],
      identities: { agt_01KVH90TQ07PB1Z8CR6GG3HBAE: "Grok" },
    });
    expect(agent?.members).toEqual([]);
    expect(agent?.agents.map((a) => a.displayName)).toEqual(["Grok"]);
  });

  it("joins a live agent uid through identities, not the last view writer", () => {
    const liveOverlay: MeshShellOverlay = {
      ...overlay,
      statusByChannelId: {
        "work-mesh-testing": {
          ...overlay.statusByChannelId["work-mesh-testing"]!,
          projectId: "work-mesh-testing",
          updatedBy: "prs_stefan",
        },
      },
    };
    const model = statusForRow(row, liveOverlay, () => null, {
      channelMembers: [
        {
          personUid: "agt_deacon",
          displayName: "Deacon",
          role: "owner",
          isAgent: true,
        },
      ],
      workThreads: [
        {
          threadId: "T-1",
          companyUid: "cmp_indigo",
          project: "work-mesh-testing",
          title: "status popover",
          status: "progress",
          storyId: "US-008",
          updatedAt: "2026-08-16T17:00:00Z",
          actor: "agt_deacon",
          note: "wiring members",
        },
      ],
    });
    expect(model?.agents.map((a) => a.displayName)).toEqual(["Deacon"]);
    expect(model?.liveAgents[0]).toMatchObject({
      displayName: "Deacon",
      storyId: "US-008",
      status: "running",
    });
  });
});

describe("entity display names", () => {
  it("refuses to keep a principal uid as the visible label", () => {
    expect(
      resolveEntityDisplayName(
        "prs_01KQ2RY9VB1S105X2GZ2EPHKWY",
        "prs_01KQ2RY9VB1S105X2GZ2EPHKWY",
        "Stefan Johnson",
      ),
    ).toBe("Stefan Johnson");
    expect(
      resolveEntityDisplayName("agt_01KVH90TQ07PB1Z8CR6GG3HBAE", "Grok"),
    ).toBe("Grok");
  });

  it("parses notify members and applies the identities join", () => {
    const roster = parseChannelMembers({
      members: [
        {
          personUid: "agt_01KVH90TQ07PB1Z8CR6GG3HBAE",
          displayName: "agt_01KVH90TQ07PB1Z8CR6GG3HBAE",
          role: "owner",
        },
      ],
    });
    const model = applyChannelRoster(
      {
        liveAgents: [],
        activeSessions: [],
        stories: { complete: 0, total: 0, label: "stories 0/0", percent: 0 },
        project: { branch: null, repo: null, repos: [], previewUrl: null },
        members: [],
        agents: [],
        memberCount: 0,
        companyLabel: "Indigo",
      },
      roster,
      identitiesFromContacts([
        {
          personUid: "agt_01KVH90TQ07PB1Z8CR6GG3HBAE",
          displayName: "Grok",
        },
      ]),
    );
    expect(model.agents.map((a) => a.displayName)).toEqual(["Grok"]);
    expect(model.members).toEqual([]);
  });
});

describe("membersFromMeshMessages", () => {
  it("dedupes posters and tags agt_* as agents", () => {
    const rows = membersFromMeshMessages([
      {
        eventId: "1",
        fromPersonUid: "prs_stefan",
        fromDisplayName: "Stefan Johnson",
        createdAt: "2026-08-16T00:00:00.000Z",
      },
      {
        eventId: "2",
        fromPersonUid: "prs_stefan",
        fromDisplayName: "Stefan Johnson",
        createdAt: "2026-08-16T00:01:00.000Z",
      },
      {
        eventId: "3",
        fromPersonUid: "agt_deacon",
        fromDisplayName: "Deacon",
        createdAt: "2026-08-16T00:02:00.000Z",
      },
    ]);
    expect(rows.map((r) => [r.personUid, r.isAgent])).toEqual([
      ["prs_stefan", false],
      ["agt_deacon", true],
    ]);
  });
});

describe("liveAgentsFromWorkThreads", () => {
  it("ignores threads for other projects and threads with no owner", () => {
    expect(
      liveAgentsFromWorkThreads(
        [
          {
            threadId: "T-other",
            companyUid: "c",
            project: "other",
            title: "x",
            status: "progress",
            storyId: "US-1",
            updatedAt: null,
            actor: "agt_x",
            note: null,
          },
          {
            threadId: "T-bare",
            companyUid: "c",
            project: "work-mesh-testing",
            title: "x",
            status: "progress",
            storyId: "US-2",
            updatedAt: null,
            actor: null,
            note: null,
          },
        ],
        "work-mesh-testing",
        [],
      ),
    ).toEqual([]);
  });
});

describe("searchRowsFromOverlay titles", () => {
  it("strips genesis Project + hash chrome so the header matches the sidebar", () => {
    const rows = searchRowsFromOverlay({
      rows: [
        {
          channelId: "chn_wmt",
          type: "project",
          scope: "project",
          companyUid: "cmp_indigo",
          name: "Project wmt-us002-20260816 446f05ca",
          lastActivityAt: "2026-08-16T00:00:00.000Z",
          unreadCount: 0,
          memberCount: 2,
        },
      ],
      messagesByChannelId: {},
      boardByChannelId: {},
      filesByChannelId: {},
      statusByChannelId: {},
    });
    expect(rows[0]?.title).toBe("wmt-us002-20260816");
  });
});

describe("createHybridSidebarApi", () => {
  it("uses the live directory when hq-pro returns rows", async () => {
    const live: ChatSidebarApi = {
      fetchChannelDirectory: async () => ({
        contractVersion: 2,
        snapshot: true,
        cursor: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        cursorExpiresAt: "2026-09-01T00:00:00.000Z",
        rows: [
          {
            channelId: "live-1",
            scope: "project",
            name: "Live",
            lastActivityAt: null,
          },
        ],
      }),
      listContacts: async () => ({ contacts: [] }),
      listDmRequests: async () => ({ requests: [] }),
      listChannels: async () => ({ channels: [] }),
      markDmThreadRead: async () => {},
      markChannelRead: async () => {},
      sendChannelMessage: async () => {},
      sendDm: async () => {},
      searchMessages: async () => ({ results: [] }),
    };
    const api = createHybridSidebarApi(live, () => overlay);
    const feed = await api.fetchChannelDirectory(null);
    expect(feed.rows?.[0]?.channelId).toBe("live-1");
  });

  it("falls back to the overlay when the live feed is empty", async () => {
    const seeded: MeshShellOverlay = {
      ...overlay,
      rows: [
        {
          channelId: "cache-1",
          type: "project",
          scope: "project",
          companyUid: "cmp_indigo",
          name: "Cached",
          lastActivityAt: "2026-08-16T00:00:00.000Z",
          unreadCount: 0,
          memberCount: 0,
        },
      ],
    };
    const live: ChatSidebarApi = {
      fetchChannelDirectory: async () => ({
        contractVersion: 2,
        snapshot: true,
        cursor: "cccccccccccccccccccccccccccccccc",
        cursorExpiresAt: "2026-09-01T00:00:00.000Z",
        rows: [],
      }),
      listContacts: async () => ({ contacts: [] }),
      listDmRequests: async () => ({ requests: [] }),
      listChannels: async () => ({ channels: [] }),
      markDmThreadRead: async () => {},
      markChannelRead: async () => {},
      sendChannelMessage: async () => {},
      sendDm: async () => {},
      searchMessages: async () => ({ results: [] }),
    };
    const api = createHybridSidebarApi(live, () => seeded);
    const feed = await api.fetchChannelDirectory(null);
    expect(feed.rows?.[0]?.channelId).toBe("cache-1");
  });
});

describe("createHybridSidebarApi optional live capabilities", () => {
  function liveApi(extra: Partial<ChatSidebarApi> = {}): ChatSidebarApi {
    return {
      fetchChannelDirectory: async () => ({
        contractVersion: 2,
        snapshot: true,
        cursor: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        cursorExpiresAt: "2026-09-01T00:00:00.000Z",
        rows: [],
      }),
      listContacts: async () => ({ contacts: [] }),
      listDmRequests: async () => ({ requests: [] }),
      listChannels: async () => ({ channels: [] }),
      markDmThreadRead: async () => {},
      markChannelRead: async () => {},
      sendChannelMessage: async () => {},
      sendDm: async () => {},
      searchMessages: async () => ({ results: [] }),
      ...extra,
    };
  }

  it("forwards listCompanyMembers and sendDmToEmail from live", async () => {
    const listCompanyMembers = vi.fn(async () => ({
      contacts: [{ personUid: "prs_kai" }],
    }));
    const sendDmToEmail = vi.fn(async () => ({ state: "delivered" as const }));
    const api = createHybridSidebarApi(
      liveApi({ listCompanyMembers, sendDmToEmail }),
      () => overlay,
    );
    expect(await api.listCompanyMembers?.("cmp_indigo")).toEqual({
      contacts: [{ personUid: "prs_kai" }],
    });
    expect(listCompanyMembers).toHaveBeenCalledWith("cmp_indigo");
    await api.sendDmToEmail?.({ toEmail: "kai@acme.test", body: "hi" });
    expect(sendDmToEmail).toHaveBeenCalledWith({
      toEmail: "kai@acme.test",
      body: "hi",
    });
  });

  it("leaves both undefined when live lacks them, and prefers persist for sendDmToEmail", async () => {
    const bare = createHybridSidebarApi(liveApi(), () => overlay);
    expect(bare.listCompanyMembers).toBeUndefined();
    expect(bare.sendDmToEmail).toBeUndefined();

    const liveSend = vi.fn(async () => ({ state: "delivered" as const }));
    const persistSend = vi.fn(async () => ({
      state: "connectionRequested" as const,
    }));
    const api = createHybridSidebarApi(
      liveApi({ sendDmToEmail: liveSend }),
      () => overlay,
      undefined,
      { sendDmToEmail: persistSend },
    );
    await api.sendDmToEmail?.({ toEmail: "kai@acme.test", body: "hi" });
    expect(persistSend).toHaveBeenCalledTimes(1);
    expect(liveSend).not.toHaveBeenCalled();
  });
});

describe("dmBundleFromRawSnapshot", () => {
  it("merges contacts + inbox + pair threads the directory does not carry", () => {
    const bundle = dmBundleFromRawSnapshot({
      contacts: [
        {
          contacts: [{ personUid: "prs_jacob", displayName: "Jacob Posel" }],
        },
      ],
      inbox: [
        {
          events: [
            {
              fromPersonUid: "prs_jacob",
              fromDisplayName: "Jacob Posel",
              createdAt: "2026-08-16T21:10:27.909Z",
            },
          ],
          pairUnreads: [{ withPersonUid: "prs_jacob", unreadCount: 4 }],
        },
      ],
      dms: [
        {
          personUid: "agt_deacon",
          unreadCount: 59,
          messages: [
            {
              eventId: "m1",
              createdAt: "2026-07-20T16:42:27.641Z",
              fromDisplayName: "Deacon",
              body: "status check",
            },
          ],
        },
      ],
    });
    expect(bundle.contacts.map((c) => c.personUid).sort()).toEqual([
      "agt_deacon",
      "prs_jacob",
    ]);
    expect(
      bundle.contacts.find((c) => c.personUid === "prs_jacob"),
    ).toMatchObject({
      lastMessageAt: "2026-08-16T21:10:27.909Z",
      unreadCount: 4,
    });
    expect(
      bundle.contacts.find((c) => c.personUid === "agt_deacon"),
    ).toMatchObject({
      displayName: "Deacon",
      lastMessageAt: "2026-07-20T16:42:27.641Z",
      unreadCount: 59,
    });
    expect(
      bundle.messagesByPersonUid.agt_deacon?.map((m) => m.eventId),
    ).toEqual(["m1"]);
  });

  it("accepts the flattened contact rows the desktop snapshot emits", () => {
    const bundle = dmBundleFromRawSnapshot({
      contacts: [{ personUid: "prs_corey", displayName: "Corey Epstein" }],
      inbox: [],
      dms: [
        {
          personUid: "prs_corey",
          unreadCount: 21,
          messages: [
            {
              eventId: "m1",
              createdAt: "2026-05-29T04:11:21.933Z",
              fromDisplayName: "Corey Epstein",
            },
          ],
        },
      ],
    });
    expect(bundle.contacts[0]).toMatchObject({
      personUid: "prs_corey",
      lastMessageAt: "2026-05-29T04:11:21.933Z",
      unreadCount: 21,
    });
  });
});

describe("createCacheSidebarApi channel capabilities", () => {
  it("forwards createChannel/addChannelMember/sendChannelMessage from persist", async () => {
    const calls: string[] = [];
    const api = createCacheSidebarApi(
      () => ({ rows: [], contacts: [], updatedAt: 0 }) as never,
      undefined,
      {
        createChannel: async () => {
          calls.push("create");
          return { channelId: "chn_x" };
        },
        addChannelMember: async () => {
          calls.push("member");
        },
        sendChannelMessage: async () => {
          calls.push("send");
        },
      },
    );
    // The sidebar keys its "New channel" affordances off these being present —
    // dropping them here silently removes channel creation from the app.
    expect(typeof api.createChannel).toBe("function");
    expect(typeof api.addChannelMember).toBe("function");
    expect(typeof api.sendChannelMessage).toBe("function");
    await api.createChannel?.({ name: "x", scope: "personal" });
    await api.addChannelMember?.("chn_x", "prs_a");
    await api.sendChannelMessage?.({ channelId: "chn_x", body: "hi" });
    expect(calls).toEqual(["create", "member", "send"]);
  });

  it("surfaces an actionable send failure when persist does not provide it", async () => {
    const api = createCacheSidebarApi(
      () => ({ rows: [], contacts: [], updatedAt: 0 }) as never,
    );
    expect(api.createChannel).toBeUndefined();
    await expect(
      api.sendChannelMessage({ channelId: "chn_x", body: "hi" }),
    ).rejects.toThrow("Message sending is unavailable while offline");
    await expect(
      api.sendDm({ toPersonUid: "prs_a", body: "hi" }),
    ).rejects.toThrow("Message sending is unavailable while offline");
  });
});

describe("parseChannelMembers — enriched profile fields", () => {
  it("reads avatarUrl + description from flat rows", () => {
    const [m] = parseChannelMembers({
      members: [
        {
          personUid: "prs_a",
          displayName: "Ada",
          email: "ada@x.com",
          avatarUrl: "https://cdn/a.jpg",
          description: "Founder",
          role: "owner",
        },
      ],
    });
    expect(m.avatarUrl).toBe("https://cdn/a.jpg");
    expect(m.description).toBe("Founder");
    expect(m.email).toBe("ada@x.com");
  });

  it("reads profile fields nested under effectiveProfile", () => {
    const [m] = parseChannelMembers({
      members: [
        {
          personUid: "prs_b",
          role: "member",
          effectiveProfile: {
            displayName: "Bo",
            avatarUrl: "https://cdn/b.jpg",
            description: "Eng",
          },
        },
      ],
    });
    expect(m.displayName).toBe("Bo");
    expect(m.avatarUrl).toBe("https://cdn/b.jpg");
    expect(m.description).toBe("Eng");
  });

  it("leaves avatar/description undefined when absent (older server)", () => {
    const [m] = parseChannelMembers({
      members: [{ personUid: "prs_c", displayName: "Cy", role: "member" }],
    });
    expect(m.avatarUrl).toBeUndefined();
    expect(m.description).toBeUndefined();
  });
});
