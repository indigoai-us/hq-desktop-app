import { describe, expect, it } from "vitest";

import {
  filesFromVaultList,
  loadLiveChannelTabs,
  projectIdForRow,
  storiesFromPrd,
  tabsFromProjectView,
} from "./live-channel-tabs.js";

const VIEW = {
  companyUid: "cmp_indigo",
  projectId: "teams-agent",
  name: "teams-agent",
  stories: [{ id: "US-001", title: "Ship", status: "in_progress" }],
  repos: [],
  files: [
    {
      path: "projects/teams-agent/prd.json",
      name: "prd.json",
      updatedAt: "2026-08-24T00:00:00.000Z",
    },
  ],
};

describe("tabsFromProjectView", () => {
  it("turns a PROJECT_VIEW into board columns + files", () => {
    const tabs = tabsFromProjectView(VIEW, [
      { personUid: "prs_a", displayName: "Ada" },
    ]);
    expect(tabs?.board?.stories["US-001"]?.title).toBe("Ship");
    expect(tabs?.files.map((f) => f.name)).toEqual(["prd.json"]);
    expect(tabs?.status?.members[0]?.displayName).toBe("Ada");
  });
});

describe("projectIdForRow", () => {
  it("uses the directory projectId when present", () => {
    expect(
      projectIdForRow({
        id: "ch:chn_1",
        kind: "channel",
        title: "teams-agent-channel",
        companyUid: "cmp_1",
        unreadDot: false,
        lastActivityAt: 0,
        pinned: false,
        channelId: "chn_1",
        channelScope: "project",
        projectId: "teams-agent-channel",
      }),
    ).toBe("teams-agent-channel");
  });

  it("falls back to the project channel title", () => {
    expect(
      projectIdForRow({
        id: "ch:chn_1",
        kind: "channel",
        title: "# work-desktop-dogfood",
        companyUid: "cmp_1",
        unreadDot: false,
        lastActivityAt: 0,
        pinned: false,
        channelId: "chn_1",
        channelScope: "project",
        projectId: null,
      }),
    ).toBe("work-desktop-dogfood");
  });
});

describe("loadLiveChannelTabs", () => {
  const row = {
    id: "ch:chn_1",
    kind: "channel" as const,
    title: "# work-desktop-dogfood",
    companyUid: "cmp_1",
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    channelId: "chn_1",
    channelScope: "project",
    projectId: null,
  };

  it("fills the board from vault prd.json when PROJECT_VIEW has no stories", async () => {
    const tabs = await loadLiveChannelTabs({
      row,
      getProjectView: async () => ({
        companyUid: "cmp_1",
        projectId: "work-desktop-dogfood",
        stories: [],
      }),
      getVaultText: async (_company, key) => {
        expect(key).toBe("projects/work-desktop-dogfood/prd.json");
        return JSON.stringify({
          userStories: [{ id: "US-001", title: "Native notifications" }],
        });
      },
    });
    expect(tabs?.board?.stories["US-001"]?.title).toBe("Native notifications");
    expect(tabs?.board?.columns.some((column) => column.cards.length > 0)).toBe(
      true,
    );
  });

  it("reads userStories on a PROJECT_VIEW envelope", async () => {
    const tabs = await loadLiveChannelTabs({
      row,
      getProjectView: async () => ({
        companyUid: "cmp_1",
        projectId: "work-desktop-dogfood",
        userStories: [{ id: "US-002", title: "Members dropdown" }],
      }),
    });
    expect(tabs?.board?.stories["US-002"]?.title).toBe("Members dropdown");
  });
});

describe("storiesFromPrd", () => {
  it("reads userStories from a vault PRD", () => {
    const stories = storiesFromPrd({
      name: "work-desktop-dogfood",
      userStories: [
        { id: "US-001", title: "Native notifications", passes: false },
        { id: "US-006", title: "Members dropdown", passes: false },
      ],
    });
    expect(stories.map((s) => s.id)).toEqual(["US-001", "US-006"]);
  });
});

describe("filesFromVaultList", () => {
  it("keeps project artifacts and drops junk", () => {
    const files = filesFromVaultList(
      {
        objects: [
          { key: "projects/teams-agent/prd.json", name: "prd.json" },
          { key: "projects/teams-agent/.DS_Store" },
          { key: "projects/teams-agent/notes.md" },
        ],
      },
      "cmp_indigo",
    );
    expect(files.map((f) => f.name).sort()).toEqual(["notes.md", "prd.json"]);
  });
});
