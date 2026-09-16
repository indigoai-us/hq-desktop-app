import { describe, expect, it } from "vitest";

import type { ConversationRow } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";
import { liveSessionStartTarget } from "./live-session-start.js";

const CRAYADS: Workspace = {
  slug: "crayads",
  displayName: "Crayads",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_crayads",
  bucketName: null,
  hasLocalFolder: true,
  localPath: "/tmp/HQ/crayads",
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

const OTHER: Workspace = {
  ...CRAYADS,
  slug: "other",
  displayName: "Other",
  cloudUid: "cmp_other",
};

function row(partial: Partial<ConversationRow>): ConversationRow {
  return {
    id: "ch:setup",
    kind: "channel",
    title: "welcome",
    companyUid: null,
    unreadDot: false,
    lastActivityAt: 0,
    pinned: true,
    channelId: "setup",
    ...partial,
  };
}

describe("liveSessionStartTarget", () => {
  it("starts from #welcome using the roster company when the row has none", () => {
    expect(liveSessionStartTarget(row({}), [CRAYADS])).toEqual({
      companySlug: "crayads",
      projectId: "",
    });
  });

  it("does not require a project on a company channel", () => {
    expect(
      liveSessionStartTarget(
        row({
          id: "ch:chn_general",
          title: "general",
          companyUid: "cmp_crayads",
          channelId: "chn_general",
          channelScope: "company",
          projectId: null,
        }),
        [CRAYADS],
      ),
    ).toEqual({ companySlug: "crayads", projectId: "" });
  });

  it("keeps the row's company and project when both are present", () => {
    expect(
      liveSessionStartTarget(
        row({
          id: "ch:chn_proj",
          title: "ops",
          companyUid: "cmp_other",
          channelId: "chn_proj",
          channelScope: "project",
          projectId: "ops",
        }),
        [CRAYADS, OTHER],
      ),
    ).toEqual({ companySlug: "other", projectId: "ops" });
  });

  it("still returns empty slugs rather than blocking when there is no roster", () => {
    expect(liveSessionStartTarget(row({}), [])).toEqual({
      companySlug: "",
      projectId: "",
    });
    expect(liveSessionStartTarget(null, null)).toEqual({
      companySlug: "",
      projectId: "",
    });
  });
});
