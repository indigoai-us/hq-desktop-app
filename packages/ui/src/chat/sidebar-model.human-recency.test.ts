/**
 * Human-only sidebar order: the three states of "last human message".
 *
 *  - known:   the server sent `lastHumanMessageAt`. Sort by it.
 *  - none:    the server sent `hasHumanMessage: false`. With a creation
 *             time: sort by it, on the same timeline as human times, never
 *             by bot or session activity. Without one (every 1:1 DM today):
 *             sort by `lastActivityAt`, like an unknown row, so a new DM is
 *             under Today. With neither time: the bottom tier, by title.
 *  - unknown: the server sent neither field. Fall back to `lastActivityAt`.
 *
 * Unknown is what an older server sends for every row, and what today's
 * server sends for every 1:1 DM and for a channel it has not examined. An
 * earlier change keyed all of those rows to 0, which would have sunk every
 * 1:1 DM to the bottom of the sidebar in title order.
 */
import { describe, expect, it } from "vitest";

import type { Channel } from "./channels";
import {
  applyDirectoryRows,
  applyDmHumanRecency,
  applySidebarFilters,
  compareRowRecency,
  flattenGrouped,
  isUndatedNoHumanRow,
  groupByDay,
  historyDayGroups,
  mergeContactActivity,
  normalizeChannel,
  normalizeConversations,
  normalizeDm,
  pickAutoOpenConversation,
  pickSettledBootConversation,
  resolveHumanRecency,
  rowHumanRecencyState,
  rowRecencyKey,
  searchHistory,
  sortConversations,
  stampContactsFromDmThreads,
  wakeMayChangeHumanRecency,
  type ConversationKind,
  type ConversationRow,
  type DmContactInput,
} from "./sidebar-model";

const T = (iso: string) => Date.parse(iso);

type RowState =
  | { human: number }
  | { none: true; createdAt?: number }
  | { unknown: true };

function row(
  kind: ConversationKind,
  name: string,
  lastActivityAt: number,
  state: RowState,
  extra: Partial<ConversationRow> = {},
): ConversationRow {
  const prefix = kind === "dm" ? "dm" : "ch";
  return {
    id: `${prefix}:${name}`,
    kind,
    title: name,
    companyUid: null,
    unreadDot: false,
    lastActivityAt,
    pinned: false,
    ...(kind === "dm" ? { personUid: name } : { channelId: name }),
    ...("human" in state ? { lastHumanMessageAt: state.human } : {}),
    ...("none" in state
      ? {
          hasHumanMessage: false as const,
          ...(state.createdAt ? { createdAt: state.createdAt } : {}),
        }
      : {}),
    ...extra,
  };
}

const ids = (rows: ConversationRow[]) => rows.map((r) => r.id);

describe("rowHumanRecencyState / rowRecencyKey", () => {
  it("known: a human time, and the key is that time", () => {
    const r = row("channel", "a", 900, { human: 500 });
    expect(rowHumanRecencyState(r)).toBe("known");
    expect(rowRecencyKey(r, true)).toBe(500);
    expect(rowRecencyKey(r, false)).toBe(900);
  });

  it("none: the key is the creation time, whatever the bot or session activity", () => {
    const r = row("channel", "a", 900, { none: true, createdAt: 100 });
    expect(rowHumanRecencyState(r)).toBe("none");
    expect(rowRecencyKey(r, true)).toBe(100);
    expect(rowRecencyKey(r, false)).toBe(900);
    expect(isUndatedNoHumanRow(r, true)).toBe(false);
  });

  it("none without a creation time: the key is lastActivityAt, like an unknown row", () => {
    const r = row("dm", "a", 900, { none: true });
    expect(rowHumanRecencyState(r)).toBe("none");
    expect(rowRecencyKey(r, true)).toBe(900);
    expect(rowRecencyKey(r, true)).toBe(
      rowRecencyKey(row("dm", "a", 900, { unknown: true }), true),
    );
    expect(rowRecencyKey(r, false)).toBe(900);
    // It has a place on the timeline, so it is not in the bottom tier.
    expect(isUndatedNoHumanRow(r, true)).toBe(false);
  });

  it("none with neither a creation time nor an activity time: key 0, the bottom tier", () => {
    const r = row("dm", "a", 0, { none: true });
    expect(rowRecencyKey(r, true)).toBe(0);
    expect(isUndatedNoHumanRow(r, true)).toBe(true);
    expect(isUndatedNoHumanRow(r, false)).toBe(false);
    // An unknown row with no activity is not in the tier: it is not known-none.
    expect(isUndatedNoHumanRow(row("dm", "b", 0, { unknown: true }), true)).toBe(false);
  });

  it("unknown: the key falls back to lastActivityAt", () => {
    const r = row("dm", "a", 900, { unknown: true });
    expect(rowHumanRecencyState(r)).toBe("unknown");
    expect(rowRecencyKey(r, true)).toBe(900);
    expect(rowRecencyKey(r, false)).toBe(900);
  });

  it("a human time wins when a row carries both fields", () => {
    const r = row("channel", "a", 900, { human: 500 }, { hasHumanMessage: false });
    expect(rowHumanRecencyState(r)).toBe("known");
  });
});

/** The same expectations hold for each kind of conversation. */
const KINDS: ConversationKind[] = ["channel", "group", "dm"];

