import { describe, expect, it } from "vitest";

import {
  NO_RETIRED_ENTITIES,
  isRetiredBot,
  isRetiredCompany,
  liveCompanyUidSet,
  mergeRetiredEntities,
  retiredProbeCandidates,
  withoutRetiredRows,
} from "./retired-entities.js";
import { mergePaletteRows } from "../shell/palette-rows.js";
import type { ConversationRow } from "./sidebar-model.js";

function row(partial: Partial<ConversationRow> & Pick<ConversationRow, "id" | "kind">): ConversationRow {
  return {
    title: partial.id,
    companyUid: null,
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    ...partial,
  };
}

const live = new Set(["cmp_live"]);
const known = mergeRetiredEntities(NO_RETIRED_ENTITIES, {
  retiredCompanyUids: ["cmp_retired"],
  goneAgentUids: ["agt_parsnip"],
  liveUids: ["cmp_new", "agt_lychee", "agt_scout", "agt_personal"],
  agentCompanyUids: {
    agt_lychee: ["cmp_retired"],
    agt_scout: ["cmp_retired", "cmp_live"],
    agt_personal: [],
  },
});

const rows = [
  row({ id: "ch:chn_retired", kind: "channel", companyUid: "cmp_retired" }),
  row({ id: "ch:chn_retired_project", kind: "channel", companyUid: "cmp_retired", channelScope: "project" }),
  row({ id: "ch:chn_live", kind: "channel", companyUid: "cmp_live" }),
  row({ id: "ch:chn_new", kind: "channel", companyUid: "cmp_new" }),
  row({ id: "ch:chn_unknown", kind: "channel", companyUid: "cmp_not_asked_yet" }),
  row({ id: "dm:agt_lychee", kind: "dm", personUid: "agt_lychee" }),
  row({ id: "dm:agt_scout", kind: "dm", personUid: "agt_scout" }),
  row({ id: "dm:agt_parsnip", kind: "dm", personUid: "agt_parsnip" }),
  row({ id: "dm:agt_personal", kind: "dm", personUid: "agt_personal" }),
  row({ id: "dm:prs_amy", kind: "dm", personUid: "prs_amy", companyUid: "cmp_retired" }),
  row({ id: "grp:chn_group", kind: "group" }),
];

describe("retired companies and their conversations", () => {
  it("hides a retired company's channels and keeps live, new and unknown companies", () => {
    const ids = withoutRetiredRows(rows, known, live).map((r) => r.id);
    expect(ids).not.toContain("ch:chn_retired");
    expect(ids).not.toContain("ch:chn_retired_project");
    expect(ids).toContain("ch:chn_live");
    // A new company whose channel arrived before the company list refreshed
    // answered live, and one not asked about yet is never hidden.
    expect(ids).toContain("ch:chn_new");
    expect(ids).toContain("ch:chn_unknown");
    expect(ids).toContain("grp:chn_group");
  });

  it("hides a bot DM only when the bot is gone or every company it is in is retired", () => {
    const ids = withoutRetiredRows(rows, known, live).map((r) => r.id);
    expect(ids).not.toContain("dm:agt_lychee");
    expect(ids).not.toContain("dm:agt_parsnip");
    expect(ids).toContain("dm:agt_scout");
    expect(ids).toContain("dm:agt_personal");
    // People outlive a company.
    expect(ids).toContain("dm:prs_amy");
  });

  it("never hides a company that is in the live list, even after a retired answer", () => {
    const relisted = new Set(["cmp_live", "cmp_retired"]);
    expect(isRetiredCompany("cmp_retired", known, relisted)).toBe(false);
    expect(isRetiredBot("agt_lychee", known, relisted)).toBe(false);
    expect(withoutRetiredRows(rows, known, relisted).map((r) => r.id)).toContain("ch:chn_retired");
  });

  it("returns the same rows untouched when nothing is retired", () => {
    expect(withoutRetiredRows(rows, NO_RETIRED_ENTITIES, live)).toBe(rows);
  });

  it("a later live answer restores a company", () => {
    const restored = mergeRetiredEntities(known, { liveUids: ["cmp_retired"] });
    expect(isRetiredCompany("cmp_retired", restored, live)).toBe(false);
  });

  it("ignores malformed answers", () => {
    const merged = mergeRetiredEntities(NO_RETIRED_ENTITIES, {
      retiredCompanyUids: ["prs_x", "", "cmp bad", 7 as unknown as string, "agt_x"],
      goneAgentUids: ["cmp_x"],
    });
    expect([...merged.retiredCompanyUids]).toEqual([]);
    expect([...merged.goneAgentUids]).toEqual([]);
    expect(mergeRetiredEntities(known, null)).toBe(known);
  });

  it("asks only about companies outside the live list and about bot DM peers, once", () => {
    const asked = new Set(["cmp_retired"]);
    expect(retiredProbeCandidates(rows, live, asked).sort()).toEqual(
      ["agt_lychee", "agt_parsnip", "agt_personal", "agt_scout", "cmp_new", "cmp_not_asked_yet"].sort(),
    );
  });

  it("keeps a retired company's rows out of the palette's cached rows", () => {
    const cached = [row({ id: "ch:chn_retired", kind: "channel", companyUid: "cmp_retired" })];
    const palette = mergePaletteRows(
      withoutRetiredRows(rows, known, live),
      withoutRetiredRows(cached, known, live),
    );
    expect(palette.map((r) => r.id)).not.toContain("ch:chn_retired");
    expect(palette.map((r) => r.id)).toContain("ch:chn_live");
  });

  it("reads live company uids from a workspace list", () => {
    expect([
      ...liveCompanyUidSet([
        { kind: "company", cloudUid: "cmp_a" },
        { kind: "personal", cloudUid: "prs_me" },
        { kind: "company", cloudUid: null },
      ]),
    ]).toEqual(["cmp_a"]);
  });
});
