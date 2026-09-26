import { describe, expect, it } from "vitest";
import { isCompanyHomeChannel, type Channel } from "./channels";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import {
  applyDirectoryFeed,
  applyDirectoryRows,
  companyActivityScore,
  findCompanyHomeRow,
  loadPinnedCompanies,
  migratePinnedCompanySelection,
  normalizeChannel,
  rankCompaniesByActivity,
  resolveCompanySectionRows,
  savePinnedCompanies,
  type ConversationRow,
} from "./sidebar-model";

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

function channel(over: Partial<Channel> = {}): Channel {
  return {
    channelId: "chn_1",
    name: "general",
    scope: "company",
    companyUid: "cmp_acme",
    ...over,
  };
}

describe("isCompanyHomeChannel", () => {
  it("is true when EITHER the explicit isCompanyHome flag is set OR the channel id matches homeChannelId", () => {
    // Flag true, id doesn't match — still home (flag wins).
    expect(
      isCompanyHomeChannel({ channelId: "chn_random", isCompanyHome: true }, "chn_home"),
    ).toBe(true);
    // Flag explicitly false, but the id DOES match homeChannelId — still
    // home: the predicate is an OR, the id is authoritative either way.
    expect(
      isCompanyHomeChannel({ channelId: "chn_home", isCompanyHome: false }, "chn_home"),
    ).toBe(true);
    // Neither signal fires.
    expect(
      isCompanyHomeChannel({ channelId: "chn_other", isCompanyHome: false }, "chn_home"),
    ).toBe(false);
  });

  it("matches by channel id when isCompanyHome is absent", () => {
    expect(isCompanyHomeChannel({ channelId: "chn_home" }, "chn_home")).toBe(true);
    expect(isCompanyHomeChannel({ channelId: "chn_random" }, "chn_home")).toBe(false);
  });

  it("is false when the company's homeChannelId is unknown", () => {
    expect(isCompanyHomeChannel({ channelId: "chn_home" }, null)).toBe(false);
    expect(isCompanyHomeChannel({ channelId: "chn_home" }, undefined)).toBe(false);
    expect(isCompanyHomeChannel({ channelId: "chn_home" }, "")).toBe(false);
  });

  it("never does name/slug matching — only the id or the explicit flag decide", () => {
    // A channel literally named after the company slug is NOT the home
    // channel unless its id matches homeChannelId (or the server flagged it).
    expect(isCompanyHomeChannel({ channelId: "chn_other" }, "chn_home")).toBe(false);
  });
});

describe("normalizeChannel — isCompanyHome resolution", () => {
  it("carries an explicit server isCompanyHome flag through to the row", () => {
    const row = normalizeChannel(channel({ isCompanyHome: true }));
    expect(row.isCompanyHome).toBe(true);
  });

  it("resolves isCompanyHome via homeChannelIdByUid when the server omits the field", () => {
    const home = normalizeChannel(
      channel({ channelId: "chn_home" }),
      { homeChannelIdByUid: new Map([["cmp_acme", "chn_home"]]) },
    );
    expect(home.isCompanyHome).toBe(true);

    const team = normalizeChannel(
      channel({ channelId: "chn_team" }),
      { homeChannelIdByUid: new Map([["cmp_acme", "chn_home"]]) },
    );
    expect(team.isCompanyHome).toBe(false);
  });

  it("with multiple scope='company' channels in one company, only the id-matching one resolves as home", () => {
    const homeMap = new Map([["cmp_acme", "chn_home"]]);
    const rows = [
      channel({ channelId: "chn_home" }),
      channel({ channelId: "chn_team1", name: "marketing" }),
      channel({ channelId: "chn_team2", name: "eng" }),
    ].map((c) => normalizeChannel(c, { homeChannelIdByUid: homeMap }));
    const homes = rows.filter((r) => r.isCompanyHome);
    expect(homes).toHaveLength(1);
    expect(homes[0]?.channelId).toBe("chn_home");
  });

  it("never marks a group DM as isCompanyHome", () => {
    const row = normalizeChannel(channel({ scope: "group", companyUid: null }));
    expect(row.isCompanyHome).toBeUndefined();
  });
});

function homeRow(
  companyUid: string,
  channelId: string,
  messageActivityAt = 0,
): ConversationRow {
  return {
    id: `ch:${channelId}`,
    kind: "channel",
    channelScope: "company",
    title: `#${channelId}`,
    companyUid,
    unreadDot: false,
    lastActivityAt: messageActivityAt,
    messageActivityAt,
    pinned: false,
    channelId,
    isCompanyHome: true,
  };
}