describe.each(KINDS)("sortConversations(humanOnly): %s rows", (kind) => {
  const knownNew = row(kind, "known-new", 100, { human: 800 });
  const knownOld = row(kind, "known-old", 950, { human: 300 });
  const unknownMid = row(kind, "unknown-mid", 600, { unknown: true });
  const unknownIdle = row(kind, "unknown-idle", 0, { unknown: true });
  const noneNew = row(kind, "none-new", 990, { none: true, createdAt: 400 });
  const noneOld = row(kind, "none-old", 999, { none: true, createdAt: 200 });
  const noneUndatedB = row(kind, "none-undated-b", 970, { none: true });
  const noneUndatedA = row(kind, "none-undated-a", 10, { none: true });
  const noneTimelessB = row(kind, "none-timeless-b", 0, { none: true });
  const noneTimelessA = row(kind, "none-timeless-a", 0, { none: true });
  const all = [
    noneTimelessB,
    noneUndatedB,
    noneOld,
    unknownIdle,
    knownOld,
    noneNew,
    unknownMid,
    noneUndatedA,
    noneTimelessA,
    knownNew,
  ];
  const prefix = kind === "dm" ? "dm" : "ch";
  const expected = [
    "none-undated-b", // known none, no creation time: lastActivityAt 970
    "known-new", // human time 800
    "unknown-mid", // no fields: lastActivityAt 600
    "none-new", // known none: created 400, although its bot activity is 990
    "known-old", // human time 300, although its bot activity is 950
    "none-old", // known none: created 200, although its bot activity is 999
    "none-undated-a", // known none, no creation time: lastActivityAt 10
    "unknown-idle", // no fields and no activity: key 0
    "none-timeless-a", // known none, neither time: bottom tier, by title
    "none-timeless-b",
  ].map((name) => `${prefix}:${name}`);

  it("recent mode: known by human time, unknown by activity, known-none by creation time on the same timeline", () => {
    expect(ids(sortConversations(all, "recent", true))).toEqual(expected);
  });

  it("type mode: the same order within the kind", () => {
    expect(ids(sortConversations(all, "type", true))).toEqual(expected);
  });

  it("flag off: every state orders by lastActivityAt, in both modes", () => {
    const byActivity = [
      "none-old", // 999
      "none-new", // 990
      "none-undated-b", // 970
      "known-old", // 950
      "unknown-mid", // 600
      "known-new", // 100
      "none-undated-a", // 10
      "none-timeless-a", // 0: these three tie and fall back to title
      "none-timeless-b", // 0
      "unknown-idle", // 0
    ].map((name) => `${prefix}:${name}`);
    expect(ids(sortConversations(all, "recent", false))).toEqual(byActivity);
    expect(ids(sortConversations(all, "type", false))).toEqual(byActivity);
  });

  it("known none: bot or session activity never moves the row", () => {
    const quiet = row(kind, "quiet", 1, { none: true, createdAt: 500 });
    const busy = row(kind, "busy", 9_999, { none: true, createdAt: 100 }, {
      unreadCount: 12,
    });
    const typed = row(kind, "typed", 2, { human: 300 });
    for (const mode of ["recent", "type"] as const) {
      expect(ids(sortConversations([busy, quiet, typed], mode, true))).toEqual(
        [`${prefix}:quiet`, `${prefix}:typed`, `${prefix}:busy`],
      );
    }
  });

  it("a conversation created after another's last human message sorts above it", () => {
    const createdToday = row(kind, "created-today", 0, { none: true, createdAt: 900 });
    const typedYesterday = row(kind, "typed-yesterday", 950, { human: 700 });
    const botOnlyOld = row(kind, "bot-only-old", 999, { none: true, createdAt: 50 });
    expect(
      ids(sortConversations([botOnlyOld, typedYesterday, createdToday], "recent", true)),
    ).toEqual([
      `${prefix}:created-today`,
      `${prefix}:typed-yesterday`,
      `${prefix}:bot-only-old`,
    ]);
  });

  it("unread breaks a tie between rows at the same key, as before", () => {
    const read = row(kind, "a-read", 5, { human: 400 });
    const unread = row(kind, "b-unread", 5, { human: 400 }, { unreadCount: 2 });
    const noneRead = row(kind, "c-none-read", 5, { none: true, createdAt: 400 });
    const noneUnread = row(kind, "d-none-unread", 5, { none: true, createdAt: 400 }, {
      unreadDot: true,
    });
    expect(
      ids(sortConversations([read, noneRead, noneUnread, unread], "recent", true)),
    ).toEqual([
      `${prefix}:b-unread`, // 2 unread
      `${prefix}:d-none-unread`, // a dot counts as 1
      `${prefix}:a-read`, // then title
      `${prefix}:c-none-read`,
    ]);
  });

  it("known none without a creation time: ordered by activity, with unread as the tie-break, exactly like an unknown row", () => {
    const newest = row(kind, "a-newest", 900, { none: true });
    const tieRead = row(kind, "b-tie-read", 500, { none: true });
    const tieUnread = row(kind, "c-tie-unread", 500, { none: true }, { unreadCount: 3 });
    const unknownTieDot = row(kind, "d-unknown-tie-dot", 500, { unknown: true }, {
      unreadDot: true,
    });
    const unknownTieRead = row(kind, "e-unknown-tie-read", 500, { unknown: true });
    const oldest = row(kind, "f-oldest", 100, { none: true }, { unreadCount: 9 });
    const sorted = ids(
      sortConversations(
        [oldest, unknownTieRead, tieRead, unknownTieDot, tieUnread, newest],
        "recent",
        true,
      ),
    );
    expect(sorted).toEqual([
      `${prefix}:a-newest`, // activity 900
      `${prefix}:c-tie-unread`, // activity 500, 3 unread
      `${prefix}:d-unknown-tie-dot`, // activity 500, a dot counts as 1
      `${prefix}:b-tie-read`, // activity 500, read: then title
      `${prefix}:e-unknown-tie-read`,
      `${prefix}:f-oldest`, // activity 100: unread does not lift it past newer rows
    ]);
    // The same rows with every known-none row turned into an unknown row
    // sort identically.
    const asUnknown = [oldest, unknownTieRead, tieRead, unknownTieDot, tieUnread, newest].map(
      (r): ConversationRow => ({ ...r, hasHumanMessage: undefined }),
    );
    expect(asUnknown.map(rowHumanRecencyState)).toEqual(asUnknown.map(() => "unknown"));
    expect(ids(sortConversations(asUnknown, "recent", true))).toEqual(sorted);
  });

  it("known none with a creation time still ignores bot activity, next to one without", () => {
    // Both rows are known-none and both have bot activity at 9,000. The one
    // with a creation time stays at it (100); the one without is placed by
    // its activity.
    const dated = row(kind, "dated", 9_000, { none: true, createdAt: 100 }, {
      unreadCount: 5,
    });
    const undated = row(kind, "undated", 9_000, { none: true });
    const typed = row(kind, "typed", 2, { human: 300 });
    for (const mode of ["recent", "type"] as const) {
      expect(ids(sortConversations([dated, typed, undated], mode, true))).toEqual([
        `${prefix}:undated`,
        `${prefix}:typed`,
        `${prefix}:dated`,
      ]);
    }
  });

  it("bottom tier (known none, neither time): last, by title, and unread does not reorder it", () => {
    const b = row(kind, "b", 0, { none: true }, { unreadCount: 9 });
    const a = row(kind, "a", 0, { none: true });
    const idle = row(kind, "idle", 0, { unknown: true });
    expect(ids(sortConversations([b, a, idle], "recent", true))).toEqual([
      `${prefix}:idle`,
      `${prefix}:a`,
      `${prefix}:b`,
    ]);
  });

  it("a row that moves from none to a human message takes the human time", () => {
    const before = row(kind, "moved", 50, { none: true, createdAt: 10 });
    const after = row(kind, "moved", 700, { human: 700 });
    const other = row(kind, "other", 400, { human: 400 });
    expect(ids(sortConversations([before, other], "recent", true))).toEqual([
      `${prefix}:other`,
      `${prefix}:moved`,
    ]);
    expect(ids(sortConversations([after, other], "recent", true))).toEqual([
      `${prefix}:moved`,
      `${prefix}:other`,
    ]);
  });
});

