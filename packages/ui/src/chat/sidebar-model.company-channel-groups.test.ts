import { describe, expect, it } from "vitest";

import {
  COLLAPSED_COMPANY_CHANNELS_STORAGE_KEY,
  groupCompanyChannelsByCompany,
  loadCollapsedCompanyChannels,
  toggleCollapsedCompanyChannels,
  type ConversationRow,
} from "./sidebar-model";

const row = (over: Partial<ConversationRow>): ConversationRow => ({
  id: "ch:x",
  kind: "channel",
  title: "x",
  companyUid: null,
  unreadDot: false,
  lastActivityAt: 0,
  ...over,
} as ConversationRow);

const rows: ConversationRow[] = [
  row({ id: "ch:sentry", title: "hq-sentry", channelScope: "company", companyUid: "cmp_indigo", lastActivityAt: 200, notifyLevel: "muted" }),
  row({ id: "ch:dev", title: "hq-dev", channelScope: "company", companyUid: "cmp_indigo", lastActivityAt: 300, unreadCount: 2 }),
  row({ id: "ch:acme", title: "general", channelScope: "company", companyUid: "cmp_acme", lastActivityAt: 400, unreadDot: true }),
  row({ id: "ch:proj", title: "proj", channelScope: "project", companyUid: "cmp_indigo", lastActivityAt: 999 }),
  row({ id: "dm:amy", kind: "dm", title: "Amy", lastActivityAt: 999 }),
];

describe("groupCompanyChannelsByCompany", () => {
  it("groups only company channels, newest group first, newest channel first", () => {
    const groups = groupCompanyChannelsByCompany(rows, [
      { companyUid: "cmp_indigo", label: "Indigo", iconUrl: "https://x/i.png" },
      { companyUid: "cmp_acme", label: "Acme" },
    ]);
    expect(groups.map((g) => g.companyUid)).toEqual(["cmp_acme", "cmp_indigo"]);
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(["ch:dev", "ch:sentry"]);
    expect(groups[1]!.label).toBe("Indigo");
    expect(groups[1]!.iconUrl).toBe("https://x/i.png");
    expect(groups[1]!.unread).toBe(2);
    expect(groups[0]!.unread).toBe(1);
  });

  it("keeps muted and unread flags on rows", () => {
    const [, indigo] = groupCompanyChannelsByCompany(rows);
    expect(indigo!.rows.find((r) => r.id === "ch:sentry")?.notifyLevel).toBe("muted");
    expect(indigo!.rows.find((r) => r.id === "ch:dev")?.unreadCount).toBe(2);
  });

  it("falls back to the uid when the company is not on the roster", () => {
    expect(groupCompanyChannelsByCompany(rows)[0]!.label).toBe("cmp_acme");
  });
});

describe("collapsed company channel groups", () => {
  it("toggles and persists", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    let collapsed = toggleCollapsedCompanyChannels([], "cmp_indigo", storage);
    expect(collapsed).toEqual(["cmp_indigo"]);
    expect(loadCollapsedCompanyChannels(storage)).toEqual(["cmp_indigo"]);
    collapsed = toggleCollapsedCompanyChannels(collapsed, "cmp_indigo", storage);
    expect(loadCollapsedCompanyChannels(storage)).toEqual([]);
    expect(store.has(COLLAPSED_COMPANY_CHANNELS_STORAGE_KEY)).toBe(true);
  });

  it("reads garbage as empty", () => {
    expect(loadCollapsedCompanyChannels({ getItem: () => "{nope" })).toEqual([]);
    expect(loadCollapsedCompanyChannels(null)).toEqual([]);
  });
});
