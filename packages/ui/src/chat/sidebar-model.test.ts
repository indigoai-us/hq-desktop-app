import { describe, expect, it } from "vitest";
import type { Channel } from "./channels";
import { dmActivityFromTimeline } from "./live-catchup";
import {
  applyDirectoryFeed,
  applyDirectoryRows,
  applyPairUnreads,
  applySidebarFilters,
  mergeContactActivity,
  mergeContactsWithInbox,
  stampContactsFromDmThreads,
  buildScopeOptions,
  clearDmDot,
  clearPairUnread,
  collapseDuplicateGroupRows,
  companyLabelFor,
  conversationKindLabel,
  conversationQueryScore,
  daySectionLabel,
  distinctDmPeople,
  filterByCompanyScope,
  filterByShow,
  filterTypeahead,
  formatSearchHitTime,
  groupByDay,
  groupByType,
  historySearchScopeLabel,
  initialsFor,
  isStrictlyRicherConversationRow,
  loadPins,
  loadSetupPinDismissed,
  loadShowFilter,
  normalizeChannel,
  normalizeConversations,
  normalizeDm,
  nextScope,
  rankPaletteConversations,
  resolveSearchHitRow,
  rowAvatar,
  savePins,
  saveSetupPinDismissed,
  saveShowFilter,
  scopeFromHotkey,
  scopePillLabel,
  searchCompanyUidFromScope,
  searchHistory,
  historyDayGroups,
  searchHitSnippet,
  sortConversations,
  takeDirectorySeed,
  takeRailConversations,
  pickAutoOpenConversation,
  pickSettledBootConversation,
  railRowScopeLabel,
  duplicateHumanDmTitles,
  resolveRailCompanyName,
  titlebarDayDate,
  togglePin,
  type ConversationRow,
  type DmContactInput,
  type MessageSearchHit,
} from "./sidebar-model";
import { MARKETPLACE_COVER_HOST } from "../avatars/csp-image-src";
import { agentAvatarAssets, agentAvatarFor } from "./messaging/agent-avatars";

const PARKER_PHOTO = `https://${MARKETPLACE_COVER_HOST}/members/agt_parker/h.png?X-Amz-Signature=mock`;
const ADA_PHOTO = `https://${MARKETPLACE_COVER_HOST}/members/prs_ada/h.png?X-Amz-Signature=mock`;

// Fixed "now": Wednesday Aug 12, 2026 15:00 local — tests use local day math.
const NOW = new Date(2026, 7, 12, 15, 0, 0, 0).getTime();

function msOnDay(daysAgo: number, hour = 12): number {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function channel(
  overrides: Partial<Channel> & { channelId: string; name: string },
): Channel {
  return {
    scope: "company",
    companyUid: "cmp_a",
    companyName: "Acme",
    unread: 0,
    ...overrides,
  };
}

function dm(
  overrides: Partial<DmContactInput> & { personUid: string },
): DmContactInput {
  return {
    displayName: "Alex",
    email: `${overrides.personUid}@example.com`,
    ...overrides,
  };
}

function memoryStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  } as Storage;
}

describe("isStrictlyRicherConversationRow", () => {
  const stub: ConversationRow = {
    id: "ch:chn_atlas",
    kind: "channel",
    title: "",
    companyUid: null,
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
  };
  const enriched: ConversationRow = {
    ...stub,
    title: "Atlas",
    companyUid: "cmp_acme",
    channelId: "chn_atlas",
    channelScope: "project",
    projectId: "atlas",
    membership: "joined",
  };

  it("adopts metadata that fills gaps without dropping known values", () => {
    expect(isStrictlyRicherConversationRow(enriched, stub)).toBe(true);
  });

  it("does not adopt an identical row, a row that drops metadata, or a different conversation", () => {
    expect(isStrictlyRicherConversationRow(enriched, enriched)).toBe(false);
    expect(
      isStrictlyRicherConversationRow(
        { ...enriched, companyUid: null },
        enriched,
      ),
    ).toBe(false);
    expect(
      isStrictlyRicherConversationRow({ ...enriched, id: "ch:chn_other" }, stub),
    ).toBe(false);
  });
});

describe("normalizeChannel / normalizeDm", () => {
  it("maps company channels with numeric unread and no DM-style assumptions", () => {
    const row = normalizeChannel(
      channel({
        channelId: "ch1",
        name: "#launch",
        unread: 3,
        lastActivityAt: iso(msOnDay(0)),
      }),
    );
    expect(row).toMatchObject({
      id: "ch:ch1",
      kind: "channel",
      title: "launch",
      companyUid: "cmp_a",
      unreadCount: 3,
      unreadDot: false,
    });
    expect(row.unreadCount).toBe(3);
  });

  it("maps group DMs as kind group with member-count and dot-only unread", () => {
    const row = normalizeChannel(
      channel({
        channelId: "g1",
        name: "",
        scope: "group",
        companyUid: null,
        unread: 2,
        memberCount: 3,
        members: [
          { personUid: "p1", displayName: "Sam" },
          { personUid: "p2", displayName: "Jo" },
        ],
        lastActivityAt: iso(msOnDay(1)),
      }),
    );
    expect(row.kind).toBe("group");
    expect(row.unreadCount).toBeUndefined();
    expect(row.unreadDot).toBe(true);
    expect(row.memberCount).toBe(3);
    expect(row.title).toContain("Sam");
  });

  it("DM unread is absent-safe — never invents a numeric field from unrelated keys", () => {
    const contact = dm({
      personUid: "p-alex",
      // `unread` alone is not the server pair-unread field — ignore it.
      ...({ unread: 99 } as object),
    }) as DmContactInput;
    const row = normalizeDm(contact);
    expect(row.kind).toBe("dm");
    expect(row.unreadCount).toBeUndefined();
    expect(row.unreadDot).toBe(false);
  });

  it("DM unreadCount > 0 renders a numeric badge (no server-driven dot)", () => {
    const row = normalizeDm(dm({ personUid: "p1", unreadCount: 4 }));
    expect(row.unreadCount).toBe(4);
    expect(row.unreadDot).toBe(false);
  });

  it("DM unreadCount 0 means read — no badge/dot from server (local dots may still show)", () => {
    const read = normalizeDm(dm({ personUid: "p1", unreadCount: 0 }));
    expect(read.unreadCount).toBeUndefined();
    expect(read.unreadDot).toBe(false);

    const withLocalDot = normalizeDm(dm({ personUid: "p2", unreadCount: 0 }), {
      dmDots: ["p2"],
    });
    expect(withLocalDot.unreadCount).toBeUndefined();
    expect(withLocalDot.unreadDot).toBe(true);
  });

  it("DM unreadCount absent/null/undefined falls back to legacy dot behavior", () => {
    expect(normalizeDm(dm({ personUid: "p-a" })).unreadDot).toBe(false);
    expect(
      normalizeDm(dm({ personUid: "p-b", unreadCount: null })).unreadDot,
    ).toBe(false);
    expect(
      normalizeDm(dm({ personUid: "p-c", unreadCount: undefined }), {
        dmDots: ["p-c"],
      }).unreadDot,
    ).toBe(true);
    expect(
      normalizeDm(dm({ personUid: "p-d", activityDot: true })).unreadDot,
    ).toBe(true);
  });

  it("DM activityDot / dmDots set lights the local-only unread dot", () => {
    expect(
      normalizeDm(dm({ personUid: "p1", activityDot: true })).unreadDot,
    ).toBe(true);
    expect(
      normalizeDm(dm({ personUid: "p2" }), { dmDots: ["p2"] }).unreadDot,
    ).toBe(true);
  });

  it("applyPairUnreads merges server rollups; clearPairUnread zeros one pair", () => {
    const contacts = [
      dm({ personUid: "p1", displayName: "Ada" }),
      dm({ personUid: "p2", displayName: "Grace" }),
    ];
    const merged = applyPairUnreads(contacts, { p1: 3 });
    expect(merged[0]?.unreadCount).toBe(3);
    expect(merged[1]?.unreadCount).toBeUndefined();

    const cleared = clearPairUnread({ p1: 3, p2: 1 }, "p1");
    expect(cleared.get("p1")).toBe(0);
    expect(cleared.get("p2")).toBe(1);
  });

  it("recent sort still favors numeric DM unread over quiet rows", () => {
    const rows = normalizeConversations(
      [],
      [
        dm({
          personUid: "quiet",
          displayName: "Quiet",
          lastMessageAt: iso(msOnDay(0, 14)),
          unreadCount: 0,
        }),
        dm({
          personUid: "hot",
          displayName: "Hot",
          lastMessageAt: iso(msOnDay(0, 10)),
          unreadCount: 5,
        }),
      ],
    );
    // Same day, quiet is more recent by activity — but when activity ties on
    // the secondary key, unread tilts. Here activity differs so recency wins;
    // force equal activity to prove unread secondary sort.
    const equalActivity: ConversationRow[] = rows.map((r) => ({
      ...r,
      lastActivityAt: NOW,
    }));
    const sorted = sortConversations(equalActivity, "recent");
    expect(sorted[0]?.personUid).toBe("hot");
    expect(sorted[0]?.unreadCount).toBe(5);
  });

  it("pins apply to both channels and DMs", () => {
    const rows = normalizeConversations(
      [channel({ channelId: "c1", name: "ops" })],
      [dm({ personUid: "p1", displayName: "Bo" })],
      { pinnedIds: ["ch:c1", "dm:p1"] },
    );
    expect(rows.every((r) => r.pinned)).toBe(true);
  });
});