describe("sortConversations(humanOnly): kinds together", () => {
  const channelKnown = row("channel", "c-known", 10, { human: 500 });
  const channelNone = row("channel", "c-none", 900, { none: true, createdAt: 50 });
  const groupUnknown = row("group", "g-unknown", 700, { unknown: true });
  const groupNone = row("group", "g-none", 800, { none: true, createdAt: 60 });
  const dmUnknown = row("dm", "d-unknown", 600, { unknown: true });
  const dmKnown = row("dm", "d-known", 5, { human: 650 });
  const dmNone = row("dm", "d-none", 990, { none: true });
  const all = [dmNone, channelNone, groupNone, dmUnknown, channelKnown, groupUnknown, dmKnown];

  it("recent mode interleaves kinds; a known-none row sits at its creation time, one without at its activity", () => {
    expect(ids(sortConversations(all, "recent", true))).toEqual([
      "dm:d-none", // none, no creation time: 990 (activity)
      "ch:g-unknown", // 700 (activity)
      "dm:d-known", // 650 (human)
      "dm:d-unknown", // 600 (activity)
      "ch:c-known", // 500 (human)
      "ch:g-none", // none, created 60
      "ch:c-none", // none, created 50
    ]);
  });

  it("type mode groups by kind first, then applies the three states", () => {
    expect(ids(sortConversations(all, "type", true))).toEqual([
      "ch:c-known",
      "ch:c-none",
      "ch:g-unknown",
      "ch:g-none",
      "dm:d-none",
      "dm:d-known",
      "dm:d-unknown",
    ]);
  });

  it("a known-none row with neither time sorts below a row with no activity at all; one with activity does not", () => {
    const timeless = row("dm", "timeless", 0, { none: true });
    const undated = row("dm", "undated", 999, { none: true });
    const idle = row("channel", "idle", 0, { unknown: true });
    expect(compareRowRecency(timeless, idle, true)).toBeGreaterThan(0);
    expect(compareRowRecency(idle, timeless, true)).toBeLessThan(0);
    expect(compareRowRecency(undated, idle, true)).toBeLessThan(0);
    expect(compareRowRecency(undated, timeless, true)).toBeLessThan(0);
  });

  it("compareRowRecency: two known-none rows without a creation time compare by activity, and tie only with neither time", () => {
    const a = row("dm", "a", 1, { none: true });
    const b = row("dm", "b", 2, { none: true });
    expect(compareRowRecency(a, b, true)).toBeGreaterThan(0);
    expect(compareRowRecency(b, a, true)).toBeLessThan(0);
    expect(
      compareRowRecency(row("dm", "a", 0, { none: true }), row("dm", "b", 0, { none: true }), true),
    ).toBe(0);
    // Against an unknown row with the same activity: a tie.
    expect(compareRowRecency(b, row("dm", "c", 2, { unknown: true }), true)).toBe(0);
  });
});

describe("regression: 1:1 DMs carry no human fields on today's server", () => {
  it("humanOnly keeps them in activity order instead of sinking them in title order", () => {
    const contacts: DmContactInput[] = [
      { personUid: "prs_zoe", displayName: "Zoe", lastMessageAt: "2026-10-01T15:00:00Z" },
      { personUid: "prs_abe", displayName: "Abe", lastMessageAt: "2026-09-20T15:00:00Z" },
      { personUid: "prs_mia", displayName: "Mia", lastMessageAt: "2026-09-28T15:00:00Z" },
    ];
    const channels: Channel[] = [
      {
        channelId: "chn_general",
        name: "general",
        scope: "company",
        companyUid: "cmp_1",
        lastActivityAt: "2026-10-01T16:00:00Z",
        lastHumanMessageAt: "2026-09-25T10:00:00Z",
      },
    ];
    const rows = normalizeConversations(channels, contacts);
    expect(
      applySidebarFilters(rows, { humanOnly: true }).map((r) => r.title),
    ).toEqual(["Zoe", "Mia", "general", "Abe"]);
  });
});

