import { describe, expect, it } from "vitest";

import { paletteRowDetail } from "../shell/palette-rows.js";
import {
  companyChannelUnread,
  companyScopedChannels,
  groupByDay,
  isCompanyScopedChannel,
  omitCompanyScopedChannels,
  type ConversationRow,
} from "./sidebar-model.js";

function row(partial: Partial<ConversationRow> & Pick<ConversationRow, "id" | "kind" | "title">): ConversationRow {
  return {
    companyUid: null,
    unreadDot: false,
    lastActivityAt: 1,
    pinned: false,
    ...partial,
  };
}

const indigo = row({
  id: "ch:indigo",
  kind: "channel",
  title: "hq-desktop-app",
  companyUid: "cmp_indigo",
  channelScope: "company",
  unreadCount: 2,
  lastActivityAt: 50,
});
const project = row({
  id: "ch:project",
  kind: "channel",
  title: "welcome",
  companyUid: "cmp_indigo",
  channelScope: "project",
  pinned: true,
  lastActivityAt: 40,
});
const dm = row({
  id: "dm:deacon",
  kind: "dm",
  title: "deacon",
  personUid: "agt_deacon",
  lastActivityAt: 30,
});

describe("home inbox omits company channels (US-008)", () => {
  const rows = [indigo, project, dm];

  it("drops company-scoped channels and keeps pinned, DMs, and project channels", () => {
    const home = omitCompanyScopedChannels(rows);
    expect(home.map((r) => r.id)).toEqual(["ch:project", "dm:deacon"]);
    const grouped = groupByDay(home, 86_400_000);
    expect(grouped.pinned.map((r) => r.id)).toEqual(["ch:project"]);
    expect(grouped.sections.length + grouped.lastWeek.length).toBeGreaterThan(0);
  });

  it("lists that company's channels under Activity and rolls unread onto the tile", () => {
    expect(companyScopedChannels(rows, "cmp_indigo").map((r) => r.id)).toEqual(["ch:indigo"]);
    expect(companyScopedChannels(rows, "cmp_other")).toEqual([]);
    expect(companyChannelUnread(rows, "cmp_indigo")).toBe(2);
    expect(isCompanyScopedChannel(project)).toBe(false);
  });

  it("keeps the company channel reachable from the command palette row model", () => {
    expect(
      paletteRowDetail(indigo, {
        companies: [{ companyUid: "cmp_indigo", label: "Indigo" }],
      }),
    ).toBe("Indigo · company channel");
  });
});