describe("day grouping", () => {
  function row(
    partial: Partial<ConversationRow> & { id: string; lastActivityAt: number },
  ): ConversationRow {
    return {
      kind: "channel",
      title: partial.id,
      companyUid: null,
      unreadDot: false,
      pinned: false,
      ...partial,
    };
  }

  it("labels TODAY with real month/day, YESTERDAY, and weekday names for 2–7d", () => {
    expect(daySectionLabel(msOnDay(0), NOW)).toMatch(/^TODAY · AUG 12$/);
    expect(daySectionLabel(msOnDay(1), NOW)).toBe("YESTERDAY · AUG 11");
    // 2 days before Wed Aug 12 = Monday
    expect(daySectionLabel(msOnDay(2), NOW)).toBe("MONDAY · AUG 10");
    // 3 days = Sunday
    expect(daySectionLabel(msOnDay(3), NOW)).toBe("SUNDAY · AUG 9");
  });

  it("titlebar day·date uses full weekday + month day", () => {
    expect(titlebarDayDate(NOW)).toBe("WEDNESDAY · AUG 12");
  });

  it("groups recent days into sections and collapses >7d into LAST WEEK", () => {
    const rows = [
      row({ id: "today", lastActivityAt: msOnDay(0) }),
      row({ id: "yest", lastActivityAt: msOnDay(1) }),
      row({ id: "mon", lastActivityAt: msOnDay(2) }),
      row({ id: "old-a", lastActivityAt: msOnDay(10) }),
      row({ id: "old-b", lastActivityAt: msOnDay(20) }),
      row({ id: "pinned-old", lastActivityAt: msOnDay(30), pinned: true }),
    ];
    const grouped = groupByDay(rows, NOW);

    expect(grouped.pinned.map((r) => r.id)).toEqual(["pinned-old"]);
    expect(grouped.sections.map((s) => s.label)).toEqual([
      "TODAY · AUG 12",
      "YESTERDAY · AUG 11",
      "MONDAY · AUG 10",
    ]);
    expect(grouped.sections[0]?.rows.map((r) => r.id)).toEqual(["today"]);
    expect(grouped.lastWeek.map((r) => r.id).sort()).toEqual([
      "old-a",
      "old-b",
    ]);
    // Pinned is excluded from lastWeek even if old.
    expect(grouped.lastWeek.find((r) => r.id === "pinned-old")).toBeUndefined();
  });

  it("treats activity at exactly the 7-day boundary as a day section, not LAST WEEK", () => {
    // day 6 (inclusive of the 7-day window today..today-6) stays in sections.
    const rows = [row({ id: "edge", lastActivityAt: msOnDay(6) })];
    const grouped = groupByDay(rows, NOW);
    expect(grouped.lastWeek).toHaveLength(0);
    expect(grouped.sections).toHaveLength(1);
  });

  it("activity older than 7 days collapses into lastWeek", () => {
    const rows = [row({ id: "edge-old", lastActivityAt: msOnDay(7) })];
    const grouped = groupByDay(rows, NOW);
    expect(grouped.sections).toHaveLength(0);
    expect(grouped.lastWeek.map((r) => r.id)).toEqual(["edge-old"]);
  });
});