describe("normalizeChannel / normalizeDm: the three states from the wire", () => {
  const base: Channel = { channelId: "chn_1", name: "ops", scope: "company" };

  it("known: maps lastHumanMessageAt, and drops a stray hasHumanMessage false", () => {
    const r = normalizeChannel({
      ...base,
      lastHumanMessageAt: "2026-09-25T10:00:00Z",
      hasHumanMessage: false,
    });
    expect(r.lastHumanMessageAt).toBe(T("2026-09-25T10:00:00Z"));
    expect(r.hasHumanMessage).toBeUndefined();
    expect(r.createdAt).toBeUndefined();
  });

  it("none: maps hasHumanMessage false and the directory creation time", () => {
    const r = normalizeChannel({
      ...base,
      hasHumanMessage: false,
      directoryCreatedAt: "2026-08-01T00:00:00Z",
      lastActivityAt: "2026-10-01T16:00:00Z",
    });
    expect(r.hasHumanMessage).toBe(false);
    expect(r.lastHumanMessageAt).toBeUndefined();
    expect(r.createdAt).toBe(T("2026-08-01T00:00:00Z"));
  });

  it("the directory creation time is never counted as activity", () => {
    const r = normalizeChannel({
      ...base,
      hasHumanMessage: false,
      directoryCreatedAt: "2026-08-01T00:00:00Z",
    });
    expect(r.lastActivityAt).toBe(0);
    expect(r.messageActivityAt).toBe(0);
  });

  it("unknown: neither field maps to neither key", () => {
    const r = normalizeChannel({ ...base, lastActivityAt: "2026-10-01T16:00:00Z" });
    expect("lastHumanMessageAt" in r).toBe(false);
    expect("hasHumanMessage" in r).toBe(false);
    expect("createdAt" in r).toBe(false);
  });

  it("a group DM maps the same way", () => {
    const group = normalizeChannel({
      channelId: "chn_g",
      name: "",
      scope: "group",
      hasHumanMessage: false,
      directoryCreatedAt: "2026-08-02T00:00:00Z",
    });
    expect(group.kind).toBe("group");
    expect(group.hasHumanMessage).toBe(false);
    expect(group.createdAt).toBe(T("2026-08-02T00:00:00Z"));
  });

  it("1:1 DM: known, none, and unknown", () => {
    const known = normalizeDm({
      personUid: "prs_a",
      lastHumanMessageAt: "2026-09-25T10:00:00Z",
    });
    expect(known.lastHumanMessageAt).toBe(T("2026-09-25T10:00:00Z"));
    expect(known.hasHumanMessage).toBeUndefined();

    const none = normalizeDm({ personUid: "prs_a", hasHumanMessage: false });
    expect(none.hasHumanMessage).toBe(false);
    expect(none.lastHumanMessageAt).toBeUndefined();

    const unknown = normalizeDm({ personUid: "prs_a", lastMessageAt: "2026-09-25T10:00:00Z" });
    expect("hasHumanMessage" in unknown).toBe(false);
    expect("lastHumanMessageAt" in unknown).toBe(false);
  });
});

describe("resolveHumanRecency: what a later payload does to a known value", () => {
  const time = { lastHumanMessageAt: "2026-09-25T10:00:00Z" };
  const none = { hasHumanMessage: false };

  it("a payload that omits both fields keeps a known time", () => {
    expect(resolveHumanRecency(time, {})).toEqual(time);
    expect(resolveHumanRecency(time, { lastHumanMessageAt: null })).toEqual(time);
  });

  it("a payload that omits both fields keeps a known none", () => {
    expect(resolveHumanRecency(none, {})).toEqual(none);
  });

  it("nothing known and nothing sent stays unknown", () => {
    expect(resolveHumanRecency(undefined, {})).toEqual({});
    expect(resolveHumanRecency({}, { hasHumanMessage: true })).toEqual({});
  });

  it("none to a human message: the time replaces the none", () => {
    expect(resolveHumanRecency(none, time)).toEqual(time);
  });

  it("a human message to none (the message was deleted): the none replaces the time", () => {
    expect(resolveHumanRecency(time, none)).toEqual(none);
  });

  it("a newer or older time from the server replaces the previous one", () => {
    const newer = { lastHumanMessageAt: "2026-09-30T10:00:00Z" };
    expect(resolveHumanRecency(time, newer)).toEqual(newer);
    expect(resolveHumanRecency(newer, time)).toEqual(time);
  });
});

describe("applyDirectoryRows: channel and group DM rows keep or replace the human state", () => {
  const dir = (extra: Record<string, unknown> = {}) => ({
    channelId: "chn_1",
    type: "chat",
    scope: "company",
    companyUid: "cmp_1",
    name: "ops",
    lastActivityAt: "2026-10-01T16:00:00Z",
    ...extra,
  });

  it("carries a human time and the creation time onto the channel", () => {
    const [channel] = applyDirectoryRows(
      [dir({ lastHumanMessageAt: "2026-09-25T10:00:00Z", createdAt: "2026-08-01T00:00:00Z" })],
      [],
    );
    expect(channel.lastHumanMessageAt).toBe("2026-09-25T10:00:00Z");
    expect(channel.hasHumanMessage).toBeUndefined();
    expect(channel.directoryCreatedAt).toBe("2026-08-01T00:00:00Z");
    // Creation time stays out of `createdAt`, which counts as activity.
    expect(channel.createdAt).toBeUndefined();
  });

  it("a later row without the fields keeps the known time", () => {
    const first = applyDirectoryRows(
      [dir({ lastHumanMessageAt: "2026-09-25T10:00:00Z" })],
      [],
    );
    const [channel] = applyDirectoryRows([dir()], first);
    expect(channel.lastHumanMessageAt).toBe("2026-09-25T10:00:00Z");
  });

  it("a later row without the fields keeps a known none and its creation time", () => {
    const first = applyDirectoryRows(
      [dir({ hasHumanMessage: false, createdAt: "2026-08-01T00:00:00Z" })],
      [],
    );
    const [channel] = applyDirectoryRows([dir()], first);
    expect(channel.hasHumanMessage).toBe(false);
    expect(channel.lastHumanMessageAt).toBeUndefined();
    expect(channel.directoryCreatedAt).toBe("2026-08-01T00:00:00Z");
  });

  it("none to a human message: the row updates and leaves the none state", () => {
    const first = applyDirectoryRows([dir({ hasHumanMessage: false })], []);
    const [channel] = applyDirectoryRows(
      [dir({ lastHumanMessageAt: "2026-10-01T17:00:00Z" })],
      first,
    );
    expect(channel.lastHumanMessageAt).toBe("2026-10-01T17:00:00Z");
    expect(channel.hasHumanMessage).toBeUndefined();
    expect(rowHumanRecencyState(normalizeChannel(channel))).toBe("known");
  });

  it("a human message to none: the stale time is dropped", () => {
    const first = applyDirectoryRows(
      [dir({ lastHumanMessageAt: "2026-09-25T10:00:00Z" })],
      [],
    );
    const [channel] = applyDirectoryRows([dir({ hasHumanMessage: false })], first);
    expect(channel.hasHumanMessage).toBe(false);
    expect(channel.lastHumanMessageAt).toBeUndefined();
    expect(rowHumanRecencyState(normalizeChannel(channel))).toBe("none");
  });

  it("an unknown row stays unknown and orders by activity", () => {
    const [channel] = applyDirectoryRows([dir()], []);
    expect("lastHumanMessageAt" in channel).toBe(false);
    expect("hasHumanMessage" in channel).toBe(false);
    const r = normalizeChannel(channel);
    expect(rowRecencyKey(r, true)).toBe(T("2026-10-01T16:00:00Z"));
  });

  it("a group DM row goes through the same merge", () => {
    const group = (extra: Record<string, unknown> = {}) => ({
      channelId: "chn_g",
      type: "dm",
      scope: "group",
      name: "",
      lastActivityAt: "2026-10-01T16:00:00Z",
      ...extra,
    });
    const first = applyDirectoryRows([group({ hasHumanMessage: false })], []);
    expect(first[0].hasHumanMessage).toBe(false);
    const kept = applyDirectoryRows([group()], first);
    expect(kept[0].hasHumanMessage).toBe(false);
    const typed = applyDirectoryRows(
      [group({ lastHumanMessageAt: "2026-10-01T18:00:00Z" })],
      kept,
    );
    expect(typed[0].lastHumanMessageAt).toBe("2026-10-01T18:00:00Z");
    expect(typed[0].hasHumanMessage).toBeUndefined();
  });
});