function teamRow(
  companyUid: string,
  channelId: string,
  messageActivityAt = 0,
): ConversationRow {
  return {
    id: `ch:${channelId}`,
    kind: "channel",
    channelScope: "company",
    title: `#${channelId}`,
    companyUid,
    unreadDot: false,
    lastActivityAt: messageActivityAt,
    messageActivityAt,
    pinned: false,
    channelId,
    isCompanyHome: false,
  };
}

describe("companyActivityScore / rankCompaniesByActivity", () => {
  const companies = [
    { companyUid: "cmp_acme", label: "Acme" },
    { companyUid: "cmp_beta", label: "Beta" },
    { companyUid: "cmp_gamma", label: "Gamma" },
  ];

  it("prefers the home channel's messageActivityAt", () => {
    const rows = [homeRow("cmp_acme", "acme", 500)];
    expect(companyActivityScore("cmp_acme", rows)).toBe(500);
  });

  it("falls back to the busiest other company-scope channel when the home row has no message activity", () => {
    const rows = [
      homeRow("cmp_acme", "acme", 0),
      teamRow("cmp_acme", "marketing", 100),
      teamRow("cmp_acme", "eng", 300),
    ];
    expect(companyActivityScore("cmp_acme", rows)).toBe(300);
  });

  it("falls back the same way when the home row is unresolved (not in the loaded rows at all)", () => {
    const rows = [teamRow("cmp_acme", "eng", 42)];
    expect(companyActivityScore("cmp_acme", rows)).toBe(42);
  });

  it("scores 0 for a company with no activity anywhere", () => {
    expect(companyActivityScore("cmp_acme", [])).toBe(0);
  });

  it("ranks the 3 most active companies first, deterministically", () => {
    const rows = [
      homeRow("cmp_acme", "acme", 100),
      homeRow("cmp_beta", "beta", 900),
      homeRow("cmp_gamma", "gamma", 500),
    ];
    const ranked = rankCompaniesByActivity(companies, rows);
    expect(ranked.map((c) => c.companyUid)).toEqual([
      "cmp_beta",
      "cmp_gamma",
      "cmp_acme",
    ]);
  });

  it("breaks ties by label for deterministic ordering", () => {
    const rows = [
      homeRow("cmp_acme", "acme", 0),
      homeRow("cmp_beta", "beta", 0),
      homeRow("cmp_gamma", "gamma", 0),
    ];
    const ranked = rankCompaniesByActivity(companies, rows);
    expect(ranked.map((c) => c.companyUid)).toEqual([
      "cmp_acme",
      "cmp_beta",
      "cmp_gamma",
    ]);
  });
});

describe("resolveCompanySectionRows", () => {
  const companies = [
    { companyUid: "cmp_acme", label: "Acme", homeChannelId: "acme" },
    { companyUid: "cmp_beta", label: "Beta", homeChannelId: "beta" },
    { companyUid: "cmp_gamma", label: "Gamma", homeChannelId: "gamma" },
    { companyUid: "cmp_delta", label: "Delta", homeChannelId: "delta" },
  ];

  it("no pins: shows the top-3 most active companies, ranked", () => {
    const rows = [
      homeRow("cmp_acme", "acme", 100),
      homeRow("cmp_beta", "beta", 900),
      homeRow("cmp_gamma", "gamma", 500),
      homeRow("cmp_delta", "delta", 50),
    ];
    const sections = resolveCompanySectionRows(companies, rows, null);
    expect(sections.map((r) => r.companyUid)).toEqual([
      "cmp_beta",
      "cmp_gamma",
      "cmp_acme",
    ]);
  });

  it("no pins: an empty pin array behaves the same as null (top-3 default)", () => {
    const rows = [
      homeRow("cmp_acme", "acme", 100),
      homeRow("cmp_beta", "beta", 900),
      homeRow("cmp_gamma", "gamma", 500),
      homeRow("cmp_delta", "delta", 50),
    ];
    const sections = resolveCompanySectionRows(companies, rows, []);
    expect(sections.map((r) => r.companyUid)).toEqual([
      "cmp_beta",
      "cmp_gamma",
      "cmp_acme",
    ]);
  });

  it("pins present: shows ONLY the pinned companies, never mixed with top-3", () => {
    const rows = [
      homeRow("cmp_acme", "acme", 100),
      homeRow("cmp_beta", "beta", 900),
      homeRow("cmp_gamma", "gamma", 500),
      homeRow("cmp_delta", "delta", 50),
    ];
    // Pin the two LEAST active companies — if pins were merged with top-3
    // this would show 4 or 5 rows; it must show exactly the 2 pinned ones.
    const sections = resolveCompanySectionRows(companies, rows, [
      "cmp_delta",
      "cmp_acme",
    ]);
    expect(sections.map((r) => r.companyUid)).toEqual(["cmp_acme", "cmp_delta"]);
  });

  it("pins are always shown even if they have zero activity", () => {
    const rows: ConversationRow[] = [];
    const sections = resolveCompanySectionRows(companies, rows, ["cmp_gamma"]);
    expect(sections.map((r) => r.companyUid)).toEqual(["cmp_gamma"]);
  });

  it("a company with no homeChannelId yet is included with homeChannelId: null (shown disabled, not hidden)", () => {
    const rows: ConversationRow[] = [];
    const sections = resolveCompanySectionRows(
      [
        { companyUid: "cmp_acme", label: "Acme", homeChannelId: "acme" },
        { companyUid: "cmp_beta", label: "Beta", homeChannelId: null },
      ],
      rows,
      ["cmp_acme", "cmp_beta"],
    );
    const beta = sections.find((r) => r.companyUid === "cmp_beta");
    expect(beta).toBeDefined();
    expect(beta?.homeChannelId).toBeNull();
  });

  it("carries the roster's homeChannelId straight through — no row lookup needed", () => {
    const sections = resolveCompanySectionRows(
      [{ companyUid: "cmp_acme", label: "Acme", homeChannelId: "acme" }],
      [],
      ["cmp_acme"],
    );
    expect(sections[0]?.homeChannelId).toBe("acme");
  });

  it("respects a custom limit for the default top-N view", () => {
    const rows = [
      homeRow("cmp_acme", "acme", 100),
      homeRow("cmp_beta", "beta", 900),
      homeRow("cmp_gamma", "gamma", 500),
      homeRow("cmp_delta", "delta", 50),
    ];
    const sections = resolveCompanySectionRows(companies, rows, null, 1);
    expect(sections.map((r) => r.companyUid)).toEqual(["cmp_beta"]);
  });
});

