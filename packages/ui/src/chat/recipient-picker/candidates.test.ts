import { describe, expect, it } from "vitest";

import { recipientItemsFromDirectory } from "./candidates.js";
import type { ConversationRow, DmContactInput } from "../sidebar-model.js";

const dm = (personUid: string, title: string, lastActivityAt: number): ConversationRow => ({
  id: `dm:${personUid}`,
  kind: "dm",
  title,
  companyUid: "cmp_indigo",
  unreadDot: false,
  lastActivityAt,
  pinned: false,
  personUid,
});

const channel = (channelId: string, title: string, extra: Partial<ConversationRow> = {}): ConversationRow => ({
  id: `ch:${channelId}`,
  kind: "channel",
  title,
  companyUid: "cmp_indigo",
  unreadDot: false,
  lastActivityAt: 5,
  pinned: false,
  channelId,
  memberCount: 12,
  ...extra,
});

describe("candidatesFromDirectory", () => {
  const roster: DmContactInput[] = [
    { personUid: "prs_c1", displayName: "Caitlin Hutchinson", email: "caitlin@getindigo.ai", companyUid: "cmp_indigo", avatarUrl: "https://cdn.example.com/c1.png" },
    { personUid: "prs_c2", displayName: "Caitlin Hutchinson", email: "caitlin.h@vyg.ai", companyUid: "cmp_indigo" },
    { personUid: "agt_izzy", displayName: "Izzy", companyUid: "cmp_indigo" },
  ];

  it("keeps same-name people apart by email and carries photos", () => {
    const people = recipientItemsFromDirectory({ rows: [], contacts: [], roster }).filter((c) => c.kind === "person");
    expect(people.map((c) => [c.id, c.name, c.subtitle])).toEqual([
      ["dm:prs_c1", "Caitlin Hutchinson", "caitlin@getindigo.ai"],
      ["dm:prs_c2", "Caitlin Hutchinson", "caitlin.h@vyg.ai"],
    ]);
    expect(people[0].avatarUrl).toBe("https://cdn.example.com/c1.png");
  });

  it("marks bots without the old 'Bot' word as a handle", () => {
    const izzy = recipientItemsFromDirectory({ rows: [], contacts: [], roster }).find((c) => c.id === "dm:agt_izzy")!;
    expect(izzy.kind).toBe("bot");
    expect(izzy.principalUid).toBe("agt_izzy");
    expect(izzy.subtitle).toBeUndefined();
  });

  it("takes recency from DM rows", () => {
    const list = recipientItemsFromDirectory({ rows: [dm("prs_c2", "Caitlin Hutchinson", 42)], contacts: [], roster });
    expect(list.find((c) => c.id === "dm:prs_c2")!.lastActivityAt).toBe(42);
    expect(list.find((c) => c.id === "dm:prs_c1")!.lastActivityAt).toBe(0);
  });

  it("adds channels with member counts only when asked, and skips browse-only rows", () => {
    const rows = [channel("welcome", "welcome"), channel("ops", "ops", { browseOnly: true, memberCount: 1 })];
    expect(recipientItemsFromDirectory({ rows, contacts: [] }).some((c) => c.kind === "channel")).toBe(false);
    const channels = recipientItemsFromDirectory({ rows, contacts: [], includeChannels: true }).filter((c) => c.kind === "channel");
    expect(channels).toEqual([
      expect.objectContaining({ id: "ch:welcome", kind: "channel", channelId: "welcome", name: "welcome", hint: "12 members", companyUid: "cmp_indigo" }),
    ]);
  });
});