describe("1:1 DM contacts keep or replace the human state", () => {
  const jacob = (extra: Partial<DmContactInput> = {}): DmContactInput => ({
    personUid: "prs_jacob",
    displayName: "Jacob",
    lastMessageAt: "2026-10-01T16:00:00Z",
    ...extra,
  });

  it("applyDmHumanRecency sets a time from the DM thread listing", () => {
    const out = applyDmHumanRecency([jacob()], [
      { personUid: "prs_jacob", lastHumanMessageAt: "2026-09-25T10:00:00Z" },
    ]);
    expect(out[0].lastHumanMessageAt).toBe("2026-09-25T10:00:00Z");
    expect(out[0].hasHumanMessage).toBeUndefined();
  });

  it("applyDmHumanRecency sets a known none", () => {
    const out = applyDmHumanRecency([jacob()], [
      { personUid: "prs_jacob", hasHumanMessage: false },
    ]);
    expect(out[0].hasHumanMessage).toBe(false);
    expect(normalizeDm(out[0]).hasHumanMessage).toBe(false);
  });

  it("an entry with neither field changes nothing (older server, inbox activity)", () => {
    const contacts = [jacob({ lastHumanMessageAt: "2026-09-25T10:00:00Z" })];
    const out = applyDmHumanRecency(contacts, [{ personUid: "prs_jacob" }]);
    expect(out).toBe(contacts);
    const none = [jacob({ hasHumanMessage: false })];
    expect(applyDmHumanRecency(none, [{ personUid: "prs_jacob" }])).toBe(none);
  });

  it("none to a human message, and back", () => {
    const typed = applyDmHumanRecency([jacob({ hasHumanMessage: false })], [
      { personUid: "prs_jacob", lastHumanMessageAt: "2026-10-01T17:00:00Z" },
    ]);
    expect(typed[0].lastHumanMessageAt).toBe("2026-10-01T17:00:00Z");
    expect(typed[0].hasHumanMessage).toBeUndefined();
    const cleared = applyDmHumanRecency(typed, [
      { personUid: "prs_jacob", hasHumanMessage: false },
    ]);
    expect(cleared[0].hasHumanMessage).toBe(false);
    expect(cleared[0].lastHumanMessageAt).toBeUndefined();
  });

  it("returns the same array when the listing repeats what is known", () => {
    const contacts = [jacob({ lastHumanMessageAt: "2026-09-25T10:00:00Z" })];
    expect(
      applyDmHumanRecency(contacts, [
        { personUid: "prs_jacob", lastHumanMessageAt: "2026-09-25T10:00:00Z" },
      ]),
    ).toBe(contacts);
  });

  it("mergeContactActivity: a roster refresh without the fields keeps the state", () => {
    const merged = mergeContactActivity(
      [jacob({ lastHumanMessageAt: "2026-09-25T10:00:00Z" })],
      [jacob({ lastMessageAt: null })],
    );
    expect(merged[0].lastHumanMessageAt).toBe("2026-09-25T10:00:00Z");
    const keptNone = mergeContactActivity(
      [jacob({ hasHumanMessage: false })],
      [jacob()],
    );
    expect(keptNone[0].hasHumanMessage).toBe(false);
  });

  it("mergeContactActivity: a refresh that carries a field replaces the pair", () => {
    const typed = mergeContactActivity(
      [jacob({ hasHumanMessage: false })],
      [jacob({ lastHumanMessageAt: "2026-10-01T17:00:00Z" })],
    );
    expect(typed[0].lastHumanMessageAt).toBe("2026-10-01T17:00:00Z");
    expect("hasHumanMessage" in typed[0]).toBe(false);
    const cleared = mergeContactActivity(
      [jacob({ lastHumanMessageAt: "2026-09-25T10:00:00Z" })],
      [jacob({ hasHumanMessage: false })],
    );
    expect(cleared[0].hasHumanMessage).toBe(false);
    expect("lastHumanMessageAt" in cleared[0]).toBe(false);
  });

  it("stampContactsFromDmThreads keeps the state while stamping activity", () => {
    const stamped = stampContactsFromDmThreads(
      [
        jacob({ lastHumanMessageAt: "2026-09-25T10:00:00Z" }),
        { personUid: "prs_bot", hasHumanMessage: false },
      ],
      [
        { personUid: "prs_jacob", lastMessageAt: "2026-10-02T09:00:00Z" },
        { personUid: "prs_bot", lastMessageAt: "2026-10-02T09:00:00Z" },
      ],
    );
    const byUid = new Map(stamped.map((c) => [c.personUid, c]));
    expect(byUid.get("prs_jacob")?.lastHumanMessageAt).toBe("2026-09-25T10:00:00Z");
    expect(byUid.get("prs_jacob")?.lastMessageAt).toBe("2026-10-02T09:00:00Z");
    expect(byUid.get("prs_bot")?.hasHumanMessage).toBe(false);
  });
});