describe("migratePinnedCompanySelection", () => {
  const allUids = ["cmp_acme", "cmp_beta", "cmp_gamma"];

  it("null (no persisted pref) stays null — no pins yet, falls back to top-N", () => {
    expect(migratePinnedCompanySelection(null, allUids)).toBeNull();
  });

  it("an old empty array ('hide all') is discarded, not carried forward as pins", () => {
    expect(migratePinnedCompanySelection([], allUids)).toBeNull();
  });

  it("an old selection naming every company ('show all', the old default) is discarded", () => {
    expect(migratePinnedCompanySelection([...allUids], allUids)).toBeNull();
  });

  it("an old selection naming every company in a different order is still discarded", () => {
    expect(
      migratePinnedCompanySelection(["cmp_gamma", "cmp_acme", "cmp_beta"], allUids),
    ).toBeNull();
  });

  it("a proper, non-empty subset is carried forward as the initial pin set", () => {
    expect(migratePinnedCompanySelection(["cmp_acme"], allUids)).toEqual([
      "cmp_acme",
    ]);
    expect(
      migratePinnedCompanySelection(["cmp_acme", "cmp_beta"], allUids),
    ).toEqual(["cmp_acme", "cmp_beta"]);
  });

  it("with an unknown company universe (allCompanyUids empty), a non-empty selection is kept as-is", () => {
    expect(migratePinnedCompanySelection(["cmp_acme"], [])).toEqual([
      "cmp_acme",
    ]);
  });
});

describe("findCompanyHomeRow", () => {
  it("field present: server-tagged isCompanyHome resolves directly", () => {
    const rows = [homeRow("cmp_acme", "acme")];
    expect(findCompanyHomeRow(rows, "cmp_acme")?.channelId).toBe("acme");
  });

  it("id match: normalizeChannel resolves isCompanyHome via homeChannelIdByUid", () => {
    const row = normalizeChannel(channel({ channelId: "chn_home" }), {
      homeChannelIdByUid: new Map([["cmp_acme", "chn_home"]]),
    });
    expect(row.isCompanyHome).toBe(true);
    expect(findCompanyHomeRow([row], "cmp_acme")?.channelId).toBe("chn_home");
  });

  it("no match: no row is the home channel", () => {
    const rows = [teamRow("cmp_acme", "random-team")];
    expect(findCompanyHomeRow(rows, "cmp_acme")).toBeNull();
  });

  it("multiple company-scope channels for one company: only the true home resolves", () => {
    const rows = [
      teamRow("cmp_acme", "marketing"),
      teamRow("cmp_acme", "eng"),
      homeRow("cmp_acme", "acme"),
    ];
    expect(findCompanyHomeRow(rows, "cmp_acme")?.channelId).toBe("acme");
  });
});