describe("takeRailConversations — siderail is not the full directory", () => {
  function row(
    partial: Partial<ConversationRow> & { id: string; lastActivityAt: number },
  ): ConversationRow {
    return {
      kind: "channel",
      title: partial.id,
      companyUid: null,
      unreadDot: false,
      pinned: false,
      ...partial,
    };
  }

  it("keeps a short list unchanged", () => {
    const rows = [
      row({ id: "a", lastActivityAt: 2 }),
      row({ id: "b", lastActivityAt: 1 }),
    ];
    expect(takeRailConversations(rows).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("keeps unread, pins, and the open row; caps extra channels", () => {
    const rows: ConversationRow[] = [
      row({
        id: "dm:jacob",
        kind: "dm",
        lastActivityAt: 100,
        personUid: "prs_j",
      }),
      row({
        id: "ch:unread",
        lastActivityAt: 90,
        unreadCount: 3,
        channelId: "unread",
      }),
      row({
        id: "ch:pinned",
        lastActivityAt: 1,
        pinned: true,
        channelId: "pinned",
      }),
      row({
        id: "ch:open",
        lastActivityAt: 2,
        channelId: "open",
      }),
      ...Array.from({ length: 80 }, (_, i) =>
        row({
          id: `ch:proj-${i}`,
          lastActivityAt: 80 - i,
          title: `Project ${i}`,
          channelId: `proj-${i}`,
          channelScope: "project",
          companyUid: "cmp_1",
        }),
      ),
    ];
    const rail = takeRailConversations(rows, { selectedId: "ch:open" });
    const ids = rail.map((r) => r.id);
    expect(ids).toContain("dm:jacob");
    expect(ids).toContain("ch:unread");
    expect(ids).toContain("ch:pinned");
    expect(ids).toContain("ch:open");
    expect(rail.length).toBeLessThanOrEqual(28);
    expect(rail.some((r) => r.id.startsWith("ch:proj-"))).toBe(true);
  });

  it("keeps a read DM after click-away even when project channels are newer", () => {
    const rows: ConversationRow[] = [
      row({
        id: "dm:old",
        kind: "dm",
        lastActivityAt: 1,
        personUid: "prs_old",
      }),
      ...Array.from({ length: 40 }, (_, i) =>
        row({
          id: `ch:proj-${i}`,
          lastActivityAt: 100 - i,
          title: `Project ${i}`,
          channelId: `proj-${i}`,
          channelScope: "project",
          companyUid: "cmp_1",
        }),
      ),
    ];
    const sorted = [...rows].sort(
      (a, b) => b.lastActivityAt - a.lastActivityAt,
    );
    const rail = takeRailConversations(sorted, {
      recentPersonUids: ["prs_old"],
    });
    expect(rail.map((r) => r.id)).toContain("dm:old");
    expect(rail.some((r) => r.id.startsWith("ch:proj-"))).toBe(true);
  });

  it("keeps project channels on the rail even when many DMs are newer", () => {
    const rows: ConversationRow[] = [
      ...Array.from({ length: 30 }, (_, i) =>
        row({
          id: `dm:${i}`,
          kind: "dm",
          lastActivityAt: 1000 - i,
          personUid: `prs_${i}`,
        }),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        row({
          id: `ch:proj-${i}`,
          kind: "channel",
          channelScope: "project",
          companyUid: "cmp_1",
          lastActivityAt: 10 - i,
          title: `Project ${i}`,
          channelId: `proj-${i}`,
        }),
      ),
    ];
    const sorted = [...rows].sort(
      (a, b) => b.lastActivityAt - a.lastActivityAt,
    );
    const rail = takeRailConversations(sorted);
    const dms = rail.filter((r) => r.kind === "dm");
    const projects = rail.filter((r) => r.id.startsWith("ch:proj-"));
    expect(dms).toHaveLength(30);
    expect(projects.length).toBeGreaterThan(0);
    expect(projects.length).toBeLessThanOrEqual(16);
  });

  it("history list stays complete so Show all history can load the rest", () => {
    const rows = Array.from({ length: 200 }, (_, i) =>
      row({
        id: `ch:${i}`,
        lastActivityAt: 200 - i,
        channelId: String(i),
      }),
    );
    const rail = takeRailConversations(rows);
    expect(rail.length).toBeLessThanOrEqual(28);
    expect(rows.length - rail.length).toBeGreaterThan(150);
    const grouped = groupByDay(rail, NOW);
    const rendered =
      grouped.pinned.length +
      grouped.sections.reduce((n, s) => n + s.rows.length, 0) +
      grouped.lastWeek.length;
    expect(rendered).toBe(rail.length);
  });

  it("takeDirectorySeed keeps unread and the newest remainder only", () => {
    const rows = [
      {
        channelId: "unread",
        unreadCount: 2,
        lastActivityAt: "2026-08-01T00:00:00.000Z",
      },
      ...Array.from({ length: 40 }, (_, i) => ({
        channelId: `ch-${i}`,
        unreadCount: 0,
        lastActivityAt: `2026-08-${String(17 - (i % 10)).padStart(2, "0")}T00:00:00.000Z`,
      })),
    ];
    const seed = takeDirectorySeed(rows, 5);
    expect(seed).toHaveLength(5);
    expect(seed[0]?.channelId).toBe("unread");
  });
});

describe("pickAutoOpenConversation", () => {
  function row(
    partial: Partial<ConversationRow> & { id: string; lastActivityAt: number },
  ): ConversationRow {
    return {
      kind: "channel",
      title: partial.id,
      companyUid: null,
      unreadDot: false,
      pinned: false,
      ...partial,
    };
  }

  it("returns null when the shell already has a selection", () => {
    expect(
      pickAutoOpenConversation(
        [row({ id: "ch:a", lastActivityAt: 2 })],
        "ch:a",
      ),
    ).toBeNull();
  });

  it("picks the newest non-browse row when nothing is selected", () => {
    const older = row({ id: "ch:old", lastActivityAt: 1 });
    const newer = row({ id: "ch:new", lastActivityAt: 9 });
    const browse = row({
      id: "ch:browse",
      lastActivityAt: 99,
      browseOnly: true,
    });
    expect(pickAutoOpenConversation([older, browse, newer], null)?.id).toBe(
      "ch:new",
    );
  });

  it("returns null when the rail is empty", () => {
    expect(pickAutoOpenConversation([], null)).toBeNull();
  });
});

describe("pickSettledBootConversation", () => {
  function row(
    partial: Partial<ConversationRow> & { id: string; lastActivityAt: number },
  ): ConversationRow {
    return {
      kind: "channel",
      title: partial.id,
      companyUid: null,
      unreadDot: false,
      pinned: false,
      ...partial,
    };
  }

  it("still prefers a real conversation over #setup", () => {
    const setup = row({
      id: "ch:setup",
      channelId: "setup",
      lastActivityAt: 99,
    });
    const live = row({
      id: "ch:chn_ops",
      channelId: "chn_ops",
      lastActivityAt: 1,
    });
    expect(pickSettledBootConversation([setup, live], null)?.id).toBe(
      "ch:chn_ops",
    );
  });

  it("falls back to #setup so an empty tenant is not stuck on the skeleton", () => {
    const setup = row({
      id: "ch:setup",
      channelId: "setup",
      lastActivityAt: 0,
      pinned: true,
    });
    expect(pickSettledBootConversation([setup], null)?.id).toBe("ch:setup");
  });

  it("returns null when a selection already exists", () => {
    const setup = row({
      id: "ch:setup",
      channelId: "setup",
      lastActivityAt: 0,
    });
    expect(pickSettledBootConversation([setup], "ch:setup")).toBeNull();
  });
});

describe("company scope filtering", () => {
  const rows: ConversationRow[] = [
    {
      id: "ch:a",
      kind: "channel",
      title: "Acme",
      companyUid: "cmp_a",
      unreadDot: false,
      lastActivityAt: 3,
      pinned: false,
    },
    {
      id: "ch:b",
      kind: "channel",
      title: "Beta",
      companyUid: "cmp_b",
      unreadDot: false,
      lastActivityAt: 2,
      pinned: false,
    },
    {
      id: "ch:p",
      kind: "channel",
      title: "Notes",
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 1,
      pinned: false,
    },
    {
      id: "dm:1",
      kind: "dm",
      title: "Alex",
      companyUid: "cmp_a",
      unreadDot: false,
      lastActivityAt: 4,
      pinned: false,
      personUid: "p1",
    },
    {
      id: "dm:2",
      kind: "dm",
      title: "Sam",
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 5,
      pinned: false,
      personUid: "p2",
    },
    {
      id: "ch:g",
      kind: "group",
      title: "Trio",
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 6,
      pinned: false,
    },
  ];

  it("all keeps every row", () => {
    expect(filterByCompanyScope(rows, "all")).toHaveLength(rows.length);
  });

  it("company uid keeps that company channels plus DMs and groups", () => {
    const filtered = filterByCompanyScope(rows, "cmp_a");
    expect(filtered.map((r) => r.id).sort()).toEqual([
      "ch:a",
      "ch:g",
      "dm:1",
      "dm:2",
    ]);
  });

  it("personal keeps personal channels, unscoped DMs, and group DMs", () => {
    const filtered = filterByCompanyScope(rows, "personal");
    expect(filtered.map((r) => r.id).sort()).toEqual(["ch:g", "ch:p", "dm:2"]);
  });
});

describe("sort + show filters", () => {
  const rows: ConversationRow[] = [
    {
      id: "ch:1",
      kind: "channel",
      title: "Zebra",
      companyUid: "c",
      unreadDot: false,
      lastActivityAt: 10,
      pinned: false,
    },
    {
      id: "dm:1",
      kind: "dm",
      title: "Alpha",
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 50,
      pinned: false,
      personUid: "p1",
    },
    {
      id: "ch:g",
      kind: "group",
      title: "Group",
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 30,
      pinned: false,
    },
  ];

  it("Recent sorts by lastActivityAt desc", () => {
    expect(sortConversations(rows, "recent").map((r) => r.id)).toEqual([
      "dm:1",
      "ch:g",
      "ch:1",
    ]);
  });

  it("groupByType buckets by kind instead of calendar day", () => {
    const grouped = groupByType(rows);
    expect(grouped.sections.map((s) => s.key)).toEqual([
      "type:channel",
      "type:group",
      "type:dm",
    ]);
    expect(grouped.sections[0]?.rows.map((r) => r.id)).toEqual(["ch:1"]);
    expect(grouped.lastWeek).toEqual([]);
  });

  it("Type sorts channel → group → dm, then recency within type", () => {
    expect(sortConversations(rows, "type").map((r) => r.id)).toEqual([
      "ch:1",
      "ch:g",
      "dm:1",
    ]);
  });

  it("Show Projects keeps only project/company channels", () => {
    expect(filterByShow(rows, "projects").map((r) => r.id)).toEqual(["ch:1"]);
  });

  it("Show DMs keeps dm + group", () => {
    expect(
      filterByShow(rows, "dms")
        .map((r) => r.id)
        .sort(),
    ).toEqual(["ch:g", "dm:1"]);
  });

  // US-021: browse-only rows (other members' project channels, owner view).
  const browseRow: ConversationRow = {
    id: "ch:browse",
    kind: "channel",
    title: "Other project",
    companyUid: "c",
    unreadDot: false,
    lastActivityAt: 20,
    pinned: false,
    browseOnly: true,
  };

  it("Show 'company-projects' includes member + browse-only channel rows (US-021)", () => {
    const result = filterByShow([...rows, browseRow], "company-projects");
    expect(result.map((r) => r.id).sort()).toEqual(["ch:1", "ch:browse"]);
  });

  it("browse-only rows are hidden from 'all', 'projects', and 'dms' (US-021)", () => {
    const withBrowse = [...rows, browseRow];
    expect(filterByShow(withBrowse, "all").map((r) => r.id)).not.toContain(
      "ch:browse",
    );
    expect(filterByShow(withBrowse, "projects").map((r) => r.id)).toEqual([
      "ch:1",
    ]);
    expect(filterByShow(withBrowse, "dms").map((r) => r.id)).not.toContain(
      "ch:browse",
    );
  });

  it("Show 'mine' keeps member channels and DMs, hides membership none", () => {
    const noneRow: ConversationRow = {
      id: "ch:none",
      kind: "channel",
      title: "Not mine",
      companyUid: "c",
      unreadDot: false,
      lastActivityAt: 5,
      pinned: false,
      membership: "none",
    };
    const result = filterByShow([...rows, browseRow, noneRow], "mine");
    expect(result.map((r) => r.id).sort()).toEqual(["ch:1", "ch:g", "dm:1"]);
  });

  it("personal-scope channels never leak into 'projects' or 'company-projects'", () => {
    const personalRow: ConversationRow = {
      id: "ch:personal",
      kind: "channel",
      channelScope: "personal",
      title: "My notes",
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 40,
      pinned: false,
    };
    const projectRow: ConversationRow = {
      id: "ch:proj",
      kind: "channel",
      channelScope: "project",
      title: "Launch",
      companyUid: "c",
      unreadDot: false,
      lastActivityAt: 60,
      pinned: false,
    };
    const all = [...rows, personalRow, projectRow];
    // Visible under 'all', hidden from both project views.
    expect(filterByShow(all, "all").map((r) => r.id)).toContain("ch:personal");
    expect(filterByShow(all, "projects").map((r) => r.id)).toEqual([
      "ch:1",
      "ch:proj",
    ]);
    expect(filterByShow(all, "company-projects").map((r) => r.id)).toEqual([
      "ch:1",
      "ch:proj",
    ]);
    // Explicit project scope still qualifies; explicit personal never does.
    expect(filterByShow([personalRow], "projects")).toEqual([]);
    expect(filterByShow([projectRow], "projects").map((r) => r.id)).toEqual([
      "ch:proj",
    ]);
  });

  it("applySidebarFilters composes scope + show + sort + person", () => {
    const result = applySidebarFilters(rows, {
      scope: "all",
      show: "dms",
      sort: "recent",
      personUid: "p1",
    });
    expect(result.map((r) => r.id)).toEqual(["dm:1"]);
  });
});

describe("pin persistence", () => {
  it("loadShowFilter defaults to mine and persists a choice", () => {
    const storage = memoryStorage();
    expect(loadShowFilter(storage)).toBe("mine");
    saveShowFilter("dms", storage);
    expect(loadShowFilter(storage)).toBe("dms");
    const bad = memoryStorage({ "hq.chat.show-filter": "nope" });
    expect(loadShowFilter(bad)).toBe("mine");
  });

  it("loadPins / savePins / togglePin round-trip through localStorage", () => {
    const storage = memoryStorage();
    expect(loadPins(storage)).toEqual([]);
    savePins(["ch:1", "dm:2"], storage);
    expect(loadPins(storage)).toEqual(["ch:1", "dm:2"]);
    const toggled = togglePin(loadPins(storage), "ch:1");
    expect(toggled).toEqual(["dm:2"]);
    savePins(toggled, storage);
    expect(loadPins(storage)).toEqual(["dm:2"]);
  });

  it("loadSetupPinDismissed defaults to false and round-trips the flag", () => {
    const storage = memoryStorage();
    expect(loadSetupPinDismissed(storage)).toBe(false);
    expect(loadSetupPinDismissed(null)).toBe(false);
    saveSetupPinDismissed(storage, true);
    expect(loadSetupPinDismissed(storage)).toBe(true);
    saveSetupPinDismissed(storage, false);
    expect(loadSetupPinDismissed(storage)).toBe(false);
    expect(storage.getItem("hq.chat.setup-pin-dismissed")).toBeNull();
    // Unknown values are not "dismissed".
    expect(
      loadSetupPinDismissed(
        memoryStorage({ "hq.chat.setup-pin-dismissed": "yes" }),
      ),
    ).toBe(false);
  });

  it("loadPins tolerates corrupt JSON", () => {
    const storage = memoryStorage({ "hq.chat.pins": "{not-json" });
    expect(loadPins(storage)).toEqual([]);
  });

  it("clearDmDot removes only the targeted person", () => {
    expect(clearDmDot(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
});

describe("scope pill helpers", () => {
  const companies = [
    { companyUid: "cmp_1", label: "Acme" },
    { companyUid: "cmp_2", label: "Beta" },
  ];

  it("buildScopeOptions is All + companies + Personal", () => {
    expect(buildScopeOptions(companies).map((o) => o.id)).toEqual([
      "all",
      "cmp_1",
      "cmp_2",
      "personal",
    ]);
  });

  it("nextScope cycles", () => {
    expect(nextScope("all", companies)).toBe("cmp_1");
    expect(nextScope("cmp_2", companies)).toBe("personal");
    expect(nextScope("personal", companies)).toBe("all");
  });

  it("scopeFromHotkey maps 0 / 1..5 / p", () => {
    expect(scopeFromHotkey("0", companies)).toBe("all");
    expect(scopeFromHotkey("1", companies)).toBe("cmp_1");
    expect(scopeFromHotkey("2", companies)).toBe("cmp_2");
    expect(scopeFromHotkey("3", companies)).toBeNull(); // only 2 companies
    expect(scopeFromHotkey("p", companies)).toBe("personal");
    expect(scopeFromHotkey("P", companies)).toBe("personal");
    expect(scopeFromHotkey("x", companies)).toBeNull();
  });

  it("scopePillLabel resolves company names", () => {
    expect(scopePillLabel("all", companies)).toBe("All");
    expect(scopePillLabel("personal", companies)).toBe("Personal");
    expect(scopePillLabel("cmp_1", companies)).toBe("Acme");
  });
});

describe("typeahead / history / people helpers", () => {
  const rows: ConversationRow[] = [
    {
      id: "dm:1",
      kind: "dm",
      title: "Alex Rivera",
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 10,
      pinned: false,
      personUid: "p1",
      email: "alex@x.com",
    },
    {
      id: "ch:1",
      kind: "channel",
      title: "launch",
      companyUid: "c",
      unreadDot: false,
      lastActivityAt: 5,
      pinned: false,
    },
  ];

  it("filterTypeahead matches title and email", () => {
    expect(filterTypeahead(rows, "alex").map((r) => r.id)).toEqual(["dm:1"]);
    expect(filterTypeahead(rows, "launch").map((r) => r.id)).toEqual(["ch:1"]);
  });

  it("searchHistory filters by title", () => {
    expect(searchHistory(rows, "LAU").map((r) => r.id)).toEqual(["ch:1"]);
  });

  it("searchHistory orders newest-first and historyDayGroups splits by day", () => {
    const now = new Date("2026-08-26T12:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    const mk = (id: string, at: number) =>
      ({ ...rows[0], id, title: id, lastActivityAt: at }) as (typeof rows)[0];
    const input = [
      mk("old", now.getTime() - 3 * day),
      mk("today", now.getTime() - 60_000),
      mk("unknown", 0),
      mk("yesterday", now.getTime() - day),
    ];
    const ordered = searchHistory(input, "");
    expect(ordered.map((r) => r.id)).toEqual([
      "today",
      "yesterday",
      "old",
      "unknown",
    ]);
    const groups = historyDayGroups(ordered, now);
    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      new Date(now.getTime() - 3 * day).toLocaleDateString([], {
        month: "short",
        day: "numeric",
      }),
      "Older",
    ]);
    expect(groups[0].rows.map((r) => r.id)).toEqual(["today"]);
  });

  it("distinctDmPeople returns unique DM counterparts", () => {
    expect(distinctDmPeople(rows)).toEqual([
      { personUid: "p1", label: "Alex Rivera" },
    ]);
  });

  it("initialsFor builds monograms", () => {
    expect(initialsFor("Alex Rivera")).toBe("AR");
    expect(initialsFor("Bo")).toBe("BO");
  });
});

describe("US-013 palette conversation ranking", () => {
  const paletteRows: ConversationRow[] = [
    {
      id: "ch:launch",
      kind: "channel",
      title: "launch",
      companyUid: "cmp_acme",
      unreadDot: false,
      lastActivityAt: 100,
      pinned: false,
      channelId: "chn_launch",
    },
    {
      id: "dm:bob",
      kind: "dm",
      title: "Bob Smith",
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 200,
      pinned: false,
      personUid: "prs_bob",
      email: "bob@example.com",
    },
    {
      id: "ch:design",
      kind: "channel",
      title: "design-system",
      companyUid: "cmp_acme",
      unreadDot: false,
      lastActivityAt: 300,
      pinned: false,
      channelId: "chn_design",
    },
    {
      id: "grp:1",
      kind: "group",
      title: "Launch crew",
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 50,
      pinned: false,
      channelId: "chn_grp",
      memberCount: 3,
    },
  ];

  it("conversationKindLabel maps kinds", () => {
    expect(conversationKindLabel("channel")).toBe("Channel");
    expect(conversationKindLabel("dm")).toBe("DM");
    expect(conversationKindLabel("group")).toBe("Group");
  });

  it("conversationQueryScore prefers starts-with over contains", () => {
    expect(conversationQueryScore(paletteRows[0]!, "lau")).toBe(3);
    expect(conversationQueryScore(paletteRows[3]!, "crew")).toBe(2);
    expect(conversationQueryScore(paletteRows[1]!, "bob@")).toBe(1);
    expect(conversationQueryScore(paletteRows[1]!, "zzz")).toBe(0);
  });

  it("rankPaletteConversations ranks match then recency and is cross-company", () => {
    const ranked = rankPaletteConversations(paletteRows, "lau");
    // "launch" starts with lau (score 3) beats "Launch crew" contains (score 2)
    expect(ranked.map((r) => r.id)).toEqual(["ch:launch", "grp:1"]);
    // Empty query keeps recency order (design 300, bob 200, launch 100, crew 50)
    expect(
      rankPaletteConversations(paletteRows, "", 3).map((r) => r.id),
    ).toEqual(["ch:design", "dm:bob", "ch:launch"]);
  });

  it("companyLabelFor resolves scope labels", () => {
    const companies = [{ companyUid: "cmp_acme", label: "Acme" }];
    expect(companyLabelFor("cmp_acme", companies)).toBe("Acme");
    expect(companyLabelFor(null, companies)).toBeNull();
  });
});

describe("rail scope labels", () => {
  const companies = [
    { companyUid: "cmp_indigo", label: "Indigo" },
    { companyUid: "cmp_lr", label: "Liverecover" },
  ];

  function channelRow(
    name: string,
    companyUid: string,
  ): ConversationRow {
    return normalizeChannel(
      channel({ channelId: name, name, companyUid, companyName: null }),
    );
  }

  function humanRow(
    personUid: string,
    displayName: string,
    email: string,
  ): ConversationRow {
    return normalizeDm(dm({ personUid, displayName, email }));
  }

  function agentRow(
    personUid: string,
    displayName: string,
    companyUid: string,
  ): ConversationRow {
    return normalizeDm(
      dm({
        personUid,
        displayName,
        email: null,
        companyUid,
      }),
    );
  }

  it("resolveRailCompanyName prefers the memberships list and hides raw uids", () => {
    expect(resolveRailCompanyName("cmp_indigo", companies)).toBe("Indigo");
    expect(resolveRailCompanyName("cmp_missing", companies)).toBeNull();
    expect(resolveRailCompanyName("Liverecover", companies)).toBe("Liverecover");
    expect(resolveRailCompanyName(null, companies)).toBeNull();
  });

  it("channel rows in All scope show the company name", () => {
    expect(
      railRowScopeLabel(channelRow("hq-desktop", "cmp_indigo"), {
        scope: "all",
        companies,
        enabled: true,
      }),
    ).toEqual({ kind: "company", text: "Indigo" });
  });

  it("agent DMs in All scope show the company name", () => {
    expect(
      railRowScopeLabel(agentRow("agt_fleet", "Fleet", "cmp_lr"), {
        scope: "all",
        companies,
        enabled: true,
      }),
    ).toEqual({ kind: "company", text: "Liverecover" });
  });

  it("human DMs in All scope show email", () => {
    expect(
      railRowScopeLabel(
        humanRow("prs_ada", "Ada Lovelace", "ada@getindigo.ai"),
        { scope: "all", companies, enabled: true },
      ),
    ).toEqual({ kind: "email", text: "ada@getindigo.ai" });
  });

  it("single-company scope hides company labels", () => {
    expect(
      railRowScopeLabel(channelRow("hq-desktop", "cmp_indigo"), {
        scope: "cmp_indigo",
        companies,
        enabled: true,
      }),
    ).toBeNull();
    expect(
      railRowScopeLabel(agentRow("agt_fleet", "Fleet", "cmp_indigo"), {
        scope: "cmp_indigo",
        companies,
        enabled: true,
      }),
    ).toBeNull();
  });

  it("duplicate-name humans keep email in single-company scope", () => {
    const alexA = humanRow("prs_a", "Alex", "alex@indigo.ai");
    const alexB = humanRow("prs_b", "Alex", "alex@liverecover.com");
    const unique = humanRow("prs_c", "Sofia", "sofia@indigo.ai");
    const dupes = duplicateHumanDmTitles([alexA, alexB, unique]);
    expect(dupes.has("alex")).toBe(true);
    expect(dupes.has("sofia")).toBe(false);
    expect(
      railRowScopeLabel(alexA, {
        scope: "cmp_indigo",
        companies,
        enabled: true,
        duplicateHumanTitles: dupes,
      }),
    ).toEqual({ kind: "email", text: "alex@indigo.ai" });
    expect(
      railRowScopeLabel(unique, {
        scope: "cmp_indigo",
        companies,
        enabled: true,
        duplicateHumanTitles: dupes,
      }),
    ).toBeNull();
  });

  it("toggle off hides every label", () => {
    expect(
      railRowScopeLabel(channelRow("hq-desktop", "cmp_indigo"), {
        scope: "all",
        companies,
        enabled: false,
      }),
    ).toBeNull();
    expect(
      railRowScopeLabel(
        humanRow("prs_ada", "Ada", "ada@getindigo.ai"),
        { scope: "all", companies, enabled: false },
      ),
    ).toBeNull();
  });
});

describe("US-013 message search helpers", () => {
  const companies = [
    { companyUid: "cmp_acme", label: "Acme" },
    { companyUid: "cmp_beta", label: "Beta" },
  ];

  it("searchCompanyUidFromScope only passes specific companies", () => {
    expect(searchCompanyUidFromScope("all")).toBeNull();
    expect(searchCompanyUidFromScope("personal")).toBeNull();
    expect(searchCompanyUidFromScope("cmp_acme")).toBe("cmp_acme");
  });

  it("historySearchScopeLabel surfaces company name", () => {
    expect(historySearchScopeLabel("all", companies)).toBe("All companies");
    expect(historySearchScopeLabel("personal", companies)).toBe("Personal");
    expect(historySearchScopeLabel("cmp_acme", companies)).toBe("Acme");
  });

  it("searchHitSnippet prefers snippet then body", () => {
    expect(
      searchHitSnippet({
        messageId: "m1",
        scope: "dm",
        snippet: "  snip  ",
        body: "body",
        createdAt: "2026-08-11T10:00:00.000Z",
      }),
    ).toBe("snip");
    expect(
      searchHitSnippet({
        messageId: "m2",
        scope: "channel",
        body: " only body ",
        createdAt: "2026-08-11T10:00:00.000Z",
      }),
    ).toBe("only body");
  });

  it("resolveSearchHitRow maps dm/channel onto local rows", () => {
    const rows: ConversationRow[] = [
      {
        id: "dm:prs_bob",
        kind: "dm",
        title: "Bob",
        companyUid: null,
        unreadDot: false,
        lastActivityAt: 1,
        pinned: false,
        personUid: "prs_bob",
      },
      {
        id: "ch:chn_1",
        kind: "channel",
        title: "launch",
        companyUid: "cmp_acme",
        unreadDot: false,
        lastActivityAt: 2,
        pinned: false,
        channelId: "chn_1",
      },
    ];
    const dmHit: MessageSearchHit = {
      messageId: "msg_y",
      scope: "dm",
      counterpartyUid: "prs_bob",
      body: "review from yesterday",
      createdAt: "2026-08-11T09:00:00.000Z",
    };
    expect(resolveSearchHitRow(dmHit, rows).title).toBe("Bob");
    const chHit: MessageSearchHit = {
      messageId: "msg_c",
      scope: "channel",
      channelId: "chn_1",
      snippet: "ship it",
      createdAt: "2026-08-11T10:00:00.000Z",
    };
    expect(resolveSearchHitRow(chHit, rows).id).toBe("ch:chn_1");
  });

  it("formatSearchHitTime labels yesterday hits", () => {
    const yesterdayIso = new Date(NOW - 86_400_000).toISOString();
    const label = formatSearchHitTime(yesterdayIso, NOW);
    expect(label.startsWith("Yesterday")).toBe(true);
  });
});

// ── Design-gap wave regressions (G2 / G3) — real failure shapes ─────────────

describe("G2: day grouping on real mixed conversation timestamps", () => {
  it("splits real ISO-timestamped channels/DMs into TODAY / YESTERDAY / weekday sections, LAST WEEK only for >7d", () => {
    // Real shape: server ISO strings on channels AND contacts (not epoch/absent).
    const channels: Channel[] = [
      channel({
        channelId: "ch_today",
        name: "hq-dev",
        lastActivityAt: iso(msOnDay(0, 9)),
      }),
      channel({
        channelId: "ch_yday",
        name: "vyg-dev",
        lastMessageAt: iso(msOnDay(1, 17)),
      }),
      channel({
        channelId: "ch_mon",
        name: "general",
        lastActivityAt: iso(msOnDay(3, 8)),
      }),
      channel({
        channelId: "ch_old",
        name: "crew",
        lastActivityAt: iso(msOnDay(12, 8)),
      }),
    ];
    const contacts: DmContactInput[] = [
      dm({
        personUid: "prs_a",
        displayName: "Jacob Posel",
        lastDmAt: iso(msOnDay(0, 10)),
      }),
      dm({
        personUid: "prs_b",
        displayName: "Alan Saura",
        lastMessageAt: iso(msOnDay(9, 10)),
      }),
    ];
    const rows = normalizeConversations(channels, contacts);
    const grouped = groupByDay(applySidebarFilters(rows), NOW);

    // Sections exist for today / yesterday / a weekday — NOT one LAST WEEK dump.
    expect(grouped.sections.length).toBe(3);
    expect(grouped.sections[0]!.label.startsWith("TODAY")).toBe(true);
    expect(grouped.sections[0]!.rows.map((r) => r.id).sort()).toEqual(
      ["ch:ch_today", "dm:prs_a"].sort(),
    );
    expect(grouped.sections[1]!.label).toBe("YESTERDAY · AUG 11");
    // 3 days ago (Sunday relative to Wed Aug 12 minus 3 = Sunday) — a weekday name.
    expect(grouped.sections[2]!.label).toMatch(
      /^(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY) · AUG \d+$/,
    );
    // Only genuinely old (>7d) rows fold under LAST WEEK.
    expect(grouped.lastWeek.map((r) => r.id).sort()).toEqual(
      ["ch:ch_old", "dm:prs_b"].sort(),
    );
  });

  it("channels stripped of timestamps (the pre-fix Rust wire bug shape) would all fold — activity fields must be honored when present", () => {
    // The regression shape: 106 rows all lastActivityAt=0 → single LAST WEEK fold.
    const stripped = [
      channel({ channelId: "c1", name: "hq-dev" }),
      channel({ channelId: "c2", name: "general" }),
    ];
    const grouped = groupByDay(normalizeConversations(stripped, []), NOW);
    expect(grouped.sections.length).toBe(0);
    expect(grouped.lastWeek.length).toBe(2);
    // Same channels WITH the server timestamps surface in day sections.
    const withTs = stripped.map((c) => ({
      ...c,
      lastActivityAt: iso(msOnDay(0, 9)),
    }));
    const fixed = groupByDay(normalizeConversations(withTs, []), NOW);
    expect(fixed.lastWeek.length).toBe(0);
    expect(fixed.sections[0]!.rows.length).toBe(2);
  });
});

describe("inbox activity stamps older DMs into their true day bucket", () => {
  it("contacts stamped with inbox activity from ~3 days ago land in that day's section, not today", () => {
    const contacts: DmContactInput[] = [
      dm({
        personUid: "prs_jacob",
        displayName: "Jacob Posel",
      }),
    ];
    expect(
      normalizeConversations([], contacts).some((r) => r.id === "dm:prs_jacob"),
    ).toBe(false);

    const threeDaysAgo = iso(msOnDay(3, 14));
    const stamped = mergeContactsWithInbox(contacts, [
      {
        fromPersonUid: "prs_jacob",
        fromDisplayName: "Jacob Posel",
        createdAt: threeDaysAgo,
      },
    ]);
    const rows = normalizeConversations([], stamped);
    const dmRow = rows.find((r) => r.id === "dm:prs_jacob");
    expect(dmRow).toBeTruthy();
    expect(dmRow!.kind).toBe("dm");
    expect(dmRow!.lastActivityAt).toBe(msOnDay(3, 14));

    const grouped = groupByDay(rows, NOW);
    expect(
      grouped.sections
        .find((s) => s.label.startsWith("TODAY"))
        ?.rows.some((r) => r.id === "dm:prs_jacob") ?? false,
    ).toBe(false);
    expect(grouped.lastWeek.some((r) => r.id === "dm:prs_jacob")).toBe(false);
    const home = grouped.sections.find((s) =>
      s.rows.some((r) => r.id === "dm:prs_jacob"),
    );
    expect(home).toBeTruthy();
    expect(home!.label).toBe(daySectionLabel(msOnDay(3, 14), NOW));
    expect(home!.label.startsWith("TODAY")).toBe(false);
  });

  it("never drags a pair backwards when the contact's own stamp is newer", () => {
    // The inbox only knows INBOUND DMs. A pair the owner messaged today must
    // stay in TODAY even though the counterpart's last reply was days ago.
    const today = msOnDay(0, 9);
    const stamped = mergeContactsWithInbox(
      [
        dm({
          personUid: "prs_jacob",
          displayName: "Jacob Posel",
          lastMessageAt: iso(today),
        }),
      ],
      [
        {
          fromPersonUid: "prs_jacob",
          fromDisplayName: "Jacob Posel",
          createdAt: iso(msOnDay(3, 14)),
        },
      ],
    );
    const rows = normalizeConversations([], stamped);
    const dmRow = rows.find((r) => r.id === "dm:prs_jacob");
    expect(dmRow?.lastActivityAt).toBe(today);
    const grouped = groupByDay(rows, NOW);
    expect(
      grouped.sections
        .find((s) => s.label.startsWith("TODAY"))
        ?.rows.some((r) => r.id === "dm:prs_jacob") ?? false,
    ).toBe(true);
  });
});

describe("every DM with messages is a rail row", () => {
  it("promotes a human DM with a message today when the contact is not cached", () => {
    const stamped = mergeContactsWithInbox([], [
      {
        fromPersonUid: "prs_jacob",
        fromDisplayName: "Jacob Posel",
        createdAt: iso(msOnDay(0, 15)),
      },
    ]);
    const rows = normalizeConversations([], stamped);
    const grouped = groupByDay(rows, NOW);
    const today = grouped.sections.find((s) => s.label.startsWith("TODAY"));
    const row = today?.rows.find((r) => r.id === "dm:prs_jacob");
    expect(row).toBeTruthy();
    expect(row!.title).toBe("Jacob Posel");
  });

  it("stamps a delegation-style timeline so the newest outbound lands under TODAY", () => {
    const inbound = msOnDay(0, 15);
    const outbound = inbound + 20_000;
    const activity = dmActivityFromTimeline("prs_jacob", [
      {
        createdAt: iso(msOnDay(9)),
        body: "",
        details: "Hand this off to Deacon",
        prompt: "Please take the next step",
      },
      {
        createdAt: iso(inbound),
        body: "Hey",
        direction: "in",
        fromPersonUid: "prs_jacob",
      },
      {
        createdAt: iso(outbound),
        body: "Hey there",
        direction: "out",
        fromPersonUid: "prs_self",
      },
    ]);
    expect(activity).toEqual({
      personUid: "prs_jacob",
      lastMessageAt: iso(outbound),
    });
    const stamped = mergeContactsWithInbox(
      [dm({ personUid: "prs_jacob", displayName: "Jacob Posel" })],
      [{ fromPersonUid: activity!.personUid, createdAt: activity!.lastMessageAt }],
    );
    const rows = normalizeConversations([], stamped);
    const dmRow = rows.find((r) => r.id === "dm:prs_jacob");
    expect(dmRow?.lastActivityAt).toBe(outbound);
    const grouped = groupByDay(rows, NOW);
    expect(
      grouped.sections
        .find((s) => s.label.startsWith("TODAY"))
        ?.rows.some((r) => r.id === "dm:prs_jacob") ?? false,
    ).toBe(true);
  });

  it("keeps one DM row for a peer in two companies and does not leak the other company's channel", () => {
    const today = iso(msOnDay(0, 12));
    const rows = normalizeConversations(
      [
        channel({
          channelId: "ch_other",
          name: "other-proj",
          companyUid: "cmp_other",
          lastActivityAt: today,
        }),
      ],
      [
        dm({
          personUid: "prs_peer",
          displayName: "Peer",
          companyUid: "cmp_indigo",
          lastMessageAt: today,
        }),
        dm({
          personUid: "prs_peer",
          displayName: "Peer",
          companyUid: "cmp_other",
          lastMessageAt: today,
        }),
      ],
    );
    expect(rows.filter((r) => r.id === "dm:prs_peer")).toHaveLength(1);
    const scoped = filterByCompanyScope(rows, "cmp_indigo");
    expect(scoped.filter((r) => r.id === "dm:prs_peer")).toHaveLength(1);
    expect(scoped.some((r) => r.id === "ch:ch_other")).toBe(false);
  });
});

describe("mergeContactsWithInbox — 1:1 DMs are not channel-directory rows", () => {
  it("stamps lastMessageAt from the newest inbox event onto a roster contact", () => {
    const merged = mergeContactsWithInbox(
      [
        {
          personUid: "prs_jacob",
          displayName: "Jacob Posel",
          email: "jacob@getindigo.ai",
        },
      ],
      [
        {
          fromPersonUid: "prs_jacob",
          fromDisplayName: "Jacob Posel",
          createdAt: "2026-08-16T19:40:05.975Z",
        },
        {
          fromPersonUid: "prs_jacob",
          fromDisplayName: "Jacob Posel",
          createdAt: "2026-08-16T21:10:27.909Z",
        },
      ],
      [{ withPersonUid: "prs_jacob", unreadCount: 4 }],
    );
    expect(merged).toEqual([
      expect.objectContaining({
        personUid: "prs_jacob",
        displayName: "Jacob Posel",
        lastMessageAt: "2026-08-16T21:10:27.909Z",
        unreadCount: 4,
      }),
    ]);
  });

  it("promotes an inbox-only sender who is missing from contacts", () => {
    const merged = mergeContactsWithInbox(
      [],
      [
        {
          fromPersonUid: "prs_new",
          fromDisplayName: "New Person",
          createdAt: "2026-08-16T12:00:00.000Z",
        },
      ],
    );
    expect(merged.map((c) => c.personUid)).toEqual(["prs_new"]);
    expect(merged[0]?.lastMessageAt).toBe("2026-08-16T12:00:00.000Z");
  });

  it("promotes a pair-unread peer after the inbox event window has rolled off", () => {
    const merged = mergeContactsWithInbox(
      [],
      [],
      [{ withPersonUid: "prs_corey", unreadCount: 21 }],
    );
    expect(merged).toEqual([
      expect.objectContaining({
        personUid: "prs_corey",
        unreadCount: 21,
      }),
    ]);
  });
});

describe("stampContactsFromDmThreads", () => {
  it("promotes a disk thread that is missing from contacts and inbox", () => {
    const merged = stampContactsFromDmThreads(
      [{ personUid: "prs_jacob", displayName: "Jacob Posel" }],
      [
        {
          personUid: "agt_deacon",
          displayName: "Deacon",
          lastMessageAt: "2026-07-20T16:42:27.641Z",
          unreadCount: 59,
        },
      ],
    );
    expect(merged.map((c) => c.personUid).sort()).toEqual([
      "agt_deacon",
      "prs_jacob",
    ]);
    expect(merged.find((c) => c.personUid === "agt_deacon")).toMatchObject({
      displayName: "Deacon",
      lastMessageAt: "2026-07-20T16:42:27.641Z",
      unreadCount: 59,
    });
  });
});

describe("mergeContactActivity", () => {
  it("keeps prior lastMessageAt when a roster refresh has none", () => {
    const merged = mergeContactActivity(
      [
        {
          personUid: "prs_jacob",
          displayName: "Jacob Posel",
          lastMessageAt: "2026-08-16T21:10:27.909Z",
          unreadCount: 4,
        },
      ],
      [
        {
          personUid: "prs_jacob",
          displayName: "Jacob Posel",
          unreadCount: 0,
        },
      ],
    );
    expect(merged).toEqual([
      expect.objectContaining({
        personUid: "prs_jacob",
        lastMessageAt: "2026-08-16T21:10:27.909Z",
        unreadCount: 0,
      }),
    ]);
  });
});

describe("applyDirectoryFeed — host seed vs empty reconcile", () => {
  const seed = [
    {
      channelId: "chn_live",
      type: "project",
      scope: "project",
      companyUid: "cmp_indigo",
      name: "work-mesh-testing",
      lastActivityAt: "2026-08-16T05:00:00.000Z",
      unreadCount: 0,
      memberCount: 1,
    },
  ];

  it("applies a populated snapshot", () => {
    const next = applyDirectoryRows(seed, []);
    expect(next.map((c) => c.channelId)).toEqual(["chn_live"]);
  });

  it("does not wipe a host seed when the first reconcile returns no rows", () => {
    const painted = applyDirectoryRows(seed, []);
    const next = applyDirectoryFeed([], painted, seed);
    expect(next.map((c) => c.channelId)).toEqual(["chn_live"]);
  });

  it("lets a later empty directory stand when there is no seed", () => {
    const painted = applyDirectoryRows(seed, []);
    expect(applyDirectoryFeed([], painted, null)).toEqual([]);
  });

  it("does not zero a newer local unread when the snapshot is older", () => {
    const painted = [
      {
        channelId: "chn_live",
        name: "work-mesh-testing",
        scope: "project" as const,
        unread: 1,
        lastActivityAt: "2026-08-22T12:00:00.000Z",
        lastMessageAt: "2026-08-22T12:00:00.000Z",
      },
    ];
    const next = applyDirectoryRows(
      [
        {
          ...seed[0]!,
          unreadCount: 0,
          lastActivityAt: "2026-08-16T05:00:00.000Z",
        },
      ],
      painted,
    );
    expect(next[0]?.unread).toBe(1);
  });
});

describe("G3: contacts directory never renders as sidebar conversation rows", () => {
  // Real failure shape: /v1/notify/contacts returns the whole people directory,
  // including raw agent ids, with NO conversation timestamps.
  const directoryContacts: DmContactInput[] = [
    dm({ personUid: "agt_01kwcayv2bgw9za9993", displayName: "", email: "" }),
    dm({ personUid: "prs_alan", displayName: "Alan Saura" }),
    dm({ personUid: "prs_aleena", displayName: "Aleena Hassaan" }),
  ];
  const realDm = dm({
    personUid: "prs_jacob",
    displayName: "Jacob Posel",
    lastDmAt: iso(msOnDay(0, 10)),
  });

  it("collapses Scouty-style DM rows that share a name and have no email", () => {
    const rows = normalizeConversations(
      [],
      [
        dm({
          personUid: "agt_scouty",
          displayName: "Scouty",
          email: null,
          unreadCount: 1,
          lastDmAt: iso(msOnDay(0, 8)),
        }),
        dm({
          personUid: "prs_scouty",
          displayName: "Scouty",
          email: null,
          unreadCount: 1,
          lastDmAt: iso(msOnDay(0, 10)),
        }),
        dm({
          personUid: "prs_other",
          displayName: "Scouty",
          email: null,
          unreadCount: 1,
          lastDmAt: iso(msOnDay(0, 9)),
        }),
      ],
    );
    expect(rows.filter((row) => row.title === "Scouty")).toHaveLength(1);
    expect(rows.find((row) => row.title === "Scouty")?.personUid).toBe(
      "prs_scouty",
    );
  });

  it("keeps two DMs with the same name when emails differ", () => {
    const rows = normalizeConversations(
      [],
      [
        dm({
          personUid: "prs_vyg",
          displayName: "Yousuf Kalim",
          email: "yousuf@vyg.ai",
          lastDmAt: iso(msOnDay(0, 8)),
        }),
        dm({
          personUid: "prs_indigo",
          displayName: "Yousuf Kalim",
          email: "yousuf@getindigo.ai",
          lastDmAt: iso(msOnDay(0, 9)),
        }),
      ],
    );
    expect(rows.filter((row) => row.title === "Yousuf Kalim")).toHaveLength(2);
  });

  it("excludes contacts with no conversation signal (incl. agt_* ids)", () => {
    const rows = normalizeConversations([], [...directoryContacts, realDm]);
    expect(rows.map((r) => r.id)).toEqual(["dm:prs_jacob"]);
  });

  it("dedupes the same personUid if the roster listed them twice", () => {
    const rows = normalizeConversations(
      [],
      [
        dm({
          personUid: "prs_scouty",
          displayName: "Scouty",
          unreadCount: 1,
          lastDmAt: iso(msOnDay(0, 10)),
        }),
        dm({
          personUid: "prs_scouty",
          displayName: "Scouty",
          unreadCount: 1,
          lastDmAt: iso(msOnDay(0, 9)),
        }),
      ],
    );
    expect(rows.map((r) => r.id)).toEqual(["dm:prs_scouty"]);
  });

  it("keeps a recently opened DM after unread is cleared", () => {
    const rows = normalizeConversations(
      [],
      [dm({ personUid: "prs_jacob", displayName: "Jacob Posel" })],
      { recentDms: ["prs_jacob"] },
    );
    expect(rows.map((r) => r.id)).toEqual(["dm:prs_jacob"]);
  });

  it("keeps contacts with server unread or a local activity dot", () => {
    const rows = normalizeConversations(
      [],
      [
        dm({ personUid: "prs_unread", displayName: "U", unreadCount: 2 }),
        dm({ personUid: "prs_dot", displayName: "D" }),
        dm({ personUid: "prs_silent", displayName: "S" }),
      ],
      { dmDots: ["prs_dot"] },
    );
    expect(rows.map((r) => r.id).sort()).toEqual([
      "dm:prs_dot",
      "dm:prs_unread",
    ]);
  });

  it("still exposes the full directory to the new-message typeahead", () => {
    const rows = normalizeConversations([], [...directoryContacts, realDm], {
      includeContactsWithoutConversation: true,
    });
    expect(rows).toHaveLength(4);
    const hits = filterTypeahead(rows, "alan");
    expect(hits.map((r) => r.personUid)).toContain("prs_alan");
  });
});

describe("collapseDuplicateGroupRows", () => {
  function groupRow(
    partial: Partial<ConversationRow> & { id: string },
  ): ConversationRow {
    return {
      kind: "group",
      title: "Jacob Posel",
      companyUid: null,
      unreadDot: false,
      lastActivityAt: 0,
      pinned: false,
      ...partial,
    };
  }

  const jacob = { personUid: "prs_jacob", displayName: "Jacob Posel" };
  const caitlin = { personUid: "prs_caitlin", displayName: "Caitlin Hutchinson" };

  it("collapses identical rosters to the most recently active row", () => {
    const older = groupRow({
      id: "ch:g-old",
      channelId: "g-old",
      lastActivityAt: msOnDay(0, 8),
      members: [jacob],
    });
    const newer = groupRow({
      id: "ch:g-new",
      channelId: "g-new",
      lastActivityAt: msOnDay(0, 10),
      unreadDot: true,
      members: [jacob],
    });
    const channelRow: ConversationRow = {
      id: "ch:ops",
      kind: "channel",
      title: "ops",
      companyUid: "cmp_a",
      unreadDot: false,
      lastActivityAt: msOnDay(0, 9),
      pinned: false,
      channelId: "ops",
    };
    const rows = collapseDuplicateGroupRows([channelRow, older, newer]);
    expect(rows.map((row) => row.id)).toEqual(["ch:ops", "ch:g-new"]);
  });

  it("keeps group rows with different rosters separate", () => {
    const withJacob = groupRow({
      id: "ch:g-jacob",
      lastActivityAt: msOnDay(0, 10),
      members: [jacob],
    });
    const withBoth = groupRow({
      id: "ch:g-both",
      title: "Jacob Posel, Caitlin Hutchinson",
      lastActivityAt: msOnDay(0, 9),
      members: [jacob, caitlin],
    });
    const rows = collapseDuplicateGroupRows([withJacob, withBoth]);
    expect(rows.map((row) => row.id)).toEqual(["ch:g-jacob", "ch:g-both"]);
  });

  it("leaves rows without member info untouched", () => {
    const noMembers = groupRow({
      id: "ch:g-empty",
      lastActivityAt: msOnDay(0, 10),
    });
    const emptyMembers = groupRow({
      id: "ch:g-blank",
      lastActivityAt: msOnDay(0, 9),
      members: [],
    });
    const unnamed = groupRow({
      id: "ch:g-unnamed",
      lastActivityAt: msOnDay(0, 8),
      members: [{ personUid: "", displayName: "" }],
    });
    const rows = collapseDuplicateGroupRows([
      noMembers,
      emptyMembers,
      unnamed,
    ]);
    expect(rows.map((row) => row.id)).toEqual([
      "ch:g-empty",
      "ch:g-blank",
      "ch:g-unnamed",
    ]);
  });

  it("keys by display names when personUids are missing, ignoring order", () => {
    const a = groupRow({
      id: "ch:g-a",
      lastActivityAt: msOnDay(0, 8),
      members: [
        { personUid: "", displayName: "Caitlin Hutchinson" },
        { personUid: "", displayName: "Jacob Posel" },
      ],
    });
    const b = groupRow({
      id: "ch:g-b",
      lastActivityAt: msOnDay(0, 11),
      members: [
        { personUid: "", displayName: "Jacob Posel" },
        { personUid: "", displayName: "Caitlin Hutchinson" },
      ],
    });
    const rows = collapseDuplicateGroupRows([a, b]);
    expect(rows.map((row) => row.id)).toEqual(["ch:g-b"]);
  });

  it("normalizeConversations collapses duplicate group channels by roster", () => {
    const rows = normalizeConversations(
      [
        channel({
          channelId: "g-old",
          name: "",
          scope: "group",
          lastActivityAt: iso(msOnDay(0, 8)),
          members: [jacob],
        }),
        channel({
          channelId: "g-new",
          name: "",
          scope: "group",
          lastActivityAt: iso(msOnDay(0, 10)),
          members: [jacob],
        }),
        channel({
          channelId: "ops",
          name: "ops",
          lastActivityAt: iso(msOnDay(0, 9)),
        }),
      ],
      [],
    );
    expect(rows.filter((row) => row.kind === "group")).toHaveLength(1);
    expect(rows.find((row) => row.kind === "group")?.channelId).toBe("g-new");
    expect(rows.find((row) => row.kind === "channel")?.channelId).toBe("ops");
  });
});

describe("rowAvatar", () => {
  const agent = {
    kind: "dm" as const,
    personUid: "agt_parker",
    title: "Parker",
  };
  const human = {
    kind: "dm" as const,
    personUid: "prs_ada",
    title: "Ada Lovelace",
  };

  it("uses a known photo for anyone", () => {
    expect(rowAvatar(agent, { agt_parker: PARKER_PHOTO })).toEqual({
      kind: "photo",
      src: PARKER_PHOTO,
    });
    expect(rowAvatar(human, { prs_ada: ADA_PHOTO })).toEqual({
      kind: "photo",
      src: ADA_PHOTO,
    });
  });

  it("ignores arbitrary http(s) photos the packaged CSP cannot paint", () => {
    expect(
      rowAvatar(agent, { agt_parker: "https://cdn.test/parker.jpg" }),
    ).toMatchObject({ kind: "generated" });
    expect(
      rowAvatar(human, { prs_ada: "https://cdn.test/ada.jpg" }),
    ).toEqual({ kind: "initials", initials: "AL" });
  });

  it("uses a deterministic generated avatar for a photo-less agent", () => {
    const avatar = rowAvatar(agent);
    expect(avatar.kind).toBe("generated");
    expect(agentAvatarAssets).toContain(avatar.src);
    expect(avatar.src).toBe(agentAvatarFor("agt_parker"));
    expect(rowAvatar(agent).src).toBe(avatar.src);
  });

  it("uses initials for a photo-less human", () => {
    expect(rowAvatar(human)).toEqual({ kind: "initials", initials: "AL" });
  });

  it("never shows bare initials for an agent while the set is bundled", () => {
    expect(rowAvatar(agent, null)).toMatchObject({ kind: "generated" });
    expect(rowAvatar(agent, {})).toMatchObject({ kind: "generated" });
  });

  it("only generates for agent DM rows, never for channels or humans", () => {
    expect(
      rowAvatar({ kind: "channel", personUid: "agt_parker", title: "ops" }),
    ).toEqual({ kind: "initials", initials: "OP" });
    expect(rowAvatar(human, {})).toEqual({ kind: "initials", initials: "AL" });
  });
});