describe("wakeMayChangeHumanRecency: when a new-message wake needs a directory read", () => {
  const known: Pick<Channel, "lastHumanMessageAt" | "hasHumanMessage"> = {
    lastHumanMessageAt: "2026-09-25T10:00:00Z",
  };

  it("unknown row: no, it is ordered by the activity the wake stamps", () => {
    expect(
      wakeMayChangeHumanRecency({}, {
        createdAt: "2026-10-01T10:00:00Z",
        fromPersonUid: "prs_a",
      }),
    ).toBe(false);
  });

  it("known row: yes for a newer message from a person", () => {
    expect(
      wakeMayChangeHumanRecency(known, {
        createdAt: "2026-10-01T10:00:00Z",
        fromPersonUid: "prs_a",
      }),
    ).toBe(true);
  });

  it("known row: no for a wake that is not newer than the known time", () => {
    expect(
      wakeMayChangeHumanRecency(known, {
        createdAt: "2026-09-25T10:00:00Z",
        fromPersonUid: "prs_a",
      }),
    ).toBe(false);
    // The same instant written with milliseconds is still not newer.
    expect(
      wakeMayChangeHumanRecency(known, {
        createdAt: "2026-09-25T10:00:00.000Z",
        fromPersonUid: "prs_a",
      }),
    ).toBe(false);
    expect(
      wakeMayChangeHumanRecency(known, {
        createdAt: "2026-09-25T09:59:59.999Z",
        fromPersonUid: "prs_a",
      }),
    ).toBe(false);
  });

  it("known-none row: yes for any message from a person", () => {
    expect(
      wakeMayChangeHumanRecency({ hasHumanMessage: false }, {
        createdAt: "2026-10-01T10:00:00Z",
        fromPersonUid: "prs_a",
      }),
    ).toBe(true);
  });

  it("an agent's post never counts, and neither does a missing row or time", () => {
    expect(
      wakeMayChangeHumanRecency(known, {
        createdAt: "2026-10-01T10:00:00Z",
        fromPersonUid: "agt_izzy",
      }),
    ).toBe(false);
    expect(
      wakeMayChangeHumanRecency(undefined, {
        createdAt: "2026-10-01T10:00:00Z",
        fromPersonUid: "prs_a",
      }),
    ).toBe(false);
    expect(wakeMayChangeHumanRecency(known, { fromPersonUid: "prs_a" })).toBe(false);
  });
});