describe("loadPinnedCompanies / savePinnedCompanies", () => {
  it("defaults to null (show all) when nothing has been persisted", () => {
    expect(loadPinnedCompanies(memoryStorage())).toBeNull();
    expect(loadPinnedCompanies(null)).toBeNull();
  });

  it("round-trips an explicit selection, including a deliberate empty array", () => {
    const storage = memoryStorage();
    savePinnedCompanies(["cmp_acme"], storage);
    expect(loadPinnedCompanies(storage)).toEqual(["cmp_acme"]);
    savePinnedCompanies([], storage);
    expect(loadPinnedCompanies(storage)).toEqual([]);
  });

  it("tolerates corrupt JSON by falling back to null (show all)", () => {
    const storage = memoryStorage({ "hq.chat.pinned-companies": "{not-json" });
    expect(loadPinnedCompanies(storage)).toBeNull();
  });
});

/**
 * Regression: a resolved company home channel must survive an intermittent
 * directory refresh that comes back missing it — reported by Jacob: some
 * companies flip to "no home channel" after a refresh on another machine.
 * The directory feed is a periodic full-snapshot reconciliation
 * (`applyDirectoryRows`/`applyDirectoryFeed`); a snapshot that's incomplete
 * because of a server hiccup (the `MESSAGES_CHANNELS_BODY_READ_FAIL` /
 * `DM_NOTIFY_CHAN_POLL_ERROR` lines in `~/.hq/logs/hq-sync.log`) must not
 * wipe a channel the client already knows is the company home.
 */
function directoryRow(over: Partial<ChannelDirectoryRow> = {}): ChannelDirectoryRow {
  return {
    channelId: "chn_home_acme",
    type: "chat",
    scope: "company",
    companyUid: "cmp_acme",
    name: "acme",
    lastActivityAt: "2026-09-24T00:00:00.000Z",
    isCompanyHome: true,
    ...over,
  };
}

describe("applyDirectoryRows / applyDirectoryFeed — home-channel refresh stability", () => {
  it("keeps a known home channel when a later snapshot omits it entirely", () => {
    const first = applyDirectoryRows([directoryRow()], []);
    expect(first.find((c) => c.channelId === "chn_home_acme")?.isCompanyHome).toBe(
      true,
    );

    // Next snapshot from a flaky refresh: the home channel is missing, but
    // an unrelated team channel is present (a partial, not an empty, feed —
    // ruling out the existing "empty feed keeps the seed" carveout).
    const second = applyDirectoryRows(
      [directoryRow({ channelId: "chn_team", isCompanyHome: false, name: "eng" })],
      first,
    );

    const home = second.find((c) => c.channelId === "chn_home_acme");
    expect(home).toBeTruthy();
    expect(home?.isCompanyHome).toBe(true);
    expect(second.find((c) => c.channelId === "chn_team")).toBeTruthy();
  });

  it("still drops a non-home channel that disappears from the snapshot (no blanket keep-everything)", () => {
    const teamRowIn = directoryRow({
      channelId: "chn_team",
      isCompanyHome: false,
      name: "eng",
    });
    const first = applyDirectoryRows([directoryRow(), teamRowIn], []);
    const second = applyDirectoryRows([directoryRow()], first);

    expect(second.find((c) => c.channelId === "chn_home_acme")).toBeTruthy();
    expect(second.find((c) => c.channelId === "chn_team")).toBeUndefined();
  });

  it("home channel resolves again via findCompanyHomeRow after surviving a lossy refresh", () => {
    const first = applyDirectoryRows([directoryRow()], []);
    const second = applyDirectoryRows([], first); // total miss, non-empty seed not involved
    const rows = second.map((c) =>
      normalizeChannel(c, {
        homeChannelIdByUid: new Map([["cmp_acme", "chn_home_acme"]]),
      }),
    );
    expect(findCompanyHomeRow(rows, "cmp_acme")?.channelId).toBe("chn_home_acme");
  });

  it("applyDirectoryFeed (the caller ChatSidebar actually uses) carries the same guarantee", () => {
    const first = applyDirectoryFeed([directoryRow()], [], null);
    // A non-empty incoming feed that simply lacks the home channel — not the
    // "incoming is empty" seed-restore path.
    const second = applyDirectoryFeed(
      [directoryRow({ channelId: "chn_team", isCompanyHome: false, name: "eng" })],
      first,
      null,
    );
    expect(
      second.find((c) => c.channelId === "chn_home_acme")?.isCompanyHome,
    ).toBe(true);
  });
});
