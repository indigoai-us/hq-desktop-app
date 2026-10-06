import { describe, expect, it } from "vitest";

import {
  groupByDay,
  flattenGrouped,
  railRowScopeLabel,
  takeAllScopeRailRows,
  type ConversationRow,
} from "./sidebar-model";

const NOW = new Date(2026, 9, 6, 15, 0, 0).getTime();
const HOUR = 3_600_000;

function row(id: string, patch: Partial<ConversationRow>): ConversationRow {
  return { id, kind: "channel", title: id, companyUid: null, lastActivityAt: 0, ...patch } as ConversationRow;
}
const channel = (id: string, companyUid: string, at: number, extra: Partial<ConversationRow> = {}) =>
  row(id, { channelScope: "company", companyUid, lastActivityAt: at, messageActivityAt: at, ...extra });

const rows: ConversationRow[] = [
  row("dm:amy", { kind: "dm", personUid: "prs_amy", lastActivityAt: NOW - 1 * HOUR }),
  channel("ch:hq-dev", "cmp_indigo", NOW - 2 * HOUR, { unreadCount: 3 }),
  channel("ch:acme", "cmp_acme", NOW - 26 * HOUR, { muted: true } as Partial<ConversationRow>),
  row("dm:bob", { kind: "dm", personUid: "prs_bob", lastActivityAt: NOW - 27 * HOUR }),
  channel("ch:pinned", "cmp_acme", NOW - 50 * HOUR, { pinned: true }),
  channel("ch:empty", "cmp_acme", NOW - 1000, { messageActivityAt: 0 }),
];

describe("All scope: channels sort into the date buckets", () => {
  it("interleaves channels and DMs by date, pinned first, empty channels last", () => {
    const grouped = groupByDay(rows, NOW, { emptyChannelsLast: true });
    expect(grouped.pinned.map((r) => r.id)).toEqual(["ch:pinned"]);
    expect(grouped.sections.map((s) => s.rows.map((r) => r.id))).toEqual([
      ["dm:amy", "ch:hq-dev"],
      ["ch:acme", "dm:bob"],
    ]);
    expect(grouped.noMessages?.map((r) => r.id)).toEqual(["ch:empty"]);
    expect(flattenGrouped(grouped, false).map((r) => r.id)).toEqual([
      "ch:pinned", "dm:amy", "ch:hq-dev", "ch:acme", "dm:bob", "ch:empty",
    ]);
    // Unread and muted ride along untouched.
    expect(grouped.sections[0]!.rows[1]!.unreadCount).toBe(3);
    expect((grouped.sections[1]!.rows[0] as { muted?: boolean }).muted).toBe(true);
  });

  it("keeps a cached row with unknown message activity dated, and leaves other scopes alone", () => {
    const cached = channel("ch:cached", "cmp_acme", NOW - HOUR, { messageActivityAt: undefined });
    expect(groupByDay([cached], NOW, { emptyChannelsLast: true }).sections[0]!.rows[0]!.id).toBe("ch:cached");
    expect(groupByDay(rows, NOW).noMessages).toBeUndefined();
  });

  it("never drops a company channel to the rail's channel budget", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      channel(`ch:c${i}`, "cmp_indigo", NOW - i * HOUR),
    );
    const kept = takeAllScopeRailRows([...many, rows[0]!], {});
    expect(kept).toHaveLength(41);
  });

  it("tags a company channel with its company only in All", () => {
    const companies = [{ companyUid: "cmp_indigo", label: "Indigo" }] as Parameters<typeof railRowScopeLabel>[1]["companies"];
    const hqDev = rows[1]!;
    expect(railRowScopeLabel(hqDev, { scope: "all", companies, enabled: false })).toEqual({ kind: "company", text: "Indigo" });
    expect(railRowScopeLabel(hqDev, { scope: "cmp_indigo", companies, enabled: true })).toBeNull();
  });
});