describe("day sections follow the same key as the order", () => {
  // Local noon on Wednesday 16 September 2026, and times relative to it.
  const NOW = new Date(2026, 8, 16, 12, 0, 0).getTime();
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const localDay = (at: number) => new Date(at).toDateString();

  /** The section a row landed in: its day, "last", or "pinned". */
  function sectionOf(
    grouped: ReturnType<typeof groupByDay>,
    id: string,
  ): string | null {
    if (grouped.pinned.some((r) => r.id === id)) return "pinned";
    if (grouped.lastWeek.some((r) => r.id === id)) return "last";
    const section = grouped.sections.find((s) => s.rows.some((r) => r.id === id));
    return section ? section.label.split(" · ")[0] : null;
  }

  const group = (rows: ConversationRow[], humanOnly: boolean) =>
    groupByDay(sortConversations(rows, "recent", humanOnly), NOW, { humanOnly });

  for (const kind of ["channel", "group", "dm"] as const) {
    describe(kind, () => {
      it("known: a mesh-busy row sits under the day of its last human message, not today", () => {
        const busy = row(kind, "busy", NOW - HOUR, { human: NOW - 3 * DAY });
        const grouped = group([busy], true);
        // Three days before a Wednesday.
        expect(sectionOf(grouped, busy.id)).toBe("SUNDAY");
        expect(
          grouped.sections.find((s) => s.label.startsWith("TODAY")),
        ).toBeUndefined();
      });

      it("known: a human message older than the week of day sections goes to the last section", () => {
        const stale = row(kind, "stale", NOW - HOUR, { human: NOW - 20 * DAY });
        expect(sectionOf(group([stale], true), stale.id)).toBe("last");
      });

      it("none: a bot-only row created long ago is not under today, whatever its activity today", () => {
        const botOnly = row(kind, "bot-only", NOW - HOUR, {
          none: true,
          createdAt: NOW - 30 * DAY,
        });
        const grouped = group([botOnly], true);
        expect(sectionOf(grouped, botOnly.id)).toBe("last");
        expect(grouped.sections).toEqual([]);
      });

      it("none: a row sits under the day it was created", () => {
        const createdToday = row(kind, "created-today", 0, {
          none: true,
          createdAt: NOW - 2 * HOUR,
        });
        const createdSunday = row(kind, "created-sunday", NOW - HOUR, {
          none: true,
          createdAt: NOW - 3 * DAY,
        });
        const grouped = group([createdSunday, createdToday], true);
        expect(sectionOf(grouped, createdToday.id)).toBe("TODAY");
        expect(sectionOf(grouped, createdSunday.id)).toBe("SUNDAY");
      });

      it("none without a creation time: bucketed by its activity, like an unknown row", () => {
        const today = row(kind, "today", NOW - HOUR, { none: true });
        const yesterday = row(kind, "yesterday", NOW - DAY, { none: true });
        const old = row(kind, "old", NOW - 20 * DAY, { unknown: true });
        const older = row(kind, "older", NOW - 21 * DAY, { none: true });
        const grouped = group([older, yesterday, old, today], true);
        expect(sectionOf(grouped, today.id)).toBe("TODAY");
        expect(sectionOf(grouped, yesterday.id)).toBe("YESTERDAY");
        // Old activity: the last section, in activity order with unknown rows.
        expect(ids(grouped.lastWeek)).toEqual([old.id, older.id]);
      });

      it("none with neither time: the last section, after every other row there", () => {
        const timeless = row(kind, "timeless", 0, { none: true });
        const old = row(kind, "old", NOW - 20 * DAY, { unknown: true });
        const idle = row(kind, "idle", 0, { unknown: true });
        const grouped = group([timeless, idle, old], true);
        expect(grouped.sections).toEqual([]);
        expect(ids(grouped.lastWeek)).toEqual([old.id, idle.id, timeless.id]);
      });

      it("unknown: the row is bucketed by its activity", () => {
        const today = row(kind, "today", NOW - HOUR, { unknown: true });
        const yesterday = row(kind, "yesterday", NOW - DAY, { unknown: true });
        const old = row(kind, "old", NOW - 20 * DAY, { unknown: true });
        const grouped = group([today, yesterday, old], true);
        expect(sectionOf(grouped, today.id)).toBe("TODAY");
        expect(sectionOf(grouped, yesterday.id)).toBe("YESTERDAY");
        expect(sectionOf(grouped, old.id)).toBe("last");
      });

      it("flag off: every state is bucketed by activity, as before", () => {
        const rows = [
          row(kind, "busy", NOW - HOUR, { human: NOW - 3 * DAY }),
          row(kind, "none", NOW - 2 * HOUR, { none: true, createdAt: 1 }),
          row(kind, "unknown", NOW - 3 * HOUR, { unknown: true }),
        ];
        const sorted = sortConversations(rows, "recent", false);
        const off = groupByDay(sorted, NOW, { humanOnly: false });
        // The two-argument call is the pre-existing one.
        expect(groupByDay(sorted, NOW)).toEqual(off);
        for (const r of rows) expect(sectionOf(off, r.id)).toBe("TODAY");
        expect(off.lastWeek).toEqual([]);
        expect(ids(off.sections[0].rows)).toEqual(ids(rows));
      });
    });
  }

  it("section and order agree for mixed rows: the sections, read top to bottom, are the sort order", () => {
    const rows = [
      row("channel", "busy", NOW - HOUR, { human: NOW - 3 * DAY }),
      row("dm", "ann", NOW - 2 * HOUR, { unknown: true }),
      row("group", "trio", NOW - 3 * HOUR, { human: NOW - DAY }),
      row("channel", "mesh-only", NOW - 4 * HOUR, { none: true, createdAt: NOW - 5 * DAY }),
      row("dm", "notices", NOW - 5 * HOUR, { none: true }),
      row("channel", "typed", NOW - 6 * HOUR, { human: NOW - 6 * HOUR }),
      row("group", "quiet", NOW - 9 * DAY, { unknown: true }),
      row("channel", "ancient", NOW - HOUR, { human: NOW - 30 * DAY }),
      row("dm", "empty", 0, { unknown: true }),
      row("channel", "new-empty", 0, { none: true, createdAt: NOW - HOUR }),
      row("channel", "old-bot-only", NOW - HOUR, { none: true, createdAt: NOW - 40 * DAY }),
      row("dm", "timeless", 0, { none: true }),
      row("dm", "old-notices", NOW - 10 * DAY, { none: true }),
    ];
    const sorted = sortConversations(rows, "recent", true);
    const grouped = groupByDay(sorted, NOW, { humanOnly: true });

    expect(ids(flattenGrouped(grouped, true))).toEqual(ids(sorted));
    expect(ids(sorted)).toEqual([
      "ch:new-empty", // none, created an hour ago
      "dm:ann", // unknown: activity two hours ago
      "dm:notices", // none, no creation time: activity five hours ago
      "ch:typed", // typed six hours ago
      "ch:trio", // typed yesterday
      "ch:busy", // typed three days ago
      "ch:mesh-only", // none, created five days ago
      "ch:quiet", // unknown: activity nine days ago
      "dm:old-notices", // none, no creation time: activity ten days ago
      "ch:ancient", // typed thirty days ago
      "ch:old-bot-only", // none, created forty days ago
      "dm:empty", // unknown, no activity
      "dm:timeless", // none, neither time: bottom tier
    ]);
    expect(grouped.sections.map((s) => [s.label.split(" · ")[0], ids(s.rows)])).toEqual([
      ["TODAY", ["ch:new-empty", "dm:ann", "dm:notices", "ch:typed"]],
      ["YESTERDAY", ["ch:trio"]],
      ["SUNDAY", ["ch:busy"]],
      ["FRIDAY", ["ch:mesh-only"]],
    ]);
    expect(ids(grouped.lastWeek)).toEqual([
      "ch:quiet",
      "dm:old-notices",
      "ch:ancient",
      "ch:old-bot-only",
      "dm:empty",
      "dm:timeless",
    ]);

    // Every row's section is the day of the key it is ordered by.
    for (const section of grouped.sections) {
      for (const r of section.rows) {
        const key = rowRecencyKey(r, true);
        expect(key).toBeGreaterThan(0);
        expect(localDay(key)).toBe(
          localDay(Number(section.key.replace("day:", ""))),
        );
      }
    }
  });

  it("section and order agree for generated rows in every state, kind, and age", () => {
    // A fixed pseudo-random sequence, so the case is the same on every run.
    let seed = 20260916;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const kinds: ConversationKind[] = ["channel", "group", "dm"];
    const rows: ConversationRow[] = [];
    for (let i = 0; i < 300; i += 1) {
      const kind = kinds[Math.floor(next() * 3)];
      const activity = next() < 0.1 ? 0 : NOW - Math.floor(next() * 12 * DAY);
      const stateRoll = next();
      const at = NOW - Math.floor(next() * 12 * DAY);
      const state: RowState =
        stateRoll < 0.4
          ? { human: at }
          : stateRoll < 0.6
            ? { none: true, createdAt: at }
            : stateRoll < 0.7
              ? { none: true }
              : { unknown: true };
      rows.push(
        row(kind, `r${i}`, activity, state, next() < 0.2 ? { unreadCount: 1 } : {}),
      );
    }
    for (const humanOnly of [true, false]) {
      const sorted = sortConversations(rows, "recent", humanOnly);
      const grouped = groupByDay(sorted, NOW, { humanOnly });
      expect(ids(flattenGrouped(grouped, true))).toEqual(ids(sorted));
      // Sections run newest day first, and each row is in its key's day.
      const dayStarts = grouped.sections.map((s) => Number(s.key.replace("day:", "")));
      expect(dayStarts).toEqual([...dayStarts].sort((a, b) => b - a));
      for (const section of grouped.sections) {
        for (const r of section.rows) {
          expect(localDay(rowRecencyKey(r, humanOnly))).toBe(
            localDay(Number(section.key.replace("day:", ""))),
          );
        }
      }
    }
  });

  it("the same rows with the flag off: sections and order both follow activity", () => {
    const rows = [
      row("channel", "busy", NOW - HOUR, { human: NOW - 3 * DAY }),
      row("channel", "mesh-only", NOW - 4 * HOUR, { none: true, createdAt: NOW - 5 * DAY }),
      row("group", "quiet", NOW - 9 * DAY, { unknown: true }),
    ];
    const sorted = sortConversations(rows, "recent", false);
    const grouped = groupByDay(sorted, NOW);
    expect(ids(flattenGrouped(grouped, true))).toEqual(ids(sorted));
    expect(ids(grouped.sections[0].rows)).toEqual(["ch:busy", "ch:mesh-only"]);
    expect(grouped.sections[0].label.startsWith("TODAY")).toBe(true);
    expect(ids(grouped.lastWeek)).toEqual(["ch:quiet"]);
  });

  it("a pinned row stays in the pinned section in either mode", () => {
    const pinned = row("channel", "pin", NOW - HOUR, { none: true }, { pinned: true });
    expect(sectionOf(group([pinned], true), pinned.id)).toBe("pinned");
    expect(sectionOf(group([pinned], false), pinned.id)).toBe("pinned");
  });
});

