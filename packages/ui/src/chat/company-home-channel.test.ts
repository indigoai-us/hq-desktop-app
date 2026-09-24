import { describe, expect, it } from "vitest";
import { isCompanyHomeChannel, type Channel } from "./channels";
import {
  loadPinnedCompanies,
  normalizeChannel,
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
  it("uses the explicit isCompanyHome field when the server sends it, even if name/scope disagree", () => {
    expect(
      isCompanyHomeChannel({ scope: "company", name: "random-team", isCompanyHome: true }, "acme"),
    ).toBe(true);
    expect(
      isCompanyHomeChannel({ scope: "company", name: "acme", isCompanyHome: false }, "acme"),
    ).toBe(false);
  });

  it("falls back to scope+name match when isCompanyHome is absent", () => {
    expect(isCompanyHomeChannel({ scope: "company", name: "acme" }, "acme")).toBe(true);
    expect(isCompanyHomeChannel({ scope: "company", name: "random-team" }, "acme")).toBe(false);
  });

  it("never treats a non-company-scope channel as home, regardless of name", () => {
    expect(isCompanyHomeChannel({ scope: "project", name: "acme" }, "acme")).toBe(false);
    expect(isCompanyHomeChannel({ scope: "personal", name: "acme" }, "acme")).toBe(false);
  });

  it("is false when the company slug is unknown", () => {
    expect(isCompanyHomeChannel({ scope: "company", name: "acme" }, null)).toBe(false);
    expect(isCompanyHomeChannel({ scope: "company", name: "acme" }, undefined)).toBe(false);
  });
});

describe("normalizeChannel — isCompanyHome resolution", () => {
  it("carries an explicit server isCompanyHome flag through to the row", () => {
    const row = normalizeChannel(channel({ name: "random-team", isCompanyHome: true }));
    expect(row.isCompanyHome).toBe(true);
  });

  it("resolves the fallback via companySlugByUid when the server omits the field", () => {
    const home = normalizeChannel(
      channel({ name: "acme" }),
      { companySlugByUid: new Map([["cmp_acme", "acme"]]) },
    );
    expect(home.isCompanyHome).toBe(true);

    const team = normalizeChannel(
      channel({ name: "random-team" }),
      { companySlugByUid: new Map([["cmp_acme", "acme"]]) },
    );
    expect(team.isCompanyHome).toBe(false);
  });

  it("with multiple scope='company' channels in one company, only the slug-matching one resolves as home", () => {
    const slugMap = new Map([["cmp_acme", "acme"]]);
    const rows = [
      channel({ channelId: "chn_home", name: "acme" }),
      channel({ channelId: "chn_team1", name: "marketing" }),
      channel({ channelId: "chn_team2", name: "eng" }),
    ].map((c) => normalizeChannel(c, { companySlugByUid: slugMap }));
    const homes = rows.filter((r) => r.isCompanyHome);
    expect(homes).toHaveLength(1);
    expect(homes[0]?.channelId).toBe("chn_home");
  });

  it("never marks a group DM as isCompanyHome", () => {
    const row = normalizeChannel(channel({ scope: "group", companyUid: null }));
    expect(row.isCompanyHome).toBeUndefined();
  });
});

describe("resolveCompanySectionRows", () => {
  const companies = [
    { companyUid: "cmp_acme", label: "Acme" },
    { companyUid: "cmp_beta", label: "Beta" },
  ];

  function homeRow(companyUid: string, channelId: string): ConversationRow {
    return {
      id: `ch:${channelId}`,
      kind: "channel",
      channelScope: "company",
      title: `#${channelId}`,
      companyUid,
      unreadDot: false,
      lastActivityAt: 0,
      pinned: false,
      channelId,
      isCompanyHome: true,
    };
  }

  it("selection === null shows every company the user belongs to (default, and covers newly-joined)", () => {
    const rows = resolveCompanySectionRows(
      companies,
      [homeRow("cmp_acme", "acme"), homeRow("cmp_beta", "beta")],
      null,
    );
    expect(rows.map((r) => r.companyUid)).toEqual(["cmp_acme", "cmp_beta"]);
    expect(rows.every((r) => r.homeRow)).toBe(true);
  });

  it("an explicit selection filters to only the chosen companies", () => {
    const rows = resolveCompanySectionRows(
      companies,
      [homeRow("cmp_acme", "acme"), homeRow("cmp_beta", "beta")],
      ["cmp_acme"],
    );
    expect(rows.map((r) => r.companyUid)).toEqual(["cmp_acme"]);
  });

  it("an explicit empty selection hides every company (deliberate hide-all, not treated as unset)", () => {
    const rows = resolveCompanySectionRows(
      companies,
      [homeRow("cmp_acme", "acme"), homeRow("cmp_beta", "beta")],
      [],
    );
    expect(rows).toEqual([]);
  });

  it("a company without a home channel yet is included with homeRow: null (shown disabled, not hidden)", () => {
    const rows = resolveCompanySectionRows(companies, [homeRow("cmp_acme", "acme")], null);
    const beta = rows.find((r) => r.companyUid === "cmp_beta");
    expect(beta).toBeDefined();
    expect(beta?.homeRow).toBeNull();
  });

  it("ignores non-home company-scope rows when picking the home channel", () => {
    const teamRow: ConversationRow = {
      id: "ch:team",
      kind: "channel",
      channelScope: "company",
      title: "#team",
      companyUid: "cmp_acme",
      unreadDot: false,
      lastActivityAt: 0,
      pinned: false,
      channelId: "team",
      isCompanyHome: false,
    };
    const rows = resolveCompanySectionRows(
      [companies[0]!],
      [teamRow, homeRow("cmp_acme", "acme")],
      null,
    );
    expect(rows[0]?.homeRow?.channelId).toBe("acme");
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