describe("history view: order and day labels follow the same key", () => {
  const NOW = new Date(2026, 8, 16, 12, 0, 0);
  const now = NOW.getTime();
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const rows = [
    row("channel", "busy", now - HOUR, { human: now - 3 * DAY }),
    row("channel", "mesh-only", now - 2 * HOUR, { none: true, createdAt: now - DAY - HOUR }),
    row("dm", "ann", now - 3 * HOUR, { unknown: true }),
    row("channel", "typed", now - 4 * HOUR, { human: now - DAY }),
  ];

  it("humanOnly: a mesh-busy row is listed under its human day, a known-none row under its creation day or, without one, its activity day", () => {
    const withUndated = [
      ...rows,
      row("dm", "notices", now - HOUR, { none: true }),
      row("dm", "timeless", 0, { none: true }),
    ];
    const ordered = searchHistory(withUndated, "", true);
    expect(ids(ordered)).toEqual([
      "dm:notices", // none, no creation time: activity an hour ago
      "dm:ann",
      "ch:typed", // typed a day ago
      "ch:mesh-only", // created an hour before that
      "ch:busy",
      "dm:timeless", // none, neither time
    ]);
    const groups = historyDayGroups(ordered, NOW, true);
    expect(groups.map((g) => [g.label, ids(g.rows)])).toEqual([
      ["Today", ["dm:notices", "dm:ann"]],
      ["Yesterday", ["ch:typed", "ch:mesh-only"]],
      ["Sep 13", ["ch:busy"]],
      ["Older", ["dm:timeless"]],
    ]);
  });

  it("flag off: order and labels follow activity, as before", () => {
    const ordered = searchHistory(rows, "");
    expect(ids(ordered)).toEqual(["ch:busy", "ch:mesh-only", "dm:ann", "ch:typed"]);
    expect(historyDayGroups(ordered, NOW).map((g) => g.label)).toEqual(["Today"]);
    expect(searchHistory(rows, "", false)).toEqual(ordered);
  });

  it("the title filter still applies", () => {
    expect(ids(searchHistory(rows, "TYP", true))).toEqual(["ch:typed"]);
  });
});

describe("boot pick follows the same key", () => {
  const rows = [
    row("channel", "mesh-only", 900, { none: true, createdAt: 100 }),
    row("channel", "busy", 800, { human: 200 }),
    row("dm", "ann", 500, { unknown: true }),
    row("channel", "typed", 400, { human: 400 }),
  ];

  it("humanOnly: opens the row the human order puts first, not the one with the newest bot activity", () => {
    expect(pickAutoOpenConversation(rows, null, true)?.id).toBe("dm:ann");
    expect(pickSettledBootConversation(rows, null, true)?.id).toBe("dm:ann");
    // The first row of the sort is the pick.
    expect(pickAutoOpenConversation(rows, null, true)?.id).toBe(
      sortConversations(rows, "recent", true)[0].id,
    );
  });

  it("humanOnly: a known-none row is picked by its creation time, or by its activity when it has no creation time", () => {
    const created = row("channel", "created", 1, { none: true, createdAt: 600 });
    expect(pickAutoOpenConversation([...rows, created], null, true)?.id).toBe("ch:created");
    // No creation time: its activity (999) is the key, newer than every
    // other row's, so it is the pick, as an unknown row would be.
    const undated = row("dm", "undated", 999, { none: true });
    expect(pickAutoOpenConversation([...rows, created, undated], null, true)?.id).toBe(
      undated.id,
    );
    expect(pickSettledBootConversation([...rows, undated], null, true)?.id).toBe(undated.id);
    // Older activity than another row's key: not the pick.
    const undatedOld = row("dm", "undated-old", 450, { none: true });
    expect(pickAutoOpenConversation([...rows, undatedOld], null, true)?.id).toBe("dm:ann");
  });

  it("humanOnly: a known-none row with neither time is picked only when nothing else can be", () => {
    const timeless = row("dm", "timeless", 0, { none: true });
    expect(pickAutoOpenConversation([timeless], null, true)?.id).toBe(timeless.id);
    expect(
      pickAutoOpenConversation([timeless, row("dm", "idle", 0, { unknown: true })], null, true)?.id,
    ).toBe("dm:idle");
  });

  it("flag off: the newest activity wins, as before", () => {
    expect(pickAutoOpenConversation(rows)?.id).toBe("ch:mesh-only");
    expect(pickAutoOpenConversation(rows, null, false)?.id).toBe("ch:mesh-only");
    expect(pickSettledBootConversation(rows)?.id).toBe("ch:mesh-only");
  });

  it("a selection or a browse-only row is still skipped", () => {
    expect(pickAutoOpenConversation(rows, "ch:busy", true)).toBeNull();
    const browse = row("dm", "browse", 999, { unknown: true }, { browseOnly: true });
    expect(pickAutoOpenConversation([browse, ...rows], null, true)?.id).toBe("dm:ann");
  });
});
